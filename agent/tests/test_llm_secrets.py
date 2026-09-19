"""Tests for the LLM secret-storage module.

Covers: file roundtrip, mode 0o600 enforcement, atomic writes, missing-file
empty-dict fallback, corruption recovery, defaults overlay for active
providers, key clearing, and the per-feature ``featureConfig`` block
(provider + model + effort) with its ``activeProviders`` back-compat
fallback in both directions.
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
    secrets.write({"apiKeys": {"openai": "sk-secret"}})
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
    """Missing key → None. Other providers' keys don't bleed through."""
    assert secrets.get_api_key("openai") is None
    # Intentionally use a non-shipped name to verify isolation — the
    # secrets layer doesn't validate keys against the registry.
    secrets.set_api_key("custom", "x-1")
    assert secrets.get_api_key("openai") is None


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
    """Editing one key must leave others alone — basic but worth a
    regression. Uses an unknown provider name as the "other" key to
    verify the secrets layer is provider-agnostic at this level."""
    secrets.set_api_key("openai", "sk-1")
    secrets.set_api_key("custom", "x-1")
    secrets.set_api_key("openai", "sk-2")
    assert secrets.get_api_key("custom") == "x-1"
    assert secrets.get_api_key("openai") == "sk-2"


def test_set_api_key_preserves_active_providers(tmp_secrets_path: Path):
    """Saving a key shouldn't wipe the user's feature routing."""
    secrets.set_feature_provider("vision", "gemini")
    secrets.set_api_key("openai", "sk-key")
    assert secrets.read_active_providers()["vision"] == "gemini"


def test_read_active_providers_empty_for_fresh_install(tmp_secrets_path: Path):
    """Brand-new install — no providers are pinned. Callers (registry,
    HTTP route) must handle missing keys; the forced-setup dialog in the
    UI is what nudges the user to set one up."""
    cfg = secrets.read_active_providers()
    assert cfg == {}


def test_read_active_providers_returns_only_saved(tmp_secrets_path: Path):
    """User picks Gemini for Vision; only that key is present. The other
    two features are absent (caller treats absence as "not configured")."""
    secrets.set_feature_provider("vision", "gemini")
    cfg = secrets.read_active_providers()
    assert cfg == {"vision": "gemini"}


def test_read_active_providers_ignores_garbage_values(tmp_secrets_path: Path):
    """Defensive — a hand-edited secrets.json with non-string values for a
    feature must drop the bad entry rather than crash. Missing slots are
    absent (no silent default substitution)."""
    secrets.write({
        "activeProviders": {
            "auto_prompt": "gemini",
            "vision": 42,        # bad — non-string
            "planner": None,     # bad — non-string
        }
    })
    cfg = secrets.read_active_providers()
    assert cfg == {"auto_prompt": "gemini"}


def test_is_active_providers_configured_false_when_empty(tmp_secrets_path: Path):
    assert secrets.is_active_providers_configured() is False


def test_is_active_providers_configured_false_when_partial(tmp_secrets_path: Path):
    secrets.set_feature_provider("vision", "gemini")
    secrets.set_feature_provider("planner", "gemini")
    # auto_prompt unset → not configured.
    assert secrets.is_active_providers_configured() is False


def test_is_active_providers_configured_true_when_mixed(tmp_secrets_path: Path):
    """All 3 set to *different* providers is now a configured install.

    The old single-provider invariant (all three must match) is gone —
    per-feature selection is the whole point of the current settings
    screen, so a mixed config must not keep re-triggering the forced
    setup dialog."""
    secrets.set_feature_provider("auto_prompt", "claude")
    secrets.set_feature_provider("vision", "gemini")
    secrets.set_feature_provider("planner", "openai")
    assert secrets.is_active_providers_configured() is True


def test_is_active_providers_configured_true_when_all_match(tmp_secrets_path: Path):
    """All 3 set to the same provider — this is what the dialog's Apply
    button writes. Setup-complete state."""
    secrets.set_feature_provider("auto_prompt", "gemini")
    secrets.set_feature_provider("vision", "gemini")
    secrets.set_feature_provider("planner", "gemini")
    assert secrets.is_active_providers_configured() is True


def test_set_feature_provider_does_not_touch_api_keys(tmp_secrets_path: Path):
    """Switching a feature's provider shouldn't wipe configured API keys."""
    secrets.set_api_key("openai", "sk-keep")
    secrets.set_feature_provider("planner", "openai")
    assert secrets.get_api_key("openai") == "sk-keep"


def test_write_then_read_preserves_full_document(tmp_secrets_path: Path):
    """End-to-end: a populated document survives a write + read cycle."""
    secrets.set_api_key("openai", "sk-1")
    secrets.set_feature_provider("auto_prompt", "gemini")
    secrets.set_feature_provider("vision", "openai")

    raw = json.loads(tmp_secrets_path.read_text())
    assert raw["apiKeys"] == {"openai": "sk-1"}
    assert raw["activeProviders"]["auto_prompt"] == "gemini"
    assert raw["activeProviders"]["vision"] == "openai"


# ── featureConfig: per-feature provider + model + effort ──────────────


def test_set_feature_config_roundtrips_model_and_effort(tmp_secrets_path: Path):
    """The whole point of featureConfig: a feature remembers WHICH model
    and WHICH reasoning effort, not just which provider."""
    secrets.set_feature_config("auto_prompt", "gemini", "gemini-3.8-flash-low", "low")
    cfg = secrets.read_feature_config()
    assert cfg["auto_prompt"] == {
        "provider": "gemini",
        "model": "gemini-3.8-flash-low",
        "effort": "low",
    }


def test_set_feature_config_features_are_independent(tmp_secrets_path: Path):
    """Three features, three different provider/model/effort triples —
    each round-trips without bleeding into its neighbours."""
    secrets.set_feature_config("auto_prompt", "gemini", "gemini-3.8-flash-low", "low")
    secrets.set_feature_config("vision", "gemini", "gemini-3.1-pro-high", "high")
    secrets.set_feature_config("planner", "claude", "opus", "xhigh")
    cfg = secrets.read_feature_config()
    assert cfg["auto_prompt"]["model"] == "gemini-3.8-flash-low"
    assert cfg["vision"]["effort"] == "high"
    assert cfg["planner"] == {
        "provider": "claude", "model": "opus", "effort": "xhigh",
    }


def test_set_feature_config_model_and_effort_default_to_none(tmp_secrets_path: Path):
    """Provider-only pin leaves model/effort null — which dispatch reads
    as "don't pass the flag" so the CLI's own default applies."""
    secrets.set_feature_config("planner", "claude")
    assert secrets.read_feature_config()["planner"] == {
        "provider": "claude", "model": None, "effort": None,
    }


def test_set_feature_config_writes_both_blocks(tmp_secrets_path: Path):
    """Writes update featureConfig AND the legacy activeProviders map, so
    downgrading to a pre-featureConfig build doesn't brick the install."""
    secrets.set_feature_config("vision", "gemini", "gemini-3.1-pro-high", "high")
    raw = json.loads(tmp_secrets_path.read_text())
    assert raw["featureConfig"]["vision"]["model"] == "gemini-3.1-pro-high"
    assert raw["activeProviders"]["vision"] == "gemini"


def test_set_feature_config_overwrites_previous_entry(tmp_secrets_path: Path):
    """Re-pinning a feature replaces the whole triple rather than merging
    — the HTTP layer owns merge semantics, the store is a plain setter."""
    secrets.set_feature_config("vision", "gemini", "gemini-3.1-pro-high", "high")
    secrets.set_feature_config("vision", "claude")
    assert secrets.read_feature_config()["vision"] == {
        "provider": "claude", "model": None, "effort": None,
    }


def test_read_feature_config_empty_for_fresh_install(tmp_secrets_path: Path):
    assert secrets.read_feature_config() == {}


def test_read_feature_config_falls_back_to_active_providers(tmp_secrets_path: Path):
    """Back-compat: an install that predates featureConfig has only
    activeProviders. Routing must survive the upgrade untouched, with
    model/effort null so every CLI keeps its own default."""
    secrets.write({
        "activeProviders": {
            "auto_prompt": "claude",
            "vision": "gemini",
            "planner": "claude",
        }
    })
    cfg = secrets.read_feature_config()
    assert cfg["auto_prompt"] == {
        "provider": "claude", "model": None, "effort": None,
    }
    assert cfg["vision"]["provider"] == "gemini"
    # And the upgraded install counts as configured, so the forced-setup
    # dialog doesn't reappear after an upgrade.
    assert secrets.is_active_providers_configured() is True


def test_feature_config_wins_over_active_providers(tmp_secrets_path: Path):
    """Both blocks present and disagreeing (e.g. a downgrade wrote the
    legacy block, then the user upgraded again) — featureConfig is the
    authority because it's the richer, newer shape."""
    secrets.write({
        "featureConfig": {
            "vision": {"provider": "claude", "model": "sonnet", "effort": "low"},
        },
        "activeProviders": {"vision": "gemini"},
    })
    cfg = secrets.read_feature_config()
    assert cfg["vision"]["provider"] == "claude"
    assert cfg["vision"]["model"] == "sonnet"


def test_read_feature_config_merges_both_blocks(tmp_secrets_path: Path):
    """A partially-migrated file: one feature in the new block, another
    only in the legacy one. Both must resolve."""
    secrets.write({
        "featureConfig": {
            "vision": {"provider": "gemini", "model": "gemini-3.1-pro-high", "effort": "high"},
        },
        "activeProviders": {"vision": "gemini", "planner": "claude"},
    })
    cfg = secrets.read_feature_config()
    assert cfg["vision"]["effort"] == "high"
    assert cfg["planner"] == {"provider": "claude", "model": None, "effort": None}


def test_read_feature_config_ignores_garbage_values(tmp_secrets_path: Path):
    """Hand-edited file with wrong types in every slot. Bad provider →
    entry dropped entirely; bad model/effort → coerced to null so the
    flag is simply not passed."""
    secrets.write({
        "featureConfig": {
            "auto_prompt": {"provider": "gemini", "model": 42, "effort": None},
            "vision": {"provider": None},      # bad — no provider to route to
            "planner": "claude",                # bad — not an object
        }
    })
    cfg = secrets.read_feature_config()
    assert cfg == {
        "auto_prompt": {"provider": "gemini", "model": None, "effort": None},
    }


def test_read_feature_config_falls_back_per_feature_on_bad_entry(
    tmp_secrets_path: Path
):
    """A featureConfig entry too broken to use falls back to the legacy
    provider for that feature rather than dropping the feature."""
    secrets.write({
        "featureConfig": {"planner": {"model": "opus"}},  # no provider
        "activeProviders": {"planner": "claude"},
    })
    assert secrets.read_feature_config()["planner"] == {
        "provider": "claude", "model": None, "effort": None,
    }


def test_read_active_providers_projects_feature_config(tmp_secrets_path: Path):
    """The provider-only view stays available for callers that don't care
    about model/effort (planner's availability probe, older tests)."""
    secrets.set_feature_config("vision", "gemini", "gemini-3.1-pro-high", "high")
    assert secrets.read_active_providers() == {"vision": "gemini"}


def test_set_feature_config_does_not_touch_api_keys(tmp_secrets_path: Path):
    secrets.set_api_key("openai", "sk-keep")
    secrets.set_feature_config("planner", "openai", "gpt-5.6-sol", "medium")
    assert secrets.get_api_key("openai") == "sk-keep"
