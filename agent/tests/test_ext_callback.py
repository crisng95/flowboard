"""Tests for POST /api/ext/callback — secret auth + future resolution."""
import asyncio

import pytest

from flowboard.services.flow_client import flow_client


def test_callback_rejects_missing_secret(client):
    r = client.post(
        "/api/ext/callback",
        json={"id": "not-real", "status": 200, "data": {}},
    )
    assert r.status_code == 401


def test_callback_rejects_wrong_secret(client):
    r = client.post(
        "/api/ext/callback",
        json={"id": "not-real", "status": 200, "data": {}},
        headers={"X-Callback-Secret": "definitely-wrong"},
    )
    assert r.status_code == 401


def test_callback_accepts_correct_secret_but_no_pending_match(client):
    r = client.post(
        "/api/ext/callback",
        json={"id": "no-match", "status": 200, "data": {}},
        headers={"X-Callback-Secret": flow_client.callback_secret},
    )
    assert r.status_code == 200
    assert r.json() == {"ok": False}


def test_callback_rejects_malformed_body(client):
    r = client.post(
        "/api/ext/callback",
        content=b"not-json",
        headers={
            "X-Callback-Secret": flow_client.callback_secret,
            "Content-Type": "application/json",
        },
    )
    assert r.status_code == 400


def test_callback_requires_id_field(client):
    r = client.post(
        "/api/ext/callback",
        json={"status": 200, "data": {}},
        headers={"X-Callback-Secret": flow_client.callback_secret},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_callback_resolves_pending_future(client):
    # Insert a fake pending future directly so we don't need a real WS.
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    flow_client._pending["probe-id"] = fut

    try:
        r = client.post(
            "/api/ext/callback",
            json={"id": "probe-id", "status": 200, "data": {"ok": True}},
            headers={"X-Callback-Secret": flow_client.callback_secret},
        )
        assert r.status_code == 200
        assert r.json() == {"ok": True}

        resolved = await asyncio.wait_for(fut, timeout=1.0)
        assert resolved["status"] == 200
        assert resolved["data"] == {"ok": True}
    finally:
        # cleanup just in case
        flow_client._pending.pop("probe-id", None)
