"""Activity feed — read-only surface over the Request table.

Existing worker-driven types (gen_image / gen_video / edit_image) are
already logged here by `worker/processor.py`. LLM call sites
(auto_prompt / vision / planner) and upload routes will start wrapping
their calls in `services/activity.record_activity` so they show up in
the same feed — see `.omc/plans/activity-logs.md`.

Endpoints:
  GET  /api/activity?limit=50&before_id=N&type=auto_prompt,vision
       → list-projection (no params/result/error) sorted DESC by id
       → cursor pagination via `next_before_id`
  GET  /api/activity/{id}
       → full row including params, result, error
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Node, Request

router = APIRouter(prefix="/api/activity", tags=["activity"])


def _duration_ms(req: Request) -> Optional[int]:
    """Return finished_at − created_at in ms, or None if still running."""
    if req.finished_at is None:
        return None
    delta = req.finished_at - req.created_at
    return int(delta.total_seconds() * 1000)


@router.get("")
def list_activity(
    limit: int = Query(50, ge=1, le=200),
    before_id: Optional[int] = Query(None, ge=1),
    type: Optional[str] = Query(None, description="Comma-separated type filter"),
) -> dict:
    """Return the most recent N activity rows in DESC order by id.

    `before_id` is a cursor — passing the `next_before_id` from a prior
    response yields the next older page. Avoids the offset-pagination
    consistency hazard for an actively-changing feed.
    """
    type_filter: Optional[set[str]] = None
    if type:
        type_filter = {t.strip() for t in type.split(",") if t.strip()}

    with get_session() as s:
        stmt = select(Request).order_by(Request.id.desc()).limit(limit)
        if before_id is not None:
            stmt = stmt.where(Request.id < before_id)
        if type_filter:
            stmt = stmt.where(Request.type.in_(type_filter))
        rows = s.exec(stmt).all()

        # Resolve node_short_id in one round trip via a join keyed by
        # the distinct node_ids in this page.
        node_ids = {r.node_id for r in rows if r.node_id is not None}
        short_ids: dict[int, str] = {}
        if node_ids:
            for n in s.exec(select(Node).where(Node.id.in_(node_ids))).all():
                if n.id is not None:
                    short_ids[n.id] = n.short_id

    items = [
        {
            "id": r.id,
            "type": r.type,
            "status": r.status,
            "node_id": r.node_id,
            "node_short_id": short_ids.get(r.node_id) if r.node_id else None,
            "created_at": r.created_at.isoformat(),
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "duration_ms": _duration_ms(r),
        }
        for r in rows
    ]
    next_before_id = rows[-1].id if len(rows) == limit and rows else None
    return {"items": items, "next_before_id": next_before_id}


@router.get("/{request_id}")
def get_activity_detail(request_id: int) -> dict:
    """Return the full row including params (input), result (output),
    error. Used by the UI's detail modal."""
    with get_session() as s:
        req = s.get(Request, request_id)
        if req is None:
            raise HTTPException(404, "activity not found")
        node_short_id: Optional[str] = None
        if req.node_id is not None:
            n = s.get(Node, req.node_id)
            if n is not None:
                node_short_id = n.short_id
    return {
        "id": req.id,
        "type": req.type,
        "status": req.status,
        "node_id": req.node_id,
        "node_short_id": node_short_id,
        "params": req.params,
        "result": req.result,
        "error": req.error,
        "created_at": req.created_at.isoformat(),
        "finished_at": req.finished_at.isoformat() if req.finished_at else None,
        "duration_ms": _duration_ms(req),
    }
