"""Protocol + shared types for the multi-LLM provider layer.

Every provider implementation (Claude / Gemini / OpenAI Codex) conforms to
``LLMProvider``. The registry (``registry.py``) is the only thing that
knows the concrete classes; everything else routes through ``run_llm``.

Caller signature is identical across providers — ``attachments`` is a list
of absolute file paths, and each provider converts internally based on its
transport (CLI flag vs. base64 data URL). See the plan at
``.omc/plans/multi-llm-provider-legacy.md`` for the full hybrid-attachment
rationale.
"""
from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable


class LLMError(RuntimeError):
    """Base error type for the multi-LLM layer.

    Provider implementations raise subclasses (or this directly) so the
    HTTP layer can surface a single error shape regardless of which
    provider failed. Never carries the API key or any token.
    """


@runtime_checkable
class LLMProvider(Protocol):
    """Every provider implementation conforms to this surface."""

    name: str
    supports_vision: bool

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: Optional[str] = None,
        attachments: Optional[list[str]] = None,
        timeout: float = 90.0,
    ) -> str:
        """Return the model's plain-text response.

        ``attachments`` are absolute file paths. Vision-capable providers
        translate them to whatever transport their backend uses. Text-only
        providers MUST raise ``LLMError`` if attachments are non-empty —
        the registry guards against this too, but defense in depth.
        """
        ...

    async def is_available(self) -> bool:
        """Cheap, cached check: is this provider usable on this host?

        For CLI providers: probe the binary with ``--version``.
        For API providers: check that an API key is configured.

        Must NOT actually call the model — that's what the test endpoint is for.
        """
        ...
