"""Subprocess wrapper around the local ``claude`` CLI.

Flowboard's planner invokes this CLI instead of calling the Anthropic API
directly. Two upsides:
- no API key management; relies on the user's existing Claude subscription
- matches Flowboard's local-only single-user philosophy

The CLI is invoked with ``--output-format json`` so we get a structured
envelope of the form ``{"type":"result","result":"<LLM text>", ...}``. The
``result`` field is the LLM's plain-text response — we return that string
and let the caller parse further (e.g. extract a fenced JSON block).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 90.0
_CLI_BIN = "claude"

# Cached availability probe. None = not probed yet.
_available: Optional[bool] = None


class ClaudeCliError(RuntimeError):
    """Raised when the CLI invocation fails (non-zero exit, bad envelope, timeout)."""


async def _probe_available() -> bool:
    try:
        proc = await asyncio.create_subprocess_exec(
            _CLI_BIN,
            "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            await asyncio.wait_for(proc.communicate(), timeout=5.0)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            return False
        return proc.returncode == 0
    except (FileNotFoundError, PermissionError):
        return False
    except Exception:  # noqa: BLE001
        logger.exception("claude_cli: unexpected error during availability probe")
        return False


async def is_available(force: bool = False) -> bool:
    """Cached check: is the ``claude`` CLI usable on this host?"""
    global _available
    if _available is None or force:
        _available = await _probe_available()
        logger.info("claude_cli: available=%s", _available)
    return _available


def reset_availability_cache() -> None:
    """Testing hook."""
    global _available
    _available = None


async def run_claude(
    user_prompt: str,
    *,
    system_prompt: Optional[str] = None,
    attachments: Optional[list[str]] = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> str:
    """Invoke ``claude -p PROMPT`` and return the LLM's text result.

    ``attachments``: list of absolute file paths (typically images) to feed
    the model. Embedded as ``@<path>`` tokens in the prompt — the CLI reads
    those files and forwards them as multimodal blocks. We never quote the
    path because it sits inside an argv token (no shell), and we resolve to
    absolute so a CLI cwd surprise can't break the lookup.

    For attachments to work the parent directory MUST be allow-listed via
    ``--add-dir`` AND the Read tool must be auto-approved
    (``--permission-mode bypassPermissions``); without these the CLI
    prompts the user for permission and our `-p` non-interactive call gets
    a refusal text back instead of a description.

    Raises ``ClaudeCliError`` on failure, timeout, or malformed envelope.
    The prompt is passed as a separate argv token — no shell interpolation.
    """
    import os

    full_prompt = user_prompt
    if attachments:
        # `@<path>` syntax handled by the CLI for file attachments.
        suffix = " ".join(f"@{p}" for p in attachments)
        full_prompt = f"{user_prompt}\n\n{suffix}" if user_prompt else suffix

    args: list[str] = [_CLI_BIN, "-p", full_prompt, "--output-format", "json"]
    if system_prompt:
        args += ["--append-system-prompt", system_prompt]
    if attachments:
        # Allow-list each attachment's parent dir so the Read tool can
        # access it, and bypass the interactive permission prompt that
        # would otherwise stall a non-interactive `-p` invocation.
        seen_dirs: set[str] = set()
        for path in attachments:
            parent = os.path.dirname(os.path.abspath(path))
            if parent and parent not in seen_dirs:
                seen_dirs.add(parent)
                args += ["--add-dir", parent]
        args += ["--permission-mode", "bypassPermissions"]

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise ClaudeCliError("claude CLI not found on PATH") from exc

    try:
        stdout_b, stderr_b = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )
    except asyncio.TimeoutError as exc:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
        raise ClaudeCliError(f"claude CLI timed out after {timeout}s") from exc

    if proc.returncode != 0:
        raise ClaudeCliError(
            f"claude CLI exited {proc.returncode}: {stderr_b.decode(errors='replace')[:400]}"
        )

    stdout = stdout_b.decode(errors="replace")
    try:
        envelope = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise ClaudeCliError(
            f"claude CLI returned non-JSON output: {stdout[:200]}"
        ) from exc

    if not isinstance(envelope, dict):
        raise ClaudeCliError("claude CLI envelope is not an object")

    if envelope.get("is_error"):
        raise ClaudeCliError(
            f"claude CLI reported error: {envelope.get('result') or envelope.get('subtype')}"
        )

    result = envelope.get("result")
    if not isinstance(result, str):
        raise ClaudeCliError("claude CLI envelope missing string 'result' field")

    return result
