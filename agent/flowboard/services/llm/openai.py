"""OpenAI provider — dual-mode (Codex CLI preferred · REST API fallback).

OpenAI is the only provider that supports two transports:

1. **Codex CLI** (`@openai/codex`) — preferred. Authenticates via the
   user's ChatGPT Plus/Pro OAuth, no API key needed. Same
   "use your existing subscription" benefit as Claude / Gemini CLIs.

2. **REST API** — fallback. Used when:
   - Codex CLI isn't installed, OR
   - Codex CLI is installed but the user's version is text-only AND
     this dispatch needs vision.

Vision capability of Codex CLI varies between versions. We probe
``codex --help`` once at first vision call and detect which image flag
(if any) is advertised. If none, the provider treats Codex as text-only
and routes vision requests through the API mode (assuming an API key
is configured; raises if not).

The class API contract: ``is_available()`` is True if at least one mode
is usable. ``run()`` picks the right mode automatically based on
attachment presence + cached probe results. Callers stay ignorant of
which transport ran.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import re
import subprocess
import time
from pathlib import Path
from typing import Optional

import httpx

from .base import LLMError
from . import secrets
from .cli_utils import (
    resolve_cli_binary,
    validate_prompt_size,
    validate_attachment_paths,
    DEFAULT_SUBPROCESS_TIMEOUT,
    CLI_PROBE_TIMEOUT,
)

logger = logging.getLogger(__name__)


_CLI_BIN = "codex"
_API_URL = "https://api.openai.com/v1/chat/completions"
_PROBE_TIMEOUT = 5.0
_DEFAULT_TIMEOUT = 90.0
_DEFAULT_TEXT_MODEL = "gpt-5"
_DEFAULT_VISION_MODEL = "gpt-4o"
_AVAILABILITY_TTL_S = 60.0
_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

# Image-flag candidates ordered by likelihood. First match wins.
_IMAGE_FLAG_CANDIDATES = ("--image", "--attach", "--file", "--input")


class OpenAIProvider:
    """Conforms to ``LLMProvider``. Dual-mode dispatch."""

    name: str = "openai"
    supports_vision: bool = True  # via at least one of the two modes

    def __init__(self) -> None:
        # CLI probe state (set by `_probe_cli`).
        # `cli_available` = True when binary present + version probe succeeds.
        # `cli_image_flag` = resolved flag string, or None for "text-only Codex".
        self._cli_probed: bool = False
        self._cli_available: bool = False
        self._cli_image_flag: Optional[str] = None

        # API availability cache (separate from CLI — they're independent).
        self._api_cached_at: Optional[float] = None
        self._api_value: Optional[bool] = None

    def reset_cache(self) -> None:
        """Testing hook + Settings panel rescan support."""
        self._cli_probed = False
        self._cli_available = False
        self._cli_image_flag = None
        self._api_cached_at = None
        self._api_value = None

    # ── CLI probe ────────────────────────────────────────────────────

    async def _probe_cli(self) -> None:
        """Resolve `_cli_available` + `_cli_image_flag` once per agent
        lifetime. Called lazily on the first availability check."""
        if self._cli_probed:
            return
        self._cli_probed = True

        # Step 1: does the binary exist + run `--version`?
        try:
            codex_bin = resolve_cli_binary(_CLI_BIN, CLI_PROBE_TIMEOUT)
            result = subprocess.run(
                [codex_bin, "--version"],
                capture_output=True,
                timeout=CLI_PROBE_TIMEOUT,
            )
            self._cli_available = result.returncode == 0
        except (FileNotFoundError, PermissionError):
            self._cli_available = False
            return
        except (subprocess.TimeoutExpired, Exception):  # noqa: BLE001
            self._cli_available = False
            return

        if not self._cli_available:
            return

        # Step 2: parse `--help` for an image-attachment flag.
        try:
            codex_bin = resolve_cli_binary(_CLI_BIN, CLI_PROBE_TIMEOUT)
            result = subprocess.run(
                [codex_bin, "--help"],
                capture_output=True,
                timeout=CLI_PROBE_TIMEOUT,
            )
            stdout_b = result.stdout
        except (FileNotFoundError, PermissionError, subprocess.TimeoutExpired):
            return
        except Exception:  # noqa: BLE001
            logger.exception("openai: unexpected error during codex --help probe")
            return

        help_text = stdout_b.decode(errors="replace")
        for candidate in _IMAGE_FLAG_CANDIDATES:
            if re.search(rf"(^|\s){re.escape(candidate)}(\s|=|\b)", help_text):
                self._cli_image_flag = candidate
                logger.info("openai: codex image flag = %s", candidate)
                return
        logger.info("openai: codex --help advertises no image flag (text-only)")

    # ── API probe ────────────────────────────────────────────────────

    async def _api_available(self) -> bool:
        """True when an API key is configured. We don't ping the API
        here — `/v1/models` costs a request, and the key presence alone
        is enough for the routing decision (the actual Test endpoint
        confirms by sending a real ping)."""
        now = time.monotonic()
        if (
            self._api_value is not None
            and self._api_cached_at is not None
            and now - self._api_cached_at < _AVAILABILITY_TTL_S
        ):
            return self._api_value
        key = secrets.get_api_key("openai")
        ok = bool(key)
        self._api_value = ok
        self._api_cached_at = now
        return ok

    # ── public API ───────────────────────────────────────────────────

    async def is_available(self) -> bool:
        """True when at least one of CLI / API is usable."""
        await self._probe_cli()
        if self._cli_available:
            return True
        return await self._api_available()

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: Optional[str] = None,
        attachments: Optional[list[str]] = None,
        timeout: float = _DEFAULT_TIMEOUT,
        model: Optional[str] = None,
    ) -> str:
        await self._probe_cli()
        api_ok = await self._api_available()

        # Mode resolution table (see plan UI Spec for the user-visible
        # version; this is its functional twin):
        #   CLI status × attachments → which mode
        #     cli_available + flag found:           CLI (any dispatch)
        #     cli_available + no flag + no attach:  CLI (text dispatch fine)
        #     cli_available + no flag + attach:     API fallback (requires key)
        #     cli_unavailable:                      API (requires key)
        if self._cli_available:
            wants_vision = bool(attachments)
            cli_supports_this = (self._cli_image_flag is not None) or not wants_vision
            if cli_supports_this:
                return await self._run_cli(
                    user_prompt, system_prompt, attachments, timeout
                )
            # Codex is text-only — fall through to API for this dispatch.
            if not api_ok:
                raise LLMError(
                    "OpenAI Codex CLI does not support vision in your version. "
                    "Either upgrade Codex CLI or configure an OpenAI API key."
                )
            return await self._run_api(
                user_prompt, system_prompt, attachments, timeout, model
            )

        # No CLI — API only.
        if not api_ok:
            raise LLMError("OpenAI is not configured (no Codex CLI, no API key)")
        return await self._run_api(
            user_prompt, system_prompt, attachments, timeout, model
        )

    @property
    def mode(self) -> str:
        """Reported by /api/llm/providers so the UI knows which row state
        to render. Returns the mode that `run()` would currently pick for
        a TEXT dispatch (vision can fall through to API even when this
        says 'cli'). Values: 'cli' / 'api' / 'none'."""
        # Probe-on-read so the property stays sync; callers that want
        # freshness should await `is_available()` first.
        if self._cli_probed and self._cli_available:
            return "cli"
        if self._api_value:
            return "api"
        return "none"

    # ── CLI dispatch ─────────────────────────────────────────────────

    async def _run_cli(
        self,
        user_prompt: str,
        system_prompt: Optional[str],
        attachments: Optional[list[str]],
        timeout: float,
    ) -> str:
        """Spawn `codex exec --output-format json -p <prompt>` and parse
        the JSON envelope (similar shape to `claude` CLI)."""
        import os

        # Validate inputs
        try:
            validate_prompt_size(user_prompt)
            if system_prompt:
                validate_prompt_size(system_prompt)
            validate_attachment_paths(attachments)
        except ValueError as exc:
            raise LLMError(f"Invalid input: {exc}") from exc

        codex_bin = resolve_cli_binary(_CLI_BIN, CLI_PROBE_TIMEOUT)
        # Pipe the prompt via stdin (`-` sentinel) instead of as an argv
        # token. Same Windows ``.cmd`` shim rationale as claude_cli.py:
        # cmd.exe re-parses argv for ``.cmd``-shimmed binaries and
        # mangles newlines / quotes in long prompts. Stdin sidesteps the
        # parser entirely.
        args: list[str] = [
            codex_bin, "exec", "--output-format", "json", "-p", "-",
        ]
        if system_prompt:
            args += ["--system", system_prompt]
        if attachments and self._cli_image_flag:
            for path in attachments:
                args += [self._cli_image_flag, os.path.abspath(path)]

        try:
            result = subprocess.run(
                args,
                input=user_prompt.encode("utf-8"),
                capture_output=True,
                timeout=timeout,
            )
        except FileNotFoundError as exc:
            raise LLMError("codex CLI not found on PATH") from exc
        except subprocess.TimeoutExpired as exc:
            raise LLMError(f"codex CLI timed out after {timeout}s") from exc
        except Exception as exc:  # noqa: BLE001
            raise LLMError(f"codex CLI error: {exc}") from exc

        if result.returncode != 0:
            stderr = result.stderr.decode(errors="replace")[:400]
            raise LLMError(f"codex CLI exited {result.returncode}: {stderr}")

        stdout = result.stdout.decode(errors="replace")
        try:
            envelope = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise LLMError(
                f"codex CLI returned non-JSON output: {stdout[:200]}"
            ) from exc

        if not isinstance(envelope, dict):
            raise LLMError("codex CLI envelope is not an object")

        # Codex envelope shape mirrors Claude CLI: {result: "..."} or
        # {is_error: true, ...}. Tolerate both `result` and `output_text`
        # since the exact field name has shifted across CLI versions.
        if envelope.get("is_error") or envelope.get("error"):
            raise LLMError(
                f"codex CLI reported error: "
                f"{envelope.get('error') or envelope.get('result') or 'unknown'}"
            )
        for key in ("result", "output_text", "text"):
            val = envelope.get(key)
            if isinstance(val, str):
                return val
        raise LLMError(f"codex CLI envelope missing string output: {envelope!r:.200}")

    # ── API dispatch ─────────────────────────────────────────────────

    async def _run_api(
        self,
        user_prompt: str,
        system_prompt: Optional[str],
        attachments: Optional[list[str]],
        timeout: float,
        model: Optional[str],
    ) -> str:
        key = secrets.get_api_key("openai")
        if not key:
            raise LLMError("OpenAI API key not configured")

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
            raise LLMError(f"openai request timed out after {timeout}s") from exc
        except httpx.HTTPError as exc:
            raise LLMError(f"openai transport error: {exc}") from exc

        if resp.status_code != 200:
            raise LLMError(
                f"openai HTTP {resp.status_code}: {_safe_error_message(resp)}"
            )

        try:
            data = resp.json()
        except ValueError as exc:
            raise LLMError("openai response was not JSON") from exc
        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"openai response missing content: {data!r:.200}") from exc


# ── helpers ───────────────────────────────────────────────────────────

def _image_url_block(path: str) -> dict:
    p = Path(path)
    size = p.stat().st_size
    if size > _MAX_ATTACHMENT_BYTES:
        raise LLMError(
            f"attachment too large for openai: "
            f"{size // (1024 * 1024)}MB > 5MB cap"
        )
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    b64 = base64.b64encode(p.read_bytes()).decode("ascii")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mime};base64,{b64}"},
    }


def _safe_error_message(resp: httpx.Response) -> str:
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
    return "(unrecognised body)"
