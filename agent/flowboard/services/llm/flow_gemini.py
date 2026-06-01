"""flow_gemini provider — text generation routed through the Flow pipeline.

Instead of calling a model directly (CLI subprocess like ``gemini``/``claude``
or a paid API like ``openai``), this provider enqueues a Control-Plane
``task_type="text_gen"`` request with ``provider="flow"`` and lets the browser
extension's cloud-worker claim it, call ``flow:generateContent`` with the
user's own captured Flow Bearer token, and complete the job with the generated
text. The net effect is `$0` text generation that reuses the same claim /
heartbeat / complete loop already proven for Flow image and video jobs (see
``.kiro/specs/gemini-via-flow-generatecontent/design.md`` component 4).

Conforms structurally to ``LLMProvider`` (``base.py``):
- ``name = "flow_gemini"``, ``supports_vision = True``
- ``is_available()`` is cheap: it only checks that a Control Plane is
  configured and a worker/board identity exists. It never calls the model.
- ``run(...)`` matches the shared caller signature exactly: a positional
  ``user_prompt`` plus keyword-only ``system_prompt`` / ``attachments`` /
  ``timeout``, returning plain text.

Secrets discipline (Req 9): the Flow Bearer token and the reCAPTCHA token live
in the extension, never in this process, so they cannot leak from here. We
still (a) never log the raw prompt — only its length and a short SHA-256
hash — and (b) sanitize any surfaced error string defensively.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import mimetypes
import os
import re
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from .base import LLMError
from flowboard.config import SUPABASE_URL, EXT_CLIENT_ID

if TYPE_CHECKING:  # avoid import-time cost (boto3/httpx) for a bare module import
    from flowboard.services.control_plane import ControlPlaneService

logger = logging.getLogger(__name__)

# Assumption A3 (design): default text model, overridable by the job/worker.
_DEFAULT_TEXT_MODEL = "gemini-3-flash-preview"

# Poll cadence while waiting for the cloud-worker to complete the job.
_POLL_INTERVAL_SEC = 2.0

# Terminal request states (mirrors the `requests` lifecycle in migrations.sql).
_COMPLETED = "completed"
_FAILED = "failed"


def _guess_mime(path: str) -> str:
    """Best-effort MIME type for an attachment path.

    Uses the stdlib ``mimetypes`` table and falls back to ``image/png`` when
    the extension is unknown — the multimodal path only ever carries images.
    """
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "image/png"


def _redact_path(path: str) -> str:
    """Redact a filesystem path for logs.

    Attachment paths can embed usernames / project names, so we never log the
    raw path. We keep the extension (useful for triage) and a short stable
    hash of the full path so repeated failures on the same file correlate.
    """
    try:
        ext = os.path.splitext(str(path))[1] or ""
    except Exception:  # noqa: BLE001 - redaction must never raise
        ext = ""
    digest = hashlib.sha256(str(path).encode("utf-8", "replace")).hexdigest()[:12]
    return f"<attachment {digest}{ext}>"


def _sanitize_error(message: str) -> str:
    """Strip anything token-shaped from an error string before surfacing it.

    Defense in depth for Req 9.3 — the Bearer / reCAPTCHA tokens never reach
    this process, but a failure reason proxied back from the worker could in
    principle echo one, so we scrub ``Bearer <...>`` and ``"token": "<...>"``
    shapes and cap the length.
    """
    if not message:
        return ""
    redacted = re.sub(r"(?i)bearer\s+[A-Za-z0-9._\-]+", "Bearer [REDACTED]", message)
    redacted = re.sub(
        r'("?(?:token|recaptcha|recaptchaToken|authorization)"?\s*[:=]\s*"?)[A-Za-z0-9._\-]+',
        r"\1[REDACTED]",
        redacted,
    )
    return redacted[:400]


class FlowGeminiProvider:
    """Conforms to ``LLMProvider`` (structural typing, like ``GeminiProvider``).

    Unlike the CLI providers this one has no local binary to probe — its
    "availability" is purely a function of Control-Plane configuration. The
    actual generation happens out-of-process in the browser extension, so
    ``run()`` is an enqueue-then-poll loop rather than a subprocess call.
    """

    name: str = "flow_gemini"
    supports_vision: bool = True  # Req 6.5 — multimodal via inlineData

    def __init__(self, control_plane: Optional["ControlPlaneService"] = None) -> None:
        # Injected for tests; resolved lazily to the module singleton otherwise.
        self._cp = control_plane
        self._poll_interval = _POLL_INTERVAL_SEC
        # Control-Plane identity for the enqueued request. board/node are
        # FK-constrained UUIDs (see migrations.sql); they come from env so a
        # deployment can pin a dedicated text-gen board/node without code.
        self._board_id = os.getenv("FLOWBOARD_TEXT_GEN_BOARD_ID", "").strip() or None
        self._node_id = os.getenv("FLOWBOARD_TEXT_GEN_NODE_ID", "").strip() or None
        self._user_id = os.getenv("FLOWBOARD_TEXT_GEN_USER_ID", "").strip() or None

    # ── availability ──────────────────────────────────────────────────

    async def is_available(self) -> bool:
        """Cheap config check — usable when a Control Plane is configured and a
        worker/board identity exists. MUST NOT call the model (Req: base.py)."""
        return bool(SUPABASE_URL) and bool(EXT_CLIENT_ID or self._board_id)

    # ── dispatch ──────────────────────────────────────────────────────

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: Optional[str] = None,
        attachments: Optional[list[str]] = None,
        timeout: float = 90.0,
    ) -> str:
        """Enqueue a ``text_gen`` job and return the completed text.

        Raises ``LLMError`` on a non-string ``system_prompt`` (without
        enqueuing — Req 6.4), on a failed/timed-out job (Req 8.5), and on an
        empty completed response (Req 8.4).
        """
        # 1. Build the Control-Plane input payload (may raise before enqueue).
        input_data = self._build_input_data(user_prompt, system_prompt, attachments)

        # Redacted dispatch log — never the raw prompt (Req 9.2).
        prompt_text = user_prompt or ""
        prompt_hash = hashlib.sha256(prompt_text.encode("utf-8")).hexdigest()[:12]
        logger.info(
            "flow_gemini: dispatch prompt_len=%d prompt_hash=%s attachments=%d",
            len(prompt_text),
            prompt_hash,
            len(input_data.get("attachments") or []),
        )

        # 2. Enqueue the text_gen request via the Control Plane.
        request = await self._enqueue(input_data)
        request_id = request.get("id") if isinstance(request, dict) else None
        if not request_id:
            raise LLMError("flow_gemini: Control Plane did not return a request id")

        # 3. Poll until completed / failed / timeout, then 4. read the text.
        text = await self._poll_until_text(str(request_id), timeout)
        if not text or not text.strip():
            raise LLMError("flow_gemini returned an empty response")  # Req 8.4
        return text.strip()

    # ── helpers ───────────────────────────────────────────────────────

    def _build_input_data(
        self,
        user_prompt: str,
        system_prompt: Optional[str],
        attachments: Optional[list[str]],
    ) -> dict[str, Any]:
        """Assemble the ``input_data`` JSON for the Control-Plane request.

        - Non-string ``system_prompt`` is a hard error: we refuse to enqueue a
          job that would silently drop the system instruction (Req 6.4).
        - Each attachment is read and base64-encoded; a per-attachment failure
          is logged (with a redacted path) and skipped so the remaining valid
          attachments still go through (Req 7.2).
        - ``system_prompt`` / ``attachments`` keys are added only when present
          so an empty attachments list yields a text-only payload (Req 7.5).
        """
        if system_prompt is not None and not isinstance(system_prompt, str):
            # Raise BEFORE building/enqueuing anything (Req 6.4).
            raise LLMError("flow_gemini: system_prompt could not be encoded as systemInstruction")

        atts: list[dict[str, str]] = []
        for path in attachments or []:
            try:
                raw = Path(path).read_bytes()
                atts.append(
                    {
                        "mimeType": _guess_mime(path),
                        "data": base64.b64encode(raw).decode("ascii"),
                    }
                )
            except Exception as exc:  # noqa: BLE001 - skip & continue (Req 7.2)
                logger.warning(
                    "flow_gemini: skipped attachment %s (%s)",
                    _redact_path(path),
                    type(exc).__name__,
                )

        data: dict[str, Any] = {"prompt": user_prompt, "model": _DEFAULT_TEXT_MODEL}
        if system_prompt:
            data["system_prompt"] = system_prompt  # Req 6.3
        if atts:
            data["attachments"] = atts  # Req 7.1; omitted when empty (Req 7.5)
        return data

    def _get_control_plane(self) -> "ControlPlaneService":
        """Return the injected Control Plane or the lazily-imported singleton.

        Lazy import keeps a bare ``import flowboard.services.llm.flow_gemini``
        free of the boto3/httpx construction the control_plane module performs
        at import time.
        """
        if self._cp is not None:
            return self._cp
        from flowboard.services.control_plane import control_plane_service

        return control_plane_service

    async def _resolve_user_id(self, cp: "ControlPlaneService") -> Optional[str]:
        """Owner user_id for the enqueued request.

        Prefer an explicit env override; otherwise resolve it from the paired
        extension client id (the same identity the cloud-worker runs under).
        """
        if self._user_id:
            return self._user_id
        if EXT_CLIENT_ID:
            try:
                return await cp.get_client_user_id(EXT_CLIENT_ID)
            except Exception as exc:  # noqa: BLE001
                logger.warning("flow_gemini: user_id lookup failed (%s)", type(exc).__name__)
                return None
        return None

    async def _enqueue(self, input_data: dict[str, Any]) -> dict[str, Any]:
        """Create the ``text_gen`` request through ``create_or_reset_request``.

        A fresh ``idempotency_key`` per call gives every dispatch its own row
        (no accidental reuse of a previous completion).
        """
        cp = self._get_control_plane()
        user_id = await self._resolve_user_id(cp)
        board_id = self._board_id
        node_id = self._node_id
        if not (user_id and board_id and node_id):
            raise LLMError(
                "flow_gemini: Control Plane identity not configured "
                "(set EXT_CLIENT_ID/FLOWBOARD_TEXT_GEN_USER_ID, "
                "FLOWBOARD_TEXT_GEN_BOARD_ID and FLOWBOARD_TEXT_GEN_NODE_ID)"
            )
        idempotency_key = f"flow_gemini-{uuid.uuid4().hex}"
        return await cp.create_or_reset_request(
            user_id=user_id,
            board_id=board_id,
            node_id=node_id,
            provider="flow",
            task_type="text_gen",
            input_data=input_data,
            idempotency_key=idempotency_key,
            expected_output="text",
        )

    async def _poll_until_text(self, request_id: str, timeout: float) -> str:
        """Poll the request row on a ~2s interval until it reaches a terminal
        state or the timeout budget elapses.

        Returns the completed ``output_result.text`` (possibly empty — the
        caller validates non-emptiness). Raises ``LLMError`` on a failed job
        (Req 8) or when the timeout is exceeded (Req 8.5).
        """
        cp = self._get_control_plane()
        loop = asyncio.get_event_loop()
        deadline = loop.time() + max(0.0, float(timeout))
        while True:
            row = await cp._get_request(request_id)
            status = (row or {}).get("status")
            if status == _COMPLETED:
                return self._extract_text(row)
            if status == _FAILED:
                reason = _sanitize_error(str((row or {}).get("error_message") or "unknown error"))
                raise LLMError(f"flow_gemini generation failed: {reason}")
            if loop.time() >= deadline:
                raise LLMError(f"flow_gemini timed out after {timeout}s")  # Req 8.5
            remaining = deadline - loop.time()
            await asyncio.sleep(min(self._poll_interval, max(0.0, remaining)))

    @staticmethod
    def _extract_text(row: Optional[dict[str, Any]]) -> str:
        """Read ``output_result.text`` from a completed request row."""
        output = (row or {}).get("output_result")
        if isinstance(output, dict):
            text = output.get("text")
            if isinstance(text, str):
                return text
        return ""
