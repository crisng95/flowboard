"""Provider registry + ``run_llm`` dispatch.

The single entry point used by ``prompt_synth``, ``vision``, ``planner``.
Looks up the configured provider for a feature, runs the capability gates
(vision attachment vs. text-only provider), then delegates to the provider's
``run()``.

The provider registry is currently populated with **only Claude** because
later commits add Gemini / OpenAI / Grok one-by-one. Providers register
themselves by being imported here; nothing else.
"""
from __future__ import annotations

import logging
from typing import Literal, Optional

from .base import LLMError, LLMProvider
from .claude import ClaudeProvider
from .gemini import GeminiProvider
from .grok import GrokProvider
from . import secrets

logger = logging.getLogger(__name__)


Feature = Literal["auto_prompt", "vision", "planner"]


# Module-level singletons. Each provider class has cheap probe state
# (e.g. cached `--version` result) so re-instantiating per call would
# defeat the cache. Same lifetime as the agent process.
_PROVIDERS: dict[str, LLMProvider] = {
    "claude": ClaudeProvider(),
    "gemini": GeminiProvider(),
    "grok": GrokProvider(),
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
      1. Look up the configured provider for ``feature`` in
         ``~/.flowboard/secrets.json`` (defaults to ``claude``).
      2. Vision capability gate — if ``attachments`` is non-empty and the
         provider declares ``supports_vision = False``, raise immediately
         (no model call). Defense in depth alongside the per-provider
         attachment-rejection inside ``run()``.
      3. Availability gate — if the provider's CLI is missing or its API
         key isn't configured, raise immediately so the caller doesn't
         eat a longer subprocess / HTTP timeout.
      4. Dispatch.
    """
    config = secrets.read_active_providers()
    provider_name = config.get(feature, "claude")
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

    logger.info(
        "llm: provider=%s feature=%s attachments=%d",
        provider_name, feature, len(attachments) if attachments else 0,
    )
    return await provider.run(
        user_prompt,
        system_prompt=system_prompt,
        attachments=attachments,
        timeout=timeout,
    )
