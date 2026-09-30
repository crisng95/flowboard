"""POST /api/chat send-path: fast run_id, attachment wiring, and the
running → done transition on the active-run endpoint.

The agent itself is replaced with a no-op so the run deterministically
stays ``running``; the transition is then driven by flipping the row.
"""
from flowboard.db import get_session
from flowboard.db.models import ChatRun

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def _board(client, name="T"):
    return client.post("/api/boards", json={"name": name}).json()


def _noop_agent(monkeypatch, calls):
    async def _fake(board_id, run_id, message, attachment_ids, mentions):
        calls.append(
            {
                "board_id": board_id,
                "run_id": run_id,
                "message": message,
                "attachment_ids": attachment_ids,
                "mentions": mentions,
            }
        )

    monkeypatch.setattr("flowboard.routes.chat.run_chat_agent", _fake)


def _upload_png(client, board_id):
    r = client.post(
        "/api/chat/attachments",
        data={"board_id": str(board_id)},
        files=[("files", ("a.png", PNG, "image/png"))],
    )
    assert r.status_code == 200
    return r.json()["assets"][0]


def test_send_returns_fast_with_run_id_and_schedules_agent(client, monkeypatch):
    calls = []
    _noop_agent(monkeypatch, calls)
    b = _board(client)
    asset = _upload_png(client, b["id"])

    r = client.post(
        "/api/chat",
        json={
            "board_id": b["id"],
            "message": "làm video",
            "mentions": [],
            "attachment_ids": [asset["id"]],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["content"] == "làm video"
    assert body["user"]["attachments"][0]["asset_id"] == asset["id"]
    assert body["user"]["attachments"][0]["url"] == asset["url"]
    run_id = body["run_id"]

    # background task fired with the right args
    assert len(calls) == 1
    assert calls[0]["run_id"] == run_id
    assert calls[0]["board_id"] == b["id"]
    assert calls[0]["attachment_ids"] == [asset["id"]]
    assert calls[0]["message"] == "làm video"

    # run is active while the (no-op) agent hasn't settled it
    active = client.get(f"/api/boards/{b['id']}/chat/runs/active")
    assert active.status_code == 200
    assert active.json()["id"] == run_id
    assert active.json()["status"] == "running"

    # …and disappears once the run settles
    with get_session() as s:
        run = s.get(ChatRun, run_id)
        run.status = "done"
        s.add(run)
        s.commit()
    assert client.get(f"/api/boards/{b['id']}/chat/runs/active").json() is None


def test_send_without_attachments_ok(client, monkeypatch):
    calls = []
    _noop_agent(monkeypatch, calls)
    b = _board(client)
    r = client.post(
        "/api/chat", json={"board_id": b["id"], "message": "hi", "mentions": []}
    )
    assert r.status_code == 200
    assert r.json()["user"]["attachments"] == []
    assert calls[0]["attachment_ids"] == []


def test_active_run_empty_and_unknown_board(client):
    b = _board(client)
    assert client.get(f"/api/boards/{b['id']}/chat/runs/active").json() is None
    assert client.get("/api/boards/424242/chat/runs/active").status_code == 404


def test_send_rejects_bound_attachment(client, monkeypatch):
    """An asset already bound to a node can't be attached to a message."""
    _noop_agent(monkeypatch, [])
    b = _board(client)
    asset = _upload_png(client, b["id"])
    node = client.post(
        "/api/nodes",
        json={"board_id": b["id"], "type": "image"},
    ).json()
    with get_session() as s:
        from flowboard.db.models import Asset

        row = s.get(Asset, asset["id"])
        row.node_id = node["id"]
        s.add(row)
        s.commit()
    r = client.post(
        "/api/chat",
        json={
            "board_id": b["id"],
            "message": "hi",
            "attachment_ids": [asset["id"]],
        },
    )
    assert r.status_code == 400
