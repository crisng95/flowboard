"""Tests for services/planner.py — generate_plan_reply + mock fallback.

After the multi-LLM migration the planner routes through
``run_llm("planner", ...)`` and probes the configured Planner provider
for availability. Tests patch:
  - `flowboard.services.planner.run_llm` — bypass dispatch entirely
  - The active provider's `is_available()` — control auto-fallback path

Default Planner provider is Claude (per `secrets.read_active_providers()`
defaults), so the tests grab the Claude singleton from the registry and
patch its `is_available`. Patches use context managers so per-test
isolation is automatic.
"""
import pytest
from unittest.mock import AsyncMock, patch

from flowboard.services import planner
from flowboard.services.llm import registry
from flowboard.services.llm.base import LLMError


@pytest.fixture(autouse=True)
def _isolated_secrets(tmp_path, monkeypatch):
    """Each test reads an isolated secrets file so the developer's real
    ~/.flowboard/secrets.json (with custom planner provider pinned)
    can't bleed into the test's defaults."""
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(tmp_path / "secrets.json"))


# ── Plan extraction (pure parsing — no provider involvement) ──────────────


def test_extract_plan_from_fenced_block():
    raw = (
        "Sure, here's the plan.\n"
        "```json\n"
        '{"nodes":[{"tmp_id":"a","type":"image"}],"edges":[]}\n'
        "```\n"
        "Let me know."
    )
    reply, plan = planner._extract_plan(raw)
    assert plan is not None
    assert plan["nodes"][0]["type"] == "image"
    assert "```" not in reply
    assert "plan" in reply.lower() or "let me know" in reply.lower()


def test_extract_plan_no_block_returns_none():
    reply, plan = planner._extract_plan("just chatting, no plan")
    assert plan is None
    assert reply == "just chatting, no plan"


def test_extract_plan_malformed_json_returns_none():
    raw = "```json\n{not valid json\n```"
    reply, plan = planner._extract_plan(raw)
    assert plan is None
    # Raw text retained
    assert "not valid json" in reply


def test_extract_plan_shape_check_rejects_bad_nodes():
    raw = '```json\n{"nodes": "should be a list"}\n```'
    _, plan = planner._extract_plan(raw)
    assert plan is None


def test_extract_plan_bare_json_without_fence():
    raw = '{"nodes":[{"tmp_id":"a","type":"prompt"}],"edges":[]}'
    reply, plan = planner._extract_plan(raw)
    assert plan is not None
    assert plan["nodes"][0]["type"] == "prompt"
    # Reply is empty when the whole body was JSON.
    assert reply == ""


# ── Real planner dispatcher ────────────────────────────────────────────────


def _board(client, name="T"):
    return client.post("/api/boards", json={"name": name}).json()


def _claude_provider():
    """Resolve the default Planner provider singleton from the registry —
    every test needs it to control the is_available probe."""
    return registry.get_provider("claude")


@pytest.mark.asyncio
async def test_generate_plan_reply_uses_provider_when_available(client):
    """Backend=cli: skip the auto-mode availability check, dispatch
    directly. Provider returns a fenced JSON block, planner extracts the
    plan + conversational text."""
    b = _board(client)
    provider_response = (
        "Creating three variations.\n"
        "```json\n"
        '{"nodes":[{"tmp_id":"img1","type":"image","params":{"prompt":"cat"}}],'
        '"edges":[],"layout_hint":"left_to_right"}\n'
        "```"
    )
    with patch("flowboard.services.planner.PLANNER_BACKEND", "cli"), patch(
        "flowboard.services.planner.run_llm",
        new=AsyncMock(return_value=provider_response),
    ):
        from flowboard.db import get_session

        with get_session() as s:
            out = await planner.generate_plan_reply(
                s, b["id"], "make 3 cats", []
            )
    assert out["plan"] is not None
    assert out["plan"]["nodes"][0]["type"] == "image"
    assert "three variations" in out["reply_text"].lower()


@pytest.mark.asyncio
async def test_generate_plan_reply_falls_back_to_mock_when_provider_unavailable(client):
    """Backend=auto + configured provider not available → short-circuit
    before building prompt context and return mock reply."""
    b = _board(client)
    with patch("flowboard.services.planner.PLANNER_BACKEND", "auto"), \
         patch.object(_claude_provider(), "is_available", return_value=False):
        from flowboard.db import get_session

        with get_session() as s:
            out = await planner.generate_plan_reply(
                s, b["id"], "hello", []
            )
    assert out["plan"] is None
    assert "Planner stub" in out["reply_text"] or "Noted" in out["reply_text"]


@pytest.mark.asyncio
async def test_generate_plan_reply_handles_provider_error_with_mock_fallback(client):
    """Backend=auto + provider available + run_llm raises → fall back to
    mock (auto mode swallows the error). Confirms the registry's `LLMError`
    contract is what the migrated planner catches now."""
    b = _board(client)
    with patch("flowboard.services.planner.PLANNER_BACKEND", "auto"), \
         patch.object(_claude_provider(), "is_available", return_value=True), \
         patch(
             "flowboard.services.planner.run_llm",
             new=AsyncMock(side_effect=LLMError("timeout")),
         ):
        from flowboard.db import get_session

        with get_session() as s:
            out = await planner.generate_plan_reply(
                s, b["id"], "hi", []
            )
    assert out["plan"] is None
    # Mock kicks in, reply_text non-empty.
    assert out["reply_text"]


@pytest.mark.asyncio
async def test_generate_plan_reply_cli_mode_surfaces_error_text(client):
    """Backend=cli + run_llm raises → reply_text shows the error verbatim
    (NOT a silent mock fallback). cli mode is "I want the LLM, tell me when
    it's broken" — so the user knows their config needs attention."""
    b = _board(client)
    with patch("flowboard.services.planner.PLANNER_BACKEND", "cli"), \
         patch(
             "flowboard.services.planner.run_llm",
             new=AsyncMock(side_effect=LLMError("provider died")),
         ):
        from flowboard.db import get_session

        with get_session() as s:
            out = await planner.generate_plan_reply(
                s, b["id"], "hi", []
            )
    assert out["plan"] is None
    assert "provider died" in out["reply_text"]
    assert "(planner unavailable" in out["reply_text"]


@pytest.mark.asyncio
async def test_generate_plan_reply_mock_mode_skips_provider_entirely(client):
    """Backend=mock: every other code path — provider lookup, is_available
    probe, run_llm dispatch — must be skipped. Asserts each mock was
    untouched so a regression that accidentally calls the LLM in mock
    mode (e.g. costing tokens in CI) gets caught."""
    b = _board(client)
    is_available_mock = AsyncMock(return_value=True)
    run_llm_mock = AsyncMock(return_value="should not be called")
    with patch("flowboard.services.planner.PLANNER_BACKEND", "mock"), \
         patch.object(_claude_provider(), "is_available", new=is_available_mock), \
         patch("flowboard.services.planner.run_llm", new=run_llm_mock):
        from flowboard.db import get_session

        with get_session() as s:
            out = await planner.generate_plan_reply(
                s, b["id"], "hi", []
            )
    assert out["plan"] is None
    # Neither the availability probe nor the dispatcher fired.
    assert is_available_mock.await_count == 0
    assert run_llm_mock.await_count == 0


@pytest.mark.asyncio
async def test_generate_plan_reply_auto_respects_user_picked_provider(
    client, tmp_path, monkeypatch
):
    """User pinned planner=gemini in Settings — auto mode probes Gemini's
    availability (not Claude's). Gemini unavailable → mock fallback even
    if Claude is available. Confirms the migration's promise that the
    'auto' fallback respects the user's pin instead of Claude-everywhere.

    Isolated secrets path so we don't write to the user's
    ~/.flowboard/secrets.json from a test."""
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(tmp_path / "secrets.json"))
    b = _board(client)
    from flowboard.services.llm import secrets
    secrets.set_feature_provider("planner", "gemini")
    gemini = registry.get_provider("gemini")
    claude = _claude_provider()
    with patch("flowboard.services.planner.PLANNER_BACKEND", "auto"), \
         patch.object(gemini, "is_available", return_value=False), \
         patch.object(claude, "is_available", return_value=True):
        from flowboard.db import get_session

        with get_session() as s:
            out = await planner.generate_plan_reply(
                s, b["id"], "hello", []
            )
    # Gemini was unavailable so mock fallback fires regardless of Claude.
    assert out["plan"] is None
