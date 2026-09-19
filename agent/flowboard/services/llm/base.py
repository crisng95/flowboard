"""Protocol + shared types for the multi-LLM provider layer.

Every provider implementation (Claude / Gemini / OpenAI Codex) conforms to
``LLMProvider``. The registry (``registry.py``) is the only thing that
knows the concrete classes; everything else routes through ``run_llm``.

Caller signature is identical across providers — ``attachments`` is a list
of absolute file paths, and each provider converts internally based on its
transport (CLI flag vs. base64 data URL). See the plan at
``.omc/plans/multi-llm-provider-legacy.md`` for the full hybrid-attachment
rationale.

**Model + effort selection.** Every feature (Auto-Prompt / Vision /
Planner) can pin its own model *and* its own reasoning effort, stored
per-feature in ``secrets.featureConfig``. Both are optional on ``run()``:
``None`` means "don't pass the flag", which lets each CLI apply whatever
default the user configured in its own settings. That "unset ⇒ omit the
flag" rule matters — passing a hard-coded model would silently override
a choice the user made inside ``claude`` / ``agy`` / ``codex`` itself.

Model *catalogs* are exposed through ``list_models()``. Some providers can
enumerate their models live (``agy models``); others have no headless
listing command, so they ship a static list. Either way the contract is
the same: return ``[{"id", "label"}]`` and **never raise** — a catalog is
a UI convenience, and a provider whose catalog can't be fetched is still
perfectly usable by typing a model id by hand.

``catalog_is_authoritative`` says which of those two a catalog is, and it
is the only thing the HTTP layer is allowed to reject a model against. A
live listing genuinely enumerates what the account can reach, so a model
outside it is a typo. A static list is a *hint* maintained by hand — the
Claude one is aliases only, the Codex one is five slugs read off one
pinned build — and rejecting against it would lock users out of models
their CLI serves perfectly well.
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

    # ── model / effort selection ──────────────────────────────────────
    #
    # ``supports_effort`` gates the UI's effort dropdown; ``efforts`` is
    # the whitelist the HTTP layer validates against (so a stale frontend
    # can't write "ultra" into a provider that only knows low/medium/high).
    # ``default_model`` is an *advisory* hint for the Settings panel's
    # initial selection — dispatch never falls back to it, because an
    # unpinned model must stay unpinned (see module docstring).
    supports_effort: bool
    efforts: list[str]
    default_model: Optional[str]
    # True only when ``list_models`` asks the backend what exists right
    # now. See the module docstring: this gates model validation, so
    # setting it on a hand-maintained list turns that list into a
    # whitelist and locks users out of models that work.
    catalog_is_authoritative: bool

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
        """Return the model's plain-text response.

        ``attachments`` are absolute file paths. Vision-capable providers
        translate them to whatever transport their backend uses. Text-only
        providers MUST raise ``LLMError`` if attachments are non-empty —
        the registry guards against this too, but defense in depth.

        ``model`` / ``effort`` are per-feature overrides resolved by the
        registry from ``secrets.featureConfig``. ``None`` means "leave the
        CLI's own default alone" — do not substitute a hard-coded value.
        """
        ...

    async def is_available(self) -> bool:
        """Cheap, cached check: is this provider usable on this host?

        For CLI providers: probe the binary with ``--version``.
        For API providers: check that an API key is configured.

        Must NOT actually call the model — that's what the test endpoint is for.
        """
        ...

    async def list_models(self, force: bool = False) -> list[dict]:
        """Return this provider's model catalog as ``[{"id", "label"}]``.

        ``force=True`` bypasses any in-process cache (the Settings panel's
        "Refresh" button). Providers with a live listing command cache the
        result with a short TTL so opening Settings doesn't re-shell out
        on every poll.

        **Never raises.** A catalog that can't be fetched comes back as an
        empty list; the caller renders a free-text model field instead of
        a dropdown, and the user is still able to type a model id.
        """
        ...
