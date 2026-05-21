"""Cross-project media re-upload + cache.

Flow scopes mediaIds to the project they were uploaded in. When a
request needs a reference image (gen_image refs, edit_image refs,
gen_video_omni ingredients) that was originally generated/uploaded
under another project, Flow returns 404 "Requested entity was not
found" because it can't see the asset in the current project.

This service bridges that gap: given an original_media_id + a target
project_id, return a media_id that Flow accepts as a reference under
that project. Re-uploads the local cached bytes on cache miss, records
the mapping in MediaProjectMapping so subsequent dispatches are
instant.

Cache semantics:
  - The mapping is keyed on (original_media_id, project_id). The same
    bytes can have multiple entries — one per project the user has
    dispatched against.
  - Identity mapping (original == project-local) is recorded too, so
    in-project refs short-circuit without a lookup miss.
  - Mapping is permanent for the lifetime of the database. If Flow
    eventually GCs a project's assets, the cache becomes stale; a
    dispatch failure surfaces and the operator can clear the row.
"""
from __future__ import annotations

import base64
import logging
from typing import Optional

from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Asset, MediaProjectMapping
from flowboard.services import media as media_service
from flowboard.services.flow_sdk import get_flow_sdk

logger = logging.getLogger(__name__)


_MIME_BY_EXT: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


class MediaSyncError(RuntimeError):
    """Raised when a reference can't be made available under the target
    project — bytes missing locally and the cached URL is dead, or the
    Flow upload itself failed."""


async def ensure_media_in_project(
    original_media_id: str, project_id: str
) -> str:
    """Return a media_id Flow recognises as a reference under
    ``project_id``. Re-uploads from the local cache on cache miss.

    Raises MediaSyncError if the bytes can't be sourced (no local file
    AND no usable Asset.url to re-ingest) or if the Flow upload fails.
    """
    if not original_media_id or not project_id:
        raise MediaSyncError("missing media_id or project_id")

    # 1) Cache hit — already synced this pair before.
    with get_session() as s:
        row = s.exec(
            select(MediaProjectMapping)
            .where(MediaProjectMapping.original_media_id == original_media_id)
            .where(MediaProjectMapping.project_id == project_id)
        ).first()
        if row:
            return row.project_local_media_id

    # 2) Resolve local bytes. First try the cached file; if missing,
    #    try fetching via Asset.url (signed GCS URL — may have expired).
    bytes_data, mime = await _load_bytes(original_media_id)
    if bytes_data is None:
        raise MediaSyncError(
            f"no bytes available for media_id={original_media_id} "
            f"(local cache miss + no usable URL)"
        )

    # 3) Upload to Flow under the target project.
    image_b64 = base64.b64encode(bytes_data).decode("ascii")
    file_name = f"sync_{original_media_id}.{_ext_from_mime(mime)}"
    resp = await get_flow_sdk().upload_image(
        image_base64=image_b64,
        mime_type=mime,
        project_id=project_id,
        file_name=file_name,
    )
    if resp.get("error"):
        raise MediaSyncError(
            f"flow upload failed: {resp['error']}"
        )
    new_media_id = resp.get("media_id")
    if not isinstance(new_media_id, str) or not new_media_id:
        raise MediaSyncError("flow upload returned no media_id")

    # 4) Persist the mapping. UniqueConstraint may race on parallel
    #    syncs of the same ref — swallow IntegrityError and re-read.
    try:
        with get_session() as s:
            s.add(
                MediaProjectMapping(
                    original_media_id=original_media_id,
                    project_id=project_id,
                    project_local_media_id=new_media_id,
                )
            )
            s.commit()
    except Exception:  # noqa: BLE001
        logger.exception(
            "MediaProjectMapping insert race for (%s, %s) — re-reading",
            original_media_id, project_id,
        )
        with get_session() as s:
            row = s.exec(
                select(MediaProjectMapping)
                .where(
                    MediaProjectMapping.original_media_id == original_media_id
                )
                .where(MediaProjectMapping.project_id == project_id)
            ).first()
            if row:
                return row.project_local_media_id
        # If we still can't find a winner, surface the original new id
        # (it's valid, just won't be cached).
        return new_media_id

    logger.info(
        "media_sync: %s -> %s under project %s",
        original_media_id, new_media_id, project_id,
    )
    return new_media_id


async def ensure_media_ids_in_project(
    media_ids: list[str], project_id: str
) -> tuple[list[str], list[tuple[str, str]]]:
    """Bulk-sync. Returns ``(synced_ids, failures)`` where ``failures``
    is a list of ``(original_media_id, error_message)`` tuples for any
    refs that couldn't be synced. Successful refs are returned in input
    order; failed refs are dropped from the returned list."""
    synced: list[str] = []
    failures: list[tuple[str, str]] = []
    for mid in media_ids:
        try:
            synced.append(await ensure_media_in_project(mid, project_id))
        except MediaSyncError as exc:
            failures.append((mid, str(exc)))
            logger.warning(
                "media_sync skipped %s for project %s: %s",
                mid, project_id, exc,
            )
    return synced, failures


# ── helpers ───────────────────────────────────────────────────────────────


async def _load_bytes(media_id: str) -> tuple[Optional[bytes], str]:
    """Return (bytes, mime). Bytes is None when neither local cache nor
    the Asset.url has a working source."""
    cached = media_service.cached_path(media_id)
    if cached is not None and cached.exists():
        try:
            data = cached.read_bytes()
            mime = _mime_from_ext(cached.suffix)
            return data, mime
        except OSError:
            logger.exception("media_sync: failed to read local cache %s", cached)

    # Fallback — try refetching via Asset.url. fetch_and_cache caches
    # to disk on success so subsequent syncs short-circuit.
    fetched = await media_service.fetch_and_cache(media_id)
    if fetched is None:
        return None, "image/png"
    data, mime, _path = fetched
    return data, mime


def _mime_from_ext(ext: str) -> str:
    return _MIME_BY_EXT.get(ext.lower(), "image/png")


def _ext_from_mime(mime: str) -> str:
    for ext, m in _MIME_BY_EXT.items():
        if m == mime:
            return ext.lstrip(".")
    return "png"
