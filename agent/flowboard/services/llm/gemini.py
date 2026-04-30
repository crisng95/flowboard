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

Output is plain text on stdout in non-interactive mode. Errors and
timeouts surface as ``LLMError`` so the registry contract holds.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

from .base import LLMError

logger = logging.getLogger(__name__)


_CLI_BIN = "gemini"
_DEFAULT_TIMEOUT = 90.0
_PROBE_TIMEOUT = 5.0


class GeminiProvider:
    """Conforms to ``LLMProvider`` (structural typing)."""

    name: str = "gemini"
    supports_vision: bool = True  # Gemini Flash + Pro both have vision

    def __init__(self) -> None:
        self._available: Optional[bool] = None

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
        try:
            proc = await asyncio.create_subprocess_exec(
                _CLI_BIN,
                "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (FileNotFoundError, PermissionError):
            return False
        except Exception:  # noqa: BLE001
            logger.exception("gemini: unexpected error during availability probe")
            return False
        try:
            await asyncio.wait_for(proc.communicate(), timeout=_PROBE_TIMEOUT)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
            return False
        return proc.returncode == 0

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
        """
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

        args: list[str] = [_CLI_BIN, "-p", full_prompt]

        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise LLMError("gemini CLI not found on PATH") from exc

        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError as exc:
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
            raise LLMError(f"gemini CLI timed out after {timeout}s") from exc

        if proc.returncode != 0:
            stderr = stderr_b.decode(errors="replace")[:400]
            raise LLMError(f"gemini CLI exited {proc.returncode}: {stderr}")

        return stdout_b.decode(errors="replace").strip()
