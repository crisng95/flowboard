"""Tests for services/planner.py — generate_plan_reply + mock fallback.

We mock ``claude_cli`` so no real subprocess spawns.
"""
import pytest
from unittest.mock import AsyncMock, patch

from flowboard.services import planner


# ── Plan extraction ─────────────────────────────────────────────────────────


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


@pytest.mark.asyncio
async def test_generate_plan_reply_uses_cli_when_available(client):
    b = _board(client)
    cli_response = (
        "Creating three variations.\n"
        "```json\n"
        '{"nodes":[{"tmp_id":"img1","type":"image","params":{"prompt":"cat"}}],'
        '"edges":[],"layout_hint":"left_to_right"}\n'
        "```"
    )
    with patch("flowboard.services.planner.PLANNER_BACKEND", "cli"), patch(
        "flowboard.services.planner.claude_cli.is_available",
        new=AsyncMock(return_value=True),
    ), patch(
        "flowboard.services.planner.claude_cli.run_claude",
        new=AsyncMock(return_value=cli_response),
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
async def test_generate_plan_reply_falls_back_to_mock_when_cli_unavailable(client):
    b = _board(client)
    with patch("flowboard.services.planner.PLANNER_BACKEND", "auto"), patch(
        "flowboard.services.planner.claude_cli.is_available",
        new=AsyncMock(return_value=False),
    ):
        from flowboard.db import get_session

        with get_session() as s:
            out = await planner.generate_plan_reply(
                s, b["id"], "hello", []
            )
    assert out["plan"] is None
    assert "Planner stub" in out["reply_text"] or "Noted" in out["reply_text"]


@pytest.mark.asyncio
async def test_generate_plan_reply_handles_cli_error_with_mock_fallback(client):
    b = _board(client)
    from flowboard.services.claude_cli import ClaudeCliError

    with patch("flowboard.services.planner.PLANNER_BACKEND", "auto"), patch(
        "flowboard.services.planner.claude_cli.is_available",
        new=AsyncMock(return_value=True),
    ), patch(
        "flowboard.services.planner.claude_cli.run_claude",
        new=AsyncMock(side_effect=ClaudeCliError("timeout")),
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
async def test_generate_plan_reply_mock_mode_skips_cli(client):
    b = _board(client)
    mock_is_available = AsyncMock(return_value=True)
    with patch("flowboard.services.planner.PLANNER_BACKEND", "mock"), patch(
        "flowboard.services.planner.claude_cli.is_available", new=mock_is_available
    ), patch(
        "flowboard.services.planner.claude_cli.run_claude",
        new=AsyncMock(return_value="should not be called"),
    ) as run_mock:
        from flowboard.db import get_session

        with get_session() as s:
            out = await planner.generate_plan_reply(
                s, b["id"], "hi", []
            )
    assert out["plan"] is None
    # CLI was never called in mock mode.
    assert run_mock.await_count == 0
    assert mock_is_available.await_count == 0
