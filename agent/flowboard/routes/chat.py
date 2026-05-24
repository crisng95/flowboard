from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, StringConstraints
from sqlmodel import select
from typing_extensions import Annotated

from flowboard.db import get_session
from flowboard.db.models import Board, ChatMessage, Plan
from flowboard.services.llm import secrets
from flowboard.services.omni_agent import OmniAgentError, stream_chat
from flowboard.services.planner import generate_plan_reply

router = APIRouter(tags=["chat"])

# short_id alphabet is base36 4-char today; cap at 8 for a bit of headroom
# without letting callers smuggle arbitrary blobs inside a mentions array.
MentionStr = Annotated[str, StringConstraints(min_length=1, max_length=8)]


class ChatSendRequest(BaseModel):
    board_id: int
    message: str = Field(min_length=1, max_length=4000)
    mentions: List[MentionStr] = Field(default_factory=list, max_length=32)
    agent_session_id: Optional[str] = None
    turn_number: Optional[int] = Field(default=None, ge=1)


@router.post("/api/chat")
async def send_chat(body: ChatSendRequest):
    chat_provider = secrets.read_active_providers().get("chat")
    with get_session() as s:
        if not s.get(Board, body.board_id):
            raise HTTPException(404, "board not found")

        user_msg = ChatMessage(
            board_id=body.board_id,
            role="user",
            content=body.message,
            mentions=list(body.mentions),
        )
        s.add(user_msg)

        if chat_provider == "omni":
            try:
                chat_out = await stream_chat(
                    board_id=body.board_id,
                    message=body.message,
                    agent_session_id=body.agent_session_id,
                    turn_number=body.turn_number,
                    session=s,
                )
            except OmniAgentError as exc:
                raise HTTPException(502, str(exc)) from exc
            assistant_text = chat_out["content"]
            plan_row = None
        else:
            # Planner can read the session (for mentions lookup). We haven't
            # committed yet, so the user row isn't visible to other connections —
            # that's fine, the planner only reads Node rows via the same session.
            planner_out = await generate_plan_reply(
                s, body.board_id, body.message, list(body.mentions)
            )
            assistant_text = planner_out["reply_text"]

        assistant_msg = ChatMessage(
            board_id=body.board_id,
            role="assistant",
            content=assistant_text,
            mentions=[],
        )
        s.add(assistant_msg)

        if chat_provider != "omni":
            plan_row = None
            if planner_out.get("plan") is not None:
                plan_row = Plan(
                    board_id=body.board_id,
                    spec=planner_out["plan"],
                    status="draft",
                )
                s.add(plan_row)

        # Single commit: both messages (and optional plan) land together so
        # neither row gets expired before we serialize it.
        s.commit()
        s.refresh(user_msg)
        s.refresh(assistant_msg)
        if plan_row is not None:
            s.refresh(plan_row)

        resp: dict = {"user": user_msg, "assistant": assistant_msg}
        if plan_row is not None:
            resp["plan"] = plan_row
        if chat_provider == "omni":
            resp["agentSessionId"] = chat_out["agent_session_id"]
            resp["turnNumber"] = chat_out["turn_number"]
            resp["chatProvider"] = "omni"
        return resp


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
        return list(s.exec(q).all())
