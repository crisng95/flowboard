"""Claude provider — thin LLMProvider wrapper around the existing
``claude_cli`` subprocess module.

Existing tested code paths in ``services/claude_cli.py`` stay untouched.
This module just adapts that interface to the ``LLMProvider`` Protocol so
the registry can dispatch to it through the unified surface.

When the multi-LLM plan reaches Step 5 (migrate prompt_synth / vision /
planner to use ``run_llm``), each call site stops importing claude_cli
directly and goes through the registry. ``claude_cli`` itself remains
as the subprocess implementation detail.

**Error type contract**: callers using ``run_llm`` see ``LLMError`` (and
nothing else) on failure. ``claude_cli.run_claude`` raises ``ClaudeCliError``
which we translate here so the contract stays clean — without this wrap,
a caller's ``except LLMError:`` would miss every Claude failure mode.
"""
from __future__ import annotations

from typing import Optional

from flowboard.services import claude_cli

from .base import LLMError


class ClaudeProvider:
    """Conforms to ``LLMProvider`` (structural typing — no inheritance)."""

    name: str = "claude"
    supports_vision: bool = True  # Haiku 4.5 / Sonnet / Opus all have vision

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: Optional[str] = None,
        attachments: Optional[list[str]] = None,
        timeout: float = 90.0,
    ) -> str:
        try:
            return await claude_cli.run_claude(
                user_prompt,
                system_prompt=system_prompt,
                attachments=attachments,
                timeout=timeout,
            )
        except claude_cli.ClaudeCliError as exc:
            # Preserve the original message + chain for diagnostics, but
            # surface as LLMError so the contract holds for callers.
            raise LLMError(str(exc)) from exc

    async def is_available(self) -> bool:
        return await claude_cli.is_available()
