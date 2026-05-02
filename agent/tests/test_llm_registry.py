"""Tests for the LLM registry — feature routing, vision-capability gate,
availability gate, and the default provider fallback.

The registry is the only thing that knows concrete provider classes; every
test here uses fake providers injected into ``_PROVIDERS`` so we never
touch a real CLI / network.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional
from unittest.mock import patch

import pytest

from flowboard.services.llm import registry, secrets
from flowboard.services.llm.base import LLMError


@pytest.fixture
def tmp_secrets_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolated secrets file per test."""
    p = tmp_path / "secrets.json"
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(p))
    return p


class _FakeProvider:
    """Mockable provider — captures calls and returns canned answers."""

    def __init__(
        self,
        name: str,
        *,
        supports_vision: bool = True,
        available: bool = True,
        run_result: str = "ok",
    ):
        self.name = name
        self.supports_vision = supports_vision
        self._available = available
        self._run_result = run_result
        self.run_calls: list[dict] = []

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: Optional[str] = None,
        attachments: Optional[list[str]] = None,
        timeout: float = 90.0,
    ) -> str:
        self.run_calls.append({
            "user_prompt": user_prompt,
            "system_prompt": system_prompt,
            "attachments": attachments,
            "timeout": timeout,
        })
        return self._run_result

    async def is_available(self) -> bool:
        return self._available


@pytest.fixture
def fake_providers(monkeypatch: pytest.MonkeyPatch):
    """Replace the real registry with controllable fakes."""
    fakes = {
        "claude": _FakeProvider("claude", supports_vision=True, available=True),
        "gemini": _FakeProvider("gemini", supports_vision=True, available=True),
        "openai": _FakeProvider("openai", supports_vision=True, available=True),
        # Sentinel for vision-gate tests — text-only future provider.
        "textonly": _FakeProvider("textonly", supports_vision=False, available=True),
    }
    monkeypatch.setattr(registry, "_PROVIDERS", fakes)
    return fakes


# ── No-default semantics ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_unconfigured_feature_raises_loud(tmp_secrets_path, fake_providers):
    """Brand-new install: secrets.json doesn't exist → no provider
    configured → registry must raise LLMError so the user sees a clear
    "open AI Provider settings" message instead of silently routing to
    a provider they didn't pick. The forced-setup dialog in the UI
    intercepts before this dispatch path actually runs in practice."""
    from flowboard.services.llm.base import LLMError

    with pytest.raises(LLMError, match="No AI provider configured"):
        await registry.run_llm("auto_prompt", "hi")
    # No provider was invoked.
    for fake in fake_providers.values():
        assert fake.run_calls == []


@pytest.mark.asyncio
async def test_user_picked_provider_is_used(tmp_secrets_path, fake_providers):
    """User pinned vision to gemini → that's where vision dispatches go."""
    secrets.set_feature_provider("vision", "gemini")
    await registry.run_llm("vision", "describe", attachments=["/tmp/x.jpg"])
    assert len(fake_providers["gemini"].run_calls) == 1
    assert fake_providers["claude"].run_calls == []


@pytest.mark.asyncio
async def test_features_route_independently(tmp_secrets_path, fake_providers):
    """Auto-Prompt = gemini, Vision = openai, Planner = claude — verifies
    each feature looks up its own provider rather than sharing one."""
    secrets.set_feature_provider("auto_prompt", "gemini")
    secrets.set_feature_provider("vision", "openai")
    secrets.set_feature_provider("planner", "claude")
    await registry.run_llm("auto_prompt", "p1")
    await registry.run_llm("vision", "p2", attachments=["/tmp/x.jpg"])
    await registry.run_llm("planner", "p3")
    assert len(fake_providers["gemini"].run_calls) == 1
    assert len(fake_providers["openai"].run_calls) == 1
    assert len(fake_providers["claude"].run_calls) == 1


# ── Vision-capability gate ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_vision_attachment_to_text_only_provider_raises(
    tmp_secrets_path, fake_providers
):
    """Defense in depth — registry must reject a vision call routed to a
    text-only provider BEFORE invoking it. The frontend disables this in
    the dropdown, but a stale-frontend or direct API caller could bypass."""
    secrets.set_feature_provider("vision", "textonly")
    with pytest.raises(LLMError, match="doesn't support vision"):
        await registry.run_llm("vision", "describe", attachments=["/tmp/x.jpg"])
    # Critical: provider.run() must NOT have been invoked.
    assert fake_providers["textonly"].run_calls == []


@pytest.mark.asyncio
async def test_no_attachments_through_text_only_provider_works(
    tmp_secrets_path, fake_providers
):
    """Vision gate fires only when attachments are present. Text-only
    providers can still serve auto_prompt + planner just fine."""
    secrets.set_feature_provider("auto_prompt", "textonly")
    out = await registry.run_llm("auto_prompt", "text-only call")
    assert out == "ok"
    assert len(fake_providers["textonly"].run_calls) == 1


# ── Availability gate ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_unavailable_provider_raises_before_dispatch(
    tmp_secrets_path, fake_providers
):
    """User picked openai but no key/CLI → fail fast with a clear
    error pointing them to Settings, NOT a longer HTTP timeout."""
    fake_providers["openai"]._available = False
    secrets.set_feature_provider("planner", "openai")
    with pytest.raises(LLMError, match="not configured"):
        await registry.run_llm("planner", "x")
    assert fake_providers["openai"].run_calls == []


# ── Unknown provider name ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_unknown_provider_raises(tmp_secrets_path, fake_providers):
    """Hand-edited secrets.json with a typo → registry surfaces the typo
    in the error so the user can find + fix it."""
    secrets.write({"activeProviders": {"auto_prompt": "claud3"}})
    with pytest.raises(LLMError, match="Unknown provider 'claud3'"):
        await registry.run_llm("auto_prompt", "x")


# ── Argument forwarding ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_run_forwards_all_kwargs(tmp_secrets_path, fake_providers):
    """system_prompt + attachments + timeout all reach the provider."""
    secrets.set_feature_provider("auto_prompt", "claude")
    await registry.run_llm(
        "auto_prompt",
        "user prompt",
        system_prompt="be terse",
        attachments=["/tmp/a.jpg", "/tmp/b.jpg"],
        timeout=42.0,
    )
    call = fake_providers["claude"].run_calls[0]
    assert call["user_prompt"] == "user prompt"
    assert call["system_prompt"] == "be terse"
    assert call["attachments"] == ["/tmp/a.jpg", "/tmp/b.jpg"]
    assert call["timeout"] == 42.0


# ── Real ClaudeProvider smoke (no actual subprocess) ───────────────────

@pytest.mark.asyncio
async def test_real_claude_provider_wraps_cli_error_as_llm_error():
    """Contract: caller doing `except LLMError:` must catch every Claude
    failure mode. The provider translates `ClaudeCliError` → `LLMError`
    so callers never have to import claude_cli to handle errors. Without
    the wrap, every Claude timeout / non-zero exit / bad envelope would
    leak through as the wrong exception type."""
    from flowboard.services import claude_cli
    from flowboard.services.llm.claude import ClaudeProvider

    p = ClaudeProvider()
    with patch(
        "flowboard.services.claude_cli.run_claude",
        side_effect=claude_cli.ClaudeCliError("subprocess timeout"),
    ):
        with pytest.raises(LLMError, match="subprocess timeout"):
            await p.run("hello")
    # Cause chain preserved for diagnostics — the original ClaudeCliError
    # is still reachable via __cause__ if a logger / debugger wants it.


@pytest.mark.asyncio
async def test_real_claude_provider_delegates_to_claude_cli():
    """Sanity check that ClaudeProvider actually wires through to
    claude_cli.run_claude — caught early if the function signature drifts.
    Uses patches, never spawns a real claude binary."""
    from flowboard.services.llm.claude import ClaudeProvider

    p = ClaudeProvider()
    assert p.name == "claude"
    assert p.supports_vision is True

    with patch(
        "flowboard.services.claude_cli.run_claude",
        return_value="mocked-result",
    ) as mock_run, patch(
        "flowboard.services.claude_cli.is_available",
        return_value=True,
    ):
        out = await p.run("hello", system_prompt="s", attachments=["/x.jpg"], timeout=5.0)
    assert out == "mocked-result"
    mock_run.assert_called_once()
    kwargs = mock_run.call_args.kwargs
    assert kwargs["system_prompt"] == "s"
    assert kwargs["attachments"] == ["/x.jpg"]
    assert kwargs["timeout"] == 5.0
