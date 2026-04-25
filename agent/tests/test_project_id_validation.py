"""Ensure the worker rejects malformed project_id before any HTTP call."""
import asyncio

import pytest

from flowboard.services.flow_sdk import is_valid_project_id
from flowboard.worker.processor import WorkerController, _handle_gen_image


def test_valid_project_ids():
    assert is_valid_project_id("abc")
    assert is_valid_project_id("ABC_XYZ-01")
    assert is_valid_project_id("a" * 128)


def test_invalid_project_ids():
    assert not is_valid_project_id("")
    assert not is_valid_project_id("../../admin")
    assert not is_valid_project_id("has space")
    assert not is_valid_project_id("slash/path")
    assert not is_valid_project_id("a" * 129)


@pytest.mark.asyncio
async def test_worker_rejects_path_traversal_project_id(client):
    row = client.post(
        "/api/requests",
        json={
            "type": "gen_image",
            "params": {"prompt": "x", "project_id": "../../admin"},
        },
    ).json()

    w = WorkerController(handlers={"gen_image": _handle_gen_image})
    task = asyncio.create_task(w.start())
    try:
        w.enqueue(row["id"])
        for _ in range(40):
            await asyncio.sleep(0.05)
            current = client.get(f"/api/requests/{row['id']}").json()
            if current["status"] not in ("queued", "running"):
                break
        assert current["status"] == "failed"
        assert current["error"] == "invalid_project_id"
    finally:
        w.request_shutdown()
        await asyncio.wait_for(task, timeout=2.0)
