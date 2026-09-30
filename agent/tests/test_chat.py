"""POST /api/chat — agentic send: returns {user, run_id} immediately and
schedules the chat agent as a background task.

The background agent is forced to fail fast here (no Muse worker in
tests) by patching ``chat_agent._chat_llm`` — deterministic regardless
of worker-presence state leaked by other test modules.
"""


def _board(client, name="T"):
    return client.post("/api/boards", json={"name": name}).json()


def _fail_fast_llm(monkeypatch):
    from flowboard.services.llm.base import LLMError

    async def _raise(*args, **kwargs):
        raise LLMError("Chưa có Muse worker")

    monkeypatch.setattr("flowboard.services.chat_agent._chat_llm", _raise)


def test_send_chat_returns_user_and_run_id(client, monkeypatch):
    _fail_fast_llm(monkeypatch)
    b = _board(client)
    r = client.post(
        "/api/chat",
        json={"board_id": b["id"], "message": "hello", "mentions": []},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["role"] == "user"
    assert body["user"]["content"] == "hello"
    assert body["user"]["board_id"] == b["id"]
    assert body["user"]["attachments"] == []
    assert isinstance(body["run_id"], int)

    # The background agent ran inline (TestClient) and failed fast: the
    # assistant message carries the error and no run stays active.
    history = client.get(f"/api/boards/{b['id']}/chat").json()
    assert [m["role"] for m in history] == ["user", "assistant"]
    assert "Muse worker" in history[1]["content"]
    assert client.get(f"/api/boards/{b['id']}/chat/runs/active").json() is None


def test_chat_mentions_stored_on_user_message(client, monkeypatch):
    _fail_fast_llm(monkeypatch)
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
    assert r.json()["user"]["mentions"] == [short]


def test_list_chat_returns_history_ordered(client, monkeypatch):
    _fail_fast_llm(monkeypatch)
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
    # every message carries the attachments list (empty here)
    assert all(m["attachments"] == [] for m in history)


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


def test_send_chat_unknown_attachment_rejected(client):
    b = _board(client)
    r = client.post(
        "/api/chat",
        json={"board_id": b["id"], "message": "hi", "attachment_ids": [424242]},
    )
    assert r.status_code == 404


def test_send_chat_too_many_attachments_rejected(client):
    b = _board(client)
    r = client.post(
        "/api/chat",
        json={
            "board_id": b["id"],
            "message": "hi",
            "attachment_ids": [1, 2, 3, 4, 5, 6],
        },
    )
    assert r.status_code == 422


def test_agent_success_path_writes_assistant_message(client, monkeypatch):
    """Scripted LLM: one tool call then done → run done, assistant reply."""
    import json as _json

    calls = [
        _json.dumps(
            {"tool": "create_node", "args": {"type": "note", "data": {"t": "x"}}}
        ),
        _json.dumps({"done": True, "reply": "xong nhé"}),
    ]

    async def _scripted(*args, **kwargs):
        return calls.pop(0)

    monkeypatch.setattr("flowboard.services.chat_agent._chat_llm", _scripted)
    b = _board(client)
    r = client.post(
        "/api/chat",
        json={"board_id": b["id"], "message": "ghi chú", "mentions": []},
    )
    assert r.status_code == 200

    history = client.get(f"/api/boards/{b['id']}/chat").json()
    assert history[-1]["role"] == "assistant"
    assert history[-1]["content"] == "xong nhé"
    assert client.get(f"/api/boards/{b['id']}/chat/runs/active").json() is None
    nodes = client.get(f"/api/boards/{b['id']}").json()["nodes"]
    assert any(n["type"] == "note" for n in nodes)
    assert calls == []  # both scripted turns consumed
