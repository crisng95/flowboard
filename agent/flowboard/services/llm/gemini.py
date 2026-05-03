"""Gemini provider — subprocess wrapper around Google's ``gemini`` CLI.

The CLI's non-interactive surface is intentionally minimal — see
``gemini --help``. Only ``-p, --prompt`` is exposed; there's no ``--system``
flag and no dedicated image-attachment flag. Both are folded into the
prompt body:

- **System prompt**: prepended as ``[System: ...]`` followed by ``\\n\\n``
  before the user prompt. The CLI passes the whole string to the model.
- **Image attachments**: inlined via ``@<absolute_path>`` tokens. The
  CLI reads the file and forwards it as a multimodal block (same
  pattern Claude CLI uses). Verified live: `gemini -p "describe @path"`
  works and returns a real description.

Output is requested as ``-o json`` so we get a structured envelope of
the form ``{"session_id": "...", "response": "<text>", "stats": {...}}``.
We extract the ``response`` field and discard the rest. Earlier the
provider returned raw stdout, which periodically picked up "Loaded
cached credentials" banners + ``Tip:`` informational lines + ANSI
escape codes that broke downstream parsers (especially the batch
auto-prompt synth that expects a JSON array reply from the model).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
from typing import Optional

from .base import LLMError
from .cli_utils import (
    resolve_cli_binary,
    get_windows_npm_paths,
    validate_prompt_size,
    validate_attachment_paths,
    DEFAULT_SUBPROCESS_TIMEOUT,
    CLI_PROBE_TIMEOUT,
)

logger = logging.getLogger(__name__)

_CLI_BIN = "gemini"
_DEFAULT_TIMEOUT = DEFAULT_SUBPROCESS_TIMEOUT
_PROBE_TIMEOUT = CLI_PROBE_TIMEOUT

# Pin a stable production model. Gemini CLI v0.38.2's default Auto
# mode picks `gemini-3-flash-preview` (preview tier) which Google
# returns 429 MODEL_CAPACITY_EXHAUSTED for routinely — even when the
# user's per-model quota is fine — because preview models are
# capacity-throttled server-side. The CLI then retries with backoff,
# inflating per-call latency by 30+ seconds before the call eventually
# lands.
#
# `gemini-2.5-flash` is the stable Flash tier that the Auto (Gemini
# 2.5) group routes to. Stable tier = real production capacity, no
# preview throttling. Direct `-m gemini-2.5-flash` works on the
# CodeAssist backend in CLI v0.38.2 (verified — unlike
# `gemini-3-flash` which returns ModelNotFound).
#
# Override via FLOWBOARD_GEMINI_MODEL if you want `gemini-2.5-pro`
# (slower but better for Planner JSON quality) or any other variant.
_DEFAULT_MODEL: str | None = "gemini-2.5-flash"


class GeminiProvider:
    """Conforms to ``LLMProvider`` (structural typing).

    Concurrency note: Google's CodeAssist backend (the one the CLI talks
    to) rate-limits **concurrent calls per user/session**. A second call
    fired while the first is in flight comes back with HTTP 429
    ``MODEL_CAPACITY_EXHAUSTED`` and the CLI then retries with backoff,
    inflating the second call's wall time by 30+ seconds. This is NOT
    user-quota or billing-tier related — Pro / Ultra plans hit it
    identically. It's a per-call concurrency ceiling on the model's
    shared capacity tier.

    We serialize at the provider boundary (one ``asyncio.Semaphore(1)``
    around the subprocess call) so every dispatch path — auto-prompt,
    vision, planner, test endpoint — naturally queues into one in-flight
    call at a time. Sequential calls land in ~7s each; we'd rather
    queue cleanly than race and pay the 30s+ retry penalty.

    Other providers (Claude, OpenAI Codex) don't need this — Anthropic's
    and OpenAI's backends handle parallel calls fine.
    """

    name: str = "gemini"
    supports_vision: bool = True  # Gemini Flash + Pro both have vision
    test_timeout_secs: float = 180.0  # Retries with backoff on 429 quota exhaustion

    def __init__(self) -> None:
        self._available: Optional[bool] = None
        # Module-level singleton in registry → one semaphore for the
        # process lifetime. Lazy-allocated on first run() because asyncio
        # Semaphore wants a running event loop in some Python versions.
        self._call_lock: Optional[asyncio.Semaphore] = None

    # ── availability ──────────────────────────────────────────────────

    async def is_available(self) -> bool:
        """Cached check: does ``gemini --version`` exit 0?

        Doesn't verify auth — the user could have the CLI installed but
        not signed in. The Test endpoint catches that by actually
        invoking the model. Mirrors the claude_cli pattern.
        """
        if self._available is None:
            self._available = await self._probe_version()
            logger.info("gemini: available=%s", self._available)
        return self._available

    def reset_cache(self) -> None:
        """Testing hook + Settings panel rescan support."""
        self._available = None


    async def _probe_version(self) -> bool:
        """Check gemini CLI availability using subprocess (Windows-compatible)."""
        # Use shared binary resolver which tries PATH + npm locations
        try:
            gemini_bin = resolve_cli_binary(_CLI_BIN, _PROBE_TIMEOUT)
            result = subprocess.run(
                [gemini_bin, "--version"],
                capture_output=True,
                timeout=_PROBE_TIMEOUT,
            )
            if result.returncode == 0:
                logger.info("gemini: found at %s", gemini_bin)
                return True
            logger.warning("gemini: version probe returned code %d", result.returncode)
            return False
        except subprocess.TimeoutExpired:
            logger.warning("gemini: probe timed out")
            return False
        except Exception as e:  # noqa: BLE001
            logger.warning("gemini: probe failed: %s", e)
            return False

    # ── dispatch ──────────────────────────────────────────────────────

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: Optional[str] = None,
        attachments: Optional[list[str]] = None,
        timeout: float = _DEFAULT_TIMEOUT,
    ) -> str:
        """Invoke ``gemini -p PROMPT`` and return stdout.

        System prompt + image attachments are folded into the prompt body
        because the CLI doesn't expose them as flags — see module docstring.

        The actual subprocess invocation is serialized through
        ``self._call_lock`` (Semaphore(1)) — see class docstring for the
        CodeAssist backend concurrency rationale. Time spent waiting in
        the lock counts against the caller's ``timeout`` budget; if a
        Vision call holds the lock for 7s and an Auto-Prompt is queued
        behind it with a 90s timeout, Auto-Prompt has 83s of work time
        once it acquires.
        """
        # Validate inputs
        try:
            validate_prompt_size(user_prompt)
            if system_prompt:
                validate_prompt_size(system_prompt)
            validate_attachment_paths(attachments)
        except ValueError as exc:
            raise LLMError(f"Invalid input: {exc}") from exc

        # Build the composite prompt: system block, user prompt, attachments.
        parts: list[str] = []
        if system_prompt:
            parts.append(f"[System: {system_prompt}]")
        parts.append(user_prompt)
        if attachments:
            parts.append(
                " ".join(f"@{os.path.abspath(p)}" for p in attachments)
            )
        full_prompt = "\n\n".join(parts)

        # Optional model pin via env var — see _DEFAULT_MODEL docstring
        # for the capacity-exhausted preview-model rationale. When unset
        # we don't pass `-m` so Gemini CLI's own `/model` setting wins.
        model = os.environ.get("FLOWBOARD_GEMINI_MODEL") or _DEFAULT_MODEL
        gemini_bin = resolve_cli_binary(_CLI_BIN, _PROBE_TIMEOUT)
        args: list[str] = [gemini_bin]
        if model:
            args += ["-m", model]
        # ``-o json`` gives us a structured envelope instead of raw text
        # mixed with banner/tip/ANSI noise. Parsed in ``_invoke_locked``.
        args += ["-o", "json", "-p", full_prompt]

        # Lazy-init the semaphore on the running loop. The wait + the
        # subprocess + communicate all live inside the lock so a second
        # caller can't slip in between proc spawn and proc.communicate.
        if self._call_lock is None:
            self._call_lock = asyncio.Semaphore(1)
        async with self._call_lock:
            return await self._invoke_locked(args, timeout=timeout)

    async def _invoke_locked(
        self, args: list[str], *, timeout: float
    ) -> str:
        """Subprocess invocation using subprocess.run (Windows-compatible).

        Assumed to be holding ``_call_lock``. This remains async for
        compatibility with the semaphore pattern, but internally uses
        synchronous subprocess.run() which avoids asyncio subprocess
        issues on Windows."""
        try:
            result = subprocess.run(
                args,
                capture_output=True,
                timeout=timeout,
                text=False,  # Keep as bytes for .decode() below
            )
        except FileNotFoundError as exc:
            raise LLMError("gemini CLI not found on PATH") from exc
        except subprocess.TimeoutExpired as exc:
            raise LLMError(f"gemini CLI timed out after {timeout}s (likely quota exhaustion or network issue)") from exc
        except Exception as exc:  # noqa: BLE001
            raise LLMError(f"gemini CLI error: {exc}") from exc

        if result.returncode != 0:
            stderr = result.stderr.decode(errors="replace")[:400]
            # Check for quota exhaustion error
            if "429" in stderr or "exhausted" in stderr.lower() or "quota" in stderr.lower():
                raise LLMError(f"Gemini quota exhausted: {stderr}")
            raise LLMError(f"gemini CLI exited {result.returncode}: {stderr}")

        stdout = result.stdout.decode(errors="replace").strip()
        # ``-o json`` envelope shape:
        #   {"session_id": "...", "response": "<model text>", "stats": {...}}
        # Extract ``response`` and discard everything else. Banners /
        # ``Tip:`` lines / ANSI codes that older raw-text mode mixed in
        # never reach the caller now because they're outside the JSON.
        try:
            envelope = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise LLMError(
                f"gemini CLI returned non-JSON output: {stdout[:200]}"
            ) from exc
        if not isinstance(envelope, dict):
            raise LLMError("gemini CLI envelope is not an object")
        response = envelope.get("response")
        if not isinstance(response, str):
            raise LLMError("gemini CLI envelope missing string 'response' field")
        return response.strip()
