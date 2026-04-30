"""Wraps any LLM / upload call so it surfaces in the activity feed.

The wrapped operation creates a ``Request`` row at start (status=running),
updates it on completion (done with result, or failed with error), and
re-raises any exception so caller behaviour is unchanged. Activity
logging is purely additive — never alters return values or error types.

Usage:

    async with record_activity(
        "auto_prompt",
        params={"node_id": node_id, "camera": camera},
        node_id=node_id,
    ) as ctx:
        text = await actual_op()
        ctx.set_result({"prompt": text})
    return text

If ``actual_op`` raises, the ``Request`` row is marked failed with the
exception's ``str(...)[:1000]`` and the exception bubbles out unchanged.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional

from flowboard.db import get_session
from flowboard.db.models import Request

logger = logging.getLogger(__name__)


class _ActivityCtx:
    """Yielded inside the context manager. Callers populate ``result``
    on success via :meth:`set_result`."""

    __slots__ = ("request_id", "result")

    def __init__(self, request_id: int) -> None:
        self.request_id = request_id
        self.result: dict[str, Any] = {}

    def set_result(self, result: dict[str, Any]) -> None:
        # Defensive copy so callers can mutate their own dict afterwards
        # without affecting what we persist.
        self.result = dict(result)


@asynccontextmanager
async def record_activity(
    type: str,
    *,
    params: Optional[dict[str, Any]] = None,
    node_id: Optional[int] = None,
) -> AsyncIterator[_ActivityCtx]:
    """Async context manager that creates / updates a ``Request`` row
    around the wrapped operation.

    Raises whatever the wrapped block raises — never swallows.
    """
    # Insert the running row before the operation starts. We commit and
    # close the session immediately so a long-running op doesn't hold a
    # DB connection.
    with get_session() as s:
        req = Request(
            node_id=node_id,
            type=type,
            params=dict(params or {}),
            status="running",
        )
        s.add(req)
        s.commit()
        s.refresh(req)
        rid = req.id
    assert rid is not None

    ctx = _ActivityCtx(rid)
    try:
        yield ctx
    except BaseException as exc:
        # Re-raise after marking failed. Cancellations + KeyboardInterrupt
        # also flow through this path so the row never gets stuck "running".
        with get_session() as s:
            row = s.get(Request, rid)
            if row is not None:
                row.status = "failed"
                row.error = str(exc)[:1000] if str(exc) else type
                row.finished_at = datetime.now(timezone.utc)
                s.add(row)
                s.commit()
        raise
    else:
        with get_session() as s:
            row = s.get(Request, rid)
            if row is not None:
                row.status = "done"
                row.result = dict(ctx.result)
                row.finished_at = datetime.now(timezone.utc)
                s.add(row)
                s.commit()
