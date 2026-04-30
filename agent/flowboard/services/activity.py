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

import copy
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
        # Deep copy so callers can mutate their own dict (or the lists
        # / nested dicts inside it) afterwards without affecting what we
        # persist. Going through ``copy.deepcopy`` rather than
        # ``json.loads(json.dumps(...))`` keeps non-JSON-serialisable
        # values caught at the SQLAlchemy boundary instead of here, where
        # the error would be obscured.
        self.result = copy.deepcopy(result)


@asynccontextmanager
async def record_activity(
    activity_type: str,
    *,
    params: Optional[dict[str, Any]] = None,
    node_id: Optional[int] = None,
) -> AsyncIterator[_ActivityCtx]:
    """Async context manager that creates / updates a ``Request`` row
    around the wrapped operation.

    Raises whatever the wrapped block raises — never swallows. If the
    DB write that records the terminal state itself fails, the original
    exception is preserved (logged but not replaced).
    """
    # Insert the running row before the operation starts. We commit and
    # close the session immediately so a long-running op doesn't hold a
    # DB connection.
    with get_session() as s:
        req = Request(
            node_id=node_id,
            type=activity_type,
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
        # The DB write itself is best-effort: if it fails (e.g. SQLite is
        # locked, agent shutting down) we log and re-raise the ORIGINAL
        # exception. Without the guard a DB error would shadow the real
        # cause and break callers' `except LLMError:` / cancellation paths.
        try:
            with get_session() as s:
                row = s.get(Request, rid)
                if row is not None:
                    row.status = "failed"
                    # Prefer the exception's own message; fall back to
                    # the class name so the activity row never carries a
                    # vacuous string like "auto_prompt" when the caller
                    # raised RuntimeError() with no message.
                    row.error = str(exc)[:1000] or exc.__class__.__name__
                    row.finished_at = datetime.now(timezone.utc)
                    s.add(row)
                    s.commit()
        except Exception:  # noqa: BLE001
            logger.exception(
                "activity: failed to mark row %d as failed (original exc preserved)", rid
            )
        raise
    else:
        try:
            with get_session() as s:
                row = s.get(Request, rid)
                if row is not None:
                    row.status = "done"
                    row.result = dict(ctx.result)
                    row.finished_at = datetime.now(timezone.utc)
                    s.add(row)
                    s.commit()
        except Exception:  # noqa: BLE001
            # Wrapped op succeeded; only the bookkeeping write failed.
            # Don't propagate — the user got their result. Log loudly so
            # operators see the row is stuck on "running" and can act.
            logger.exception(
                "activity: failed to mark row %d as done (caller's result returned normally)", rid
            )
