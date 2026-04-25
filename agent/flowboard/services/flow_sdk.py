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


def is_valid_project_id(project_id: str) -> bool:
    return bool(_PROJECT_ID_RE.fullmatch(project_id))

# Captcha action strings recognised by Google Flow.
CAPTCHA_IMAGE = "IMAGE_GENERATION"
CAPTCHA_VIDEO = "VIDEO_GENERATION"

# Default max operations to poll in parallel. Conservative; flowkit passes
# the full list at once.
_MAX_VIDEO_OPS = 4

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
        start_media_id: str,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier: str = "PAYGATE_TIER_ONE",
        scene_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Kick off an i2v operation. Returns ``{raw, operation_names}`` on
        success or ``{raw, error}`` on failure. Operations are async — the
        caller polls ``check_async`` until they complete.
        """
        model_key = (
            VIDEO_MODEL_KEYS.get(paygate_tier, {}).get(aspect_ratio)
        )
        if not model_key:
            return {
                "raw": None,
                "error": f"no_video_model_for_tier_{paygate_tier}_aspect_{aspect_ratio}",
            }

        ts = int(time.time() * 1000)
        ctx = _client_context(project_id, paygate_tier)
        request_item = {
            "aspectRatio": aspect_ratio,
            "seed": ts % 1_000_000,
            "textInput": {"structuredPrompt": {"parts": [{"text": prompt}]}},
            "videoModelKey": model_key,
            "startImage": {"mediaId": start_media_id},
            "metadata": {"sceneId": scene_id or str(uuid.uuid4())},
        }
        body = {
            "clientContext": ctx,
            "mediaGenerationContext": {"batchId": str(uuid.uuid4())},
            "requests": [request_item],
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
        character_media_ids: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """Generate one image. When ``character_media_ids`` is provided, the
        request is augmented with ``imageInputs`` so Flow conditions the result
        on those character references (mirrors flowkit's edit_image flow).
        """
        ts = int(time.time() * 1000)
        ctx = _client_context(project_id, paygate_tier)
        request_item: dict[str, Any] = {
            "clientContext": {**ctx, "sessionId": f";{ts}"},
            "seed": ts % 1_000_000,
            "structuredPrompt": {"parts": [{"text": prompt}]},
            "imageAspectRatio": aspect_ratio,
            "imageModelName": IMAGE_MODEL_NAME,
        }
        if character_media_ids:
            request_item["imageInputs"] = [
                {"name": mid, "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE"}
                for mid in character_media_ids
            ]
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
                    done_flag = bool(inner.get("done")) or bool(media_id and fife)
                    entries = []
                    if done_flag and isinstance(media_id, str):
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
