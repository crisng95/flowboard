"""In-process worker that drains queued generation requests.

Scope for Run 3 (Phase 2 bridge): a single handler type `"proxy"` that
forwards `params = {url, method?, headers?, body?}` through the extension
via ``flow_client.api_request``. Further types (gen_image, gen_video,
upload_image, etc.) land in later runs once the full Flow protocol + captcha
round-trip is ported.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from flowboard.db import get_session
from flowboard.db.models import Request
from flowboard.services import media as media_service
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_sdk import get_flow_sdk

logger = logging.getLogger(__name__)


# type → coroutine(params) → (result_dict, error_or_None)
Handler = Callable[[dict], Awaitable[tuple[dict, Optional[str]]]]


_ALLOWED_URL_PREFIXES: tuple[str, ...] = (
    "https://aisandbox-pa.googleapis.com/",
)


async def _handle_proxy(params: dict) -> tuple[dict, Optional[str]]:
    url = params.get("url")
    method = params.get("method", "POST")
    if not isinstance(url, str) or not url:
        return {}, "missing_url"
    # Defense-in-depth: refuse to proxy URLs outside the expected allowlist
    # even if the extension's own check was somehow bypassed.
    if not any(url.startswith(p) for p in _ALLOWED_URL_PREFIXES):
        return {}, "url_not_allowed"
    resp = await flow_client.api_request(
        url=url,
        method=method,
        headers=params.get("headers") or {},
        body=params.get("body"),
    )
    if not isinstance(resp, dict):
        return {"value": resp}, None
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    status = resp.get("status")
    if isinstance(status, int) and status >= 400:
        return resp, f"API_{status}"
    return resp, None


async def _handle_create_project(params: dict) -> tuple[dict, Optional[str]]:
    name = params.get("name") or params.get("title") or "Untitled"
    if not isinstance(name, str) or not name.strip():
        return {}, "missing_name"
    tool = params.get("tool", "PINHOLE")
    resp = await get_flow_sdk().create_project(name.strip(), tool)
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    return resp, None


async def _handle_gen_image(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    aspect = params.get("aspect_ratio") or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    tier = params.get("paygate_tier") or "PAYGATE_TIER_ONE"
    # `ref_media_ids` is the broader name (any upstream image / character /
    # visual_asset feeds in as IMAGE_INPUT_TYPE_REFERENCE). Older callers used
    # `character_media_ids` — accept both.
    raw_ref_ids = params.get("ref_media_ids")
    if not isinstance(raw_ref_ids, list):
        raw_ref_ids = params.get("character_media_ids")
    ref_media_ids: Optional[list[str]] = None
    if isinstance(raw_ref_ids, list):
        cleaned = [m for m in raw_ref_ids if isinstance(m, str) and m]
        ref_media_ids = cleaned or None
    raw_count = params.get("variant_count")
    variant_count = 1
    if isinstance(raw_count, int) and raw_count > 0:
        variant_count = raw_count
    # Per-variant prompts (optional). When provided, each variant gets its
    # own text — used by auto-prompt batch mode so variants don't collapse
    # to the same stance.
    raw_prompts = params.get("prompts")
    per_variant_prompts: Optional[list[str]] = None
    if isinstance(raw_prompts, list):
        cleaned = [p for p in raw_prompts if isinstance(p, str) and p.strip()]
        per_variant_prompts = cleaned or None
    resp = await get_flow_sdk().gen_image(
        prompt=prompt.strip(),
        project_id=project_id,
        aspect_ratio=aspect,
        paygate_tier=tier,
        ref_media_ids=ref_media_ids,
        variant_count=variant_count,
        prompts=per_variant_prompts,
    )
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    # Flow returns signed fifeUrls directly in the response — persist them
    # immediately so `/media/:id` can serve bytes without any extra round-trip.
    entries_with_urls = [
        e for e in (resp.get("media_entries") or []) if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_image response failed")
    return resp, None


# Video polling knobs — overridable in tests. flowkit uses 420s/10s; Flow's
# video gen routinely takes 4-6 minutes, so 5 minutes is too tight and times
# out legitimately-finishing operations.
VIDEO_POLL_INTERVAL_S = 10.0
VIDEO_POLL_MAX_CYCLES = 42


async def _handle_gen_video(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    start_media_id = params.get("start_media_id") or params.get("startMediaId")
    raw_starts = params.get("start_media_ids")
    start_media_ids: Optional[list[str]] = None
    if isinstance(raw_starts, list):
        cleaned = [m for m in raw_starts if isinstance(m, str) and m.strip()]
        start_media_ids = [m.strip() for m in cleaned] or None

    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    # Either a single start_media_id OR a non-empty start_media_ids list.
    if start_media_ids is None and (
        not isinstance(start_media_id, str) or not start_media_id.strip()
    ):
        return {}, "missing_start_media_id"
    aspect = params.get("aspect_ratio") or "VIDEO_ASPECT_RATIO_LANDSCAPE"
    tier = params.get("paygate_tier") or "PAYGATE_TIER_ONE"

    sdk = get_flow_sdk()
    dispatch = await sdk.gen_video(
        prompt=prompt.strip(),
        project_id=project_id,
        start_media_id=start_media_id.strip()
        if isinstance(start_media_id, str) and start_media_id.strip()
        else None,
        start_media_ids=start_media_ids,
        aspect_ratio=aspect,
        paygate_tier=tier,
    )
    if dispatch.get("error"):
        return dispatch, str(dispatch["error"])[:200]

    op_names = dispatch.get("operation_names") or []
    if not op_names:
        return dispatch, "no_operations_returned"

    poll_attempts = 0
    last_poll: dict = {}
    all_entries: list[dict] = []
    done_by_name: dict[str, bool] = {name: False for name in op_names}
    op_error: Optional[str] = None

    while (
        poll_attempts < VIDEO_POLL_MAX_CYCLES
        and not all(done_by_name.values())
        and op_error is None
    ):
        await asyncio.sleep(VIDEO_POLL_INTERVAL_S)
        poll_attempts += 1
        last_poll = await sdk.check_async(op_names)
        if last_poll.get("error"):
            continue
        for op in last_poll.get("operations") or []:
            if not isinstance(op, dict):
                continue
            name = op.get("name")
            # Per-operation terminal failure (e.g. content filter
            # PUBLIC_ERROR_AUDIO_FILTERED). Bail immediately rather than
            # polling for the full 7-min timeout — Flow won't change its mind.
            err = op.get("error")
            if isinstance(err, str) and err:
                op_error = err
                break
            # Only collect entries the FIRST time an op transitions to
            # done — otherwise every subsequent poll re-appends them and
            # we end up with duplicates in `media_ids` (saw 7 entries
            # for a 4-variant gen because ops 1-3 finished early and
            # got re-collected on each later poll).
            if op.get("done") and not done_by_name.get(name, False):
                done_by_name[name] = True
                for e in op.get("media_entries") or []:
                    all_entries.append(e)

    if op_error is not None:
        return (
            {
                "raw_dispatch": dispatch,
                "last_poll": last_poll,
                "operation_names": op_names,
                "done": done_by_name,
            },
            op_error,
        )

    if not all(done_by_name.values()):
        return (
            {
                "raw_dispatch": dispatch,
                "last_poll": last_poll,
                "operation_names": op_names,
                "done": done_by_name,
            },
            "timeout_waiting_video",
        )

    entries_with_urls = [e for e in all_entries if isinstance(e, dict) and e.get("url")]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_video response failed")

    media_ids = [e["media_id"] for e in all_entries if isinstance(e, dict) and e.get("media_id")]
    return (
        {
            "raw_dispatch": dispatch,
            "last_poll": last_poll,
            "operation_names": op_names,
            "media_ids": media_ids,
            "media_entries": all_entries,
        },
        None,
    )


async def _handle_edit_image(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    source_media_id = params.get("source_media_id") or params.get("sourceMediaId")
    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    if not isinstance(source_media_id, str) or not source_media_id.strip():
        return {}, "missing_source_media_id"
    aspect = params.get("aspect_ratio") or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    tier = params.get("paygate_tier") or "PAYGATE_TIER_ONE"
    raw_refs = params.get("ref_media_ids")
    ref_ids: Optional[list[str]] = None
    if isinstance(raw_refs, list):
        cleaned = [m for m in raw_refs if isinstance(m, str) and m]
        ref_ids = cleaned or None

    resp = await get_flow_sdk().edit_image(
        prompt=prompt.strip(),
        project_id=project_id,
        source_media_id=source_media_id.strip(),
        ref_media_ids=ref_ids,
        aspect_ratio=aspect,
        paygate_tier=tier,
    )
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    entries_with_urls = [
        e for e in (resp.get("media_entries") or []) if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from edit_image response failed")
    return resp, None


_DEFAULT_HANDLERS: dict[str, Handler] = {
    "proxy": _handle_proxy,
    "create_project": _handle_create_project,
    "gen_image": _handle_gen_image,
    "gen_video": _handle_gen_video,
    "edit_image": _handle_edit_image,
}


class WorkerController:
    """Single-consumer async queue worker."""

    def __init__(self, handlers: Optional[dict[str, Handler]] = None) -> None:
        self._queue: asyncio.Queue[int] = asyncio.Queue()
        self._handlers = dict(handlers or _DEFAULT_HANDLERS)
        self._shutdown = asyncio.Event()
        self._active = 0
        self._started_at: Optional[float] = None

    # ── enqueue ────────────────────────────────────────────────────────────
    def enqueue(self, request_id: int) -> None:
        self._queue.put_nowait(request_id)

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def start(self) -> None:
        self._started_at = time.time()
        logger.info("worker started")
        while not self._shutdown.is_set():
            try:
                rid = await asyncio.wait_for(self._queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            await self._process_one(rid)

    def request_shutdown(self) -> None:
        self._shutdown.set()

    async def drain(self) -> None:
        # Wait for any in-flight task to finish.
        while self._active > 0:
            await asyncio.sleep(0.05)

    @property
    def active_count(self) -> int:
        return self._active

    @property
    def uptime_s(self) -> Optional[float]:
        if self._started_at is None:
            return None
        return time.time() - self._started_at

    # ── execution ──────────────────────────────────────────────────────────
    async def _process_one(self, rid: int) -> None:
        self._active += 1
        try:
            with get_session() as s:
                req = s.get(Request, rid)
                if req is None:
                    logger.warning("worker: request %s not found", rid)
                    return
                handler = self._handlers.get(req.type)
                if handler is None:
                    req.status = "failed"
                    req.error = f"unknown_request_type:{req.type}"
                    req.finished_at = datetime.now(timezone.utc)
                    s.add(req)
                    s.commit()
                    return

                req.status = "running"
                s.add(req)
                s.commit()
                params = dict(req.params or {})

            # Release the session during the possibly-long RPC.
            result, err = await handler(params)

            with get_session() as s:
                req = s.get(Request, rid)
                if req is None:
                    return
                req.result = result if isinstance(result, dict) else {"value": result}
                req.finished_at = datetime.now(timezone.utc)
                if err:
                    req.status = "failed"
                    req.error = err
                else:
                    req.status = "done"
                    req.error = None
                s.add(req)
                s.commit()
        except Exception as exc:  # noqa: BLE001
            logger.exception("worker exception on rid=%s", rid)
            try:
                with get_session() as s:
                    req = s.get(Request, rid)
                    if req is not None:
                        req.status = "failed"
                        req.error = str(exc)[:500]
                        req.finished_at = datetime.now(timezone.utc)
                        s.add(req)
                        s.commit()
            except Exception:  # noqa: BLE001
                logger.exception("worker: failed to record failure for rid=%s", rid)
        finally:
            self._active -= 1


_worker: Optional[WorkerController] = None


def get_worker() -> WorkerController:
    global _worker
    if _worker is None:
        _worker = WorkerController()
    return _worker
