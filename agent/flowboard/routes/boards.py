from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import delete as sql_delete, select

from flowboard.db import get_session
from flowboard.db.models import (
    Asset,
    Board,
    BoardFlowProject,
    ChatMessage,
    Edge,
    Node,
    PipelineRun,
    Plan,
    PlanRevision,
    Request,
)
# Shared rather than re-implemented: `utc_iso` is the single place that
# knows SQLite hands datetimes back naive, and that a missing `Z` makes
# every timestamp read 7h early on a UTC+7 client. See its docstring.
from flowboard.timestamps import utc_iso
# Same reason: how request types are classified is shared with the worker
# rather than restated here. See `list_board_requests`.
from flowboard.request_types import MEDIA_PRODUCING_TYPES, SIDECAR_REQUEST_TYPES

router = APIRouter(prefix="/api/boards", tags=["boards"])

# In-flight = the statuses the worker can still move a row out of.
# `done` / `failed` / `timeout` / `canceled` are all terminal.
ACTIVE_REQUEST_STATUSES = ("queued", "running")

# ...and in-flight is not enough on its own: `vision` and `auto_prompt`
# also open a `running` Request row (services/activity.py), against a node,
# and they settle it themselves inside their own HTTP handler. They are
# never queued to the worker, so there is nothing for a resumed poll to
# wait on — and handing one to the GENERATION poll is actively
# destructive, because their result carries no `media_ids` and that poll
# reads the absence as "this node rendered nothing".
#
# So the listing is keyed by kind, not by a single "resumable" flag: a
# caller names the kinds it can actually handle, and gets nothing else.
# `MEDIA_PRODUCING_TYPES` is exactly the set the worker dispatches AND
# whose result a generation poll can act on; `SIDECAR_REQUEST_TYPES` is
# the synchronous LLM set, which needs its own much smaller poll.
RESUMABLE_REQUEST_TYPES = tuple(sorted(MEDIA_PRODUCING_TYPES))
SIDECAR_RESUMABLE_TYPES = tuple(sorted(SIDECAR_REQUEST_TYPES))

# `worker` stays the default so a caller that says nothing — including
# every caller written before sidecar resume existed — keeps getting only
# the rows a generation poll can safely act on. Opting into `sidecar` is
# a deliberate act by a caller that has somewhere to put text results.
REQUEST_KINDS: dict[str, tuple[str, ...]] = {
    "worker": RESUMABLE_REQUEST_TYPES,
    "sidecar": SIDECAR_RESUMABLE_TYPES,
}
DEFAULT_REQUEST_KINDS = "worker"


class BoardCreate(BaseModel):
    name: str


class BoardUpdate(BaseModel):
    name: str


@router.get("")
def list_boards():
    with get_session() as s:
        return s.exec(select(Board)).all()


@router.post("")
def create_board(body: BoardCreate):
    with get_session() as s:
        board = Board(name=body.name)
        s.add(board)
        s.commit()
        s.refresh(board)
        return board


@router.get("/{board_id}")
def get_board(board_id: int):
    with get_session() as s:
        board = s.get(Board, board_id)
        if not board:
            raise HTTPException(404, "board not found")
        nodes = s.exec(select(Node).where(Node.board_id == board_id)).all()
        edges = s.exec(select(Edge).where(Edge.board_id == board_id)).all()
        return {"board": board, "nodes": nodes, "edges": edges}


@router.get("/{board_id}/requests")
def list_board_requests(
    board_id: int,
    active: bool = Query(
        False, description="Only return in-flight (queued / running) rows"
    ),
    kinds: str = Query(
        DEFAULT_REQUEST_KINDS,
        description=(
            "Comma-separated request kinds to include when active=true: "
            "`worker` (media-producing generations) and/or `sidecar` "
            "(synchronous LLM activities). Ignored when active=false."
        ),
    ),
    limit: int = Query(100, ge=1, le=500),
) -> dict:
    """Requests belonging to this board, newest first.

    Exists so a freshly-loaded board can find the work that is still in
    flight and re-attach a poll to it. The backend keeps `Node.status` and
    `Node.data` current on its own — the worker for generations, the
    service itself for the sidecar activities — but nothing tells a
    reloaded page WHICH requests are still moving, and a node parked on
    `running` (or on "Analyzing…") with nobody watching it never picks up
    its result.

    `/api/activity` answers almost the same question and is not reusable
    here: it has no board filter, so a board-scoped resume would re-attach
    polls for nodes that aren't on screen.

    `params` rides along because the frontend rebuilds the poll's options
    (prompt, aspect ratio) from it — the dispatch call that originally held
    them died with the old page.

    Requests reach a board only through their Node, so rows with a NULL
    `node_id` — standalone `proxy` / `create_project` calls, and rows
    detached by a node delete — are not board-scoped and never listed here.

    `active=true` narrows by type as well as status, to the kinds the
    caller asked for (see `REQUEST_KINDS`); `active=false` deliberately
    does not narrow at all. The full listing is a debugging view and
    should stay honest about every row the board carries, including the
    types no caller resumes (`planner`, and anything added since).
    """
    selected: list[str] = []
    for raw in kinds.split(","):
        kind = raw.strip()
        if not kind:
            continue
        if kind not in REQUEST_KINDS:
            raise HTTPException(
                400,
                f"unknown request kind {kind!r}; expected one of "
                f"{', '.join(sorted(REQUEST_KINDS))}",
            )
        selected.extend(REQUEST_KINDS[kind])
    if not selected:
        # `kinds=` / `kinds=,` is a caller bug, not a request for
        # everything. Falling back to the default keeps the unsafe
        # reading ("no filter") unreachable.
        selected = list(REQUEST_KINDS[DEFAULT_REQUEST_KINDS])

    with get_session() as s:
        if not s.get(Board, board_id):
            raise HTTPException(404, "board not found")
        # Join rather than a second query: `node_short_id` is what the
        # activity feed labels rows with, and the frontend uses it for the
        # same purpose when reporting a resumed generation.
        stmt = (
            select(Request, Node.short_id)
            .join(Node, Request.node_id == Node.id)
            .where(Node.board_id == board_id)
        )
        if active:
            stmt = stmt.where(Request.status.in_(ACTIVE_REQUEST_STATUSES))
            stmt = stmt.where(Request.type.in_(selected))
        stmt = stmt.order_by(Request.id.desc()).limit(limit)
        rows = s.exec(stmt).all()

        return {
            "items": [
                {
                    "id": req.id,
                    "type": req.type,
                    "status": req.status,
                    "node_id": req.node_id,
                    "node_short_id": short_id,
                    "created_at": utc_iso(req.created_at),
                    "params": req.params,
                }
                for req, short_id in rows
            ]
        }


@router.patch("/{board_id}")
def update_board(board_id: int, body: BoardUpdate):
    with get_session() as s:
        board = s.get(Board, board_id)
        if not board:
            raise HTTPException(404, "board not found")
        board.name = body.name
        s.add(board)
        s.commit()
        s.refresh(board)
        return board


@router.delete("/{board_id}")
def delete_board(board_id: int):
    """Cascade-delete a board and everything that hangs off it.

    SQLite enforces FK constraints, so we have to clear children before
    the parent. Order:
      Asset(node_id) → Request(node_id) → Node
      PipelineRun(plan_id) → PlanRevision(plan_id) → Plan
      Edge → ChatMessage → BoardFlowProject → Board.

    Note: this only removes the *local* mapping to a Google Flow project.
    The Flow project itself is NOT deleted — Flow exposes no delete-project
    RPC on the transport we use. Since the September 2026 migration it also
    exposes no create-project RPC, so boards share one pinned Flow project
    and deleting it by hand in the Flow UI would affect every board.
    """
    with get_session() as s:
        board = s.get(Board, board_id)
        if not board:
            raise HTTPException(404, "board not found")

        # Children-of-children first.
        node_ids = [
            n.id for n in s.exec(select(Node).where(Node.board_id == board_id)).all()
        ]
        if node_ids:
            s.exec(sql_delete(Asset).where(Asset.node_id.in_(node_ids)))
            s.exec(sql_delete(Request).where(Request.node_id.in_(node_ids)))

        plan_ids = [
            p.id for p in s.exec(select(Plan).where(Plan.board_id == board_id)).all()
        ]
        if plan_ids:
            s.exec(sql_delete(PipelineRun).where(PipelineRun.plan_id.in_(plan_ids)))
            s.exec(sql_delete(PlanRevision).where(PlanRevision.plan_id.in_(plan_ids)))

        # Edge has FK on Node (source_id, target_id) — must clear before Node.
        s.exec(sql_delete(Edge).where(Edge.board_id == board_id))
        s.exec(sql_delete(Node).where(Node.board_id == board_id))
        s.exec(sql_delete(Plan).where(Plan.board_id == board_id))
        s.exec(sql_delete(ChatMessage).where(ChatMessage.board_id == board_id))
        s.exec(sql_delete(BoardFlowProject).where(BoardFlowProject.board_id == board_id))
        s.delete(board)
        s.commit()
        return {"deleted": board_id}
