# Autopilot Run 3 — Implementation Plan

Tracks `.omc/autopilot/spec.md`. Three waves of file changes + test + QA + review.

## Wave A — Agent core (orchestrator writes directly)

Files new / rewritten:
- `agent/flowboard/main.py` — swap to lifespan, start WS + worker tasks, register `/api/ext/callback`, extend `/api/health` with `ws_stats`.
- `agent/flowboard/services/flow_client.py` — full rewrite with async futures keyed by id, stats tracking, `ws_stats` property.
- `agent/flowboard/services/ws_server.py` (new) — `run_ws_server()` using `websockets.serve` bound to `WS_HOST:WS_PORT`.
- `agent/flowboard/routes/requests.py` (new) — POST + GET.
- `agent/flowboard/worker/processor.py` — rewrite the placeholder: queue + drain loop + dispatch.
- `agent/flowboard/routes/__init__.py` — unchanged; just ensure imports line up.
- `agent/flowboard/config.py` — already has `EXTENSION_WS_PORT` env + default; add `WS_HOST` default `127.0.0.1`.
- Drop `agent/flowboard/routes/ws.py` (old `/ws/extension`) OR convert to a small stub that 410s the endpoint. **Choice**: drop entirely and remove registration from main.py — clean break; background.js is being rewritten anyway.

## Wave B — Extension rewrite (delegate to executor)

Files:
- `extension/manifest.json` (modify)
- `extension/background.js` (full rewrite — scaled-down flowkit port)
- `extension/popup.html` (rewrite)
- `extension/popup.js` (new)
- `extension/rules.json` (new, `[]`)

Style must follow flowkit visually: compact, monospaced status card, buttons muted with icons.

## Wave C — Frontend + tests (orchestrator)

- `frontend/src/components/StatusBar.tsx` — read `ws_stats.request_count` when connected, show as small pill.
- `agent/tests/test_flow_client.py` (new)
- `agent/tests/test_requests.py` (new)
- `agent/tests/test_ext_callback.py` (new)
- `agent/tests/test_lifespan.py` (new, single smoke)

## Wave D — QA

- `.venv/bin/pytest` green.
- Frontend `tsc` clean.
- Kill existing agent (`be4ykzwow`) and restart; confirm `WebSocket server listening on ws://127.0.0.1:9222` in logs + `/api/health` returns `ws_stats`.

## Wave E — Validation (3 parallel reviewers)

- Architect: acceptance criteria 1-6.
- Code-reviewer: callback secret hygiene, future leak guards, worker shutdown race.
- Security: **boost focus on /api/ext/callback** (open from any localhost process), URL allowlist in extension, WS origin policy on :9222.

## Wave F — Cleanup

- Remove `.omc/autopilot/`.
- Keep `.omc/plans/autopilot-run3.md` for history.

## Risks

1. **uvicorn --reload + dedicated WS server.** `--reload` does not always re-execute lifespan cleanly on every edit; during dev the WS server can leak. Document: restart uvicorn manually after lifespan changes.
2. **`websockets` library version vs `websockets>=12`** already in pyproject. Compatible.
3. **Extension host permission grant.** On reload, Chrome may prompt the user to re-grant `webRequest` permission. Not a test concern, just a user-facing note.
4. **Callback secret rotation.** Secret is generated at boot; if the WS drops and the extension reconnects, it gets a fresh secret. Old pending futures resolved with the fresh secret are fine; old extension-side pending fetches will get an auth mismatch on their callback. We'll accept that — the extension's old in-flight requests get logged as errors; the agent never waits longer than 180s.
5. **Worker startup race with FastAPI.** Worker starts inside lifespan before yield. If any request is enqueued in the same tick as shutdown, we want graceful drain. `drain()` awaits inflight.
6. **TestClient doesn't run lifespan by default in older FastAPI versions.** We use 0.115+, which should run `lifespan` automatically via `with TestClient(app) as c:`. Our conftest currently uses the plain `TestClient(app)` — this might not invoke lifespan, meaning the WS server + worker won't start during tests. **That's fine** for unit tests: we stub flow_client directly for `test_requests.py` and never rely on actual WS in tests.

## Acceptance

All 6 criteria in spec. At least 35 tests passing (baseline 28 + expected ~8 new).
