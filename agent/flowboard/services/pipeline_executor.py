"""Pipeline executor — materialize a chat-proposed plan and run it.

A ``Plan.spec`` looks roughly like::

    {
      "nodes": [
        {"tmp_id": "a", "type": "character", "params": {"prompt": "..."}},
        {"tmp_id": "b", "type": "image",     "params": {"prompt": "..."}},
        {"tmp_id": "c", "type": "video",     "params": {"prompt": "..."}}
      ],
      "edges": [
        {"from": "a", "to": "b", "kind": "ref"},
        {"from": "b", "to": "c", "kind": "ref"}
      ],
      "layout_hint": "left_to_right"
    }

``materialize_plan`` writes the spec to the DB (Node + Edge rows). Endpoints
in edges may reference a ``tmp_id`` from this plan or a ``#shortId`` of an
existing node on the same board — the executor resolves both.

``run_pipeline`` walks the resulting DAG topologically. For ``image``/``video``
nodes that have a prompt, it enqueues a Request through the existing worker
(``flowboard.worker.processor``) and waits for the row to settle, threading
upstream media ids forward (character refs for image, start media id for
video). One node's failure does not abort the whole run — independent branches
keep going; downstream-of-failure nodes are short-circuited to ``error`` with
a synthetic ``upstream_failed`` reason.

This module is imported by ``routes/plans.py``; the actual ``asyncio.create_task``
spawning happens there so we stay testable here.
"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Edge, Node, PipelineRun, Plan, Request
from flowboard.short_id import generate_unique_short_id
from flowboard.worker.processor import get_worker

logger = logging.getLogger(__name__)


# ── Layout ────────────────────────────────────────────────────────────────


COL_WIDTH = 280
ROW_HEIGHT = 200
ORIGIN_X = 200.0
ORIGIN_Y = 200.0


def auto_layout(
    spec_nodes: list[dict],
    spec_edges: list[dict],
    *,
    existing_short_ids: set[str] | None = None,
) -> dict[str, tuple[float, float]]:
    """Assign (x, y) to each ``tmp_id`` based on topological depth.

    Edges that reference unknown endpoints (typo, or ``#shortId`` of a
    pre-existing node) are ignored for depth purposes — they don't push
    anything in the new plan deeper.
    """
    tmp_ids = [n.get("tmp_id") for n in spec_nodes if isinstance(n.get("tmp_id"), str)]
    tmp_set = set(tmp_ids)
    existing = existing_short_ids or set()

    incoming: dict[str, set[str]] = defaultdict(set)
    outgoing: dict[str, set[str]] = defaultdict(set)
    for e in spec_edges:
        src = _normalise_endpoint(e.get("from"))
        dst = _normalise_endpoint(e.get("to"))
        if src is None or dst is None:
            continue
        # Only consider edges whose target is one of the new plan nodes for
        # depth calculation. Edges to/from existing #shortId nodes don't shift
        # new layout.
        if dst in tmp_set:
            if src in tmp_set:
                incoming[dst].add(src)
                outgoing[src].add(dst)
            elif src in existing:
                # Treat as a virtual root: increment depth by 1.
                incoming[dst].add(f"__existing__:{src}")

    # Compute depth via BFS from roots.
    depth: dict[str, int] = {}
    roots = [t for t in tmp_ids if not incoming.get(t)]
    queue: list[tuple[str, int]] = [(r, 0) for r in roots]
    while queue:
        node, d = queue.pop(0)
        prev = depth.get(node)
        if prev is not None and prev >= d:
            continue
        depth[node] = d
        for child in outgoing.get(node, ()):
            queue.append((child, d + 1))

    # Any node not reached (cycle) gets depth 0.
    for t in tmp_ids:
        depth.setdefault(t, 0)

    # Group by depth and assign row index.
    by_depth: dict[int, list[str]] = defaultdict(list)
    for t in tmp_ids:  # preserve declaration order within a depth
        by_depth[depth[t]].append(t)

    layout: dict[str, tuple[float, float]] = {}
    for d, ids in by_depth.items():
        for row, t in enumerate(ids):
            layout[t] = (ORIGIN_X + d * COL_WIDTH, ORIGIN_Y + row * ROW_HEIGHT)
    return layout


def _normalise_endpoint(raw: Any) -> Optional[str]:
    """Edges may use bare ``tmp_id`` or ``#shortId``. Strip the leading ``#``."""
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw:
        return None
    return raw[1:] if raw.startswith("#") else raw


# ── Materialisation ────────────────────────────────────────────────────────


_VALID_NODE_TYPES = {
    # legacy
    "character", "image", "video", "prompt", "note", "Storyboard", "visual_asset",
    # Concepta fork
    "reference", "style_pack", "concept", "multiview", "part", "variant", "list",
    "pose", "turntable",
}


def materialize_plan(session, plan_id: int) -> dict:
    """Create Node + Edge rows for ``plan.spec``. Returns a summary dict.

    Idempotent at the row level — won't re-create rows on re-run. Looks for an
    existing PipelineRun-tagged set via ``Plan.spec[\"_materialized_node_ids\"]``;
    if present, returns those rows untouched.
    """
    plan = session.get(Plan, plan_id)
    if plan is None:
        raise ValueError(f"plan {plan_id} not found")

    spec = plan.spec or {}
    spec_nodes = spec.get("nodes") or []
    spec_edges = spec.get("edges") or []
    if not isinstance(spec_nodes, list):
        spec_nodes = []
    if not isinstance(spec_edges, list):
        spec_edges = []

    # Idempotent re-run: if we've already materialised, return what we have.
    cached_ids = spec.get("_materialized_node_ids")
    if isinstance(cached_ids, list) and cached_ids:
        nodes = list(
            session.exec(select(Node).where(Node.id.in_(cached_ids))).all()  # type: ignore[attr-defined]
        )
        if nodes:
            return {
                "plan_id": plan_id,
                "node_ids": [n.id for n in nodes],
                "tmp_to_node_id": spec.get("_tmp_to_node_id") or {},
                "created": False,
            }

    board_id = plan.board_id
    # Existing #shortId index for edge endpoint resolution.
    existing_nodes = list(
        session.exec(select(Node).where(Node.board_id == board_id)).all()
    )
    short_id_to_node: dict[str, Node] = {n.short_id: n for n in existing_nodes if n.short_id}

    layout = auto_layout(
        spec_nodes, spec_edges, existing_short_ids=set(short_id_to_node)
    )

    # Build initial data + create Node rows.
    tmp_to_node_id: dict[str, int] = {}
    created_node_ids: list[int] = []
    skipped: list[str] = []

    for spec_node in spec_nodes:
        if not isinstance(spec_node, dict):
            continue
        tmp_id = spec_node.get("tmp_id")
        node_type = spec_node.get("type")
        if not isinstance(tmp_id, str) or not tmp_id:
            skipped.append("(missing tmp_id)")
            continue
        if node_type not in _VALID_NODE_TYPES:
            skipped.append(tmp_id)
            logger.warning("plan %s: skipping node %s with bad type %r", plan_id, tmp_id, node_type)
            continue
        params = spec_node.get("params") or {}
        if not isinstance(params, dict):
            params = {}
        title = (
            params.get("title")
            if isinstance(params.get("title"), str)
            else node_type.title()
        )
        prompt = params.get("prompt") if isinstance(params.get("prompt"), str) else None

        x, y = layout.get(tmp_id, (ORIGIN_X, ORIGIN_Y))
        short_id = generate_unique_short_id(session, board_id)
        data: dict[str, Any] = {"title": title}
        if prompt:
            data["prompt"] = prompt
        node = Node(
            board_id=board_id,
            short_id=short_id,
            type=node_type,
            x=x,
            y=y,
            data=data,
            status="idle",
        )
        session.add(node)
        session.flush()  # need node.id for tmp_to_node_id
        assert node.id is not None
        tmp_to_node_id[tmp_id] = node.id
        created_node_ids.append(node.id)

    # Edges. Endpoints resolve via tmp_to_node_id first, then existing short_ids.
    created_edge_ids: list[int] = []
    for spec_edge in spec_edges:
        if not isinstance(spec_edge, dict):
            continue
        src_raw = _normalise_endpoint(spec_edge.get("from"))
        dst_raw = _normalise_endpoint(spec_edge.get("to"))
        if src_raw is None or dst_raw is None:
            continue
        kind = spec_edge.get("kind") if isinstance(spec_edge.get("kind"), str) else "ref"
        if kind not in ("ref", "hint"):
            kind = "ref"

        src_id = _resolve_endpoint(src_raw, tmp_to_node_id, short_id_to_node)
        dst_id = _resolve_endpoint(dst_raw, tmp_to_node_id, short_id_to_node)
        if src_id is None or dst_id is None:
            logger.warning(
                "plan %s: skipping edge %s→%s (unresolved endpoint)",
                plan_id, src_raw, dst_raw,
            )
            continue
        if src_id == dst_id:
            continue

        edge = Edge(
            board_id=board_id, source_id=src_id, target_id=dst_id, kind=kind,
        )
        session.add(edge)
        session.flush()
        assert edge.id is not None
        created_edge_ids.append(edge.id)

    # Persist materialisation hint on the plan so re-runs are idempotent.
    new_spec = dict(spec)
    new_spec["_materialized_node_ids"] = created_node_ids
    new_spec["_tmp_to_node_id"] = tmp_to_node_id
    plan.spec = new_spec
    session.add(plan)
    # Caller commits.

    return {
        "plan_id": plan_id,
        "node_ids": created_node_ids,
        "edge_ids": created_edge_ids,
        "tmp_to_node_id": tmp_to_node_id,
        "skipped": skipped,
        "created": True,
    }


def _resolve_endpoint(
    raw: str,
    tmp_to_node_id: dict[str, int],
    short_id_to_node: dict[str, Node],
) -> Optional[int]:
    if raw in tmp_to_node_id:
        return tmp_to_node_id[raw]
    node = short_id_to_node.get(raw)
    if node is not None and node.id is not None:
        return node.id
    return None


# ── Execution ─────────────────────────────────────────────────────────────


_DEFAULT_REQUEST_TIMEOUT_S = 180.0
_REQUEST_POLL_INTERVAL_S = 0.5


async def run_pipeline(
    run_id: int,
    *,
    request_timeout_s: float = _DEFAULT_REQUEST_TIMEOUT_S,
    poll_interval_s: float = _REQUEST_POLL_INTERVAL_S,
) -> None:
    """Execute the plan attached to PipelineRun[run_id]. Long-running."""
    logger.info("pipeline run %s: starting", run_id)

    # Load run + plan + materialised nodes/edges.
    with get_session() as s:
        run = s.get(PipelineRun, run_id)
        if run is None:
            logger.warning("pipeline run %s not found at start", run_id)
            return
        plan = s.get(Plan, run.plan_id)
        if plan is None:
            run.status = "failed"
            run.error = "plan_missing"
            run.finished_at = datetime.now(timezone.utc)
            s.add(run)
            s.commit()
            return

        # Mark started.
        run.status = "running"
        run.started_at = datetime.now(timezone.utc)
        plan.status = "running"
        s.add(run)
        s.add(plan)
        s.commit()
        s.refresh(run)
        s.refresh(plan)

        node_ids: list[int] = list(plan.spec.get("_materialized_node_ids") or [])
        if not node_ids:
            run.status = "failed"
            run.error = "no_materialized_nodes"
            run.finished_at = datetime.now(timezone.utc)
            plan.status = "failed"
            s.add(run)
            s.add(plan)
            s.commit()
            return

        # Pull the snapshot we need before releasing the session.
        nodes = list(
            s.exec(select(Node).where(Node.id.in_(node_ids))).all()  # type: ignore[attr-defined]
        )
        node_by_id = {n.id: n for n in nodes}
        board_id = plan.board_id
        edges = list(
            s.exec(
                select(Edge).where(
                    Edge.board_id == board_id,
                    Edge.source_id.in_(node_ids) | Edge.target_id.in_(node_ids),  # type: ignore[attr-defined]
                )
            ).all()
        )

    # Build adjacency limited to nodes within this plan.
    incoming: dict[int, list[int]] = defaultdict(list)
    outgoing: dict[int, list[int]] = defaultdict(list)
    for e in edges:
        if e.source_id in node_by_id and e.target_id in node_by_id:
            incoming[e.target_id].append(e.source_id)
            outgoing[e.source_id].append(e.target_id)

    order = _topo_sort(node_ids, incoming)
    failed_nodes: set[int] = set()

    for nid in order:
        node = node_by_id.get(nid)
        if node is None:
            continue

        # Short-circuit on upstream failure.
        upstream_failed = any(s in failed_nodes for s in incoming.get(nid, ()))
        if upstream_failed:
            failed_nodes.add(nid)
            _stamp_node_status(nid, "error", error="upstream_failed")
            continue

        if node.type not in ("image", "video"):
            # character/prompt/note nodes have no generation step.
            continue

        prompt = (node.data or {}).get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            # No prompt → leave node idle. Not an error.
            continue

        # Resolve project_id from board → BoardFlowProject.
        project_id = _project_id_for_board(board_id)
        if project_id is None:
            failed_nodes.add(nid)
            _stamp_node_status(nid, "error", error="no_project")
            continue

        # Image: collect upstream character mediaIds.
        # Video: pick the first upstream image's mediaId as start.
        upstream_node_ids = incoming.get(nid, ())
        upstream_nodes = [node_by_id[u] for u in upstream_node_ids if u in node_by_id]

        if node.type == "image":
            ref_media_ids = [
                (u.data or {}).get("mediaId")
                for u in upstream_nodes
                if u.type in ("character", "image", "visual_asset")
                and isinstance((u.data or {}).get("mediaId"), str)
            ]
            ref_media_ids = [m for m in ref_media_ids if m]
            params = {
                "prompt": prompt.strip(),
                "project_id": project_id,
            }
            if ref_media_ids:
                params["ref_media_ids"] = ref_media_ids
            req_type = "gen_image"
        else:  # video
            start_media_id = None
            for u in upstream_nodes:
                if u.type == "image":
                    mid = (u.data or {}).get("mediaId")
                    if isinstance(mid, str) and mid:
                        start_media_id = mid
                        break
            if not start_media_id:
                failed_nodes.add(nid)
                _stamp_node_status(nid, "error", error="missing_upstream_image")
                continue
            params = {
                "prompt": prompt.strip(),
                "project_id": project_id,
                "start_media_id": start_media_id,
            }
            req_type = "gen_video"

        # Stamp running, dispatch.
        _stamp_node_status(nid, "running")
        request_row_id = _create_request_row(nid, req_type, params)
        get_worker().enqueue(request_row_id)

        # Wait for the row to settle.
        try:
            settled = await _await_request(
                request_row_id,
                timeout_s=request_timeout_s,
                poll_s=poll_interval_s,
            )
        except asyncio.TimeoutError:
            failed_nodes.add(nid)
            _stamp_node_status(nid, "error", error="timeout")
            continue

        if settled.status == "done":
            result = settled.result or {}
            media_ids = result.get("media_ids") if isinstance(result.get("media_ids"), list) else []
            media_id = media_ids[0] if media_ids else None
            patch: dict[str, Any] = {"mediaIds": media_ids}
            if media_id:
                patch["mediaId"] = media_id
            _stamp_node_status(nid, "done", data_patch=patch)
            # Refresh in-memory snapshot so downstream nodes see the new mediaId.
            with get_session() as s:
                fresh = s.get(Node, nid)
                if fresh is not None:
                    node_by_id[nid] = fresh
        else:
            failed_nodes.add(nid)
            _stamp_node_status(nid, "error", error=settled.error or "request_failed")

    # Finalise pipeline run + plan.
    final_status = "failed" if failed_nodes else "done"
    with get_session() as s:
        run = s.get(PipelineRun, run_id)
        if run is not None:
            run.status = final_status
            run.finished_at = datetime.now(timezone.utc)
            if failed_nodes:
                run.error = f"failed_nodes:{sorted(failed_nodes)}"
            s.add(run)
        plan2 = s.get(Plan, run.plan_id) if run else None
        if plan2 is not None:
            plan2.status = final_status
            s.add(plan2)
        s.commit()
    logger.info(
        "pipeline run %s: finished status=%s failed=%d",
        run_id, final_status, len(failed_nodes),
    )


def _topo_sort(node_ids: Iterable[int], incoming: dict[int, list[int]]) -> list[int]:
    """Kahn's algorithm. Cycles get appended at the end (best-effort)."""
    pending = list(node_ids)
    in_count = {nid: len(incoming.get(nid, ())) for nid in pending}
    ready = [nid for nid, c in in_count.items() if c == 0]
    out: list[int] = []
    seen: set[int] = set()
    # Track forward edges via the inverse of incoming.
    forward: dict[int, list[int]] = defaultdict(list)
    for tgt, srcs in incoming.items():
        for s in srcs:
            forward[s].append(tgt)
    while ready:
        nid = ready.pop(0)
        if nid in seen:
            continue
        seen.add(nid)
        out.append(nid)
        for child in forward.get(nid, ()):
            in_count[child] -= 1
            if in_count[child] <= 0:
                ready.append(child)
    # Any leftover (cycle) gets appended.
    for nid in pending:
        if nid not in seen:
            out.append(nid)
    return out


def _project_id_for_board(board_id: int) -> Optional[str]:
    from flowboard.db.models import BoardFlowProject  # local import to avoid cycle

    with get_session() as s:
        row = s.get(BoardFlowProject, board_id)
        return row.flow_project_id if row is not None else None


def _stamp_node_status(
    node_id: int,
    status: str,
    *,
    error: Optional[str] = None,
    data_patch: Optional[dict] = None,
) -> None:
    with get_session() as s:
        n = s.get(Node, node_id)
        if n is None:
            return
        n.status = status
        merged = dict(n.data or {})
        if data_patch:
            merged.update(data_patch)
        if error:
            merged["error"] = error
        n.data = merged
        s.add(n)
        s.commit()


def _create_request_row(node_id: int, req_type: str, params: dict) -> int:
    with get_session() as s:
        req = Request(
            node_id=node_id,
            type=req_type,
            params=dict(params),
            status="queued",
        )
        s.add(req)
        s.commit()
        s.refresh(req)
        assert req.id is not None
        return req.id


async def _await_request(
    request_id: int,
    *,
    timeout_s: float,
    poll_s: float,
) -> Request:
    elapsed = 0.0
    while elapsed < timeout_s:
        await asyncio.sleep(poll_s)
        elapsed += poll_s
        with get_session() as s:
            row = s.get(Request, request_id)
            if row is None:
                raise RuntimeError(f"request {request_id} disappeared")
            if row.status in ("done", "failed"):
                return row
    raise asyncio.TimeoutError()
