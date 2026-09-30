"""Bottom-dock chat: uploads + agentic E2E sends.

``POST /api/chat/attachments`` — multipart upload of 1–5 images, stored
under ``storage/chat_uploads/`` as unbound ``Asset`` rows.

``POST /api/chat`` — persists the user message (+ ``ChatAttachment``
rows), creates a running ``ChatRun``, and schedules
``services.chat_agent.run_chat_agent`` as a BackgroundTask. Returns
``{"user": ..., "run_id": ...}`` immediately; the agent loop writes the
assistant message when it finishes.

``GET /api/boards/{id}/chat`` — message history, each message carrying
its ``attachments`` list.

``GET /api/boards/{id}/chat/runs/active`` — the running ``ChatRun`` or
``null`` (the dock polls this).

The old plan-draft planner flow is intentionally NOT called here; the
``services.planner`` module itself is untouched.
"""
from pathlib import Path
from typing import List, Optional
import uuid

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, StringConstraints
from sqlmodel import select
from typing_extensions import Annotated

from flowboard import config
from flowboard.db import get_session
from flowboard.db.models import Asset, Board, ChatAttachment, ChatMessage, ChatRun
from flowboard.services.chat_agent import run_chat_agent

router = APIRouter(tags=["chat"])

# short_id alphabet is base36 4-char today; cap at 8 for a bit of headroom
# without letting callers smuggle arbitrary blobs inside a mentions array.
MentionStr = Annotated[str, StringConstraints(min_length=1, max_length=8)]

MAX_CHAT_FILES = 5
MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024  # 10 MB each (mirrors routes/upload.py)
_CHAT_UPLOAD_MIMES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
}
_EXT_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def _sniff_image_mime(raw: bytes) -> Optional[str]:
    """Magic-byte sniff — same defence-in-depth as routes/upload.py: never
    trust the browser-supplied Content-Type alone."""
    if len(raw) < 12:
        return None
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def _attachment_url(asset_id: int) -> str:
    return f"/api/chat/attachments/{asset_id}/file"


def _serialize_messages(s, messages: List[ChatMessage]) -> list:
    ids = [m.id for m in messages if m.id is not None]
    by_msg: dict[int, list] = {}
    if ids:
        att_rows = s.exec(
            select(ChatAttachment).where(ChatAttachment.message_id.in_(ids))
        ).all()
        asset_ids = list({r.asset_id for r in att_rows})
        assets = (
            {
                a.id: a
                for a in s.exec(
                    select(Asset).where(Asset.id.in_(asset_ids))
                ).all()
            }
            if asset_ids
            else {}
        )
        for r in att_rows:
            a = assets.get(r.asset_id)
            if a is None:
                continue
            by_msg.setdefault(r.message_id, []).append(
                {
                    "id": r.id,
                    "asset_id": a.id,
                    "mime": a.mime,
                    "url": _attachment_url(a.id),
                }
            )
    return [
        {
            "id": m.id,
            "board_id": m.board_id,
            "role": m.role,
            "content": m.content,
            "mentions": list(m.mentions or []),
            "created_at": m.created_at,
            "attachments": by_msg.get(m.id, []),
        }
        for m in messages
    ]


# ── uploads ───────────────────────────────────────────────────────────


@router.post("/api/chat/attachments")
async def upload_chat_attachments(
    board_id: int = Form(...),
    files: List[UploadFile] = File(...),
):
    with get_session() as s:
        if not s.get(Board, board_id):
            raise HTTPException(404, "board not found")

    if not files or len(files) > MAX_CHAT_FILES:
        raise HTTPException(
            400, f"attach 1–{MAX_CHAT_FILES} images per message"
        )

    dest_dir = config.STORAGE_DIR / "chat_uploads"
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Validate everything before writing anything, so a bad file late in
    # the batch can't leave orphaned bytes on disk.
    validated: list[tuple[str, bytes]] = []
    for uf in files:
        raw = await uf.read()
        if len(raw) > MAX_CHAT_FILE_BYTES:
            raise HTTPException(400, f"{uf.filename or 'file'}: exceeds 10 MB")
        mime = _sniff_image_mime(raw)
        if mime not in _CHAT_UPLOAD_MIMES:
            raise HTTPException(
                400,
                f"{uf.filename or 'file'}: not a supported image "
                "(jpeg/png/webp/gif)",
            )
        validated.append((mime, raw))

    assets: list[Asset] = []
    with get_session() as s:
        for mime, raw in validated:
            mid = uuid.uuid4().hex
            path = dest_dir / f"{mid}{_EXT_BY_MIME[mime]}"
            try:
                path.write_bytes(raw)
            except OSError as exc:
                raise HTTPException(500, f"could not store upload: {exc}")
            # uuid_media_id lets run_muse_media resolve the file via the
            # local_path fallback (no Flow / remote URL involved).
            assets.append(
                Asset(
                    kind="image",
                    node_id=None,
                    uuid_media_id=mid,
                    local_path=str(path),
                    mime=mime,
                )
            )
        s.add_all(assets)
        s.commit()
        for a in assets:
            s.refresh(a)

    return {
        "assets": [
            {"id": a.id, "mime": a.mime, "url": _attachment_url(a.id)}
            for a in assets
        ]
    }


@router.get("/api/chat/attachments/{asset_id}/file")
def get_chat_attachment_file(asset_id: int):
    with get_session() as s:
        row = s.get(Asset, asset_id)
        if row is None or (row.kind or "") != "image" or not row.local_path:
            raise HTTPException(404, "attachment not found")
        mime = row.mime or "image/png"
        p = Path(row.local_path).resolve()
    # Containment: never serve a path outside the storage dir.
    try:
        p.relative_to(config.STORAGE_DIR.resolve())
    except ValueError:
        raise HTTPException(404, "attachment not found")
    if not p.is_file():
        raise HTTPException(404, "attachment not found")
    return FileResponse(path=str(p), media_type=mime)


# ── send ──────────────────────────────────────────────────────────────


class ChatSendRequest(BaseModel):
    board_id: int
    message: str = Field(min_length=1, max_length=4000)
    mentions: List[MentionStr] = Field(default_factory=list, max_length=32)
    attachment_ids: List[int] = Field(default_factory=list, max_length=5)


@router.post("/api/chat")
async def send_chat(body: ChatSendRequest, background_tasks: BackgroundTasks):
    with get_session() as s:
        if not s.get(Board, body.board_id):
            raise HTTPException(404, "board not found")

        # Validate attachments: must be existing, unbound images.
        seen: set[int] = set()
        for aid in body.attachment_ids:
            if aid in seen:
                raise HTTPException(400, f"duplicate attachment id {aid}")
            seen.add(aid)
            row = s.get(Asset, aid)
            if row is None:
                raise HTTPException(404, f"attachment asset {aid} not found")
            if (row.kind or "") != "image":
                raise HTTPException(
                    400, f"attachment asset {aid} is not an image"
                )
            if row.node_id is not None:
                raise HTTPException(
                    400, f"attachment asset {aid} is already bound to a node"
                )

        user_msg = ChatMessage(
            board_id=body.board_id,
            role="user",
            content=body.message,
            mentions=list(body.mentions),
        )
        s.add(user_msg)
        s.commit()
        s.refresh(user_msg)

        for aid in body.attachment_ids:
            s.add(ChatAttachment(message_id=user_msg.id, asset_id=aid))

        run = ChatRun(
            board_id=body.board_id,
            user_message_id=user_msg.id,
            status="running",
        )
        s.add(run)
        s.commit()
        s.refresh(run)
        run_id = run.id

        user_dto = _serialize_messages(s, [user_msg])[0]

    # The agent loop runs after the response is sent; it writes the
    # assistant message and settles the run. It never raises.
    background_tasks.add_task(
        run_chat_agent,
        body.board_id,
        run_id,
        body.message,
        list(body.attachment_ids),
        list(body.mentions),
    )
    return {"user": user_dto, "run_id": run_id}


# ── history + run status ──────────────────────────────────────────────


@router.get("/api/boards/{board_id}/chat")
def list_chat(
    board_id: int,
    limit: Optional[int] = Query(default=500, ge=1, le=2000),
):
    with get_session() as s:
        if not s.get(Board, board_id):
            raise HTTPException(404, "board not found")
        q = (
            select(ChatMessage)
            .where(ChatMessage.board_id == board_id)
            .order_by(ChatMessage.created_at, ChatMessage.id)
        )
        if limit:
            q = q.limit(limit)
        messages = list(s.exec(q).all())
        return _serialize_messages(s, messages)


@router.get("/api/boards/{board_id}/chat/runs/active")
def get_active_chat_run(board_id: int):
    with get_session() as s:
        if not s.get(Board, board_id):
            raise HTTPException(404, "board not found")
        run = s.exec(
            select(ChatRun)
            .where(ChatRun.board_id == board_id, ChatRun.status == "running")
            .order_by(ChatRun.id.desc())
        ).first()
        return run
