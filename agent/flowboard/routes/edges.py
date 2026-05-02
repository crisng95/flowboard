from typing import Literal, Optional

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
    # Optional pin to a specific variant of the source's `mediaIds[]`.
    # Frontend passes when the user picks a variant before drawing the
    # edge (or when right-click → pin variant on an existing edge).
    source_variant_idx: Optional[int] = None


class EdgePatch(BaseModel):
    """Partial update — currently only the variant pin is mutable;
    swapping source/target is a delete + create."""
    source_variant_idx: Optional[int] = None


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
            source_variant_idx=body.source_variant_idx,
        )
        s.add(edge)
        s.commit()
        s.refresh(edge)
        return edge


@router.patch("/{edge_id}")
def patch_edge(edge_id: int, body: EdgePatch):
    """Update an edge's variant pin without recreating the edge.

    Used by the variant-click flow: user picks a variant on an upstream
    multi-variant node → we PATCH the existing edge to that downstream
    so the next Generate uses the chosen ref. Passing
    ``source_variant_idx: null`` clears the pin (revert to mediaId).
    """
    with get_session() as s:
        edge = s.get(Edge, edge_id)
        if not edge:
            raise HTTPException(404, "edge not found")
        # Distinguish "unset" (don't touch) from "null" (clear). Pydantic
        # gives us model_fields_set for that.
        if "source_variant_idx" in body.model_fields_set:
            edge.source_variant_idx = body.source_variant_idx
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
