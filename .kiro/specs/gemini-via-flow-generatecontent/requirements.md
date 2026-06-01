# Requirements Document

## Introduction

This feature replaces the unused, fragile `GeminiBrowserDriver` (Playwright/CDP scraping of `gemini.google.com`) with a text-generation path that reuses the **same extension pipeline** already used for Flow image and video generation. Text generation is performed by calling `POST https://aisandbox-pa.googleapis.com/v1/flow:generateContent` with a Gemini-style payload, authenticated by the user's own captured Flow Bearer token and protected by the existing reCAPTCHA mechanism.

The strategic goal (see `docs/ADR-0001`) is a cloud-first SaaS optimized for $0 free-tier cost and retirement of the local Python agent. Routing text generation through the user's own Flow session means $0 LLM cost: no Claude/OpenAI API keys and no paid Gemini API quota.

The architecture follows **variant B** from `docs/SPIKE-gemini-qua-flow-generatecontent.md`: a job-based pipeline consistent with images/videos. A Control Plane request is enqueued with `provider="flow"` and `task_type="text_gen"`; the extension cloud-worker claims it, calls `flow:generateContent`, and completes the job with the generated text and an empty assets array (no R2 asset).

The real consumers of text generation in the product are `agent/flowboard/services/prompt_synth.py` (auto-prompt) and `agent/flowboard/services/vision.py` (multimodal image brief), both routing through the `agent/flowboard/services/llm/` registry via `run_llm`. This feature adds a new LLM provider, `flow_gemini`, so those consumers can run at $0 without changing their call sites.

### Scope boundaries

In scope: extension request builder + response text extractor, top-level reCAPTCHA token injection in `background.js`, a `text_gen` cloud-worker dispatch branch, Control Plane `task_type=text_gen` validation, a `flow_gemini` LLM provider (text + multimodal), and deprecation/removal of `GeminiBrowserDriver` and its Playwright dependency/tests.

Out of scope: a model-list/dropdown endpoint, and the multi-turn agent SSE path (`flowAgent:runAppletAgentSse`).

### Assumptions (noted, not blockers)

- **A1 — Captcha action string** for `generateContent` is **`TEXT_GENERATION`** — verified against a live Flow session (port-9222 CDP E2E): `IMAGE_GENERATION` / `GENERATE_CONTENT` / `GEMINI` / `VIDEO_GENERATION` all return `403 PUBLIC_ERROR_UNUSUAL_ACTIVITY`; only `TEXT_GENERATION` is accepted (HTTP 200). Still overridable via `injected.js OBSERVE_EVENT` if the Flow page ever changes.
- **A2 — `requestContext.flowSdkInfo` (`appletId`, `appletVersionId`)** is **NOT required** — same E2E succeeds (HTTP 200) with no `requestContext` (Tier 1). The seed/observer fallback is retained defensively but unused in practice.
- **A3 — Model identifier** defaults to `gemini-3-flash-preview` (E2E-confirmed) and is overridable via configuration.

## Glossary

- **Flow_Api**: The extension module `extension/flow_api.js` (class `FlowboardFlowApi`) that builds and sends authenticated requests to `aisandbox-pa.googleapis.com`.
- **Generate_Content_Method**: The new `FlowboardFlowApi.generateContent(contents, options)` method added by this feature.
- **Text_Extractor**: The new helper that reads generated text from a `generateContent` response (`candidates[].content.parts[].text`).
- **Background_Worker**: The extension service worker `extension/background.js`, including `handleApiRequest` (token injection / fetch) and `runCloudFlowJob` (cloud-worker dispatch).
- **Cloud_Worker**: The `cloud-worker` mode loop in Background_Worker that claims, runs, and completes Control Plane jobs.
- **Control_Plane**: The Cloudflare Worker `cloudflare/control-plane-worker` exposing `/api/...` request/claim/complete endpoints (route file `src/routes/canvas.ts`).
- **LLM_Registry**: The agent module `agent/flowboard/services/llm/` whose `run_llm(feature, ...)` dispatches to a configured provider.
- **Flow_Gemini_Provider**: The new LLM provider named `flow_gemini` added to LLM_Registry, conforming to the `LLMProvider` protocol.
- **Text_Gen_Job**: A Control Plane request with `provider="flow"` and `task_type="text_gen"`.
- **Recaptcha_Context**: The `recaptchaContext` object carrying the reCAPTCHA token. For `generateContent` this object is at the **top level** of the request body (not inside `clientContext`).
- **Bearer_Token**: The captured `Authorization: Bearer ya29...` Flow token stored in Background_Worker as `flowKey`.
- **Generated_Text**: The plain-text result extracted from a successful `generateContent` response.
- **Inline_Data**: A `parts[]` entry of shape `{ inlineData: { mimeType, data } }` where `data` is base64-encoded image bytes, used for multimodal input.

## Requirements

### Requirement 1: Extension builds the generateContent request body

**User Story:** As a developer integrating text generation, I want Flow_Api to expose a `generateContent` method that builds a correct Gemini-style request body, so that text and multimodal prompts can be sent through the existing Flow gateway.

#### Acceptance Criteria

1. THE Flow_Api SHALL expose a method `generateContent(contents, options)` that returns the parsed response and the extracted Generated_Text.
2. WHEN `generateContent` is invoked, THE Generate_Content_Method SHALL set the request body `model` field from `options.model`, defaulting to `gemini-3-flash-preview` WHERE `options.model` is absent.
3. WHEN `generateContent` is invoked, THE Generate_Content_Method SHALL set the request body `contents` field to the supplied `contents` argument.
4. WHERE `options.systemInstruction` is provided, THE Generate_Content_Method SHALL include `systemInstruction` as `{ parts: [{ text }] }` in the request body.
5. WHERE `options.thinkingConfig` is provided, THE Generate_Content_Method SHALL include `thinkingConfig` in the request body.
6. WHERE `options.requestContext` is provided, THE Generate_Content_Method SHALL include `requestContext` in the request body, AND WHERE `options.requestContext` is absent THE Generate_Content_Method SHALL omit `requestContext` from the request body.
7. THE Generate_Content_Method SHALL place Recaptcha_Context at the top level of the request body with field `applicationType` set to `"RECAPTCHA_APPLICATION_TYPE_WEB"`.
8. THE Generate_Content_Method SHALL send the request to `https://aisandbox-pa.googleapis.com/v1/flow:generateContent` using HTTP POST with the `authorization` header set to the Bearer_Token.
9. THE Generate_Content_Method SHALL exclude `clientContext` from the `generateContent` request body.

### Requirement 2: Extension extracts generated text from the response

**User Story:** As a consumer of text generation, I want a Text_Extractor that reads the generated text from the response, so that callers receive plain text rather than the raw API envelope.

#### Acceptance Criteria

1. WHEN a successful `generateContent` response contains `candidates[].content.parts[].text`, THE Text_Extractor SHALL return the concatenation of those `text` values in document order.
2. FOR ALL response objects, building a request from a `contents` array of text parts then extracting text from a response synthesized from the same parts SHALL reproduce the original concatenated text (round-trip property between request text parts and extracted text).
3. IF the response contains no `candidates` array OR no `parts` containing `text`, THEN THE Text_Extractor SHALL return an empty string.
4. THE Text_Extractor SHALL ignore non-text `parts` entries when assembling Generated_Text.

### Requirement 3: Background worker injects the captcha token at top level

**User Story:** As an operator relying on reCAPTCHA, I want Background_Worker to inject the solved captcha token into the top-level Recaptcha_Context, so that `generateContent` requests pass reCAPTCHA validation like image and video requests.

#### Acceptance Criteria

1. WHEN `handleApiRequest` processes a request whose body contains a top-level `recaptchaContext` object, THE Background_Worker SHALL set `body.recaptchaContext.token` to the solved captcha token.
2. THE Background_Worker SHALL preserve its existing token injection into `clientContext.recaptchaContext`, `agentClientContext.recaptchaContext`, and `requests[].clientContext.recaptchaContext`.
3. WHEN a request body has no top-level `recaptchaContext`, THE Background_Worker SHALL leave the body's other Recaptcha_Context locations unchanged.
4. THE Background_Worker SHALL resolve the captcha action for `generateContent` from the configured action value, defaulting to `IMAGE_GENERATION` WHERE no action is supplied.

### Requirement 4: Cloud-worker dispatches text_gen jobs

**User Story:** As the cloud-worker pipeline, I want a dispatch branch for `task_type="text_gen"`, so that text generation runs through the same claim/complete loop as images and videos.

#### Acceptance Criteria

1. WHEN `runCloudFlowJob` processes a job WHERE `task_type` equals `"text_gen"`, THE Cloud_Worker SHALL call `Flow_Api.generateContent` with the job's prompt content and options.
2. WHEN a Text_Gen_Job completes successfully, THE Cloud_Worker SHALL call the Control_Plane complete operation with payload `{ provider: "flow", task_type: "text_gen", text: <Generated_Text> }` and an empty assets array.
3. WHEN `runCloudFlowJob` processes a Text_Gen_Job, THE Cloud_Worker SHALL build the `contents` array from the job input, including any supplied image attachment as Inline_Data.
4. IF a Text_Gen_Job fails during generation, THEN THE Cloud_Worker SHALL report the failure through the existing Control_Plane fail operation with a sanitized error reason.

### Requirement 5: Control Plane accepts and validates text_gen

**User Story:** As the Control Plane, I want to accept and validate `task_type="text_gen"`, so that text generation jobs can be enqueued and claimed alongside existing task types.

#### Acceptance Criteria

1. WHEN a request is created with `task_type` equal to `"text_gen"`, THE Control_Plane SHALL persist the request with `task_type` set to `"text_gen"`.
2. WHEN a Text_Gen_Job is completed with a `text` payload and an empty assets array, THE Control_Plane SHALL store the result without requiring an asset record.
3. IF a request is created with an unrecognized `task_type` value, THEN THE Control_Plane SHALL reject the request with a client error.
4. THE Control_Plane SHALL expose the completed `text` value to the requesting agent through the existing request-status retrieval path.

### Requirement 6: Flow_Gemini LLM provider routes text generation

**User Story:** As a Flowboard user, I want a `flow_gemini` provider that performs text generation through the Control Plane, so that auto-prompt and vision features run at $0 using my Flow session.

#### Acceptance Criteria

1. THE LLM_Registry SHALL register a provider named `flow_gemini` that conforms to the `LLMProvider` protocol.
2. WHEN `run_llm` dispatches to Flow_Gemini_Provider with a `user_prompt`, THE Flow_Gemini_Provider SHALL enqueue a Text_Gen_Job through the Control_Plane and return the completed Generated_Text.
3. WHERE a `system_prompt` is supplied, THE Flow_Gemini_Provider SHALL include it as the `systemInstruction` of the Text_Gen_Job.
4. IF a supplied `system_prompt` cannot be included as `systemInstruction` in the Text_Gen_Job, THEN THE Flow_Gemini_Provider SHALL raise an `LLMError` and SHALL NOT dispatch the job without the system prompt.
5. THE Flow_Gemini_Provider SHALL declare `supports_vision` as `true`.
6. WHEN `prompt_synth` calls `run_llm("auto_prompt", ...)` AND the configured provider is `flow_gemini`, THE LLM_Registry SHALL route the call to Flow_Gemini_Provider without changes to the `prompt_synth` call site.
7. WHEN `vision` calls `run_llm("vision", ...)` AND the configured provider is `flow_gemini`, THE LLM_Registry SHALL route the call to Flow_Gemini_Provider without changes to the `vision` call site.

### Requirement 7: Multimodal image attachments are sent as inlineData

**User Story:** As the vision feature, I want image attachments forwarded as base64 inlineData, so that multimodal briefs can be generated through `generateContent`.

#### Acceptance Criteria

1. WHEN Flow_Gemini_Provider receives a non-empty `attachments` list, THE Flow_Gemini_Provider SHALL encode each attachment as base64 and include it in `contents` as Inline_Data with the file's `mimeType`.
2. IF encoding an individual attachment fails, THEN THE Flow_Gemini_Provider SHALL skip that attachment and continue building the Text_Gen_Job with the remaining valid attachments.
3. WHEN a multimodal Text_Gen_Job is built, THE Cloud_Worker SHALL place each Inline_Data entry in the `parts` array of the `user` content alongside the text part.
4. FOR ALL provided image attachments, decoding the base64 `data` of the corresponding Inline_Data entry SHALL reproduce the original image bytes (round-trip property for base64 encoding).
5. WHERE the `attachments` list is empty, THE Flow_Gemini_Provider SHALL send a `contents` array containing only the text part.

### Requirement 8: Error handling for text generation

**User Story:** As an operator, I want text generation to fail safely with clear, sanitized errors, so that failures are diagnosable without leaking secrets and mirror existing image/video handling.

#### Acceptance Criteria

1. IF the Bearer_Token is absent when a Text_Gen_Job is dispatched, THEN THE Background_Worker SHALL report a `NO_FLOW_KEY` error and SHALL NOT call `generateContent`.
2. IF reCAPTCHA solving fails, THEN THE Background_Worker SHALL report a captcha-failure error and SHALL NOT call `generateContent`.
3. IF the `generateContent` response status is outside the 200–299 range, THEN THE Generate_Content_Method SHALL raise an error that includes the HTTP status code.
4. IF a successful response yields an empty Generated_Text, THEN THE Flow_Gemini_Provider SHALL raise an `LLMError` indicating an empty response.
5. IF the Text_Gen_Job does not complete within the configured timeout, THEN THE Flow_Gemini_Provider SHALL raise an `LLMError` indicating a timeout.
6. IF the response body cannot be parsed as JSON, THEN THE Generate_Content_Method SHALL raise an error indicating a malformed response.

### Requirement 9: Secrets and prompt redaction

**User Story:** As a security-conscious maintainer, I want prompts and tokens kept out of logs, so that sensitive content and credentials are not exposed.

#### Acceptance Criteria

1. THE Flow_Gemini_Provider SHALL NOT write the Bearer_Token to logs.
2. WHEN Flow_Gemini_Provider logs a dispatch event, THE Flow_Gemini_Provider SHALL record prompt content that matches a detected sensitive pattern (such as credentials, API keys, or personal data) in redacted or hashed form, consistent with the existing provider logging pattern.
3. WHEN an error is surfaced from Flow_Gemini_Provider, THE Flow_Gemini_Provider SHALL exclude the Bearer_Token and the reCAPTCHA token from the error message.

### Requirement 10: Retire the Playwright Gemini driver

**User Story:** As a maintainer pursuing the cloud-first strategy, I want the unused Playwright-based Gemini driver removed, so that the codebase no longer depends on browser scraping or Playwright for text generation.

#### Acceptance Criteria

1. THE feature SHALL remove `agent/flowboard/extension_worker/gemini_browser_driver.py` and its associated tests (`agent/tests/test_gemini_browser_driver.py`).
2. THE feature SHALL remove the Playwright-based Gemini smoke and end-to-end test scaffolding that exists solely to support the retired driver.
3. WHERE Playwright is no longer referenced by any remaining agent code path, THE feature SHALL remove the Playwright dependency from the agent's dependency manifest.
4. WHEN the driver is removed, THE agent SHALL continue to start and serve requests without import errors referencing the removed modules.
