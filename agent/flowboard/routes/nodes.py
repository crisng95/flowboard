from typing import List, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Asset, Board, Edge, Node, Request
from flowboard.short_id import generate_unique_short_id

router = APIRouter(prefix="/api/nodes", tags=["nodes"])

# NodeType enum matches the supported V2 canvas node set only.
NodeType = Literal[
    "note",
    "reference",
    "variant",
    "video",
    "upload",
    "list",
    "text",
    "add_reference",
    "group",
    "Storyboard",
]
NodeStatus = Literal["idle", "queued", "running", "done", "error"]

_COORD_MIN = -1_000_000.0
_COORD_MAX = 1_000_000.0
_SIZE_MAX = 100_000.0
_GROUP_DEFAULT_COLOR = "#7c5cff"


class NodeCreate(BaseModel):
    board_id: int
    type: NodeType
    x: float = Field(default=0.0, ge=_COORD_MIN, le=_COORD_MAX)
    y: float = Field(default=0.0, ge=_COORD_MIN, le=_COORD_MAX)
    w: float = Field(default=240.0, gt=0, le=_SIZE_MAX)
    h: float = Field(default=160.0, gt=0, le=_SIZE_MAX)
    data: dict = {}
    status: NodeStatus = "idle"
    # Optional parent group id. When set, (x, y) are interpreted as
    # coordinates relative to the parent group''s origin so React Flow
    # ``extent: "parent"`` can keep children visually anchored when the
    # group moves.
    parent_id: Optional[int] = None


class NodeUpdate(BaseModel):
    x: Optional[float] = Field(default=None, ge=_COORD_MIN, le=_COORD_MAX)
    y: Optional[float] = Field(default=None, ge=_COORD_MIN, le=_COORD_MAX)
    w: Optional[float] = Field(default=None, gt=0, le=_SIZE_MAX)
    h: Optional[float] = Field(default=None, gt=0, le=_SIZE_MAX)
    data: Optional[dict] = None
    status: Optional[NodeStatus] = None
    # Allow re-parenting / un-parenting through PATCH. ``None`` clears
    # the link, an int assigns the node to a different group; the
    # frontend recomputes relative coordinates before patching.
    parent_id: Optional[int] = Field(default=None)


@router.post("")
def create_node(body: NodeCreate):
    with get_session() as s:
        if not s.get(Board, body.board_id):
            raise HTTPException(404, "board not found")
        if body.parent_id is not None:
            parent = s.get(Node, body.parent_id)
            if not parent or parent.board_id != body.board_id:
                raise HTTPException(400, "parent_id does not belong to this board")
        short_id = generate_unique_short_id(s, body.board_id)
        node = Node(
            board_id=body.board_id,
            short_id=short_id,
            type=body.type,
            x=body.x,
            y=body.y,
            w=body.w,
            h=body.h,
            data=body.data,
            status=body.status,
            parent_id=body.parent_id,
        )
        s.add(node)
        s.commit()
        s.refresh(node)
        return node


@router.patch("/{node_id}")
def update_node(node_id: int, body: NodeUpdate):
    """Partial update.

    The ``data`` field is shallow-merged into the existing JSON column
    rather than wholesale-replaced - earlier behaviour dropped any
    sibling field the caller forgot to list, which silently erased
    ``aspectRatio``, ``aiBrief``, and other state every time the
    frontend sent a partial update. Merge is the natural REST PATCH
    semantic and prevents that whole class of regression.

    Merge depth is one level - patch keys at the top level of ``data``
    are merged with existing keys, but if a key''s value is itself a
    dict, the new dict REPLACES the old one (no recursive merge). All
    current FlowboardNodeData fields are scalars or arrays, so this
    matches the schema. If a future field needs nested-merge
    semantics, switch to a recursive walker here and update this
    docstring.

    Sentinel: a value of ``null`` in the data patch deletes the key.
    So callers that want to clear ``aiBrief`` after a regen pass
    ``{aiBrief: null}`` (still merge-safe - no risk of accidentally
    nuking unrelated fields). Missing keys are preserved.

    Non-``data`` fields (``x``, ``y``, ``w``, ``h``, ``status``,
    ``parent_id``) keep the original setattr-replace semantic - no
    merge applied.
    """
    with get_session() as s:
        node = s.get(Node, node_id)
        if not node:
            raise HTTPException(404, "node not found")
        patch = body.model_dump(exclude_unset=True)
        for k, v in patch.items():
            if k == "data" and isinstance(v, dict):
                merged = dict(node.data or {})
                for dk, dv in v.items():
                    if dv is None:
                        merged.pop(dk, None)
                    else:
                        merged[dk] = dv
                node.data = merged
            else:
                setattr(node, k, v)
        s.add(node)
        s.commit()
        s.refresh(node)
        return node


@router.delete("/{node_id}")
def delete_node(node_id: int):
    with get_session() as s:
        node = s.get(Node, node_id)
        if not node:
            raise HTTPException(404, "node not found")
        # Cascade delete: when the target is a Group, remove every
        # child first (along with its edges / requests / assets) so
        # we don''t leave dangling parent_id pointers. The model only
        # supports one level of nesting, so a simple WHERE-parent_id
        # query is enough.
        deleted_child_ids: List[int] = []
        if node.type == "group":
            children = s.exec(select(Node).where(Node.parent_id == node_id)).all()
            for child in children:
                child_id = child.id
                if child_id is None:
                    continue
                child_edges = s.exec(
                    select(Edge).where(
                        (Edge.source_id == child_id) | (Edge.target_id == child_id)
                    )
                ).all()
                for e in child_edges:
                    s.delete(e)
                child_requests = s.exec(
                    select(Request).where(Request.node_id == child_id)
                ).all()
                for r in child_requests:
                    s.delete(r)
                child_assets = s.exec(
                    select(Asset).where(Asset.node_id == child_id)
                ).all()
                for a in child_assets:
                    s.delete(a)
                s.delete(child)
                deleted_child_ids.append(child_id)
        edges = s.exec(
            select(Edge).where((Edge.source_id == node_id) | (Edge.target_id == node_id))
        ).all()
        for e in edges:
            s.delete(e)
        requests = s.exec(select(Request).where(Request.node_id == node_id)).all()
        for r in requests:
            s.delete(r)
        assets = s.exec(select(Asset).where(Asset.node_id == node_id)).all()
        for a in assets:
            s.delete(a)
        s.delete(node)
        s.commit()
        return {
            "ok": True,
            "deleted_edges": [e.id for e in edges],
            "deleted_child_ids": deleted_child_ids,
        }


# Group endpoints --------------------------------------------------
# Atomic helpers for the Node Group feature - the frontend collects a
# selection of nodes, computes a bounding box client-side, and then
# calls /api/nodes/group with the bounding-box origin + child rfIds.
# Backend creates the new group node and re-parents the children (and
# rewrites their coordinates to be relative to the group origin) in a
# single transaction so a partial failure can''t leave the canvas in
# a half-grouped state.


class GroupCreate(BaseModel):
    board_id: int
    child_ids: List[int]
    title: str = "Group"
    color: str = _GROUP_DEFAULT_COLOR
    locked: bool = False
    x: float = Field(ge=_COORD_MIN, le=_COORD_MAX)
    y: float = Field(ge=_COORD_MIN, le=_COORD_MAX)
    w: float = Field(default=320.0, gt=0, le=_SIZE_MAX)
    h: float = Field(default=200.0, gt=0, le=_SIZE_MAX)


class GroupResponse(BaseModel):
    group: Node
    children: List[Node]


@router.post("/group", response_model=GroupResponse)
def create_group(body: GroupCreate):
    """Create a Group node and re-parent the supplied children.

    Children must:
      * exist on the same board as ``board_id``
      * NOT already have a parent_id (nested groups are not supported
        in this phase - the UI gates this client-side too, but we
        defend against a misbehaving caller here)
      * NOT include a node of type ``group`` (no nested groups)

    Children''s (x, y) are rewritten relative to the group origin so
    React Flow''s ``extent: "parent"`` keeps them visually anchored
    even when the group later moves.
    """
    with get_session() as s:
        if not s.get(Board, body.board_id):
            raise HTTPException(404, "board not found")
        if not body.child_ids:
            raise HTTPException(400, "child_ids must contain at least one node")
        children = s.exec(select(Node).where(Node.id.in_(body.child_ids))).all()
        if len(children) != len(set(body.child_ids)):
            raise HTTPException(404, "one or more child nodes not found")
        for child in children:
            if child.board_id != body.board_id:
                raise HTTPException(400, "child belongs to a different board")
            if child.parent_id is not None:
                raise HTTPException(400, "nested groups are not supported")
            if child.type == "group":
                raise HTTPException(400, "cannot nest a group inside another group")

        short_id = generate_unique_short_id(s, body.board_id)
        group = Node(
            board_id=body.board_id,
            short_id=short_id,
            type="group",
            x=body.x,
            y=body.y,
            w=body.w,
            h=body.h,
            data={
                "title": body.title,
                "groupColor": body.color,
                "locked": body.locked,
            },
            status="idle",
        )
        s.add(group)
        s.flush()  # populate group.id without committing
        if group.id is None:
            raise HTTPException(500, "failed to allocate group id")

        for child in children:
            # Re-parent / re-position only. Child JSON payload must
            # survive grouping byte-for-byte so modelKey / aspectRatio /
            # refType and any future node settings do not reset.
            preserved_data = dict(child.data or {})
            child.x = round(child.x - body.x, 4)
            child.y = round(child.y - body.y, 4)
            child.parent_id = group.id
            child.data = preserved_data
            s.add(child)
        s.commit()
        s.refresh(group)
        for child in children:
            s.refresh(child)
        return {"group": group, "children": children}


class UngroupResponse(BaseModel):
    deleted_group_id: int
    children: List[Node]


@router.post("/{node_id}/ungroup", response_model=UngroupResponse)
def ungroup_node(node_id: int):
    """Detach all children of a group, then delete the group node.

    Children''s relative (x, y) are converted back to absolute board
    coordinates so they keep their visual position once the parent is
    removed. Group-level edges (rare - only present if a future
    feature wires edges to groups directly) are cleaned up the same
    way as a regular delete.
    """
    with get_session() as s:
        group = s.get(Node, node_id)
        if not group:
            raise HTTPException(404, "group not found")
        if group.type != "group":
            raise HTTPException(400, "node is not a group")
        gx = group.x
        gy = group.y
        children = s.exec(select(Node).where(Node.parent_id == node_id)).all()
        for child in children:
            # Same invariant as grouping: ungroup only changes spatial
            # columns + parent_id. The child data blob is preserved as-is.
            preserved_data = dict(child.data or {})
            child.x = round(child.x + gx, 4)
            child.y = round(child.y + gy, 4)
            child.parent_id = None
            child.data = preserved_data
            s.add(child)
        edges = s.exec(
            select(Edge).where((Edge.source_id == node_id) | (Edge.target_id == node_id))
        ).all()
        for e in edges:
            s.delete(e)
        s.delete(group)
        s.commit()
        for child in children:
            s.refresh(child)
        return {"deleted_group_id": node_id, "children": children}

