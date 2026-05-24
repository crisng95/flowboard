from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, Iterable, Optional

from sqlmodel import Session

from flowboard.db import get_session
from flowboard.db.models import Board, BoardFlowProject
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_sdk import get_flow_sdk, is_valid_project_id

logger = logging.getLogger(__name__)

_OMNI_CHAT_URL = (
    "https://aisandbox-pa.googleapis.com/v1/flowCreationAgent:streamChat?alt=sse"
)
_OMNI_HEADERS = {
    "content-type": "application/json",
    "accept": "text/event-stream",
    "origin": "https://labs.google",
    "referer": "https://labs.google/",
}
_TEXT_KEYS = {
    "text",
    "content",
    "outputtext",
    "responsetext",
    "answer",
    "value",
}
_SESSION_KEYS = {"agentsessionid", "sessionid"}
_TURN_KEYS = {"turnnumber"}


class OmniAgentError(RuntimeError):
    """Raised when the Flow Creation Agent route fails or yields no text."""


def _omni_project_id(project_id: str) -> str:
    project_id = project_id.strip()
    if project_id.startswith("projects/"):
        return project_id
    return f"projects/{project_id}"


def _omni_client_session_id(now_ms: Optional[int] = None) -> str:
    value = now_ms if isinstance(now_ms, int) and now_ms > 0 else int(time.time() * 1000)
    return f";{value}"


def _resolve_omni_captcha_action() -> str:
    action = flow_client.get_observed_captcha_action("omni_chat")
    if isinstance(action, str) and action:
        return action
    raise OmniAgentError(
        "Omni captcha action not observed yet. Use Google Labs Flow chat once, then retry."
    )


def _ensure_board_project(session: Session, board_id: int) -> str:
    board = session.get(Board, board_id)
    if board is None:
        raise OmniAgentError("board not found")
    row = session.get(BoardFlowProject, board_id)
    if row is not None:
        return row.flow_project_id

    raise OmniAgentError("board has no Flow project bound")


async def _create_and_bind_project(board_id: int) -> str:
    with get_session() as s:
        board = s.get(Board, board_id)
        if board is None:
            raise OmniAgentError("board not found")
        existing = s.get(BoardFlowProject, board_id)
        if existing is not None:
            return existing.flow_project_id
        board_name = board.name

    resp = await get_flow_sdk().create_project(title=board_name or "Untitled")
    if resp.get("error"):
        raise OmniAgentError(str(resp["error"]))
    flow_project_id = resp.get("project_id")
    if not isinstance(flow_project_id, str) or not is_valid_project_id(flow_project_id):
        raise OmniAgentError("invalid project_id from Flow")

    with get_session() as s:
        existing = s.get(BoardFlowProject, board_id)
        if existing is not None:
            return existing.flow_project_id
        row = BoardFlowProject(board_id=board_id, flow_project_id=flow_project_id)
        s.add(row)
        s.commit()
        return flow_project_id


async def ensure_board_project_id(board_id: int, *, session: Optional[Session] = None) -> str:
    try:
        if session is not None:
            return _ensure_board_project(session, board_id)
        with get_session() as s:
            return _ensure_board_project(s, board_id)
    except OmniAgentError as exc:
        if "no Flow project bound" not in str(exc):
            raise
    return await _create_and_bind_project(board_id)


def _iter_sse_data_lines(payload: str) -> Iterable[str]:
    for raw_line in payload.splitlines():
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        value = line[5:].strip()
        if value and value != "[DONE]":
            yield value


def _extract_text_fragments(value: Any) -> list[str]:
    out: list[str] = []

    def _walk(node: Any, *, key: Optional[str] = None) -> None:
        if isinstance(node, dict):
            if "error" in node and node["error"]:
                raise OmniAgentError(str(node["error"]))
            for k, v in node.items():
                _walk(v, key=k)
            return
        if isinstance(node, list):
            for item in node:
                _walk(item, key=key)
            return
        if isinstance(node, str):
            key_norm = (key or "").lower()
            if key_norm in _TEXT_KEYS and node.strip():
                out.append(node.strip())

    _walk(value)
    deduped: list[str] = []
    seen: set[str] = set()
    for item in out:
        if item not in seen:
            seen.add(item)
            deduped.append(item)
    return deduped


def _extract_first_string(value: Any, keys: set[str]) -> Optional[str]:
    found: Optional[str] = None

    def _walk(node: Any, *, key: Optional[str] = None) -> None:
        nonlocal found
        if found is not None:
            return
        if isinstance(node, dict):
            for k, v in node.items():
                _walk(v, key=k)
            return
        if isinstance(node, list):
            for item in node:
                _walk(item, key=key)
            return
        if isinstance(node, str) and (key or "").lower() in keys and node.strip():
            found = node.strip()

    _walk(value)
    return found


def _extract_first_int(value: Any, keys: set[str]) -> Optional[int]:
    found: Optional[int] = None

    def _walk(node: Any, *, key: Optional[str] = None) -> None:
        nonlocal found
        if found is not None:
            return
        if isinstance(node, dict):
            for k, v in node.items():
                _walk(v, key=k)
            return
        if isinstance(node, list):
            for item in node:
                _walk(item, key=key)
            return
        if isinstance(node, int) and (key or "").lower() in keys:
            found = node

    _walk(value)
    return found


def parse_sse_payload(payload: str) -> dict[str, Any]:
    texts: list[str] = []
    session_id: Optional[str] = None
    turn_number: Optional[int] = None

    for data_line in _iter_sse_data_lines(payload):
        parsed: Any
        try:
            parsed = json.loads(data_line)
        except json.JSONDecodeError:
            stripped = data_line.strip()
            if stripped:
                texts.append(stripped)
            continue

        session_id = session_id or _extract_first_string(parsed, _SESSION_KEYS)
        turn_number = turn_number or _extract_first_int(parsed, _TURN_KEYS)
        fragments = _extract_text_fragments(parsed)
        if fragments:
            texts.extend(fragments)

    content = "\n".join(part for part in texts if part).strip()
    return {
        "content": content,
        "agent_session_id": session_id,
        "turn_number": turn_number,
        "raw": payload,
    }


async def stream_chat(
    *,
    board_id: int,
    message: str,
    agent_session_id: Optional[str] = None,
    turn_number: Optional[int] = None,
    session: Optional[Session] = None,
    timeout: float = 120.0,
) -> dict[str, Any]:
    project_id = await ensure_board_project_id(board_id, session=session)
    omni_project_id = _omni_project_id(project_id)
    captcha_action = _resolve_omni_captcha_action()
    session_id = agent_session_id or str(uuid.uuid4())
    current_turn = turn_number if isinstance(turn_number, int) and turn_number > 0 else 1
    body = {
        "agentSessionId": session_id,
        "agentClientContext": {
            "projectId": omni_project_id,
            "clientSessionId": _omni_client_session_id(),
            "recaptchaContext": {
                "token": "",
                "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
            },
            "turnNumber": current_turn,
        },
        "userMessage": {
            "userPrompt": {
                "parts": [{"text": message}],
            }
        },
    }

    resp = await flow_client.api_request(
        _OMNI_CHAT_URL,
        method="POST",
        headers=dict(_OMNI_HEADERS),
        body=body,
        captcha_action=captcha_action,
        timeout=timeout,
    )
    if resp.get("error"):
        raise OmniAgentError(str(resp["error"]))
    status = resp.get("status")
    if isinstance(status, int) and status >= 400:
        detail = resp.get("data")
        if isinstance(detail, dict):
            try:
                detail_text = json.dumps(detail, ensure_ascii=True)
            except Exception:  # noqa: BLE001
                detail_text = str(detail)
        else:
            detail_text = str(detail)
        raise OmniAgentError(f"HTTP {status}: {detail_text}")

    data = resp.get("data")
    if isinstance(data, str):
        parsed = parse_sse_payload(data)
    else:
        parsed = {"content": "", "agent_session_id": None, "turn_number": None, "raw": data}

    content = (parsed.get("content") or "").strip()
    if not content:
        logger.warning("omni_agent: empty SSE text payload board=%s raw=%r", board_id, data)
        raise OmniAgentError("Omni Agent returned no text")

    return {
        "content": content,
        "agent_session_id": parsed.get("agent_session_id") or session_id,
        "turn_number": parsed.get("turn_number") or current_turn,
        "project_id": project_id,
        "raw": parsed.get("raw"),
    }
