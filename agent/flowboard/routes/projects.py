"""Bind a local board to a Google Flow project.

Each board holds exactly one `flow_project_id`, and the binding is
idempotent: calling POST repeatedly returns the same id without creating
anything.

It no longer creates a Flow project either, because Flow stopped letting it.
`project.createProject` lived on the labs.google tRPC frontend that the
September 2026 migration unauthenticated, so the binding now points at the
pinned FLOWBOARD_FLOW_PROJECT_ID and the response carries `reused: true` —
boards share one Flow workspace rather than owning one each. Generation is
unaffected; every RPC only needs *a* project.
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
    #
    # Flow cannot create a project any more, so this hands back the pinned one
    # (`reused: True`). Persisting that as the board's binding is deliberate:
    # it is what the board will actually generate into, so recording it is
    # accurate. What is lost is per-board isolation, and Flow no longer offers
    # it — boards share one Flow workspace. The `reused` flag is passed through
    # so a caller is never told a project was created when none was.
    resp = await get_flow_sdk().create_project(title=board_name or "Untitled")
    if resp.get("error"):
        raise HTTPException(
            status_code=502,
            detail={"message": resp["error"], "raw": resp.get("raw")},
        )
    reused = bool(resp.get("reused"))
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
        logger.info(
            "bound board %s → flow_project %s%s",
            board_id, flow_project_id, " (pinned, shared)" if reused else "",
        )
        return {
            "flow_project_id": row.flow_project_id,
            # A binding was created locally; the Flow project was not.
            "created": not reused,
            "reused": reused,
        }
