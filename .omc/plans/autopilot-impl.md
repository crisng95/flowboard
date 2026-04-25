# Flowboard Phase 1 — Implementation Plan (autopilot)

Driven by `.omc/autopilot/spec.md`. 11 code tasks + 2 meta tasks (QA, validation).

## Execution order & parallelism

Three waves. Within a wave, tasks are independent and can run in parallel. Between waves, later tasks depend on earlier tasks' files.

### Wave A — Backend foundations (parallel)
- **T3** Node CRUD routes (`agent/flowboard/routes/nodes.py`)
- **T4** Edge CRUD routes (`agent/flowboard/routes/edges.py`)
- **T5** Board PATCH (append to `agent/flowboard/routes/boards.py`)
- **T6** Short-ID uniqueness helper (update `agent/flowboard/short_id.py`)

All four touch different files; no conflicts. T3 uses T6's helper — coordinate by writing the helper first within T6, then T3 imports it. If T6 arrives late, T3 can ship with the plain generator and swap to unique helper in a follow-up commit (not ideal — we'll serialize T6 before T3).

**Revised ordering:** T6 → {T3, T4, T5} parallel.

After wave A: register new routers in `agent/flowboard/main.py`.

### Wave B — Backend tests (sequential with wave A)
- **T7** pytest setup + route tests

Depends on wave A being complete.

### Wave C — Frontend (parallel after wave A)
- **T8** API client (`frontend/src/api/client.ts`)
- **T9** Board loader + store (`frontend/src/store/board.ts`)
- **T12** NodeCard v2 (`frontend/src/canvas/NodeCard.tsx`)
- **T13** Toolbar (`frontend/src/components/Toolbar.tsx`)

T9 depends on T8 (uses its exports). T10 and T11 depend on T8 + T9. T12 and T13 are independent.

**Revised ordering:** T8 → T9 → {T10, T11}. T12 and T13 parallel to any of the above.

### Wave D — Frontend wiring (sequential with wave C)
- **T10** Canvas interactions in `Board.tsx`: drag-persist, onConnect, onNodesDelete, onEdgesDelete
- **T11** Add-node palette (`frontend/src/canvas/AddNodePalette.tsx`) + mount in `App.tsx`

After wave D: update `App.tsx` to mount Toolbar + AddNodePalette + Board.

### Phase 3 — QA loop (T14)
- `cd agent && .venv/bin/pytest tests/` (expect all green)
- `cd frontend && npm run lint` (= `tsc -b --noEmit`)
- Cycle up to 5 times; stop if same error 3×.

### Phase 4 — Validation (T15)
Three parallel reviewer agents:
- `oh-my-claudecode:architect` — completeness vs spec success criteria 1-9
- `oh-my-claudecode:code-reviewer` — quality, SOLID, style consistency with Phase 0 code
- `oh-my-claudecode:security-reviewer` — OWASP on new routes (input validation, SQL injection, path traversal on media endpoint later, CORS config already lax for local-only)

Fix all blocking issues. Re-validate on rejections (max 3 rounds).

### Phase 5 — Cleanup (T16)
Remove `.omc/autopilot/`, `.omc/state/autopilot-*`, summarize in chat, leave plan file for reference.

## File inventory (new files this phase)

**Backend:**
- `agent/flowboard/routes/nodes.py`
- `agent/flowboard/routes/edges.py`
- `agent/tests/__init__.py`
- `agent/tests/conftest.py`
- `agent/tests/test_boards.py`
- `agent/tests/test_nodes.py`
- `agent/tests/test_edges.py`

**Frontend:**
- `frontend/src/canvas/AddNodePalette.tsx`
- `frontend/src/components/Toolbar.tsx`

**Modified:**
- `agent/flowboard/main.py` (register new routers)
- `agent/flowboard/routes/boards.py` (add PATCH)
- `agent/flowboard/short_id.py` (unique helper)
- `frontend/src/api/client.ts` (many methods)
- `frontend/src/store/board.ts` (remove seedNodes)
- `frontend/src/canvas/Board.tsx` (wire interactions)
- `frontend/src/canvas/NodeCard.tsx` (specimen-sheet spec)
- `frontend/src/App.tsx` (mount Toolbar + palette)
- `frontend/src/styles.css` (add status-strip / palette classes)

## Risks

- **SQLModel + FastAPI dependency injection**: session management is done with `get_session()` contextmanager in Phase 0. Routes use `with get_session() as s:` pattern. Keep consistent.
- **React Flow selection vs. deletion**: `onNodesDelete` fires after default delete behavior; Zustand must remove from state AND call the API. Avoid double-delete by not also listening to `onNodesChange` for deletion.
- **Debounce across unrelated nodes**: Use per-node debounce map or debounce per change.
- **Short-ID retry loop**: 16 attempts of 36^4 = 1.6M keys per board is plenty; if exhausted, raise 500 (realistically never hits).

## Acceptance

All 9 success criteria in spec must pass before marking T15 complete.
