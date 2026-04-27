"""Tests for POST /api/requests and GET /api/requests/:id, plus the worker."""
import asyncio

import pytest

from flowboard.worker.processor import WorkerController


def _board(client, name="T"):
    return client.post("/api/boards", json={"name": name}).json()


def test_create_request_persists_and_returns_row(client):
    b = _board(client)
    n = client.post("/api/nodes", json={"board_id": b["id"], "type": "image"}).json()

    r = client.post(
        "/api/requests",
        json={
            "node_id": n["id"],
            "type": "proxy",
            "params": {"url": "https://aisandbox-pa.googleapis.com/v1/ping"},
        },
    )
    assert r.status_code == 200
    row = r.json()
    assert row["type"] == "proxy"
    assert row["status"] == "queued"
    assert row["node_id"] == n["id"]
    assert "id" in row


def test_create_request_with_missing_node_returns_404(client):
    r = client.post(
        "/api/requests",
        json={"node_id": 9999, "type": "proxy", "params": {}},
    )
    assert r.status_code == 404


def test_get_request_returns_row(client):
    r = client.post(
        "/api/requests",
        json={"type": "proxy", "params": {"url": "https://aisandbox-pa.googleapis.com/v1/ping"}},
    ).json()
    r2 = client.get(f"/api/requests/{r['id']}")
    assert r2.status_code == 200
    assert r2.json()["id"] == r["id"]


def test_get_missing_request_returns_404(client):
    r = client.get("/api/requests/9999")
    assert r.status_code == 404


# ── Worker tests ──────────────────────────────────────────────────────────────


async def _ok_handler(params):
    return ({"echo": params}, None)


async def _fail_handler(_params):
    return ({}, "boom")


@pytest.mark.asyncio
async def test_worker_marks_request_done_on_ok(client):
    # Enqueue via the real API so we get a real DB row.
    row = client.post(
        "/api/requests",
        json={"type": "proxy", "params": {"marker": "abc"}},
    ).json()

    w = WorkerController(handlers={"proxy": _ok_handler})
    task = asyncio.create_task(w.start())
    try:
        w.enqueue(row["id"])
        # Poll the row until status flips, up to ~2s.
        for _ in range(40):
            await asyncio.sleep(0.05)
            current = client.get(f"/api/requests/{row['id']}").json()
            if current["status"] != "queued":
                break
        assert current["status"] == "done"
        assert current["result"] == {"echo": {"marker": "abc"}}
        assert current["error"] is None
    finally:
        w.request_shutdown()
        await asyncio.wait_for(task, timeout=2.0)


@pytest.mark.asyncio
async def test_worker_marks_request_failed_on_error(client):
    row = client.post(
        "/api/requests", json={"type": "proxy", "params": {}}
    ).json()

    w = WorkerController(handlers={"proxy": _fail_handler})
    task = asyncio.create_task(w.start())
    try:
        w.enqueue(row["id"])
        for _ in range(40):
            await asyncio.sleep(0.05)
            current = client.get(f"/api/requests/{row['id']}").json()
            if current["status"] != "queued":
                break
        assert current["status"] == "failed"
        assert current["error"] == "boom"
    finally:
        w.request_shutdown()
        await asyncio.wait_for(task, timeout=2.0)


@pytest.mark.asyncio
async def test_worker_unknown_request_type_fails(client):
    row = client.post(
        "/api/requests", json={"type": "totally_made_up", "params": {}}
    ).json()
    w = WorkerController(handlers={"proxy": _ok_handler})
    task = asyncio.create_task(w.start())
    try:
        w.enqueue(row["id"])
        for _ in range(40):
            await asyncio.sleep(0.05)
            current = client.get(f"/api/requests/{row['id']}").json()
            if current["status"] != "queued":
                break
        assert current["status"] == "failed"
        assert "unknown_request_type" in current["error"]
    finally:
        w.request_shutdown()
        await asyncio.wait_for(task, timeout=2.0)


# ── create_project + gen_image handler tests ──────────────────────────────────


async def _poll_until_settled(client, rid, timeout_s=2.0):
    for _ in range(int(timeout_s / 0.05)):
        await asyncio.sleep(0.05)
        current = client.get(f"/api/requests/{rid}").json()
        if current["status"] not in ("queued", "running"):
            return current
    return current


@pytest.mark.asyncio
async def test_worker_create_project_stores_project_id(client):
    async def stub_create_project(params):
        assert params.get("name") == "Scene 01"
        return {"raw": {"status": 200}, "project_id": "proj-abc"}, None

    row = client.post(
        "/api/requests",
        json={"type": "create_project", "params": {"name": "Scene 01"}},
    ).json()

    w = WorkerController(handlers={"create_project": stub_create_project})
    task = asyncio.create_task(w.start())
    try:
        w.enqueue(row["id"])
        settled = await _poll_until_settled(client, row["id"])
        assert settled["status"] == "done"
        assert settled["result"]["project_id"] == "proj-abc"
    finally:
        w.request_shutdown()
        await asyncio.wait_for(task, timeout=2.0)


@pytest.mark.asyncio
async def test_worker_gen_image_stores_media_ids(client):
    async def stub_gen_image(params):
        assert params["prompt"] == "a cat"
        assert params["project_id"] == "proj-abc"
        return {"raw": {"status": 200}, "media_ids": ["m-1", "m-2"]}, None

    row = client.post(
        "/api/requests",
        json={
            "type": "gen_image",
            "params": {"prompt": "a cat", "project_id": "proj-abc"},
        },
    ).json()

    w = WorkerController(handlers={"gen_image": stub_gen_image})
    task = asyncio.create_task(w.start())
    try:
        w.enqueue(row["id"])
        settled = await _poll_until_settled(client, row["id"])
        assert settled["status"] == "done"
        assert settled["result"]["media_ids"] == ["m-1", "m-2"]
    finally:
        w.request_shutdown()
        await asyncio.wait_for(task, timeout=2.0)


# ── gen_video worker tests ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_worker_gen_video_happy_path(client, monkeypatch):
    """SDK returns op names then reports done on second poll; worker ingests."""
    from flowboard.worker import processor as proc

    # Speed up polls.
    monkeypatch.setattr(proc, "VIDEO_POLL_INTERVAL_S", 0.05)

    dispatch_called = {"n": 0}
    poll_calls = {"n": 0}

    class _StubSdk:
        async def gen_video(self, **kwargs):
            dispatch_called["n"] += 1
            assert kwargs["start_media_id"] == "src-1"
            return {"raw": {"ok": True}, "operation_names": ["op-1"]}

        async def check_async(self, names):
            poll_calls["n"] += 1
            if poll_calls["n"] == 1:
                return {
                    "raw": {},
                    "operations": [{"name": "op-1", "done": False, "media_entries": []}],
                }
            return {
                "raw": {},
                "operations": [
                    {
                        "name": "op-1",
                        "done": True,
                        "media_entries": [
                            {
                                "media_id": "vid-aaa",
                                "url": "https://flow-content.google/video/vid-aaa?sig=z",
                                "mediaType": "video",
                            }
                        ],
                    }
                ],
            }

    monkeypatch.setattr(proc, "get_flow_sdk", lambda: _StubSdk())

    row = client.post(
        "/api/requests",
        json={
            "type": "gen_video",
            "params": {
                "prompt": "ripple",
                "project_id": "abcd1234",
                "start_media_id": "src-1",
            },
        },
    ).json()

    w = WorkerController(handlers={"gen_video": proc._handle_gen_video})
    task = asyncio.create_task(w.start())
    try:
        w.enqueue(row["id"])
        for _ in range(200):
            await asyncio.sleep(0.05)
            current = client.get(f"/api/requests/{row['id']}").json()
            if current["status"] not in ("queued", "running"):
                break
        assert current["status"] == "done", current
        assert current["result"]["media_ids"] == ["vid-aaa"]
        assert dispatch_called["n"] == 1
        assert poll_calls["n"] >= 2
    finally:
        w.request_shutdown()
        await asyncio.wait_for(task, timeout=2.0)


@pytest.mark.asyncio
async def test_worker_gen_video_times_out(client, monkeypatch):
    from flowboard.worker import processor as proc

    monkeypatch.setattr(proc, "VIDEO_POLL_INTERVAL_S", 0.01)
    monkeypatch.setattr(proc, "VIDEO_POLL_MAX_CYCLES", 3)

    class _StubSdk:
        async def gen_video(self, **kwargs):
            return {"raw": {}, "operation_names": ["op-never"]}

        async def check_async(self, names):
            return {
                "raw": {},
                "operations": [{"name": "op-never", "done": False, "media_entries": []}],
            }

    monkeypatch.setattr(proc, "get_flow_sdk", lambda: _StubSdk())

    row = client.post(
        "/api/requests",
        json={
            "type": "gen_video",
            "params": {
                "prompt": "x",
                "project_id": "abcd1234",
                "start_media_id": "src",
            },
        },
    ).json()

    w = WorkerController(handlers={"gen_video": proc._handle_gen_video})
    task = asyncio.create_task(w.start())
    try:
        w.enqueue(row["id"])
        for _ in range(200):
            await asyncio.sleep(0.02)
            current = client.get(f"/api/requests/{row['id']}").json()
            if current["status"] not in ("queued", "running"):
                break
        assert current["status"] == "failed"
        assert current["error"] == "timeout_waiting_video"
    finally:
        w.request_shutdown()
        await asyncio.wait_for(task, timeout=2.0)


@pytest.mark.asyncio
async def test_worker_gen_video_bails_on_per_op_error(client, monkeypatch):
    """When Flow returns ``operation.error.message`` (e.g. content filter),
    the worker must stamp the request `failed` immediately rather than
    polling for the full timeout."""
    from flowboard.worker import processor as proc

    monkeypatch.setattr(proc, "VIDEO_POLL_INTERVAL_S", 0.01)
    monkeypatch.setattr(proc, "VIDEO_POLL_MAX_CYCLES", 50)

    poll_count = {"n": 0}

    class _StubSdk:
        async def gen_video(self, **kwargs):
            return {"raw": {}, "operation_names": ["op-bad"]}

        async def check_async(self, names):
            poll_count["n"] += 1
            return {
                "raw": {},
                "operations": [
                    {
                        "name": "op-bad",
                        "done": True,
                        "media_entries": [],
                        "status": "MEDIA_GENERATION_STATUS_FAILED",
                        "error": "PUBLIC_ERROR_AUDIO_FILTERED",
                    }
                ],
            }

    monkeypatch.setattr(proc, "get_flow_sdk", lambda: _StubSdk())

    row = client.post(
        "/api/requests",
        json={
            "type": "gen_video",
            "params": {
                "prompt": "x",
                "project_id": "abcd1234",
                "start_media_id": "src",
            },
        },
    ).json()

    w = WorkerController(handlers={"gen_video": proc._handle_gen_video})
    task = asyncio.create_task(w.start())
    try:
        w.enqueue(row["id"])
        for _ in range(200):
            await asyncio.sleep(0.02)
            current = client.get(f"/api/requests/{row['id']}").json()
            if current["status"] not in ("queued", "running"):
                break
        assert current["status"] == "failed", current
        assert current["error"] == "PUBLIC_ERROR_AUDIO_FILTERED"
        # Bail-out must happen on the very first poll, not after polling 50×.
        assert poll_count["n"] == 1
    finally:
        w.request_shutdown()
        await asyncio.wait_for(task, timeout=2.0)


@pytest.mark.asyncio
async def test_worker_gen_video_dedupes_repeat_entries_across_polls(
    client, monkeypatch,
):
    """Ops that finish early get re-listed as `done` on every subsequent
    poll. The worker must collect each op's media_entries ONLY on the
    transition; otherwise media_ids accumulates duplicates and the node
    UI shows extra phantom variants (saw 7 chips on a 4-variant gen)."""
    from flowboard.worker import processor as proc

    monkeypatch.setattr(proc, "VIDEO_POLL_INTERVAL_S", 0.01)
    monkeypatch.setattr(proc, "VIDEO_POLL_MAX_CYCLES", 50)

    poll_state = {"n": 0}

    class _StubSdk:
        async def gen_video(self, **kwargs):
            return {"raw": {}, "operation_names": ["op-1", "op-2", "op-3"]}

        async def check_async(self, names):
            poll_state["n"] += 1
            n = poll_state["n"]
            # Each op finishes on a different poll; once done it stays
            # `done=True` in subsequent polls (Flow behaviour). Worker
            # must not re-collect.
            ops = []
            for i, name in enumerate(["op-1", "op-2", "op-3"], start=1):
                done = i <= n  # op 1 done at poll 1, op 2 at 2, etc.
                entries = (
                    [{"media_id": f"vid-{i}", "url": f"https://flow-content.google/video/vid-{i}", "mediaType": "video"}]
                    if done
                    else []
                )
                ops.append({
                    "name": name,
                    "done": done,
                    "media_entries": entries,
                    "status": "MEDIA_GENERATION_STATUS_SUCCESSFUL" if done else "MEDIA_GENERATION_STATUS_PENDING",
                })
            return {"raw": {}, "operations": ops}

    monkeypatch.setattr(proc, "get_flow_sdk", lambda: _StubSdk())

    row = client.post(
        "/api/requests",
        json={
            "type": "gen_video",
            "params": {
                "prompt": "x",
                "project_id": "abcd1234",
                "start_media_id": "src",
            },
        },
    ).json()

    w = WorkerController(handlers={"gen_video": proc._handle_gen_video})
    task = asyncio.create_task(w.start())
    try:
        w.enqueue(row["id"])
        for _ in range(200):
            await asyncio.sleep(0.02)
            current = client.get(f"/api/requests/{row['id']}").json()
            if current["status"] not in ("queued", "running"):
                break
        assert current["status"] == "done", current
        media_ids = current["result"]["media_ids"]
        # Exactly 3 unique videos — no duplicates from polls 2 and 3.
        assert media_ids == ["vid-1", "vid-2", "vid-3"], media_ids
        assert len(media_ids) == len(set(media_ids))
    finally:
        w.request_shutdown()
        await asyncio.wait_for(task, timeout=2.0)


@pytest.mark.asyncio
async def test_worker_gen_video_rejects_missing_start(client):
    from flowboard.worker.processor import _handle_gen_video

    row = client.post(
        "/api/requests",
        json={"type": "gen_video", "params": {"prompt": "x", "project_id": "abcd1234"}},
    ).json()

    w = WorkerController(handlers={"gen_video": _handle_gen_video})
    task = asyncio.create_task(w.start())
    try:
        w.enqueue(row["id"])
        for _ in range(40):
            await asyncio.sleep(0.05)
            current = client.get(f"/api/requests/{row['id']}").json()
            if current["status"] not in ("queued", "running"):
                break
        assert current["status"] == "failed"
        assert current["error"] == "missing_start_media_id"
    finally:
        w.request_shutdown()
        await asyncio.wait_for(task, timeout=2.0)


@pytest.mark.asyncio
async def test_worker_gen_image_rejects_missing_prompt(client):
    row = client.post(
        "/api/requests",
        json={"type": "gen_image", "params": {"project_id": "p"}},
    ).json()

    from flowboard.worker.processor import _handle_gen_image

    w = WorkerController(handlers={"gen_image": _handle_gen_image})
    task = asyncio.create_task(w.start())
    try:
        w.enqueue(row["id"])
        settled = await _poll_until_settled(client, row["id"])
        assert settled["status"] == "failed"
        assert settled["error"] == "missing_prompt"
    finally:
        w.request_shutdown()
        await asyncio.wait_for(task, timeout=2.0)


def test_recover_orphan_running_requests_marks_them_failed(client):
    """An agent restart while a long-running gen_video poll is mid-flight leaves
    the request in 'running' forever. The startup recovery hook should sweep
    those rows to 'failed' so the frontend stops polling indefinitely."""
    from datetime import datetime, timezone

    from flowboard.db import get_session
    from flowboard.db.models import Request
    from flowboard.main import _recover_orphan_running_requests

    # Two stuck running rows + one already-failed (untouched control).
    with get_session() as s:
        s.add(Request(
            type="gen_video",
            status="running",
            params={},
            created_at=datetime.now(timezone.utc),
        ))
        s.add(Request(
            type="gen_image",
            status="running",
            params={},
            created_at=datetime.now(timezone.utc),
        ))
        s.add(Request(
            type="gen_image",
            status="failed",
            error="prior",
            params={},
            created_at=datetime.now(timezone.utc),
        ))
        s.commit()

    touched = _recover_orphan_running_requests()
    assert touched == 2

    rows = client.get("/api/requests").json() if False else None  # noqa: F841
    from sqlmodel import select as _select
    with get_session() as s:
        rows = s.exec(_select(Request)).all()
        statuses = sorted([(r.type, r.status, r.error) for r in rows])
    assert statuses == [
        ("gen_image", "failed", "agent_restart_lost"),
        ("gen_image", "failed", "prior"),
        ("gen_video", "failed", "agent_restart_lost"),
    ]

    # Idempotent — second call should touch nothing.
    assert _recover_orphan_running_requests() == 0
