"""The worker is the system of record for a node's in-flight state.

Before this, `Node.status` was never written and the finished media was
PATCHed onto the node by the browser's poll loop. Reloading the page mid
generation therefore did two bad things: the board came back from a DB
that still said the node was idle, and when the request landed seconds
later there was no poll left to write the result anywhere — a generation
that was dispatched, rendered and paid for simply vanished.

These tests pin the replacement contract:

  * the worker stamps `Node.status` on every transition it makes,
  * it merges the completion payload into `Node.data` without clobbering
    keys it cannot derive,
  * failing to do either can never strand the `Request` row, and
  * `GET /api/boards/{id}/requests?active=true` tells a reloaded page
    which generations are still worth polling.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from typing import Optional

import pytest

from flowboard.worker import processor as proc
from flowboard.worker.processor import WorkerController


def _board(client, name="T"):
    return client.post("/api/boards", json={"name": name}).json()


def _node(client, board_id, type="image", data=None):
    return client.post(
        "/api/nodes",
        json={"board_id": board_id, "type": type, "data": data or {}},
    ).json()


def _read_node(client, board_id, node_id) -> dict:
    detail = client.get(f"/api/boards/{board_id}").json()
    return next(n for n in detail["nodes"] if n["id"] == node_id)


async def _run_to_settled(client, handlers, rid, timeout_s=3.0):
    """Drive one request through a worker and return the settled row."""
    w = WorkerController(handlers=handlers)
    task = asyncio.create_task(w.start())
    try:
        w.enqueue(rid)
        current = client.get(f"/api/requests/{rid}").json()
        for _ in range(int(timeout_s / 0.05)):
            await asyncio.sleep(0.05)
            current = client.get(f"/api/requests/{rid}").json()
            if current["status"] not in ("queued", "running"):
                break
        return current
    finally:
        w.request_shutdown()
        await asyncio.wait_for(task, timeout=2.0)


# ── Node.status transitions ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_worker_stamps_node_running_then_done(client):
    """`running` has to be visible in the DB *while* the handler runs —
    that is the whole point: a reload during generation must find the
    node busy, not idle."""
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={
            "node_id": n["id"],
            "type": "gen_image",
            "params": {"prompt": "a cat", "project_id": "p1"},
        },
    ).json()

    seen_while_running: list[str] = []

    async def stub(_params):
        # Read the node from the DB at the moment the handler is mid-flight.
        seen_while_running.append(_read_node(client, b["id"], n["id"])["status"])
        return {"media_ids": ["m-1"]}, None

    settled = await _run_to_settled(client, {"gen_image": stub}, row["id"])
    assert settled["status"] == "done"
    assert seen_while_running == ["running"]
    assert _read_node(client, b["id"], n["id"])["status"] == "done"


@pytest.mark.asyncio
async def test_worker_stamps_node_error_on_failure(client):
    """`failed` and `timeout` both collapse to the node vocabulary's
    `error` — the finer distinction stays on the request row that the
    activity feed reads."""
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {}},
    ).json()

    async def stub(_params):
        return {}, "boom"

    settled = await _run_to_settled(client, {"gen_image": stub}, row["id"])
    assert settled["status"] == "failed"
    assert _read_node(client, b["id"], n["id"])["status"] == "error"


@pytest.mark.asyncio
async def test_worker_stamps_node_error_on_video_timeout(client):
    b = _board(client)
    n = _node(client, b["id"], type="video")
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_video", "params": {}},
    ).json()

    async def stub(_params):
        return {"op_errors": {}}, "timeout_waiting_video"

    settled = await _run_to_settled(client, {"gen_video": stub}, row["id"])
    assert settled["status"] == "timeout"
    assert _read_node(client, b["id"], n["id"])["status"] == "error"


@pytest.mark.asyncio
async def test_worker_stamps_node_error_on_unknown_request_type(client):
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "totally_made_up", "params": {}},
    ).json()

    settled = await _run_to_settled(client, {}, row["id"])
    assert settled["status"] == "failed"
    assert _read_node(client, b["id"], n["id"])["status"] == "error"


@pytest.mark.asyncio
async def test_worker_stamps_node_error_when_handler_raises(client):
    """The crash path stamps the node too. Without it the card keeps the
    `running` stamp from dispatch and spins forever on a request that
    already gave up."""
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {}},
    ).json()

    async def stub(_params):
        raise RuntimeError("handler exploded")

    settled = await _run_to_settled(client, {"gen_image": stub}, row["id"])
    assert settled["status"] == "failed"
    assert _read_node(client, b["id"], n["id"])["status"] == "error"


@pytest.mark.asyncio
async def test_worker_leaves_canceled_node_alone(client):
    """A canceled row keeps its status and its node is reset by the cancel
    endpoint, not by a late-arriving worker stamp."""
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {}},
    ).json()

    async def stub(_params):
        # Cancel lands while the handler is in flight, exactly as the
        # activity-bell cancel does.
        client.post(f"/api/requests/{row['id']}/cancel")
        return {"media_ids": ["m-late"]}, None

    settled = await _run_to_settled(client, {"gen_image": stub}, row["id"])
    assert settled["status"] == "canceled"
    node = _read_node(client, b["id"], n["id"])
    assert node["status"] == "idle"
    # The late result must not have been written onto the node either.
    assert "mediaId" not in node["data"]


def test_cancel_resets_node_status(client):
    """Cancelling clears the in-flight stamp so a reloaded board doesn't
    render a processing card with no request left to poll."""
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {}},
    ).json()
    # Simulate the worker having picked it up.
    client.patch(f"/api/nodes/{n['id']}", json={"status": "running"})

    assert client.post(f"/api/requests/{row['id']}/cancel").status_code == 200
    assert _read_node(client, b["id"], n["id"])["status"] == "idle"


def test_cancel_leaves_a_finished_node_status_alone(client):
    """Only an in-flight stamp is cleared — a node showing `done` from an
    earlier run must not be knocked back to idle by cancelling a newer
    request that never started."""
    b = _board(client)
    n = _node(client, b["id"])
    client.patch(f"/api/nodes/{n['id']}", json={"status": "done"})
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {}},
    ).json()

    client.post(f"/api/requests/{row['id']}/cancel")
    assert _read_node(client, b["id"], n["id"])["status"] == "done"


# ── Node.data merge ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_worker_writes_result_into_node_data(client):
    """The completion payload lands on the node without the browser being
    involved — this is the data-loss half of the reload bug."""
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={
            "node_id": n["id"],
            "type": "gen_image",
            "params": {
                "prompt": "a cat on a roof",
                "project_id": "p1",
                "aspect_ratio": "IMAGE_ASPECT_RATIO_PORTRAIT",
                "image_model": "NANO_BANANA_PRO",
            },
        },
    ).json()

    async def stub(_params):
        return {"media_ids": ["m-1", "m-2"]}, None

    await _run_to_settled(client, {"gen_image": stub}, row["id"])

    data = _read_node(client, b["id"], n["id"])["data"]
    assert data["mediaId"] == "m-1"
    assert data["mediaIds"] == ["m-1", "m-2"]
    assert data["prompt"] == "a cat on a roof"
    assert data["aspectRatio"] == "IMAGE_ASPECT_RATIO_PORTRAIT"
    assert data["imageModel"] == "NANO_BANANA_PRO"
    assert data["renderedAt"].endswith("Z")


@pytest.mark.asyncio
async def test_worker_merges_node_data_instead_of_replacing(client):
    """Keys the worker cannot derive survive untouched; the ones that
    describe *this* run are overwritten rather than inherited.

    `variantCount` and `aiBrief` belong to the second group. Leaving a
    previous run's values alone is what made a headless 1-variant re-run
    of a 4-variant node reload as four tiles with three broken, under a
    brief written for an image that is no longer there.
    """
    b = _board(client)
    n = _node(
        client,
        b["id"],
        data={
            "title": "Hero shot",
            "variantCount": 4,
            "aiBrief": "a brief from the vision pass",
            "charCountry": "vn",
        },
    )
    row = client.post(
        "/api/requests",
        json={
            "node_id": n["id"],
            "type": "gen_image",
            "params": {"prompt": "p", "project_id": "p1"},
        },
    ).json()

    async def stub(_params):
        return {"media_ids": ["m-1"]}, None

    await _run_to_settled(client, {"gen_image": stub}, row["id"])

    data = _read_node(client, b["id"], n["id"])["data"]
    assert data["title"] == "Hero shot"
    assert data["charCountry"] == "vn"
    assert data["mediaId"] == "m-1"
    # This run dispatched no `variant_count`, so one rendered image means
    # one slot — not the four the previous run left behind.
    assert data["variantCount"] == 1
    assert "aiBrief" not in data


@pytest.mark.asyncio
async def test_worker_clears_stale_partial_error_on_a_clean_run(client):
    """`error` is the one key written as a deletion — a summary left by a
    previous blocked batch must not outlive a clean re-run."""
    b = _board(client)
    n = _node(client, b["id"], data={"error": "1/4 variants blocked: FILTER"})
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {}},
    ).json()

    async def stub(_params):
        return {"media_ids": ["m-1"]}, None

    await _run_to_settled(client, {"gen_image": stub}, row["id"])
    assert "error" not in _read_node(client, b["id"], n["id"])["data"]


@pytest.mark.asyncio
async def test_worker_persists_partial_error_and_slot_errors(client):
    b = _board(client)
    n = _node(client, b["id"], type="video")
    row = client.post(
        "/api/requests",
        json={
            "node_id": n["id"],
            "type": "gen_video",
            "params": {"prompt": "p", "video_quality": "quality"},
        },
    ).json()

    async def stub(_params):
        return (
            {
                "media_ids": [None, "m-2"],
                "slot_errors": ["PUBLIC_ERROR_UNSAFE_GENERATION", None],
                "partial_error": "1/2 variants blocked: PUBLIC_ERROR_UNSAFE_GENERATION",
            },
            None,
        )

    await _run_to_settled(client, {"gen_video": stub}, row["id"])

    data = _read_node(client, b["id"], n["id"])["data"]
    # First NON-NULL id is the primary; the null placeholder keeps slot
    # alignment with the upstream image's variants.
    assert data["mediaId"] == "m-2"
    assert data["mediaIds"] == [None, "m-2"]
    assert data["slotErrors"] == ["PUBLIC_ERROR_UNSAFE_GENERATION", None]
    assert data["error"].startswith("1/2 variants blocked")
    assert data["videoQuality"] == "quality"


@pytest.mark.asyncio
async def test_worker_does_not_touch_node_media_for_a_non_media_result(client):
    """`proxy` / `create_project` rows can carry a node_id. Writing the
    media keys for them would blank whatever the node is showing."""
    b = _board(client)
    n = _node(client, b["id"], data={"mediaId": "keep-me", "mediaIds": ["keep-me"]})
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "proxy", "params": {}},
    ).json()

    async def stub(_params):
        return {"status": 200}, None

    await _run_to_settled(client, {"proxy": stub}, row["id"])

    node = _read_node(client, b["id"], n["id"])
    assert node["status"] == "done"
    assert node["data"]["mediaId"] == "keep-me"
    assert node["data"]["mediaIds"] == ["keep-me"]
    assert "renderedAt" not in node["data"]


@pytest.mark.asyncio
async def test_zero_media_from_a_media_type_is_an_error_not_a_done(client):
    """`_handle_gen_image` returns `(resp, None)` for any envelope without
    a top-level `"error"`, and an envelope where nothing rendered has an
    empty `media_ids`. Read as a success that just happens to carry no
    media, the node flips to `done` still wearing the PREVIOUS run's
    `mediaIds` / `renderedAt` — the UI shows nothing, and F5 brings back
    the old images as if they were the new ones.
    """
    b = _board(client)
    n = _node(
        client,
        b["id"],
        data={"mediaId": "old-1", "mediaIds": ["old-1"], "renderedAt": "2026-01-01T00:00:00Z"},
    )
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {"prompt": "p"}},
    ).json()

    async def stub(_params):
        return {"media_ids": [], "media_entries": []}, None

    settled = await _run_to_settled(client, {"gen_image": stub}, row["id"])
    assert settled["status"] == "failed"
    assert settled["error"] == "no_media_returned"

    node = _read_node(client, b["id"], n["id"])
    assert node["status"] == "error"
    # Untouched, exactly as on any other failed re-run: the previous
    # result is still the node's last known good one, it is just no longer
    # being passed off as this run's.
    assert node["data"]["renderedAt"] == "2026-01-01T00:00:00Z"


@pytest.mark.asyncio
async def test_all_variants_blocked_is_an_error_not_a_partial_success(client):
    """`media_ids` carries positional `null`s for blocked variants, so a
    list of nothing but placeholders is still nothing rendered."""
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={
            "node_id": n["id"],
            "type": "gen_image",
            "params": {"prompt": "p", "variant_count": 2},
        },
    ).json()

    async def stub(_params):
        return {"media_ids": [None, None], "slot_errors": ["blocked", "blocked"]}, None

    settled = await _run_to_settled(client, {"gen_image": stub}, row["id"])
    assert settled["status"] == "failed"
    assert settled["error"] == "no_media_returned"


@pytest.mark.asyncio
async def test_zero_media_from_a_non_media_type_is_still_a_success(client):
    """The check keys off `req.type`, not off the shape of the result —
    `proxy` and `create_project` legitimately settle with a bare
    envelope and must not be dragged into this."""
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "proxy", "params": {}},
    ).json()

    async def stub(_params):
        return {"status": 200}, None

    settled = await _run_to_settled(client, {"proxy": stub}, row["id"])
    assert settled["status"] == "done"
    assert _read_node(client, b["id"], n["id"])["status"] == "done"


def test_completion_patch_derives_omni_model_from_duration():
    """Omni Flash is duration-scoped, so the model key is derived rather
    than dispatched — mirrors resolve_omni_flash_model."""
    from flowboard.db.models import Request

    req = Request(type="gen_video_omni", params={"duration_s": 8})
    patch = proc._node_completion_patch(req, {"media_ids": ["m-1"]})
    assert patch["videoQuality"] == "abra_r2v_8s"

    req.params = {"duration_s": 5}
    patch = proc._node_completion_patch(req, {"media_ids": ["m-1"]})
    assert "videoQuality" not in patch


def test_completion_patch_derives_variant_count_from_dispatch():
    """`variant_count` is only stamped into params by `gen_image`. Where
    it exists it is the authority — it counts slots the user asked for,
    including ones that never rendered. Everything else falls through to
    `len(media_ids)`, which keeps its positional `null`s and so describes
    the same slot layout."""
    from flowboard.db.models import Request

    req = Request(type="gen_image", params={"prompt": "p", "variant_count": 4})
    patch = proc._node_completion_patch(req, {"media_ids": ["m-1", None, None, None]})
    assert patch["variantCount"] == 4

    req = Request(type="gen_video", params={"prompt": "p"})
    patch = proc._node_completion_patch(req, {"media_ids": ["m-1", "m-2", "m-3"]})
    assert patch["variantCount"] == 3

    # Garbage in params must not resize the grid to nonsense.
    req = Request(type="gen_image", params={"variant_count": "four"})
    patch = proc._node_completion_patch(req, {"media_ids": ["m-1", "m-2"]})
    assert patch["variantCount"] == 2


def test_completion_patch_clears_a_stale_ai_brief():
    """`aiBrief` belongs to whichever image was on the node when the
    vision pass ran. The frontend clears it with a `null` sentinel on
    every completion; the worker has to do the same or a headless run
    renders a fresh image under the old brief."""
    from flowboard.db.models import Request

    req = Request(type="gen_image", params={"prompt": "p"})
    patch = proc._node_completion_patch(req, {"media_ids": ["m-1"]})
    assert patch["aiBrief"] is None


# ── Failure isolation ─────────────────────────────────────────────────────


@contextmanager
def _terminal_node_writes_fail(*, times: Optional[int] = None):
    """Make commits that carry a *terminal* node stamp raise.

    Scoped to `done` / `error` so the dispatch transition (node →
    `running`) still goes through: we want to fail the commits that carry
    a finished result, not stop the request reaching one.

    `times=None` means every one of them, forever. That is what makes a
    test of the recovery *path* rather than of one lucky retry: if the
    re-stamp carried a node write of its own it would raise here too, the
    inner handler would swallow it, and the request would strand in
    `running` — the original bug, one level down. Under it, the only thing
    that can settle a request is a Request-only write.

    `times=1` is the realistic transient case — a brief `database is
    locked` on the node UPDATE — and lets the reconcile pass through.
    """
    from sqlalchemy import event
    from sqlalchemy.exc import OperationalError
    from sqlmodel import Session

    from flowboard.db.models import Node as NodeModel

    fired = 0

    def _explode(session, flush_context, instances):
        nonlocal fired
        if times is not None and fired >= times:
            return
        for obj in session.dirty:
            if isinstance(obj, NodeModel) and obj.status in ("done", "error"):
                fired += 1
                raise OperationalError(
                    "UPDATE node SET status=?", None,
                    Exception("database is locked"),
                )

    event.listen(Session, "before_flush", _explode)
    try:
        yield
    finally:
        event.remove(Session, "before_flush", _explode)



@pytest.mark.asyncio
async def test_node_mirror_failure_does_not_strand_the_request(client, monkeypatch):
    """A request that never settles is a dead generation; a node that
    fails to update is a stale card. The first must never be caused by
    the second.

    Narrow by construction: swapping `proc.Node` for an unmapped class
    makes `Session.get()` raise `NoInspectionAvailable` *before* it
    touches the database, so this only covers a node lookup that blows up
    on the Python side. The flush and commit failures — the ones that can
    actually cost a paid result — are covered by
    `test_a_failing_node_write_cannot_discard_a_successful_generation`.
    """
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {}},
    ).json()

    # Not a mapped class — Session.get() blows up on it, which is as close
    # as we can get to "the node write went wrong" without faking the ORM.
    class _NotAModel:
        pass

    monkeypatch.setattr(proc, "Node", _NotAModel)

    async def stub(_params):
        return {"media_ids": ["m-1"]}, None

    settled = await _run_to_settled(client, {"gen_image": stub}, row["id"])
    assert settled["status"] == "done"
    assert settled["error"] is None


@pytest.mark.asyncio
async def test_a_failing_node_write_cannot_discard_a_successful_generation(client):
    """The sharpest edge in the whole mirror.

    The Request stamp and the Node mirror share one commit. When that
    commit is what fails — a `StaleDataError` because the node was deleted
    between the lookup and the flush, `database is locked`, anything — the
    old code let the exception reach the worker's outer handler, which
    opened a fresh session and wrote `status="failed"`. The generation had
    already rendered and been paid for; its `result` (and the media ids in
    it) went in the bin.

    The mirror is best-effort. The Request stamp is not.
    """
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {"prompt": "p"}},
    ).json()

    async def stub(_params):
        return {"media_ids": ["m-1", "m-2"]}, None

    with _terminal_node_writes_fail(times=1):
        settled = await _run_to_settled(client, {"gen_image": stub}, row["id"])

    assert settled["status"] == "done"
    assert settled["error"] is None
    # The whole point: the media ids survived the failed mirror.
    assert settled["result"]["media_ids"] == ["m-1", "m-2"]

    # ...and the node caught up. Dropping the node half is what saves the
    # result, but leaving it dropped is its own bug: nothing else would
    # ever reconcile it. `/requests?active=true` skips this row now that it
    # is terminal, and the startup sweep only looks at in-flight requests,
    # so a card left on `running` would spin forever on a generation that
    # finished — for a reloaded or closed tab, which is precisely the case
    # this mirror exists to serve.
    node = _read_node(client, b["id"], n["id"])
    assert node["status"] == "done"
    assert node["data"]["mediaIds"] == ["m-1", "m-2"]

    active = client.get(
        f"/api/boards/{b['id']}/requests", params={"active": "true"}
    ).json()["items"]
    assert active == [], "a terminal request is not re-offered for polling"


@pytest.mark.asyncio
async def test_a_permanently_failing_node_write_still_settles_the_request(client):
    """The floor, when the reconcile pass fails too.

    Request correct and complete; node stale. That is the deliberate
    trade — and the fact that the request still settles under a node write
    that NEVER succeeds is what proves the recovery path carries no node
    write of its own.
    """
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {"prompt": "p"}},
    ).json()

    async def stub(_params):
        return {"media_ids": ["m-1"]}, None

    with _terminal_node_writes_fail():
        settled = await _run_to_settled(client, {"gen_image": stub}, row["id"])

    assert settled["status"] == "done"
    assert settled["result"]["media_ids"] == ["m-1"]
    assert _read_node(client, b["id"], n["id"])["status"] == "running"


def test_a_failing_rollback_cannot_rewrite_a_success_as_a_failure(client):
    """`rollback()` can itself raise on an invalidated connection.

    It sat outside the except's own try, so a raising rollback escaped
    `_commit_settlement` entirely and reached `_process_one`'s outer
    handler — which hardcodes `failed`. Two lines of gap, leading to
    exactly the outcome this function exists to prevent: a generation that
    succeeded, recorded as failed, with its media ids binned.

    Driven directly rather than through the worker so both failures land
    on the same session deterministically.
    """
    from datetime import datetime, timezone

    from sqlalchemy.exc import OperationalError

    from flowboard.db import get_session

    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {"prompt": "p"}},
    ).json()

    def _locked(*_a, **_kw):
        raise OperationalError("COMMIT", None, Exception("database is locked"))

    with get_session() as s:
        # Instance attributes, so nothing leaks to other sessions — the
        # retry and reconcile passes open their own and must still work.
        s.commit = _locked
        s.rollback = _locked
        proc._commit_settlement(
            s,
            rid=row["id"],
            stamp={
                "status": "done",
                "error": None,
                "result": {"media_ids": ["m-1"]},
                "finished_at": datetime.now(timezone.utc),
            },
            node_id=n["id"],
            node_status="done",
            node_data_patch={"mediaIds": ["m-1"], "mediaId": "m-1"},
        )

    settled = client.get(f"/api/requests/{row['id']}").json()
    assert settled["status"] == "done"
    assert settled["error"] is None
    assert settled["result"]["media_ids"] == ["m-1"]
    assert _read_node(client, b["id"], n["id"])["status"] == "done"


@pytest.mark.parametrize(
    "req_type, handler_err, expected_status, expected_error",
    [
        ("gen_image", None, "done", None),
        ("gen_image", "flow_rejected_prompt", "failed", "flow_rejected_prompt"),
        ("gen_video", "timeout_waiting_video", "timeout", "timeout_waiting_video"),
    ],
)
@pytest.mark.asyncio
async def test_a_failing_node_write_preserves_the_requests_real_outcome(
    client, req_type, handler_err, expected_status, expected_error
):
    """The recovery re-stamp replays the outcome that was actually
    determined — not a hardcoded `failed`.

    `timeout` is the one that shows the difference plainly: it exists so
    the UI can render a soft auto-cancel instead of a generation error, and
    falling back to the worker's generic failure handler would flatten it.
    `result` has to survive all three, because even a failed run's envelope
    is what the activity feed and any retry read.
    """
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": req_type, "params": {"prompt": "p"}},
    ).json()

    async def stub(_params):
        return {"media_ids": ["m-1"], "trace": "kept"}, handler_err

    with _terminal_node_writes_fail():
        settled = await _run_to_settled(client, {req_type: stub}, row["id"])

    assert settled["status"] == expected_status
    assert settled["error"] == expected_error
    assert settled["result"]["trace"] == "kept"
    assert settled["finished_at"] is not None


@pytest.mark.asyncio
async def test_a_node_deleted_between_the_lookup_and_the_commit(client):
    """The other reachable `StaleDataError`, and the one the
    delete-inside-the-handler test cannot reach.

    `_mirror_node` loads the Node and dirties it; the UPDATE goes out at
    `commit()`. A delete landing in that window makes the flush match zero
    rows, which SQLAlchemy raises on. The request must still settle with
    its real outcome.
    """
    from sqlalchemy import event, text
    from sqlmodel import Session

    from flowboard.db.models import Node as NodeModel

    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {"prompt": "p"}},
    ).json()

    def _delete_the_node_mid_flush(session, flush_context, instances):
        for obj in session.dirty:
            if isinstance(obj, NodeModel) and obj.status == "done":
                # Same connection, so the pending UPDATE really does find
                # nothing — this is the race, not a simulation of it.
                session.connection().execute(
                    text("DELETE FROM node WHERE id = :id"), {"id": obj.id}
                )

    async def stub(_params):
        return {"media_ids": ["m-1"]}, None

    event.listen(Session, "before_flush", _delete_the_node_mid_flush)
    try:
        settled = await _run_to_settled(client, {"gen_image": stub}, row["id"])
    finally:
        event.remove(Session, "before_flush", _delete_the_node_mid_flush)

    assert settled["status"] == "done"
    assert settled["error"] is None
    assert settled["result"]["media_ids"] == ["m-1"]


def test_mirror_node_does_not_flush_the_pending_request(client):
    """`session.get()` autoflushes by default.

    That is how a node lookup used to drag the caller's pending Request
    stamp into a flush that `_mirror_node`'s own `except` then swallowed —
    leaving the Session rollback-pending, so the caller's `commit()` died
    with `PendingRollbackError` far away from anything that knew what the
    request's real outcome was.
    """
    from sqlalchemy import event

    from flowboard.db import get_session
    from flowboard.db.models import Request

    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {}},
    ).json()

    flushes: list[int] = []
    with get_session() as s:
        req = s.get(Request, row["id"])
        req.status = "done"
        s.add(req)

        event.listen(s, "after_flush", lambda *_a: flushes.append(1))
        proc._mirror_node(s, n["id"], status="done", data_patch={"mediaId": "m-1"})
        assert flushes == [], "node lookup flushed the pending Request stamp"

        s.commit()

    assert client.get(f"/api/requests/{row['id']}").json()["status"] == "done"
    assert _read_node(client, b["id"], n["id"])["status"] == "done"


@pytest.mark.asyncio
async def test_completion_patch_failure_does_not_strand_the_request(
    client, monkeypatch
):
    """Same guarantee for the other half — building the payload is wrapped
    separately from applying it."""
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {}},
    ).json()

    def _explode(_req, _result):
        raise ValueError("patch builder exploded")

    monkeypatch.setattr(proc, "_node_completion_patch", _explode)

    async def stub(_params):
        return {"media_ids": ["m-1"]}, None

    settled = await _run_to_settled(client, {"gen_image": stub}, row["id"])
    assert settled["status"] == "done"
    # Status still mirrored — only the data half was lost.
    assert _read_node(client, b["id"], n["id"])["status"] == "done"


@pytest.mark.asyncio
async def test_node_deleted_mid_flight_still_settles_the_request(client):
    """delete_node detaches requests rather than deleting them, so the row
    outlives its node and has to settle with nothing to mirror onto.

    The delete lands inside the handler, i.e. before the completion
    session opens, so this covers the easy branch: `session.get()` returns
    None and there is simply nothing to write. The hard one — a delete
    landing between that lookup and the commit, which is a real
    `StaleDataError` — is
    `test_a_node_deleted_between_the_lookup_and_the_commit`.
    """
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={"node_id": n["id"], "type": "gen_image", "params": {}},
    ).json()

    async def stub(_params):
        client.delete(f"/api/nodes/{n['id']}")
        return {"media_ids": ["m-1"]}, None

    settled = await _run_to_settled(client, {"gen_image": stub}, row["id"])
    assert settled["status"] == "done"


# ── GET /api/boards/{id}/requests ─────────────────────────────────────────


def test_board_requests_active_filter(client):
    """`active=true` is what a reloading page asks for: only the rows the
    worker can still move, so it doesn't re-attach polls to finished work."""
    b = _board(client)
    n = _node(client, b["id"])

    def _mk(status):
        row = client.post(
            "/api/requests",
            json={"node_id": n["id"], "type": "gen_image", "params": {"prompt": "p"}},
        ).json()
        if status != "queued":
            from flowboard.db import get_session
            from flowboard.db.models import Request

            with get_session() as s:
                r = s.get(Request, row["id"])
                r.status = status
                s.add(r)
                s.commit()
        return row["id"]

    queued_id = _mk("queued")
    running_id = _mk("running")
    done_id = _mk("done")
    failed_id = _mk("failed")
    canceled_id = _mk("canceled")

    active = client.get(f"/api/boards/{b['id']}/requests?active=true")
    assert active.status_code == 200
    ids = {it["id"] for it in active.json()["items"]}
    assert ids == {queued_id, running_id}

    every = client.get(f"/api/boards/{b['id']}/requests")
    assert {it["id"] for it in every.json()["items"]} == {
        queued_id, running_id, done_id, failed_id, canceled_id
    }


def test_board_requests_active_excludes_non_worker_types(client):
    """`vision`, `auto_prompt` and `auto_prompt_batch` open a `running`
    Request row against a node too (services/activity.py), but they run
    synchronously inside their own HTTP handler and are never queued to
    the worker — so a reloading page has nothing to wait on.

    Handing them out was not merely useless: their result carries no
    `media_ids`, the poll loop reads that absence as an empty media list
    and spreads it over `Node.data`, and the image the user is looking at
    disappears off the canvas until the next reload.

    Filtering by what the worker DOES dispatch rather than by the known
    offenders is the point: `auto_prompt_batch` is a fourth node-attached
    activity type, and the next one lands excluded without a code change.
    """
    from flowboard.db import get_session
    from flowboard.db.models import Request

    b = _board(client)
    n = _node(client, b["id"])

    def _mk(type_, status):
        with get_session() as s:
            row = Request(node_id=n["id"], type=type_, status=status, params={})
            s.add(row)
            s.commit()
            s.refresh(row)
            return row.id

    vision_id = _mk("vision", "running")
    auto_prompt_id = _mk("auto_prompt", "running")
    batch_id = _mk("auto_prompt_batch", "running")
    running_gen_id = _mk("gen_image", "running")
    queued_gen_id = _mk("gen_video", "queued")

    items = client.get(f"/api/boards/{b['id']}/requests?active=true").json()["items"]
    assert {it["id"] for it in items} == {running_gen_id, queued_gen_id}

    # ...and the full listing stays honest: it is a debugging view of what
    # the board actually holds, not a resume feed.
    every = client.get(f"/api/boards/{b['id']}/requests").json()["items"]
    assert {it["id"] for it in every} == {
        vision_id, auto_prompt_id, batch_id, running_gen_id, queued_gen_id
    }


def test_resumable_types_are_all_worker_dispatched(client):
    """The resume filter is only safe while every type in it is one the
    worker actually drains — a type the worker never picks up would sit
    `queued` forever with a browser polling it."""
    from flowboard.routes.boards import RESUMABLE_REQUEST_TYPES

    assert set(RESUMABLE_REQUEST_TYPES) <= set(proc._DEFAULT_HANDLERS)


def test_board_requests_item_shape(client):
    """`params` rides along because the resuming page rebuilds the poll's
    options from it — the dispatch call that held them died with the old
    page."""
    b = _board(client)
    n = _node(client, b["id"])
    row = client.post(
        "/api/requests",
        json={
            "node_id": n["id"],
            "type": "gen_image",
            "params": {"prompt": "a cat", "aspect_ratio": "IMAGE_ASPECT_RATIO_SQUARE"},
        },
    ).json()

    item = client.get(f"/api/boards/{b['id']}/requests?active=true").json()["items"][0]
    assert item == {
        "id": row["id"],
        "type": "gen_image",
        "status": "queued",
        "node_id": n["id"],
        "node_short_id": n["short_id"],
        "created_at": item["created_at"],
        "params": {"prompt": "a cat", "aspect_ratio": "IMAGE_ASPECT_RATIO_SQUARE"},
    }
    assert item["created_at"].endswith("Z")


def test_board_requests_are_board_scoped(client):
    """The reason this exists instead of reusing /api/activity: a resume
    must not re-attach polls for another board's nodes."""
    b1 = _board(client, "one")
    b2 = _board(client, "two")
    n1 = _node(client, b1["id"])
    n2 = _node(client, b2["id"])
    r1 = client.post(
        "/api/requests",
        json={"node_id": n1["id"], "type": "gen_image", "params": {}},
    ).json()
    client.post(
        "/api/requests",
        json={"node_id": n2["id"], "type": "gen_image", "params": {}},
    )

    items = client.get(f"/api/boards/{b1['id']}/requests?active=true").json()["items"]
    assert [it["id"] for it in items] == [r1["id"]]


def test_board_requests_excludes_unattached_rows(client):
    """A request reaches a board only through its node, so standalone rows
    (and rows detached by a node delete) are not board-scoped."""
    b = _board(client)
    client.post("/api/requests", json={"type": "create_project", "params": {}})
    items = client.get(f"/api/boards/{b['id']}/requests").json()["items"]
    assert items == []


def test_board_requests_missing_board_returns_404(client):
    assert client.get("/api/boards/999/requests").status_code == 404
