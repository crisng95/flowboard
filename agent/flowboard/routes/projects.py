"""Bootstrap a Google Flow project for a local board.

One-to-one: each board gets exactly one `flow_project_id`. The bootstrap is
idempotent — calling POST multiple times returns the same project id without
creating a new one on labs.google.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from flowboard.db import get_session
from flowboard.db.models import Board, BoardFlowProject
from flowboard.services.flow_sdk import get_flow_sdk, is_valid_project_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/boards", tags=["board-projects"])


@router.get("/{board_id}/project")
def get_board_project(board_id: int):
    with get_session() as s:
        if not s.get(Board, board_id):
            raise HTTPException(404, "board not found")
        row = s.get(BoardFlowProject, board_id)
        if row is None:
            raise HTTPException(404, "no project bound to this board")
        return {"flow_project_id": row.flow_project_id, "created": False}


@router.post("/{board_id}/project")
async def ensure_board_project(board_id: int):
    # Cheap path: DB hit only.
    with get_session() as s:
        board = s.get(Board, board_id)
        if not board:
            raise HTTPException(404, "board not found")
        row = s.get(BoardFlowProject, board_id)
        if row is not None:
            return {"flow_project_id": row.flow_project_id, "created": False}
        board_name = board.name

    # Release the session before the extension round-trip.
    resp = await get_flow_sdk().create_project(title=board_name or "Untitled")
    if resp.get("error"):
        # Surface the extension/TRPC error cleanly to the caller.
        raise HTTPException(
            status_code=502,
            detail={"message": resp["error"], "raw": resp.get("raw")},
        )
    flow_project_id = resp.get("project_id")
    if not isinstance(flow_project_id, str) or not flow_project_id:
        raise HTTPException(
            status_code=502,
            detail={"message": "no project_id in Flow response", "raw": resp.get("raw")},
        )
    # Defense-in-depth: refuse to persist a project_id that would later be
    # rejected by the worker's validator. Keeps the DB clean of anything that
    # could be URL-injected by a future code path.
    if not is_valid_project_id(flow_project_id):
        raise HTTPException(
            status_code=502,
            detail={
                "message": "invalid project_id shape from Flow",
                "raw": resp.get("raw"),
            },
        )

    # Persist. Guard against concurrent callers that may have beaten us to it.
    with get_session() as s:
        existing = s.get(BoardFlowProject, board_id)
        if existing is not None:
            return {"flow_project_id": existing.flow_project_id, "created": False}
        row = BoardFlowProject(board_id=board_id, flow_project_id=flow_project_id)
        s.add(row)
        s.commit()
        s.refresh(row)
        logger.info("bound board %s → flow_project %s", board_id, flow_project_id)
        return {"flow_project_id": row.flow_project_id, "created": True}
