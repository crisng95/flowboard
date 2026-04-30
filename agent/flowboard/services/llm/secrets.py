"""Local secret storage for the multi-LLM provider layer.

Schema of ``~/.flowboard/secrets.json``:

```json
{
  "apiKeys": {"openai": "sk-...", "grok": "xai-..."},
  "activeProviders": {
    "auto_prompt": "claude",
    "vision": "gemini",
    "planner": "claude"
  },
  "visionEnabled": true
}
```

Stored as plain JSON with file mode ``0o600`` (owner read/write only).
Single-user local app — OS-level file permissions are sufficient. We
deliberately don't encrypt; encryption adds a key-management surface
area without real benefit when the only attacker that matters has
already won (root on this user's box).

Writes are atomic (`tmp + replace`) so a crash mid-write can't corrupt
the file — readers either see the old contents or the new contents,
never a half-written file.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


_DEFAULT_PATH = Path.home() / ".flowboard" / "secrets.json"


def _path() -> Path:
    """Indirection so tests can monkeypatch the location.

    Tests typically set ``FLOWBOARD_SECRETS_PATH`` to a tmp file. Production
    callers leave the env var unset and the default ``~/.flowboard/secrets.json``
    applies.
    """
    override = os.environ.get("FLOWBOARD_SECRETS_PATH")
    return Path(override) if override else _DEFAULT_PATH


def read() -> dict:
    """Load the full secrets document. Empty dict if file doesn't exist
    or is corrupt — callers must handle missing keys themselves."""
    p = _path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("secrets: file unreadable, treating as empty (%s)", exc)
        return {}


def write(payload: dict) -> None:
    """Atomic write with mode 0o600. Creates parent dir if needed."""
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2))
    # chmod BEFORE replace so the final file is never group/world-readable
    # even momentarily on filesystems that preserve permissions on rename.
    os.chmod(tmp, 0o600)
    tmp.replace(p)


# ── API key helpers ────────────────────────────────────────────────────

def get_api_key(provider: str) -> Optional[str]:
    """None if the key is unset OR if the file doesn't exist."""
    doc = read()
    keys = doc.get("apiKeys") or {}
    val = keys.get(provider)
    return val if isinstance(val, str) and val else None


def set_api_key(provider: str, key: Optional[str]) -> None:
    """Set or clear (key=None) a provider's API key.

    Clearing removes the entry entirely so ``get_api_key`` returns None
    cleanly without falsy-empty-string ambiguity.
    """
    doc = read()
    keys = dict(doc.get("apiKeys") or {})
    if key is None or not key:
        keys.pop(provider, None)
    else:
        keys[provider] = key
    doc["apiKeys"] = keys
    write(doc)


# ── Active-providers helpers ───────────────────────────────────────────

# Default routing — used when the user hasn't configured anything yet.
# Claude is the historical default for all three features.
_DEFAULT_ACTIVE: dict[str, str] = {
    "auto_prompt": "claude",
    "vision": "claude",
    "planner": "claude",
}


def read_active_providers() -> dict[str, str]:
    """Return ``{feature: provider_name}`` with defaults filled in for any
    feature the user hasn't picked yet."""
    doc = read()
    saved = doc.get("activeProviders") or {}
    if not isinstance(saved, dict):
        saved = {}
    return {**_DEFAULT_ACTIVE, **{k: v for k, v in saved.items() if isinstance(v, str)}}


def set_feature_provider(feature: str, provider: str) -> None:
    """Pin one feature to one provider. Caller validates names."""
    doc = read()
    saved = dict(doc.get("activeProviders") or {})
    saved[feature] = provider
    doc["activeProviders"] = saved
    write(doc)


# ── Vision toggle ──────────────────────────────────────────────────────

# When False, the auto-prompt synthesiser falls back to each upstream
# node's typed `prompt` instead of its vision-derived `aiBrief`. The
# upload-triggered vision call is unaffected (the user explicitly
# uploaded an image, so describing it is intentional). Default True
# preserves existing behaviour for users who don't open the toggle.

def read_vision_enabled() -> bool:
    """True when vision-derived briefs should be used by the synth flow."""
    doc = read()
    val = doc.get("visionEnabled")
    # Treat any non-False explicit setting (including missing) as enabled.
    return val is not False


def set_vision_enabled(enabled: bool) -> None:
    doc = read()
    doc["visionEnabled"] = bool(enabled)
    write(doc)
