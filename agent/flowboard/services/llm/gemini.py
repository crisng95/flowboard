"""Gemini provider — subprocess wrapper around Google's ``gemini`` CLI.

Mirrors the structure of ``claude_cli`` (subprocess + stdout parse +
caching for the availability probe). Vision attachments are forwarded
via the CLI's image flag, which we detect at init time by parsing
``gemini --help`` — different gemini-cli versions advertise different
flag names (`--image`, `--input`, `--file`), so we resolve to the
canonical one once and cache it for the agent's lifetime.

Output: gemini-cli emits plain text on stdout in non-interactive mode
(`gemini -p "<prompt>"`). No JSON envelope to parse; we strip trailing
newlines and return the body. If the CLI ever ships a structured
output flag, we'll add envelope parsing here without touching callers.

Error handling mirrors ``claude_cli``: timeouts, non-zero exit codes,
and missing-binary all surface as ``LLMError`` with the stderr tail
preserved for debugging.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Optional

from .base import LLMError

logger = logging.getLogger(__name__)


_CLI_BIN = "gemini"
_DEFAULT_TIMEOUT = 90.0
_PROBE_TIMEOUT = 5.0

# Flag candidates ordered by likelihood. The first one found in
# `gemini --help` wins. Add new aliases here as the CLI evolves —
# nothing else in the codebase needs to change.
_IMAGE_FLAG_CANDIDATES = ("--image", "--file", "--input", "--attach")


class GeminiProvider:
    """Conforms to ``LLMProvider`` (structural typing)."""

    name: str = "claude"  # placeholder; reset below
    supports_vision: bool = True  # Gemini Flash + Pro both have vision

    def __init__(self) -> None:
        self.name = "gemini"
        self._available: Optional[bool] = None
        self._image_flag: Optional[str] = None  # resolved on first vision call
        self._image_flag_probed: bool = False

    # ── availability ──────────────────────────────────────────────────

    async def is_available(self) -> bool:
        """Cached check: does ``gemini --version`` exit 0?

        Doesn't verify auth — the user could have the CLI installed but
        not signed in. The Test endpoint catches that by actually invoking
        the model. Mirrors the claude_cli pattern for consistency.
        """
        if self._available is None:
            self._available = await self._probe_version()
            logger.info("gemini: available=%s", self._available)
        return self._available

    def reset_cache(self) -> None:
        """Testing hook — also useful for the Settings panel's manual
        re-scan if we add one later."""
        self._available = None
        self._image_flag = None
        self._image_flag_probed = False

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

    async def _resolve_image_flag(self) -> Optional[str]:
        """Probe ``gemini --help`` once and cache the resolved image flag.

        Returns None if no recognised flag is found — caller should treat
        that as "this gemini version is text-only" and surface an error
        for vision dispatches rather than silently dropping attachments.
        """
        if self._image_flag_probed:
            return self._image_flag
        self._image_flag_probed = True
        try:
            proc = await asyncio.create_subprocess_exec(
                _CLI_BIN,
                "--help",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, _ = await asyncio.wait_for(
                proc.communicate(), timeout=_PROBE_TIMEOUT
            )
        except (FileNotFoundError, PermissionError, asyncio.TimeoutError):
            return None
        except Exception:  # noqa: BLE001
            logger.exception("gemini: unexpected error during --help probe")
            return None
        help_text = stdout_b.decode(errors="replace")
        for candidate in _IMAGE_FLAG_CANDIDATES:
            # Word-boundary match so `--input` doesn't shadow `--input-file`.
            if re.search(rf"(^|\s){re.escape(candidate)}(\s|=|\b)", help_text):
                self._image_flag = candidate
                logger.info("gemini: image flag resolved to %s", candidate)
                return candidate
        logger.warning(
            "gemini: no recognised image flag in --help — vision dispatches will fail"
        )
        return None

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

        For vision: prepend ``--{image_flag} <path>`` per attachment
        (resolved by ``_resolve_image_flag`` at init). For system prompts:
        gemini-cli accepts them via ``--system`` in current versions.
        """
        import os

        args: list[str] = [_CLI_BIN, "-p", user_prompt]

        if system_prompt:
            args += ["--system", system_prompt]

        if attachments:
            flag = await self._resolve_image_flag()
            if flag is None:
                raise LLMError(
                    "Gemini CLI doesn't expose a recognised image attachment "
                    "flag in its --help output. Either upgrade the CLI or "
                    "switch the Vision provider to a different one."
                )
            for path in attachments:
                args += [flag, os.path.abspath(path)]

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
