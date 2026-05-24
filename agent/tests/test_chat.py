from unittest.mock import AsyncMock, patch


def _board(client, name="T"):
    return client.post("/api/boards", json={"name": name}).json()


def test_send_chat_persists_user_and_assistant(client):
    b = _board(client)
    r = client.post(
        "/api/chat",
        json={"board_id": b["id"], "message": "hello", "mentions": []},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["role"] == "user"
    assert body["user"]["content"] == "hello"
    assert body["assistant"]["role"] == "assistant"
    assert body["assistant"]["content"]  # non-empty mock reply
    assert body["assistant"]["board_id"] == b["id"]


def test_chat_mentions_referenced_in_reply(client):
    b = _board(client)
    node = client.post(
        "/api/nodes",
        json={"board_id": b["id"], "type": "character", "data": {"title": "Lira"}},
    ).json()
    short = node["short_id"]

    r = client.post(
        "/api/chat",
        json={
            "board_id": b["id"],
            "message": "animate this",
            "mentions": [short],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["mentions"] == [short]
    assert f"#{short}" in body["assistant"]["content"]
    assert "Lira" in body["assistant"]["content"]


def test_chat_unknown_mention_noted(client):
    b = _board(client)
    r = client.post(
        "/api/chat",
        json={"board_id": b["id"], "message": "what", "mentions": ["zzzz"]},
    )
    assert r.status_code == 200
    assert "zzzz" in r.json()["assistant"]["content"]


def test_list_chat_returns_history_ordered(client):
    b = _board(client)
    for i in range(3):
        client.post(
            "/api/chat",
            json={"board_id": b["id"], "message": f"msg{i}", "mentions": []},
        )
    r = client.get(f"/api/boards/{b['id']}/chat")
    assert r.status_code == 200
    history = r.json()
    # 3 user + 3 assistant = 6 rows
    assert len(history) == 6
    # user rows in original order
    user_contents = [m["content"] for m in history if m["role"] == "user"]
    assert user_contents == ["msg0", "msg1", "msg2"]


def test_send_chat_rejects_empty_message(client):
    b = _board(client)
    r = client.post(
        "/api/chat",
        json={"board_id": b["id"], "message": "", "mentions": []},
    )
    assert r.status_code == 422


def test_send_chat_unknown_board(client):
    r = client.post(
        "/api/chat",
        json={"board_id": 999, "message": "hi", "mentions": []},
    )
    assert r.status_code == 404


def test_list_chat_unknown_board(client):
    r = client.get("/api/boards/999/chat")
    assert r.status_code == 404


# ── plan persistence + response shape ─────────────────────────────────────


def test_send_chat_returns_plan_when_planner_emits_one(client):
    b = _board(client)
    planned = {
        "reply_text": "Making a plan.",
        "plan": {
            "nodes": [{"tmp_id": "a", "type": "image"}],
            "edges": [],
            "layout_hint": "left_to_right",
        },
    }
    with patch(
        "flowboard.routes.chat.generate_plan_reply",
        new=AsyncMock(return_value=planned),
    ):
        r = client.post(
            "/api/chat",
            json={"board_id": b["id"], "message": "plan this", "mentions": []},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["content"] == "plan this"
    assert body["assistant"]["content"] == "Making a plan."
    assert "plan" in body
    assert body["plan"]["spec"]["nodes"][0]["type"] == "image"
    assert body["plan"]["status"] == "draft"


def test_send_chat_omits_plan_when_planner_returns_none(client):
    b = _board(client)
    planned = {"reply_text": "Just chatting.", "plan": None}
    with patch(
        "flowboard.routes.chat.generate_plan_reply",
        new=AsyncMock(return_value=planned),
    ):
        r = client.post(
            "/api/chat",
            json={"board_id": b["id"], "message": "hi", "mentions": []},
        )
    assert r.status_code == 200
    body = r.json()
    assert "plan" not in body
    assert body["assistant"]["content"] == "Just chatting."


def test_send_chat_uses_omni_provider_when_chat_configured(client, monkeypatch):
    b = _board(client)
    monkeypatch.setattr(
        "flowboard.routes.chat.secrets.read_active_providers",
        lambda: {"chat": "omni"},
    )
    with patch(
        "flowboard.routes.chat.stream_chat",
        new=AsyncMock(
            return_value={
                "content": "Hello from Omni.",
                "agent_session_id": "sess-123",
                "turn_number": 1,
                "project_id": "projects/test",
            }
        ),
    ) as omni_mock:
        r = client.post(
            "/api/chat",
            json={
                "board_id": b["id"],
                "message": "hello omni",
                "mentions": [],
                "agent_session_id": None,
                "turn_number": 1,
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert body["assistant"]["content"] == "Hello from Omni."
    assert body["chatProvider"] == "omni"
    assert body["agentSessionId"] == "sess-123"
    assert body["turnNumber"] == 1
    assert "plan" not in body
    omni_mock.assert_awaited_once()


def test_send_chat_passes_agent_session_and_turn_to_omni(client, monkeypatch):
    b = _board(client)
    monkeypatch.setattr(
        "flowboard.routes.chat.secrets.read_active_providers",
        lambda: {"chat": "omni"},
    )
    with patch(
        "flowboard.routes.chat.stream_chat",
        new=AsyncMock(
            return_value={
                "content": "Turn two",
                "agent_session_id": "sess-abc",
                "turn_number": 2,
                "project_id": "projects/test",
            }
        ),
    ) as omni_mock:
        r = client.post(
            "/api/chat",
            json={
                "board_id": b["id"],
                "message": "continue",
                "mentions": [],
                "agent_session_id": "sess-abc",
                "turn_number": 2,
            },
        )
    assert r.status_code == 200
    kwargs = omni_mock.await_args.kwargs
    assert kwargs["agent_session_id"] == "sess-abc"
    assert kwargs["turn_number"] == 2


def test_send_chat_omni_failure_returns_502(client, monkeypatch):
    from flowboard.services.omni_agent import OmniAgentError

    b = _board(client)
    monkeypatch.setattr(
        "flowboard.routes.chat.secrets.read_active_providers",
        lambda: {"chat": "omni"},
    )
    with patch(
        "flowboard.routes.chat.stream_chat",
        new=AsyncMock(side_effect=OmniAgentError("NO_FLOW_KEY")),
    ):
        r = client.post(
            "/api/chat",
            json={"board_id": b["id"], "message": "hello", "mentions": []},
        )
    assert r.status_code == 502
    assert "NO_FLOW_KEY" in r.text
