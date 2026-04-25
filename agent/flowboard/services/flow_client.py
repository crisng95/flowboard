"""Bridge to the Chrome MV3 extension over WebSocket.

Ported + trimmed from flowkit (https://github.com/crisng95/flowkit).

Control flow:
1. Extension opens WS to :9222.
2. Agent sends ``{type:"callback_secret", secret}`` immediately.
3. When the agent wants to make an authenticated call against Google Flow /
   aisandbox-pa, it calls ``flow_client.api_request(url, method, headers, body)``
   which sends ``{id, method:"api_request", params}`` over WS and awaits a future.
4. The extension performs ``fetch(url, Authorization: Bearer <token>)`` inside
   the user's browser session and POSTs the response to
   ``/api/ext/callback`` with ``X-Callback-Secret``.
5. That HTTP handler resolves the pending future by id.
6. WS-side inbound messages from the extension (``token_captured``,
   ``extension_ready``, ``pong``, ``status``) update our stats.
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
import uuid
from typing import Any, Optional

logger = logging.getLogger(__name__)


class FlowClient:
    """Singleton bridge client."""

    DEFAULT_TIMEOUT = 180.0  # seconds

    def __init__(self) -> None:
        self._ws: Optional[Any] = None
        self._pending: dict[str, asyncio.Future] = {}
        self._callback_secret: str = secrets.token_urlsafe(32)

        self._token_captured_at: Optional[float] = None
        self._flow_key_present: bool = False
        self._request_count = 0
        self._success_count = 0
        self._failed_count = 0
        self._last_error: Optional[str] = None

    # ── connection ─────────────────────────────────────────────────────────
    @property
    def connected(self) -> bool:
        return self._ws is not None

    @property
    def callback_secret(self) -> str:
        return self._callback_secret

    def set_extension(self, ws: Any) -> None:
        self._ws = ws

    def clear_extension(self) -> None:
        self._ws = None
        self._flow_key_present = False
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError("extension_disconnected"))
        self._pending.clear()

    # ── inbound handling ───────────────────────────────────────────────────
    async def handle_message(self, data: dict) -> None:
        t = data.get("type")
        if t == "extension_ready":
            self._flow_key_present = bool(data.get("flowKeyPresent"))
            logger.info("extension_ready flowKeyPresent=%s", self._flow_key_present)
            return
        if t == "token_captured":
            self._flow_key_present = True
            self._token_captured_at = time.time()
            logger.info("token_captured (len=%d)", len(data.get("flowKey", "")))
            return
        if t == "pong":
            return
        # Inbound response (legacy path; production flow uses HTTP callback)
        req_id = data.get("id")
        if req_id and req_id in self._pending:
            self._resolve(req_id, data)

    def resolve_callback(self, data: dict) -> bool:
        """Called by the HTTP callback endpoint after validating the secret.

        Returns True if a pending future matched.
        """
        req_id = data.get("id")
        if not req_id or req_id not in self._pending:
            return False
        self._resolve(req_id, data)
        return True

    def _resolve(self, req_id: str, data: dict) -> None:
        fut = self._pending.pop(req_id, None)
        if not fut or fut.done():
            return
        # Count as failure if (a) an explicit `error` field is set OR
        # (b) the HTTP status is a 4xx/5xx. Otherwise success.
        status = data.get("status")
        http_error = isinstance(status, int) and status >= 400
        explicit_error = bool(data.get("error"))
        if http_error or explicit_error:
            self._failed_count += 1
            msg = data.get("error") or f"API_{status}"
            self._last_error = str(msg)[:200]
            fut.set_result(data)
        else:
            self._success_count += 1
            fut.set_result(data)

    # ── outbound ──────────────────────────────────────────────────────────
    async def _send(self, method: str, params: dict, timeout: Optional[float] = None) -> dict:
        if not self.connected:
            return {"error": "extension_disconnected"}

        req_id = str(uuid.uuid4())
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        self._request_count += 1

        payload = {"id": req_id, "method": method, "params": params}
        try:
            await self._ws.send(json.dumps(payload))
            return await asyncio.wait_for(fut, timeout=timeout or self.DEFAULT_TIMEOUT)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            self._failed_count += 1
            self._last_error = "timeout"
            return {"error": "timeout"}
        except ConnectionError as exc:
            self._pending.pop(req_id, None)
            self._failed_count += 1
            self._last_error = str(exc)
            return {"error": str(exc)}
        except Exception as exc:  # noqa: BLE001
            self._pending.pop(req_id, None)
            self._failed_count += 1
            self._last_error = str(exc)
            return {"error": str(exc)}

    async def api_request(
        self,
        url: str,
        method: str = "POST",
        headers: Optional[dict] = None,
        body: Any = None,
        captcha_action: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        """Proxy an HTTP call against aisandbox-pa.googleapis.com through the
        extension's browser session. If ``captcha_action`` is set, the
        extension solves reCAPTCHA on an active Flow tab before firing the
        fetch and injects the token into the body's recaptchaContext fields.
        """
        params: dict[str, Any] = {
            "url": url,
            "method": method,
            "headers": headers or {},
            "body": body,
        }
        if captcha_action:
            params["captchaAction"] = captcha_action
        return await self._send("api_request", params, timeout=timeout)

    async def trpc_request(
        self,
        url: str,
        method: str = "POST",
        headers: Optional[dict] = None,
        body: Any = None,
        timeout: Optional[float] = 30.0,
    ) -> dict:
        """Proxy a TRPC call against labs.google through the extension.

        No captcha; just Bearer auth passthrough on a `credentials: include`
        fetch. Used for metadata calls like ``project.createProject``.
        """
        return await self._send(
            "trpc_request",
            {"url": url, "method": method, "headers": headers or {}, "body": body},
            timeout=timeout,
        )

    # ── observability ─────────────────────────────────────────────────────
    @property
    def ws_stats(self) -> dict:
        token_age = (
            int(time.time() - self._token_captured_at)
            if self._token_captured_at is not None
            else None
        )
        return {
            "connected": self.connected,
            "flow_key_present": self._flow_key_present,
            "token_age_s": token_age,
            "pending": len(self._pending),
            "request_count": self._request_count,
            "success_count": self._success_count,
            "failed_count": self._failed_count,
            "last_error": self._last_error,
        }


flow_client = FlowClient()


def get_flow_client() -> FlowClient:
    return flow_client
