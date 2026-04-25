# Autopilot Run 8 — Implementation Plan

## Wave A — Agent SDK + worker (orchestrator)

1. `services/flow_sdk.py` — gen_video + check_async + VIDEO_MODEL_KEYS.
2. `worker/processor.py` — `_handle_gen_video` handler with poll loop.
3. `services/media.py` — no changes (already handles video mime).

## Wave B — Tests (orchestrator)

4. `test_flow_sdk.py` — gen_video body + check_async extraction.
5. `test_requests.py` — worker gen_video handler with stub SDK + timeout.

## Wave C — Frontend (delegate to executor, Sonnet)

6. NodeCard VideoBody with `<video>` tag + retry.
7. ResultViewer switch on type for `<video>`.
8. GenerationDialog branching: video shows aspect LANDSCAPE/PORTRAIT only + source image picker.
9. store/generation.ts: dispatchGeneration branches by kind.

## Wave D — QA

- pytest ≥115 green.
- tsc clean.
- Agent restart.
- Dry curl: gen_video without start_media_id → missing_start_media_id error.

## Wave E — Validation (self)

Focus: polling correctness, timeout behavior, operation name parsing, captcha action, ResultViewer `<video>` controls accessibility.

## Wave F — Cleanup

Remove `.omc/autopilot/`. Write summary with smoke steps.
