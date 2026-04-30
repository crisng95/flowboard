> **Status: ALTERNATIVE — preserved for reference, not the active plan.**
>
> The chosen approach is `multi-llm-provider.md` which pivots to using
> [9Router](https://github.com/decolua/9router) (a local OpenAI-compatible
> proxy) instead of integrating 4 vendors directly inside Flowboard. This
> file documents the dropped 4-vendor approach — kept because:
>
> 1. The hybrid CLI / API vision-attachment strategy here is generally
>    useful and may inform future provider work.
> 2. If a future requirement forces Flowboard to ship without external
>    npm dependencies (e.g. self-contained Docker image, air-gapped env),
>    falling back to direct integrations is the right shape.
> 3. Provides a worked example of per-vendor error mapping, secret
>    storage, and Settings-UI auth flow.
>
> **Comparison vs the chosen 9Router plan:**
>
> | Metric | This (5-vendor) | 9Router |
> |---|---|---|
> | Effort | ~7 days | ~4 days |
> | Provider classes to write | 5 | 2 |
> | Models reachable | 5 | 100+ |
> | API keys Flowboard might manage | 3 max (OpenAI fallback / Grok / DeepSeek; Claude + Gemini + OpenAI CLI auth use OAuth) | 1 |
> | CLI subscription benefit (no key) | **Claude + Gemini + OpenAI (Codex CLI)** | Claude direct, plus 9Router routes Claude Code OAuth, Codex OAuth, Cursor OAuth, GitHub Copilot OAuth, Kiro Free, OpenCode Free, Vertex Free |
> | External dependency | None (uses each vendor's own CLI/API) | `9router` npm package |
> | Token-saving (RTK 20-40%) | No | Yes |
> | Built-in fallback chain | No | Yes (combos) |
> | Cheapest text option | DeepSeek-chat ($0.14/M in) | DeepSeek-chat via 9Router (same vendor, +0% markup) |
>
> Last updated: 2026-04-30 (added Codex CLI as Tier 1 for OpenAI; DeepSeek as 5th provider; original draft commit `c7c1647` had 4).

---

# Plan — Multi-LLM Provider support (Claude / Gemini / OpenAI / Grok / DeepSeek)

## Requirements Summary

Replace the single Claude-CLI dependency with a swappable provider layer so users can pick which LLM powers each Flowboard feature. Provide:
1. **Backend abstraction** with 5 providers (Claude, Gemini, OpenAI, Grok, DeepSeek)
2. **Per-feature provider routing** (Auto-Prompt / Vision / Planner can each use a different provider)
3. **Settings UI** for picking providers + entering API keys + testing connections
4. **Secret storage** that survives restart but stays local (no cloud, no PII to backend logs)
5. **Backward-compatible** with existing `FLOWBOARD_PLANNER_BACKEND` env var; default = Claude (current behavior)
6. **Vision-capability enforcement** — providers that don't support vision (e.g. DeepSeek text-only) cannot be set as the Vision provider; backend rejects with a clear error and the UI dropdown disables them.

## Decisions

| Decision | Default | Rationale |
|---|---|---|
| Provider granularity | **Per-feature** (Auto-Prompt / Vision / Planner each pick) | Vision much cheaper on Gemini; planner JSON extraction more reliable on Claude. One global setting forces a bad compromise. |
| Auth model — Claude / Gemini | **CLI auth** (existing `claude` + new `gemini` CLI subscription) | Matches Flowboard's "no API key, use your existing subscription" philosophy. Both vendors ship official CLIs (Anthropic Claude CLI, Google `gemini-cli` via npm). |
| Auth model — OpenAI | **Tier 1: Codex CLI (OAuth with ChatGPT subscription) — Tier 2: API key fallback** | OpenAI ships `@openai/codex` CLI with OAuth auth against ChatGPT Plus/Pro accounts. Same "use your existing subscription" benefit as Claude CLI. CLI mode is preferred when `codex` binary is detected + authenticated; API key mode is the documented fallback for users without a ChatGPT subscription (or when Codex CLI vision support proves inadequate — see risks). The `OpenAIProvider` class probes at init and selects the mode automatically. |
| Auth model — Grok / DeepSeek | **API key entry in UI** | Neither vendor has a stable end-user CLI with OAuth flow as of plan date. Direct REST API + user-supplied key. DeepSeek's API is OpenAI-compatible (`https://api.deepseek.com/v1`), so the same `httpx` client shape works. |
| DeepSeek vision | **Not supported — `supports_vision = False`** | DeepSeek's public API (`deepseek-chat` / `deepseek-reasoner`) is text-only as of 2026-04. Their vision models (`deepseek-vl2` family) aren't on the same endpoint. Picking DeepSeek as the Vision provider must be blocked at backend boundary + disabled in the UI dropdown. This is the first time the vision-capability check actually triggers — the other 4 providers all have vision. |
| DeepSeek model selection | Default `deepseek-chat` for Auto-Prompt; `deepseek-reasoner` (R1) for Planner | Reasoner model is heavier but excels at structured-output / JSON-extraction tasks (the Planner flow). Auto-Prompt uses the cheaper / faster chat model. |
| Secret storage | **Plain JSON at `~/.flowboard/secrets.json` with file mode 600** | Single-user local app, OS-level file permissions are sufficient. Encryption adds key-management surface area without real benefit. Gitignored by virtue of being outside the repo. |
| API key transport | **Backend-only** — never expose keys to browser | Frontend POSTs the key to `PUT /api/llm/providers/openai` once; never reads it back. Status endpoint returns only `{configured: true}`. |
| Per-feature config storage | **Same secrets.json** under separate top-level key (`activeProviders`) | One file, one source of truth. Hot-reloads on every dispatch (no caching pitfalls). |
| Vision routing | **Auto-route to vision-capable provider** if user picked a text-only one | Don't fail silently if user sets Vision = Grok-1 (no vision). Resolve to nearest capable + log a warning. Out of scope until Grok-1: all 4 currently planned providers have vision. |
| Vision attachment transport | **Hybrid — caller passes file path; provider converts internally** | CLI providers (Claude, Gemini) attach via their native flag (`@<path>` / `--image <path>`) — preserves the "no API key, use subscription" benefit. API providers (OpenAI, Grok) read bytes → base64 → inline data URL in request body. Unified caller contract: `attachments: list[str]` of file paths. Forces every provider to support the SAME caller signature without leaking transport details upstream. Alternative considered: force base64 for everyone — rejected because it would require API keys for Claude/Gemini and lose the existing-subscription benefit. |
| Backward compat | **`FLOWBOARD_PLANNER_BACKEND=mock\|cli\|auto`** still respected; new env vars overlay it | Existing dev setups don't break. New env var: `FLOWBOARD_LLM_DEFAULT_PROVIDER=claude` for headless deployments. |
| Cost telemetry | **Out of scope** for v1 | Counters per provider, monthly spend tracking — nice-to-have but not blocking. |
| Fallback chain | **Out of scope** for v1 | "Primary fails → switch to next" complexity not justified yet. Keep error surfaces clean; let the user decide. |

## Acceptance Criteria

1. Settings panel has a new **AI Providers** section with three per-feature dropdowns: Auto-Prompt / Vision / Planner. Each dropdown lists Claude, Gemini, OpenAI, Grok, DeepSeek with a status icon (`✓ ready`, `⚠ no key`, `✗ unavailable`).
2. **Claude / Gemini** rows show `✓ ready` only when their CLI is installed and authenticated. Click "Setup →" → opens a help dialog with `npm install -g …` + auth command.
3. **OpenAI / Grok / DeepSeek** rows show an input field for API key + a **Test** button. Test calls a tiny prompt and reports success/failure within 10s. Key is masked after save (`sk-…••••`).
4. Generating an image with **Auto-Prompt = Gemini** routes the synth call through Gemini CLI, not Claude. Verifiable by inspecting agent logs (`llm: provider=gemini feature=auto_prompt`).
5. Uploading an image with **Vision = OpenAI** routes the describe call through OpenAI's vision endpoint. The aiBrief returned matches the same 200-char factual format as Claude.
6. **DeepSeek is text-only** — the Vision dropdown shows DeepSeek with a "Text only" tag and the option is disabled. Backend rejects with `LLMError("DeepSeek doesn't support vision; reconfigure Vision provider")` if a stale frontend somehow dispatches a vision call routed to DeepSeek.
7. Setting **Planner = DeepSeek** routes through `deepseek-reasoner` (R1 model). Setting **Auto-Prompt = DeepSeek** routes through `deepseek-chat` (faster / cheaper).
8. Provider config persists across agent restart — user picks Gemini, restarts agent, still on Gemini.
9. API keys never appear in agent logs (filter at logger level), in HTTP responses (only `{configured: true}` returned), or in browser localStorage.
10. Removing an API key (clear field + Save) sets the row back to `⚠ no key` and disables that provider in dropdowns until re-entered.
11. If user picks a provider that's currently unavailable (CLI missing, no key) and dispatches, request fails with a clear error message naming the missing provider — NOT a silent fallback.
12. All 30+ existing tests still pass after migration. No backend test should reach a real provider — the abstraction is mockable.
13. New unit tests cover: provider registry routing, secret-file roundtrip, per-feature dispatch, vision-capability check (including DeepSeek rejection path), DeepSeek model auto-selection (chat vs reasoner per feature).

## Implementation Steps

### Step 1 — Backend: provider abstraction package

New package `agent/flowboard/services/llm/`:

```
llm/
  __init__.py        # Re-exports run_llm + LLMProvider
  base.py            # Protocol + LLMRequest/LLMResponse dataclasses
  claude.py          # Wraps existing claude_cli.py (no logic change, just rename + adapt)
  gemini.py          # NEW — subprocess wrapper for `gemini` CLI
  openai.py          # NEW — httpx client → POST /v1/chat/completions
  grok.py            # NEW — httpx client → POST https://api.x.ai/v1/chat/completions
  deepseek.py        # NEW — httpx client → POST https://api.deepseek.com/v1/chat/completions (text-only)
  registry.py        # Picks provider by feature + handles vision routing
  secrets.py         # Read/write ~/.flowboard/secrets.json with mode 600
```

`base.py`:
```python
class LLMProvider(Protocol):
    name: str
    supports_vision: bool

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: str | None = None,
        attachments: list[str] | None = None,
        timeout: float = 90.0,
    ) -> str: ...

    async def is_available(self) -> bool: ...
```

`registry.py`:
```python
async def run_llm(
    feature: Literal["auto_prompt", "vision", "planner"],
    user_prompt: str,
    **kwargs,
) -> str:
    config = secrets.read_active_providers()  # {feature → provider_name}
    provider_name = config.get(feature, "claude")
    provider = _PROVIDERS[provider_name]
    if attachments := kwargs.get("attachments"):
        if not provider.supports_vision:
            raise LLMError(f"{provider_name} doesn't support vision; reconfigure Vision provider")
    if not await provider.is_available():
        raise LLMError(f"{provider_name} is not configured (no API key / CLI missing)")
    return await provider.run(user_prompt, **kwargs)
```

### Step 2 — Backend: secret storage

`agent/flowboard/services/llm/secrets.py`:
```python
import json
import os
from pathlib import Path

_PATH = Path.home() / ".flowboard" / "secrets.json"

# Schema:
# {
#   "apiKeys": {"openai": "sk-...", "grok": "xai-...", "deepseek": "sk-..."},
#   "activeProviders": {
#     "auto_prompt": "claude",
#     "vision": "gemini",
#     "planner": "claude"
#   }
# }

def read() -> dict:
    if not _PATH.exists():
        return {}
    try:
        return json.loads(_PATH.read_text())
    except json.JSONDecodeError:
        return {}

def write(payload: dict) -> None:
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2))
    os.chmod(tmp, 0o600)
    tmp.replace(_PATH)

def get_api_key(provider: str) -> str | None: ...
def set_api_key(provider: str, key: str | None) -> None: ...
def read_active_providers() -> dict[str, str]: ...
def set_feature_provider(feature: str, provider: str) -> None: ...
```

### Step 3 — Backend: 5 provider implementations

**Vision attachment strategy** — caller signature is identical across providers (`attachments: list[str]` of file paths). Each vision-capable provider converts internally based on its transport. DeepSeek is text-only — its `run()` raises `LLMError` if attachments are non-empty, defending against any caller that bypasses the registry's capability check:

| Provider | Vision | Transport | Attachment handling |
|---|---|---|---|
| Claude | ✓ | CLI subprocess | Pass `@<absolute_path>` arg + `--add-dir <parent> --permission-mode bypassPermissions` (existing pattern) |
| Gemini | ✓ | CLI subprocess | Pass `--image <absolute_path>` per attachment (verify exact flag via `gemini --help`) |
| OpenAI (Codex CLI mode) | ✓ if CLI supports it · ✗ otherwise | CLI subprocess (`codex exec --output-format json -p <prompt>`) | If `codex --help` advertises an image flag (e.g. `--image <path>` or `--attach <path>` — verify at provider init), use it. **If Codex CLI lacks vision support**, OpenAIProvider falls back to API mode for vision dispatches only (text features stay on Codex). This dual-mode is documented in the provider class. |
| OpenAI (API mode — fallback) | ✓ | REST API (httpx) | Read file bytes → `base64.b64encode` → embed as data URL in `messages[].content[].image_url.url`. Mime type detected via `mimetypes.guess_type(path)`. Used when no Codex CLI installed OR Codex CLI lacks vision support. |
| Grok | ✓ | REST API (httpx) | Same base64 data-URL pattern as OpenAI API mode (xAI uses OpenAI-compatible message schema) |
| DeepSeek | ✗ | REST API (httpx) | Reject non-empty attachments at `Provider.run()` boundary. Registry is the primary guard, but defense in depth keeps DeepSeek from silently dropping image content if a stale code path bypasses the check. |

**File-size guard** — vision-capable provider modules reject attachments >5MB before sending (each provider has a different max but 5MB is comfortably under all of them; Flow image outputs are typically <2MB so non-issue in practice). Surfaced as `LLMError("attachment too large for {provider}: {size}MB > 5MB cap")`.

**Why hybrid not "base64 everywhere"** — pushing every provider through API + base64 would force API keys for Claude/Gemini, losing the existing-subscription benefit (matches Flowboard's local-only / no-key philosophy). The caller code stays clean either way; only the provider implementation differs.

---

**`claude.py`**: copy logic from current `claude_cli.py`, conform to LLMProvider protocol. Keep current `@<path>` attachment handling. `supports_vision = True` (Haiku 4.5 / Sonnet / Opus all have vision).

**`gemini.py`**: subprocess `gemini -p <prompt> --json` (verify exact CLI flags via `gemini --help`). Vision attachments via `--image <path>` per file. Same `--version` probe pattern as Claude. `supports_vision = True` (Gemini Flash / Pro both have vision).

**`openai.py`** — dual-mode provider that prefers the OpenAI Codex CLI (OAuth with ChatGPT Plus/Pro subscription, matches the no-key philosophy used by Claude/Gemini) and falls back to the REST API only when needed.

```python
class OpenAIProvider:
    name = "openai"
    supports_vision = True   # via at least one of the modes

    async def __init_async__(self):
        # Probe Codex CLI at init: check `codex --version`, then parse
        # `codex --help` to detect the image attachment flag. Cache the
        # resolved auth mode for the agent's lifetime.
        if await _probe_codex_cli():
            self._mode = "cli"
            self._cli_image_flag = await _detect_codex_image_flag()  # "--image" / "--attach" / None
        elif secrets.get_api_key("openai"):
            self._mode = "api"
        else:
            self._mode = None  # is_available() returns False

    async def run(self, prompt, *, system_prompt=None, attachments=None, timeout=90.0, model=None):
        if self._mode == "cli":
            # Vision capability depends on Codex CLI version. If attachments
            # present and CLI doesn't support image flag → fall through to API
            # mode for THIS request (requires API key configured as backup).
            if attachments and self._cli_image_flag is None:
                if not secrets.get_api_key("openai"):
                    raise LLMError(
                        "OpenAI Codex CLI does not support vision in your version. "
                        "Either upgrade Codex CLI or configure an OpenAI API key in Settings."
                    )
                return await self._run_via_api(prompt, system_prompt, attachments, timeout, model)
            return await self._run_via_cli(prompt, system_prompt, attachments, timeout, model)
        return await self._run_via_api(prompt, system_prompt, attachments, timeout, model)
```

**CLI mode** (preferred): subprocess `codex exec --output-format json -p <prompt> [--image <path>]`. Same `--version` probe pattern as Claude/Gemini. JSON envelope parsing reuses the structure pioneered by `claude_cli.py`.

**API mode** (fallback): httpx async client. `POST https://api.openai.com/v1/chat/completions`. Default model: `gpt-5` for text, auto-bump to `gpt-4o` (or whichever vision-capable variant is current) when `attachments` is non-empty. Vision payload shape:
```python
content = [{"type": "text", "text": prompt}]
for path in attachments:
    b64 = base64.b64encode(Path(path).read_bytes()).decode()
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
```
JSON mode for planner: `response_format={"type":"json_object"}`. `supports_vision = True`.

**`grok.py`**: httpx client. `POST https://api.x.ai/v1/chat/completions` (xAI's OpenAI-compatible endpoint). Default model: `grok-4`; auto-bump to `grok-2-vision-1212` when `attachments` is non-empty. Same base64 data-URL message shape as OpenAI. `supports_vision = True`.

**`deepseek.py`**: httpx client. `POST https://api.deepseek.com/v1/chat/completions` (DeepSeek's OpenAI-compatible endpoint — same payload shape as OpenAI / Grok). Model selection by feature:
- Auto-Prompt → `deepseek-chat` (cheaper, ~$0.14/M input)
- Planner → `deepseek-reasoner` (R1 model — heavier but better at structured-output / JSON extraction)
- Vision → never reached; `run()` short-circuits with `LLMError` if attachments present.

JSON mode for planner: `response_format={"type":"json_object"}` (DeepSeek mirrors OpenAI's flag). `supports_vision = False`.

```python
# Sketch — deepseek.py
class DeepSeekProvider:
    name = "deepseek"
    supports_vision = False

    async def run(self, prompt, *, system_prompt=None, attachments=None, timeout=90.0, model=None):
        if attachments:
            raise LLMError("DeepSeek doesn't support vision; reconfigure Vision provider")
        # Pick model: caller can override; otherwise default = deepseek-chat
        chosen = model or "deepseek-chat"
        # … standard OpenAI-shape POST to https://api.deepseek.com/v1/chat/completions
```

Each provider's `is_available()`:
- Claude / Gemini: probe CLI binary with `--version` (5s timeout, cached)
- OpenAI: returns True if EITHER Codex CLI is installed + authenticated OR an API key is configured. CLI mode probe also caches the resolved image-attachment flag (or `None` if Codex CLI is text-only).
- Grok / DeepSeek: check `secrets.get_api_key(name)` is set + ping `/v1/models` with that key (cached 60s)

### Step 4 — Backend: HTTP routes for provider config

`agent/flowboard/routes/llm.py`:

```
GET  /api/llm/providers
  → [{name, supports_vision, available, configured, requires_key}]

PUT  /api/llm/providers/{name}
  body: {"apiKey": "sk-..."} | {"apiKey": null}  // null clears
  → {ok: true}

POST /api/llm/providers/{name}/test
  → {ok: true, latencyMs: 1234} | {ok: false, error: "..."}

GET  /api/llm/config
  → {auto_prompt: "claude", vision: "gemini", planner: "claude"}

PUT  /api/llm/config
  body: {auto_prompt?: "...", vision?: "...", planner?: "..."}
  → {ok: true}
```

Mount in `flowboard/app.py`. Tests in `tests/test_llm_routes.py`.

### Step 5 — Migrate existing services to use registry

Three small refactors:
- `prompt_synth.py`: `from .claude_cli import run_claude` → `from .llm import run_llm`; replace each call site `await run_claude(prompt, system_prompt=...)` → `await run_llm("auto_prompt", prompt, system_prompt=...)`. ~6 call sites.
- `vision.py`: same pattern; route as `"vision"`. ~1 call site.
- `planner.py`: same; route as `"planner"`. ~1 call site. Keep the existing `FLOWBOARD_PLANNER_BACKEND=mock` short-circuit so deterministic tests don't break.

Existing `claude_cli.py` becomes a thin re-export of `llm.claude.ClaudeProvider` for backward compat (deprecation note in docstring; remove in v1.2).

### Step 6 — Frontend: API client + types

`frontend/src/api/client.ts` — add functions:
```ts
export interface LLMProviderInfo {
  name: "claude" | "gemini" | "openai" | "grok" | "deepseek";
  supportsVision: boolean;   // false for deepseek
  available: boolean;        // CLI installed / key set
  configured: boolean;       // explicitly configured (key entered or CLI auth done)
  requiresKey: boolean;      // false for claude/gemini, true for openai/grok/deepseek
}

export interface LLMConfig {
  auto_prompt: string;
  vision: string;
  planner: string;
}

getLlmProviders(): Promise<LLMProviderInfo[]>;
setLlmApiKey(name: string, apiKey: string | null): Promise<{ok: boolean}>;
testLlmProvider(name: string): Promise<{ok: boolean; latencyMs?: number; error?: string}>;
getLlmConfig(): Promise<LLMConfig>;
setLlmConfig(partial: Partial<LLMConfig>): Promise<{ok: boolean}>;
```

### Step 7 — Frontend: Settings panel "AI Providers" section

Insert new section in `SettingsPanel.tsx` between "Video model" and "Image model":

```
═══ AI Providers ═══

Per-feature provider selection
─ Auto-Prompt: [Claude ✓ ▼]
─ Vision:      [Gemini ✓ ▼]
─ Planner:     [Claude ✓ ▼]

API Keys / Auth
─ Claude    ✓ Connected (Claude CLI · OAuth)         [Setup help →]
─ Gemini    ⚠ CLI not found                          [Setup help →]
─ OpenAI    ✓ Connected (Codex CLI · ChatGPT OAuth)  [Setup help →]
            [+ Add API key fallback for vision ▼]    ⓘ Codex CLI v0.x text-only;
                                                        API key needed for Vision feature
─ Grok      [_____________] [Test]   [Save]
─ DeepSeek  [sk-•••••••••••] [Test]  [Save]   ⓘ Text only — Vision dropdown excludes
```

OpenAI row dynamic states:
- **Codex CLI installed + supports vision**: `✓ Connected (Codex CLI · ChatGPT OAuth)` — collapsed; API key field hidden
- **Codex CLI installed but text-only** (current likely state): `✓ Connected (Codex CLI · ChatGPT OAuth)` + an inline note offering API key as a vision fallback
- **No Codex CLI, only API key**: `✓ Connected (API key)` with masked key field
- **Neither**: `⚠ Setup needed` + 2-tab modal (CLI install vs API key entry)

Status icons:
- `✓ ready` — provider available + configured
- `⚠ needs setup` — provider not configured (no key / CLI missing)
- `✗ test failed` — last test returned an error

Each row "Setup help →" opens a small inline modal with the install command (e.g. `npm install -g @google/gemini-cli`) and auth command (`gemini auth login`).

Per-feature dropdowns disable providers that are not `available` and show the reason in a tooltip.

### Step 8 — Frontend: gracefully handle vision/provider mismatch

The Vision dropdown filters out providers where `supportsVision === false` (DeepSeek today; could be more in the future). Those providers still appear in the Auto-Prompt and Planner dropdowns. The "AI Providers" section header notes "DeepSeek is text-only — won't appear in Vision dropdown."

When user sets `Vision = Grok` and the selected Grok model is text-only (Grok-1), surface a warning inline next to the dropdown: "⚠ This provider has no vision support — image briefs will fail." (Pull `supportsVision` from the providers list.) This is a UX guardrail; the backend also enforces it at dispatch time.

### Step 9 — Tests

Backend (~15 new tests):
- `tests/test_llm_secrets.py`: secrets file roundtrip, file mode 600, atomic write, missing-file empty dict
- `tests/test_llm_registry.py`: feature → provider routing, vision-capability enforcement, fallback to default when config empty, error on unavailable provider
- `tests/test_llm_providers.py`: each provider's `is_available()` probe path with mocks
- `tests/test_llm_routes.py`: GET/PUT/POST endpoints, key masking in responses, test endpoint invokes provider correctly
- Existing tests: update mocks from `run_claude` → `run_llm` (mechanical search/replace).

Frontend: type-check only (no test runner currently).

### Step 10 — Documentation

`README.md` add a section "Configuring AI Providers":
- Default = Claude (existing behavior, no change for current users)
- Switching: Settings → AI Providers
- Auth: Claude/Gemini via CLI subscription, OpenAI/Grok via API key
- Where keys are stored (`~/.flowboard/secrets.json`, mode 600, gitignored by virtue of location)
- Cost notes: which providers are free with subscription vs. pay-per-token

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| API key leak via logs | Wrap `httpx` calls in a redacting logger; assert in tests that the key never appears in any captured log line. |
| `secrets.json` world-readable on misconfigured systems | Use `os.chmod(path, 0o600)` after write; `os.umask(0o077)` at agent startup as belt-and-braces. Document in README. |
| Provider API breaking changes | Each provider in its own module; failures in one don't cascade. Pin `httpx` + lock provider SDK versions. |
| Vision-required call routes to text-only provider | Backend `run_llm()` raises `LLMError` immediately if `attachments` present and `provider.supports_vision == False`. Frontend dropdown also flags it. |
| `FLOWBOARD_PLANNER_BACKEND=mock` users break | `planner.py` keeps the mock short-circuit before calling `run_llm`. Add a regression test. |
| Long timeouts on rate-limited OpenAI/Grok | Per-provider configurable timeout (default 90s). Surface clear error to UI with provider name. |
| Provider system prompts perform worse on non-Claude models | All system prompts stay generic-text; we don't tune to Claude internals. Document that Auto-Prompt quality may vary across providers. Add a "Recommended providers" hint per feature in Settings (e.g. "Vision: Gemini cheaper, Claude more accurate"). |
| Large image attachments timeout API providers (5MB+ base64 = 7MB+ wire) | Reject >5MB at provider boundary with a clear error. Flow's image outputs are typically <2MB so this is defensive. |
| Gemini CLI flag for image attachment changes between versions | Detect at provider init: probe `gemini --help` and parse for `--image` vs `--input` vs whatever; cache the resolved flag. Falls back to error with install-version notice if no recognised flag found. |
| Test suite shape changes break CI | Migrate tests in one commit (mechanical), verify 224/224 still pass before any provider work lands. |
| DeepSeek-VL released to public API mid-roadmap and breaks the "text-only" assumption | Vision capability is per-provider, not hardcoded. When DeepSeek-VL becomes available on `api.deepseek.com`, flip `supports_vision = True` in `deepseek.py`, add the base64 attachment branch, and the Vision dropdown picks it up automatically (`supportsVision` flows through to UI via `/api/llm/providers`). One-line change at the provider class plus a small attachment branch — frontend untouched. |
| DeepSeek-reasoner (R1) is much slower than chat for Planner | Document in README. Users who hit timeouts can switch Planner provider in Settings. Optional follow-up: make per-feature model name configurable instead of hardcoded chat/reasoner mapping. |
| Codex CLI vision support unverified at plan time | Provider class probes `codex --help` at init and parses for image-attachment flag. If found, Codex CLI handles vision; if not, OpenAIProvider falls back to API mode for vision dispatches only — text features stay on Codex CLI. Settings UI surfaces this clearly so users know they need an API key as backup *only if* their Codex version is text-only. The capability is detected, not assumed. |
| Codex CLI flag for image attachment changes between versions | Same mitigation as Gemini CLI flag drift — probe `--help` at init, parse for `--image` / `--attach` / `--file`, cache the resolved flag. If no recognised flag, treat as text-only and route vision via API mode. |
| Users without ChatGPT subscription can't use Codex CLI mode | Document clearly in Settings UI: "Codex CLI requires a ChatGPT Plus or Pro account". API key path remains available for users without a subscription. |

## Verification Steps

1. `cd agent && .venv/bin/pytest -q` — all 224 existing tests pass + ~15 new tests pass.
2. Set `~/.flowboard/secrets.json` manually with an OpenAI key, restart agent. `curl /api/llm/providers` returns OpenAI as `{available: true, configured: true}`.
3. In Settings UI, switch Vision to OpenAI. Upload a character image. aiBrief returns within 10s and matches the 200-char factual format.
4. Switch Vision to Grok with no key set → dropdown shows `⚠ needs setup` and disables it.
5. Set Auto-Prompt to Gemini. Click Generate without prompt on an image node. Synth call routes through `gemini` CLI (verify in agent logs: `llm: provider=gemini feature=auto_prompt`).
6. Restart agent; settings persist.
7. Clear OpenAI key in UI → row reverts to "needs setup", row disabled in dropdowns until re-entered.
8. Verify `secrets.json` has mode `-rw-------` (600).
9. **Vision parity** — set Vision provider to each of Claude / Gemini / OpenAI / Grok in turn (DeepSeek excluded — not in dropdown), upload the SAME test image each time. All 4 vision-capable providers should produce a non-empty 80-200 char factual brief. Confirms the hybrid attachment pipeline works for both CLI (`@<path>`, `--image <path>`) and API (base64 data URL) transports.
10. **DeepSeek vision rejection** — manually craft a Vision dispatch with provider=deepseek (e.g. via `curl PUT /api/llm/config` to set vision:deepseek then upload an image). Backend returns `LLMError("DeepSeek doesn't support vision; reconfigure Vision provider")` immediately, never sends a request to deepseek.com.
11. **DeepSeek text path** — set Auto-Prompt = DeepSeek, click Generate without typing a prompt. Synth call routes through DeepSeek (`deepseek-chat`); set Planner = DeepSeek, send a chat message → routes through `deepseek-reasoner`. Both produce expected outputs in same format as Claude.
12. **OpenAI Codex CLI mode** — install `npm install -g @openai/codex`, authenticate via `codex login` (ChatGPT account). Without setting any API key, set Auto-Prompt = OpenAI in Settings. Click Generate → synth routes through Codex CLI subprocess (verify in agent logs: `llm: provider=openai mode=cli feature=auto_prompt`). No API call to api.openai.com observed.
13. **OpenAI Codex CLI vision fallback** — with Codex CLI authenticated but no API key configured, set Vision = OpenAI. Upload an image. If the resolved `_cli_image_flag` is None (text-only Codex CLI), dispatch fails with `LLMError("OpenAI Codex CLI does not support vision in your version. Either upgrade Codex CLI or configure an OpenAI API key in Settings.")`. After adding API key, the same Vision dispatch succeeds via API mode.
14. Reject a 6MB test image — provider returns `LLMError("attachment too large…")` consistently across all vision-capable providers.

## File touch list

**Backend (new):**
- `agent/flowboard/services/llm/__init__.py`
- `agent/flowboard/services/llm/base.py`
- `agent/flowboard/services/llm/claude.py`
- `agent/flowboard/services/llm/gemini.py`
- `agent/flowboard/services/llm/openai.py` — dual-mode (Codex CLI subprocess + httpx API fallback, with capability probe at init)
- `agent/flowboard/services/llm/grok.py`
- `agent/flowboard/services/llm/deepseek.py`
- `agent/flowboard/services/llm/registry.py`
- `agent/flowboard/services/llm/secrets.py`
- `agent/flowboard/routes/llm.py`
- `agent/tests/test_llm_secrets.py`
- `agent/tests/test_llm_registry.py`
- `agent/tests/test_llm_providers.py`
- `agent/tests/test_llm_routes.py`
- `agent/tests/test_llm_deepseek.py` — vision-rejection path + chat/reasoner model selection
- `agent/tests/test_llm_openai_dual_mode.py` — Codex CLI probe with various `--help` outputs, mode selection, vision fallback to API mode when CLI is text-only, error path when neither CLI nor API key present

**Backend (modified):**
- `agent/flowboard/services/claude_cli.py` — thin re-export → deprecate
- `agent/flowboard/services/prompt_synth.py` — switch to `run_llm`
- `agent/flowboard/services/vision.py` — switch to `run_llm`
- `agent/flowboard/services/planner.py` — switch to `run_llm`
- `agent/flowboard/app.py` — mount `/api/llm` router
- `agent/flowboard/config.py` — add `LLM_DEFAULT_PROVIDER` env var
- `agent/pyproject.toml` — add `httpx` (already present) — verify; no new deps needed
- Existing tests in `test_prompt_synth.py`, `test_vision.py`, `test_planner.py` — update mocks

**Frontend (new):**
- `frontend/src/components/AiProvidersSection.tsx` — extract section into its own component (SettingsPanel is already tall)

**Frontend (modified):**
- `frontend/src/components/SettingsPanel.tsx` — mount AiProvidersSection
- `frontend/src/api/client.ts` — add 5 LLM functions + 2 types
- `frontend/src/styles.css` — provider rows, status icons

**Docs:**
- `README.md` — "Configuring AI Providers" section
- `docs/llm-providers.md` (new) — full setup guides for each provider

## Out of scope (follow-ups)

- Cost telemetry (token counters, monthly spend dashboard)
- Automatic fallback chain on provider failure
- Per-call provider override (e.g. "this one Generate uses GPT-5")
- Self-hosted local models (Ollama / LM Studio integration)
- Streaming responses (currently all 3 features are batch / single-shot)
- Encrypted secrets file (only worth it if we ship to multi-user environments)
- Provider quality benchmarks / "recommended for X" UI hints powered by real data
- BYO model — let user enter custom OpenAI-compatible endpoint URL (Ollama, vLLM, custom)

## Effort estimate

| Phase | Days |
|---|---|
| Backend: abstraction + 2 pure CLI providers (Claude, Gemini) | 1 |
| Backend: OpenAI provider (Codex CLI mode + API mode dual implementation, capability probe, mode-switching logic) | 1.25 |
| Backend: 2 API-only providers (Grok, DeepSeek) + secrets + routes | 1 |
| Backend: migrate 3 services + update existing tests | 0.5 |
| Backend: write new tests (incl. DeepSeek vision-rejection, OpenAI dual-mode probe + fallback, Codex CLI image-flag detection) | 1.5 |
| Frontend: API client + Settings UI + status indicators (incl. OpenAI smart row showing CLI vs API mode + optional API-key-as-vision-fallback affordance, DeepSeek "Text only" tag, Vision dropdown filter) | 1.75 |
| Documentation + manual smoke testing | 0.5 |
| **Total** | **~7 days** |

Suggested release: **v1.2.0** (this is feature-complete enough to bump minor version, not patch).
