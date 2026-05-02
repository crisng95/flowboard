"""Chat planner.

Two paths:

- ``generate_mock_reply`` — deterministic, no LLM. Used as fallback when the
  configured Planner provider is unavailable or when
  ``FLOWBOARD_PLANNER_BACKEND=mock``.
- ``generate_plan_reply`` — invokes the configured Planner provider via
  ``run_llm("planner", ...)`` (default = Claude CLI; user can pin Gemini /
  OpenAI Codex in Settings → AI Providers). Asks it to produce a
  conversational acknowledgement and (optionally) a JSON pipeline plan
  matching the schema in ``docs/PLAN.md``.

The backend is chosen at dispatch time by ``FLOWBOARD_PLANNER_BACKEND``
(``cli|mock|auto``, default ``auto``). Post-multi-LLM, the env var name
is historical — "cli" now means "use the configured provider" and "auto"
means "use the configured provider if available, else mock". The mode
matters because dev / test environments without any LLM available need
the mock fallback to keep working.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Iterable, Optional

from sqlmodel import select

from flowboard.config import PLANNER_BACKEND
from flowboard.db.models import Node
from flowboard.services.activity import record_activity
from flowboard.services.llm import registry, run_llm, secrets
from flowboard.services.llm.base import LLMError

logger = logging.getLogger(__name__)


_PLANNER_SYSTEM_PROMPT = """You are the Flowboard planner.

Flowboard is a personal infinite-canvas workspace for AI media workflows.
Nodes are typed cards: `character`, `image`, `video`, `prompt`, `note`.
Edges express "use as reference".

When the user describes intent, you:
1. Respond conversationally in one or two short sentences.
2. If (and only if) the intent implies creating nodes, append a pipeline plan
   at the end of your message wrapped in a fenced JSON block:

```json
{
  "nodes": [
    {"tmp_id": "a", "type": "image", "params": {"prompt": "…"}}
  ],
  "edges": [
    {"from": "a", "to": "b", "kind": "ref"}
  ],
  "layout_hint": "left_to_right"
}
```

Rules:
- `tmp_id` is a short local alias you invent (used only to wire edges).
- `type` must be one of character / image / video / prompt / note.
- Edge `from` / `to` are `tmp_id`s OR `#shortId` of existing nodes.
- Prefer small plans (<= 6 nodes). Do NOT emit a plan if the user is just
  chatting.
- Never emit prose inside the JSON block.
- If no plan is appropriate, omit the JSON block entirely.
"""


def _lookup_nodes(session, board_id: int, short_ids: Iterable[str]) -> list[Node]:
    ids = [s for s in short_ids if s]
    if not ids:
        return []
    return list(
        session.exec(
            select(Node).where(
                Node.board_id == board_id, Node.short_id.in_(ids)  # type: ignore[attr-defined]
            )
        ).all()
    )


def _node_summary_for_context(session, board_id: int, limit: int = 20) -> list[dict]:
    """Brief digest of the board's nodes for the LLM context."""
    rows = list(
        session.exec(
            select(Node).where(Node.board_id == board_id).limit(limit)
        ).all()
    )
    out = []
    for n in rows:
        title = (n.data or {}).get("title") or n.type
        out.append({"short_id": n.short_id, "type": n.type, "title": title})
    return out


def generate_mock_reply(
    session,
    board_id: int,
    user_text: str,
    mention_short_ids: list[str],
) -> str:
    """Deterministic reply — acknowledges mentions, no LLM call."""
    resolved = _lookup_nodes(session, board_id, mention_short_ids)
    resolved_by_id = {n.short_id: n for n in resolved}

    refs_parts: list[str] = []
    missing: list[str] = []
    for sid in mention_short_ids:
        node = resolved_by_id.get(sid)
        if node is None:
            missing.append(sid)
        else:
            title = (node.data or {}).get("title") or node.type
            refs_parts.append(f"#{sid} ({title})")

    trimmed = user_text.strip()
    preview = trimmed if len(trimmed) <= 80 else trimmed[:77] + "…"

    sentences: list[str] = []
    if preview:
        sentences.append(f'Noted your ask: "{preview}".')
    if refs_parts:
        sentences.append("Refs resolved: " + ", ".join(refs_parts) + ".")
    if missing:
        sentences.append(
            "Could not find: " + ", ".join(f"#{m}" for m in missing) + "."
        )
    sentences.append(
        "Planner stub — set FLOWBOARD_PLANNER_BACKEND=cli (or use auto with the "
        "claude CLI on PATH) to enable real planning."
    )
    return " ".join(sentences)


# ── Real planner (Claude CLI) ────────────────────────────────────────────────

_FENCED_JSON_RE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)


def _extract_plan(text: str) -> tuple[str, Optional[dict]]:
    """Pull a fenced JSON block out of the LLM response.

    Returns ``(reply_text_without_fence, parsed_plan_or_None)``. If the JSON
    block is present but malformed or the minimum shape check fails, the raw
    text is returned untouched and the plan is ``None``.
    """
    m = _FENCED_JSON_RE.search(text)
    if m:
        raw = m.group(1)
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("planner: fenced JSON block failed to parse")
            return text, None
        if not _is_valid_plan_shape(parsed):
            logger.warning("planner: plan JSON fails shape check")
            return text, None
        # Strip the fence out of the human-readable reply.
        cleaned = (text[: m.start()] + text[m.end() :]).strip()
        return cleaned or text, parsed

    # Fallback: try parsing the entire body as JSON (for LLMs that skip fences).
    stripped = text.strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            parsed = None
        if parsed is not None and _is_valid_plan_shape(parsed):
            return "", parsed

    return text, None


def _is_valid_plan_shape(plan: Any) -> bool:
    if not isinstance(plan, dict):
        return False
    nodes = plan.get("nodes")
    if not isinstance(nodes, list):
        return False
    for n in nodes:
        if not isinstance(n, dict):
            return False
    edges = plan.get("edges", [])
    if not isinstance(edges, list):
        return False
    for e in edges:
        if not isinstance(e, dict):
            return False
    return True


async def generate_plan_reply(
    session,
    board_id: int,
    user_text: str,
    mention_short_ids: list[str],
) -> dict:
    """Returns ``{"reply_text": str, "plan": dict | None}``.

    Honors ``FLOWBOARD_PLANNER_BACKEND``:
    - ``mock`` → always use the deterministic mock (plan is None).
    - ``cli``  → require the configured Planner provider; surface the
      error in reply_text on failure.
    - ``auto`` → try the configured Planner provider, fall back to mock
      on unavailable / error.

    The auto-fallback respects the user's Settings pin: if they picked
    ``planner = gemini`` and Gemini CLI isn't installed, we fall back to
    mock (not Claude). Picking the right provider but having it down still
    means "the user's chosen LLM is unavailable" — mock is the right fallback.
    """
    backend = (PLANNER_BACKEND or "auto").lower()

    if backend == "mock":
        return {
            "reply_text": generate_mock_reply(
                session, board_id, user_text, mention_short_ids
            ),
            "plan": None,
        }

    if backend == "auto":
        # Probe the configured Planner provider — no default. If the user
        # hasn't completed the AI Provider setup, fall back to mock
        # silently here (the forced-setup gate in the UI is what nudges
        # them to configure; mock keeps the chat reply path graceful).
        config = secrets.read_active_providers()
        provider_name = config.get("planner")
        provider = registry.get_provider(provider_name) if provider_name else None
        if provider is None or not await provider.is_available():
            logger.info(
                "planner: %s unavailable, using mock", provider_name or "unset"
            )
            return {
                "reply_text": generate_mock_reply(
                    session, board_id, user_text, mention_short_ids
                ),
                "plan": None,
            }

    resolved = _lookup_nodes(session, board_id, mention_short_ids)
    board_context = _node_summary_for_context(session, board_id)
    mention_lines = [
        f"- #{n.short_id} ({n.type}) — {(n.data or {}).get('title') or n.type}"
        for n in resolved
    ]

    user_prompt_parts: list[str] = [user_text.strip() or "(empty)"]
    if mention_lines:
        user_prompt_parts.append("\nMentioned nodes:\n" + "\n".join(mention_lines))
    if board_context:
        ctx_lines = [
            f"- #{n['short_id']} ({n['type']}) — {n['title']}" for n in board_context
        ]
        user_prompt_parts.append(
            "\nCurrent board (up to 20 nodes):\n" + "\n".join(ctx_lines)
        )

    user_prompt = "\n".join(user_prompt_parts)

    # Activity log captures redacted params only — full board context can
    # be large (kilobytes per gen) and is reconstructable from Node/Edge
    # rows at the same timestamp anyway. Wrap only the LLM call so an
    # LLMError naturally marks the row failed; caller's mock-fallback
    # path runs OUTSIDE the activity context.
    raw: Optional[str] = None
    try:
        async with record_activity(
            "planner",
            params={"user_text": user_text, "mention_short_ids": list(mention_short_ids)},
        ) as activity:
            raw = await run_llm(
                "planner",
                user_prompt=user_prompt,
                system_prompt=_PLANNER_SYSTEM_PROMPT,
            )
            activity.set_result({"raw_length": len(raw) if isinstance(raw, str) else 0})
    except LLMError as exc:
        logger.warning("planner: provider failed (%s), falling back to mock", exc)
        if backend == "cli":
            return {
                "reply_text": f"(planner unavailable: {exc})",
                "plan": None,
            }
        return {
            "reply_text": generate_mock_reply(
                session, board_id, user_text, mention_short_ids
            ),
            "plan": None,
        }

    # Defensive: if a future provider returns None on empty model output,
    # `_extract_plan(None)` would explode in the regex search. Coerce to
    # empty string so the "no plan, just empty reply" path takes over.
    reply_text, plan = _extract_plan(raw or "")
    if not reply_text.strip():
        # Some LLM runs put nothing but the JSON block. Give the user at least
        # a short acknowledgement.
        reply_text = "Plan proposed — review below."
    return {"reply_text": reply_text, "plan": plan}
