"""Provider-job queue — the handoff between the agent and external workers.

The "Muse" provider (Pax, the assistant itself) is a *delegated* backend:
producers (the LLM layer, the media path) insert a QUEUED row and block in
:func:`wait_for_provider_job`; an external worker claims rows through
``routes/provider_jobs.py``, does the work with its own tools, and posts
the result back.

Lease protocol (ported from flowkit's provider-job queue):
- ``claim`` grants a lease (``lease_expires_at``); only the lease holder
  may heartbeat / progress / complete / fail a live job.
- Heartbeats extend the lease and flip CLAIMED → RUNNING.
- complete/fail are idempotent for the lease holder on an already-terminal
  row; a stranger's attempt is rejected (returns None → 409 at the HTTP
  layer).
- A crashed worker's lease expires and the job becomes reclaimable, so
  jobs are never stranded.

All functions are synchronous on SQLModel sessions (the app's ``get_session``
is sync); :func:`wait_for_provider_job` is the one async entry point, used
by producers that already run inside the worker's event loop.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import or_, and_
from sqlmodel import select, update

from flowboard.db import get_session
from flowboard.db.models import ProviderJob

logger = logging.getLogger(__name__)

# ── job kinds ─────────────────────────────────────────────────────────────
KIND_LLM = "llm"                # prompt (+system, attachments) -> text
KIND_IMAGE = "image"            # prompt (+refs) -> image
KIND_EDIT_IMAGE = "edit_image"  # source image + prompt -> edited image
KIND_VIDEO = "video"            # start frame -> video (i2v)
KIND_VIDEO_REFS = "video_refs"  # reference images -> video (r2v)

TERMINAL_STATUSES = ("SUCCEEDED", "FAILED", "CANCELLED")
LIVE_STATUSES = ("CLAIMED", "RUNNING")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def create_provider_job(
    *,
    provider: str,
    kind: str,
    prompt: str = "",
    orientation: Optional[str] = None,
    source_url: Optional[str] = None,
    start_url: Optional[str] = None,
    end_url: Optional[str] = None,
    reference_urls: Optional[list] = None,
    extra: Optional[dict] = None,
    job_id: Optional[str] = None,
) -> ProviderJob:
    """Insert a QUEUED job. Returns the row (detached; re-fetch to observe)."""
    jid = job_id or uuid.uuid4().hex
    now = _utcnow()
    with get_session() as s:
        job = ProviderJob(
            id=jid,
            provider=provider.strip().lower(),
            kind=kind,
            status="QUEUED",
            prompt=prompt or "",
            orientation=orientation,
            source_url=source_url,
            start_url=start_url,
            end_url=end_url,
            reference_urls=list(reference_urls or []),
            extra=dict(extra or {}),
            created_at=now,
            updated_at=now,
        )
        s.add(job)
        s.commit()
        s.refresh(job)
        s.expunge(job)
        return job


def get_provider_job(job_id: str) -> Optional[ProviderJob]:
    with get_session() as s:
        job = s.get(ProviderJob, job_id)
        if job is None:
            return None
        s.expunge(job)
        return job


def list_provider_jobs(
    *,
    provider: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 100,
) -> list[ProviderJob]:
    with get_session() as s:
        stmt = select(ProviderJob).order_by(ProviderJob.created_at.desc()).limit(limit)
        if provider:
            stmt = stmt.where(ProviderJob.provider == provider.strip().lower())
        if status:
            stmt = stmt.where(ProviderJob.status == status)
        rows = s.exec(stmt).all()
        for r in rows:
            s.expunge(r)
        return list(rows)

def _claimable_filter(now: datetime):
    """QUEUED rows, plus live rows whose lease expired (crashed worker)."""
    return or_(
        ProviderJob.status == "QUEUED",
        and_(
            ProviderJob.status.in_(LIVE_STATUSES),
            or_(
                ProviderJob.lease_expires_at.is_(None),
                ProviderJob.lease_expires_at <= now,
            ),
        ),
    )


def claim_next_provider_job(
    provider: str, worker_id: str, lease_ttl_s: float = 300
) -> Optional[ProviderJob]:
    """Claim the oldest claimable job for a provider (non-blocking).

    Select-then-claim: two workers may SELECT the same row, but the
    guarded claim UPDATE below only lets one of them win (rowcount 0
    for the loser), so the race is harmless.
    """
    with get_session() as s:
        row_id = s.exec(
            select(ProviderJob.id)
            .where(ProviderJob.provider == provider.strip().lower())
            .where(ProviderJob.status.not_in(TERMINAL_STATUSES))
            .where(_claimable_filter(_utcnow()))
            .order_by(ProviderJob.created_at.asc())
            .limit(1)
        ).first()
    if row_id is None:
        return None
    return claim_provider_job(row_id, worker_id, lease_ttl_s)


def claim_provider_job(
    job_id: str, worker_id: str, lease_ttl_s: float = 300
) -> Optional[ProviderJob]:
    """Claim one specific job. None when it isn't claimable.

    The UPDATE is atomic and guarded by status/lease, so concurrent
    claimants can't double-claim: exactly one sees rowcount 1.
    """
    now = _utcnow()
    expiry = datetime.fromtimestamp(now.timestamp() + lease_ttl_s, tz=timezone.utc)
    with get_session() as s:
        stmt = (
            update(ProviderJob)
            .where(ProviderJob.id == job_id)
            .where(ProviderJob.status.not_in(TERMINAL_STATUSES))
            .where(_claimable_filter(now))
            .values(
                status="CLAIMED",
                claimed_by=worker_id,
                claimed_at=now,
                lease_expires_at=expiry,
                updated_at=now,
            )
        )
        result = s.exec(stmt)
        s.commit()
        if not result.rowcount:
            return None
        job = s.get(ProviderJob, job_id)
        if job is None:
            return None
        s.expunge(job)
        return job


def heartbeat_provider_job(
    job_id: str, worker_id: str, lease_ttl_s: float = 300
) -> Optional[ProviderJob]:
    """Extend the lease. Only the lease holder on a live job."""
    now = _utcnow()
    expiry = datetime.fromtimestamp(now.timestamp() + lease_ttl_s, tz=timezone.utc)
    with get_session() as s:
        stmt = (
            update(ProviderJob)
            .where(ProviderJob.id == job_id)
            .where(ProviderJob.claimed_by == worker_id)
            .where(ProviderJob.status.in_(LIVE_STATUSES))
            .values(lease_expires_at=expiry, updated_at=now)
        )
        result = s.exec(stmt)
        # First heartbeat also flips CLAIMED → RUNNING.
        if result.rowcount:
            s.exec(
                update(ProviderJob)
                .where(ProviderJob.id == job_id)
                .where(ProviderJob.status == "CLAIMED")
                .values(status="RUNNING")
            )
        s.commit()
        if not result.rowcount:
            return None
        job = s.get(ProviderJob, job_id)
        if job is None:
            return None
        s.expunge(job)
        return job


def report_provider_job_progress(
    job_id: str, worker_id: str, progress: int, message: Optional[str] = None
) -> Optional[ProviderJob]:
    with get_session() as s:
        stmt = (
            update(ProviderJob)
            .where(ProviderJob.id == job_id)
            .where(ProviderJob.claimed_by == worker_id)
            .where(ProviderJob.status.in_(LIVE_STATUSES))
            .values(
                progress=max(0, min(100, int(progress))),
                progress_message=message,
                updated_at=_utcnow(),
            )
        )
        result = s.exec(stmt)
        s.commit()
        if not result.rowcount:
            return None
        job = s.get(ProviderJob, job_id)
        if job is None:
            return None
        s.expunge(job)
        return job


def complete_provider_job(
    job_id: str, worker_id: str, result: Optional[dict] = None
) -> Optional[ProviderJob]:
    """Complete as the lease holder. Idempotent on already-terminal rows."""
    with get_session() as s:
        job = s.get(ProviderJob, job_id)
        if job is None:
            return None
        if job.status in TERMINAL_STATUSES:
            # Idempotent: the lease holder re-completing returns the row;
            # anyone else (or a job that ended FAILED/CANCELLED) is rejected.
            if job.claimed_by == worker_id and job.status == "SUCCEEDED":
                s.expunge(job)
                return job
            return None
        if job.claimed_by != worker_id or job.status not in LIVE_STATUSES:
            return None
        job.status = "SUCCEEDED"
        job.result = dict(result or {})
        job.progress = 100
        job.updated_at = _utcnow()
        s.add(job)
        s.commit()
        s.refresh(job)
        s.expunge(job)
        return job


def fail_provider_job(
    job_id: str, worker_id: str, error: str = ""
) -> Optional[ProviderJob]:
    """Fail as the lease holder. Idempotent for already-FAILED rows."""
    with get_session() as s:
        job = s.get(ProviderJob, job_id)
        if job is None:
            return None
        if job.status in TERMINAL_STATUSES:
            if job.claimed_by == worker_id and job.status == "FAILED":
                s.expunge(job)
                return job
            return None
        if job.claimed_by != worker_id or job.status not in LIVE_STATUSES:
            return None
        job.status = "FAILED"
        job.error_message = (error or "unknown error")[:2000]
        job.updated_at = _utcnow()
        s.add(job)
        s.commit()
        s.refresh(job)
        s.expunge(job)
        return job


def cancel_provider_job(job_id: str) -> Optional[ProviderJob]:
    """Producer-side cancel. Rejected once the job is terminal."""
    with get_session() as s:
        job = s.get(ProviderJob, job_id)
        if job is None or job.status in TERMINAL_STATUSES:
            return None
        job.status = "CANCELLED"
        job.updated_at = _utcnow()
        s.add(job)
        s.commit()
        s.refresh(job)
        s.expunge(job)
        return job


async def wait_for_provider_job(
    job_id: str, timeout_s: float = 600, poll_interval_s: float = 2.0
) -> Optional[ProviderJob]:
    """Block until the job reaches a terminal status. None on timeout."""
    import time as _time

    deadline = _time.monotonic() + timeout_s
    while True:
        job = await asyncio.to_thread(get_provider_job, job_id)
        if job is None:
            return None
        if job.status in TERMINAL_STATUSES:
            return job
        if _time.monotonic() >= deadline:
            return None
        await asyncio.sleep(min(poll_interval_s, max(0.1, deadline - _time.monotonic())))
