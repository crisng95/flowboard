from fastapi import APIRouter, HTTPException
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

router = APIRouter(prefix="/api/boards", tags=["boards"])


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
