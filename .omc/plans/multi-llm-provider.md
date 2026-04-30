# Plan — Multi-LLM Provider support (Claude / Gemini / OpenAI / Grok)

## Requirements Summary

Replace the single Claude-CLI dependency with a swappable provider layer so users can pick which LLM powers each Flowboard feature. Provide:
1. **Backend abstraction** with 4 providers (Claude, Gemini, OpenAI, Grok)
2. **Per-feature provider routing** (Auto-Prompt / Vision / Planner can each use a different provider)
3. **Settings UI** for picking providers + entering API keys + testing connections
4. **Secret storage** that survives restart but stays local (no cloud, no PII to backend logs)
5. **Backward-compatible** with existing `FLOWBOARD_PLANNER_BACKEND` env var; default = Claude (current behavior)

## Decisions

| Decision | Default | Rationale |
|---|---|---|
| Provider granularity | **Per-feature** (Auto-Prompt / Vision / Planner each pick) | Vision much cheaper on Gemini; planner JSON extraction more reliable on Claude. One global setting forces a bad compromise. |
| Auth model — Claude / Gemini | **CLI auth** (existing `claude` + new `gemini` CLI subscription) | Matches Flowboard's "no API key, use your existing subscription" philosophy. Both vendors ship official CLIs (Anthropic Claude CLI, Google `gemini-cli` via npm). |
| Auth model — OpenAI / Grok | **API key entry in UI** | Neither vendor has a stable end-user CLI with auth flow. Direct REST API + user-supplied key. |
| Secret storage | **Plain JSON at `~/.flowboard/secrets.json` with file mode 600** | Single-user local app, OS-level file permissions are sufficient. Encryption adds key-management surface area without real benefit. Gitignored by virtue of being outside the repo. |
| API key transport | **Backend-only** — never expose keys to browser | Frontend POSTs the key to `PUT /api/llm/providers/openai` once; never reads it back. Status endpoint returns only `{configured: true}`. |
| Per-feature config storage | **Same secrets.json** under separate top-level key (`activeProviders`) | One file, one source of truth. Hot-reloads on every dispatch (no caching pitfalls). |
| Vision routing | **Auto-route to vision-capable provider** if user picked a text-only one | Don't fail silently if user sets Vision = Grok-1 (no vision). Resolve to nearest capable + log a warning. Out of scope until Grok-1: all 4 currently planned providers have vision. |
| Vision attachment transport | **Hybrid — caller passes file path; provider converts internally** | CLI providers (Claude, Gemini) attach via their native flag (`@<path>` / `--image <path>`) — preserves the "no API key, use subscription" benefit. API providers (OpenAI, Grok) read bytes → base64 → inline data URL in request body. Unified caller contract: `attachments: list[str]` of file paths. Forces every provider to support the SAME caller signature without leaking transport details upstream. Alternative considered: force base64 for everyone — rejected because it would require API keys for Claude/Gemini and lose the existing-subscription benefit. |
| Backward compat | **`FLOWBOARD_PLANNER_BACKEND=mock\|cli\|auto`** still respected; new env vars overlay it | Existing dev setups don't break. New env var: `FLOWBOARD_LLM_DEFAULT_PROVIDER=claude` for headless deployments. |
| Cost telemetry | **Out of scope** for v1 | Counters per provider, monthly spend tracking — nice-to-have but not blocking. |
| Fallback chain | **Out of scope** for v1 | "Primary fails → switch to next" complexity not justified yet. Keep error surfaces clean; let the user decide. |

## Acceptance Criteria

1. Settings panel has a new **AI Providers** section with three per-feature dropdowns: Auto-Prompt / Vision / Planner. Each dropdown lists Claude, Gemini, OpenAI, Grok with a status icon (`✓ ready`, `⚠ no key`, `✗ unavailable`).
2. **Claude / Gemini** rows show `✓ ready` only when their CLI is installed and authenticated. Click "Setup →" → opens a help dialog with `npm install -g …` + auth command.
3. **OpenAI / Grok** rows show an input field for API key + a **Test** button. Test calls a tiny prompt and reports success/failure within 10s. Key is masked after save (`sk-…••••`).
4. Generating an image with **Auto-Prompt = Gemini** routes the synth call through Gemini CLI, not Claude. Verifiable by inspecting agent logs (`llm: provider=gemini feature=auto_prompt`).
5. Uploading an image with **Vision = OpenAI** routes the describe call through OpenAI's vision endpoint. The aiBrief returned matches the same 200-char factual format as Claude.
6. Provider config persists across agent restart — user picks Gemini, restarts agent, still on Gemini.
7. API keys never appear in agent logs (filter at logger level), in HTTP responses (only `{configured: true}` returned), or in browser localStorage.
8. Removing an API key (clear field + Save) sets the row back to `⚠ no key` and disables that provider in dropdowns until re-entered.
9. If user picks a provider that's currently unavailable (CLI missing, no key) and dispatches, request fails with a clear error message naming the missing provider — NOT a silent fallback.
10. All 30+ existing tests still pass after migration. No backend test should reach a real provider — the abstraction is mockable.
11. New unit tests cover: provider registry routing, secret-file roundtrip, per-feature dispatch, vision-capability check.

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
#   "apiKeys": {"openai": "sk-...", "grok": "xai-..."},
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

### Step 3 — Backend: 4 provider implementations

**Vision attachment strategy** — caller signature is identical across all 4 providers (`attachments: list[str]` of file paths). Each provider converts internally based on its transport:

| Provider | Transport | Attachment handling |
|---|---|---|
| Claude | CLI subprocess | Pass `@<absolute_path>` arg + `--add-dir <parent> --permission-mode bypassPermissions` (existing pattern) |
| Gemini | CLI subprocess | Pass `--image <absolute_path>` per attachment (verify exact flag via `gemini --help`) |
| OpenAI | REST API (httpx) | Read file bytes → `base64.b64encode` → embed as data URL in `messages[].content[].image_url.url`. Mime type detected via `mimetypes.guess_type(path)`. |
| Grok | REST API (httpx) | Same base64 data-URL pattern as OpenAI (xAI uses OpenAI-compatible message schema) |

**File-size guard** — provider modules reject attachments >5MB before sending (each provider has a different max but 5MB is comfortably under all of them; Flow image outputs are typically <2MB so non-issue in practice). Surfaced as `LLMError("attachment too large for {provider}: {size}MB > 5MB cap")`.

**Why hybrid not "base64 everywhere"** — pushing every provider through API + base64 would force API keys for Claude/Gemini, losing the existing-subscription benefit (matches Flowboard's local-only / no-key philosophy). The caller code stays clean either way; only the provider implementation differs.

---

**`claude.py`**: copy logic from current `claude_cli.py`, conform to LLMProvider protocol. Keep current `@<path>` attachment handling. `supports_vision = True` (Haiku 4.5 / Sonnet / Opus all have vision).

**`gemini.py`**: subprocess `gemini -p <prompt> --json` (verify exact CLI flags via `gemini --help`). Vision attachments via `--image <path>` per file. Same `--version` probe pattern as Claude. `supports_vision = True` (Gemini Flash / Pro both have vision).

**`openai.py`**: httpx async client. `POST https://api.openai.com/v1/chat/completions`. Default model: `gpt-5` for text, auto-bump to `gpt-4o` (or whichever vision-capable variant is current) when `attachments` is non-empty. Vision payload shape:
```python
content = [{"type": "text", "text": prompt}]
for path in attachments:
    b64 = base64.b64encode(Path(path).read_bytes()).decode()
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
```
JSON mode for planner: `response_format={"type":"json_object"}`. `supports_vision = True`.

**`grok.py`**: httpx client. `POST https://api.x.ai/v1/chat/completions` (xAI's OpenAI-compatible endpoint). Default model: `grok-4`; auto-bump to `grok-2-vision-1212` when `attachments` is non-empty. Same base64 data-URL message shape as OpenAI. `supports_vision = True`.

Each provider's `is_available()`:
- Claude / Gemini: probe CLI binary with `--version` (5s timeout, cached)
- OpenAI / Grok: check `secrets.get_api_key(name)` is set + ping `/v1/models` with that key (cached 60s)

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
  name: "claude" | "gemini" | "openai" | "grok";
  supportsVision: boolean;
  available: boolean;        // CLI installed / key set
  configured: boolean;       // explicitly configured (key entered or CLI auth done)
  requiresKey: boolean;      // false for claude/gemini, true for openai/grok
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

API Keys
─ Claude   ✓ Connected (CLI)        [Setup help →]
─ Gemini   ⚠ CLI not found          [Setup help →]
─ OpenAI   [sk-•••••••••••] [Test]  [Save]
─ Grok     [_____________] [Test]   [Save]
```

Status icons:
- `✓ ready` — provider available + configured
- `⚠ needs setup` — provider not configured (no key / CLI missing)
- `✗ test failed` — last test returned an error

Each row "Setup help →" opens a small inline modal with the install command (e.g. `npm install -g @google/gemini-cli`) and auth command (`gemini auth login`).

Per-feature dropdowns disable providers that are not `available` and show the reason in a tooltip.

### Step 8 — Frontend: gracefully handle vision/provider mismatch

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

## Verification Steps

1. `cd agent && .venv/bin/pytest -q` — all 224 existing tests pass + ~15 new tests pass.
2. Set `~/.flowboard/secrets.json` manually with an OpenAI key, restart agent. `curl /api/llm/providers` returns OpenAI as `{available: true, configured: true}`.
3. In Settings UI, switch Vision to OpenAI. Upload a character image. aiBrief returns within 10s and matches the 200-char factual format.
4. Switch Vision to Grok with no key set → dropdown shows `⚠ needs setup` and disables it.
5. Set Auto-Prompt to Gemini. Click Generate without prompt on an image node. Synth call routes through `gemini` CLI (verify in agent logs: `llm: provider=gemini feature=auto_prompt`).
6. Restart agent; settings persist.
7. Clear OpenAI key in UI → row reverts to "needs setup", row disabled in dropdowns until re-entered.
8. Verify `secrets.json` has mode `-rw-------` (600).
9. **Vision parity** — set Vision provider to each of Claude / Gemini / OpenAI / Grok in turn, upload the SAME test image each time. All 4 should produce a non-empty 80-200 char factual brief. Confirms the hybrid attachment pipeline works for both CLI (`@<path>`, `--image <path>`) and API (base64 data URL) transports.
10. Reject a 6MB test image — provider returns `LLMError("attachment too large…")` consistently across all 4 providers.

## File touch list

**Backend (new):**
- `agent/flowboard/services/llm/__init__.py`
- `agent/flowboard/services/llm/base.py`
- `agent/flowboard/services/llm/claude.py`
- `agent/flowboard/services/llm/gemini.py`
- `agent/flowboard/services/llm/openai.py`
- `agent/flowboard/services/llm/grok.py`
- `agent/flowboard/services/llm/registry.py`
- `agent/flowboard/services/llm/secrets.py`
- `agent/flowboard/routes/llm.py`
- `agent/tests/test_llm_secrets.py`
- `agent/tests/test_llm_registry.py`
- `agent/tests/test_llm_providers.py`
- `agent/tests/test_llm_routes.py`

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
| Backend: abstraction + 2 CLI providers (Claude, Gemini) | 1 |
| Backend: 2 API providers (OpenAI, Grok) + secrets + routes | 1.5 |
| Backend: migrate 3 services + update existing tests | 0.5 |
| Backend: write new tests | 1 |
| Frontend: API client + Settings UI + status indicators | 1.5 |
| Documentation + manual smoke testing | 0.5 |
| **Total** | **~6 days** |

Suggested release: **v1.2.0** (this is feature-complete enough to bump minor version, not patch).
