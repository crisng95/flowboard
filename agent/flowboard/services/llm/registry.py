"""Provider registry + ``run_llm`` dispatch.

The single entry point used by ``prompt_synth``, ``vision``, ``planner``.
Looks up the configured provider — plus that feature's pinned model and
reasoning effort — runs the capability gates (vision attachment vs.
text-only provider), then delegates to the provider's ``run()``.

Three CLI-backed providers are registered: Claude, Gemini (which drives
the ``agy`` CLI — see ``gemini.py`` for why the id outlived the binary),
OpenAI Codex. xAI Grok was previously wired up but never shipped a usable
end-user CLI, so it was dropped from both UI and registry.
"""
from __future__ import annotations

import logging
from typing import Literal, Optional

from .base import LLMError, LLMProvider
from .claude import ClaudeProvider
from .gemini import GeminiProvider
from .openai import OpenAIProvider
from . import secrets

logger = logging.getLogger(__name__)


Feature = Literal["auto_prompt", "vision", "planner"]


# Module-level singletons. Each provider class has cheap probe state
# (e.g. cached `--version` result, cached model catalog) so re-instantiating
# per call would defeat the cache. Same lifetime as the agent process.
_PROVIDERS: dict[str, LLMProvider] = {
    "claude": ClaudeProvider(),
    "gemini": GeminiProvider(),
    "openai": OpenAIProvider(),
}


def get_provider(name: str) -> Optional[LLMProvider]:
    """Lookup by name. None if the name is unknown."""
    return _PROVIDERS.get(name)


def list_providers() -> list[LLMProvider]:
    """All registered providers, in deterministic order."""
    return list(_PROVIDERS.values())


async def run_llm(
    feature: Feature,
    user_prompt: str,
    *,
    system_prompt: Optional[str] = None,
    attachments: Optional[list[str]] = None,
    timeout: float = 90.0,
) -> str:
    """Feature-routed LLM dispatch.

    Resolution chain:
      1. Look up the configured provider / model / effort for ``feature``
         in ``~/.flowboard/secrets.json``. No defaults — if the user
         hasn't picked a provider yet, raise loud so the UI's forced-setup
         gate intercepts before the call lands. Model and effort MAY be
         unset even when the provider is pinned; unset means "don't pass
         the flag", so the CLI's own configured default applies.
      2. Vision capability gate — if ``attachments`` is non-empty and the
         provider declares ``supports_vision = False``, raise immediately
         (no model call). Defense in depth alongside the per-provider
         attachment-rejection inside ``run()``.
      3. Availability gate — if the provider's CLI is missing or its API
         key isn't configured, raise immediately so the caller doesn't
         eat a longer subprocess / HTTP timeout.
      4. Effort re-check — see below.
      5. Dispatch.
    """
    config = secrets.read_feature_config()
    entry = config.get(feature)
    if entry is None:
        raise LLMError(
            f"No AI provider configured for {feature}; "
            f"open the AI Provider settings to set one up."
        )
    provider_name = entry["provider"]
    model = entry.get("model")
    effort = entry.get("effort")
    provider = _PROVIDERS.get(provider_name)
    if provider is None:
        raise LLMError(
            f"Unknown provider {provider_name!r} configured for {feature}; "
            f"reconfigure in Settings → AI Providers."
        )

    if attachments and not provider.supports_vision:
        raise LLMError(
            f"{provider_name} doesn't support vision; "
            f"reconfigure Vision provider in Settings → AI Providers."
        )

    if not await provider.is_available():
        raise LLMError(
            f"{provider_name} is not configured "
            f"(CLI missing or API key not set); "
            f"reconfigure in Settings → AI Providers."
        )

    # Defense in depth. `effort` came out of secrets.json, which the HTTP
    # layer validates on the way in — but that file is on disk and
    # hand-editable, a provider's ladder can shrink under a config written
    # against the old one, and this value ends up inside a CLI flag
    # (`-c model_reasoning_effort="…"` for Codex). Dropping an
    # unrecognised value costs the user their effort pin for this call and
    # leaves the CLI's own default in place; passing it through would put
    # an unchecked string on the command line. The model is deliberately
    # NOT re-checked here: unknown-but-valid model ids are the documented
    # escape hatch (see routes/llm.py's `_validate_model`).
    if effort is not None:
        allowed = list(getattr(provider, "efforts", []) or [])
        if allowed and effort not in allowed:
            logger.warning(
                "llm: dropping unknown effort %r for provider=%s feature=%s "
                "(accepts %s); falling back to the CLI's own setting",
                effort, provider_name, feature, ", ".join(allowed),
            )
            effort = None

    logger.info(
        "llm: provider=%s feature=%s model=%s effort=%s attachments=%d",
        provider_name, feature, model or "-", effort or "-",
        len(attachments) if attachments else 0,
    )
    return await provider.run(
        user_prompt,
        system_prompt=system_prompt,
        attachments=attachments,
        timeout=timeout,
        model=model,
        effort=effort,
    )
