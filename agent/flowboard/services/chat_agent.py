"""Server-side ReAct agent for the bottom-dock chat (E2E video builder).

``POST /api/chat`` persists the user message and schedules
:func:`run_chat_agent` as a FastAPI BackgroundTask. The loop runs HERE,
not in the worker: only LLM reasoning goes through the muse provider
queue (``run_llm("chat_agent", ...)``); every tool is a direct service
call (create node/edge, ``run_muse_media`` for image/video, ffmpeg
concat).

:func:`run_chat_agent` never raises — any failure marks the ChatRun
``failed`` and writes an assistant message carrying the error.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NamedTuple, Optional

from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Asset, Board, ChatAttachment, ChatMessage, ChatRun, Edge, Node
from flowboard.services import video_concat
from flowboard.services.activity import record_activity
from flowboard.services.llm.base import LLMError
from flowboard.services.llm.muse import MuseProvider
from flowboard.services.llm.registry import run_llm
from flowboard.services.muse_media import run_muse_media
from flowboard.short_id import generate_unique_short_id

logger = logging.getLogger(__name__)

MAX_TURNS = 12
_LLM_TIMEOUT_S = 120.0

_NODE_TYPES = {"character", "image", "video", "prompt", "note", "merge"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ChatAgentError(Exception):
    """Expected tool failure — fed back to the LLM as an observation."""


class ToolCall(NamedTuple):
    tool: str = ""
    args: dict = {}
    done: bool = False
    reply: str = ""


# ── system prompt ─────────────────────────────────────────────────────

_SYSTEM_PROMPT = """You are the Flowboard build agent. You control an infinite-canvas
workspace through tools to fulfil the user's media request end-to-end:
create nodes, generate images/videos, wire edges, and concat videos.

RULES
- Respond with EXACTLY ONE JSON object per turn, no prose outside it.
- Either a tool call: {"tool": "<name>", "args": {...}}
- Or finish: {"done": true, "reply": "<summary for the user>"}
- The reply must be in the same language as the user's message.
- Node positions: x grows right, y grows down. Lay new content out
  left-to-right starting near x=0, spacing nodes ~300px apart.
- Prefer reusing existing nodes on follow-up turns ("sửa", "gen lại"):
  regenerate into the same node instead of creating duplicates.
- Keep prompts you send to gen_image/gen_video concrete and visual.
- If a tool returns an error, adapt (fix args, try another tool) instead
  of repeating the identical call.

TOOLS
- create_node: {"type": "character|image|video|prompt|note|merge",
  "x": float, "y": float, "data": {optional dict}}
  → {"ok": true, "short_id": "abcd", "id": 7}
- add_edge: {"from_short_id": "abcd", "to_short_id": "efgh",
  "kind": "ref"}  (kind: "ref" = use as reference)
- gen_image: {"prompt": "...", "node_short_id": "abcd" (optional),
  "reference_asset_ids": [1, 2] (optional, uploaded/attached images)}
  Generates an image and binds it to the node (creates an image node
  if none given).
- gen_video: {"prompt": "...", "source_asset_id": 3 (REQUIRED: image or
  video asset id used as the start frame), "node_short_id": "abcd"
  (optional)}  Generates a video and binds it to a video node.
- concat_videos: {"video_asset_ids": [4, 5], "node_short_id": "abcd"
  (optional)}  Joins videos in order with ffmpeg; binds the result to
  a merge node (created if none given).
- update_node: {"short_id": "abcd", "data_patch": {...}}  Shallow-merges
  data (a null value deletes the key).
- refresh: {}  Re-reads the board (nodes/edges) after many mutations.

Typical video job: upload/start images → create_node image ×N →
gen_image each (or reuse attached images directly) → gen_video per image
with source_asset_id → create_node merge → add_edge video→merge in order
→ concat_videos → done with a short summary.
"""


# ── context builder ───────────────────────────────────────────────────

def _summarize_data(data: Optional[dict]) -> str:
    if not data:
        return ""
    bits: list[str] = []
    prompt = data.get("prompt")
    if isinstance(prompt, str) and prompt:
        bits.append(f"prompt={prompt[:120]!r}")
    mids = data.get("mediaIds")
    if isinstance(mids, list):
        bits.append(f"media={len(mids)}")
    title = data.get("title")
    if isinstance(title, str) and title:
        bits.append(f"title={title[:60]!r}")
    return " ".join(bits)


def build_board_context(
    board_id: int,
    message: str,
    attachment_asset_ids: list[int],
    mentions: list[str],
) -> str:
    """Static per-run context: history + current request + attachments."""
    with get_session() as s:
        board = s.get(Board, board_id)
        hist = s.exec(
            select(ChatMessage)
            .where(ChatMessage.board_id == board_id)
            .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
            .limit(20)
        ).all()
        hist = list(reversed(hist))
        att_counts: dict[int, int] = {}
        if hist:
            rows = s.exec(
                select(ChatAttachment).where(
                    ChatAttachment.message_id.in_([m.id for m in hist if m.id])
                )
            ).all()
            for r in rows:
                att_counts[r.message_id] = att_counts.get(r.message_id, 0) + 1
        nodes = s.exec(select(Node).where(Node.board_id == board_id)).all()
        node_by_short = {n.short_id: n for n in nodes}

    lines = [f"# Board: {board.name if board else board_id} (id={board_id})"]
    lines.append("## Recent chat (oldest → newest)")
    if not hist:
        lines.append("(no previous messages)")
    for m in hist:
        content = (m.content or "")[:600]
        suffix = ""
        n_att = att_counts.get(m.id or -1, 0)
        if n_att:
            suffix = f" [{n_att} image(s) attached]"
        lines.append(f"[{m.role}] {content}{suffix}")
    if mentions:
        lines.append("## Mentions")
        for men in mentions:
            n = node_by_short.get(men)
            if n is not None:
                lines.append(f"#{men} → {n.type} node {_summarize_data(n.data)}")
            else:
                lines.append(f"#{men} → (unknown node)")
    lines.append("## Current request")
    lines.append(message)
    if attachment_asset_ids:
        with get_session() as s:
            paths = []
            for aid in attachment_asset_ids:
                row = s.get(Asset, aid)
                if row is not None and row.local_path:
                    paths.append(f"asset {aid}: {row.local_path}")
        lines.append(
            "Attached images (asset id → absolute path, readable by your tools):\n"
            + "\n".join(paths)
        )
    lines.append(_dynamic_context(board_id))
    return "\n".join(lines)


def _dynamic_context(board_id: int) -> str:
    """Fresh nodes/edges snapshot — rebuilt every turn."""
    with get_session() as s:
        nodes = s.exec(
            select(Node).where(Node.board_id == board_id).order_by(Node.id)
        ).all()
        edges = s.exec(
            select(Edge).where(Edge.board_id == board_id).order_by(Edge.id)
        ).all()
        by_id = {n.id: n for n in nodes}
    lines = ["## Nodes"]
    if not nodes:
        lines.append("(board is empty)")
    for n in nodes:
        lines.append(
            f"#{n.short_id} [{n.type}] status={n.status} "
            f"@({n.x:.0f},{n.y:.0f}) {_summarize_data(n.data)}".rstrip()
        )
    lines.append("## Edges")
    for e in edges:
        a = by_id.get(e.source_id)
        b = by_id.get(e.target_id)
        if a and b:
            lines.append(f"#{a.short_id} -> #{b.short_id} ({e.kind})")
    return "\n".join(lines)


# ── LLM call (registry with muse fallback) ────────────────────────────

async def _chat_llm(
    user_prompt: str,
    attachments: Optional[list[str]],
    turn: int,
) -> str:
    """Route through ``run_llm("chat_agent")``; on a fresh install with no
    provider pinned, fall back to the muse provider directly (the dock is
    specified Muse-compatible, and muse needs no configuration)."""
    try:
        return await run_llm(
            "chat_agent",
            user_prompt,
            system_prompt=_SYSTEM_PROMPT,
            attachments=attachments,
            timeout=_LLM_TIMEOUT_S,
        )
    except LLMError as exc:
        if "No AI provider configured for chat_agent" not in str(exc):
            raise
        logger.info("chat_agent: no provider pinned, falling back to muse")
        provider = MuseProvider()
        if not await provider.is_available():
            raise LLMError(
                "Chưa có Muse worker — agent không thể suy nghĩ. "
                "Chạy: python agent/scripts/muse_worker.py"
            )
        return await provider.run(
            user_prompt,
            system_prompt=_SYSTEM_PROMPT,
            attachments=attachments,
            timeout=_LLM_TIMEOUT_S,
        )


# ── tool-call parsing ─────────────────────────────────────────────────

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def _parse_tool_call(raw: str) -> Optional[ToolCall]:
    text = (raw or "").strip()
    m = _FENCE_RE.search(text)
    if m:
        text = m.group(1).strip()
    obj: Any = None
    try:
        obj = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        start, end = text.find("{"), text.rfind("}")
        if 0 <= start < end:
            try:
                obj = json.loads(text[start : end + 1])
            except (json.JSONDecodeError, ValueError):
                return None
        else:
            return None
    if not isinstance(obj, dict):
        return None
    if obj.get("done") is True:
        reply = obj.get("reply", "")
        return ToolCall(done=True, reply=reply if isinstance(reply, str) else "")
    tool = obj.get("tool")
    args = obj.get("args", {})
    if not isinstance(tool, str) or not tool or not isinstance(args, dict):
        return None
    return ToolCall(tool=tool, args=args)


# ── tool implementations ──────────────────────────────────────────────

def _node_by_short(s, board_id: int, short_id: str) -> Optional[Node]:
    return s.exec(
        select(Node).where(Node.board_id == board_id, Node.short_id == short_id)
    ).first()


def _auto_pos(s, board_id: int) -> tuple[float, float]:
    nodes = s.exec(select(Node).where(Node.board_id == board_id)).all()
    if not nodes:
        return 0.0, 0.0
    return max(n.x for n in nodes) + 300.0, 0.0


def _bind_media(node_id: int, media_ids: list[str]) -> None:
    """Mirror the pipeline executor's binding: data.mediaIds + mediaId,
    status → done."""
    with get_session() as s:
        node = s.get(Node, node_id)
        if node is None:
            return
        data = dict(node.data or {})
        existing = data.get("mediaIds")
        merged = list(existing) if isinstance(existing, list) else []
        for mid in media_ids:
            if mid and mid not in merged:
                merged.append(mid)
        data["mediaIds"] = merged
        if merged:
            data["mediaId"] = merged[0]
        node.data = data
        node.status = "done"
        s.add(node)
        s.commit()


def _get_or_create_media_node(
    s, board_id: int, short_id: Optional[str], node_type: str, prompt: str
) -> Node:
    if short_id:
        node = _node_by_short(s, board_id, short_id)
        if node is None:
            raise ChatAgentError(f"node #{short_id} not found on this board")
        return node
    x, y = _auto_pos(s, board_id)
    node = Node(
        board_id=board_id,
        short_id=generate_unique_short_id(s, board_id),
        type=node_type,
        x=x,
        y=y,
        data={"prompt": prompt} if prompt else {},
        status="idle",
    )
    s.add(node)
    s.commit()
    s.refresh(node)
    return node


def _asset_media_id(s, asset_id: int, expect_kind: Optional[str] = None) -> str:
    row = s.get(Asset, asset_id)
    if row is None:
        raise ChatAgentError(f"asset {asset_id} not found")
    if expect_kind and (row.kind or "") != expect_kind:
        raise ChatAgentError(
            f"asset {asset_id} has kind {row.kind!r}, expected {expect_kind!r}"
        )
    if not row.uuid_media_id:
        raise ChatAgentError(f"asset {asset_id} has no media id")
    return row.uuid_media_id


async def _tool_create_node(board_id: int, args: dict) -> dict:
    ntype = args.get("type")
    if ntype not in _NODE_TYPES:
        raise ChatAgentError(
            f"unknown node type {ntype!r}; valid: {sorted(_NODE_TYPES)}"
        )
    data = args.get("data") or {}
    if not isinstance(data, dict):
        raise ChatAgentError("data must be an object")
    try:
        x = float(args.get("x", 0.0))
        y = float(args.get("y", 0.0))
    except (TypeError, ValueError):
        raise ChatAgentError("x/y must be numbers")
    with get_session() as s:
        if "x" not in args or "y" not in args:
            x, y = _auto_pos(s, board_id)
        node = Node(
            board_id=board_id,
            short_id=generate_unique_short_id(s, board_id),
            type=ntype,
            x=x,
            y=y,
            data=data,
            status="idle",
        )
        s.add(node)
        s.commit()
        s.refresh(node)
        return {
            "ok": True,
            "tool": "create_node",
            "id": node.id,
            "short_id": node.short_id,
            "type": ntype,
        }


async def _tool_add_edge(board_id: int, args: dict) -> dict:
    from_sid = args.get("from_short_id")
    to_sid = args.get("to_short_id")
    kind = args.get("kind", "ref")
    if not from_sid or not to_sid:
        raise ChatAgentError("from_short_id and to_short_id are required")
    with get_session() as s:
        a = _node_by_short(s, board_id, from_sid)
        b = _node_by_short(s, board_id, to_sid)
        if a is None:
            raise ChatAgentError(f"node #{from_sid} not found")
        if b is None:
            raise ChatAgentError(f"node #{to_sid} not found")
        edge = Edge(board_id=board_id, source_id=a.id, target_id=b.id, kind=kind)
        s.add(edge)
        s.commit()
        s.refresh(edge)
        return {
            "ok": True,
            "tool": "add_edge",
            "id": edge.id,
            "from": from_sid,
            "to": to_sid,
        }


async def _tool_gen_image(board_id: int, args: dict) -> dict:
    prompt = args.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ChatAgentError("prompt is required")
    ref_ids = args.get("reference_asset_ids") or []
    if not isinstance(ref_ids, list):
        raise ChatAgentError("reference_asset_ids must be a list")
    with get_session() as s:
        ref_mids = [_asset_media_id(s, int(aid), "image") for aid in ref_ids]
    result, error = await run_muse_media(
        kind="image",
        prompt=prompt,
        reference_media_ids=ref_mids or None,
    )
    if error:
        return {"ok": False, "tool": "gen_image", "error": error}
    out = [m for m in (result.get("media_ids") or []) if m]
    if not out:
        return {"ok": False, "tool": "gen_image", "error": "worker returned no media"}
    with get_session() as s:
        node = _get_or_create_media_node(
            s, board_id, args.get("node_short_id"), "image", prompt
        )
        node_id, short_id = node.id, node.short_id
    _bind_media(node_id, out)
    return {
        "ok": True,
        "tool": "gen_image",
        "node_short_id": short_id,
        "media_ids": out,
    }


async def _tool_gen_video(board_id: int, args: dict) -> dict:
    prompt = args.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ChatAgentError("prompt is required")
    source_aid = args.get("source_asset_id")
    if source_aid is None:
        raise ChatAgentError("source_asset_id is required (start-frame asset)")
    with get_session() as s:
        src_mid = _asset_media_id(s, int(source_aid))
    result, error = await run_muse_media(
        kind="video",
        prompt=prompt,
        source_media_ids=[src_mid],
    )
    if error:
        return {"ok": False, "tool": "gen_video", "error": error}
    out = [m for m in (result.get("media_ids") or []) if m]
    if not out:
        return {"ok": False, "tool": "gen_video", "error": "worker returned no media"}
    with get_session() as s:
        node = _get_or_create_media_node(
            s, board_id, args.get("node_short_id"), "video", prompt
        )
        node_id, short_id = node.id, node.short_id
    _bind_media(node_id, out)
    return {
        "ok": True,
        "tool": "gen_video",
        "node_short_id": short_id,
        "media_ids": out,
    }


async def _tool_concat_videos(board_id: int, args: dict) -> dict:
    aids = args.get("video_asset_ids") or []
    if not isinstance(aids, list) or len(aids) < 1:
        raise ChatAgentError("video_asset_ids must be a non-empty list")
    new_id, error = await asyncio.to_thread(
        video_concat.concat_video_assets, [int(a) for a in aids]
    )
    if error or new_id is None:
        return {"ok": False, "tool": "concat_videos", "error": error or "unknown"}
    with get_session() as s:
        node = _get_or_create_media_node(
            s, board_id, args.get("node_short_id"), "merge", "concat"
        )
        node_id, short_id = node.id, node.short_id
        row = s.get(Asset, new_id)
        out_mids = [row.uuid_media_id] if row and row.uuid_media_id else []
    if out_mids:
        _bind_media(node_id, out_mids)
    return {
        "ok": True,
        "tool": "concat_videos",
        "asset_id": new_id,
        "node_short_id": short_id,
    }


async def _tool_update_node(board_id: int, args: dict) -> dict:
    short_id = args.get("short_id")
    patch = args.get("data_patch") or {}
    if not short_id:
        raise ChatAgentError("short_id is required")
    if not isinstance(patch, dict):
        raise ChatAgentError("data_patch must be an object")
    with get_session() as s:
        node = _node_by_short(s, board_id, short_id)
        if node is None:
            raise ChatAgentError(f"node #{short_id} not found")
        # Same shallow-merge + null-deletes semantics as PATCH /api/nodes.
        merged = dict(node.data or {})
        for dk, dv in patch.items():
            if dv is None:
                merged.pop(dk, None)
            else:
                merged[dk] = dv
        node.data = merged
        s.add(node)
        s.commit()
        return {"ok": True, "tool": "update_node", "short_id": short_id}


async def _tool_refresh(board_id: int, args: dict) -> dict:
    return {"ok": True, "tool": "refresh", "board": _dynamic_context(board_id)}


_TOOLS = {
    "create_node": _tool_create_node,
    "add_edge": _tool_add_edge,
    "gen_image": _tool_gen_image,
    "gen_video": _tool_gen_video,
    "concat_videos": _tool_concat_videos,
    "update_node": _tool_update_node,
    "refresh": _tool_refresh,
}


async def _execute_tool(board_id: int, tool: str, args: dict) -> dict:
    handler = _TOOLS.get(tool)
    if handler is None:
        return {
            "ok": False,
            "tool": tool,
            "error": f"unknown tool {tool!r}; available: {sorted(_TOOLS)}",
        }
    try:
        obs = await handler(board_id, args)
    except ChatAgentError as exc:
        return {"ok": False, "tool": tool, "error": str(exc)}
    obs.setdefault("tool", tool)
    return obs


# ── run lifecycle ─────────────────────────────────────────────────────

def _finish_run(run_id: int, reply: str, *, failed: bool = False) -> None:
    with get_session() as s:
        run = s.get(ChatRun, run_id)
        if run is None:
            logger.error("chat_agent: ChatRun %s vanished", run_id)
            return
        content = reply.strip() or "(agent finished with no summary)"
        msg = ChatMessage(
            board_id=run.board_id, role="assistant", content=content, mentions=[]
        )
        s.add(msg)
        run.status = "failed" if failed else "done"
        if failed:
            run.error = content[:500]
        run.finished_at = _utcnow()
        s.add(run)
        s.commit()


async def _run_agent(
    board_id: int,
    run_id: int,
    message: str,
    attachment_asset_ids: list[int],
    mentions: list[str],
) -> None:
    static_ctx = build_board_context(board_id, message, attachment_asset_ids, mentions)

    attach_paths: Optional[list[str]] = None
    if attachment_asset_ids:
        with get_session() as s:
            paths = []
            for aid in attachment_asset_ids:
                row = s.get(Asset, aid)
                if row is not None and row.local_path and Path(row.local_path).is_file():
                    paths.append(str(Path(row.local_path).resolve()))
        attach_paths = paths or None

    observations: list[dict] = []
    for turn in range(MAX_TURNS):
        dynamic = _dynamic_context(board_id)
        obs_text = ""
        if observations:
            obs_text = "\n\n## Tool results so far\n" + json.dumps(
                observations, ensure_ascii=False, indent=1
            )[-6000:]
        user_prompt = (
            f"{static_ctx}\n\n{dynamic}{obs_text}\n\n"
            "Respond with exactly one JSON object: a tool call or "
                '{"done": true, "reply": "..."}.'
        )
        # Attachments go to the worker on the first turn only; later turns
        # reference them by asset id (already in context).
        raw = await _chat_llm(
            user_prompt,
            attachments=attach_paths if turn == 0 else None,
            turn=turn,
        )
        call = _parse_tool_call(raw)
        if call is None:
            async with record_activity(
                "chat_agent",
                params={"board_id": board_id, "run_id": run_id, "turn": turn,
                        "tool": "unparseable"},
            ) as act:
                act.set_result({"ok": False})
            observations.append(
                {
                    "ok": False,
                    "error": "could not parse a tool call from your reply; "
                    "reply with exactly one JSON object",
                    "raw": raw[:500],
                }
            )
            continue
        if call.done:
            _finish_run(run_id, call.reply or "Xong.")
            return
        # One activity row per turn so the feed shows live progress.
        redacted = {
            k: (str(v)[:200] if k != "data_patch" else "{...}")
            for k, v in call.args.items()
        }
        async with record_activity(
            "chat_agent",
            params={"board_id": board_id, "run_id": run_id, "turn": turn,
                    "tool": call.tool, "args": redacted},
        ) as act:
            obs = await _execute_tool(board_id, call.tool, call.args)
            act.set_result({"ok": bool(obs.get("ok")), "tool": call.tool})
        observations.append(obs)

    _finish_run(
        run_id,
        "Hết lượt suy nghĩ (12 turns) mà chưa xong. "
        "Các bước đã làm:\n"
        + "\n".join(
            f"- {o.get('tool')}: {'ok' if o.get('ok') else o.get('error', 'fail')}"
            for o in observations[-8:]
        ),
    )


async def run_chat_agent(
    board_id: int,
    run_id: int,
    message: str,
    attachment_asset_ids: list[int],
    mentions: list[str],
) -> None:
    """Background-task entry. Never raises."""
    try:
        await _run_agent(board_id, run_id, message, attachment_asset_ids, mentions)
    except LLMError as exc:
        logger.warning("chat_agent run %s: llm unavailable (%s)", run_id, exc)
        _finish_run(run_id, str(exc), failed=True)
    except Exception as exc:  # noqa: BLE001 — catch-all: run must settle
        logger.exception("chat_agent run %s crashed", run_id)
        _finish_run(run_id, f"Agent gặp lỗi: {exc}"[:500], failed=True)
