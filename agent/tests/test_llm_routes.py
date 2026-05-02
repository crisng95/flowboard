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


# ── GET /api/llm/config ───────────────────────────────────────────────


def test_get_config_fresh_install_has_no_providers(client, tmp_secrets_path):
    """No saved config → every feature is null and configured=false. The
    frontend uses `configured=false` to force-open the setup dialog."""
    resp = client.get("/api/llm/config")
    assert resp.status_code == 200
    assert resp.json() == {
        "auto_prompt": None,
        "vision": None,
        "planner": None,
        "configured": False,
    }


def test_get_config_returns_user_picks(client, tmp_secrets_path):
    """Partial picks come back as-is; missing features stay null. Mixed
    state (different providers per feature) keeps configured=false."""
    secrets.set_feature_provider("vision", "gemini")
    secrets.set_feature_provider("planner", "openai")
    resp = client.get("/api/llm/config")
    assert resp.json() == {
        "auto_prompt": None,
        "vision": "gemini",
        "planner": "openai",
        "configured": False,
    }


def test_get_config_configured_when_all_three_match(client, tmp_secrets_path):
    """Single-provider model: all 3 features → same provider flips
    `configured` to true. This is what the dialog's Apply button writes."""
    secrets.set_feature_provider("auto_prompt", "gemini")
    secrets.set_feature_provider("vision", "gemini")
    secrets.set_feature_provider("planner", "gemini")
    resp = client.get("/api/llm/config")
    assert resp.json()["configured"] is True


def test_get_config_not_configured_when_one_feature_diverges(
    client, tmp_secrets_path
):
    """Mixed config (legacy/hand-edited) → configured=false even though
    every feature is set; UI prompts the user to consolidate."""
    secrets.set_feature_provider("auto_prompt", "gemini")
    secrets.set_feature_provider("vision", "claude")
    secrets.set_feature_provider("planner", "gemini")
    resp = client.get("/api/llm/config")
    assert resp.json()["configured"] is False


# ── PUT /api/llm/config ───────────────────────────────────────────────


def test_set_config_single_feature(client, tmp_secrets_path):
    resp = client.put("/api/llm/config", json={"vision": "gemini"})
    assert resp.status_code == 200
    cfg = client.get("/api/llm/config").json()
    assert cfg["vision"] == "gemini"
    # Other features stay null until the user picks them — no default.
    assert cfg["auto_prompt"] is None
    assert cfg["planner"] is None
    assert cfg["configured"] is False


def test_set_config_multiple_features(client, tmp_secrets_path):
    resp = client.put(
        "/api/llm/config",
        json={"vision": "gemini", "planner": "openai", "auto_prompt": "claude"},
    )
    assert resp.status_code == 200
    cfg = client.get("/api/llm/config").json()
    assert cfg == {
        "auto_prompt": "claude",
        "vision": "gemini",
        "planner": "openai",
        "configured": False,  # 3 different providers, not single-provider
    }


def test_set_config_rejects_unknown_provider(client, tmp_secrets_path):
    resp = client.put("/api/llm/config", json={"vision": "claud3"})
    assert resp.status_code == 400
    assert "unknown provider" in resp.json()["detail"]


def test_set_config_rejects_unknown_feature(client, tmp_secrets_path):
    """Pydantic models reject unknown fields, but defense in depth — a typo
    like `auto_promt` (missing letter) becomes a no-op rather than picking
    up an unintended feature."""
    # The pydantic model only declares the 3 valid features so unknown keys
    # are silently dropped. The empty payload triggers the "no fields"
    # 400 we added.
    resp = client.put("/api/llm/config", json={"auto_promt": "claude"})
    assert resp.status_code == 400
    assert "no fields" in resp.json()["detail"].lower()


def test_set_config_empty_body_returns_400(client, tmp_secrets_path):
    resp = client.put("/api/llm/config", json={})
    assert resp.status_code == 400


def test_set_config_does_not_validate_provider_availability(
    client, tmp_secrets_path
):
    """User can pre-pin a provider before completing setup. Dispatch path
    surfaces the gap when it's actually invoked. OpenAI without a key
    or CLI is unavailable but pinning is still allowed at this layer."""
    resp = client.put("/api/llm/config", json={"vision": "openai"})
    assert resp.status_code == 200
    assert client.get("/api/llm/config").json()["vision"] == "openai"
