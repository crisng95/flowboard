"""Tests for the /api/llm/* HTTP routes.

Uses FastAPI TestClient + the conftest's app fixture. Provider classes
are real but their cheap probes are stubbed (subprocess + httpx mocked
where needed) so no real CLI / network is hit.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from flowboard.services.llm import registry, secrets


@pytest.fixture
def tmp_secrets_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    p = tmp_path / "secrets.json"
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(p))
    return p


@pytest.fixture(autouse=True)
def _reset_provider_caches():
    """Each route test gets fresh provider probes — module-level singletons
    cache availability between tests otherwise."""
    for p in registry.list_providers():
        if hasattr(p, "reset_cache"):
            p.reset_cache()
    yield


# ── GET /api/llm/providers ────────────────────────────────────────────


def test_list_providers_returns_all_three(client, tmp_secrets_path):
    """All 3 registered providers (Claude / Gemini / OpenAI) appear with
    expected fields. xAI Grok was dropped — never shipped a usable CLI."""
    with patch.object(
        registry._PROVIDERS["claude"], "is_available", return_value=False
    ), patch.object(
        registry._PROVIDERS["gemini"], "is_available", return_value=False
    ), patch.object(
        registry._PROVIDERS["openai"], "is_available", return_value=False
    ):
        resp = client.get("/api/llm/providers")
    assert resp.status_code == 200
    by_name = {p["name"]: p for p in resp.json()}
    assert set(by_name) == {"claude", "gemini", "openai"}
    for name in ("claude", "gemini", "openai"):
        entry = by_name[name]
        assert "available" in entry
        assert "configured" in entry
        assert "supportsVision" in entry
        assert "requiresKey" in entry
        assert "mode" in entry
        # Model/effort selection contract the Settings panel builds on.
        assert isinstance(entry["supportsEffort"], bool)
        assert isinstance(entry["efforts"], list)
        assert isinstance(entry["models"], list)
        assert "defaultModel" in entry


def test_list_providers_carries_effort_ladders_and_catalogs(
    client, tmp_secrets_path
):
    """Each provider advertises its OWN effort ladder — agy stops at
    `high` while Claude and Codex go to `max`. The UI can't share one
    dropdown across providers, and the PUT /config validator rejects
    cross-provider efforts on the strength of these lists."""
    with patch.object(
        registry._PROVIDERS["gemini"], "list_models", new=AsyncMock(return_value=[]),
    ):
        by_name = {p["name"]: p for p in client.get("/api/llm/providers").json()}
    assert by_name["gemini"]["efforts"] == ["low", "medium", "high"]
    assert by_name["claude"]["efforts"] == ["low", "medium", "high", "xhigh", "max"]
    # Static catalogs are always present; agy's live one was stubbed empty
    # here, which is a legal state (UI falls back to a free-text field).
    assert by_name["claude"]["models"]
    assert by_name["openai"]["models"]
    assert by_name["gemini"]["models"] == []


def test_list_providers_survives_a_broken_catalog(client, tmp_secrets_path):
    """A provider whose model listing blows up must not 500 the whole
    Settings panel — the row renders with an empty catalog instead."""
    with patch.object(
        registry._PROVIDERS["gemini"],
        "list_models",
        new=AsyncMock(side_effect=RuntimeError("agy exploded")),
    ):
        resp = client.get("/api/llm/providers")
    assert resp.status_code == 200
    by_name = {p["name"]: p for p in resp.json()}
    assert by_name["gemini"]["models"] == []


# ── GET /api/llm/providers/{name}/models ──────────────────────────────


def test_get_provider_models_returns_catalog(client, tmp_secrets_path):
    fake = [{"id": "gemini-3.8-flash-low", "label": "Gemini 3.8 Flash (Low)"}]
    with patch.object(
        registry._PROVIDERS["gemini"], "list_models", new=AsyncMock(return_value=fake),
    ):
        resp = client.get("/api/llm/providers/gemini/models")
    assert resp.status_code == 200
    assert resp.json() == {"models": fake, "cached": True}


def test_get_provider_models_force_bypasses_cache(client, tmp_secrets_path):
    """`force=true` is the Settings panel's Refresh button — it must
    reach the provider with force=True and report cached=false."""
    lister = AsyncMock(return_value=[])
    with patch.object(registry._PROVIDERS["gemini"], "list_models", new=lister):
        resp = client.get("/api/llm/providers/gemini/models?force=true")
    assert resp.json() == {"models": [], "cached": False}
    assert lister.await_args.kwargs["force"] is True


def test_get_provider_models_unknown_provider_404(client, tmp_secrets_path):
    assert client.get("/api/llm/providers/foobar/models").status_code == 404


def test_list_providers_no_provider_requires_key_by_default(
    client, tmp_secrets_path
):
    """All three shipped providers are CLI-first. OpenAI has an API
    fallback but its `requiresKey=false` means the CLI path is enough on
    its own — no provider forces the user to enter a key."""
    resp = client.get("/api/llm/providers")
    for entry in resp.json():
        assert entry["requiresKey"] is False


def test_list_providers_does_not_leak_api_keys(client, tmp_secrets_path):
    secrets.set_api_key("openai", "sk-leaky-secret-1234567890")
    resp = client.get("/api/llm/providers")
    body = resp.text
    assert "sk-leaky-secret-1234567890" not in body


# ── PUT /api/llm/providers/{name} ─────────────────────────────────────


def test_set_openai_api_key_clear_path(client, tmp_secrets_path):
    """apiKey=null clears a previously-saved OpenAI key — the only
    provider that accepts API keys via this endpoint."""
    secrets.set_api_key("openai", "sk-existing")
    resp = client.put("/api/llm/providers/openai", json={"apiKey": None})
    assert resp.status_code == 200
    assert secrets.get_api_key("openai") is None


def test_set_openai_api_key(client, tmp_secrets_path):
    resp = client.put("/api/llm/providers/openai", json={"apiKey": "sk-new"})
    assert resp.status_code == 200
    assert secrets.get_api_key("openai") == "sk-new"


def test_set_key_for_cli_only_provider_returns_400(client, tmp_secrets_path):
    """Claude doesn't accept API keys — UI shouldn't post here, but backend
    must reject if it does."""
    resp = client.put("/api/llm/providers/claude", json={"apiKey": "xyz"})
    assert resp.status_code == 400
    assert "doesn't accept API keys" in resp.json()["detail"]
    resp = client.put("/api/llm/providers/gemini", json={"apiKey": "xyz"})
    assert resp.status_code == 400


def test_set_key_for_unknown_provider_returns_404(client, tmp_secrets_path):
    resp = client.put("/api/llm/providers/foobar", json={"apiKey": "xyz"})
    assert resp.status_code == 404


def test_setting_key_invalidates_provider_cache(client, tmp_secrets_path):
    """After saving a key, the next /providers call must reflect the new
    state immediately — not wait for the 60s availability cache. OpenAI
    is the only provider that accepts API keys; verify its cache is
    reset on key save."""
    openai = registry._PROVIDERS["openai"]
    openai._cli_available = True  # type: ignore[attr-defined]
    resp = client.put("/api/llm/providers/openai", json={"apiKey": "sk-1"})
    assert resp.status_code == 200
    # reset_cache() flips _cli_available back to False so the next probe
    # re-runs the CLI version check.
    assert openai._cli_available is False  # type: ignore[attr-defined]


# ── POST /api/llm/providers/{name}/test ───────────────────────────────


def test_test_endpoint_reports_success_with_latency(client, tmp_secrets_path):
    """Provider is_available returns True + run() succeeds → ok + latencyMs."""
    openai = registry._PROVIDERS["openai"]
    with patch.object(openai, "is_available", return_value=True), \
         patch.object(openai, "run", return_value="ok"):
        resp = client.post("/api/llm/providers/openai/test")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert isinstance(body["latencyMs"], int)
    assert body["latencyMs"] >= 0


def test_test_endpoint_returns_unconfigured_message(client, tmp_secrets_path):
    """is_available False → ok: false with a friendly message, NOT a 500."""
    openai = registry._PROVIDERS["openai"]
    with patch.object(openai, "is_available", return_value=False):
        resp = client.post("/api/llm/providers/openai/test")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"ok": False, "error": "provider not configured"}


def test_test_endpoint_surfaces_llm_error(client, tmp_secrets_path):
    from flowboard.services.llm.base import LLMError

    openai = registry._PROVIDERS["openai"]
    with patch.object(openai, "is_available", return_value=True), \
         patch.object(openai, "run", side_effect=LLMError("HTTP 401: invalid key")):
        resp = client.post("/api/llm/providers/openai/test")
    body = resp.json()
    assert body["ok"] is False
    assert "401" in body["error"]


def test_test_endpoint_wraps_unexpected_exceptions(client, tmp_secrets_path):
    """Anything non-LLMError must still come out as ok:false, not 500."""
    openai = registry._PROVIDERS["openai"]
    with patch.object(openai, "is_available", return_value=True), \
         patch.object(openai, "run", side_effect=RuntimeError("kaboom")):
        resp = client.post("/api/llm/providers/openai/test")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "RuntimeError" in body["error"]


def test_test_endpoint_unknown_provider_404(client, tmp_secrets_path):
    resp = client.post("/api/llm/providers/foobar/test")
    assert resp.status_code == 404


def test_test_endpoint_uses_supplied_model_and_effort(client, tmp_secrets_path):
    """Test must exercise the pair the user is looking at, not the
    provider's default — otherwise a green Test tells them nothing about
    the model they're about to save."""
    openai = registry._PROVIDERS["openai"]
    runner = AsyncMock(return_value="ok")
    with patch.object(openai, "is_available", return_value=True), \
         patch.object(openai, "run", new=runner):
        resp = client.post(
            "/api/llm/providers/openai/test",
            json={"model": "gpt-5.6-sol", "effort": "high"},
        )
    assert resp.json()["ok"] is True
    kwargs = runner.await_args.kwargs
    assert kwargs["model"] == "gpt-5.6-sol"
    assert kwargs["effort"] == "high"


def test_test_endpoint_rejects_an_effort_outside_the_providers_ladder(
    client, tmp_secrets_path
):
    """The Test path used to forward model/effort straight to
    `provider.run` while the save path validated both. For Codex that
    lands the value inside `-c model_reasoning_effort="{effort}"` — the
    same `-c` override that configures `sandbox_mode`."""
    openai = registry._PROVIDERS["openai"]
    runner = AsyncMock(return_value="ok")
    with patch.object(openai, "is_available", return_value=True), \
         patch.object(openai, "run", new=runner):
        resp = client.post(
            "/api/llm/providers/openai/test",
            json={"effort": 'high" sandbox_mode="danger-full-access'},
        )
    assert resp.status_code == 400
    assert "unknown effort" in resp.json()["detail"]
    runner.assert_not_awaited()


def test_test_endpoint_rejects_a_model_missing_from_a_live_catalog(
    client, tmp_secrets_path
):
    """Same rule the save path uses — including which catalogs count."""
    gemini = registry._PROVIDERS["gemini"]
    runner = AsyncMock(return_value="ok")
    with patch.object(gemini, "is_available", return_value=True), \
         patch.object(
             gemini, "list_models",
             new=AsyncMock(return_value=[{"id": "gemini-3.8-flash-low", "label": "G"}]),
         ), \
         patch.object(gemini, "run", new=runner):
        resp = client.post(
            "/api/llm/providers/gemini/test", json={"model": "gemini-9-ultra"},
        )
    assert resp.status_code == 400
    assert "unknown model" in resp.json()["detail"]
    runner.assert_not_awaited()


def test_test_endpoint_accepts_a_model_outside_a_static_catalog(
    client, tmp_secrets_path
):
    """Claude's catalog is four aliases. Test must not be stricter about a
    full model name than the CLI it is testing."""
    claude = registry._PROVIDERS["claude"]
    runner = AsyncMock(return_value="ok")
    with patch.object(claude, "is_available", return_value=True), \
         patch.object(claude, "run", new=runner):
        resp = client.post(
            "/api/llm/providers/claude/test", json={"model": "claude-opus-5"},
        )
    assert resp.json()["ok"] is True
    assert runner.await_args.kwargs["model"] == "claude-opus-5"


def test_test_endpoint_body_is_optional(client, tmp_secrets_path):
    """No body → model/effort None, i.e. "don't pass the flags"."""
    openai = registry._PROVIDERS["openai"]
    runner = AsyncMock(return_value="ok")
    with patch.object(openai, "is_available", return_value=True), \
         patch.object(openai, "run", new=runner):
        resp = client.post("/api/llm/providers/openai/test")
    assert resp.json()["ok"] is True
    kwargs = runner.await_args.kwargs
    assert kwargs["model"] is None
    assert kwargs["effort"] is None


# ── GET /api/llm/config ───────────────────────────────────────────────


_EMPTY = {"provider": None, "model": None, "effort": None}


def test_get_config_fresh_install_has_no_providers(client, tmp_secrets_path):
    """No saved config → every feature is an all-null object and
    configured=false. The frontend uses `configured=false` to force-open
    the setup dialog."""
    resp = client.get("/api/llm/config")
    assert resp.status_code == 200
    assert resp.json() == {
        "auto_prompt": _EMPTY,
        "vision": _EMPTY,
        "planner": _EMPTY,
        "configured": False,
    }


def test_get_config_returns_user_picks(client, tmp_secrets_path):
    """Partial picks come back as-is; missing features stay all-null."""
    secrets.set_feature_config("vision", "gemini", "gemini-3.1-pro-high", "high")
    secrets.set_feature_provider("planner", "openai")
    resp = client.get("/api/llm/config")
    assert resp.json() == {
        "auto_prompt": _EMPTY,
        "vision": {
            "provider": "gemini",
            "model": "gemini-3.1-pro-high",
            "effort": "high",
        },
        "planner": {"provider": "openai", "model": None, "effort": None},
        "configured": False,
    }


def test_get_config_configured_when_all_three_pinned(client, tmp_secrets_path):
    secrets.set_feature_provider("auto_prompt", "gemini")
    secrets.set_feature_provider("vision", "gemini")
    secrets.set_feature_provider("planner", "gemini")
    assert client.get("/api/llm/config").json()["configured"] is True


def test_get_config_configured_when_features_use_different_providers(
    client, tmp_secrets_path
):
    """Per-feature selection is the point of this screen — a mixed config
    is a finished setup, not a legacy state to nag the user about. The
    old "all three must match" invariant is gone."""
    secrets.set_feature_provider("auto_prompt", "gemini")
    secrets.set_feature_provider("vision", "claude")
    secrets.set_feature_provider("planner", "openai")
    assert client.get("/api/llm/config").json()["configured"] is True


def test_get_config_reads_legacy_active_providers(client, tmp_secrets_path):
    """Back-compat: a secrets.json written before featureConfig existed
    still answers this endpoint, with model/effort null."""
    secrets.write({
        "activeProviders": {
            "auto_prompt": "claude", "vision": "gemini", "planner": "claude",
        }
    })
    body = client.get("/api/llm/config").json()
    assert body["vision"] == {"provider": "gemini", "model": None, "effort": None}
    assert body["configured"] is True


# ── PUT /api/llm/config ───────────────────────────────────────────────


def test_set_config_single_feature(client, tmp_secrets_path):
    resp = client.put("/api/llm/config", json={"vision": {"provider": "gemini"}})
    assert resp.status_code == 200
    cfg = client.get("/api/llm/config").json()
    assert cfg["vision"]["provider"] == "gemini"
    # Other features stay null until the user picks them — no default.
    assert cfg["auto_prompt"] == _EMPTY
    assert cfg["planner"] == _EMPTY
    assert cfg["configured"] is False


def test_set_config_multiple_features(client, tmp_secrets_path):
    resp = client.put(
        "/api/llm/config",
        json={
            "vision": {"provider": "gemini"},
            "planner": {"provider": "openai"},
            "auto_prompt": {"provider": "claude"},
        },
    )
    assert resp.status_code == 200
    cfg = client.get("/api/llm/config").json()
    assert cfg["auto_prompt"]["provider"] == "claude"
    assert cfg["vision"]["provider"] == "gemini"
    assert cfg["planner"]["provider"] == "openai"
    # Three different providers is a complete setup now.
    assert cfg["configured"] is True


def test_set_config_saves_model_and_effort(client, tmp_secrets_path):
    """The feature this endpoint grew for: a per-feature model + effort
    pair that survives a round-trip."""
    with patch.object(
        registry._PROVIDERS["gemini"],
        "list_models",
        new=AsyncMock(return_value=[
            {"id": "gemini-3.8-flash-low", "label": "Gemini 3.8 Flash (Low)"},
        ]),
    ):
        resp = client.put(
            "/api/llm/config",
            json={"auto_prompt": {
                "provider": "gemini",
                "model": "gemini-3.8-flash-low",
                "effort": "low",
            }},
        )
    assert resp.status_code == 200
    assert client.get("/api/llm/config").json()["auto_prompt"] == {
        "provider": "gemini",
        "model": "gemini-3.8-flash-low",
        "effort": "low",
    }


def test_set_config_patches_effort_without_resending_provider(
    client, tmp_secrets_path
):
    """The UI's effort dropdown PATCHes one field. Omitted fields keep
    their stored value so a partial write can't silently unpin a model."""
    secrets.set_feature_config("planner", "claude", "opus", "low")
    resp = client.put("/api/llm/config", json={"planner": {"effort": "max"}})
    assert resp.status_code == 200
    assert client.get("/api/llm/config").json()["planner"] == {
        "provider": "claude", "model": "opus", "effort": "max",
    }


def test_set_config_explicit_null_clears_a_pinned_model(client, tmp_secrets_path):
    """Sending model: null is how the UI un-pins a model — distinct from
    omitting the field, which preserves it."""
    secrets.set_feature_config("planner", "claude", "opus", "low")
    resp = client.put("/api/llm/config", json={"planner": {"model": None}})
    assert resp.status_code == 200
    cfg = client.get("/api/llm/config").json()["planner"]
    assert cfg == {"provider": "claude", "model": None, "effort": "low"}


def test_set_config_switching_provider_drops_stale_model(client, tmp_secrets_path):
    """A model id is provider-specific. Carrying `gemini-3.8-flash-low`
    over to Claude would fail at dispatch time with a confusing error
    instead of showing an obviously-empty field in Settings."""
    secrets.set_feature_config("vision", "gemini", "gemini-3.8-flash-low", "low")
    resp = client.put("/api/llm/config", json={"vision": {"provider": "claude"}})
    assert resp.status_code == 200
    assert client.get("/api/llm/config").json()["vision"] == {
        "provider": "claude", "model": None, "effort": None,
    }


def test_set_config_rejects_unknown_provider(client, tmp_secrets_path):
    resp = client.put("/api/llm/config", json={"vision": {"provider": "claud3"}})
    assert resp.status_code == 400
    assert "unknown provider" in resp.json()["detail"]


def test_set_config_rejects_unknown_feature(client, tmp_secrets_path):
    """A typo like `auto_promt` must say so rather than returning 200
    having saved nothing."""
    resp = client.put(
        "/api/llm/config", json={"auto_promt": {"provider": "claude"}}
    )
    assert resp.status_code == 400
    assert "unknown feature" in resp.json()["detail"]


def test_set_config_rejects_effort_outside_the_providers_ladder(
    client, tmp_secrets_path
):
    """agy tops out at `high`. A stale frontend reusing Claude's ladder
    would otherwise write `xhigh` into a gemini pin and only find out at
    dispatch time."""
    resp = client.put(
        "/api/llm/config",
        json={"vision": {"provider": "gemini", "effort": "xhigh"}},
    )
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "unknown effort" in detail
    assert "low, medium, high" in detail


def test_set_config_accepts_effort_inside_the_providers_ladder(
    client, tmp_secrets_path
):
    """Same value, different provider — `xhigh` is legal for Claude."""
    resp = client.put(
        "/api/llm/config",
        json={"planner": {"provider": "claude", "effort": "xhigh"}},
    )
    assert resp.status_code == 200
    assert client.get("/api/llm/config").json()["planner"]["effort"] == "xhigh"


def test_set_config_rejects_model_missing_from_a_known_catalog(
    client, tmp_secrets_path
):
    """When we DO have a catalog, an id that isn't in it is an
    unambiguous typo and worth a clear 400."""
    with patch.object(
        registry._PROVIDERS["gemini"],
        "list_models",
        new=AsyncMock(return_value=[
            {"id": "gemini-3.8-flash-low", "label": "Gemini 3.8 Flash (Low)"},
        ]),
    ):
        resp = client.put(
            "/api/llm/config",
            json={"vision": {"provider": "gemini", "model": "gemini-9-ultra"}},
        )
    assert resp.status_code == 400
    assert "unknown model" in resp.json()["detail"]


def test_set_config_accepts_a_full_model_name_for_claude(client, tmp_secrets_path):
    """`claude --help` takes an alias OR a full model name, and
    `claude.py` says so in prose. The catalog here is four hand-written
    aliases — a hint for the dropdown, not an enumeration of what the
    account can reach — so enforcing membership against it returned a 400
    for `claude-opus-5`, a model that works."""
    resp = client.put(
        "/api/llm/config",
        json={"planner": {"provider": "claude", "model": "claude-opus-5"}},
    )
    assert resp.status_code == 200
    assert client.get("/api/llm/config").json()["planner"]["model"] == "claude-opus-5"


def test_set_config_accepts_an_unlisted_codex_model(client, tmp_secrets_path):
    """Codex's catalog is five slugs read by hand off one pinned build's
    model cache. A user on a different build has models it never heard
    of, and no way to enumerate them (`codex models` needs a terminal)."""
    resp = client.put(
        "/api/llm/config",
        json={"auto_prompt": {"provider": "openai", "model": "gpt-6-nova"}},
    )
    assert resp.status_code == 200
    assert client.get("/api/llm/config").json()["auto_prompt"]["model"] == "gpt-6-nova"


def test_set_config_still_rejects_a_typo_against_the_live_catalog(
    client, tmp_secrets_path
):
    """Loosening the static catalogs must not loosen agy's. `agy models`
    asks the backend what this account can reach, so a miss really is a
    typo."""
    with patch.object(
        registry._PROVIDERS["gemini"],
        "list_models",
        new=AsyncMock(return_value=[{"id": "gemini-3.8-flash-low", "label": "G"}]),
    ):
        resp = client.put(
            "/api/llm/config",
            json={"vision": {"provider": "gemini", "model": "gemini-3.8-flsah-low"}},
        )
    assert resp.status_code == 400


def test_set_config_accepts_any_model_when_catalog_is_empty(
    client, tmp_secrets_path
):
    """An empty catalog means "we couldn't enumerate", not "no models
    exist" — rejecting against a list we don't have would lock the user
    out whenever `agy models` is briefly unreachable."""
    with patch.object(
        registry._PROVIDERS["gemini"], "list_models", new=AsyncMock(return_value=[]),
    ):
        resp = client.put(
            "/api/llm/config",
            json={"vision": {"provider": "gemini", "model": "brand-new-model"}},
        )
    assert resp.status_code == 200
    assert client.get("/api/llm/config").json()["vision"]["model"] == "brand-new-model"


def test_set_config_rejects_model_or_effort_without_any_provider(
    client, tmp_secrets_path
):
    """Nothing stored and no provider sent — there's no ladder to
    validate the effort against, so say so instead of guessing."""
    resp = client.put("/api/llm/config", json={"planner": {"effort": "low"}})
    assert resp.status_code == 400
    assert "no provider set" in resp.json()["detail"]


def test_set_config_writes_nothing_when_one_feature_is_invalid(
    client, tmp_secrets_path
):
    """All-or-nothing: a bad third entry must not leave the first two
    half-applied, or the user ends up with a config they never asked for."""
    resp = client.put(
        "/api/llm/config",
        json={
            "auto_prompt": {"provider": "claude"},
            "vision": {"provider": "nope"},
        },
    )
    assert resp.status_code == 400
    assert client.get("/api/llm/config").json()["auto_prompt"] == _EMPTY


def test_set_config_empty_body_returns_400(client, tmp_secrets_path):
    resp = client.put("/api/llm/config", json={})
    assert resp.status_code == 400


def test_set_config_does_not_validate_provider_availability(
    client, tmp_secrets_path
):
    """User can pre-pin a provider before completing setup. Dispatch path
    surfaces the gap when it's actually invoked. OpenAI without a key
    or CLI is unavailable but pinning is still allowed at this layer."""
    resp = client.put("/api/llm/config", json={"vision": {"provider": "openai"}})
    assert resp.status_code == 200
    assert client.get("/api/llm/config").json()["vision"]["provider"] == "openai"
