# Autopilot Run 2 — Implementation Plan

Tracks `.omc/autopilot/spec.md`. Five waves; tasks within a wave run in parallel where files differ.

## Wave A — Backend micro-changes (directly by orchestrator)

| Task | File | Summary |
|---|---|---|
| A5 | `agent/flowboard/db/models.py` | Switch `datetime.utcnow` to `lambda: datetime.now(timezone.utc)` on all `default_factory=`. Import `timezone`. |
| A2+A3 | `agent/flowboard/routes/nodes.py` | Add `Literal` type + `status` enums, `Field(ge=…, le=…)` bounds on coord fields in both `NodeCreate` and `NodeUpdate`. |
| A2 | `agent/flowboard/routes/edges.py` | `kind: Literal["ref"] = "ref"`. |
| B1 | `agent/flowboard/routes/chat.py` (new) | POST/GET routes; use `services.planner.generate_mock_reply`. |
| B1 | `agent/flowboard/main.py` | Register `chat.router`. |
| B2 | `agent/flowboard/services/planner.py` (new) | `generate_mock_reply(session, board_id, user_text, mention_short_ids) -> str`. |

## Wave B — Frontend (single executor agent, parallel internally)

Delegate to `executor` (sonnet):
- A1 Toaster
- A4 NodeCard typed props
- B3 `api/client.ts` chat methods + `store/chat.ts`
- B4 `ChatSidebar.tsx` full rewrite per design `04-chat-sidebar.png`
- B5 Mention autocomplete inside composer

Consistency constraints:
- Reuse existing CSS tokens, extend `styles.css` only for new primitives (`.toaster`, `.chat-message--user`, `.mention-popover`, etc.)
- No new dependencies.
- `tsc -b --noEmit` must stay clean.

## Wave C — Tests

Directly by orchestrator:
- `agent/tests/test_chat.py` — chat round-trip, mentions, assistant persisted, GET order.
- Append to `agent/tests/test_nodes.py` — 422 on invalid `type`, 422 on out-of-range coords, 5xx (or wrapped 404) on orphan `board_id` once FK is on.
- `agent/tests/test_edges.py` — 422 on invalid `kind`.

## Wave D — QA

- `.venv/bin/pytest agent/tests/ -q` → all green.
- `frontend/node_modules/.bin/tsc -b --noEmit` → clean.
- Up to 3 fix cycles; stop if the same error re-occurs 2×.

## Wave E — Validation

3 reviewers in parallel (architect, code-reviewer, security-reviewer). Scope:
- New chat surface (potential injection via `message` body, cross-site use of `/api/chat`).
- Store cross-boundary (chat ↔ board).
- Toaster accessibility.

## Wave F — Cleanup

Remove `.omc/autopilot/spec.md`, leave `.omc/plans/autopilot-run2.md`, report summary.

## Risks & mitigations

1. **FK pragma breaks existing tests.** Rerun immediately after A5; if `test_edges.py::test_edge_crossing_board_rejected` starts failing with IntegrityError instead of 400, reorder the validation in `edges.py` to check existence first.
2. **Mention autocomplete trap for `Enter`.** Only preventDefault when popover is open AND filtered list non-empty; when closed, Enter should be a newline (shift+Enter alt) or submit — pick submit on bare Enter, shift+Enter for newline (per design `04` hint "⌘Enter send" but single-line behavior acceptable for now).
3. **Chat order.** Use `ORDER BY created_at ASC, id ASC` to handle same-millisecond inserts.
