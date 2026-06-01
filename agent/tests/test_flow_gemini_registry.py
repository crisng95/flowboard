"""Registry routing tests for the ``flow_gemini`` provider (spec task 6.5).

Confirms that *configuring* ``flow_gemini`` for a feature routes
``run_llm(feature, ...)`` through ``FlowGeminiProvider.run`` with NO change at
the call site — ``prompt_synth`` still calls ``run_llm("auto_prompt", ...)``
and ``vision`` still calls ``run_llm("vision", ...)``.

Validates: Requirements 6.6, 6.7.

What is mocked and why:
- A real ``FlowGeminiProvider`` instance is placed in ``registry._PROVIDERS``
  (monkeypatched) so we exercise the genuine registered class, not a stand-in.
- Only ``.run`` and ``.is_available`` are replaced with ``AsyncMock``s — ``run``
  to capture the dispatch (the provider's enqueue/poll loop and Control Plane
  are out of scope for a *routing* test), ``is_available`` to pass the registry's
  availability gate without a real Supabase/Control Plane. The provider's
  ``name`` / ``supports_vision`` remain the real values.
- ``secrets`` is pointed at a tmp file so feature→provider config is isolated.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from flowboard.services.llm import registry, secrets
from flowboard.services.llm.flow_gemini import FlowGeminiProvider


@pytest.fixture
def tmp_secrets_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolated secrets file per test (mirrors test_llm_registry.py)."""
    p = tmp_path / "secrets.json"
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(p))
    return p


@pytest.fixture
def flow_gemini_in_registry(monkeypatch: pytest.MonkeyPatch):
    """Replace the registry with the other providers as fakes plus a real
    ``FlowGeminiProvider`` whose ``run`` / ``is_available`` are mocked."""
    fg = FlowGeminiProvider()
    fg.run = AsyncMock(return_value="flow-gemini-output")  # type: ignore[method-assign]
    fg.is_available = AsyncMock(return_value=True)  # type: ignore[method-assign]

    providers = dict(registry._PROVIDERS)
    providers["flow_gemini"] = fg
    monkeypatch.setattr(registry, "_PROVIDERS", providers)
    return fg


@pytest.mark.asyncio
async def test_auto_prompt_routes_to_flow_gemini(tmp_secrets_path, flow_gemini_in_registry):
    """Req 6.6 — auto_prompt pinned to flow_gemini dispatches there, with the
    unchanged ``run_llm("auto_prompt", ...)`` call site."""
    secrets.set_feature_provider("auto_prompt", "flow_gemini")

    out = await registry.run_llm("auto_prompt", "synthesize a prompt")

    assert out == "flow-gemini-output"
    flow_gemini_in_registry.run.assert_awaited_once()
    assert flow_gemini_in_registry.run.await_args.args[0] == "synthesize a prompt"


@pytest.mark.asyncio
async def test_vision_routes_to_flow_gemini(tmp_secrets_path, flow_gemini_in_registry):
    """Req 6.7 — vision pinned to flow_gemini dispatches there, attachments
    forwarded (supports_vision is True so the vision gate passes), with the
    unchanged ``run_llm("vision", ...)`` call site."""
    secrets.set_feature_provider("vision", "flow_gemini")

    out = await registry.run_llm(
        "vision", "describe this", attachments=["/tmp/a.jpg"]
    )

    assert out == "flow-gemini-output"
    flow_gemini_in_registry.run.assert_awaited_once()
    call = flow_gemini_in_registry.run.await_args
    assert call.args[0] == "describe this"
    assert call.kwargs["attachments"] == ["/tmp/a.jpg"]


@pytest.mark.asyncio
async def test_both_features_route_independently_to_flow_gemini(
    tmp_secrets_path, flow_gemini_in_registry
):
    """Req 6.6 + 6.7 — both auto_prompt and vision can target flow_gemini and
    each dispatch reaches ``FlowGeminiProvider.run``."""
    secrets.set_feature_provider("auto_prompt", "flow_gemini")
    secrets.set_feature_provider("vision", "flow_gemini")

    await registry.run_llm("auto_prompt", "p1")
    await registry.run_llm("vision", "p2", attachments=["/tmp/x.jpg"])

    assert flow_gemini_in_registry.run.await_count == 2
