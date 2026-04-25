# Autopilot Run 5 — Implementation Plan

Tracks `.omc/autopilot/spec.md`. Backend first (smaller + gates frontend),
then parallel frontend via executor.

## Wave A — Backend (orchestrator)

1. `agent/flowboard/db/models.py` — append `BoardFlowProject` SQLModel.
2. `agent/flowboard/routes/projects.py` (new) — POST + GET with idempotency.
3. `agent/flowboard/main.py` — register router.
4. `agent/tests/test_board_project.py` (new) — SDK stubbed to assert
   idempotency + error paths.

## Wave B — Frontend (delegate to executor, Sonnet)

All files listed in spec §Frontend scope. Single executor task keeps
dialog + viewer + generation store + NodeCard extension + Board
interactions + CSS internally consistent.

## Wave C — QA

- pytest ≥67 pass
- `tsc -b --noEmit` clean
- Agent health still `ok`
- Vite HMR picks up changes automatically

## Wave D — Validation (3 reviewers)

- Architect: acceptance criteria 1-7 map to code; polling lifecycle correct
- Code-reviewer: race conditions (cancel on regenerate, user deletes node
  mid-gen, rfId → DB id mapping), modal accessibility, dead-code from
  Run 4's `TestClient` workaround
- Security: flow_project_id handling on frontend (trusted string returned
  from our own backend — no XSS risk since React escapes); external link
  to labs.google with `rel="noopener noreferrer"` attribute

## Wave E — Cleanup

Remove `.omc/autopilot/`. Write summary with step-by-step test recipe.

## Risks already captured in spec

Polling race, g-key conflict, extension disconnect surfaces, project
title conflicts.
