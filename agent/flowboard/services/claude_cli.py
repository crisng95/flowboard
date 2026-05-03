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
import subprocess
from typing import Optional

from .llm.cli_utils import (
    resolve_cli_binary,
    validate_attachment_paths,
    validate_prompt_size,
    DEFAULT_SUBPROCESS_TIMEOUT,
    CLI_PROBE_TIMEOUT,
)

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = DEFAULT_SUBPROCESS_TIMEOUT
_CLI_BIN = "claude"

# Cached availability probe. None = not probed yet.
_available: Optional[bool] = None


class ClaudeCliError(RuntimeError):
    """Raised when the CLI invocation fails (non-zero exit, bad envelope, timeout)."""


async def _probe_available() -> bool:
    # Try to resolve and probe claude binary
    try:
        claude_bin = resolve_cli_binary(_CLI_BIN, CLI_PROBE_TIMEOUT)
        result = subprocess.run(
            [claude_bin, "--version"],
            capture_output=True,
            timeout=CLI_PROBE_TIMEOUT,
        )
        if result.returncode == 0:
            logger.info("claude_cli: SUCCESS - found claude at %s", claude_bin)
            return True
        logger.warning("claude_cli: probe returned code %d", result.returncode)
        return False
    except subprocess.TimeoutExpired:
        logger.warning("claude_cli: probe timed out")
        return False
    except Exception as e:  # noqa: BLE001
        logger.warning("claude_cli: probe failed - %s", e)
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

    # Validate inputs
    try:
        validate_prompt_size(user_prompt)
        if system_prompt:
            validate_prompt_size(system_prompt)
        validate_attachment_paths(attachments)
    except ValueError as exc:
        raise ClaudeCliError(f"Invalid input: {exc}") from exc

    full_prompt = user_prompt
    if attachments:
        # `@<path>` syntax handled by the CLI for file attachments.
        suffix = " ".join(f"@{os.path.abspath(p)}" for p in attachments)
        full_prompt = f"{user_prompt}\n\n{suffix}" if user_prompt else suffix

    # Resolve claude binary path: try PATH first, then npm locations
    claude_bin = resolve_cli_binary(_CLI_BIN, CLI_PROBE_TIMEOUT)
    args: list[str] = [claude_bin, "-p", full_prompt, "--output-format", "json"]
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

    # Use synchronous subprocess.run() to avoid asyncio subprocess issues on Windows.
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            timeout=timeout,
            text=False,
        )
    except FileNotFoundError as exc:
        raise ClaudeCliError("claude CLI not found on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise ClaudeCliError(f"claude CLI timed out after {timeout}s") from exc
    except Exception as exc:  # noqa: BLE001
        raise ClaudeCliError(f"claude CLI error: {exc}") from exc

    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace")[:400]
        raise ClaudeCliError(f"claude CLI exited {result.returncode}: {stderr}")

    stdout = result.stdout.decode(errors="replace")
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

    result_text = envelope.get("result")
    if not isinstance(result_text, str):
        raise ClaudeCliError("claude CLI envelope missing string 'result' field")

    return result_text
