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
        node_id = params.get("__node_id")
        if node_id is not None:
            try:
                from flowboard.services.prompt_synth import auto_prompt
                prompt = await auto_prompt(node_id)
            except Exception as exc:
                logger.warning("auto_prompt failed for node %s: %s", node_id, exc)
                return {}, "missing_prompt"
        else:
            return {}, "missing_prompt"
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    aspect = params.get("aspect_ratio") or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    # Tier resolution: caller-stamped value first (set at dispatch time),
    # then the live value from `flow_client` (resolved authoritatively
    # via /v1/credits on token capture). NO silent default — if both
    # are absent we fail loud with `paygate_tier_unknown`. The old
    # behaviour (default `PAYGATE_TIER_ONE`) silently downgraded Ultra
    # users to Pro and stamped the wrong tier into request.params, which
    # then fed back through `_last_observed_paygate_tier_from_db()` and
    # corrupted /api/auth/me responses for the rest of the session.
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"
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
    image_model = params.get("image_model")
    if not isinstance(image_model, str) or not image_model.strip():
        image_model = None
    resp = await get_flow_sdk().gen_image(
        prompt=prompt.strip(),
        project_id=project_id,
        aspect_ratio=aspect,
        paygate_tier=tier,
        ref_media_ids=ref_media_ids,
        variant_count=variant_count,
        prompts=per_variant_prompts,
        image_model=image_model,
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


# Video polling knobs — overridable in tests. 5-minute hard deadline
# (30 cycles × 10s). When the budget runs out without all ops finishing
# the handler returns the ``timeout_waiting_video`` sentinel and the
# worker stamps the row as ``status='timeout'`` (distinct from
# ``failed``) so the UI can render it as a soft auto-cancel rather than
# a generation error.
VIDEO_POLL_INTERVAL_S = 10.0
VIDEO_POLL_MAX_CYCLES = 30


def _is_request_canceled(rid: Optional[int]) -> bool:
    """Return True iff the cancel endpoint flipped this row to canceled.

    Long-running handlers call this between polls so a user-initiated
    cancel takes effect mid-flight (we can't abort the Flow HTTP calls
    themselves, but we can stop polling and let _process_one keep the
    canceled status intact).
    """
    if not isinstance(rid, int):
        return False
    with get_session() as s:
        req = s.get(Request, rid)
        if req is None:
            return True
        return req.status == "canceled"


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
    # Tier resolution — see the matching block in _handle_gen_image for
    # the rationale. No silent default; missing tier is a hard error so
    # we never dispatch an Ultra user's video at the Pro checkpoint.
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"
    video_quality = params.get("video_quality")
    if not isinstance(video_quality, str) or not video_quality.strip():
        video_quality = None

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
        video_quality=video_quality,
    )
    if dispatch.get("error"):
        return dispatch, str(dispatch["error"])[:200]

    op_names = dispatch.get("operation_names") or []
    if not op_names:
        return dispatch, "no_operations_returned"
    # NEW low-priority models return workflows (`{name, primary_media_id}`)
    # instead of operations; the SDK surfaces them on `dispatch["workflows"]`
    # so we can route the poll to /v1/media/<id> instead of batchCheckAsync.
    workflows = dispatch.get("workflows") or None

    poll_attempts = 0
    last_poll: dict = {}
    done_by_name: dict[str, bool] = {name: False for name in op_names}
    entry_by_name: dict[str, dict] = {}
    op_errors: dict[str, str] = {}
    rid = params.get("__request_id")

    # Per-op resolution: each operation in the batch resolves
    # independently (success, content-filter rejection, or timeout). We
    # used to break the whole loop on the first per-op error, which
    # collapsed a 4-variant gen into a hard failure even when 3/4 clips
    # had already rendered. Now we let every op terminate on its own
    # and aggregate the outcome at the end so partial batches still
    # surface the variants that did succeed.
    while (
        poll_attempts < VIDEO_POLL_MAX_CYCLES
        and not all(done_by_name.values())
    ):
        await asyncio.sleep(VIDEO_POLL_INTERVAL_S)
        poll_attempts += 1
        if _is_request_canceled(rid):
            # User canceled mid-poll. Bail with the special error code
            # so _process_one knows to leave the row's canceled status
            # intact (the cancel endpoint already stamped finished_at +
            # error='canceled'). Any partial state we collected is
            # preserved on `result` for the detail viewer.
            return (
                {
                    "raw_dispatch": dispatch,
                    "last_poll": last_poll,
                    "operation_names": op_names,
                    "done": done_by_name,
                    "canceled": True,
                },
                "canceled",
            )
        last_poll = await sdk.check_async(op_names, workflows=workflows)
        if last_poll.get("error"):
            continue
        for op in last_poll.get("operations") or []:
            if not isinstance(op, dict):
                continue
            name = op.get("name")
            if not isinstance(name, str) or done_by_name.get(name, False):
                continue
            # Per-op terminal failure (e.g. content filter
            # PUBLIC_ERROR_UNSAFE_GENERATION / PUBLIC_ERROR_AUDIO_FILTERED).
            # Mark this op resolved-with-error and keep polling the rest.
            err = op.get("error")
            if isinstance(err, str) and err:
                done_by_name[name] = True
                op_errors[name] = err
                continue
            if op.get("done"):
                done_by_name[name] = True
                # Each op is expected to yield exactly one media entry
                # on success; capture the first valid one.
                for e in op.get("media_entries") or []:
                    if isinstance(e, dict) and e.get("media_id"):
                        entry_by_name[name] = e
                        break

    # Slots still unresolved after the max cycles — record as timeout
    # so the partial summary names them alongside any filter failures.
    for name in op_names:
        if not done_by_name.get(name) and name not in op_errors:
            op_errors[name] = "timeout_waiting_video"

    # Build positional outcome aligned to dispatch order. Slot i in
    # `media_ids` corresponds to slot i in the original
    # `start_media_ids` array, so the frontend can keep upstream-image
    # variant ↔ video-variant alignment even when middle slots fail.
    # `slot_errors` mirrors the same indexing — `None` for succeeded
    # slots, error code for blocked ones — so the detail viewer can
    # render the exact filter reason on the blocked tile without
    # having to know the internal Flow op-name keys.
    positional_ids: list[Optional[str]] = []
    slot_errors: list[Optional[str]] = []
    succeeded_entries: list[dict] = []
    for name in op_names:
        e = entry_by_name.get(name)
        if isinstance(e, dict) and isinstance(e.get("media_id"), str):
            positional_ids.append(e["media_id"])
            succeeded_entries.append(e)
            slot_errors.append(None)
        else:
            positional_ids.append(None)
            slot_errors.append(op_errors.get(name))

    success_count = sum(1 for x in positional_ids if x)
    total = len(op_names)

    if success_count == 0:
        # No op produced a clip — surface the first error verbatim.
        # When all errors are "timeout_waiting_video" this matches the
        # legacy single-op timeout contract; tests rely on it.
        first_err = next(iter(op_errors.values()), "timeout_waiting_video")
        return (
            {
                "raw_dispatch": dispatch,
                "last_poll": last_poll,
                "operation_names": op_names,
                "done": done_by_name,
                "op_errors": op_errors,
            },
            first_err,
        )

    # ≥1 op succeeded — ingest only the bytes we actually have.
    entries_with_urls = [
        e for e in succeeded_entries if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_video response failed")
    # Workflow-mode (Low Priority) deliveries arrive inline as base64 MP4
    # bytes on the `/v1/media/<id>` poll — there is no GCS URL to chase.
    # Plant the bytes in the local cache directly so the `/media/<id>` route
    # serves them like any URL-backed asset.
    for entry in succeeded_entries:
        if not isinstance(entry, dict):
            continue
        encoded = entry.get("encoded_video")
        mid = entry.get("media_id")
        if not isinstance(encoded, str) or not isinstance(mid, str):
            continue
        try:
            import base64 as _b64
            media_service.ingest_inline_bytes(
                mid, _b64.b64decode(encoded, validate=False),
                kind="video", mime="video/mp4",
            )
        except Exception:  # noqa: BLE001
            logger.exception("inline ingest from workflow-mode poll failed for %s", mid)

    partial_error: Optional[str] = None
    if op_errors:
        # De-dup distinct error codes for a compact one-line summary
        # (e.g. "1/4 variants blocked: PUBLIC_ERROR_UNSAFE_GENERATION").
        unique_errs = sorted({err for err in op_errors.values()})
        partial_error = (
            f"{len(op_errors)}/{total} variants blocked: {', '.join(unique_errs)}"
        )

    return (
        {
            "raw_dispatch": dispatch,
            "last_poll": last_poll,
            "operation_names": op_names,
            "media_ids": positional_ids,
            "media_entries": succeeded_entries,
            "op_errors": op_errors,
            "slot_errors": slot_errors,
            "partial_error": partial_error,
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
    # Tier resolution — see _handle_gen_image for rationale. Fail loud,
    # no silent fallback to Pro.
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"
    raw_refs = params.get("ref_media_ids")
    ref_ids: Optional[list[str]] = None
    if isinstance(raw_refs, list):
        cleaned = [m for m in raw_refs if isinstance(m, str) and m]
        ref_ids = cleaned or None
    image_model = params.get("image_model")
    if not isinstance(image_model, str) or not image_model.strip():
        image_model = None

    resp = await get_flow_sdk().edit_image(
        prompt=prompt.strip(),
        project_id=project_id,
        source_media_id=source_media_id.strip(),
        ref_media_ids=ref_ids,
        aspect_ratio=aspect,
        paygate_tier=tier,
        image_model=image_model,
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


# ── Storyboard ────────────────────────────────────────────────────────────
# Plan: .omc/plans/storyboard-image-node.md §6.3-6.5.
# A storyboard request fans out into:
#   Phase A — gen_image for every root shot (parents[k] is None) in
#             parallel chunks of ≤4 (Flow's hard cap).
#   Phase B — BFS through the continuity tree; siblings whose parent
#             just turned `done` dispatch in parallel as edit_image
#             with `base_media_id = shots[parent].mediaId`.
# Refs are global (locked OPEN-4): same array passed to every dispatch.
# Failures keep the partial state — descendants of a failed shot are
# marked "blocked" so the user can retry just the failed level.

def _propagate_blocked(shots: list[dict]) -> None:
    """Any shot whose parent is error/blocked → blocked + parent_failed."""
    n = len(shots)
    changed = True
    while changed:
        changed = False
        for k in range(n):
            if shots[k].get("status") != "queued":
                continue
            p = shots[k].get("parentShotIdx")
            if p is None:
                continue
            if shots[p].get("status") in ("error", "blocked"):
                shots[k]["status"] = "blocked"
                shots[k]["error"] = "parent_failed"
                changed = True


def _aggregate_node_status(shots: list[dict]) -> str:
    statuses = {s.get("status") for s in shots}
    if statuses == {"done"}:
        return "done"
    if statuses <= {"error", "blocked"}:
        return "error"
    if "done" in statuses:
        return "partial"
    return "running"


def _persist_storyboard_progress(
    node_id: int, shots: list[dict], node_status: str
) -> None:
    """Write the in-progress shots[] state to Node.data so the frontend
    sees Phase A roots populate before Phase B finishes. Mirrors the final
    patchNode payload the frontend writes on done — idempotent w.r.t.
    that final write.

    For 30-60s storyboards the request-level polling path only patches
    the node ONCE on completion. Persisting after each phase lets a poll
    of `/api/nodes/:id` return real-time progress.
    """
    from flowboard.db.models import Node
    with get_session() as s:
        node = s.get(Node, node_id)
        if node is None:
            return
        new_data = dict(node.data or {})
        new_data["shots"] = shots
        new_data["shotCount"] = len(shots)
        new_data["mediaIds"] = [sh.get("mediaId") for sh in shots]
        node.data = new_data
        node.status = node_status
        s.add(node)
        s.commit()


async def _handle_gen_storyboard(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services import prompt_synth
    from flowboard.services.flow_sdk import is_valid_project_id

    n = params.get("shot_count")
    if not isinstance(n, int) or not 1 <= n <= 8:
        return {}, "shot_count_out_of_range"

    project_id = params.get("project_id")
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"

    aspect = params.get("aspect_ratio") or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"

    image_model = params.get("image_model")
    if not isinstance(image_model, str) or not image_model.strip():
        image_model = None

    raw_refs = params.get("global_ref_media_ids")
    refs: list[str] = []
    if isinstance(raw_refs, list):
        refs = [m for m in raw_refs if isinstance(m, str) and m]

    # Hoist node_id read here so progressive-persistence helpers below can
    # reach Node.data without depending on planner branch. The escape-hatch
    # path (caller supplies shot_prompts) doesn't require a node_id — tests
    # of the validation-only path call without one. Persistence is gated on
    # `isinstance(node_id, int)` so a missing node_id is a no-op, not an
    # error, here.
    node_id = params.get("__node_id") or params.get("node_id")

    # 1. Plan beats (or use caller-supplied)
    if isinstance(params.get("shot_prompts"), list):
        prompts = list(params["shot_prompts"])
        parents = list(params.get("shot_parents") or [])
        if len(prompts) != n or len(parents) != n:
            return {}, "shot_prompts_length_mismatch"
    else:
        if not isinstance(node_id, int):
            return {}, "missing_node_id_for_planner"
        try:
            plan = await prompt_synth.auto_prompt_storyboard(
                node_id, count=n,
                narrative_seed=params.get("narrative_seed", "") or "",
            )
        except prompt_synth.PromptSynthError as exc:
            return {}, f"planner:{exc}"[:200]
        prompts = list(plan["prompts"])
        parents = list(plan["parents"])

    # 2. Validate parents
    if parents[0] is not None:
        return {}, "parents_root_must_be_null"
    for k in range(1, n):
        v = parents[k]
        # Reject bool explicitly: in Python `bool` subclasses `int`, so a
        # caller posting `shot_parents=[null, true]` would otherwise pass
        # the `isinstance(v, int)` check and `True == 1` would silently be
        # used as the parent index. Mirrors the planner-side validation in
        # `auto_prompt_storyboard` (services/prompt_synth.py).
        if v is not None and not (
            isinstance(v, int) and not isinstance(v, bool) and 0 <= v < k
        ):
            return {}, f"parents_oob_at_{k}"

    # 3. Initialise shots state
    shots: list[dict] = [
        {
            "idx": k,
            "prompt": prompts[k],
            "parentShotIdx": parents[k],
            "mediaId": None,
            "status": "queued",
            "error": None,
        }
        for k in range(n)
    ]

    sdk = get_flow_sdk()

    async def _ingest(entries: list[dict]) -> None:
        urls = [e for e in entries if isinstance(e, dict) and e.get("url")]
        if not urls:
            return
        try:
            media_service.ingest_urls(urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest failed in gen_storyboard")

    # 4. Phase A — dispatch roots in chunks of ≤4
    roots = [k for k in range(n) if parents[k] is None]
    for chunk_start in range(0, len(roots), 4):
        chunk = roots[chunk_start:chunk_start + 4]
        try:
            res = await sdk.gen_image(
                prompt=prompts[chunk[0]],
                project_id=project_id,
                aspect_ratio=aspect,
                paygate_tier=tier,
                ref_media_ids=refs or None,
                variant_count=len(chunk),
                prompts=[prompts[k] for k in chunk],
                image_model=image_model,
            )
            if (res or {}).get("error"):
                err_msg = str(res["error"])[:200]
                for k in chunk:
                    shots[k]["status"] = "error"
                    shots[k]["error"] = err_msg
                continue
            await _ingest((res or {}).get("media_entries") or [])
            ids = (res or {}).get("media_ids") or []
            for i, k in enumerate(chunk):
                mid = ids[i] if i < len(ids) else None
                shots[k]["mediaId"] = mid
                shots[k]["status"] = "done" if mid else "error"
                shots[k]["error"] = None if mid else "missing_media"
        except Exception as exc:  # noqa: BLE001
            logger.exception("gen_storyboard root chunk failed")
            err_msg = str(exc)[:200]
            for k in chunk:
                shots[k]["status"] = "error"
                shots[k]["error"] = err_msg
    _propagate_blocked(shots)
    # Persist Phase A progress so the frontend sees roots populate before
    # Phase B finishes (mirrors the final patchNode payload — idempotent).
    if isinstance(node_id, int):
        _persist_storyboard_progress(
            node_id, shots, _aggregate_node_status(shots)
        )

    # 5. Phase B — BFS children level by level
    while True:
        eligible = [
            k for k in range(n)
            if shots[k]["status"] == "queued"
            and parents[k] is not None
            and shots[parents[k]]["status"] == "done"
        ]
        if not eligible:
            break

        async def _edit_one(k: int) -> None:
            try:
                res = await sdk.edit_image(
                    prompt=prompts[k],
                    project_id=project_id,
                    source_media_id=shots[parents[k]]["mediaId"],
                    ref_media_ids=refs or None,
                    aspect_ratio=aspect,
                    paygate_tier=tier,
                    image_model=image_model,
                )
                if (res or {}).get("error"):
                    shots[k]["status"] = "error"
                    shots[k]["error"] = str(res["error"])[:200]
                    return
                await _ingest((res or {}).get("media_entries") or [])
                ids = (res or {}).get("media_ids") or []
                mid = ids[0] if ids else None
                shots[k]["mediaId"] = mid
                shots[k]["status"] = "done" if mid else "error"
                shots[k]["error"] = None if mid else "missing_media"
            except Exception as exc:  # noqa: BLE001
                logger.exception("gen_storyboard child %d failed", k)
                shots[k]["status"] = "error"
                shots[k]["error"] = str(exc)[:200]

        await asyncio.gather(*[_edit_one(k) for k in eligible])
        _propagate_blocked(shots)
        # Persist after each BFS level so a long Phase B reveals progress
        # tile-by-tile. The next eligibility scan uses the in-memory shots
        # list, not the persisted copy, so this write is purely for
        # frontend visibility.
        if isinstance(node_id, int):
            _persist_storyboard_progress(
                node_id, shots, _aggregate_node_status(shots)
            )

    return (
        {
            "shots": shots,
            "media_ids": [s["mediaId"] for s in shots],
            "node_status": _aggregate_node_status(shots),
        },
        None,
    )


async def _handle_retry_storyboard_shot(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.db.models import Node
    from flowboard.services.flow_sdk import is_valid_project_id

    shot_idx = params.get("shot_idx")
    if not isinstance(shot_idx, int) or shot_idx < 0:
        return {}, "missing_shot_idx"

    node_id = params.get("__node_id") or params.get("node_id")
    if not isinstance(node_id, int):
        return {}, "missing_node_id"

    # Pull current shots[] + node-level config from Node.data.
    with get_session() as s:
        node = s.get(Node, node_id)
        if node is None:
            return {}, "node_not_found"
        data = dict(node.data or {})
        shots = list(data.get("shots") or [])
        if not (0 <= shot_idx < len(shots)):
            return {}, "shot_idx_out_of_range"
        shot = dict(shots[shot_idx])
        node_aspect = data.get("aspectRatio")
        node_refs_raw = data.get("globalRefMediaIds")
        node_refs = (
            [m for m in node_refs_raw if isinstance(m, str) and m]
            if isinstance(node_refs_raw, list) else []
        )
        node_model = data.get("imageModel")
        node_tier = data.get("paygateTier")
        node_project = data.get("projectId")

    prompt = shot.get("prompt")
    parent_idx = shot.get("parentShotIdx")
    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "shot_has_no_prompt"

    project_id = params.get("project_id") or node_project
    aspect = params.get("aspect_ratio") or node_aspect or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    tier = params.get("paygate_tier") or node_tier or flow_client.paygate_tier
    raw_refs = params.get("ref_media_ids")
    refs = (
        [m for m in raw_refs if isinstance(m, str) and m]
        if isinstance(raw_refs, list) else node_refs
    )
    model = params.get("image_model") or node_model
    if not isinstance(model, str) or not model.strip():
        model = None

    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    if tier is None:
        return {}, "paygate_tier_unknown"

    sdk = get_flow_sdk()

    if parent_idx is None:
        # Root retry — gen_image with variant_count=1.
        try:
            res = await sdk.gen_image(
                prompt=prompt,
                project_id=project_id,
                aspect_ratio=aspect,
                paygate_tier=tier,
                ref_media_ids=refs or None,
                variant_count=1,
                prompts=[prompt],
                image_model=model,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("retry_storyboard_shot root dispatch failed")
            return {}, f"gen_image:{exc}"[:200]
    else:
        if not (0 <= parent_idx < len(shots)):
            return {}, "parent_idx_out_of_range"
        parent_status = shots[parent_idx].get("status")
        if parent_status != "done":
            return {}, "parent_not_ready"
        parent_mid = shots[parent_idx].get("mediaId")
        if not isinstance(parent_mid, str) or not parent_mid:
            return {}, "parent_has_no_media"
        try:
            res = await sdk.edit_image(
                prompt=prompt,
                project_id=project_id,
                source_media_id=parent_mid,
                ref_media_ids=refs or None,
                aspect_ratio=aspect,
                paygate_tier=tier,
                image_model=model,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("retry_storyboard_shot child dispatch failed")
            return {}, f"edit_image:{exc}"[:200]

    if (res or {}).get("error"):
        return res, str(res["error"])[:200]
    entries = (res or {}).get("media_entries") or []
    urls = [e for e in entries if isinstance(e, dict) and e.get("url")]
    if urls:
        try:
            media_service.ingest_urls(urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest failed in retry_storyboard_shot")
    ids = (res or {}).get("media_ids") or []
    new_mid = ids[0] if ids else None
    return (
        {
            "shot_idx": shot_idx,
            "media_id": new_mid,
            "media_ids": [new_mid] if new_mid else [],
        },
        None,
    )


# ── Omni Flash r2v ────────────────────────────────────────────────────────
# Variable-duration video model with a distinct endpoint + body shape from
# Veo i2v. See agent/flowboard/services/flow_sdk.py::gen_video_omni for the
# request assembly. Single operation per request (no multi-source batching
# like Veo's start_media_ids), so the polling logic collapses to a single
# op + first-error-wins, simpler than _handle_gen_video.

async def _handle_gen_video_omni(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    raw_refs = params.get("ref_media_ids")
    if not isinstance(raw_refs, list):
        # Also accept the legacy single-source field for symmetry with
        # Veo's start_media_id, so the same upstream-walk on the frontend
        # works without a special-case.
        raw_refs = (
            [params.get("start_media_id")]
            if isinstance(params.get("start_media_id"), str)
            else []
        )
    ref_media_ids = [m for m in raw_refs if isinstance(m, str) and m.strip()]
    duration_s = params.get("duration_s")

    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    if not ref_media_ids:
        return {}, "missing_ref_media_ids"
    if not isinstance(duration_s, int) or duration_s not in (4, 6, 8, 10):
        return {}, "invalid_duration_s"
    aspect = params.get("aspect_ratio") or "VIDEO_ASPECT_RATIO_PORTRAIT"
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    if tier is None:
        return {}, "paygate_tier_unknown"

    sdk = get_flow_sdk()
    dispatch = await sdk.gen_video_omni(
        prompt=prompt.strip(),
        project_id=project_id,
        ref_media_ids=ref_media_ids,
        duration_s=duration_s,
        aspect_ratio=aspect,
        paygate_tier=tier,
    )
    if dispatch.get("error"):
        return dispatch, str(dispatch["error"])[:200]

    op_names = dispatch.get("operation_names") or []
    if not op_names:
        return dispatch, "no_operations_returned"
    workflows = dispatch.get("workflows") or None

    poll_attempts = 0
    last_poll: dict = {}
    done_by_name: dict[str, bool] = {name: False for name in op_names}
    entry_by_name: dict[str, dict] = {}
    op_errors: dict[str, str] = {}
    rid = params.get("__request_id")

    while (
        poll_attempts < VIDEO_POLL_MAX_CYCLES
        and not all(done_by_name.values())
    ):
        await asyncio.sleep(VIDEO_POLL_INTERVAL_S)
        poll_attempts += 1
        if _is_request_canceled(rid):
            return (
                {
                    "raw_dispatch": dispatch,
                    "last_poll": last_poll,
                    "operation_names": op_names,
                    "done": done_by_name,
                    "canceled": True,
                },
                "canceled",
            )
        last_poll = await sdk.check_async(op_names, workflows=workflows)
        if last_poll.get("error"):
            continue
        for op in last_poll.get("operations") or []:
            if not isinstance(op, dict):
                continue
            name = op.get("name")
            if not isinstance(name, str) or done_by_name.get(name, False):
                continue
            err = op.get("error")
            if isinstance(err, str) and err:
                done_by_name[name] = True
                op_errors[name] = err
                continue
            if op.get("done"):
                done_by_name[name] = True
                for e in op.get("media_entries") or []:
                    if isinstance(e, dict) and e.get("media_id"):
                        entry_by_name[name] = e
                        break

    for name in op_names:
        if not done_by_name.get(name) and name not in op_errors:
            op_errors[name] = "timeout_waiting_video"

    positional_ids: list[Optional[str]] = []
    slot_errors: list[Optional[str]] = []
    succeeded_entries: list[dict] = []
    for name in op_names:
        e = entry_by_name.get(name)
        if isinstance(e, dict) and isinstance(e.get("media_id"), str):
            positional_ids.append(e["media_id"])
            succeeded_entries.append(e)
            slot_errors.append(None)
        else:
            positional_ids.append(None)
            slot_errors.append(op_errors.get(name))

    if not any(positional_ids):
        first_err = next(iter(op_errors.values()), "timeout_waiting_video")
        return (
            {
                "raw_dispatch": dispatch,
                "last_poll": last_poll,
                "operation_names": op_names,
                "done": done_by_name,
                "op_errors": op_errors,
            },
            first_err,
        )

    entries_with_urls = [
        e for e in succeeded_entries if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_video_omni response failed")

    return (
        {
            "raw_dispatch": dispatch,
            "last_poll": last_poll,
            "operation_names": op_names,
            "media_ids": positional_ids,
            "media_entries": succeeded_entries,
            "op_errors": op_errors,
            "slot_errors": slot_errors,
            "duration_s": duration_s,
        },
        None,
    )


_DEFAULT_HANDLERS: dict[str, Handler] = {
    "proxy": _handle_proxy,
    "create_project": _handle_create_project,
    "gen_image": _handle_gen_image,
    "gen_video": _handle_gen_video,
    "gen_video_omni": _handle_gen_video_omni,
    "edit_image": _handle_edit_image,
    "gen_variant": None,
}



# ── Variant (Concepta fork) ─────────────────────────────────────────
# Variant supports `variant_count > 1` so the user gets multiple
# alternates in one click. We dispatch N×1 edit_image (parallel chunks
# of 4) — Flow's batch edit_image doesn't preserve order between
# request[i] and output[i] when per-variant prompts differ.
#
# Params shape (set by the frontend dispatch path):
#   gen_variant: { project_id, source_media_id, axis_key (str),
#                  instruction (str), variant_count (1..4),
#                  aspect_ratio, paygate_tier, image_model }


async def _handle_gen_variant(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.concept import build_variant_prompt
    from flowboard.services.flow_sdk import is_valid_project_id

    project_id = params.get("project_id")
    source_media_id = params.get("source_media_id")
    axis_key = params.get("axis_key")
    instruction = params.get("instruction") or ""
    aspect = params.get("aspect_ratio") or "IMAGE_ASPECT_RATIO_PORTRAIT"
    tier = params.get("paygate_tier") or flow_client.paygate_tier
    image_model = params.get("image_model")

    raw_count = params.get("variant_count")
    n = max(1, min(int(raw_count) if isinstance(raw_count, int) else 1, 4))

    if not isinstance(project_id, str) or not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    if not isinstance(source_media_id, str) or not source_media_id:
        return {}, "missing_source_media_id"
    if not isinstance(axis_key, str) or not axis_key:
        return {}, "missing_axis_key"
    if tier is None:
        return {}, "paygate_tier_unknown"
    if not isinstance(image_model, str) or not image_model.strip():
        image_model = None

    # Per-variant prompts: when the user requests N variants of the
    # SAME axis, we synthesise N slightly-perturbed instructions so
    # the outputs are actually different. Frontend can pass
    # `instructions: list[str]` to override (1 instruction per
    # variant); else we just dispatch the same instruction N times
    # and rely on Flow's seed variation.
    raw_instructions = params.get("instructions")
    instructions: list[str] = []
    if isinstance(raw_instructions, list):
        instructions = [
            i for i in raw_instructions if isinstance(i, str) and i.strip()
        ]
    if not instructions:
        instructions = [instruction] * n
    elif len(instructions) < n:
        instructions += [instructions[-1]] * (n - len(instructions))

    sdk = get_flow_sdk()
    media_ids: list[Optional[str]] = [None] * n
    angle_errors: list[Optional[str]] = [None] * n
    media_entries_acc: list[dict] = []

    async def _edit_one(k: int) -> None:
        prompt = build_variant_prompt(axis_key, instructions[k])
        if prompt is None:
            angle_errors[k] = f"unknown_axis:{axis_key}"
            return
        try:
            resp = await sdk.edit_image(
                prompt=prompt,
                project_id=project_id,
                source_media_id=source_media_id,
                ref_media_ids=None,
                aspect_ratio=aspect,
                paygate_tier=tier,
                image_model=image_model,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("gen_variant slot %d failed", k)
            angle_errors[k] = f"edit_image:{exc}"[:200]
            return
        if (resp or {}).get("error"):
            angle_errors[k] = str(resp["error"])[:200]
            return
        ids = (resp or {}).get("media_ids") or []
        mid = next((m for m in ids if isinstance(m, str) and m), None)
        if not mid:
            angle_errors[k] = "filtered_or_missing"
            return
        media_ids[k] = mid
        for e in (resp.get("media_entries") or []):
            if isinstance(e, dict) and e.get("url"):
                media_entries_acc.append(e)

    # Chunk dispatch so we stay under Flow's 4-call concurrent cap.
    CHUNK = 4
    for start in range(0, n, CHUNK):
        chunk = list(range(start, min(start + CHUNK, n)))
        await asyncio.gather(*(_edit_one(k) for k in chunk))

    if media_entries_acc:
        try:
            media_service.ingest_urls(media_entries_acc)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_variant failed")

    failed_idx = [k for k, e in enumerate(angle_errors) if e]
    partial_error = (
        f"variants_failed:{','.join(str(i) for i in failed_idx[:3])}"
        if failed_idx
        else None
    )

    return (
        {
            "media_ids": media_ids,
            "axis_key": axis_key,
            "slot_errors": angle_errors,
            "partial_error": partial_error,
            "media_entries": [],  # already ingested
        },
        None,
    )


# Late-bind these too — same forward-ref pattern as gen_multiview.
_DEFAULT_HANDLERS["gen_variant"] = _handle_gen_variant


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
                # Drift guard — the row might have been canceled (or
                # otherwise transitioned out of queued) between enqueue
                # and pop. The cancel endpoint mutates the DB row only;
                # it can't yank the rid back off the in-memory queue, so
                # we re-check here and bail without flipping status.
                if req.status != "queued":
                    logger.info(
                        "worker: skipping rid=%s (status=%s)", rid, req.status
                    )
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
                # Enrich with the request's node_id so handlers that need
                # to look up Node.data (e.g. storyboard) don't depend on
                # the caller copying it into params explicitly. Underscore
                # prefix avoids colliding with handler-defined fields.
                if req.node_id is not None and "__node_id" not in params:
                    params["__node_id"] = req.node_id
                # Long-running handlers re-check this rid between polls
                # to honor user-initiated cancels.
                params["__request_id"] = rid

            # Release the session during the possibly-long RPC.
            result, err = await handler(params)

            with get_session() as s:
                req = s.get(Request, rid)
                if req is None:
                    return
                # Don't overwrite a canceled row with a late-arriving
                # done/failed stamp. The cancel endpoint already set
                # status='canceled' and finished_at; we only persist the
                # partial result for debugging visibility.
                if req.status == "canceled":
                    if isinstance(result, dict):
                        req.result = result
                        s.add(req)
                        s.commit()
                    return
                req.result = result if isinstance(result, dict) else {"value": result}
                req.finished_at = datetime.now(timezone.utc)
                if err:
                    # Video-poll exhaustion gets its own status so the UI
                    # can render "TIMEOUT" instead of a generic failure.
                    req.status = "timeout" if err == "timeout_waiting_video" else "failed"
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
                    if req is not None and req.status != "canceled":
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
