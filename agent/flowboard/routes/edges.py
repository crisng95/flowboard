from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from flowboard.db import get_session
from flowboard.db.models import Edge, Node

router = APIRouter(prefix="/api/edges", tags=["edges"])

EdgeKind = Literal["ref", "hint"]


class EdgeCreate(BaseModel):
    board_id: int
    source_id: int
    target_id: int
    kind: EdgeKind = "ref"


@router.post("")
def create_edge(body: EdgeCreate):
    with get_session() as s:
        if body.source_id == body.target_id:
            raise HTTPException(400, "source_id and target_id must differ")
        source = s.get(Node, body.source_id)
        target = s.get(Node, body.target_id)
        if not source or not target:
            raise HTTPException(404, "source or target node not found")
        if source.board_id != body.board_id or target.board_id != body.board_id:
            raise HTTPException(400, "nodes must belong to the same board")
        edge = Edge(
            board_id=body.board_id,
            source_id=body.source_id,
            target_id=body.target_id,
            kind=body.kind,
        )
        s.add(edge)
        s.commit()
        s.refresh(edge)
        return edge


@router.delete("/{edge_id}")
def delete_edge(edge_id: int):
    with get_session() as s:
        edge = s.get(Edge, edge_id)
        if not edge:
            raise HTTPException(404, "edge not found")
        s.delete(edge)
        s.commit()
        return {"ok": True}
