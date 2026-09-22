"""One-way sync: ensure each Flowboard board has a live Flow project.

This is a LOCAL → FLOW direction sync. We do NOT import Flow's project
list into Flowboard's UI. The flow:

  GET  /api/flow/projects  → per-board sync status (does this board's
                              flow_project_id still exist on Flow?)
  POST /api/flow/projects/sync-up → for every board whose flow_project_id
                                     is missing on Flow (or no binding
                                     at all), CREATE a new Flow project
                                     and update BoardFlowProject so the
                                     dashboard's projects exist on Flow's
                                     side too. Idempotent: boards that
                                     already exist on Flow are left
                                     untouched.

The Flow project list used to be fetched internally (via the labs.google
TRPC search endpoint) just to diff against local binds.

SINCE THE SEPTEMBER 2026 MIGRATION BOTH HALVES OF THAT ARE GONE. Flow has no
batchexecute RPC for listing a user's projects, and none for creating one, so:

  * ``GET`` still reports every board's binding, but ``exists_on_flow`` is
    ``null`` (unknown) rather than ``false`` — claiming a project is missing
    when we simply cannot look is worse than admitting we cannot look.
  * ``POST /sync-up`` refuses with 501. It could technically "succeed" by
    binding every board to the one pinned Flow project, but that would record
    a shared workspace as if each board owned it.

Generation does not depend on any of this: a board with no binding falls back
to the pinned project. See flow_sdk.search_user_projects.

Which project that is used to be settable only in ``.env``. It is now settable
at runtime through ``GET``/``PUT /api/flow/projects/pinned`` and resolved
everywhere via ``flow_project.effective_project_id`` — the routes below
included, because a status endpoint that reported the env value while
generation used an override would be worse than not reporting one at all.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from flowboard.db import get_session
from flowboard.db.models import Board, BoardFlowProject
from flowboard.services.flow_project import (
    effective_project_id,
    project_setting,
    set_override,
)
from flowboard.services.flow_sdk import get_flow_sdk, is_valid_project_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/flow/projects", tags=["flow-projects"])


async def _remote_project_ids(tool: str) -> tuple[set[str], Optional[str]]:
    """Try to pull the user's Flow project id set.

    Returns ``(ids, unavailable_reason)``. On the current transport the reason
    is always set, because Flow exposes no project-listing RPC — but this is
    written as a probe rather than a hardcoded refusal so that capturing one
    later is a change in ``flow_sdk``, not here.
    """
    result = await get_flow_sdk().list_user_projects_all(tool=tool)
    if result.get("error"):
        return set(), str(result["error"])
    projects = result.get("projects") or []
    ids = {
        p["project_id"] for p in projects
        if isinstance(p, dict) and p.get("project_id")
    }
    return ids, None


@router.get("")
async def get_sync_status(tool: str = "PINHOLE"):
    """Per-board sync status. Does NOT expose the Flow project list —
    this is a one-way sync (local → Flow), so the frontend only needs
    to know which boards are still synced.

    Response:
        {
          "board_status": [
            {board_id, board_name, flow_project_id, exists_on_flow},
            ...
          ],
          "flow_listing": {"available": bool, "reason": str|null,
                           "pinned_project_id": str|null}
        }

    ``exists_on_flow`` is ``null`` when Flow's project list could not be read
    — which is every time on the current transport. The bindings themselves
    are still real and worth showing, so this degrades rather than 502s.
    """
    remote_ids, unavailable = await _remote_project_ids(tool)
    with get_session() as s:
        boards = s.query(Board).order_by(Board.created_at.desc()).all()
        binds = {
            b.board_id: b.flow_project_id
            for b in s.query(BoardFlowProject).all()
        }
        board_status = []
        for b in boards:
            pid: Optional[str] = binds.get(b.id)
            if unavailable:
                exists = None
            elif pid:
                exists = pid in remote_ids
            else:
                exists = False
            board_status.append({
                "board_id": b.id,
                "board_name": b.name,
                "flow_project_id": pid,
                "exists_on_flow": exists,
            })
    return {
        "board_status": board_status,
        "flow_listing": {
            "available": unavailable is None,
            "reason": unavailable,
            "pinned_project_id": effective_project_id() or None,
        },
    }


class PinnedProjectUpdate(BaseModel):
    """Body of ``PUT /pinned``. ``None`` (or ``""``) clears the override."""
    flow_project_id: Optional[str] = None


@router.get("/pinned")
def get_pinned_project():
    """The Flow project everything generates into, and where it came from.

    Deliberately on ``/pinned`` under the existing plural prefix rather than a
    new top-level ``/api/flow/project``: one character between two live routes
    is a trap, and this genuinely is a property of the project collection.

    Response: ``{"flow_project_id": str|null, "source": "override"|"env"|"none",
    "env_project_id": str|null}``.
    """
    return project_setting()


@router.put("/pinned")
def set_pinned_project(body: PinnedProjectUpdate):
    """Pin a Flow project at runtime, or clear the pin back to ``.env``.

    Answers the same shape as ``GET`` plus ``rebound_boards`` — how many
    boards were moved off the previous effective project onto this one. That
    count is not decoration: boards persist their own binding, so a change
    here that did not move them would leave them generating into the old
    project. See ``flow_project._rebind_boards`` for which rows move.

    A malformed id is a 400 whose ``detail`` says how to find the right value,
    and nothing is written.
    """
    try:
        rebound = set_override(body.flow_project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {**project_setting(), "rebound_boards": rebound}


@router.post("/sync-up")
async def sync_up(tool: str = "PINHOLE"):
    """Push every orphan board up to Flow. For each board where the
    bound flow_project_id is missing from Flow's remote list (or no
    binding exists at all), create a new Flow project and replace the
    BoardFlowProject row.

    Idempotent: boards already in sync are skipped. Returns a per-board
    action log so the UI can summarise ("synced N boards").

    Answers 501 while Flow exposes no way to create a project. It is important
    that this refuses instead of degrading: ``create_project`` now hands back
    the single pinned project, so "succeeding" here would write that same uuid
    into every board's binding and record a shared Flow workspace as if each
    board owned one.
    """
    remote_ids, unavailable = await _remote_project_ids(tool)
    if unavailable:
        raise HTTPException(
            status_code=501,
            detail={
                "message": (
                    "Flow no longer exposes project creation or listing, so "
                    "boards cannot be pushed up individually."
                ),
                "reason": unavailable,
                "fix": (
                    "Create one project in the Flow UI and pin its uuid — in "
                    "Settings, or as FLOWBOARD_FLOW_PROJECT_ID. Boards with no "
                    "binding use it automatically, so generation keeps working."
                ),
                "pinned_project_id": effective_project_id() or None,
            },
        )

    # Snapshot the boards that need work. Read-only pass to avoid
    # holding the session during the TRPC round-trips below.
    with get_session() as s:
        boards = s.query(Board).all()
        binds = {
            b.board_id: b.flow_project_id
            for b in s.query(BoardFlowProject).all()
        }
        to_sync = [
            (b.id, b.name, binds.get(b.id))
            for b in boards
            if binds.get(b.id) is None or binds.get(b.id) not in remote_ids
        ]

    actions: list[dict] = []
    sdk = get_flow_sdk()

    for board_id, board_name, old_pid in to_sync:
        resp = await sdk.create_project(title=board_name or "Untitled")
        if resp.get("error"):
            actions.append({
                "board_id": board_id,
                "board_name": board_name,
                "old_flow_project_id": old_pid,
                "new_flow_project_id": None,
                "status": "failed",
                "error": str(resp["error"])[:200],
            })
            continue
        new_pid = resp.get("project_id")
        if not isinstance(new_pid, str) or not is_valid_project_id(new_pid):
            actions.append({
                "board_id": board_id,
                "board_name": board_name,
                "old_flow_project_id": old_pid,
                "new_flow_project_id": None,
                "status": "failed",
                "error": "invalid project_id from Flow",
            })
            continue

        with get_session() as s:
            row = s.get(BoardFlowProject, board_id)
            if row is None:
                row = BoardFlowProject(
                    board_id=board_id, flow_project_id=new_pid
                )
            else:
                row.flow_project_id = new_pid
            s.add(row)
            s.commit()
        logger.info(
            "sync-up: board %s %s → new flow_project %s",
            board_id,
            f"(was {old_pid})" if old_pid else "(no prior bind)",
            new_pid,
        )
        actions.append({
            "board_id": board_id,
            "board_name": board_name,
            "old_flow_project_id": old_pid,
            "new_flow_project_id": new_pid,
            "status": "rebound" if old_pid else "created",
            "error": None,
        })

    return {
        "synced": [a for a in actions if a["status"] in ("created", "rebound")],
        "failed": [a for a in actions if a["status"] == "failed"],
        "total_boards": len(to_sync) + (
            # boards that were already synced
            len([1 for b in (binds.values()) if isinstance(b, str) and b in remote_ids])
        ),
    }
