# Autopilot Run 7 — Implementation Plan

Tracks `.omc/autopilot/spec.md`.

## Wave A — Agent core (orchestrator)

1. `agent/flowboard/services/claude_cli.py` (new) — subprocess wrapper + availability cache.
2. `agent/flowboard/services/planner.py` (modify) — add `generate_plan_reply`; keep `generate_mock_reply`; dispatch based on `FLOWBOARD_PLANNER_BACKEND`.
3. `agent/flowboard/config.py` — `PLANNER_BACKEND` env.
4. `agent/flowboard/routes/chat.py` — call async planner, persist `Plan`, extend response shape.

## Wave B — Tests (orchestrator)

5. `agent/tests/test_claude_cli.py` (new).
6. `agent/tests/test_planner.py` (new).
7. `agent/tests/test_chat.py` — extend to cover plan field.

## Wave C — Frontend (delegate to executor, Sonnet)

One executor pass:
- `api/client.ts` — `PlanDTO` + extended `ChatSendResponse`.
- `store/chat.ts` — attach plans to messages.
- `components/ChatSidebar.tsx` — plan preview card.

## Wave D — QA

- pytest ≥90 green.
- tsc clean.
- Restart agent; curl smoke with planner enabled.

## Wave E — Validation

Self-validate focusing on:
- Subprocess argv safety (no shell=True, each arg separate).
- Timeout coverage.
- Planner fallback on CLI unavailable.
- Plan row not duplicated on retry.

## Wave F — Cleanup

Remove `.omc/autopilot/spec.md`. Write summary with:
- How to toggle backend (env var).
- Cost caveat.
- Run 8 = ghost nodes + plan execution.

## Risks

Latency, cost, JSON parse, CLI version drift — all documented in spec.
