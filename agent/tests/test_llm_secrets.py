"""Tests for the LLM secret-storage module.

Covers: file roundtrip, mode 0o600 enforcement, atomic writes, missing-file
empty-dict fallback, corruption recovery, defaults overlay for active
providers, key clearing.
"""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from flowboard.services.llm import secrets


@pytest.fixture
def tmp_secrets_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the secrets module at a tmp file. Each test gets a fresh path
    so module-level state can't bleed across tests (the module reads
    FLOWBOARD_SECRETS_PATH on every call — no cached resolution)."""
    p = tmp_path / "secrets.json"
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(p))
    return p


def test_read_returns_empty_when_file_missing(tmp_secrets_path: Path):
    assert not tmp_secrets_path.exists()
    assert secrets.read() == {}


def test_read_returns_empty_on_corrupt_file(tmp_secrets_path: Path):
    """Corrupt JSON must not crash the agent — return empty dict so
    callers' .get(...) chains still work."""
    tmp_secrets_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_secrets_path.write_text("{not json")
    assert secrets.read() == {}


def test_write_creates_parent_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """First-time setup — ~/.flowboard/ doesn't exist yet."""
    nested = tmp_path / "nested" / "subdir" / "secrets.json"
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(nested))
    secrets.write({"apiKeys": {"openai": "sk-1"}})
    assert nested.exists()
    assert json.loads(nested.read_text()) == {"apiKeys": {"openai": "sk-1"}}


def test_write_sets_mode_0600(tmp_secrets_path: Path):
    """Critical — file must not be group/world readable. API keys live here."""
    secrets.write({"apiKeys": {"grok": "xai-secret"}})
    mode = stat.S_IMODE(os.stat(tmp_secrets_path).st_mode)
    assert mode == 0o600, f"expected 0o600 got {oct(mode)}"


def test_write_is_atomic_no_tmp_leftover(tmp_secrets_path: Path):
    """The temp file used for atomic-replace must not linger after success."""
    secrets.write({"apiKeys": {"openai": "sk-x"}})
    tmp = tmp_secrets_path.with_suffix(tmp_secrets_path.suffix + ".tmp")
    assert not tmp.exists()


def test_get_api_key_roundtrip(tmp_secrets_path: Path):
    secrets.set_api_key("openai", "sk-roundtrip")
    assert secrets.get_api_key("openai") == "sk-roundtrip"


def test_get_api_key_returns_none_when_missing(tmp_secrets_path: Path):
    assert secrets.get_api_key("openai") is None
    secrets.set_api_key("grok", "xai-1")
    assert secrets.get_api_key("openai") is None  # other provider isn't set


def test_get_api_key_returns_none_for_empty_string(tmp_secrets_path: Path):
    """Defensive — if a write somehow stored an empty string, treat as unset."""
    secrets.write({"apiKeys": {"openai": ""}})
    assert secrets.get_api_key("openai") is None


def test_set_api_key_clears_with_none(tmp_secrets_path: Path):
    """Clearing removes the entry entirely — not just empty-string."""
    secrets.set_api_key("openai", "sk-1")
    assert secrets.get_api_key("openai") == "sk-1"
    secrets.set_api_key("openai", None)
    assert secrets.get_api_key("openai") is None
    # Verify the entry is actually gone, not just shadowed
    doc = json.loads(tmp_secrets_path.read_text())
    assert "openai" not in (doc.get("apiKeys") or {})


def test_set_api_key_does_not_touch_other_providers(tmp_secrets_path: Path):
    """Editing one key must leave others alone — basic but worth a regression."""
    secrets.set_api_key("openai", "sk-1")
    secrets.set_api_key("grok", "xai-1")
    secrets.set_api_key("openai", "sk-2")
    assert secrets.get_api_key("grok") == "xai-1"
    assert secrets.get_api_key("openai") == "sk-2"


def test_set_api_key_preserves_active_providers(tmp_secrets_path: Path):
    """Saving a key shouldn't wipe the user's feature routing."""
    secrets.set_feature_provider("vision", "gemini")
    secrets.set_api_key("grok", "xai-key")
    assert secrets.read_active_providers()["vision"] == "gemini"


def test_read_active_providers_defaults_to_claude(tmp_secrets_path: Path):
    """Brand-new install — every feature defaults to claude."""
    cfg = secrets.read_active_providers()
    assert cfg == {
        "auto_prompt": "claude",
        "vision": "claude",
        "planner": "claude",
    }


def test_read_active_providers_overlays_defaults(tmp_secrets_path: Path):
    """User picks Gemini for Vision; the other two stay at claude defaults."""
    secrets.set_feature_provider("vision", "gemini")
    cfg = secrets.read_active_providers()
    assert cfg["vision"] == "gemini"
    assert cfg["auto_prompt"] == "claude"
    assert cfg["planner"] == "claude"


def test_read_active_providers_ignores_garbage_values(tmp_secrets_path: Path):
    """Defensive — a hand-edited secrets.json with non-string values for a
    feature must not crash; fall back to the claude default for that slot."""
    secrets.write({
        "activeProviders": {
            "auto_prompt": "gemini",
            "vision": 42,        # bad — non-string
            "planner": None,     # bad — non-string
        }
    })
    cfg = secrets.read_active_providers()
    assert cfg["auto_prompt"] == "gemini"
    assert cfg["vision"] == "claude"
    assert cfg["planner"] == "claude"


def test_set_feature_provider_does_not_touch_api_keys(tmp_secrets_path: Path):
    """Switching a feature's provider shouldn't wipe configured API keys."""
    secrets.set_api_key("openai", "sk-keep")
    secrets.set_feature_provider("planner", "openai")
    assert secrets.get_api_key("openai") == "sk-keep"


def test_write_then_read_preserves_full_document(tmp_secrets_path: Path):
    """End-to-end: a populated document survives a write + read cycle."""
    secrets.set_api_key("openai", "sk-1")
    secrets.set_api_key("grok", "xai-1")
    secrets.set_feature_provider("auto_prompt", "gemini")
    secrets.set_feature_provider("vision", "openai")

    raw = json.loads(tmp_secrets_path.read_text())
    assert raw["apiKeys"] == {"openai": "sk-1", "grok": "xai-1"}
    assert raw["activeProviders"]["auto_prompt"] == "gemini"
    assert raw["activeProviders"]["vision"] == "openai"
