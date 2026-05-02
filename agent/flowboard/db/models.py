from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Field, SQLModel, Column, JSON


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Board(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    created_at: datetime = Field(default_factory=_utcnow)


class Node(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    board_id: int = Field(foreign_key="board.id", index=True)
    short_id: str = Field(index=True)
    type: str
    x: float = 0.0
    y: float = 0.0
    w: float = 240.0
    h: float = 160.0
    data: dict = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = "idle"
    created_at: datetime = Field(default_factory=_utcnow)


class Edge(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    board_id: int = Field(foreign_key="board.id", index=True)
    source_id: int = Field(foreign_key="node.id")
    target_id: int = Field(foreign_key="node.id")
    kind: str = "ref"
    # Per-edge variant pin: when the source node holds multiple variants
    # (`data.mediaIds`), this index selects WHICH variant feeds the
    # downstream as a reference. None = "fall back to the source's
    # active mediaId" (the natural single-variant case).
    #
    # Why per-edge instead of expanding all variants on the wire: each
    # variant of the same upstream produces a SEPARATE Flow API call
    # (Flow doesn't bind output[i] to input[i] when both are
    # multi-variant). Pinning lets the user say "use variant 2 for
    # downstream A, variant 3 for downstream B" with two clicks; the
    # edge UI surfaces the pinned index so the binding stays visible.
    source_variant_idx: Optional[int] = None


class Request(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    node_id: Optional[int] = Field(default=None, foreign_key="node.id", index=True)
    type: str
    params: dict = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = "queued"
    result: dict = Field(default_factory=dict, sa_column=Column(JSON))
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)
    finished_at: Optional[datetime] = None


class Asset(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    # node_id is optional — assets can arrive from TRPC before any node
    # binding (e.g. the user browses an old Flow project).
    node_id: Optional[int] = Field(default=None, foreign_key="node.id", index=True)
    kind: str  # image | video | thumbnail
    # Media id (the hex uuid from Google Flow). Unique so ingest can upsert.
    uuid_media_id: Optional[str] = Field(default=None, index=True, unique=True)
    # Latest captured signed GCS URL (expires — refreshed when user reopens
    # Flow tab).
    url: Optional[str] = None
    local_path: Optional[str] = None
    mime: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)


class ChatMessage(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    board_id: int = Field(foreign_key="board.id", index=True)
    role: str  # user | assistant | system
    content: str
    mentions: list = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=_utcnow)


class Plan(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    board_id: int = Field(foreign_key="board.id", index=True)
    spec: dict = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = "draft"  # draft | approved | running | done | failed
    created_at: datetime = Field(default_factory=_utcnow)


class PlanRevision(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    plan_id: int = Field(foreign_key="plan.id", index=True)
    rev_no: int
    spec: dict = Field(default_factory=dict, sa_column=Column(JSON))
    edits: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=_utcnow)


class PipelineRun(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    plan_id: int = Field(foreign_key="plan.id", index=True)
    status: str = "pending"  # pending | running | done | failed
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    error: Optional[str] = None


class BoardFlowProject(SQLModel, table=True):
    """1:1 link between a local board and a Google Flow project_id.

    Kept as a separate table so we don't have to migrate the Board schema.
    Paygate tier is loaded realtime from the extension via /api/auth/me,
    not persisted here — the binding is purely about project identity.
    """
    board_id: int = Field(primary_key=True, foreign_key="board.id")
    flow_project_id: str
    created_at: datetime = Field(default_factory=_utcnow)
