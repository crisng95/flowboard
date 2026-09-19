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

**Model catalog**: the ``claude`` CLI has no headless "list models"
command — ``claude --help`` documents the ``--model`` flag as taking
"an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a
model's full name (e.g. 'claude-fable-5')". So the catalog here is
static and intentionally alias-only. Aliases always resolve to whatever
the currently-latest model in that tier is, which means this list does
not rot when Anthropic ships a new point release — a hard-coded
``claude-sonnet-4-5-20250929`` would.

Users who *want* a pinned full model name can still type one, and that is
enforced rather than merely intended: ``catalog_is_authoritative`` is
False here, so ``routes/llm.py`` does not check membership against this
list at all. It used to, which meant ``claude-opus-5`` — a model the CLI
accepts, documented two paragraphs up as accepted — came back a 400.
"""
from __future__ import annotations

from typing import Optional

from flowboard.services import claude_cli

from .base import LLMError


# Alias-only catalog — see module docstring for why full model names are
# deliberately absent.
_MODELS: list[dict] = [
    {"id": "fable", "label": "Fable (latest)"},
    {"id": "opus", "label": "Opus (latest)"},
    {"id": "sonnet", "label": "Sonnet (latest)"},
    {"id": "haiku", "label": "Haiku (latest)"},
]

# Verified against ``claude --help``: "--effort <level>  Effort level for
# the current session (low, medium, high, xhigh, max)".
_EFFORTS: list[str] = ["low", "medium", "high", "xhigh", "max"]


class ClaudeProvider:
    """Conforms to ``LLMProvider`` (structural typing — no inheritance)."""

    name: str = "claude"
    supports_vision: bool = True  # Haiku 4.5 / Sonnet / Opus all have vision
    supports_effort: bool = True
    efforts: list[str] = _EFFORTS
    # Advisory only — the Settings panel pre-selects this for a feature the
    # user hasn't configured yet. Dispatch never substitutes it; an unpinned
    # model stays unpinned so the CLI's own model setting wins.
    default_model: Optional[str] = "sonnet"
    # The catalog is four hand-written aliases, not an enumeration of what
    # this account can reach. Nothing may validate against it.
    catalog_is_authoritative: bool = False

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: Optional[str] = None,
        attachments: Optional[list[str]] = None,
        timeout: float = 90.0,
        model: Optional[str] = None,
        effort: Optional[str] = None,
    ) -> str:
        try:
            return await claude_cli.run_claude(
                user_prompt,
                system_prompt=system_prompt,
                attachments=attachments,
                timeout=timeout,
                model=model,
                effort=effort,
            )
        except claude_cli.ClaudeCliError as exc:
            # Preserve the original message + chain for diagnostics, but
            # surface as LLMError so the contract holds for callers.
            raise LLMError(str(exc)) from exc

    async def is_available(self) -> bool:
        return await claude_cli.is_available()

    async def list_models(self, force: bool = False) -> list[dict]:
        """Static catalog — ``force`` is accepted for protocol symmetry but
        has nothing to refresh (there is no upstream listing to re-fetch)."""
        return [dict(m) for m in _MODELS]
