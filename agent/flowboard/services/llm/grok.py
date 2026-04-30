"""Grok provider — direct REST API client against ``api.x.ai``.

xAI hasn't shipped an end-user CLI as of plan date, so this is the one
provider that requires an API key in Settings (the others use their CLI's
existing OAuth flow). xAI's API is OpenAI-compatible — same
``/v1/chat/completions`` shape, same message structure — so the same
``httpx`` client pattern applies cleanly.

Vision attachments are sent as base64 data URLs in
``messages[].content[].image_url.url``. Default model is ``grok-4``;
auto-bumps to ``grok-2-vision-1212`` when attachments are present.
File-size guard rejects any single attachment >5MB before hitting the
network.

The API key never appears in any log line — see ``services/llm/secrets.py``
for storage and the redaction filter we'll add at logger init in Step 5.
"""
from __future__ import annotations

import base64
import logging
import mimetypes
import time
from pathlib import Path
from typing import Optional

import httpx

from .base import LLMError
from . import secrets

logger = logging.getLogger(__name__)


_API_URL = "https://api.x.ai/v1/chat/completions"
_MODELS_URL = "https://api.x.ai/v1/models"
_DEFAULT_TEXT_MODEL = "grok-4"
_DEFAULT_VISION_MODEL = "grok-2-vision-1212"
_DEFAULT_TIMEOUT = 90.0
_AVAILABILITY_TTL_S = 60.0  # cache `is_available()` result for 60s
_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024  # 5 MB


class GrokProvider:
    """Conforms to ``LLMProvider``."""

    name: str = "grok"
    supports_vision: bool = True

    def __init__(self) -> None:
        self._availability_cached_at: Optional[float] = None
        self._availability_value: Optional[bool] = None

    def reset_cache(self) -> None:
        """Testing hook + Settings panel "rescan" if we add one."""
        self._availability_cached_at = None
        self._availability_value = None

    # ── availability ──────────────────────────────────────────────────

    async def is_available(self) -> bool:
        """True when an API key is configured AND a `/v1/models` ping
        with that key succeeds. Cached for 60s so a Settings panel poll
        doesn't hit the API on every refresh."""
        now = time.monotonic()
        if (
            self._availability_value is not None
            and self._availability_cached_at is not None
            and now - self._availability_cached_at < _AVAILABILITY_TTL_S
        ):
            return self._availability_value
        key = secrets.get_api_key("grok")
        if not key:
            self._availability_value = False
            self._availability_cached_at = now
            return False
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    _MODELS_URL, headers={"authorization": f"Bearer {key}"}
                )
            ok = resp.status_code == 200
        except httpx.HTTPError as exc:
            logger.warning("grok: availability probe failed: %s", exc)
            ok = False
        self._availability_value = ok
        self._availability_cached_at = now
        return ok

    # ── dispatch ──────────────────────────────────────────────────────

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: Optional[str] = None,
        attachments: Optional[list[str]] = None,
        timeout: float = _DEFAULT_TIMEOUT,
        model: Optional[str] = None,
    ) -> str:
        key = secrets.get_api_key("grok")
        if not key:
            raise LLMError("Grok API key not configured")

        chosen_model = model or (
            _DEFAULT_VISION_MODEL if attachments else _DEFAULT_TEXT_MODEL
        )

        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        if attachments:
            content: list[dict] = [{"type": "text", "text": user_prompt}]
            for path in attachments:
                content.append(_image_url_block(path))
            messages.append({"role": "user", "content": content})
        else:
            messages.append({"role": "user", "content": user_prompt})

        payload = {"model": chosen_model, "messages": messages}

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    _API_URL,
                    headers={
                        "authorization": f"Bearer {key}",
                        "content-type": "application/json",
                    },
                    json=payload,
                )
        except httpx.TimeoutException as exc:
            raise LLMError(f"grok request timed out after {timeout}s") from exc
        except httpx.HTTPError as exc:
            raise LLMError(f"grok transport error: {exc}") from exc

        if resp.status_code != 200:
            # Don't include the raw body — provider errors sometimes echo
            # back parts of the request including auth headers in some
            # error shapes. Use the parsed error message field only if
            # the body is JSON; otherwise the status code alone.
            err_msg = _safe_error_message(resp)
            raise LLMError(f"grok HTTP {resp.status_code}: {err_msg}")

        try:
            data = resp.json()
        except ValueError as exc:
            raise LLMError("grok response was not JSON") from exc
        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"grok response missing content: {data!r:.200}") from exc


# ── helpers ───────────────────────────────────────────────────────────


def _image_url_block(path: str) -> dict:
    """Encode a local file as a data-URL image_url block per OpenAI schema.

    Same shape used by Grok and OpenAI API mode — both speak the
    OpenAI-compatible message format.
    """
    p = Path(path)
    size = p.stat().st_size
    if size > _MAX_ATTACHMENT_BYTES:
        raise LLMError(
            f"attachment too large for grok: "
            f"{size // (1024 * 1024)}MB > 5MB cap"
        )
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    b64 = base64.b64encode(p.read_bytes()).decode("ascii")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mime};base64,{b64}"},
    }


def _safe_error_message(resp: httpx.Response) -> str:
    """Best-effort extraction of a human-readable error from the response.

    Trim aggressively so logs don't carry raw provider body that could
    contain echoed request fragments.
    """
    try:
        body = resp.json()
    except ValueError:
        return "(non-JSON body)"
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            msg = err.get("message")
            if isinstance(msg, str):
                return msg[:200]
        msg = body.get("message")
        if isinstance(msg, str):
            return msg[:200]
    return f"(unrecognised body)"
