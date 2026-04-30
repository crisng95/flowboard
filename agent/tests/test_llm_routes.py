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


def test_list_providers_returns_all_four(client, tmp_secrets_path):
    """All 4 registered providers appear, with expected fields."""
    with patch.object(
        registry._PROVIDERS["claude"], "is_available", return_value=False
    ), patch.object(
        registry._PROVIDERS["gemini"], "is_available", return_value=False
    ), patch.object(
        registry._PROVIDERS["openai"], "is_available", return_value=False
    ), patch.object(
        registry._PROVIDERS["grok"], "is_available", return_value=False
    ):
        resp = client.get("/api/llm/providers")
    assert resp.status_code == 200
    by_name = {p["name"]: p for p in resp.json()}
    assert set(by_name) == {"claude", "gemini", "openai", "grok"}
    for name in ("claude", "gemini", "openai", "grok"):
        entry = by_name[name]
        assert "available" in entry
        assert "configured" in entry
        assert "supportsVision" in entry
        assert "requiresKey" in entry
        assert "mode" in entry


def test_list_providers_marks_grok_as_requires_key(client, tmp_secrets_path):
    with patch.object(
        registry._PROVIDERS["grok"], "is_available", return_value=False
    ):
        resp = client.get("/api/llm/providers")
    by_name = {p["name"]: p for p in resp.json()}
    assert by_name["grok"]["requiresKey"] is True
    assert by_name["claude"]["requiresKey"] is False
    assert by_name["openai"]["requiresKey"] is False


def test_list_providers_grok_configured_when_key_set(client, tmp_secrets_path):
    """Setting a key flips `configured` to true even if test hasn't run."""
    secrets.set_api_key("grok", "xai-1")
    with patch.object(
        registry._PROVIDERS["grok"], "is_available", return_value=False
    ):
        resp = client.get("/api/llm/providers")
    grok = next(p for p in resp.json() if p["name"] == "grok")
    assert grok["configured"] is True
    # `available` stays False because the cached probe says no.
    assert grok["available"] is False


def test_list_providers_does_not_leak_api_keys(client, tmp_secrets_path):
    secrets.set_api_key("grok", "xai-leaky-secret-1234567890")
    secrets.set_api_key("openai", "sk-leaky-secret-1234567890")
    resp = client.get("/api/llm/providers")
    body = resp.text
    assert "xai-leaky-secret-1234567890" not in body
    assert "sk-leaky-secret-1234567890" not in body


# ── PUT /api/llm/providers/{name} ─────────────────────────────────────


def test_set_grok_api_key(client, tmp_secrets_path):
    resp = client.put("/api/llm/providers/grok", json={"apiKey": "xai-new"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert secrets.get_api_key("grok") == "xai-new"


def test_clear_grok_api_key(client, tmp_secrets_path):
    secrets.set_api_key("grok", "xai-existing")
    resp = client.put("/api/llm/providers/grok", json={"apiKey": None})
    assert resp.status_code == 200
    assert secrets.get_api_key("grok") is None


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
    state immediately — not wait for the 60s availability cache."""
    grok = registry._PROVIDERS["grok"]
    grok._availability_value = False  # type: ignore[attr-defined]
    grok._availability_cached_at = 9e9  # very fresh "false" cache
    resp = client.put("/api/llm/providers/grok", json={"apiKey": "xai-1"})
    assert resp.status_code == 200
    # Cache should be reset (not the value, just the timestamp/value cleared).
    assert grok._availability_value is None  # type: ignore[attr-defined]


# ── POST /api/llm/providers/{name}/test ───────────────────────────────


def test_test_endpoint_reports_success_with_latency(client, tmp_secrets_path):
    """Provider is_available returns True + run() succeeds → ok + latencyMs."""
    grok = registry._PROVIDERS["grok"]
    with patch.object(grok, "is_available", return_value=True), \
         patch.object(grok, "run", return_value="ok"):
        resp = client.post("/api/llm/providers/grok/test")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert isinstance(body["latencyMs"], int)
    assert body["latencyMs"] >= 0


def test_test_endpoint_returns_unconfigured_message(client, tmp_secrets_path):
    """is_available False → ok: false with a friendly message, NOT a 500."""
    grok = registry._PROVIDERS["grok"]
    with patch.object(grok, "is_available", return_value=False):
        resp = client.post("/api/llm/providers/grok/test")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"ok": False, "error": "provider not configured"}


def test_test_endpoint_surfaces_llm_error(client, tmp_secrets_path):
    from flowboard.services.llm.base import LLMError

    grok = registry._PROVIDERS["grok"]
    with patch.object(grok, "is_available", return_value=True), \
         patch.object(grok, "run", side_effect=LLMError("HTTP 401: invalid key")):
        resp = client.post("/api/llm/providers/grok/test")
    body = resp.json()
    assert body["ok"] is False
    assert "401" in body["error"]


def test_test_endpoint_wraps_unexpected_exceptions(client, tmp_secrets_path):
    """Anything non-LLMError must still come out as ok:false, not 500."""
    grok = registry._PROVIDERS["grok"]
    with patch.object(grok, "is_available", return_value=True), \
         patch.object(grok, "run", side_effect=RuntimeError("kaboom")):
        resp = client.post("/api/llm/providers/grok/test")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "RuntimeError" in body["error"]


def test_test_endpoint_unknown_provider_404(client, tmp_secrets_path):
    resp = client.post("/api/llm/providers/foobar/test")
    assert resp.status_code == 404


# ── GET /api/llm/config ───────────────────────────────────────────────


def test_get_config_returns_defaults_for_fresh_install(client, tmp_secrets_path):
    """No saved config → every feature defaults to claude, vision is on."""
    resp = client.get("/api/llm/config")
    assert resp.status_code == 200
    assert resp.json() == {
        "auto_prompt": "claude",
        "vision": "claude",
        "planner": "claude",
        "visionEnabled": True,
    }


def test_get_config_overlays_user_picks(client, tmp_secrets_path):
    secrets.set_feature_provider("vision", "gemini")
    secrets.set_feature_provider("planner", "openai")
    resp = client.get("/api/llm/config")
    assert resp.json() == {
        "auto_prompt": "claude",
        "vision": "gemini",
        "planner": "openai",
        "visionEnabled": True,
    }


def test_get_config_includes_vision_disabled_when_set(client, tmp_secrets_path):
    secrets.set_vision_enabled(False)
    resp = client.get("/api/llm/config")
    assert resp.json()["visionEnabled"] is False


# ── PUT /api/llm/config ───────────────────────────────────────────────


def test_set_config_single_feature(client, tmp_secrets_path):
    resp = client.put("/api/llm/config", json={"vision": "gemini"})
    assert resp.status_code == 200
    cfg = client.get("/api/llm/config").json()
    assert cfg["vision"] == "gemini"
    # Other features stay at defaults.
    assert cfg["auto_prompt"] == "claude"
    assert cfg["planner"] == "claude"


def test_set_config_multiple_features(client, tmp_secrets_path):
    resp = client.put(
        "/api/llm/config",
        json={"vision": "gemini", "planner": "openai", "auto_prompt": "grok"},
    )
    assert resp.status_code == 200
    cfg = client.get("/api/llm/config").json()
    assert cfg == {
        "auto_prompt": "grok",
        "vision": "gemini",
        "planner": "openai",
        "visionEnabled": True,
    }


def test_set_config_toggles_vision_enabled(client, tmp_secrets_path):
    resp = client.put("/api/llm/config", json={"visionEnabled": False})
    assert resp.status_code == 200
    assert client.get("/api/llm/config").json()["visionEnabled"] is False
    # And back on
    client.put("/api/llm/config", json={"visionEnabled": True})
    assert client.get("/api/llm/config").json()["visionEnabled"] is True


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
    surfaces the gap when it's actually invoked."""
    resp = client.put("/api/llm/config", json={"vision": "grok"})
    # Grok has no key and is unavailable, but pinning it is allowed.
    assert resp.status_code == 200
    assert client.get("/api/llm/config").json()["vision"] == "grok"
