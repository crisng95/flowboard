export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// Map cryptic Flow / pipeline error tokens to a sentence the user can act on.
// Returns null when the token is unrecognised, so the caller falls through to
// the raw message.
function humanizeBackendError(token: string): string | null {
  const t = token.toLowerCase();
  if (t.startsWith("paygate_tier_invalid")) {
    return (
      "Flowboard doesn't recognise the configured Google Flow plan. Set "
      + "FLOWBOARD_PAYGATE_TIER to PAYGATE_TIER_TWO (Ultra) or "
      + "PAYGATE_TIER_ONE (Pro) and restart the agent. It refuses to "
      + "dispatch in this state rather than guessing, because the plan "
      + "picks which video checkpoint renders."
    );
  }
  if (t.includes("no_flow_project")) {
    return (
      "Flow no longer lets Flowboard create projects — that endpoint went "
      + "with Google's September 2026 migration. Create one project in the "
      + "Flow UI, copy its uuid from the address bar, and set "
      + "FLOWBOARD_FLOW_PROJECT_ID to it before restarting the agent."
    );
  }
  if (t.includes("unsupported_on_batch_api")) {
    // Not transient and not the user's fault: Flow's current API has no
    // equivalent for this. Retrying will never help, so say so.
    return (
      token
      + " — this capability has no equivalent on Flow's current API, so "
      + "retrying will not help."
    );
  }
  if (t.includes("no_at_token")) {
    return (
      "The Flow tab is open but hasn't finished loading, so it can't sign "
      + "the request yet. Reload https://flow.google.com/ , wait for the "
      + "app to appear, then retry."
    );
  }
  if (t.includes("no_flow_tab") || t.includes("flow_tab_discarded")) {
    return (
      "Flowboard needs one signed-in https://flow.google.com/ tab left "
      + "open — only the page itself can sign a Flow request, so nothing "
      + "works headless. Open it and retry."
    );
  }
  if (t === "no_media_id_in_upload_response") {
    return (
      "Google Flow accepted the upload but didn't return a media handle — "
      + "this usually means the image was silently rejected by Flow's "
      + "content filter (logos, watermarks, copyrighted brand imagery). "
      + "Try a different image or download it locally and upload as a file. "
      + "Check the agent terminal for the full Flow response."
    );
  }
  if (t.includes("captcha_failed: no current window")) {
    return (
      "Chrome has no open windows for the extension to attach a Flow tab to. "
      + "Open any Chrome window (or click the extension's '⋯ → Open Flow') "
      + "and retry — Flowboard will reuse the existing window automatically."
    );
  }
  if (t.startsWith("captcha_failed:")) {
    // CAPTCHA failures are rarely the user's fault — surface the underlying
    // reason verbatim but keep the prefix so power-users can grep for it.
    return token;
  }
  if (t.startsWith("public_error_")) {
    // Veo / Imagen content filters are returned verbatim by Flow — these
    // are already self-describing, just prettify the prefix.
    return token.replace(/^PUBLIC_ERROR_/i, "Flow rejected: ").replace(/_/g, " ");
  }
  return null;
}

async function extractErrorMessage(res: Response): Promise<string> {
  let detail: unknown;
  try {
    detail = await res.json();
  } catch {
    try {
      detail = await res.text();
    } catch {
      return `${res.status} ${res.statusText}`;
    }
  }
  const inner =
    typeof detail === "object" && detail !== null && "detail" in detail
      ? (detail as { detail: unknown }).detail
      : detail;
  if (typeof inner === "string" && inner) {
    return humanizeBackendError(inner) ?? inner;
  }
  if (inner && typeof inner === "object") {
    const obj = inner as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message) {
      return humanizeBackendError(obj.message) ?? obj.message;
    }
    try {
      return JSON.stringify(inner);
    } catch {
      // fall through
    }
  }
  return `${res.status} ${res.statusText}`;
}

export interface WsStats {
  connected: boolean;
  flow_key_present: boolean;
  token_age_s: number | null;
  pending: number;
  request_count: number;
  success_count: number;
  failed_count: number;
  last_error: string | null;
}

export interface HealthResponse {
  ok: boolean;
  extension_connected: boolean;
  ws_stats?: WsStats;
}

export function getHealth() {
  return api<HealthResponse>("/api/health");
}

// ── DTOs ────────────────────────────────────────────────────────────────────

export type NodeType = "character" | "image" | "video" | "prompt" | "note" | "visual_asset" | "Storyboard";
export type NodeStatus = "idle" | "queued" | "running" | "done" | "error";

export interface Board {
  id: number;
  name: string;
  created_at: string;
}

export interface NodeDTO {
  id: number;
  board_id: number;
  short_id: string;
  type: NodeType;
  x: number;
  y: number;
  w: number;
  h: number;
  data: Record<string, unknown>;
  status: NodeStatus;
  created_at: string;
}

export interface EdgeDTO {
  id: number;
  board_id: number;
  source_id: number;
  target_id: number;
  kind: string;
  // null when the upstream is single-variant (or the edge hasn't been
  // pinned yet — natural fallback to source.mediaId at dispatch time).
  // 0-based index into the source node's `data.mediaIds[]` when the
  // user has explicitly picked a variant.
  source_variant_idx: number | null;
}

export interface BoardDetail {
  board: Board;
  nodes: NodeDTO[];
  edges: EdgeDTO[];
}

// ── API methods ──────────────────────────────────────────────────────────────

export function listBoards(): Promise<Board[]> {
  return api<Board[]>("/api/boards");
}

export function createBoard(name: string): Promise<Board> {
  return api<Board>("/api/boards", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function getBoard(id: number): Promise<BoardDetail> {
  return api<BoardDetail>(`/api/boards/${id}`);
}

export function patchBoard(id: number, name: string): Promise<Board> {
  return api<Board>(`/api/boards/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function deleteBoard(id: number): Promise<{ deleted: number }> {
  return api<{ deleted: number }>(`/api/boards/${id}`, { method: "DELETE" });
}

export function createNode(input: {
  board_id: number;
  type: NodeType;
  x: number;
  y: number;
  data?: object;
}): Promise<NodeDTO> {
  return api<NodeDTO>("/api/nodes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Shallow-merge patch for `node.data` — the backend (see
 * agent/flowboard/routes/nodes.py::update_node) merges this dict into
 * the existing JSON column instead of replacing it.
 *
 * Conventions:
 *   - Keys present in the patch override existing values.
 *   - Keys absent from the patch are PRESERVED (this is what the type
 *     guarantees over a wholesale replace).
 *   - A value of `null` is the explicit "delete this key" sentinel.
 *     Use it instead of `undefined` to clear fields like `aiBrief`
 *     after a regen — `undefined` gets dropped by JSON.stringify and
 *     would leave the stale value in place after the merge.
 *   - Merge depth is ONE LEVEL. Nested dict values are wholesale-
 *     replaced, not deep-merged. None of FlowboardNodeData's current
 *     fields nest, so this is a non-issue today; revisit if a future
 *     field stores objects.
 *
 * Pre-merge call sites that built the full `data` from scratch and
 * forgot a sibling field caused a real data-loss regression
 * (`aspectRatio` was wiped on every image gen by the auto-brief
 * patch). Sticking to deltas-only with this type as the contract
 * prevents that whole class of bug.
 */
export type DataPatch = Record<string, unknown>;

export function patchNode(
  id: number,
  patch: Partial<
    Pick<Omit<NodeDTO, "data">, "x" | "y" | "w" | "h" | "status">
  > & { data?: DataPatch },
): Promise<NodeDTO> {
  return api<NodeDTO>(`/api/nodes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteNode(id: number): Promise<{ ok: true; deleted_edges: number[] }> {
  return api<{ ok: true; deleted_edges: number[] }>(`/api/nodes/${id}`, {
    method: "DELETE",
  });
}

export function createEdge(input: {
  board_id: number;
  source_id: number;
  target_id: number;
  kind?: string;
  source_variant_idx?: number | null;
}): Promise<EdgeDTO> {
  return api<EdgeDTO>("/api/edges", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Update an edge's variant pin without recreating it. Pass
 * `source_variant_idx: null` explicitly to clear the pin (revert to
 * the source's active mediaId at dispatch time). Omit the field to
 * leave it untouched.
 */
export function patchEdge(
  id: number,
  patch: { source_variant_idx?: number | null },
): Promise<EdgeDTO> {
  return api<EdgeDTO>(`/api/edges/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteEdge(id: number): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/edges/${id}`, {
    method: "DELETE",
  });
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessageDTO {
  id: number;
  board_id: number;
  role: ChatRole;
  content: string;
  mentions: string[];
  created_at: string;
}

export interface PlanDTO {
  id: number;
  board_id: number;
  spec: {
    nodes: Array<{ tmp_id?: string; type: string; params?: Record<string, unknown> }>;
    edges: Array<{ from: string; to: string; kind?: string }>;
    layout_hint?: string;
  };
  status: "draft" | "approved" | "running" | "done" | "failed";
  created_at: string;
}

export interface ChatSendResponse {
  user: ChatMessageDTO;
  assistant: ChatMessageDTO;
  plan?: PlanDTO;
}

export function listChatMessages(boardId: number) {
  return api<ChatMessageDTO[]>(`/api/boards/${boardId}/chat`);
}

export function sendChatMessage(
  boardId: number,
  message: string,
  mentions: string[],
) {
  return api<ChatSendResponse>("/api/chat", {
    method: "POST",
    body: JSON.stringify({ board_id: boardId, message, mentions }),
  });
}

// ── Generation ───────────────────────────────────────────────────────────────

export interface BoardProject {
  flow_project_id: string;
  created: boolean;
}

export interface RequestDTO {
  id: number;
  node_id: number | null;
  type: string;
  params: Record<string, unknown>;
  // 'canceled' = user cancelled the request from the activity bell.
  // 'timeout' = backend's 5-minute video-gen budget elapsed; the row
  // self-transitions out of running. Both are terminal states.
  status: "queued" | "running" | "done" | "failed" | "canceled" | "timeout";
  result: Record<string, unknown>;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export function ensureBoardProject(boardId: number) {
  return api<BoardProject>(`/api/boards/${boardId}/project`, { method: "POST" });
}

export function getBoardProject(boardId: number) {
  return api<BoardProject>(`/api/boards/${boardId}/project`).catch(() => null);
}

// ── Auth / profile ───────────────────────────────────────────────────────

export interface AuthMe {
  // Identity rode on the Bearer token the extension sniffed off
  // aisandbox-pa. Since Flow moved to flow.google.com no Bearer is minted,
  // so these stay null and `identity_available` is false — genuinely
  // unavailable, not pending. Don't poll waiting for them.
  email: string | null;
  name: string | null;
  picture: string | null;
  verified_email: boolean | null;
  identity_available: boolean;
  // The tier generation will actually use. Same story as identity — it came
  // from /v1/credits with that token — so it is declared in the agent's
  // config now rather than discovered.
  paygate_tier: "PAYGATE_TIER_ONE" | "PAYGATE_TIER_TWO" | null;
  // "extension" when a live signal was available (an older extension that
  // still captures a token), "configured" otherwise — the normal case.
  paygate_tier_source: "extension" | "configured";
  // Set when the configured tier is not a value Flow recognises. Generation
  // will refuse until it is fixed, so surface it rather than waiting for a
  // dispatch to fail.
  paygate_tier_error: string | null;
  // Subscription SKU from /v1/credits — e.g. "WS_ULTRA" / "WS_PRO".
  // Available alongside paygate_tier; null until the credits fetch lands.
  sku: string | null;
  // Subscription credits remaining — bonus info from /v1/credits.
  // Frontend can display under the tier badge if desired.
  credits: number | null;
}

export function getAuthMe() {
  return api<AuthMe>("/api/auth/me").catch(() => null);
}

export interface AuthLogoutResult {
  ok: boolean;
  // Whether the agent could push a `logout` message to the extension
  // over its open WebSocket. False when no extension is connected —
  // agent-side caches were still cleared so the dashboard reflects
  // the logged-out state immediately.
  extension_notified: boolean;
}

export function logoutExtension() {
  return api<AuthLogoutResult>("/api/auth/logout", { method: "POST" });
}

export interface AuthScanResult {
  // True when the extension WebSocket is currently connected to the
  // agent. False means the user must install / enable / open Chrome.
  extension_connected: boolean;
  has_user_info: boolean;
  has_paygate_tier: boolean;
  // True when the agent had to ask the extension to re-fetch userinfo
  // (i.e. WS open but cache empty). Backend sets this only in that
  // narrow case; otherwise false.
  userinfo_nudged: boolean;
  // True when the agent successfully resolved tier from /v1/credits
  // during this scan call. False if the call failed (token expired,
  // network error, etc.) or if tier was already cached.
  tier_fetched: boolean;
}

export function scanExtension() {
  return api<AuthScanResult>("/api/auth/scan", { method: "POST" });
}

export function createRequest(body: {
  type: string;
  node_id?: number;
  params: Record<string, unknown>;
}) {
  return api<RequestDTO>("/api/requests", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getRequest(id: number) {
  return api<RequestDTO>(`/api/requests/${id}`);
}

/**
 * One row of `GET /api/boards/{id}/requests`. Deliberately thinner than
 * `RequestDTO` — no `result` / `error`, because the caller is about to poll
 * each row anyway and shipping every finished result would make a board
 * load carry its whole generation history.
 *
 * `params` IS included: a page that reloaded mid-generation has to rebuild
 * the poll's options (prompt, aspect ratio) from it, since the
 * `dispatchGeneration` call that originally held them died with the old page.
 */
export interface BoardRequestItem {
  id: number;
  type: string;
  status: RequestDTO["status"];
  node_id: number | null;
  node_short_id: string | null;
  created_at: string;
  params: Record<string, unknown>;
}

/** Requests attached to this board's nodes. `active` narrows to the ones
 * still in flight (queued / running) — what a reloading board wants. */
export function listBoardRequests(boardId: number, opts?: { active?: boolean }) {
  const qs = opts?.active ? "?active=true" : "";
  return api<{ items: BoardRequestItem[] }>(`/api/boards/${boardId}/requests${qs}`);
}

// ── Plans + Pipeline runs ────────────────────────────────────────────────────

export interface PipelineRunDTO {
  id: number;
  plan_id: number;
  status: "pending" | "running" | "done" | "failed";
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export function getPlan(planId: number) {
  return api<PlanDTO>(`/api/plans/${planId}`);
}

export function runPlan(planId: number) {
  return api<PipelineRunDTO>(`/api/plans/${planId}/run`, { method: "POST" });
}

export function getPipelineRun(runId: number) {
  return api<PipelineRunDTO>(`/api/pipeline-runs/${runId}`);
}

// ── Media ────────────────────────────────────────────────────────────────────

export interface MediaStatus {
  available: boolean;
  has_url: boolean;
  mime?: string;
  reason?: string;
}

export function getMediaStatus(mediaId: string): Promise<MediaStatus> {
  const clean = mediaId.replace(/^media\//, "");
  return api<MediaStatus>(`/api/media/${encodeURIComponent(clean)}/status`);
}

export function mediaUrl(mediaId: string): string {
  const clean = mediaId.replace(/^media\//, "");
  return `/media/${encodeURIComponent(clean)}`;
}

// ── Upload ───────────────────────────────────────────────────────────────────

export interface UploadResponse {
  media_id: string;
  mime: string;
  size: number;
  // Detected by the agent from the image bytes; one of
  // IMAGE_ASPECT_RATIO_{SQUARE,PORTRAIT,LANDSCAPE}. Optional because legacy
  // responses (or formats we couldn't sniff) skip the field.
  aspect_ratio?: string;
  width?: number;
  height?: number;
}

export async function uploadImage(
  file: File,
  projectId: string,
  nodeId?: number,
): Promise<UploadResponse> {
  const form = new FormData();
  form.append("project_id", projectId);
  if (nodeId !== undefined) form.append("node_id", String(nodeId));
  form.append("file", file);

  // Don't set Content-Type — the browser sets it with the correct boundary.
  const res = await fetch("/api/upload", { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<UploadResponse>;
}

export interface VisionDescribeResponse {
  media_id: string;
  description: string;
}

export interface AutoPromptResponse {
  node_id: number;
  prompt: string;
}

export interface AutoPromptBatchResponse {
  node_id: number;
  prompts: string[];
}

export async function autoPromptBatch(
  nodeId: number,
  count: number,
  opts?: { camera?: string },
): Promise<AutoPromptBatchResponse> {
  const res = await fetch("/api/prompt/auto-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, count, camera: opts?.camera }),
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<AutoPromptBatchResponse>;
}

export async function autoPrompt(
  nodeId: number,
  opts?: { camera?: string },
): Promise<AutoPromptResponse> {
  const res = await fetch("/api/prompt/auto", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, camera: opts?.camera }),
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<AutoPromptResponse>;
}

export async function describeMedia(mediaId: string): Promise<VisionDescribeResponse> {
  const res = await fetch("/api/vision/describe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ media_id: mediaId }),
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<VisionDescribeResponse>;
}

export async function uploadImageFromUrl(
  url: string,
  projectId: string,
  nodeId?: number,
): Promise<UploadResponse> {
  const res = await fetch("/api/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, project_id: projectId, node_id: nodeId }),
  });
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  return res.json() as Promise<UploadResponse>;
}


// ── LLM provider Settings ─────────────────────────────────────────────────
// Per-feature model: each of the 3 features (auto_prompt / vision /
// planner) independently pins a provider + model + effort. The old
// single-provider invariant ("all 3 features must point at the same
// name") is gone — `configured` now only means every feature has a
// provider pinned; model/effort stay optional.

export type LLMProviderName = "claude" | "gemini" | "openai";
export type LLMFeature = "auto_prompt" | "vision" | "planner";
export type LLMProviderMode = "cli" | "api" | "none";
export type LLMLastError =
  | "not_installed"
  | "not_authenticated"
  | "no_key"
  | "unreachable"
  | "unknown";

/** One entry of a provider's model catalog. `id` is what travels back
 * in the config / test payloads; `label` is display-only. */
export interface LLMModelInfo {
  id: string;
  label: string;
}

export interface LLMProviderInfo {
  name: LLMProviderName;
  supportsVision: boolean;
  available: boolean;
  configured: boolean;
  requiresKey: boolean;
  mode: LLMProviderMode;
  // Effort vocabularies differ per provider (claude: low…max, agy:
  // low/medium/high, codex: whatever it reports), so the UI must render
  // the options from `efforts` and never hardcode a list.
  supportsEffort: boolean;
  efforts: string[];
  // Legitimately [] when the catalog couldn't be fetched (offline, CLI
  // mid-upgrade, auth expired). The UI falls back to a free-text model
  // field in that case so a stale catalog can't block the user.
  models: LLMModelInfo[];
  defaultModel: string | null;
  lastError?: LLMLastError;
  lastTest?: { ok: boolean; latencyMs?: number; error?: string };
}

/** One feature's pin. Every field is independently nullable:
 * `provider` null = feature not set up yet; `model` / `effort` null =
 * "whatever the provider defaults to". */
export interface LLMFeatureConfig {
  provider: LLMProviderName | null;
  model: string | null;
  effort: string | null;
}

export interface LLMConfig {
  auto_prompt: LLMFeatureConfig;
  vision: LLMFeatureConfig;
  planner: LLMFeatureConfig;
  // True once every feature has a provider. Drives the forced-setup
  // gate. A feature with a provider but no model still counts as
  // configured — the backend falls back to that provider's default.
  configured: boolean;
}

/** PUT body — feature keys and the fields inside them are all
 * optional, so a caller can patch one feature without re-sending the
 * other two. */
export type LLMConfigUpdate = Partial<
  Record<LLMFeature, Partial<LLMFeatureConfig>>
>;

export async function getLlmProviders(): Promise<LLMProviderInfo[]> {
  // Backend returns snake-case keys mapped from Python — but the route
  // already emits camelCase for the public surface. Re-typed here so
  // the spread/destructure pattern in the UI components stays clean.
  const res = await fetch("/api/llm/providers");
  if (!res.ok) throw new Error(`getLlmProviders: ${res.status}`);
  return res.json() as Promise<LLMProviderInfo[]>;
}

export interface LlmModelCatalog {
  models: LLMModelInfo[];
  /** True when the backend answered from its catalog cache rather than
   * re-asking the CLI — surfaced so the refresh button can tell the
   * user whether anything was actually re-fetched. */
  cached: boolean;
}

export async function getLlmProviderModels(
  name: LLMProviderName,
  force = false,
): Promise<LlmModelCatalog> {
  // `force=true` bypasses the backend's catalog cache. Wired to the
  // per-row refresh button for the case where the user installs a new
  // model / upgrades the CLI while the dialog is open.
  const qs = force ? "?force=true" : "";
  const res = await fetch(`/api/llm/providers/${name}/models${qs}`);
  if (!res.ok) throw new Error(`getLlmProviderModels: ${res.status}`);
  return res.json() as Promise<LlmModelCatalog>;
}

export async function getLlmConfig(): Promise<LLMConfig> {
  const res = await fetch("/api/llm/config");
  if (!res.ok) throw new Error(`getLlmConfig: ${res.status}`);
  return res.json() as Promise<LLMConfig>;
}

export async function setLlmConfig(
  partial: LLMConfigUpdate,
): Promise<{ ok: boolean }> {
  const res = await fetch("/api/llm/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

export async function setLlmApiKey(
  name: LLMProviderName,
  apiKey: string | null,
): Promise<{ ok: boolean }> {
  // null clears the key. Backend chmods secrets.json to 0o600 after
  // every write; the key is never echoed back via getLlmProviders.
  const res = await fetch(`/api/llm/providers/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

export interface LlmTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export async function testLlmProvider(
  name: LLMProviderName,
  opts: { model?: string | null; effort?: string | null } = {},
): Promise<LlmTestResult> {
  // Cost-bounded by the backend: 1-token ping, 15s deadline. Returns
  // ok:false (NOT a non-200 HTTP status) on any failure mode so the
  // UI can render the error inline without try/catch boilerplate.
  //
  // model/effort are passed through so a per-feature row tests the
  // exact combination it is about to save — a provider that answers on
  // its default model can still fail on an exotic one.
  const body: { model?: string; effort?: string } = {};
  if (opts.model) body.model = opts.model;
  if (opts.effort) body.effort = opts.effort;
  const res = await fetch(`/api/llm/providers/${name}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}` };
  }
  return res.json();
}


// ── Activity feed ─────────────────────────────────────────────────────────
// Read-only surface over the Request table. Captures every backend op:
// gen_image / gen_video / edit_image (worker), auto_prompt /
// auto_prompt_batch / vision / planner (LLM layer via record_activity).

export type ActivityType =
  | "auto_prompt" | "auto_prompt_batch"
  | "vision" | "planner"
  | "gen_image" | "gen_video" | "edit_image"
  | "upload" | "upload_url";
export type ActivityStatus = "queued" | "running" | "done" | "failed";

export interface ActivityListItem {
  id: number;
  type: ActivityType | string; // string fallback for forward-compat
  status: ActivityStatus | string;
  node_id: number | null;
  node_short_id: string | null;
  created_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface ActivityDetail extends ActivityListItem {
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string | null;
}

export async function getActivityList(opts?: {
  limit?: number;
  beforeId?: number;
  type?: string[];
}): Promise<{ items: ActivityListItem[]; next_before_id: number | null }> {
  const search = new URLSearchParams();
  if (opts?.limit) search.set("limit", String(opts.limit));
  if (opts?.beforeId) search.set("before_id", String(opts.beforeId));
  if (opts?.type && opts.type.length > 0) search.set("type", opts.type.join(","));
  const q = search.toString();
  const res = await fetch(`/api/activity${q ? `?${q}` : ""}`);
  if (!res.ok) throw new Error(`getActivityList: ${res.status}`);
  return res.json();
}

export async function getActivityDetail(id: number): Promise<ActivityDetail> {
  const res = await fetch(`/api/activity/${id}`);
  if (!res.ok) throw new Error(`getActivityDetail: ${res.status}`);
  return res.json();
}

// Cancel a queued or running request. The activity row id IS the
// underlying Request.id, so the same numeric handle works against
// /api/requests. Backend returns 409 when the row has already settled
// (done/failed/timeout/canceled).
export async function cancelActivity(id: number): Promise<void> {
  const res = await fetch(`/api/requests/${id}/cancel`, { method: "POST" });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`cancelActivity: ${res.status} ${detail}`);
  }
}


// ── References ───────────────────────────────────────────────────────────
// User-curated cross-board library of saved media. Backend mirror:
// agent/flowboard/routes/references.py + db.models.Reference.
// JSON wire format is snake_case (mirrors SQLModel column names);
// camelCase is reserved for the TS surface, so each helper maps the
// rows on the way back.

export interface ReferenceItem {
  id: number;
  mediaId: string;
  // Best-effort signed CDN URL captured at save time. May expire — the
  // canonical bytes live in storage/media/{mediaId}.{ext}; this field
  // exists purely as a re-ingest hint when the file goes missing.
  url: string | null;
  label: string;
  kind: "image" | "character" | "visual_asset" | "storyboard_shot";
  // Snapshot of the source node's aiBrief at save time; lets cross-board
  // spawn skip the re-vision call entirely.
  aiBrief: string | null;
  aspectRatio: string | null;
  tags: string[];
  pinned: boolean;
  position: number;
  sourceBoardId: number | null;
  sourceNodeShortId: string | null;
  createdAt: string;
}

// Wire-shape POST body — snake_case to match the FastAPI schema 1:1.
export interface ReferenceCreateInput {
  media_id: string;
  kind: ReferenceItem["kind"];
  label?: string;
  ai_brief?: string | null;
  aspect_ratio?: string | null;
  url?: string | null;
  source_board_id?: number | null;
  source_node_short_id?: string | null;
  tags?: string[];
}

// Wire-shape PATCH body. Same snake_case convention.
export interface ReferencePatchInput {
  label?: string;
  pinned?: boolean;
  position?: number;
  tags?: string[];
}

interface ReferenceRowWire {
  id: number;
  media_id: string;
  url: string | null;
  label: string;
  kind: string;
  ai_brief: string | null;
  aspect_ratio: string | null;
  tags: string[] | null;
  pinned: boolean;
  position: number;
  source_board_id: number | null;
  source_node_short_id: string | null;
  created_at: string;
}

function mapReferenceRow(row: ReferenceRowWire): ReferenceItem {
  // Coerce the kind string into the typed union — the backend already
  // validates against _ALLOWED_KINDS so any unknown value here would
  // mean a backend bug. Fall back to "image" defensively rather than
  // throwing, so a single bad row doesn't break the whole list render.
  const allowed: ReferenceItem["kind"][] = [
    "image",
    "character",
    "visual_asset",
    "storyboard_shot",
  ];
  const kind: ReferenceItem["kind"] = (allowed as string[]).includes(row.kind)
    ? (row.kind as ReferenceItem["kind"])
    : "image";
  return {
    id: row.id,
    mediaId: row.media_id,
    url: row.url,
    label: row.label,
    kind,
    aiBrief: row.ai_brief,
    aspectRatio: row.aspect_ratio,
    tags: Array.isArray(row.tags) ? row.tags : [],
    pinned: row.pinned,
    position: row.position,
    sourceBoardId: row.source_board_id,
    sourceNodeShortId: row.source_node_short_id,
    createdAt: row.created_at,
  };
}

export async function listReferences(params?: {
  q?: string;
  pinned_first?: boolean;
  limit?: number;
}): Promise<ReferenceItem[]> {
  const search = new URLSearchParams();
  if (params?.q) search.set("q", params.q);
  if (params?.pinned_first !== undefined) {
    search.set("pinned_first", String(params.pinned_first));
  }
  if (params?.limit !== undefined) search.set("limit", String(params.limit));
  const qs = search.toString();
  const rows = await api<ReferenceRowWire[]>(
    `/api/references${qs ? `?${qs}` : ""}`,
  );
  return rows.map(mapReferenceRow);
}

export async function createReference(
  input: ReferenceCreateInput,
): Promise<ReferenceItem> {
  const row = await api<ReferenceRowWire>("/api/references", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return mapReferenceRow(row);
}

export async function patchReference(
  id: number,
  patch: ReferencePatchInput,
): Promise<ReferenceItem> {
  const row = await api<ReferenceRowWire>(`/api/references/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return mapReferenceRow(row);
}

export async function deleteReference(id: number): Promise<void> {
  // Backend returns 204 No Content; api<T>() would choke on the empty
  // body, so we use fetch() directly and skip the JSON parse.
  const res = await fetch(`/api/references/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`deleteReference: ${res.status} ${res.statusText}`);
  }
}

// ── Flow project sync (local → Flow, one direction) ───────────────────────

export interface BoardFlowStatus {
  board_id: number;
  board_name: string;
  flow_project_id: string | null;
  // null = could not be checked. Flow exposes no project-listing RPC since
  // the migration, so this is null in practice; treating null as `false`
  // would flag every board as missing from Flow.
  exists_on_flow: boolean | null;
}

export interface FlowListingStatus {
  available: boolean;
  reason: string | null;
  // The single Flow project every board generates into, when one is pinned.
  pinned_project_id: string | null;
}

export interface SyncStatusResponse {
  board_status: BoardFlowStatus[];
  flow_listing: FlowListingStatus;
}

export interface SyncUpAction {
  board_id: number;
  board_name: string;
  old_flow_project_id: string | null;
  new_flow_project_id: string | null;
  status: "created" | "rebound" | "failed";
  error: string | null;
}

export interface SyncUpResponse {
  synced: SyncUpAction[];
  failed: SyncUpAction[];
  total_boards: number;
}

export function getFlowSyncStatus(): Promise<SyncStatusResponse> {
  return api<SyncStatusResponse>("/api/flow/projects");
}

export function syncBoardsUpToFlow(): Promise<SyncUpResponse> {
  return api<SyncUpResponse>("/api/flow/projects/sync-up", { method: "POST" });
}
