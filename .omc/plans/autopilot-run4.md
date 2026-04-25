# Autopilot Run 4 — Implementation Plan

Tracks `.omc/autopilot/spec.md`.

## Wave A — Extension (delegate to executor, Sonnet)

One agent ports all three files + manifest in one pass to keep the captcha
wiring + TRPC handler internally consistent.

Files:
- `extension/content.js` (new — port from flowkit)
- `extension/injected.js` (new — port verbatim, including the TRPC fetch
  monkey-patch that fires `TRPC_MEDIA_URLS` events into a void)
- `extension/manifest.json` (modify — add `content_scripts`,
  `web_accessible_resources`)
- `extension/background.js` (extend — add `solveCaptcha`,
  `requestCaptchaFromTab`, update `handleApiRequest` for captcha, add
  `handleTrpcRequest`, dispatch `trpc_request` in WS onmessage)
- `extension/rules.json` (add declarative Referer override rule for TRPC
  if needed — flowkit ships one; mirror it to avoid 403s on
  labs.google TRPC)

## Wave B — Agent core (orchestrator writes)

Files:
- `agent/flowboard/services/flow_client.py` — accept optional
  `captcha_action` kwarg on `api_request`; new `trpc_request(url, method,
  headers, body, timeout=30)`.
- `agent/flowboard/services/flow_sdk.py` — new module, 2 methods per spec.
- `agent/flowboard/worker/processor.py` — add handlers
  `create_project` + `gen_image`.

## Wave C — Tests

- `agent/tests/test_flow_client.py` — add cases:
  - `api_request(captcha_action="IMAGE_GENERATION")` passes through to WS
    payload.
  - `trpc_request(...)` sends `method:"trpc_request"` + correlates same way.
- `agent/tests/test_flow_sdk.py` (new) — with mocked FlowClient, verify:
  - `create_project` body is `{"json": {"projectTitle": ..., "toolName":
    "PINHOLE"}}` and extracts `projectId` from the synthetic TRPC response.
  - `gen_image` body includes `clientContext.recaptchaContext.token=""`,
    `requests[0].imageAspectRatio`, `structuredPrompt.parts[0].text`.
  - `gen_image` result extracts `media_ids` from `data.media[].name`.
- `agent/tests/test_requests.py` — add:
  - Worker handler `create_project` with a stub SDK returns the project_id.
  - Worker handler `gen_image` with a stub SDK returns media_ids.

## Wave D — QA

- pytest green.
- tsc clean.
- Restart agent; verify `/api/health` unchanged.
- Reload extension in Chrome (user action) — document for smoke step.

## Wave E — Validation (3 reviewers in parallel)

Focus:
- **Architect** — acceptance criteria 1–8; does the SDK shape actually match
  flowkit's (spot check a couple of keys)?
- **Code-reviewer** — captcha-token injection deep-clones the body so the
  original doesn't mutate? retry logic on captcha timeout? SDK error paths
  surface `raw` without swallowing?
- **Security** — SITE_KEY acceptable to ship? Content script scope correct?
  TRPC endpoint allowlist server-side? Any new attack surface introduced
  by `trpc_request` bypass of the `aisandbox-pa` URL guard?

## Wave F — Cleanup + smoke-test doc

- Remove `.omc/autopilot/spec.md`.
- Add "Try it" curl block in summary chat message.

## Risks already captured in spec

1. Paygate tier 403.
2. Model name drift.
3. SITE_KEY rotation.
4. TRPC parse fragility.
5. Content-script URL match gaps.
