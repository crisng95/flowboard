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

import re
import time
import uuid
from typing import Any, Optional

from flowboard.services.flow_client import FlowClient, flow_client

# Endpoints -----------------------------------------------------------------

FLOW_API_BASE = "https://aisandbox-pa.googleapis.com"
TRPC_CREATE_PROJECT = "https://labs.google/fx/api/trpc/project.createProject"
VIDEO_I2V_URL = f"{FLOW_API_BASE}/v1/video:batchAsyncGenerateVideoStartImage"
VIDEO_POLL_URL = f"{FLOW_API_BASE}/v1/video:batchCheckAsyncVideoGenerationStatus"
UPLOAD_IMAGE_URL = f"{FLOW_API_BASE}/v1/flow/uploadImage"

# Actual Google Flow model identifier. flowkit uses a nickname "NANO_BANANA_PRO"
# that resolves to this value via its models.json; we inline the resolved value
# to avoid the indirection. Update when Google rotates model names.
IMAGE_MODEL_NAME = "GEM_PIX_2"

# Video model keys per paygate tier + aspect (flowkit models.json snapshot).
# Update when Google rotates these; flowkit keeps the map in a separate file.
VIDEO_MODEL_KEYS: dict[str, dict[str, str]] = {
    "PAYGATE_TIER_ONE": {
        "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_s_fast",
        "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_s_fast_portrait",
    },
    "PAYGATE_TIER_TWO": {
        "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_s_fast_ultra_relaxed",
        "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_s_fast_ultra_relaxed",
    },
}

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
# UI clamps to 4 too. Any value above this is silently coerced down.
MAX_VARIANT_COUNT = 4

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


def _client_context(project_id: str, paygate_tier: str = "PAYGATE_TIER_ONE") -> dict:
    """Skeleton clientContext — extension fills in recaptchaContext.token."""
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
        paygate_tier: str = "PAYGATE_TIER_ONE",
        scene_id: Optional[str] = None,
        start_media_ids: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """Kick off i2v operation(s). Returns ``{raw, operation_names}`` on
        success or ``{raw, error}`` on failure. Operations are async — the
        caller polls ``check_async`` until they complete.

        ``start_media_ids`` (optional list) — when provided, dispatch ONE
        item per source image so a 4-variant upstream image produces 4
        videos in a single batch (one operation per source). Falls back to
        ``start_media_id`` (single) if the list is missing/empty.
        """
        model_key = (
            VIDEO_MODEL_KEYS.get(paygate_tier, {}).get(aspect_ratio)
        )
        if not model_key:
            return {
                "raw": None,
                "error": f"no_video_model_for_tier_{paygate_tier}_aspect_{aspect_ratio}",
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

        ts = int(time.time() * 1000)
        ctx = _client_context(project_id, paygate_tier)
        items: list[dict[str, Any]] = []
        for i, mid in enumerate(sources):
            items.append({
                "aspectRatio": aspect_ratio,
                # Distinct seed per item so Flow doesn't dedupe.
                "seed": (ts + i * 9973) % 1_000_000,
                "textInput": {"structuredPrompt": {"parts": [{"text": prompt}]}},
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
        return {"raw": resp, "operation_names": op_names}

    async def check_async(self, operation_names: list[str]) -> dict[str, Any]:
        """Poll one or more video operations. No captcha.

        Returns ``{raw, operations: [{name, done, media_entries}]}`` — one
        entry per input operation. ``media_entries`` is a list of
        ``{media_id, url, mediaType}`` ready for ``media.ingest_urls``.
        """
        body = {
            "operations": [
                {"operation": {"name": name}} for name in operation_names
            ]
        }
        resp = await self._client.api_request(
            url=VIDEO_POLL_URL,
            method="POST",
            headers=dict(_API_HEADERS),
            body=body,
        )
        if isinstance(resp, dict) and resp.get("error"):
            return {"raw": resp, "error": resp["error"]}

        ops_summary = extract_video_operations(resp, requested=operation_names)
        return {"raw": resp, "operations": ops_summary}

    # ── image generation (api_request + captcha) ───────────────────────────
    async def gen_image(
        self,
        prompt: str,
        project_id: str,
        aspect_ratio: str = "IMAGE_ASPECT_RATIO_LANDSCAPE",
        paygate_tier: str = "PAYGATE_TIER_ONE",
        ref_media_ids: Optional[list[str]] = None,
        variant_count: int = 1,
        character_media_ids: Optional[list[str]] = None,  # legacy alias
        prompts: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """Generate ``variant_count`` images (1-4). When ``ref_media_ids`` is
        provided, every request item is augmented with ``imageInputs`` so Flow
        conditions the result on those upstream images (any combination of
        character / image / visual_asset upstream nodes — all become
        ``IMAGE_INPUT_TYPE_REFERENCE`` inputs).

        Multiple variants are produced by replicating the request item with
        distinct seeds — Flow returns one entry in ``data.media[]`` per
        request item.
        """
        n = max(1, min(int(variant_count), MAX_VARIANT_COUNT))
        ts = int(time.time() * 1000)
        ctx = _client_context(project_id, paygate_tier)
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
                "imageModelName": IMAGE_MODEL_NAME,
            }
            if image_inputs is not None:
                item["imageInputs"] = list(image_inputs)
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
        paygate_tier: str = "PAYGATE_TIER_ONE",
    ) -> dict[str, Any]:
        """Refine an existing image with an optional list of reference media.

        Order of ``imageInputs`` matters — flowkit puts BASE_IMAGE first so
        Flow knows which is the canonical source.
        """
        ts = int(time.time() * 1000)
        ctx = _client_context(project_id, paygate_tier)

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
            "imageModelName": IMAGE_MODEL_NAME,
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
            return {"raw": resp, "error": "no_media_id_in_upload_response"}
        return {"raw": resp, "media_id": media_id}


def _extract_project_id(resp: Any) -> Optional[str]:
    """TRPC createProject nests the projectId quite deeply."""
    try:
        data = resp.get("data") if isinstance(resp, dict) else None
        return data["result"]["data"]["json"]["result"]["projectId"]  # type: ignore[index]
    except (KeyError, TypeError):
        return None


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
    """Pull ``operation.name`` out of a ``batchAsyncGenerateVideo*`` response."""
    if not isinstance(resp, dict):
        return []
    data = resp.get("data")
    if not isinstance(data, dict):
        return []
    ops = data.get("operations")
    if not isinstance(ops, list):
        return []
    names: list[str] = []
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
    return names


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
