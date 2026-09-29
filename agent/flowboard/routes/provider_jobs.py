"""Provider-job API — the handoff queue between the agent and external workers.

A producer (the Muse LLM provider, the Muse media path) creates a QUEUED
job; a consumer (an external worker — Pax, the assistant itself) claims it,
heartbeats while working, and completes/fails it. Long-poll endpoints let
both sides wait without busy-looping.

    Producer flow:  POST /api/provider-jobs            -> {id}
                    GET  /api/provider-jobs/{id}/wait  -> terminal row

    Worker flow:    GET /api/provider-jobs/wait-next?provider=muse&worker_id=w1
                    POST /api/provider-jobs/{id}/heartbeat   (every ~lease/3)
                    POST /api/provider-jobs/{id}/progress    (optional)
                    POST /api/provider-jobs/{id}/complete    (or /fail)

Ownership: heartbeat/progress/complete/fail are accepted only from the
worker that holds the lease (claimed_by == worker_id) while the job is
live (CLAIMED/RUNNING). complete/fail are idempotent for the lease holder —
repeating them on an already-terminal job returns the existing row. cancel
is producer-side and rejected once the job is terminal.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from flowboard.services import provider_jobs as pq
from flowboard.services import worker_presence

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/provider-jobs", tags=["provider-jobs"])

DEFAULT_LEASE_TTL_S = 300
POLL_INTERVAL_S = 2.0


# ── models ────────────────────────────────────────────────────────────


class ProviderJobCreate(BaseModel):
    provider: str = Field(..., description="Target backend: muse")
    kind: str = Field(
        ..., description="llm | image | edit_image | video | video_refs"
    )
    prompt: str = ""
    orientation: Optional[str] = None
    source_url: Optional[str] = None
    start_url: Optional[str] = None
    end_url: Optional[str] = None
    reference_urls: Optional[list[str]] = None
    extra: Optional[dict] = None
    job_id: Optional[str] = None


class HeartbeatBody(BaseModel):
    worker_id: str
    lease_ttl_s: float = DEFAULT_LEASE_TTL_S


class ProgressBody(BaseModel):
    worker_id: str
    progress: int = Field(..., ge=0, le=100)
    message: Optional[str] = None


class CompleteBody(BaseModel):
    worker_id: str
    result: Optional[dict] = None


class FailBody(BaseModel):
    worker_id: str
    error: str = ""


def _serialize(job) -> Optional[dict]:
    if job is None:
        return None
    d = job.model_dump()
    # datetimes → ISO strings for JSON
    for k in ("claimed_at", "lease_expires_at", "created_at", "updated_at"):
        v = d.get(k)
        if v is not None and hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


# ── producer endpoints ────────────────────────────────────────────────


@router.post("")
def create_job(body: ProviderJobCreate):
    job = pq.create_provider_job(
        provider=body.provider,
        kind=body.kind,
        prompt=body.prompt,
        orientation=body.orientation,
        source_url=body.source_url,
        start_url=body.start_url,
        end_url=body.end_url,
        reference_urls=body.reference_urls,
        extra=body.extra,
        job_id=body.job_id,
    )
    return _serialize(job)


@router.get("")
def list_jobs(
    provider: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None),
    limit: int = Query(default=100, le=500),
):
    return [_serialize(j) for j in pq.list_provider_jobs(
        provider=provider, status=status, limit=limit)]


@router.get("/workers/status")
def workers_status(provider: str = Query(default="muse")):
    """Which workers are currently listening (presence, advisory)."""
    return {
        "provider": provider,
        "workers": worker_presence.recent_workers(provider),
    }


# NOTE: static sub-paths are declared before /{job_id} so they can't be
# shadowed by the path parameter.


@router.get("/wait-next")
async def wait_next_job(
    provider: str = Query(...),
    worker_id: str = Query(...),
    lease_ttl_s: float = Query(default=DEFAULT_LEASE_TTL_S),
    timeout_s: float = Query(default=60, le=600),
):
    """Long-poll: wait for the next claimable job for a provider, then claim it.

    Returns the claimed job row, or 204 when the timeout expires with nothing
    available. This is the primary endpoint external workers poll.
    """
    worker_presence.touch(provider, worker_id)
    deadline = time.monotonic() + timeout_s
    while True:
        job = pq.claim_next_provider_job(provider, worker_id, lease_ttl_s)
        if job:
            logger.info("provider_job %s claimed by %s", job.id[:12], worker_id)
            return _serialize(job)
        if time.monotonic() >= deadline:
            return JSONResponse(status_code=204, content=None)
        await asyncio.sleep(min(POLL_INTERVAL_S, max(0.1, deadline - time.monotonic())))


@router.get("/{job_id}")
def get_job(job_id: str):
    job = pq.get_provider_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="provider job not found")
    return _serialize(job)


@router.get("/{job_id}/wait")
async def wait_job(job_id: str, timeout_s: float = Query(default=600, le=3600)):
    """Long-poll: wait until a job reaches a terminal status.

    404 when the job doesn't exist; 204 when the timeout expires first.
    """
    job = await pq.wait_for_provider_job(
        job_id, timeout_s=timeout_s, poll_interval_s=POLL_INTERVAL_S
    )
    if job is None:
        if pq.get_provider_job(job_id) is None:
            raise HTTPException(status_code=404, detail="provider job not found")
        return JSONResponse(status_code=204, content=None)
    return _serialize(job)


# ── worker endpoints ──────────────────────────────────────────────────


@router.post("/next")
def claim_next_job(body: HeartbeatBody, provider: str = Query(...)):
    """Claim the oldest available job for a provider (non-blocking)."""
    worker_presence.touch(provider, body.worker_id)
    job = pq.claim_next_provider_job(provider, body.worker_id, body.lease_ttl_s)
    if job is None:
        raise HTTPException(status_code=404, detail="no claimable job available")
    return _serialize(job)


@router.post("/{job_id}/heartbeat")
def heartbeat_job(job_id: str, body: HeartbeatBody):
    existing = pq.get_provider_job(job_id)
    if existing is not None:
        worker_presence.touch(existing.provider, body.worker_id)
    job = pq.heartbeat_provider_job(job_id, body.worker_id, body.lease_ttl_s)
    if job is None:
        raise HTTPException(
            status_code=409,
            detail="heartbeat rejected (not the lease holder or job not running)",
        )
    return _serialize(job)


@router.post("/{job_id}/progress")
def progress_job(job_id: str, body: ProgressBody):
    """Report progress. 409 unless the caller holds the lease on a live job."""
    job = pq.report_provider_job_progress(
        job_id, body.worker_id, body.progress, body.message
    )
    if job is None:
        raise HTTPException(
            status_code=409,
            detail="progress rejected (not the lease holder or job not live)",
        )
    return _serialize(job)


@router.post("/{job_id}/complete")
def complete_job(job_id: str, body: CompleteBody):
    """Complete a job as its lease holder. Idempotent: re-completing an
    already-SUCCEEDED job returns the existing row. 409 otherwise."""
    job = pq.complete_provider_job(job_id, body.worker_id, body.result)
    if job is None:
        raise HTTPException(
            status_code=409,
            detail="complete rejected (not the lease holder, "
            "job not live, or ended in another terminal state)",
        )
    return _serialize(job)


@router.post("/{job_id}/fail")
def fail_job(job_id: str, body: FailBody):
    """Fail a job as its lease holder. Idempotent for already-FAILED jobs;
    a SUCCEEDED/CANCELLED job cannot be failed. 409 otherwise."""
    job = pq.fail_provider_job(job_id, body.worker_id, body.error)
    if job is None:
        raise HTTPException(
            status_code=409,
            detail="fail rejected (not the lease holder, "
            "job not live, or already succeeded/cancelled)",
        )
    return _serialize(job)


@router.post("/{job_id}/cancel")
def cancel_job(job_id: str):
    """Producer-side cancel. 409 when the job is missing or already terminal."""
    job = pq.cancel_provider_job(job_id)
    if job is None:
        raise HTTPException(
            status_code=409, detail="cancel rejected (job missing or already terminal)"
        )
    return _serialize(job)
