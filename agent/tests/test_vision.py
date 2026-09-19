"""Tests for the vision describe service + /api/vision/describe route.

The service routes vision calls through `run_llm("vision", ...)` after
the multi-LLM provider migration. Tests patch `run_llm` at the import
boundary in `vision_service` so the registry / provider stack is fully
bypassed — registry routing is tested separately in `test_llm_registry.py`.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flowboard.services import vision as vision_service
from flowboard.services.llm.base import LLMError


# ── service tests ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_describe_media_passes_cached_path_through_run_llm(monkeypatch, tmp_path):
    """Service must locate the cached file, then forward the absolute path
    as an attachment to `run_llm("vision", ...)` with the brief system prompt."""
    media_id = "11111111-2222-3333-4444-555555555555"

    fake_cached = tmp_path / f"{media_id}.png"
    fake_cached.write_bytes(b"\x89PNG\r\n\x1a\n")

    from flowboard.services import media as media_service
    monkeypatch.setattr(media_service, "cached_path", lambda mid: fake_cached)

    captured: dict = {}

    async def stub_run_llm(feature, prompt, *, system_prompt=None, attachments=None, timeout=0):
        captured["feature"] = feature
        captured["prompt"] = prompt
        captured["system_prompt"] = system_prompt
        captured["attachments"] = attachments
        return "white cotton crewneck t-shirt with small heart logo on chest"

    monkeypatch.setattr(vision_service, "run_llm", stub_run_llm)

    out = await vision_service.describe_media(media_id)
    assert "white cotton crewneck" in out
    assert captured["feature"] == "vision"  # routed under the right feature key
    assert captured["attachments"] == [str(fake_cached.resolve())]
    assert captured["system_prompt"] is not None
    assert "annotator" in (captured["system_prompt"] or "").lower()


@pytest.mark.asyncio
async def test_describe_media_rejects_invalid_id():
    with pytest.raises(vision_service.VisionError):
        await vision_service.describe_media("not-a-uuid")


@pytest.mark.asyncio
async def test_describe_media_caps_long_responses(monkeypatch, tmp_path):
    media_id = "22222222-2222-3333-4444-555555555555"
    fake = tmp_path / f"{media_id}.png"
    fake.write_bytes(b"x")

    from flowboard.services import media as media_service
    monkeypatch.setattr(media_service, "cached_path", lambda mid: fake)

    long_text = "a" * 800
    async def stub_run_llm(*a, **k):
        return long_text

    monkeypatch.setattr(vision_service, "run_llm", stub_run_llm)
    out = await vision_service.describe_media(media_id)
    assert len(out) <= 401  # 400 + ellipsis
    assert out.endswith("…")


@pytest.mark.asyncio
async def test_describe_media_propagates_provider_failure(monkeypatch, tmp_path):
    """Provider failure surfaces as VisionError. Confirms the registry
    contract that `run_llm` only raises LLMError — vision wraps it
    further into VisionError so route handlers can return a clean 502."""
    media_id = "33333333-2222-3333-4444-555555555555"
    fake = tmp_path / f"{media_id}.png"
    fake.write_bytes(b"x")

    from flowboard.services import media as media_service
    monkeypatch.setattr(media_service, "cached_path", lambda mid: fake)

    async def stub_run_llm(*a, **k):
        raise LLMError("auth failed")

    monkeypatch.setattr(vision_service, "run_llm", stub_run_llm)
    with pytest.raises(vision_service.VisionError, match="vision provider failed"):
        await vision_service.describe_media(media_id)


# ── route tests ───────────────────────────────────────────────────────────


def test_describe_route_happy_path(client, monkeypatch):
    media_id = "44444444-2222-3333-4444-555555555555"

    async def stub_describe(mid, *, node_id=None):
        assert mid == media_id
        assert node_id is None  # body omitted it — the field is optional
        return "young Korean woman, neutral expression, dark hair tied back"

    monkeypatch.setattr(vision_service, "describe_media", stub_describe)
    r = client.post("/api/vision/describe", json={"media_id": media_id})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["media_id"] == media_id
    assert "Korean woman" in body["description"]


def test_describe_route_502_on_vision_error(client, monkeypatch):
    async def stub_describe(mid, *, node_id=None):
        raise vision_service.VisionError("media not cached and could not be fetched")

    monkeypatch.setattr(vision_service, "describe_media", stub_describe)
    r = client.post(
        "/api/vision/describe",
        json={"media_id": "55555555-2222-3333-4444-555555555555"},
    )
    assert r.status_code == 502
    assert "not cached" in r.json()["detail"]


# ── node_id: the activity row, and the node write ─────────────────────────
#
# These cover the reason a reload used to lose a brief. The browser was the
# only writer: it awaited /api/vision/describe and then PATCHed the node
# itself, so refreshing mid-call dropped the answer on the floor even though
# the server had produced it. The service now writes `aiBrief` itself.


def _seed_node(data: dict | None = None) -> tuple[int, int]:
    """Board + one visual_asset node. Returns (board_id, node_id)."""
    from flowboard.db import get_session
    from flowboard.db.models import Board, Node

    with get_session() as s:
        b = Board(name="vision")
        s.add(b)
        s.commit()
        s.refresh(b)
        n = Node(
            board_id=b.id,
            short_id="vis1",
            type="visual_asset",
            x=0, y=0, w=240, h=180,
            data=data if data is not None else {"title": "Asset"},
            status="idle",
        )
        s.add(n)
        s.commit()
        s.refresh(n)
        return b.id, n.id


def _read_node_data(node_id: int) -> dict:
    from flowboard.db import get_session
    from flowboard.db.models import Node

    with get_session() as s:
        return dict(s.get(Node, node_id).data or {})


def _rows_for(node_id: int) -> list:
    from flowboard.db import get_session
    from flowboard.db.models import Request
    from sqlmodel import select

    with get_session() as s:
        return list(s.exec(select(Request).where(Request.node_id == node_id)).all())


def test_describe_route_forwards_node_id(client, monkeypatch):
    """The route has to carry `node_id` or the service can't write the
    brief anywhere — vision rows used to land with `node_id=NULL`, which
    also kept them out of every board-scoped listing."""
    captured: dict = {}

    async def stub_describe(mid, *, node_id=None):
        captured["node_id"] = node_id
        return "a brief"

    monkeypatch.setattr(vision_service, "describe_media", stub_describe)
    r = client.post(
        "/api/vision/describe",
        json={"media_id": "66666666-2222-3333-4444-555555555555", "node_id": 41},
    )
    assert r.status_code == 200, r.text
    assert captured["node_id"] == 41


@pytest.mark.asyncio
async def test_describe_media_records_node_id_on_the_activity_row(
    client, monkeypatch, tmp_path
):
    """The row is what a reloading page finds the call through, and it
    only reaches a board through its node."""
    media_id = "77777777-2222-3333-4444-555555555555"
    fake = tmp_path / f"{media_id}.png"
    fake.write_bytes(b"x")

    from flowboard.services import media as media_service
    monkeypatch.setattr(media_service, "cached_path", lambda mid: fake)

    async def stub_run_llm(*a, **k):
        return "navy linen shirt, relaxed fit"

    monkeypatch.setattr(vision_service, "run_llm", stub_run_llm)

    _board_id, node_id = _seed_node()
    await vision_service.describe_media(media_id, node_id=node_id)

    rows = _rows_for(node_id)
    assert len(rows) == 1
    assert rows[0].type == "vision"
    assert rows[0].status == "done"
    assert rows[0].result["description"] == "navy linen shirt, relaxed fit"


@pytest.mark.asyncio
async def test_describe_media_writes_the_brief_onto_the_node(
    client, monkeypatch, tmp_path
):
    """The whole point: the answer lands on the node whether or not the
    tab that asked for it is still listening. Merged, not replaced — the
    node's other keys are everything else the card renders."""
    media_id = "88888888-2222-3333-4444-555555555555"
    fake = tmp_path / f"{media_id}.png"
    fake.write_bytes(b"x")

    from flowboard.services import media as media_service
    monkeypatch.setattr(media_service, "cached_path", lambda mid: fake)

    async def stub_run_llm(*a, **k):
        return "white cotton crewneck t-shirt"

    monkeypatch.setattr(vision_service, "run_llm", stub_run_llm)

    _board_id, node_id = _seed_node(
        {"title": "Asset", "mediaId": media_id, "thumbnailUrl": "blob:keep-me"}
    )
    await vision_service.describe_media(media_id, node_id=node_id)

    data = _read_node_data(node_id)
    assert data["aiBrief"] == "white cotton crewneck t-shirt"
    assert data["thumbnailUrl"] == "blob:keep-me"
    assert data["title"] == "Asset"


@pytest.mark.asyncio
async def test_describe_media_without_a_node_writes_nothing(
    client, monkeypatch, tmp_path
):
    """`node_id` stays optional — the endpoint is callable on a media id
    alone, and that path must not blow up looking for a node."""
    media_id = "99999999-2222-3333-4444-555555555555"
    fake = tmp_path / f"{media_id}.png"
    fake.write_bytes(b"x")

    from flowboard.services import media as media_service
    monkeypatch.setattr(media_service, "cached_path", lambda mid: fake)

    async def stub_run_llm(*a, **k):
        return "a brief"

    monkeypatch.setattr(vision_service, "run_llm", stub_run_llm)

    _board_id, node_id = _seed_node()
    out = await vision_service.describe_media(media_id)
    assert out == "a brief"
    assert "aiBrief" not in _read_node_data(node_id)


@pytest.mark.asyncio
async def test_a_failing_node_write_changes_neither_the_result_nor_the_row(
    client, monkeypatch, tmp_path
):
    """Same discipline as the worker's mirror: the LLM call is the
    expensive part and it already succeeded. A node that can't be written
    (deleted mid-flight, locked DB) must not turn that into a 502, and
    must not stop the row settling `done` with its result — the row is
    what makes the answer recoverable on the next load.

    Swapping the mapped class out makes `Session.get()` raise before it
    touches the database, which is as close to "the node write went
    wrong" as we can get without faking the ORM.
    """
    media_id = "aaaaaaaa-2222-3333-4444-555555555555"
    fake = tmp_path / f"{media_id}.png"
    fake.write_bytes(b"x")

    from flowboard.services import media as media_service
    monkeypatch.setattr(media_service, "cached_path", lambda mid: fake)

    async def stub_run_llm(*a, **k):
        return "a brief that survives"

    monkeypatch.setattr(vision_service, "run_llm", stub_run_llm)

    class _NotAModel:
        pass

    from flowboard import node_mirror
    monkeypatch.setattr(node_mirror, "Node", _NotAModel)

    _board_id, node_id = _seed_node()
    out = await vision_service.describe_media(media_id, node_id=node_id)

    assert out == "a brief that survives"
    rows = _rows_for(node_id)
    assert [r.status for r in rows] == ["done"]
    assert rows[0].result["description"] == "a brief that survives"
    assert "aiBrief" not in _read_node_data(node_id)


@pytest.mark.asyncio
async def test_describe_media_rejects_an_unknown_node_id():
    """An unknown `node_id` is a caller mistake, not a server fault.

    `Request.node_id` is a real FK and `PRAGMA foreign_keys=ON` is set, so
    letting it reach `record_activity`'s insert raises `IntegrityError` out
    of a route that only catches `VisionError` — the endpoint answered 500.
    Reachable without doing anything strange: a stale tab fires auto-brief
    for a node the user has since deleted.

    `prompt_synth` already answers "node <id> not found" for the same
    input on its sibling endpoints; this keeps the two consistent.
    """
    with pytest.raises(vision_service.VisionError) as exc:
        await vision_service.describe_media(
            "66666666-2222-3333-4444-555555555555", node_id=424242
        )
    assert "424242" in str(exc.value)


def test_describe_route_502s_on_an_unknown_node_id(client):
    """The route surfaces it as 502, not 500 — no stub, so this exercises
    the real service path including the guard."""
    r = client.post(
        "/api/vision/describe",
        json={
            "media_id": "66666666-2222-3333-4444-555555555555",
            "node_id": 424242,
        },
    )
    assert r.status_code == 502
    assert "424242" in r.json()["detail"]
