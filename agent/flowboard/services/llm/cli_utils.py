"""Shared utilities for LLM CLI providers (Claude, Gemini, OpenAI Codex).

Consolidates cross-provider patterns:
- Binary path resolution (PATH + Windows npm fallback)
- Subprocess error handling
- Input validation (prompt size, attachment limits)
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
from typing import Optional, Type

logger = logging.getLogger(__name__)

# Subprocess timeouts
CLI_PROBE_TIMEOUT = 5.0
DEFAULT_SUBPROCESS_TIMEOUT = 90.0

# Input validation limits
MAX_PROMPT_BYTES = 100 * 1024  # 100 KB
MAX_ATTACHMENTS = 10

# Windows npm paths
_WINDOWS_NPM_PATHS = [
    ("APPDATA", "npm"),
    ("USERPROFILE", "AppData", "Roaming", "npm"),
    ("HOME", "AppData", "Roaming", "npm"),
]


def get_windows_npm_paths(cli_name: str) -> list[str]:
    r"""Get dynamic list of Windows npm paths for a CLI tool.

    Checks:
    1. %APPDATA%\npm\<cli_name>.cmd
    2. %USERPROFILE%\AppData\Roaming\npm\<cli_name>.cmd
    3. ~\AppData\Roaming\npm\<cli_name>.cmd (via expanduser)

    Returns list of paths to check (may be empty if no env vars set).
    """
    paths = []

    appdata = os.environ.get("APPDATA")
    if appdata:
        paths.append(os.path.join(appdata, "npm", f"{cli_name}.cmd"))

    userprofile = os.environ.get("USERPROFILE")
    if userprofile:
        paths.append(
            os.path.join(userprofile, "AppData", "Roaming", "npm", f"{cli_name}.cmd")
        )

    home = os.path.expanduser("~")
    if home and home != "~":  # expanduser returns ~ if HOME not set
        paths.append(os.path.join(home, "AppData", "Roaming", "npm", f"{cli_name}.cmd"))

    return paths


def resolve_cli_binary(
    cli_name: str, timeout: float = CLI_PROBE_TIMEOUT
) -> str:
    """Resolve CLI binary path: try PATH first, then Windows npm locations.

    Args:
        cli_name: Name of the CLI tool (e.g., "claude", "gemini", "codex")
        timeout: Timeout for --version probe (seconds)

    Returns:
        Resolved binary path, or cli_name as fallback (will error later if not found)
    """
    # Try PATH first
    if cli_path := shutil.which(cli_name):
        logger.debug(f"{cli_name}: resolved from PATH: {cli_path}")
        return cli_path

    # Try Windows npm locations
    for npm_path in get_windows_npm_paths(cli_name):
        if os.path.exists(npm_path):
            try:
                result = subprocess.run(
                    [npm_path, "--version"],
                    capture_output=True,
                    timeout=timeout,
                )
                if result.returncode == 0:
                    logger.info(f"{cli_name}: resolved from npm: {npm_path}")
                    return npm_path
            except (subprocess.TimeoutExpired, Exception):
                pass

    logger.warning(
        f"{cli_name}: not found in PATH or npm locations, falling back to '{cli_name}'"
    )
    return cli_name


def validate_prompt_size(prompt: str, max_bytes: int = MAX_PROMPT_BYTES) -> None:
    """Validate prompt doesn't exceed size limit.

    Args:
        prompt: The user or system prompt
        max_bytes: Maximum allowed size in bytes

    Raises:
        ValueError: If prompt exceeds limit
    """
    if len(prompt.encode("utf-8")) > max_bytes:
        raise ValueError(
            f"Prompt exceeds {max_bytes // 1024}KB limit "
            f"({len(prompt.encode('utf-8'))} bytes)"
        )


def validate_attachment_paths(
    attachments: Optional[list[str]], max_count: int = MAX_ATTACHMENTS
) -> None:
    """Validate attachments exist and are readable.

    Args:
        attachments: List of file paths
        max_count: Maximum number of attachments allowed

    Raises:
        ValueError: If validation fails
    """
    if not attachments:
        return

    if len(attachments) > max_count:
        raise ValueError(f"Too many attachments (max {max_count}, got {len(attachments)})")

    for path in attachments:
        abs_path = os.path.abspath(path)
        if not os.path.isfile(abs_path):
            raise ValueError(f"Attachment not found: {path}")
        if not os.access(abs_path, os.R_OK):
            raise ValueError(f"Attachment not readable: {path}")


def validate_model_name(
    model: Optional[str], allowed: Optional[set[str]] = None
) -> Optional[str]:
    """Validate model name against whitelist.

    Args:
        model: Model name from user input or environment
        allowed: Set of allowed model names (if None, validation skipped)

    Returns:
        Validated model name, or None if invalid (caller should use default)

    Raises:
        ValueError: If validation is strict and model not allowed
    """
    if not model or not allowed:
        return model
    if model in allowed:
        return model
    logger.warning(f"Unknown model '{model}', not in allowed set: {allowed}")
    return None
