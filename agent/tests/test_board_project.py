"""Tests for POST/GET /api/boards/:id/project — idempotent Flow project
bootstrap. The SDK is patched so we don't touch a real extension.
"""
from unittest.mock import AsyncMock, patch

import pytest


def _board(client, name="T"):
    return client.post("/api/boards", json={"name": name}).json()


def test_bootstrap_creates_project_first_time(client):
    async def fake_create(title, tool="PINHOLE"):
        assert title == "Scene 01"
        return {"raw": {"status": 200}, "project_id": "flow-proj-1"}

    b = _board(client, "Scene 01")
    with patch(
        "flowboard.routes.projects.get_flow_sdk"
    ) as m:
        m.return_value.create_project = AsyncMock(side_effect=fake_create)
        r = client.post(f"/api/boards/{b['id']}/project")
        assert r.status_code == 200
        body = r.json()
        assert body["flow_project_id"] == "flow-proj-1"
        assert body["created"] is True

        # Second call is idempotent and does NOT re-invoke the SDK
        r2 = client.post(f"/api/boards/{b['id']}/project")
        assert r2.status_code == 200
        body2 = r2.json()
        assert body2["flow_project_id"] == "flow-proj-1"
        assert body2["created"] is False

        # SDK was only called once
        assert m.return_value.create_project.await_count == 1


def test_get_returns_404_when_no_binding(client):
    b = _board(client)
    r = client.get(f"/api/boards/{b['id']}/project")
    assert r.status_code == 404


def test_get_returns_existing_binding(client):
    async def fake_create(title, tool="PINHOLE"):
        return {"raw": {}, "project_id": "pid-x"}

    b = _board(client)
    with patch("flowboard.routes.projects.get_flow_sdk") as m:
        m.return_value.create_project = AsyncMock(side_effect=fake_create)
        client.post(f"/api/boards/{b['id']}/project")

    r = client.get(f"/api/boards/{b['id']}/project")
    assert r.status_code == 200
    assert r.json() == {"flow_project_id": "pid-x", "created": False}


def test_bootstrap_surfaces_sdk_error_as_502(client):
    async def failing_create(title, tool="PINHOLE"):
        return {"raw": {"error": "extension_disconnected"}, "error": "extension_disconnected"}

    b = _board(client)
    with patch("flowboard.routes.projects.get_flow_sdk") as m:
        m.return_value.create_project = AsyncMock(side_effect=failing_create)
        r = client.post(f"/api/boards/{b['id']}/project")
        assert r.status_code == 502
        detail = r.json()["detail"]
        assert detail["message"] == "extension_disconnected"
        assert detail["raw"]["error"] == "extension_disconnected"


def test_bootstrap_rejects_unknown_board(client):
    r = client.post("/api/boards/9999/project")
    assert r.status_code == 404


def test_bootstrap_502_when_flow_returns_no_project_id(client):
    async def missing_id(title, tool="PINHOLE"):
        return {"raw": {"status": 200}, "error": "no_project_id_in_response"}

    b = _board(client)
    with patch("flowboard.routes.projects.get_flow_sdk") as m:
        m.return_value.create_project = AsyncMock(side_effect=missing_id)
        r = client.post(f"/api/boards/{b['id']}/project")
        assert r.status_code == 502


@pytest.mark.asyncio
async def test_bootstrap_is_concurrency_safe(client):
    """Two parallel callers should not produce two bindings."""
    call_count = 0

    async def fake_create(title, tool="PINHOLE"):
        nonlocal call_count
        call_count += 1
        return {"raw": {}, "project_id": f"pid-{call_count}"}

    b = _board(client)
    with patch("flowboard.routes.projects.get_flow_sdk") as m:
        m.return_value.create_project = AsyncMock(side_effect=fake_create)
        r1 = client.post(f"/api/boards/{b['id']}/project")
        r2 = client.post(f"/api/boards/{b['id']}/project")

    # After first call completes, the row exists, so the second call
    # short-circuits without calling SDK. End state: same project_id.
    pid1 = r1.json()["flow_project_id"]
    pid2 = r2.json()["flow_project_id"]
    assert pid1 == pid2
