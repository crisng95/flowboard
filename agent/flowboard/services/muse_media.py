"""Muse media path — image / video generation via the provider-job queue.

The four media request types (`gen_image`, `edit_image`, `gen_video`,
`gen_video_omni`) check `params["media_provider"]` first; when it is
`"muse"` they land here instead of the Google Flow SDK path:

    kind "image"      <- gen_image (prompt + optional ref images)
    kind "edit_image" <- edit_image (source image + prompt)
    kind "video"      <- gen_video (i2v start frame(s))
    kind "video_refs" <- gen_video_omni (reference ingredients, r2v)

The job is published to the queue and the worker blocks on
`wait_for_provider_job`. The Pax worker fulfils it with its own tools
(e.g. media/image/video generation skills) and completes with:

    {"outputs": [{"output_url": "file://..." | "https://...",
                  "media_id": "<optional uuid>"}]}

The agent then reads the bytes (local read for file://, download for
https://) and ingests them into the media cache with
`ingest_inline_bytes`, so the existing `/media/{id}` route serves them
and the worker's node-mirroring writes `media_ids` like any Flow run.

Result shape matches the Flow handlers: `{"media_ids": [...],
"media_entries": [...], "provider": "muse"}` in the processor's
`(dict, Optional[str])` convention.

**muse2api transport.** With `FLOWBOARD_MUSE2API_BASE` set, the same four
kinds skip the queue and call the muse2api gateway directly (see
`services/muse2api.py`):

    image       /v1/images/generations (one call per per-variant prompt)
    edit_image  /v1/images/edits (source + refs as multipart)
    video       /v1/videos, one task per start frame (frame = `image`)
    video_refs  /v1/videos, first reference as the first frame

muse2api has no reference-image input for text-to-image and only a single
first frame for video, so refs it cannot take are dropped and reported in
`result["warnings"]` rather than failing the render.
"""
from __future__ import annotations

import asyncio
import logging
import mimetypes
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx

from flowboard import config
from flowboard.services import media as media_service
from flowboard.services import muse2api
from flowboard.services import provider_jobs as pq

logger = logging.getLogger(__name__)

# Don't try to ingest absurd files (a worker bug, not a render).
_MAX_OUTPUT_BYTES = 500 * 1024 * 1024


def _kind_media_type(kind: str) -> str:
    return "video" if kind in ("video", "video_refs") else "image"


def _guess_mime(url: str, media_type: str) -> str:
    mime, _ = mimetypes.guess_type(urlparse(url).path)
    if mime and mime.startswith(("image/", "video/")):
        return mime
    return "video/mp4" if media_type == "video" else "image/png"


async def _read_output_bytes(
    url: str, media_type: str
) -> Optional[tuple[bytes, str]]:
    """Read worker output bytes. Returns (bytes, mime) or None."""
    if url.startswith("file://"):
        path = urlparse(url).path
        try:
            import os

            size = os.path.getsize(path)
            if size <= 0 or size > _MAX_OUTPUT_BYTES:
                logger.warning("muse media: refusing file %s (size %d)", path, size)
                return None
            with open(path, "rb") as f:
                data = f.read()
            return data, _guess_mime(url, media_type)
        except OSError as exc:
            logger.warning("muse media: cannot read %s: %s", path, exc)
            return None
    if url.startswith(("https://", "http://")):
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.get(url, follow_redirects=True)
                resp.raise_for_status()
                data = resp.content
            if not data or len(data) > _MAX_OUTPUT_BYTES:
                return None
            mime = resp.headers.get("content-type", "").split(";")[0].strip()
            if not mime.startswith(("image/", "video/")):
                mime = _guess_mime(url, media_type)
            return data, mime
        except Exception as exc:  # noqa: BLE001
            logger.warning("muse media: download failed for %s: %s", url[:80], exc)
            return None
    logger.warning("muse media: unsupported output_url scheme: %s", url[:40])
    return None


async def _resolve_media_input_url(media_id: str) -> Optional[str]:
    """Turn a Flowboard media_id into something the worker can read.

    Prefer the local cache (file://) — the worker runs on the same host.
    Fall back to the asset's remote URL.
    """
    try:
        cached = media_service.cached_path(media_id)
        if cached is not None:
            return f"file://{cached}"
        fetched = await media_service.fetch_and_cache(media_id)
        if fetched is not None:
            _bytes, _mime, path = fetched
            return f"file://{path}"
    except Exception:  # noqa: BLE001
        logger.exception("muse media: cache resolve failed for %s", media_id[:12])
    from flowboard.db import get_session
    from flowboard.db.models import Asset

    try:
        with get_session() as s:
            from sqlmodel import select

            row = s.exec(
                select(Asset).where(Asset.uuid_media_id == media_id)
            ).first()
            if row is not None and row.url:
                return row.url
            # Local-only assets (e.g. chat uploads) have no remote URL —
            # the worker runs on the same host, so hand it the file path.
            if row is not None and row.local_path:
                p = Path(row.local_path)
                if p.is_file():
                    return f"file://{p}"
    except Exception:  # noqa: BLE001
        logger.exception("muse media: asset lookup failed for %s", media_id[:12])
    return None


async def run_muse_media(
    *,
    kind: str,
    prompt: str,
    orientation: Optional[str] = None,
    source_media_ids: Optional[list[str]] = None,
    reference_media_ids: Optional[list[str]] = None,
    extra: Optional[dict] = None,
) -> tuple[dict, Optional[str]]:
    """Dispatch one media job to the muse queue; import the outputs.

    Returns (result, error) in the worker-handler convention. `error`
    None means the request row goes `done` with `media_ids` mirrored.
    """
    media_type = _kind_media_type(kind)

    if muse2api.is_configured():
        return await _run_via_muse2api(
            kind=kind,
            prompt=prompt,
            orientation=orientation,
            source_media_ids=source_media_ids or [],
            reference_media_ids=reference_media_ids or [],
            extra=extra or {},
        )

    # Resolve input media to worker-readable URLs before queueing, so the
    # job payload is self-contained.
    source_urls: list[str] = []
    for mid in source_media_ids or []:
        url = await _resolve_media_input_url(mid)
        if url:
            source_urls.append(url)
    reference_urls: list[str] = []
    for mid in reference_media_ids or []:
        url = await _resolve_media_input_url(mid)
        if url:
            reference_urls.append(url)

    job = pq.create_provider_job(
        provider="muse",
        kind=kind,
        prompt=prompt,
        orientation=orientation,
        source_url=source_urls[0] if source_urls else None,
        start_url=source_urls[0] if kind in ("video",) else None,
        end_url=None,
        reference_urls=reference_urls,
        extra={
            **(extra or {}),
            "media_type": media_type,
            "source_urls": source_urls,
        },
    )
    logger.info(
        "muse media: %s job %s queued — waiting for worker", kind, job.id[:12]
    )
    final = await pq.wait_for_provider_job(
        job.id, timeout_s=config.MUSE_MEDIA_TIMEOUT_S
    )
    if final is None:
        return {}, (
            f"muse_no_worker: no Pax worker answered within "
            f"{config.MUSE_MEDIA_TIMEOUT_S:.0f}s (job {job.id[:12]}). "
            f"Start one: python agent/scripts/muse_worker.py"
        )
    if final.status == "CANCELLED":
        return {}, f"muse_cancelled: job {job.id[:12]} was cancelled"
    if final.status != "SUCCEEDED":
        return {}, (
            f"muse_failed: {(final.error_message or 'worker failed')[:300]}"
        )

    outputs = (final.result or {}).get("outputs") or []
    if not isinstance(outputs, list) or not outputs:
        return {}, f"muse_empty: worker returned no outputs (job {job.id[:12]})"

    media_ids: list[Optional[str]] = []
    media_entries: list[dict] = []
    slot_errors: list[dict] = []
    for i, out in enumerate(outputs):
        if not isinstance(out, dict):
            continue
        url = out.get("output_url")
        if not isinstance(url, str) or not url:
            slot_errors.append({"slot": i, "error": "missing_output_url"})
            media_ids.append(None)
            continue
        raw = await _read_output_bytes(url, media_type)
        if raw is None:
            slot_errors.append({"slot": i, "error": "unreadable_output"})
            media_ids.append(None)
            continue
        data, mime = raw
        mid = out.get("media_id")
        if not isinstance(mid, str) or not media_service.is_valid_media_id(mid):
            mid = uuid.uuid4().hex
        ok = media_service.ingest_inline_bytes(
            mid, data, kind=media_type, mime=mime
        )
        if not ok:
            slot_errors.append({"slot": i, "error": "ingest_failed"})
            media_ids.append(None)
            continue
        media_ids.append(mid)
        media_entries.append({"media_id": mid, "url": f"/media/{mid}"})

    if not any(media_ids):
        detail = slot_errors[0]["error"] if slot_errors else "unknown"
        return {}, f"muse_no_media: no usable outputs ({detail})"

    result: dict = {
        "provider": "muse",
        "provider_job_id": job.id,
        "media_ids": media_ids,
        "media_entries": media_entries,
    }
    if slot_errors:
        result["slot_errors"] = slot_errors
    return result, None


# ── muse2api transport ────────────────────────────────────────────────


async def _load_input(media_id: str) -> Optional[tuple[bytes, str]]:
    """A Flowboard media_id's bytes, for shipping to muse2api (no shared FS)."""
    url = await _resolve_media_input_url(media_id)
    if not url:
        return None
    return await _read_output_bytes(url, "image")


async def _muse2api_outputs(
    kind: str,
    prompt: str,
    size: Optional[str],
    source_ids: list[str],
    ref_ids: list[str],
    extra: dict,
    warnings: list[str],
) -> list:
    """Run the gateway calls for one dispatch.

    Returns one entry per output slot: ``(bytes, mime)`` or a
    ``Muse2APIError`` for a slot that failed (so one bad variant doesn't
    discard its siblings, mirroring the queue path's slot_errors).
    """
    timeout = config.MUSE_MEDIA_TIMEOUT_S

    async def _slot(coro):
        try:
            return await coro
        except muse2api.Muse2APIError as exc:
            return exc

    if kind == "image":
        if ref_ids:
            warnings.append(
                f"{len(ref_ids)} reference image(s) ignored: muse2api text-to-image "
                "takes no image input"
            )
        prompts = [p for p in (extra.get("prompts") or []) if isinstance(p, str) and p.strip()]
        if prompts:
            batches = [(p.strip(), 1) for p in prompts]
        else:
            count = extra.get("variant_count")
            count = count if isinstance(count, int) and count > 0 else 1
            batches = []
            while count > 0:
                n = min(count, muse2api.MAX_IMAGES_PER_CALL)
                batches.append((prompt, n))
                count -= n
        results = await asyncio.gather(*(
            _slot(muse2api.generate_images(p, n=n, size=size, timeout=timeout))
            for p, n in batches
        ))
        out: list = []
        for (_p, n), r in zip(batches, results):
            if isinstance(r, Exception):
                out.extend([r] * n)
            else:
                out.extend(r)
        return out

    if kind == "edit_image":
        if not source_ids:
            return [muse2api.Muse2APIError("missing source image")]
        source = await _load_input(source_ids[0])
        if source is None:
            return [muse2api.Muse2APIError("source image unreadable")]
        refs = [r for r in [await _load_input(m) for m in ref_ids] if r is not None]
        try:
            return list(await muse2api.edit_image(
                prompt, image=source, references=refs, size=size, timeout=timeout
            ))
        except muse2api.Muse2APIError as exc:
            return [exc]

    # Video: muse2api takes exactly one optional first frame per task.
    if kind == "video":
        frames = source_ids
    else:  # video_refs
        frames = ref_ids[:1]
        if len(ref_ids) > 1:
            warnings.append(
                f"{len(ref_ids) - 1} reference image(s) ignored: muse2api video "
                "takes a single first frame"
            )
    duration = extra.get("duration_s")
    duration = duration if isinstance(duration, int) and duration > 0 else None

    async def _one_video(media_id: Optional[str]):
        image = None
        if media_id is not None:
            loaded = await _load_input(media_id)
            if loaded is None:
                raise muse2api.Muse2APIError(f"start frame {media_id[:12]} unreadable")
            image = muse2api.data_url(*loaded)
        return await muse2api.generate_video(
            prompt, image=image, size=size, duration=duration, timeout=timeout
        )

    targets: list[Optional[str]] = list(frames) or [None]
    return list(await asyncio.gather(*(_slot(_one_video(m)) for m in targets)))


async def _run_via_muse2api(
    *,
    kind: str,
    prompt: str,
    orientation: Optional[str],
    source_media_ids: list[str],
    reference_media_ids: list[str],
    extra: dict,
) -> tuple[dict, Optional[str]]:
    media_type = _kind_media_type(kind)
    warnings: list[str] = []
    logger.info("muse media: %s via muse2api at %s", kind, muse2api.base_url())
    outputs = await _muse2api_outputs(
        kind,
        prompt,
        muse2api.size_for_orientation(orientation),
        source_media_ids,
        reference_media_ids,
        extra,
        warnings,
    )

    media_ids: list[Optional[str]] = []
    media_entries: list[dict] = []
    slot_errors: list[dict] = []
    for i, out in enumerate(outputs):
        if isinstance(out, Exception):
            slot_errors.append({"slot": i, "error": str(out)[:300]})
            media_ids.append(None)
            continue
        data, mime = out
        mid = uuid.uuid4().hex
        if not media_service.ingest_inline_bytes(mid, data, kind=media_type, mime=mime):
            slot_errors.append({"slot": i, "error": "ingest_failed"})
            media_ids.append(None)
            continue
        media_ids.append(mid)
        media_entries.append({"media_id": mid, "url": f"/media/{mid}"})

    if not any(media_ids):
        detail = slot_errors[0]["error"] if slot_errors else "no outputs"
        return {}, f"muse2api_failed: {detail}"[:400]

    result: dict = {
        "provider": "muse",
        "transport": "muse2api",
        "media_ids": media_ids,
        "media_entries": media_entries,
    }
    if slot_errors:
        result["slot_errors"] = slot_errors
    if warnings:
        result["warnings"] = warnings
    return result, None
