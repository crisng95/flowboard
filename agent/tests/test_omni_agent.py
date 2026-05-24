from flowboard.services import omni_agent
from unittest.mock import AsyncMock

import pytest


def test_parse_sse_payload_collects_text_and_metadata():
    raw = """event: message
data: {"agentSessionId":"sess-1","turnNumber":1}

event: message
data: {"candidate":{"content":{"parts":[{"text":"Hello"},{"text":"world"}]}}}

event: message
data: {"delta":{"text":"Final line"}}
"""
    out = omni_agent.parse_sse_payload(raw)
    assert out["agent_session_id"] == "sess-1"
    assert out["turn_number"] == 1
    assert out["content"] == "Hello\nworld\nFinal line"


def test_parse_sse_payload_falls_back_to_plain_text_lines():
    raw = """data: hello
data: world
"""
    out = omni_agent.parse_sse_payload(raw)
    assert out["content"] == "hello\nworld"


def test_omni_project_id_prefixes_bare_uuid():
    assert omni_agent._omni_project_id("8f734187-0f01-4321-855b-317ef20aa3b7") == (
        "projects/8f734187-0f01-4321-855b-317ef20aa3b7"
    )
    assert omni_agent._omni_project_id("projects/8f734187-0f01-4321-855b-317ef20aa3b7") == (
        "projects/8f734187-0f01-4321-855b-317ef20aa3b7"
    )


def test_omni_client_session_id_uses_semicolon_prefix():
    assert omni_agent._omni_client_session_id(1779351196653) == ";1779351196653"


def test_resolve_omni_captcha_action_uses_observed_value(monkeypatch):
    monkeypatch.setattr(
        omni_agent.flow_client,
        "get_observed_captcha_action",
        lambda scope: "labs_flow_omni_chat",
    )
    assert omni_agent._resolve_omni_captcha_action() == "labs_flow_omni_chat"


def test_resolve_omni_captcha_action_raises_when_missing(monkeypatch):
    monkeypatch.setattr(
        omni_agent.flow_client,
        "get_observed_captcha_action",
        lambda scope: None,
    )
    with pytest.raises(omni_agent.OmniAgentError, match="not observed yet"):
        omni_agent._resolve_omni_captcha_action()


@pytest.mark.asyncio
async def test_stream_chat_sends_projects_prefixed_project_id(monkeypatch):
    monkeypatch.setattr(
        omni_agent,
        "ensure_board_project_id",
        AsyncMock(return_value="8f734187-0f01-4321-855b-317ef20aa3b7"),
    )
    monkeypatch.setattr(omni_agent, "_omni_client_session_id", lambda now_ms=None: ";1779351196653")
    monkeypatch.setattr(omni_agent, "_resolve_omni_captcha_action", lambda: "labs_flow_omni_chat")
    api_request = AsyncMock(
        return_value={
            "status": 200,
            "data": 'data: {"candidate":{"content":{"parts":[{"text":"ok"}]}}}',
        }
    )
    monkeypatch.setattr(omni_agent.flow_client, "api_request", api_request)

    out = await omni_agent.stream_chat(board_id=5, message="hello")

    kwargs = api_request.await_args.kwargs
    ctx = kwargs["body"]["agentClientContext"]
    assert ctx["projectId"] == (
        "projects/8f734187-0f01-4321-855b-317ef20aa3b7"
    )
    assert ctx["clientSessionId"] == ";1779351196653"
    assert ctx["recaptchaContext"] == {
        "token": "",
        "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
    }
    assert ctx["turnNumber"] == 1
    assert "turnNumber" not in kwargs["body"]
    assert kwargs["captcha_action"] == "labs_flow_omni_chat"
    assert out["content"] == "ok"
