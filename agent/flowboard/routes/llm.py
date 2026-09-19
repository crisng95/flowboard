"""HTTP routes for the multi-LLM provider Settings UI.

Endpoints:
  GET  /api/llm/providers                — list with state + catalog per provider
  GET  /api/llm/providers/{name}/models  — that provider's model catalog
  PUT  /api/llm/providers/{name}         — set/clear API key
  POST /api/llm/providers/{name}/test    — connection ping
  GET  /api/llm/config                   — read per-feature provider/model/effort
  PUT  /api/llm/config                   — update per-feature provider/model/effort

Frontend ↔ backend contract is documented in detail in
``.omc/plans/multi-llm-provider-legacy.md`` (UI Specification → Frontend
↔ backend contract section).

API keys are accepted only via PUT /providers/{name} and never echoed
back. The list endpoint reports `configured: true/false` instead.
"""
from __future__ import annotations

import logging
import time
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from flowboard.services.llm import registry, secrets
from flowboard.services.llm.base import LLMError
from flowboard.services import claude_cli

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/llm", tags=["llm"])


# ── request/response models ───────────────────────────────────────────


class _ApiKeyBody(BaseModel):
    """PUT /api/llm/providers/{name}: `apiKey: null` clears the key."""
    apiKey: Optional[str] = None


class _FeatureConfigBody(BaseModel):
    """One feature's assignment inside PUT /api/llm/config.

    All three fields are optional so the UI can PATCH just the effort
    without re-sending the provider. Merge semantics live in
    ``set_config`` — see its docstring for how an omitted field differs
    from an explicit null.
    """
    provider: Optional[str] = None
    model: Optional[str] = None
    effort: Optional[str] = None


class _ConfigBody(BaseModel):
    """PUT /api/llm/config: any subset of the three features.

    ``extra="allow"`` is deliberate. Pydantic's default would silently
    drop a misspelled feature key like ``auto_promt`` and we'd answer 200
    having saved nothing; keeping the extras lets ``set_config`` name the
    bad key in a 400 instead.
    """
    model_config = ConfigDict(extra="allow")

    auto_prompt: Optional[_FeatureConfigBody] = None
    vision: Optional[_FeatureConfigBody] = None
    planner: Optional[_FeatureConfigBody] = None


class _TestBody(BaseModel):
    """POST /api/llm/providers/{name}/test: optional model/effort so the
    Settings panel can verify the exact pair the user is about to save,
    not just the provider's default."""
    model: Optional[str] = None
    effort: Optional[str] = None


# Whitelist for the writable feature → provider mapping. Hand-edited
# secrets.json with garbage values is tolerated by `read_feature_config`,
# but the HTTP surface must reject input that wouldn't route anywhere.
_VALID_PROVIDER_NAMES = {"claude", "gemini", "openai"}
_VALID_FEATURES = ("auto_prompt", "vision", "planner")


# ── GET /api/llm/providers ────────────────────────────────────────────


@router.post("/debug/reset-probe")
async def debug_reset_probe() -> dict:
    """Force re-probe Claude CLI (debug endpoint)."""
    claude_cli.reset_availability_cache()
    available = await claude_cli.is_available(force=True)
    return {"ok": True, "claude_available": available}


@router.get("/providers")
async def list_providers() -> list[dict]:
    """Snapshot per-provider state for the Settings panel.

    Each entry carries everything the UI needs to render the right row
    state without follow-up calls: availability, whether the provider
    exposes a reasoning-effort setting and which values it accepts, and
    its model catalog. `configured` reports whether the user has done
    setup (CLI: same as `available`; API: key present, regardless of test
    outcome). `mode` is meaningful only for OpenAI ("cli"/"api"/"none").

    `models` may legitimately be empty — a provider whose catalog can't
    be fetched right now is still usable, the UI just renders a free-text
    model field instead of a dropdown.
    """
    out: list[dict] = []
    for provider in registry.list_providers():
        # CLI providers: available implies configured. API providers:
        # `configured` means a key exists; `available` adds "key works"
        # via the cached probe. Splitting the two lets the UI distinguish
        # "user has set things up but the key is bad" from "user hasn't
        # set anything up yet".
        available = await provider.is_available()
        if provider.name == "openai":
            mode = provider.mode  # type: ignore[attr-defined]
            configured = (
                bool(secrets.get_api_key("openai"))
                or getattr(provider, "_cli_available", False)
            )
            requires_key = False  # CLI path doesn't require it
        else:
            mode = "cli"
            configured = available
            requires_key = False

        out.append({
            "name": provider.name,
            "supportsVision": provider.supports_vision,
            "available": available,
            "configured": configured,
            "requiresKey": requires_key,
            "mode": mode,
            "supportsEffort": getattr(provider, "supports_effort", False),
            "efforts": list(getattr(provider, "efforts", []) or []),
            "models": await _safe_list_models(provider),
            "defaultModel": getattr(provider, "default_model", None),
        })
    return out


# ── GET /api/llm/providers/{name}/models ──────────────────────────────


@router.get("/providers/{name}/models")
async def list_provider_models(name: str, force: bool = False) -> dict:
    """Return one provider's model catalog.

    `force=true` bypasses the provider's in-process cache — that's the
    Settings panel's "Refresh models" button, for when the user just
    gained access to a new model upstream and doesn't want to wait out
    the TTL. `cached` reports whether this response came from the cache,
    so the UI can show "as of a moment ago" vs. "just refreshed".
    """
    if name not in _VALID_PROVIDER_NAMES:
        raise HTTPException(status_code=404, detail=f"unknown provider {name!r}")
    provider = registry.get_provider(name)
    if provider is None:
        raise HTTPException(status_code=404, detail=f"provider {name!r} not registered")
    models = await _safe_list_models(provider, force=force)
    return {"models": models, "cached": not force}


# ── PUT /api/llm/providers/{name} ─────────────────────────────────────


@router.put("/providers/{name}")
async def set_provider_key(name: str, body: _ApiKeyBody) -> dict:
    """Save (or clear, when `apiKey: null`) a provider's API key.

    Only OpenAI's API mode accepts keys (its CLI path doesn't need one).
    Setting a key on a CLI-only provider is a 400 — the UI shouldn't
    reach this endpoint for them in the first place, but defend in depth.
    """
    if name not in _VALID_PROVIDER_NAMES:
        raise HTTPException(status_code=404, detail=f"unknown provider {name!r}")
    if name != "openai":
        raise HTTPException(
            status_code=400,
            detail=f"{name} doesn't accept API keys; uses CLI auth instead",
        )
    secrets.set_api_key(name, body.apiKey)
    # Bust the relevant provider's availability cache so the next /providers
    # poll reflects the change immediately rather than waiting up to 60s.
    provider = registry.get_provider(name)
    if provider is not None and hasattr(provider, "reset_cache"):
        provider.reset_cache()
    logger.info("llm: api key %s for %s", "set" if body.apiKey else "cleared", name)
    return {"ok": True}


# ── POST /api/llm/providers/{name}/test ───────────────────────────────


@router.post("/providers/{name}/test")
async def test_provider(name: str, body: Optional[_TestBody] = None) -> dict:
    """Ping the provider with a tiny prompt and report success / latency.

    Cost: ~1 token in + ~1 token out. Used by the Settings panel's "Test"
    button. Returns `{ok, latencyMs}` on success or `{ok: false, error}`
    on any failure mode.

    The optional body carries the model/effort the user is currently
    looking at, so Test exercises the pair they're about to save rather
    than the provider's default. Omitted fields mean "don't pass the
    flag", exactly as in dispatch.

    Both are validated with the *same* rules ``set_config`` uses, via the
    shared helpers below. They used to be forwarded raw, which mattered:
    for Codex, ``effort`` is interpolated into
    ``-c model_reasoning_effort="{effort}"``, and the comment justifying
    that interpolation says the value is already whitelist-validated at
    the HTTP layer — true on the save path, false on this one. Same ``-c``
    mechanism configures ``sandbox_mode``.
    """
    if name not in _VALID_PROVIDER_NAMES:
        raise HTTPException(status_code=404, detail=f"unknown provider {name!r}")
    provider = registry.get_provider(name)
    if provider is None:
        raise HTTPException(status_code=404, detail=f"provider {name!r} not registered")

    # Input first: a malformed model/effort is a 400 about the request,
    # not an inline "provider not configured" about the host.
    model = body.model if body else None
    effort = body.effort if body else None
    _validate_effort(provider, name, effort)
    await _validate_model(provider, name, model)

    if not await provider.is_available():
        return {"ok": False, "error": "provider not configured"}

    started = time.monotonic()
    try:
        # Single-character prompt to keep cost minimal. We do NOT pass
        # max_tokens because some providers (Claude CLI) ignore it; we
        # accept the small overage as a one-shot cost.
        # Timeout aligned with the slowest production feature ceiling
        # (auto_prompt_batch + vision both at 120s). The test endpoint
        # used to time out at 30s while Vision dispatches succeeded
        # because the Test path was tighter than what the user actually
        # runs. 120s keeps Test honest — if Vision passes here, it'll
        # pass at dispatch time too.
        # Agentic CLIs (agy) can take several minutes on a slow turn, so
        # they raise the ceiling via `test_timeout_secs`.
        test_timeout = getattr(provider, "test_timeout_secs", 120.0)
        await provider.run(".", timeout=test_timeout, model=model, effort=effort)
    except LLMError as exc:
        return {"ok": False, "error": str(exc)[:200]}
    except Exception as exc:  # noqa: BLE001
        # Wrapped so the Test endpoint never 500s — UI can render the
        # error inline regardless of which exception type leaked through.
        logger.exception("llm: test endpoint hit unexpected error for %s", name)
        return {"ok": False, "error": f"unexpected: {type(exc).__name__}"}
    latency_ms = int((time.monotonic() - started) * 1000)
    return {"ok": True, "latencyMs": latency_ms}


# ── GET /api/llm/config ───────────────────────────────────────────────


@router.get("/config")
def get_config() -> dict:
    """Return the per-feature provider/model/effort plus ``configured``.

    Every feature is an object with three ``str | null`` fields. Null
    provider means the user hasn't pinned one yet; null model/effort mean
    "use whatever that CLI is already configured to use". ``configured``
    is True once every feature has a provider — the frontend uses it to
    gate the forced AI Provider setup dialog on first run. It no longer
    requires all features to share one provider: per-feature selection is
    the point of this screen.
    """
    saved = secrets.read_feature_config()
    out: dict = {}
    for feature in _VALID_FEATURES:
        entry = saved.get(feature) or {}
        out[feature] = {
            "provider": entry.get("provider"),
            "model": entry.get("model"),
            "effort": entry.get("effort"),
        }
    out["configured"] = secrets.is_active_providers_configured()
    return out


# ── PUT /api/llm/config ───────────────────────────────────────────────


@router.put("/config")
async def set_config(body: _ConfigBody) -> dict:
    """Update one or more features' provider / model / effort.

    Validation:
      - provider must be a registered name;
      - effort must be one of *that provider's* ``efforts``, so a stale
        frontend can't write ``xhigh`` into agy (which stops at ``high``);
      - model is accepted even when it isn't in the cached catalog, and
        for a provider whose catalog is hand-maintained it is accepted
        unconditionally. See ``_validate_model``.

    Merge semantics: a field the caller omits keeps its stored value,
    except when the provider changes. Switching providers clears any
    model/effort the caller didn't re-send, because a model id is
    provider-specific and silently carrying ``gemini-3.8-flash-low`` over
    to Claude would produce a confusing dispatch-time failure instead of
    an obvious empty field.

    Provider *availability* is NOT checked here — picking an unconfigured
    provider is allowed (the dispatch path fails loud when invoked). Lets
    the user pre-pin a provider before completing setup.
    """
    for feature in body.model_extra or {}:
        raise HTTPException(status_code=400, detail=f"unknown feature {feature!r}")

    updates = {
        feature: getattr(body, feature)
        for feature in _VALID_FEATURES
        if getattr(body, feature) is not None
    }
    if not updates:
        raise HTTPException(status_code=400, detail="no fields to update")

    existing = secrets.read_feature_config()
    resolved: dict[str, dict] = {}

    for feature, patch in updates.items():
        current = existing.get(feature) or {}
        # ``model_fields_set`` distinguishes "field omitted" from "field
        # explicitly null" — the latter is how the UI clears a pinned
        # model or effort without also clearing the provider.
        sent = patch.model_fields_set
        provider_name = patch.provider or current.get("provider")
        if provider_name is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"no provider set for {feature!r}; "
                    f"send a provider before setting model or effort"
                ),
            )
        if provider_name not in _VALID_PROVIDER_NAMES:
            raise HTTPException(
                status_code=400, detail=f"unknown provider {provider_name!r}"
            )
        provider = registry.get_provider(provider_name)

        switched = provider_name != current.get("provider")
        model = patch.model if "model" in sent else None
        effort = patch.effort if "effort" in sent else None
        if model is None and "model" not in sent and not switched:
            model = current.get("model")
        if effort is None and "effort" not in sent and not switched:
            effort = current.get("effort")

        _validate_effort(provider, provider_name, effort)
        await _validate_model(provider, provider_name, model)

        resolved[feature] = {
            "provider": provider_name,
            "model": model,
            "effort": effort,
        }

    # Write only after every feature validated, so a bad third entry can't
    # leave the first two half-applied.
    for feature, entry in resolved.items():
        secrets.set_feature_config(
            feature, entry["provider"], entry["model"], entry["effort"]
        )
    logger.info("llm: config updated features=%s", sorted(resolved))
    return {"ok": True}


# ── helpers ───────────────────────────────────────────────────────────
#
# Model / effort validation lives here rather than inline because two
# routes need it — PUT /config (save) and POST /providers/{name}/test —
# and they drifted: Test forwarded both fields straight through to
# ``provider.run`` while Save checked them. One copy, two callers.


def _validate_effort(provider, provider_name: str, effort: Optional[str]) -> None:
    """400 unless ``effort`` is one of *that provider's* accepted values.

    Per-provider because the ladders differ — claude and codex reach
    ``xhigh``/``max``, agy stops at ``high`` — so a stale frontend must not
    be able to write ``xhigh`` into agy. It also has to hold on the Test
    path: Codex interpolates the value into ``-c
    model_reasoning_effort="{effort}"``, and the same ``-c`` mechanism is
    what configures ``sandbox_mode``. There is no argv injection (list
    form, no shell) and the agent is loopback-only, but an unvalidated
    string reaching a config-override flag is not something to leave to
    those two facts.

    ``None`` means "don't pass the flag" and is always allowed.
    """
    if effort is None:
        return
    allowed = list(getattr(provider, "efforts", []) or [])
    if effort not in allowed:
        raise HTTPException(
            status_code=400,
            detail=(
                f"unknown effort {effort!r} for {provider_name}; "
                f"expected one of {', '.join(allowed) or '(none)'}"
            ),
        )


async def _validate_model(provider, provider_name: str, model: Optional[str]) -> None:
    """400 only when the provider's catalog is authoritative *and* live.

    Membership is a meaningful check exactly once: against ``agy models``,
    which asks the backend what this account can reach. There, a model
    outside the list is a typo.

    Everywhere else the catalog is a hand-maintained hint — Claude's is
    four aliases, Codex's is five slugs read off one pinned build — and
    enforcing it broke the escape hatch both providers document. Typing
    ``claude-opus-5``, which ``claude --help`` explicitly accepts and
    ``claude.py`` explicitly promises, returned a 400; a user on a
    different Codex build could not select their own model at all.

    An empty catalog still means "we couldn't enumerate", not "no models
    exist", so it never rejects either.
    """
    if model is None or provider is None:
        return
    if not getattr(provider, "catalog_is_authoritative", False):
        return
    known = {m["id"] for m in await _safe_list_models(provider)}
    if known and model not in known:
        raise HTTPException(
            status_code=400,
            detail=(
                f"unknown model {model!r} for {provider_name}; "
                f"pick one from GET /api/llm/providers/{provider_name}/models"
            ),
        )


async def _safe_list_models(provider, force: bool = False) -> list[dict]:
    """``provider.list_models()`` with a belt-and-braces guard.

    The protocol says catalogs never raise, but this endpoint is the one
    place a provider bug would turn "the Settings panel is a bit empty"
    into "the Settings panel is a 500". Swallow, log, return empty.
    """
    lister = getattr(provider, "list_models", None)
    if lister is None:
        return []
    try:
        return await lister(force=force)
    except Exception:  # noqa: BLE001
        logger.exception("llm: model catalog failed for %s", provider.name)
        return []
