"""The one way a finished request writes its outcome onto its Node.

Two callers, two lifecycles, one merge:

  * the worker settles a generation and its Node in a single commit, so it
    needs to STAGE the node change into the session that already carries
    the pending ``Request`` stamp → :func:`stage_node_patch`.
  * the synchronous LLM activities (``vision``, ``auto_prompt``) have no
    such session — they run inside an HTTP handler and their ``Request``
    row is settled for them by ``services/activity.py`` — so they need a
    self-contained write → :func:`apply_node_patch`.

Lives at the top level, next to ``request_types``, for the same reason
that module does: a service importing ``worker/processor`` to reach this
would drag in the Flow SDK, the extension client and the media service.

The merge itself is the part that must not be written twice. ``Node.data``
is a JSON blob holding everything the card renders, and a request only
ever knows about its own few keys — replacing the dict instead of merging
into it silently drops the rest (thumbnail, aspect ratio, variant count).
A second implementation of "merge, except None means delete" would be a
second chance to get that wrong.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from flowboard.db import get_session
from flowboard.db.models import Node

logger = logging.getLogger(__name__)


def stage_node_patch(
    session,
    node_id: Optional[int],
    *,
    status: Optional[str] = None,
    data_patch: Optional[dict[str, Any]] = None,
) -> None:
    """Stage a request's outcome onto its Node, inside the caller's session.

    Staging only — the caller commits. Running in the same session as the
    Request update is what lets the two land in one commit, but it is also
    why this has to be careful: the Request stamp is already pending on
    this session, and anything that throws here must not take it down.

    Two guards, for two different ways that used to happen:

      * ``no_autoflush``. ``session.get(Node, …)`` normally autoflushes the
        pending Request first. If that flush raised, the ``except`` below
        swallowed it and left the Session rollback-pending, so the caller's
        ``commit()`` — outside every guard — died with
        ``PendingRollbackError``, which landed in the worker's outer
        handler and rewrote a *successful, paid* generation as ``failed``.
        Not flushing here means a Node lookup can never carry the Request
        with it.
      * The blanket ``except``, for a Node that refuses to update at all
        (deleted mid-flight, unexpected column state). A stale node card
        is cosmetic; an unsettled request is a dead generation.

    In the worker the commit itself is guarded by ``_commit_settlement``.

    ``data_patch`` merges into ``Node.data`` key by key; a ``None`` value
    is the explicit "remove this key" sentinel (a JSON blob has no other
    way to say it, since an absent key already means "leave alone").
    """
    if node_id is None:
        return
    try:
        with session.no_autoflush:
            node = session.get(Node, node_id)
            if node is None:
                # Node deleted while its generation was in flight. The
                # request row survives (delete_node detaches rather than
                # deletes) and settles normally; there is just nothing
                # left to mirror onto.
                return
            if status is not None:
                node.status = status
            if data_patch:
                merged = dict(node.data or {})
                for key, value in data_patch.items():
                    if value is None:
                        merged.pop(key, None)
                    else:
                        merged[key] = value
                node.data = merged
            session.add(node)
    except Exception:  # noqa: BLE001
        logger.exception("node mirror failed for node_id=%s", node_id)


def apply_node_patch(
    node_id: Optional[int],
    *,
    status: Optional[str] = None,
    data_patch: Optional[dict[str, Any]] = None,
) -> None:
    """Same merge, in a session of its own, committed here.

    For callers whose Request row is settled elsewhere — the synchronous
    LLM activities, whose row belongs to the ``record_activity`` context
    manager wrapped around them.

    Never raises, by the same reasoning as the worker's mirror and then
    some: these callers are HTTP handlers that have already produced the
    answer the user asked for. A node write that fails must not turn a
    finished vision call into a 502, and must not stop
    ``record_activity`` from marking the row ``done`` — the result is
    still in the row either way, which is what makes it recoverable.
    Losing the mirror costs a cosmetic refresh; losing the response costs
    the LLM call.
    """
    if node_id is None:
        return
    try:
        with get_session() as s:
            stage_node_patch(s, node_id, status=status, data_patch=data_patch)
            s.commit()
    except Exception:  # noqa: BLE001
        logger.exception(
            "node mirror commit failed for node_id=%s (caller's result is unaffected)",
            node_id,
        )
