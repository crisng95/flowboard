"""Tests for the provider-job queue, the Muse LLM provider, and muse media routing.

The queue is the handoff between the agent and external workers (the Muse
provider = Pax, the assistant itself). Lifecycle:
QUEUED -> CLAIMED -> RUNNING -> SUCCEEDED | FAILED | CANCELLED.
"""
from __future__ import annotations

import threading
import time
from unittest.mock import AsyncMock, patch

import pytest

from flowboard.services import provider_jobs as pq
from flowboard.services import worker_presence
from flowboard.services.llm.base import LLMError


@pytest.fixture(autouse=True)
def _reset_worker_presence():
    """worker_presence is process-global; tests must not see each other's polls."""
    worker_presence._seen.clear()
    yield
    worker_presence._seen.clear()


# ── queue lifecycle ───────────────────────────────────────────────────


def test_full_lifecycle_claim_heartbeat_progress_complete():
    job = pq.create_provider_job(provider="muse", kind="llm", prompt="hi")
    assert job.status == "QUEUED"

    claimed = pq.claim_provider_job(job.id, "w1")
    assert claimed is not None and claimed.status == "CLAIMED"
    assert claimed.claimed_by == "w1"
    assert claimed.lease_expires_at is not None

    hb = pq.heartbeat_provider_job(job.id, "w1")
    assert hb is not None and hb.status == "RUNNING"  # first heartbeat flips it

    prog = pq.report_provider_job_progress(job.id, "w1", 42, "halfway")
    assert prog is not None and prog.progress == 42
    assert prog.progress_message == "halfway"

    done = pq.complete_provider_job(job.id, "w1", {"text": "hello"})
    assert done.status == "SUCCEEDED"
    assert done.result == {"text": "hello"}
    assert pq.get_provider_job(job.id).status == "SUCCEEDED"


def test_claim_is_exclusive():
    job = pq.create_provider_job(provider="muse", kind="llm")
    assert pq.claim_provider_job(job.id, "w1") is not None
    # Second worker can't steal a live lease.
    assert pq.claim_provider_job(job.id, "w2") is None
    # Neither can it heartbeat / progress / complete / fail.
    assert pq.heartbeat_provider_job(job.id, "w2") is None
    assert pq.report_provider_job_progress(job.id, "w2", 10) is None
    assert pq.complete_provider_job(job.id, "w2", {}) is None
    assert pq.fail_provider_job(job.id, "w2", "x") is None


def test_expired_lease_is_reclaimable():
    job = pq.create_provider_job(provider="muse", kind="llm")
    # Claim with an already-expired lease (crashed worker).
    assert pq.claim_provider_job(job.id, "w1", lease_ttl_s=-1) is not None
    reclaimed = pq.claim_provider_job(job.id, "w2")
    assert reclaimed is not None and reclaimed.claimed_by == "w2"


def test_complete_fail_idempotent_for_lease_holder():
    job = pq.create_provider_job(provider="muse", kind="llm")
    pq.claim_provider_job(job.id, "w1")
    first = pq.complete_provider_job(job.id, "w1", {"text": "t"})
    again = pq.complete_provider_job(job.id, "w1", {"text": "t"})
    assert again is not None and again.status == "SUCCEEDED"
    # But a stranger still can't touch the terminal row.
    assert pq.complete_provider_job(job.id, "w2", {}) is None
    # And a succeeded job can't be failed, even by the holder.
    assert pq.fail_provider_job(job.id, "w1", "x") is None

    job2 = pq.create_provider_job(provider="muse", kind="llm")
    pq.claim_provider_job(job2.id, "w1")
    pq.fail_provider_job(job2.id, "w1", "boom")
    again2 = pq.fail_provider_job(job2.id, "w1", "boom")
    assert again2 is not None and again2.status == "FAILED"
    assert again2.error_message == "boom"


def test_cancel_and_terminal_guard():
    job = pq.create_provider_job(provider="muse", kind="llm")
    assert pq.cancel_provider_job(job.id) is not None
    assert pq.get_provider_job(job.id).status == "CANCELLED"
    # Terminal rows can't be cancelled, claimed, or completed.
    assert pq.cancel_provider_job(job.id) is None
    assert pq.claim_provider_job(job.id, "w1") is None
    assert pq.complete_provider_job(job.id, "w1", {}) is None


def test_claim_next_oldest_first_and_provider_scoped():
    j1 = pq.create_provider_job(provider="muse", kind="llm")
    j2 = pq.create_provider_job(provider="muse", kind="llm")
    other = pq.create_provider_job(provider="other", kind="llm")
    first = pq.claim_next_provider_job("muse", "w1")
    assert first is not None and first.id == j1.id
    second = pq.claim_next_provider_job("muse", "w1")
    assert second is not None and second.id == j2.id
    assert pq.claim_next_provider_job("muse", "w1") is None
    # Other provider's job untouched and still claimable under its name.
    assert pq.claim_next_provider_job("other", "w1") is not None
    assert other.id is not None


def test_list_filtering():
    pq.create_provider_job(provider="muse", kind="llm")
    pq.create_provider_job(provider="muse", kind="image")
    assert len(pq.list_provider_jobs(provider="muse")) == 2
    assert len(pq.list_provider_jobs(status="QUEUED")) == 2
    assert pq.list_provider_jobs(provider="nope") == []


@pytest.mark.asyncio
async def test_wait_for_provider_job_resolves_on_complete():
    job = pq.create_provider_job(provider="muse", kind="llm")

    def worker():
        time.sleep(0.3)
        pq.claim_provider_job(job.id, "w1")
        pq.complete_provider_job(job.id, "w1", {"text": "done"})

    threading.Thread(target=worker, daemon=True).start()
    final = await pq.wait_for_provider_job(job.id, timeout_s=10)
    assert final is not None and final.status == "SUCCEEDED"


@pytest.mark.asyncio
async def test_wait_for_provider_job_timeout():
    job = pq.create_provider_job(provider="muse", kind="llm")
    final = await pq.wait_for_provider_job(
        job.id, timeout_s=0.5, poll_interval_s=0.1
    )
    assert final is None


# ── worker presence ───────────────────────────────────────────────────


def test_worker_presence_window():
    assert worker_presence.any_recent("muse") is False
    worker_presence.touch("muse", "w1")
    assert worker_presence.any_recent("muse") is True
    # Outside the window it's gone.
    assert worker_presence.any_recent("muse", within_s=0.0) is False
    recent = worker_presence.recent_workers("muse")
    assert recent and recent[0]["worker_id"] == "w1"


# ── Muse LLM provider ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_muse_provider_run_success():
    from flowboard.services.llm.muse import MuseProvider

    real_create = pq.create_provider_job

    def fake_create(**kwargs):
        job = real_create(**kwargs)
        assert job.provider == "muse" and job.kind == "llm"

        def worker():
            time.sleep(0.3)
            pq.claim_provider_job(job.id, "w1")
            pq.complete_provider_job(job.id, "w1", {"text": "hello from pax"})

        threading.Thread(target=worker, daemon=True).start()
        return job

    with patch.object(pq, "create_provider_job", fake_create):
        text = await MuseProvider().run("hi", timeout=10)
    assert text == "hello from pax"


@pytest.mark.asyncio
async def test_muse_provider_run_timeout_without_worker():
    from flowboard.services.llm.muse import MuseProvider

    with pytest.raises(LLMError, match="timed out"):
        await MuseProvider().run("hi", timeout=0.5)


@pytest.mark.asyncio
async def test_muse_provider_run_worker_failure():
    from flowboard.services.llm.muse import MuseProvider

    real_create = pq.create_provider_job

    def fake_create(**kwargs):
        job = real_create(**kwargs)

        def worker():
            time.sleep(0.2)
            pq.claim_provider_job(job.id, "w1")
            pq.fail_provider_job(job.id, "w1", "render exploded")

        threading.Thread(target=worker, daemon=True).start()
        return job

    with patch.object(pq, "create_provider_job", fake_create):
        with pytest.raises(LLMError, match="render exploded"):
            await MuseProvider().run("hi", timeout=10)


@pytest.mark.asyncio
async def test_muse_provider_availability_is_presence_driven():
    from flowboard.services.llm.muse import MuseProvider

    p = MuseProvider()
    assert await p.is_available() is False
    worker_presence.touch("muse", "w9")
    assert await p.is_available() is True


@pytest.mark.asyncio
async def test_muse_provider_list_models():
    from flowboard.services.llm.muse import MuseProvider

    models = await MuseProvider().list_models()
    assert models and models[0]["id"] == "muse-spark"


# ── HTTP routes ───────────────────────────────────────────────────────


def test_provider_job_routes_end_to_end(client):
    # Create
    resp = client.post(
        "/api/provider-jobs",
        json={"provider": "muse", "kind": "llm", "prompt": "ping"},
    )
    assert resp.status_code == 200
    job_id = resp.json()["id"]
    assert resp.json()["status"] == "QUEUED"

    # wait-next claims it (and touches presence)
    resp = client.get(
        "/api/provider-jobs/wait-next",
        params={"provider": "muse", "worker_id": "w1", "timeout_s": 1},
    )
    assert resp.status_code == 200
    assert resp.json()["id"] == job_id
    assert resp.json()["status"] == "CLAIMED"

    # presence is now visible
    workers = client.get(
        "/api/provider-jobs/workers/status", params={"provider": "muse"}
    ).json()
    assert any(w["worker_id"] == "w1" for w in workers["workers"])

    # heartbeat -> RUNNING
    resp = client.post(
        f"/api/provider-jobs/{job_id}/heartbeat", json={"worker_id": "w1"}
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "RUNNING"

    # progress by a stranger is rejected
    resp = client.post(
        f"/api/provider-jobs/{job_id}/progress",
        json={"worker_id": "intruder", "progress": 50},
    )
    assert resp.status_code == 409

    # complete by the holder
    resp = client.post(
        f"/api/provider-jobs/{job_id}/complete",
        json={"worker_id": "w1", "result": {"text": "pong"}},
    )
    assert resp.status_code == 200
    assert resp.json()["result"] == {"text": "pong"}

    # idempotent re-complete
    resp = client.post(
        f"/api/provider-jobs/{job_id}/complete",
        json={"worker_id": "w1", "result": {"text": "pong"}},
    )
    assert resp.status_code == 200

    # terminal job can't be failed
    resp = client.post(
        f"/api/provider-jobs/{job_id}/fail",
        json={"worker_id": "w1", "error": "x"},
    )
    assert resp.status_code == 409

    # list + get
    assert client.get("/api/provider-jobs").status_code == 200
    assert client.get(f"/api/provider-jobs/{job_id}").status_code == 200
    assert client.get("/api/provider-jobs/does-not-exist").status_code == 404


def test_wait_next_empty_returns_204(client):
    resp = client.get(
        "/api/provider-jobs/wait-next",
        params={"provider": "muse", "worker_id": "w1", "timeout_s": 1},
    )
    assert resp.status_code == 204


def test_wait_endpoint_terminal_and_missing(client):
    job = pq.create_provider_job(provider="muse", kind="llm")
    pq.claim_provider_job(job.id, "w1")
    pq.complete_provider_job(job.id, "w1", {"text": "t"})
    resp = client.get(f"/api/provider-jobs/{job.id}/wait", params={"timeout_s": 5})
    assert resp.status_code == 200
    assert resp.json()["status"] == "SUCCEEDED"

    resp = client.get("/api/provider-jobs/missing/wait", params={"timeout_s": 1})
    assert resp.status_code == 404


def test_cancel_endpoint(client):
    resp = client.post(
        "/api/provider-jobs", json={"provider": "muse", "kind": "image"}
    )
    job_id = resp.json()["id"]
    assert client.post(f"/api/provider-jobs/{job_id}/cancel").status_code == 200
    # Second cancel on a terminal row -> 409
    assert client.post(f"/api/provider-jobs/{job_id}/cancel").status_code == 409


# ── processor routing ─────────────────────────────────────────────────


def test_media_provider_of_defaults_and_overrides():
    from flowboard.worker.processor import _media_provider_of

    assert _media_provider_of({}) == "flow"
    assert _media_provider_of({"media_provider": "muse"}) == "muse"
    assert _media_provider_of({"media_provider": "flow"}) == "flow"
    # Unknown values fail closed to the existing behaviour.
    assert _media_provider_of({"media_provider": "bogus"}) == "flow"
    assert _media_provider_of({"media_provider": " Muse "}) == "muse"


def test_orientation_from_aspect():
    from flowboard.worker.processor import _orientation_from_aspect

    assert _orientation_from_aspect("IMAGE_ASPECT_RATIO_PORTRAIT") == "VERTICAL"
    assert _orientation_from_aspect("VIDEO_ASPECT_RATIO_LANDSCAPE") == "HORIZONTAL"
    assert _orientation_from_aspect("SQUARE") is None
    assert _orientation_from_aspect(None) is None


@pytest.mark.asyncio
async def test_gen_image_routes_to_muse_queue():
    from flowboard.worker import processor

    seen = {}

    async def fake_run_muse_media(**kwargs):
        seen.update(kwargs)
        return ({"media_ids": ["mid1"], "media_entries": []}, None)

    with patch(
        "flowboard.services.muse_media.run_muse_media", fake_run_muse_media
    ):
        result, error = await processor._handle_gen_image(
            {
                "prompt": "a cat",
                "media_provider": "muse",
                "aspect_ratio": "IMAGE_ASPECT_RATIO_PORTRAIT",
                "variant_count": 2,
            }
        )
    assert error is None
    assert result["media_ids"] == ["mid1"]
    assert seen["kind"] == "image"
    assert seen["orientation"] == "VERTICAL"
    assert seen["extra"]["variant_count"] == 2


@pytest.mark.asyncio
async def test_gen_image_muse_skips_project_validation():
    """Muse needs no Flow project — empty/missing project_id must not fail."""
    from flowboard.worker import processor

    async def fake_run_muse_media(**kwargs):
        return ({"media_ids": ["m1"], "media_entries": []}, None)

    with patch(
        "flowboard.services.muse_media.run_muse_media", fake_run_muse_media
    ):
        result, error = await processor._handle_gen_image(
            {"prompt": "a cat", "media_provider": "muse"}
        )
    assert error is None
    assert result["media_ids"] == ["m1"]


@pytest.mark.asyncio
async def test_gen_image_flow_still_requires_project():
    """The Flow path is untouched: missing project still fails loud."""
    from flowboard.worker import processor

    _result, error = await processor._handle_gen_image({"prompt": "a cat"})
    assert error == "missing_project_id"


@pytest.mark.asyncio
async def test_gen_video_muse_requires_start_frame():
    from flowboard.worker import processor

    _result, error = await processor._handle_gen_video(
        {"prompt": "move", "media_provider": "muse"}
    )
    assert error == "missing_start_media_id"


@pytest.mark.asyncio
async def test_edit_image_muse_dispatch_shape():
    from flowboard.worker import processor

    seen = {}

    async def fake_run_muse_media(**kwargs):
        seen.update(kwargs)
        return ({"media_ids": ["e1"], "media_entries": []}, None)

    with patch(
        "flowboard.services.muse_media.run_muse_media", fake_run_muse_media
    ):
        result, error = await processor._handle_edit_image(
            {
                "prompt": "make it rain",
                "media_provider": "muse",
                "source_media_id": "src123",
                "ref_media_ids": ["r1"],
            }
        )
    assert error is None
    assert seen["kind"] == "edit_image"
    assert seen["source_media_ids"] == ["src123"]
    assert seen["reference_media_ids"] == ["r1"]


@pytest.mark.asyncio
async def test_gen_video_omni_muse_dispatch_shape():
    from flowboard.worker import processor

    seen = {}

    async def fake_run_muse_media(**kwargs):
        seen.update(kwargs)
        return ({"media_ids": ["v1"], "media_entries": []}, None)

    with patch(
        "flowboard.services.muse_media.run_muse_media", fake_run_muse_media
    ):
        result, error = await processor._handle_gen_video_omni(
            {
                "prompt": "animate",
                "media_provider": "muse",
                "ref_media_ids": ["r1", "r2"],
                "duration_s": 6,
                "aspect_ratio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
            }
        )
    assert error is None
    assert seen["kind"] == "video_refs"
    assert seen["reference_media_ids"] == ["r1", "r2"]
    assert seen["extra"]["duration_s"] == 6
    assert seen["orientation"] == "HORIZONTAL"


@pytest.mark.asyncio
async def test_run_muse_media_imports_file_output(tmp_path):
    """End-to-end-ish: a worker completes with a file:// output; the agent
    imports the bytes into the media cache and returns media_ids."""
    from flowboard.services import muse_media

    img = tmp_path / "render.png"
    img.write_bytes(b"\x89PNG-fake-bytes")

    real_create = pq.create_provider_job

    def fake_create(**kwargs):
        job = real_create(**kwargs)

        def worker():
            time.sleep(0.3)
            pq.claim_provider_job(job.id, "w1")
            pq.complete_provider_job(
                job.id, "w1", {"outputs": [{"output_url": f"file://{img}"}]}
            )

        threading.Thread(target=worker, daemon=True).start()
        return job

    with patch.object(pq, "create_provider_job", fake_create), patch.object(
        muse_media.config, "MUSE_MEDIA_TIMEOUT_S", 10
    ):
        result, error = await muse_media.run_muse_media(
            kind="image", prompt="a cat"
        )
    assert error is None
    assert len(result["media_ids"]) == 1
    mid = result["media_ids"][0]
    # Bytes landed in the cache and serve from /media/{id}.
    from flowboard.services import media as media_service

    assert media_service.cached_path(mid) is not None


@pytest.mark.asyncio
async def test_run_muse_media_no_worker_error():
    from flowboard.services import muse_media

    with patch.object(muse_media.config, "MUSE_MEDIA_TIMEOUT_S", 0.5):
        _result, error = await muse_media.run_muse_media(
            kind="image", prompt="a cat"
        )
    assert error is not None and "muse_no_worker" in error
