# Implementation Plan: Gemini via Flow generateContent

## Overview

This plan turns the design into incremental, test-driven coding steps across four layers, in dependency order: extension request builder (`flow_api.js`) → extension token injection + dispatch (`background.js`) → Control Plane Worker validation → agent `flow_gemini` LLM provider → retirement of the Playwright Gemini driver.

Each layer is a thin addition to an existing seam. Pure logic is factored into small exported helpers (`extractGeneratedText`, `injectCaptchaToken`, `buildTextGenContents`, the base64 attachment encoder) so the five correctness properties can be property-tested without Chrome/`fetch` mocking. Property-based tests use **fast-check** (JS, in the extension/worker test package) and **hypothesis** (Python, already in `pyproject.toml` dev extras); each runs a minimum of 100 iterations.

Test commands (Windows / PowerShell, use `;` not `&&`):
- Extension JS: `npm test` / vitest (add fast-check dev dep)
- Worker: `npm test` (vitest) in `cloudflare/control-plane-worker`
- Agent: `pytest` in `agent/`

## Tasks

- [x] 1. Extension `flow_api.js` — generateContent request builder + text extractor
  - [x] 1.1 Implement module-level `extractGeneratedText(data)` and export it
    - Add `extractGeneratedText(data)` that tolerates a `{data:{...}}` envelope, concatenates `candidates[].content.parts[].text` in document order, ignores non-text parts, and returns `''` when no `candidates`/`parts`/`text` exist
    - Export it on `global.FlowboardFlowApiUtils` alongside the existing utils
    - _Requirements: 2.1, 2.3, 2.4_

  - [x] 1.2 Implement `FlowboardFlowApi.generateContent(contents, options)`
    - Add module constants `GENERATE_CONTENT_URL`, `DEFAULT_TEXT_MODEL = 'gemini-3-flash-preview'`, `CAPTCHA_TEXT = 'IMAGE_GENERATION'`
    - Build body with `model` (default `gemini-3-flash-preview`), `contents`, and a **top-level** `recaptchaContext` with `applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB'`; include `systemInstruction`/`thinkingConfig`/`requestContext` only when supplied; never set `clientContext`
    - Solve captcha via `this.solveCaptcha?.(opts.captchaAction || CAPTCHA_TEXT)`; throw when no token
    - POST to `flow:generateContent` with `authorization` Bearer header and `credentials: 'include'`; parse JSON before the `resp.ok` check, throwing malformed-JSON error on parse failure and `HTTP <status>` error on non-2xx; return `{ raw, text }`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 8.3, 8.6_

  - [x]* 1.3 Write property test for the generateContent body builder
    - **Property 1: generateContent request body is built correctly**
    - Tag: `Feature: gemini-via-flow-generatecontent, Property 1: For all options (model present/absent; any subset of systemInstruction/thinkingConfig/requestContext) and any contents array, generateContent produces a body with correct model default, deep-equal contents, optional fields present iff supplied, a top-level recaptchaContext with applicationType RECAPTCHA_APPLICATION_TYPE_WEB, and no clientContext key`
    - fast-check, minimum 100 iterations; stub `solveCaptcha` and capture the body passed to a stubbed `fetch`
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.9**

  - [x]* 1.4 Write property test for the text extractor round-trip
    - **Property 2: text extraction round-trip**
    - Tag: `Feature: gemini-via-flow-generatecontent, Property 2: For all lists of text strings, synthesizing a response whose candidates[].content.parts[] carry those strings (interleaved with non-text parts and empty candidates) then applying extractGeneratedText reproduces the in-order concatenation; and for responses with no candidates/text parts it returns the empty string`
    - fast-check, minimum 100 iterations
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4**

  - [x]* 1.5 Write unit/example tests for generateContent
    - POSTs to `flow:generateContent` URL with Bearer `authorization` and `credentials:include` (Req 1.8); returns `{raw, text}` (Req 1.1); non-2xx throws with status (Req 8.3); invalid JSON throws malformed (Req 8.6)
    - _Requirements: 1.1, 1.8, 8.3, 8.6_

- [x] 2. Extension `background.js` — top-level captcha token injection
  - [x] 2.1 Extract `injectCaptchaToken(body, token)` helper and wire into `handleApiRequest`
    - Factor the recaptcha-token injection into a pure exported helper that, for a solved token, sets `.token` at every present location (top-level `recaptchaContext`, `clientContext.recaptchaContext`, `agentClientContext.recaptchaContext`, each `requests[].clientContext.recaptchaContext`), creates none that are absent, and is idempotent
    - Call it inside the existing `if (captchaToken && finalBody)` clone block so the caller's object is never mutated; ensure the top-level `recaptchaContext` case is covered
    - Keep captcha-action resolution via `resolveCaptchaAction`/`observedCaptchaActions`, defaulting to `IMAGE_GENERATION`
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x]* 2.2 Write property test for captcha token injection
    - **Property 3: captcha token injection is position-correct and idempotent**
    - Tag: `Feature: gemini-via-flow-generatecontent, Property 3: For all bodies containing any subset of the four recaptcha locations, applying injectCaptchaToken with a solved token sets .token at every present location, creates none where absent, and is idempotent (applying twice equals applying once)`
    - fast-check on the extracted `injectCaptchaToken` helper, minimum 100 iterations
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [x]* 2.3 Write unit test for default captcha action
    - `generateContent` dispatch resolves the captcha action to `IMAGE_GENERATION` when none supplied
    - _Requirements: 3.4_

- [x] 3. Extension `background.js` — text_gen dispatch branch
  - [x] 3.1 Extract pure `buildTextGenContents(inputData)` helper
    - Produce a single `user` content whose `parts` begins with one `{ text: prompt }` followed by one `{ inlineData: { mimeType, data } }` per supplied attachment in order; when attachments are empty, `parts` contains only the text entry
    - Export the helper for reuse by `runCloudFlowJob` and the property test
    - _Requirements: 4.3, 7.1, 7.3, 7.5_

  - [x] 3.2 Add `text_gen` branch in `runCloudFlowJob`
    - Branch early (before project creation / ref-media resolution) when `taskType === 'text_gen'`: build contents via `buildTextGenContents`, derive `options` (`model` from `inputData.model`/`cloudConfig.textModel`, `captchaAction`, `systemInstruction` from a string `system_prompt`)
    - Call `flowApi.generateContent` via `withStage('ERR_STAGE_GENERATE', ...)`, then complete via `completeCloudRequestWithRetry` with `{ provider:'flow', task_type:'text_gen', text }` and an empty assets array `[]`; update metrics and `return`
    - Rely on existing prompt/`flowKey` guards and the existing `catch` → `cloud.fail(requestId, sanitizedReason)`
    - _Requirements: 4.1, 4.2, 4.4, 8.1, 8.2_

  - [x]* 3.3 Write property test for the contents builder
    - **Property 4: contents builder assembles user parts from job input**
    - Tag: `Feature: gemini-via-flow-generatecontent, Property 4: For all non-empty prompts and all attachment lists (incl. empty), buildTextGenContents produces a single user content whose parts start with exactly one {text} equal to the prompt followed by exactly one {inlineData:{mimeType,data}} per attachment in order; empty attachments yield only the text part`
    - fast-check on the extracted `buildTextGenContents` helper, minimum 100 iterations
    - **Validates: Requirements 4.3, 7.1, 7.3, 7.5**

  - [x]* 3.4 Write unit/example tests for the text_gen branch
    - `text_gen` branch calls `generateContent` (Req 4.1) and completes with `{provider, task_type, text}` + `[]` assets (Req 4.2); generation error → `cloud.fail` (Req 4.4); no `flowKey` → `NO_FLOW_KEY` and `generateContent` not called (Req 8.1); captcha null → no fetch (Req 8.2)
    - _Requirements: 4.1, 4.2, 4.4, 8.1, 8.2_

- [x] 4. Control Plane Worker — text_gen validation + text-only completion
  - [x] 4.1 Add `ALLOWED_TASK_TYPES` and `assertTaskType` in `src/lib/requestGuards.ts`
    - Define `ALLOWED_TASK_TYPES = new Set(['txt2img','edit_image','img2vid','txt2vid_omni','text_gen'])`
    - Add `assertTaskType(taskType)` defaulting empty/missing to `txt2img` and throwing `ApiError(400, 'INVALID_TASK_TYPE', ...)` for unrecognized values; return the validated string
    - _Requirements: 5.1, 5.3_

  - [x] 4.2 Wire `assertTaskType` into `canvas.ts` POST /requests
    - Call `const taskType = assertTaskType(body.task_type)` before the `create_or_reset_request` RPC and pass `p_task_type: taskType`
    - Set `p_expected_output: body.expected_output ?? (taskType === 'text_gen' ? 'text' : 'image')`
    - _Requirements: 5.1, 5.2_

  - [x]* 4.3 Write Worker integration tests for task_type validation
    - `assertTaskType('text_gen') === 'text_gen'`; unknown value throws `ApiError(400)`; colocate with `test/guards.test.ts`
    - _Requirements: 5.1, 5.3_

  - [x]* 4.4 Write Worker integration tests for text-only completion + read-back
    - `/extension/complete` with `output_result={provider,task_type,text}` and `assets=[]` succeeds without an asset record (Req 5.2); `GET /requests/:id` preserves `output_result.text` for a completed `text_gen` row (Req 5.4); 1–3 representative examples
    - _Requirements: 5.2, 5.4_

- [x] 5. Checkpoint - extension + Worker layers
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Agent — `flow_gemini` LLM provider
  - [x] 6.1 Create `agent/flowboard/services/llm/flow_gemini.py`
    - Implement `FlowGeminiProvider` conforming to the `LLMProvider` protocol: `name='flow_gemini'`, `supports_vision=True`, `is_available()`, and `run(user_prompt, *, system_prompt, attachments, timeout)`
    - `_build_input_data`: raise `LLMError` on non-string `system_prompt` (no enqueue); base64-encode attachments with guessed mimeType, skipping per-attachment failures with a redacted-path warning; carry `system_prompt` and non-empty `attachments` into `input_data`; include `model` default `gemini-3-flash-preview`
    - `_enqueue` via `ControlPlaneService.create_or_reset_request(provider='flow', task_type='text_gen', expected_output='text', ...)`; `_poll_until_text` on a 2s interval until `completed`/`failed`/timeout
    - Raise `LLMError` on empty completed text and on timeout
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.5, 8.4, 8.5_

  - [x] 6.2 Register `flow_gemini` in `registry.py`
    - Import `FlowGeminiProvider` and add `"flow_gemini": FlowGeminiProvider()` to `_PROVIDERS`
    - _Requirements: 6.1, 6.6, 6.7_

  - [x]* 6.3 Write property test for attachment base64 round-trip
    - **Property 5: attachment base64 encode/decode round-trip**
    - Tag: `Feature: gemini-via-flow-generatecontent, Property 5: For all image byte sequences, base64-encoding into inlineData.data then base64-decoding reproduces the original bytes exactly`
    - hypothesis on the `flow_gemini` attachment encoder, minimum 100 iterations; vary `bytes` (empty, binary, large)
    - **Validates: Requirements 7.4**

  - [x]* 6.4 Write unit tests for `flow_gemini.py`
    - Protocol-conforming + registered (Req 6.1); `supports_vision is True` (Req 6.5); `run` enqueues and returns completed text via a mocked `ControlPlaneService` (Req 6.2); `system_prompt` carried into `input_data.system_prompt` (Req 6.3); non-string `system_prompt` → `LLMError`, no enqueue (Req 6.4); empty completed text → `LLMError` (Req 8.4); poll timeout → `LLMError` (Req 8.5); unreadable attachment skipped, others kept (Req 7.2)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.2, 8.4, 8.5_

  - [x]* 6.5 Write registry routing tests
    - Configuring `flow_gemini` routes `run_llm("auto_prompt", ...)` and `run_llm("vision", ...)` through `FlowGeminiProvider.run` with no call-site change
    - _Requirements: 6.6, 6.7_

  - [x]* 6.6 Write redaction/secrets tests
    - Bearer/reCAPTCHA tokens never appear in logs or error messages; sensitive-pattern prompt content is hashed/redacted in dispatch logs
    - _Requirements: 9.1, 9.2, 9.3_

- [x] 7. Checkpoint - agent provider integrated
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Retire the Playwright Gemini driver
  - [x]* 8.1 Delete the driver and its Playwright-only tests
    - Delete `agent/flowboard/extension_worker/gemini_browser_driver.py` and `agent/tests/test_gemini_browser_driver.py`; delete any Playwright-only Gemini smoke/e2e scaffolding (e.g. `gemini_smoke.py`, `gemini_e2e_smoke.py`) if present
    - _Requirements: 10.1, 10.2_

  - [x]* 8.2 Remove the Playwright dependency from the agent manifest
    - Confirm `playwright` is referenced only by the removed files (workspace search); remove any `playwright` entry from `agent/pyproject.toml` / lock/extras if one surfaces
    - _Requirements: 10.3_

  - [x]* 8.3 Write import smoke test for retirement
    - After deletion, `python -c "import flowboard.services.llm.registry"` and the agent app import succeed with no `ImportError` referencing removed modules; workspace search shows no `playwright` matches outside removed files
    - _Requirements: 10.4_

- [x] 9. Self-discovery of captcha action + flowSdkInfo (resolves A1/A2)
  - [x] 9.1 Extension `injected.js` — `extractFlowSdkInfo` helper + passive `fetch` observer
    - Add a pure module-level `extractFlowSdkInfo(rawBody)` (parallels `extractGeneratedText`): parse the body, tolerating non-JSON input by returning `null`; read `requestContext.flowSdkInfo.appletId`/`appletVersionId`, plus `agentClientContext.appletId`/`appletProjectId` and top-level `appletProjectId`; return `null` when none are present, otherwise `{ appletId, appletVersionId, appletProjectId }`
    - Wrap `window.fetch` exactly once (guarded by a flag, like `ensureWrapped`) so that for `flow:generateContent` / `flowAgent:*` URLs it extracts the info and dispatches a new `FLOWBOARD_FLOW_SDK_INFO_OBSERVED` CustomEvent with `{ appletId, appletVersionId, appletProjectId, href, observedAt }`; the wrap MUST always forward to the original `fetch` (no page behavior change)
    - _Requirements: 1.6_

  - [x] 9.2 Extension `content.js` + `background.js` — relay + store observed `flowSdkInfo`
    - In `content.js`, relay the `FLOWBOARD_FLOW_SDK_INFO_OBSERVED` window event as a `FLOW_SDK_INFO_OBSERVED` runtime message (mirror the existing `CAPTCHA_ACTION_OBSERVED` relay)
    - In `background.js`, load `observedFlowSdkInfo` from `chrome.storage.local` at startup (alongside `observedCaptchaActions`); on the `FLOW_SDK_INFO_OBSERVED` message, store the latest non-empty `{ appletId, appletVersionId, href, observedAt }` (skip when both ids are empty)
    - _Requirements: 1.6_

  - [x] 9.3 Extension `background.js` — `resolveFlowSdkInfo()` + 3-tier fallback + `generateContent` captcha-action override
    - Add `resolveFlowSdkInfo()` with precedence `observedFlowSdkInfo` → `cloudConfig.flowSdkInfoSeed` → `null`
    - Implement the 3-tier request chain around the `text_gen` `generateContent` call: Tier 1 omits `requestContext` (default first attempt, preserves Req 1.6); Tier 2 retries once with the resolved `flowSdkInfo` when the failure indicates `flowSdkInfo` is required (e.g. `400`/`INVALID_ARGUMENT` referencing `flowSdkInfo`/`requestContext`/`applet`); Tier 3 seed constants (`appletId 96d388e5-41e3-4661-8102-57479ac91729`, `appletVersionId fbca04f3-c5cc-4b69-8c91-4c88abb1e9a3`) come from `cloudConfig.flowSdkInfoSeed`
    - Extend `resolveCaptchaAction` so the observed-action lookup (`getBestObservedCaptchaSnapshot`) also applies to the `flow:generateContent` href (today only `flowCreationAgent:streamChat` is special-cased), keeping `IMAGE_GENERATION` as the default; on `403`/`CAPTCHA_FAILED` retry candidate actions and log the winning action
    - _Requirements: 1.6, 3.4, 8.2, 8.3_

  - [x]* 9.4 Write example/edge-case tests for `injected.js` observer (vitest)
    - `extractFlowSdkInfo` returns `{appletId, appletVersionId, appletProjectId}` for a body carrying `requestContext.flowSdkInfo`, returns `null` for a body without it, and returns `null` for a non-JSON body (example + edge cases)
    - The `fetch` wrap dispatches `FLOWBOARD_FLOW_SDK_INFO_OBSERVED` only for `flow:generateContent` / `flowAgent:*` URLs and always forwards to the original `fetch`
    - NOTE: this is observer wiring per design 6d — **no new correctness property is added (do NOT add a Property 6)**; example/edge-case tests only
    - _Requirements: 1.6_

  - [x]* 9.5 Write tests for `resolveFlowSdkInfo` precedence + 3-tier chain (vitest)
    - `resolveFlowSdkInfo()` precedence is observed → `cloudConfig.flowSdkInfoSeed` → `null`
    - The 3-tier chain omits `requestContext` on the first attempt and retries with the resolved value only on a `flowSdkInfo`-required error
    - NOTE: deterministic example/integration cases per design 6d — **no new correctness property**
    - _Requirements: 1.6, 3.4, 8.2, 8.3_

- [x] 10. Final checkpoint - full suite
  - Ensure all tests pass (extension vitest, Worker vitest, agent pytest), ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. These cover property tests, unit/integration tests, the self-discovery observer tests (Task 9), and the retirement cleanup (Task 8). The retirement (Req 10) removes unused dead code and is safe to defer without affecting the feature's behavior; do it before final cleanup of the cloud-first migration.
- Pure helpers (`extractGeneratedText`, `injectCaptchaToken`, `buildTextGenContents`, attachment encoder, `extractFlowSdkInfo`) are introduced specifically so the testable logic can be exercised without Chrome/`fetch` mocking.
- Each property test references a specific property from the design and runs a minimum of 100 iterations, tagged `Feature: gemini-via-flow-generatecontent, Property {n}: {property_text}`.
- Task 9 (self-discovery of captcha action + `flowSdkInfo`, design component 6) is passive observer + retry **wiring**. Per design 6d it adds **NO new correctness property** — `extractFlowSdkInfo`, the `resolveFlowSdkInfo` precedence, and the 3-tier chain are covered by example/edge-case/integration tests only, so there is no Property 6.
- fast-check is a new dev dependency for the JS/extension + Worker tests; hypothesis is already available for the agent.
- Each task references specific requirement clauses for traceability; checkpoints validate incrementally per layer.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1", "6.1", "9.1"] },
    { "id": 1, "tasks": ["1.2", "3.1", "4.2", "6.2"] },
    { "id": 2, "tasks": ["1.3", "1.4", "1.5", "2.2", "2.3", "3.2", "3.3", "4.3", "4.4", "6.3", "6.4", "6.5", "6.6"] },
    { "id": 3, "tasks": ["3.4", "8.1", "8.2", "9.2"] },
    { "id": 4, "tasks": ["8.3", "9.3", "9.4"] },
    { "id": 5, "tasks": ["9.5"] }
  ]
}
```
