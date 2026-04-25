from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Board, Edge, Node

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
