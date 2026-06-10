"""Minimal Google Flow SDK wrapper.

Ported from flowkit (`/tmp/flowkit-ref/agent/services/flow_client.py`).
Trimmed to what Run 4 ships: `create_project` (TRPC) + `gen_image` (api_request
with IMAGE_GENERATION captcha). Video / upload / upscale / check_async land in
later runs.

The wrapper intentionally preserves `raw` on every return so callers (and the
request-worker that persists it to the DB) can inspect Flow's error payload
when the user's paygate tier or model name drifts.
"""
from __future__ import annotations

import logging
import re
import time
import uuid
from typing import Any, Optional

from flowboard.services.flow_client import FlowClient, flow_client

logger = logging.getLogger(__name__)

# Endpoints -----------------------------------------------------------------

FLOW_API_BASE = "https://aisandbox-pa.googleapis.com"
TRPC_CREATE_PROJECT = "https://labs.google/fx/api/trpc/project.createProject"
VIDEO_I2V_URL = f"{FLOW_API_BASE}/v1/video:batchAsyncGenerateVideoStartImage"
# Omni Flash uses a separate endpoint that takes referenceImages[] (multi-
# ref, asset-typed) instead of a single startImage. Different request shape
# from Veo i2v — see gen_video_omni() for the body assembly.
VIDEO_OMNI_URL = f"{FLOW_API_BASE}/v1/video:batchAsyncGenerateVideoReferenceImages"
VIDEO_POLL_URL = f"{FLOW_API_BASE}/v1/video:batchCheckAsyncVideoGenerationStatus"
UPLOAD_IMAGE_URL = f"{FLOW_API_BASE}/v1/flow/uploadImage"


# Omni Flash — variable-duration r2v video model. Each duration maps to a
# distinct Flow model key. Credit cost scales with duration. Same key on
# Pro (TIER_ONE) and Ultra (TIER_TWO) per owner; revisit if Google ships
# a per-tier Ultra variant.
OMNI_FLASH_DURATION_KEYS: dict[int, str] = {
    4: "abra_r2v_4s",
    6: "abra_r2v_6s",
    8: "abra_r2v_8s",
    10: "abra_r2v_10s",
}
OMNI_FLASH_VALID_ASPECTS: set[str] = {
    "VIDEO_ASPECT_RATIO_PORTRAIT",
    "VIDEO_ASPECT_RATIO_LANDSCAPE",
}
# Informational — backend doesn't enforce, frontend surfaces to the user
# at dispatch time so the credit cost is visible before submit.
OMNI_FLASH_CREDIT_COST: dict[int, int] = {4: 15, 6: 20, 8: 25, 10: 30}


def resolve_omni_flash_model(duration_s: int) -> str:
    """Map a duration (4/6/8/10s) → Flow model key for Omni Flash.
    Raises if the duration is unsupported."""
    key = OMNI_FLASH_DURATION_KEYS.get(duration_s)
    if not key:
        raise ValueError(
            f"Omni Flash duration {duration_s}s unsupported "
            f"(valid: {sorted(OMNI_FLASH_DURATION_KEYS)})"
        )
    return key


def _media_get_url(media_id: str) -> str:
    """Endpoint that returns inline encoded video bytes for a workflow's
    primary media. Used to poll Low Priority (workflow-schema) submissions —
    they have no operation name and don't appear in ``batchCheckAsync``."""
    return f"{FLOW_API_BASE}/v1/media/{media_id}?clientContext.tool=PINHOLE"

# Image model keys, indexed by the user-facing nickname used in
# flowkit's models.json. Pro is Flow's premium / higher-quality image
# model; "Banana 2" (NARWHAL) is the lighter / faster option. The
# frontend Settings panel lets the user pick which one drives gen_image
# + edit_image at request time. Update when Google rotates model names.
IMAGE_MODELS: dict[str, str] = {
    "NANO_BANANA_PRO": "GEM_PIX_2",
    "NANO_OMNI": "GEM_OMNI_1",
    "NANO_BANANA_2": "NARWHAL",
}
DEFAULT_IMAGE_MODEL_KEY = "NANO_BANANA_PRO"


def resolve_image_model(key: Optional[str]) -> str:
    """Map a nickname (`NANO_BANANA_PRO` / `NANO_BANANA_2` / `NANO_OMNI`) to the actual
    Flow model identifier. Falls back to the Pro default for unknown /
    missing keys so a stale frontend can't break dispatch."""
    if isinstance(key, str) and key in IMAGE_MODELS:
        return IMAGE_MODELS[key]
    return IMAGE_MODELS[DEFAULT_IMAGE_MODEL_KEY]

# Video model keys nested by [tier][quality][aspect]. All values verified
# against real Flow web request bodies (curl exports from labs.google's
# Network tab) — do NOT speculate suffixes here, only use observed keys.
#
# `quality` is "fast" (default), "lite", "quality", or — Ultra only —
# "lite_relaxed" / "fast_relaxed" (0-credit low-priority queue).
#   - Lite (`veo_3_1_i2v_lite`) is shared by Tier 1 and Tier 2; verified
#     from PRO PLAN and ULTRA PLAN curls (see video_model.md and
#     video_model_ultra.md). Multi-aspect — same key for both 16:9 and
#     9:16; the model adapts via the aspectRatio field.
#   - Quality (`veo_3_1_i2v_s` / `veo_3_1_i2v_s_portrait`) is also shared
#     across both tiers; the difference is the `userPaygateTier` in
#     clientContext (rate limits / queue priority), not the model key.
#   - Tier 2 Fast naming pattern: Tier 1 Fast key + `_ultra` suffix
#     (e.g. `veo_3_1_i2v_s_fast` → `veo_3_1_i2v_s_fast_ultra`,
#     `veo_3_1_i2v_s_fast_portrait` → `veo_3_1_i2v_s_fast_portrait_ultra`).
#   - Tier 2 "low priority" 0-credit models (Ultra-only fallback when the
#     user wants to keep their daily credit budget): Lite uses the
#     `_low_priority` suffix (`veo_3_1_i2v_lite_low_priority`); Fast uses
#     the `_relaxed` suffix on the ultra family (`veo_3_1_i2v_s_fast_ultra_relaxed`).
#     Verified from ULTRA PLAN curls. PORTRAIT keys for these are not yet
#     observed — we reuse the LANDSCAPE key for both aspects (Lite is
#     genuinely multi-aspect; Fast Relaxed portrait will need a real curl
#     to confirm, but Flow's portrait variants typically follow the
#     `_portrait` suffix convention if separate keys are required).
VIDEO_MODEL_KEYS: dict[str, dict[str, dict[str, str]]] = {
    # Tier 1 (Pro) — three quality levels, all verified from real PRO
    # PLAN curls (see video_model.md). Lite shares `veo_3_1_i2v_lite`
    # with Tier 2; Quality shares `veo_3_1_i2v_s` with Tier 2 — paygate
    # tier in clientContext drives any per-tier difference. No 0-credit
    # low-priority option here — that's a Tier 2 (Ultra) perk.
    "PAYGATE_TIER_ONE": {
        "lite": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_lite",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_lite",
        },
        "fast": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_s_fast",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_s_fast_portrait",
        },
        "quality": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_s",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_s_portrait",
        },
    },
    # Tier 2 (Ultra) — five quality levels:
    #   - lite: `veo_3_1_i2v_lite` (5 credits, multi-aspect)
    #   - fast: `_fast_ultra` family (10 credits, default, balanced)
    #   - quality: `veo_3_1_i2v_s*` family (highest fidelity, slowest)
    #   - lite_relaxed: `veo_3_1_i2v_lite_low_priority` (0 credits,
    #     low-priority queue, Ultra-only)
    #   - fast_relaxed: `veo_3_1_i2v_s_fast_ultra_relaxed` (0 credits,
    #     low-priority queue, Ultra-only).
    #   PORTRAIT keys for the `_relaxed` family are not yet verified
    #   from a real curl; we reuse the LANDSCAPE key as a best-effort
    #   fallback. If Flow rejects portrait dispatches, capture a portrait
    #   curl and add the proper key here.
    "PAYGATE_TIER_TWO": {
        "lite": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_lite",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_lite",
        },
        "fast": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_s_fast_ultra",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_s_fast_portrait_ultra",
        },
        "quality": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_s",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_s_portrait",
        },
        "lite_relaxed": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_lite_low_priority",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_lite_low_priority",
        },
        "fast_relaxed": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_s_fast_ultra_relaxed",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_s_fast_ultra_relaxed",
        },
    },
}

DEFAULT_VIDEO_QUALITY = "fast"


def resolve_video_model(
    paygate_tier: str, aspect_ratio: str, quality: Optional[str] = None
) -> Optional[str]:
    """Resolve a Flow video model key from tier + aspect + quality.

    Falls back through (quality → fast) → (tier → TIER_ONE) → None so
    a stale frontend or unknown tier can't break dispatch silently.
    """
    q = (quality or DEFAULT_VIDEO_QUALITY).lower()
    tier_map = (
        VIDEO_MODEL_KEYS.get(paygate_tier)
        or VIDEO_MODEL_KEYS.get("PAYGATE_TIER_ONE")
        or {}
    )
    quality_map = tier_map.get(q) or tier_map.get(DEFAULT_VIDEO_QUALITY) or {}
    return quality_map.get(aspect_ratio)

# project_id must match the shape Google Flow returns (UUID-ish). Validated at
# handler boundaries to prevent path traversal into arbitrary API URLs.
_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

# Flow CDN URLs embed the UUID media_id in the path:
#   https://flow-content.google/video/<UUID>?Expires=...&Signature=...
# When the polling response omits `metadata.video.mediaId` (it usually does for
# video — only `mediaGenerationId` which is a base64 protobuf, NOT a UUID),
# we recover the UUID from the URL exactly like flowkit does.
_UUID_IN_URL_RE = re.compile(
    r"/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)


def _media_id_from_url(url: Optional[str]) -> Optional[str]:
    if not isinstance(url, str):
        return None
    m = _UUID_IN_URL_RE.search(url)
    return m.group(1) if m else None


def _extract_inner_api_error(resp: Any) -> Optional[str]:
    """Surface a Flow API error if the response envelope indicates one.

    `flow_client.api_request` returns ``{"id", "status", "data"}`` on a
    completed round-trip even when the underlying call failed — the HTTP
    status from Google lives on ``resp["status"]`` and the structured error
    body on ``resp["data"]["error"]``. Top-level ``resp["error"]`` is only
    set by the client itself for transport-level failures (which we already
    handle). When ``status >= 400`` or ``data.error.status`` is set, the
    request must be reported as failed — silently treating an empty
    ``media_ids`` list as success masked Flow's content-filter rejections
    (e.g. ``PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED``).
    """
    if not isinstance(resp, dict):
        return None
    status = resp.get("status")
    data = resp.get("data") if isinstance(resp.get("data"), dict) else None
    err = data.get("error") if isinstance(data, dict) else None
    has_status_err = isinstance(status, int) and status >= 400
    has_data_err = isinstance(err, dict)
    if not (has_status_err or has_data_err):
        return None
    if has_data_err:
        reasons: list[str] = []
        for detail in err.get("details") or []:
            if isinstance(detail, dict):
                r = detail.get("reason")
                if isinstance(r, str) and r:
                    reasons.append(r)
        msg = err.get("message") or err.get("status") or "API error"
        return f"{reasons[0]}: {msg}" if reasons else str(msg)
    return f"API_{status}"


def is_valid_project_id(project_id: str) -> bool:
    return bool(_PROJECT_ID_RE.fullmatch(project_id))

# Captcha action strings recognised by Google Flow.
CAPTCHA_IMAGE = "IMAGE_GENERATION"
CAPTCHA_VIDEO = "VIDEO_GENERATION"

# Default max operations to poll in parallel. Conservative; flowkit passes
# the full list at once.
_MAX_VIDEO_OPS = 4

# Image variants per dispatch are capped server-side as defence-in-depth — the
# UI clamps to 4 too for standard runs, but batch runs can go higher (e.g. cross product).
MAX_VARIANT_COUNT = 99

# Minimal static headers that have worked against labs.google in flowkit.
_TRPC_HEADERS = {
    "content-type": "application/json",
    "accept": "*/*",
}
_API_HEADERS = {
    "content-type": "text/plain;charset=UTF-8",
    "accept": "*/*",
    "origin": "https://labs.google",
    "referer": "https://labs.google/",
}


def _client_context(project_id: str, paygate_tier: str) -> dict:
    """Skeleton clientContext — extension fills in recaptchaContext.token.

    `paygate_tier` is REQUIRED (no default). Pre-v1.1.5 the default was
    `"PAYGATE_TIER_ONE"` which silently downgraded Ultra users when any
    upstream code path forgot to pass tier. Now we raise loudly on
    invalid / unknown values so a code regression can't quietly serve
    Pro to an Ultra account.
    """
    if paygate_tier not in _VALID_TIERS:
        raise ValueError(
            f"invalid paygate_tier {paygate_tier!r} — must be one of {sorted(_VALID_TIERS)}"
        )
    return {
        "projectId": str(project_id),
        "recaptchaContext": {
            "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
            "token": "",
        },
        "sessionId": f";{int(time.time() * 1000)}",
        "tool": "PINHOLE",
        "userPaygateTier": paygate_tier,
    }


def _generate_images_url(project_id: str) -> str:
    return f"{FLOW_API_BASE}/v1/projects/{project_id}/flowMedia:batchGenerateImages"


class FlowSDK:
    """High-level helpers on top of ``flow_client``. Stateless."""

    def __init__(self, client: Optional[FlowClient] = None) -> None:
        self._client = client or flow_client

    # ── project creation (TRPC) ────────────────────────────────────────────
    async def create_project(
        self, title: str, tool: str = "PINHOLE"
    ) -> dict[str, Any]:
        body = {"json": {"projectTitle": title, "toolName": tool}}
        resp = await self._client.trpc_request(
            url=TRPC_CREATE_PROJECT,
            method="POST",
            headers=_TRPC_HEADERS,
            body=body,
        )
        if isinstance(resp, dict) and resp.get("error"):
            return {"raw": resp, "error": resp["error"]}

        project_id = _extract_project_id(resp)
        out: dict[str, Any] = {"raw": resp}
        if project_id is None:
            out["error"] = "no_project_id_in_response"
        else:
            out["project_id"] = project_id
        return out

    # ── video generation (async via operations) ────────────────────────────
    async def gen_video(
        self,
        prompt: str,
        project_id: str,
        start_media_id: Optional[str] = None,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier: Optional[str] = None,
        scene_id: Optional[str] = None,
        start_media_ids: Optional[list[str]] = None,
        video_quality: Optional[str] = None,
        prompts: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """Kick off i2v operation(s). Returns ``{raw, operation_names}`` on
        success or ``{raw, error}`` on failure. Operations are async — the
        caller polls ``check_async`` until they complete.

        ``start_media_ids`` (optional list) — when provided, dispatch ONE
        item per source image so a 4-variant upstream image produces 4
        videos in a single batch (one operation per source). Falls back to
        ``start_media_id`` (single) if the list is missing/empty.

        ``video_quality`` ("fast" / "lite" / "quality" / "lite_relaxed"
        / "fast_relaxed") routes to a different Veo checkpoint. Defaults
        to "fast" — the `_s_fast` family. The first three are available
        on both Tier 1 (Pro) and Tier 2 (Ultra); the `_relaxed` variants
        are 0-credit low-priority queues and are Ultra-only. See
        ``VIDEO_MODEL_KEYS`` for the per-tier mapping.

        ``paygate_tier`` is required. Pre-v1.1.5 it defaulted to
        ``"PAYGATE_TIER_ONE"`` which silently downgraded Ultra users.
        Raise loudly instead — the worker should always have a tier
        from the live extension signal before reaching here.
        """
        if paygate_tier is None:
            raise ValueError("paygate_tier is required — see docs/migrations/clear-polluted-paygate-tier.sql")
        model_key = resolve_video_model(paygate_tier, aspect_ratio, video_quality)
        if not model_key:
            return {
                "raw": None,
                "error": (
                    f"no_video_model_for_tier_{paygate_tier}"
                    f"_quality_{video_quality or DEFAULT_VIDEO_QUALITY}"
                    f"_aspect_{aspect_ratio}"
                ),
            }

        # Normalise into a non-empty list of source media ids. Single
        # `start_media_id` is the common case; `start_media_ids` is for
        # batch-i2v from a multi-variant upstream image.
        sources: list[str] = []
        if start_media_ids:
            sources = [m for m in start_media_ids if isinstance(m, str) and m]
        if not sources and isinstance(start_media_id, str) and start_media_id:
            sources = [start_media_id]
        if not sources:
            return {"raw": None, "error": "missing_start_media_id"}

        # Per-variant prompts: when the caller provides ``prompts``, pair
        # prompts[i] with source[i] so each i2v clip uses its own text.
        # Missing/short lists fall back to the shared ``prompt``. This is
        # what makes zip/cross batch modes emit distinct clips instead of
        # N copies of the first prompt.
        per_item_prompts: list[str] = []
        for i in range(len(sources)):
            if prompts and i < len(prompts) and isinstance(prompts[i], str) and prompts[i]:
                per_item_prompts.append(prompts[i])
            else:
                per_item_prompts.append(prompt)

        ts = int(time.time() * 1000)
        ctx = _client_context(project_id, paygate_tier)
        items: list[dict[str, Any]] = []
        for i, mid in enumerate(sources):
            items.append({
                "aspectRatio": aspect_ratio,
                # Distinct seed per item so Flow doesn't dedupe.
                "seed": (ts + i * 9973) % 1_000_000,
                "textInput": {"structuredPrompt": {"parts": [{"text": per_item_prompts[i]}]}},
                "videoModelKey": model_key,
                "startImage": {"mediaId": mid},
                "metadata": {"sceneId": scene_id or str(uuid.uuid4())},
            })
        body = {
            "clientContext": ctx,
            "mediaGenerationContext": {"batchId": str(uuid.uuid4())},
            "requests": items,
            "useV2ModelConfig": True,
        }

        resp = await self._client.api_request(
            url=VIDEO_I2V_URL,
            method="POST",
            headers=dict(_API_HEADERS),
            body=body,
            captcha_action=CAPTCHA_VIDEO,
        )
        if isinstance(resp, dict) and resp.get("error"):
            return {"raw": resp, "error": resp["error"]}
        inner_err = _extract_inner_api_error(resp)
        if inner_err:
            return {"raw": resp, "error": inner_err}

        op_names = extract_operation_names(resp)
        if not op_names:
            return {"raw": resp, "error": "no_operations_in_response"}
        out: dict[str, Any] = {"raw": resp, "operation_names": op_names}
        # NEW low-priority workflow models return `data.workflows[]` with a
        # `primaryMediaId` per workflow instead of operations. Surface the
        # pairing so the poller can hit `/v1/media/<id>` directly.
        workflows = extract_video_workflows(resp)
        if workflows:
            out["workflows"] = workflows
        return out

    # ── Omni Flash — variable-duration r2v ─────────────────────────────────
    async def gen_video_omni(
        self,
        prompt: str,
        project_id: str,
        ref_media_ids: list[str],
        duration_s: int,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT",
        paygate_tier: Optional[str] = None,
        seed: Optional[int] = None,
        start_media_ids: Optional[list[str]] = None,
        prompts: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """Kick off Omni Flash video generation. Distinct from Veo i2v —
        uses /video:batchAsyncGenerateVideoReferenceImages with a
        referenceImages[] payload + per-duration model key.

        Returns ``{raw, operation_names}`` on success or ``{raw, error}``
        on failure. Polls via the shared ``check_async`` path — Omni
        operations come back in the same shape as Veo's.

        ``ref_media_ids`` MUST be non-empty (Omni requires at least one
        asset reference; the model is reference-conditioned, not text-only).
        ``duration_s`` ∈ {4,6,8,10}.
        ``aspect_ratio`` ∈ {PORTRAIT, LANDSCAPE} (no SQUARE per owner).
        ``paygate_tier`` required — same as gen_video.
        """
        if paygate_tier is None:
            raise ValueError("paygate_tier is required")
        if aspect_ratio not in OMNI_FLASH_VALID_ASPECTS:
            return {
                "raw": None,
                "error": f"omni_aspect_unsupported_{aspect_ratio}",
            }
        shared_refs = [m for m in (ref_media_ids or []) if isinstance(m, str) and m]
        batch_sources = [m for m in (start_media_ids or []) if isinstance(m, str) and m]
        # Batch mode: each start image becomes its own video, conditioned on
        # that image (plus any shared reference ingredients). This is what
        # makes a zip/cross batch (N prompts x N images) emit N distinct
        # clips instead of collapsing everything into one video. Without a
        # batch the request is a single video conditioned on every ref image.
        if not batch_sources and not shared_refs:
            return {"raw": None, "error": "missing_ref_media_ids"}
        try:
            model_key = resolve_omni_flash_model(duration_s)
        except ValueError as exc:
            return {"raw": None, "error": str(exc)[:200]}

        ts = int(time.time() * 1000)
        ctx = _client_context(project_id, paygate_tier)

        def _ref_images(ids: list[str]) -> list[dict[str, Any]]:
            return [
                {"mediaId": mid, "imageUsageType": "IMAGE_USAGE_TYPE_ASSET"}
                for mid in ids
            ]

        items: list[dict[str, Any]] = []
        if batch_sources:
            for i, mid in enumerate(batch_sources):
                item_prompt = (
                    prompts[i]
                    if prompts
                    and i < len(prompts)
                    and isinstance(prompts[i], str)
                    and prompts[i]
                    else prompt
                )
                items.append({
                    "aspectRatio": aspect_ratio,
                    "textInput": {"structuredPrompt": {"parts": [{"text": item_prompt}]}},
                    "videoModelKey": model_key,
                    # Distinct seed per item so Flow doesn't dedupe.
                    "seed": (ts + i * 9973) % 1_000_000,
                    "metadata": {},
                    "referenceImages": _ref_images([mid, *shared_refs]),
                })
        else:
            used_seed = seed if seed is not None else ts % 1_000_000
            items.append({
                "aspectRatio": aspect_ratio,
                "textInput": {"structuredPrompt": {"parts": [{"text": prompt}]}},
                "videoModelKey": model_key,
                "seed": used_seed,
                "metadata": {},
                "referenceImages": _ref_images(shared_refs),
            })
        body = {
            "mediaGenerationContext": {
                "batchId": str(uuid.uuid4()),
                # Omni's V2 config flags silent-audio outputs as failures
                # so the caller can retry with a different prompt instead
                # of getting back a silently-degraded video.
                "audioFailurePreference": "BLOCK_SILENCED_VIDEOS",
            },
            "clientContext": {**ctx, "sessionId": f";{ts}"},
            "requests": items,
            "useV2ModelConfig": True,
        }

        resp = await self._client.api_request(
            url=VIDEO_OMNI_URL,
            method="POST",
            headers=dict(_API_HEADERS),
            body=body,
            captcha_action=CAPTCHA_VIDEO,
        )
        if isinstance(resp, dict) and resp.get("error"):
            return {"raw": resp, "error": resp["error"]}
        inner_err = _extract_inner_api_error(resp)
        if inner_err:
            return {"raw": resp, "error": inner_err}

        op_names = extract_operation_names(resp)
        if not op_names:
            return {"raw": resp, "error": "no_operations_in_response"}
        out: dict[str, Any] = {"raw": resp, "operation_names": op_names}
        workflows = extract_video_workflows(resp)
        if workflows:
            out["workflows"] = workflows
        return out

    async def check_async(
        self,
        operation_names: list[str],
        workflows: Optional[list[dict[str, Any]]] = None,
    ) -> dict[str, Any]:
        """Poll one or more video operations. No captcha.

        Returns ``{raw, operations: [{name, done, media_entries}]}`` — one
        entry per input operation. ``media_entries`` is a list of
        ``{media_id, url, mediaType}`` ready for ``media.ingest_urls``.

        ``workflows`` (optional) carries ``{name, primary_media_id}`` pairs
        from the NEW low-priority response. When provided, every workflow
        entry is polled against ``/v1/media/<primary_media_id>`` and the
        result is merged into the same ``operations`` shape so the caller
        is schema-agnostic.
        """
        ops_summary: list[dict[str, Any]] = []
        raw_old: Any = None
        # Names that came from workflows are NOT valid operation handles —
        # don't dispatch them to batchCheckAsync (Flow would 400).
        workflow_names = {w["name"] for w in (workflows or []) if isinstance(w, dict) and w.get("name")}
        old_names = [n for n in operation_names if n not in workflow_names]
        if old_names:
            body = {
                "operations": [
                    {"operation": {"name": name}} for name in old_names
                ]
            }
            raw_old = await self._client.api_request(
                url=VIDEO_POLL_URL,
                method="POST",
                headers=dict(_API_HEADERS),
                body=body,
            )
            if isinstance(raw_old, dict) and raw_old.get("error"):
                return {"raw": raw_old, "error": raw_old["error"]}
            ops_summary.extend(
                extract_video_operations(raw_old, requested=old_names)
            )

        raw_workflows: list[dict[str, Any]] = []
        if workflows:
            wf_summary, raw_workflows = await self._poll_workflows(workflows)
            ops_summary.extend(wf_summary)

        # Preserve the original input order so callers (worker) can keep
        # positional alignment with their per-op state.
        order = {name: i for i, name in enumerate(operation_names)}
        ops_summary.sort(key=lambda op: order.get(op.get("name"), 1 << 30))

        raw_out: dict[str, Any] = {}
        if raw_old is not None:
            raw_out["operations_poll"] = raw_old
        if raw_workflows:
            raw_out["workflow_polls"] = raw_workflows
        return {"raw": raw_out or raw_old, "operations": ops_summary}

    async def _poll_workflows(
        self, workflows: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Single poll pass for workflow-mode (Low Priority) submissions.

        For each ``{name, primary_media_id}`` pair, GET ``/v1/media/<id>``
        and inspect ``video.encodedVideo``. Flow returns base64-encoded MP4
        once rendering completes; before that the payload is metadata-only
        (small bytes, no ``ftyp`` magic) — we treat that as "still pending".

        Returns ``(ops_summary, raw_polls)`` mirroring the OLD-schema
        ``check_async`` contract: one entry per workflow with
        ``{name, done, media_entries, status, error}``. The poll loop in
        the worker calls this repeatedly via ``check_async`` until ``done``.
        """
        import base64 as _b64

        ops_summary: list[dict[str, Any]] = []
        raw_polls: list[dict[str, Any]] = []
        for wf in workflows:
            if not isinstance(wf, dict):
                continue
            name = wf.get("name")
            mid = wf.get("primary_media_id")
            if not isinstance(name, str) or not isinstance(mid, str) or not mid:
                continue
            try:
                resp = await self._client.api_request(
                    url=_media_get_url(mid),
                    method="GET",
                    headers=dict(_API_HEADERS),
                    body=None,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("workflow poll error for %s: %s", mid[:8], exc)
                ops_summary.append(
                    {
                        "name": name,
                        "done": False,
                        "media_entries": [],
                        "status": None,
                        "error": None,
                    }
                )
                continue
            raw_polls.append({"name": name, "media_id": mid, "resp": resp})

            # Transport / API failure — keep polling. Treat 404 as "not ready"
            # too; Flow sometimes 404s the media endpoint mid-render.
            if not isinstance(resp, dict):
                ops_summary.append(
                    {"name": name, "done": False, "media_entries": [], "status": None, "error": None}
                )
                continue
            status_code = resp.get("status")
            if isinstance(status_code, int) and status_code >= 400 and status_code != 404:
                # Surface the inner Flow error (e.g. content filter).
                inner = _extract_inner_api_error(resp)
                ops_summary.append(
                    {
                        "name": name,
                        "done": True,
                        "media_entries": [],
                        "status": None,
                        "error": inner or f"API_{status_code}",
                    }
                )
                continue

            # `data` is the body; for /v1/media it's the media object directly.
            data = resp.get("data") if isinstance(resp.get("data"), dict) else {}
            video_block = data.get("video") if isinstance(data.get("video"), dict) else {}
            encoded = (
                video_block.get("encodedVideo")
                if isinstance(video_block, dict)
                else None
            )
            if not isinstance(encoded, str) or not encoded:
                ops_summary.append(
                    {"name": name, "done": False, "media_entries": [], "status": None, "error": None}
                )
                continue
            try:
                binary = _b64.b64decode(encoded, validate=False)
            except Exception:  # noqa: BLE001
                ops_summary.append(
                    {"name": name, "done": False, "media_entries": [], "status": None, "error": None}
                )
                continue
            # MP4 box layout: bytes 4..8 == "ftyp" on a complete file.
            # Until that lands, Flow returns a small metadata payload — skip.
            is_mp4 = len(binary) >= 12 and binary[4:8] == b"ftyp"
            if not is_mp4:
                ops_summary.append(
                    {"name": name, "done": False, "media_entries": [], "status": None, "error": None}
                )
                continue
            fife = (
                video_block.get("fifeUrl") if isinstance(video_block, dict) else None
            ) or data.get("fifeUrl")
            ops_summary.append(
                {
                    "name": name,
                    "done": True,
                    "media_entries": [
                        {
                            "media_id": mid,
                            "url": fife if isinstance(fife, str) else None,
                            "mediaType": "video",
                            "encoded_video": encoded,
                        }
                    ],
                    "status": "MEDIA_GENERATION_STATUS_SUCCESSFUL",
                    "error": None,
                }
            )
        return ops_summary, raw_polls

    # ── image generation (api_request + captcha) ───────────────────────────
    async def gen_image(
        self,
        prompt: str,
        project_id: str,
        aspect_ratio: str = "IMAGE_ASPECT_RATIO_LANDSCAPE",
        paygate_tier: Optional[str] = None,
        ref_media_ids: Optional[list[str]] = None,
        variant_count: int = 1,
        character_media_ids: Optional[list[str]] = None,  # legacy alias
        prompts: Optional[list[str]] = None,
        image_model: Optional[str] = None,
    ) -> dict[str, Any]:
        """Generate ``variant_count`` images (1-4). When ``ref_media_ids`` is
        provided, every request item is augmented with ``imageInputs`` so Flow
        conditions the result on those upstream images (any combination of
        character / image / visual_asset upstream nodes — all become
        ``IMAGE_INPUT_TYPE_REFERENCE`` inputs).

        Multiple variants are produced by replicating the request item with
        distinct seeds — Flow returns one entry in ``data.media[]`` per
        request item.

        ``paygate_tier`` is required. See ``gen_video`` for rationale.
        """
        if paygate_tier is None:
            raise ValueError("paygate_tier is required — caller must resolve before dispatch")
        n = max(1, min(int(variant_count), MAX_VARIANT_COUNT))
        ts = int(time.time() * 1000)
        ctx = _client_context(project_id, paygate_tier)
        model_name = resolve_image_model(image_model)
        # Accept the legacy `character_media_ids` kwarg as a fallback.
        merged_refs = ref_media_ids if ref_media_ids is not None else character_media_ids
        image_inputs = None
        if merged_refs:
            image_inputs = [
                {"name": mid, "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE"}
                for mid in merged_refs
            ]

        # Per-variant prompts: when the caller provides `prompts`, each
        # request_item gets its own text so the 4 variants render with
        # different poses instead of 4 seeds of one stance. Missing /
        # short list falls back to the single `prompt` for that slot.
        per_item_prompts: list[str] = []
        for i in range(n):
            if prompts and i < len(prompts) and isinstance(prompts[i], str) and prompts[i]:
                per_item_prompts.append(prompts[i])
            else:
                per_item_prompts.append(prompt)

        requests_arr: list[dict[str, Any]] = []
        for i in range(n):
            seed = (ts + i * 9973) % 1_000_000  # any deterministic spread is fine
            item: dict[str, Any] = {
                "clientContext": {**ctx, "sessionId": f";{ts + i}"},
                "seed": seed,
                "structuredPrompt": {"parts": [{"text": per_item_prompts[i]}]},
                "imageAspectRatio": aspect_ratio,
                "imageModelName": model_name,
            }
            if merged_refs:
                # If we have equal number of prompts and media references, pair them 1-to-1!
                if prompts and len(prompts) == len(merged_refs) and i < len(merged_refs):
                    item["imageInputs"] = [
                        {"name": merged_refs[i], "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE"}
                    ]
                else:
                    item["imageInputs"] = [
                        {"name": mid, "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE"}
                        for mid in merged_refs
                    ]
            requests_arr.append(item)

        body = {
            "clientContext": ctx,
            "mediaGenerationContext": {"batchId": str(uuid.uuid4())},
            "useNewMedia": True,
            "requests": requests_arr,
        }

        resp = await self._client.api_request(
            url=_generate_images_url(project_id),
            method="POST",
            headers=dict(_API_HEADERS),
            body=body,
            captcha_action=CAPTCHA_IMAGE,
        )
        if isinstance(resp, dict) and resp.get("error"):
            return {"raw": resp, "error": resp["error"]}
        inner_err = _extract_inner_api_error(resp)
        if inner_err:
            return {"raw": resp, "error": inner_err}

        entries = extract_media_entries(resp)
        media_ids = [e["media_id"] for e in entries]
        return {"raw": resp, "media_ids": media_ids, "media_entries": entries}

    # ── image refine (edit_image) ──────────────────────────────────────────
    async def edit_image(
        self,
        prompt: str,
        project_id: str,
        source_media_id: str,
        ref_media_ids: Optional[list[str]] = None,
        aspect_ratio: str = "IMAGE_ASPECT_RATIO_LANDSCAPE",
        paygate_tier: Optional[str] = None,
        image_model: Optional[str] = None,
    ) -> dict[str, Any]:
        """Refine an existing image with an optional list of reference media.

        Order of ``imageInputs`` matters — flowkit puts BASE_IMAGE first so
        Flow knows which is the canonical source.

        ``paygate_tier`` is required. See ``gen_video`` for rationale.
        """
        if paygate_tier is None:
            raise ValueError("paygate_tier is required — caller must resolve before dispatch")
        ts = int(time.time() * 1000)
        ctx = _client_context(project_id, paygate_tier)
        model_name = resolve_image_model(image_model)

        image_inputs: list[dict[str, Any]] = [
            {"name": source_media_id, "imageInputType": "IMAGE_INPUT_TYPE_BASE_IMAGE"}
        ]
        for mid in ref_media_ids or []:
            if isinstance(mid, str) and mid:
                image_inputs.append(
                    {"name": mid, "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE"}
                )

        request_item = {
            "clientContext": {**ctx, "sessionId": f";{ts}"},
            "seed": ts % 1_000_000,
            "structuredPrompt": {"parts": [{"text": prompt}]},
            "imageAspectRatio": aspect_ratio,
            "imageModelName": model_name,
            "imageInputs": image_inputs,
        }
        body = {
            "clientContext": ctx,
            "mediaGenerationContext": {"batchId": str(uuid.uuid4())},
            "useNewMedia": True,
            "requests": [request_item],
        }

        resp = await self._client.api_request(
            url=_generate_images_url(project_id),
            method="POST",
            headers=dict(_API_HEADERS),
            body=body,
            captcha_action=CAPTCHA_IMAGE,
        )
        if isinstance(resp, dict) and resp.get("error"):
            return {"raw": resp, "error": resp["error"]}
        inner_err = _extract_inner_api_error(resp)
        if inner_err:
            return {"raw": resp, "error": inner_err}

        entries = extract_media_entries(resp)
        media_ids = [e["media_id"] for e in entries]
        return {"raw": resp, "media_ids": media_ids, "media_entries": entries}

    # ── image upload (api_request, no captcha) ─────────────────────────────
    async def upload_image(
        self,
        image_base64: str,
        mime_type: str,
        project_id: str,
        file_name: str = "upload.png",
    ) -> dict[str, Any]:
        """Upload a user-provided image into a Flow project. Returns
        ``{raw, media_id}`` on success or ``{raw, error}`` on failure.

        ``image_base64`` should be a base64-encoded payload (no data: prefix).
        Flow accepts the image bytes inline in the JSON body.
        """
        body = {
            "clientContext": {
                "projectId": str(project_id),
                "tool": "PINHOLE",
            },
            "fileName": file_name,
            "imageBytes": image_base64,
            "isHidden": False,
            "isUserUploaded": True,
            "mimeType": mime_type,
        }
        resp = await self._client.api_request(
            url=UPLOAD_IMAGE_URL,
            method="POST",
            headers=dict(_API_HEADERS),
            body=body,
        )
        if isinstance(resp, dict) and resp.get("error"):
            return {"raw": resp, "error": resp["error"]}

        media_id = _extract_uploaded_media_id(resp)
        if media_id is None:
            # Flow returned 200 but no usable media handle. Most common cause
            # is a silent content-filter rejection (logos/watermarks/branded
            # imagery from product CDNs); next most common is a Flow schema
            # change. Log the full payload so the operator can tell which.
            logger.error(
                "upload_image: no media_id in response (project_id=%s, "
                "file=%s, mime=%s) — raw=%r",
                project_id, file_name, mime_type, resp,
            )
            return {"raw": resp, "error": "no_media_id_in_upload_response"}
        return {"raw": resp, "media_id": media_id}


def _extract_project_id(resp: Any) -> Optional[str]:
    """TRPC createProject nests the projectId quite deeply."""
    try:
        data = resp.get("data") if isinstance(resp, dict) else None
        return data["result"]["data"]["json"]["result"]["projectId"]  # type: ignore[index]
    except (KeyError, TypeError):
        return None


_VALID_TIERS = {"PAYGATE_TIER_ONE", "PAYGATE_TIER_TWO"}


def _extract_uploaded_media_id(resp: Any) -> Optional[str]:
    """uploadImage returns ``data.media.name`` as the new media_id."""
    if not isinstance(resp, dict):
        return None
    data = resp.get("data")
    if not isinstance(data, dict):
        return None
    media = data.get("media")
    if isinstance(media, dict):
        name = media.get("name")
        if isinstance(name, str) and name:
            return name
    return None


def extract_operation_names(resp: Any) -> list[str]:
    """Pull ``operation.name`` out of a ``batchAsyncGenerateVideo*`` response.

    Supports two shapes:

    * **OLD** (Lite / Fast / Quality) — ``data.operations[].operation.name``.
    * **NEW** (Low Priority — ``_low_priority`` / ``_relaxed`` models) —
      ``data.workflows[].name``. Workflows don't have ``operation.name``;
      callers that need to poll must also read ``primaryMediaId`` from
      ``workflows[].metadata`` (see ``extract_video_workflows``).
    """
    if not isinstance(resp, dict):
        return []
    data = resp.get("data")
    if not isinstance(data, dict):
        return []
    names: list[str] = []
    ops = data.get("operations")
    if isinstance(ops, list):
        for op in ops:
            if not isinstance(op, dict):
                continue
            inner = op.get("operation") if isinstance(op.get("operation"), dict) else None
            if inner is None:
                # Some variants inline the name at top level.
                name = op.get("name")
            else:
                name = inner.get("name")
            if isinstance(name, str) and name:
                names.append(name)
    if names:
        return names
    # NEW workflow schema — `data.workflows[]` instead of `data.operations[]`.
    workflows = data.get("workflows")
    if isinstance(workflows, list):
        for wf in workflows:
            if not isinstance(wf, dict):
                continue
            name = wf.get("name")
            if isinstance(name, str) and name:
                names.append(name)
    return names


def extract_video_workflows(resp: Any) -> list[dict[str, Any]]:
    """Pull workflow entries out of a NEW-schema video submit response.

    Returns ``[{"name": <workflow_name>, "primary_media_id": <uuid>}, ...]``.
    Empty list when the response is OLD-schema (operations-based) or has no
    workflows. Callers use this to drive media-endpoint polling — workflow
    submits don't yield operations, so ``batchCheckAsync`` can't see them;
    we poll ``/v1/media/<primaryMediaId>`` directly and read the inline MP4
    bytes off ``video.encodedVideo`` once it lands.
    """
    if not isinstance(resp, dict):
        return []
    data = resp.get("data")
    if not isinstance(data, dict):
        return []
    workflows = data.get("workflows")
    if not isinstance(workflows, list):
        return []
    out: list[dict[str, Any]] = []
    for wf in workflows:
        if not isinstance(wf, dict):
            continue
        name = wf.get("name")
        meta = wf.get("metadata") if isinstance(wf.get("metadata"), dict) else {}
        primary = meta.get("primaryMediaId") if isinstance(meta, dict) else None
        if isinstance(name, str) and name and isinstance(primary, str) and primary:
            out.append({"name": name, "primary_media_id": primary})
    return out


def extract_video_operations(
    resp: Any, *, requested: list[str]
) -> list[dict[str, Any]]:
    """Summarise a ``batchCheckAsync`` response.

    Flow's response shape is::

        {"data": {"operations": [{
            "status": "MEDIA_GENERATION_STATUS_{PENDING,SUCCESSFUL,FAILED}",
            "operation": {"name": "<id>", "metadata": {"video": {
                "mediaId": "<uuid>", "fifeUrl": "https://flow-content..."
            }}}
        }]}}

    flowkit treats ``MEDIA_GENERATION_STATUS_SUCCESSFUL`` as terminal-success;
    we mirror that.

    Returns one entry per *requested* operation name, in order. Missing
    operations are reported as ``done=False`` so the caller can keep polling.
    """
    by_name: dict[str, dict[str, Any]] = {}
    if isinstance(resp, dict):
        data = resp.get("data")
        if isinstance(data, dict):
            ops = data.get("operations")
            if isinstance(ops, list):
                for op in ops:
                    if not isinstance(op, dict):
                        continue
                    inner = op.get("operation") if isinstance(op.get("operation"), dict) else op
                    name = inner.get("name") if isinstance(inner, dict) else None
                    if not isinstance(name, str):
                        continue
                    meta = (inner.get("metadata") or {}) if isinstance(inner, dict) else {}
                    video_meta = meta.get("video") if isinstance(meta.get("video"), dict) else {}
                    media_id = video_meta.get("mediaId") if isinstance(video_meta, dict) else None
                    fife = video_meta.get("fifeUrl") if isinstance(video_meta, dict) else None
                    # Flow's video poll response usually omits `mediaId` and only
                    # provides `mediaGenerationId` (base64 protobuf, NOT a UUID).
                    # The actual UUID is embedded in the `fifeUrl` path. Recover it.
                    if not (isinstance(media_id, str) and media_id):
                        recovered = _media_id_from_url(fife if isinstance(fife, str) else None)
                        if recovered is None and isinstance(video_meta, dict):
                            recovered = _media_id_from_url(video_meta.get("servingBaseUri"))
                        if recovered is not None:
                            media_id = recovered
                    # Flow puts the status at the *top* of each op envelope,
                    # not on the inner operation object — bug we hit before.
                    status = op.get("status") if isinstance(op.get("status"), str) else None
                    # Per-op terminal failure (e.g. PUBLIC_ERROR_AUDIO_FILTERED).
                    # Flow puts the error on the inner operation object as
                    # ``{code, message}``. We surface it so the worker can bail
                    # instead of polling for the full timeout.
                    op_err: Optional[str] = None
                    inner_err = inner.get("error") if isinstance(inner, dict) else None
                    if isinstance(inner_err, dict):
                        msg = inner_err.get("message") or inner_err.get("status") or "operation_failed"
                        op_err = str(msg)
                    if status == "MEDIA_GENERATION_STATUS_FAILED" and op_err is None:
                        op_err = "MEDIA_GENERATION_STATUS_FAILED"
                    done_flag = (
                        status == "MEDIA_GENERATION_STATUS_SUCCESSFUL"
                        or status == "MEDIA_GENERATION_STATUS_FAILED"
                        or bool(inner.get("done"))
                        or bool(media_id and fife)
                    )
                    entries = []
                    if (
                        done_flag
                        and op_err is None
                        and isinstance(media_id, str)
                    ):
                        entries.append(
                            {
                                "media_id": media_id,
                                "url": fife if isinstance(fife, str) else None,
                                "mediaType": "video",
                            }
                        )
                    by_name[name] = {
                        "name": name,
                        "done": done_flag,
                        "media_entries": entries,
                        "status": status,
                        "error": op_err,
                    }

    out: list[dict[str, Any]] = []
    for name in requested:
        out.append(
            by_name.get(
                name, {"name": name, "done": False, "media_entries": []}
            )
        )
    return out


def _extract_media_ids(resp: Any) -> list[str]:
    return [e["media_id"] for e in extract_media_entries(resp)]


def extract_media_entries(resp: Any) -> list[dict[str, Any]]:
    """Pull media entries out of a ``batchGenerateImages`` response.

    Returns a list of ``{media_id, url, mediaType}`` dicts suitable for
    ``media.ingest_urls``. ``url`` may be missing if Flow didn't include a
    ``fifeUrl`` for some reason — caller should handle that.
    """
    if not isinstance(resp, dict):
        return []
    data = resp.get("data")
    if not isinstance(data, dict):
        return []
    media = data.get("media")
    if not isinstance(media, list):
        return []
    out: list[dict[str, Any]] = []
    for m in media:
        if not isinstance(m, dict):
            continue
        media_id = m.get("name")
        if not isinstance(media_id, str) or not media_id:
            continue
        url: Optional[str] = None
        kind = "image"
        image = m.get("image") if isinstance(m.get("image"), dict) else None
        video = m.get("video") if isinstance(m.get("video"), dict) else None
        if image is not None:
            gen = image.get("generatedImage")
            if isinstance(gen, dict):
                candidate = gen.get("fifeUrl")
                if isinstance(candidate, str):
                    url = candidate
            kind = "image"
        elif video is not None:
            gen = video.get("generatedVideo") or video.get("generatedImage")
            if isinstance(gen, dict):
                candidate = gen.get("fifeUrl")
                if isinstance(candidate, str):
                    url = candidate
            kind = "video"
        out.append({"media_id": media_id, "url": url, "mediaType": kind})
    return out


_sdk: Optional[FlowSDK] = None


def get_flow_sdk() -> FlowSDK:
    global _sdk
    if _sdk is None:
        _sdk = FlowSDK()
    return _sdk
