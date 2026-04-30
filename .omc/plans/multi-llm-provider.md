# Plan — Multi-LLM Provider via 9Router

## Requirements Summary

Replace the single Claude-CLI dependency with a swappable provider layer where users can pick which LLM powers each Flowboard feature. Architecture:

- **Default**: keep `claude` CLI direct (zero setup, works out-of-the-box, free with user's existing Claude subscription).
- **Optional**: integrate **9Router** (https://github.com/decolua/9router) — a local OpenAI-compatible proxy that exposes 40+ providers and 100+ models behind a single endpoint. User installs `9router` separately (`npm install -g 9router`), authenticates each provider in 9Router's own dashboard, then picks any of those models inside Flowboard's Settings panel.

Net effect: Flowboard only ships **2 provider classes** (Claude CLI + 9Router) but unlocks 100+ models for power users — Gemini Flash, GPT-5, Grok, Kiro Free Claude 4.5, GLM, MiniMax, DeepSeek, Llama, etc.

## Why 9Router and not 4 separate vendor integrations

| Concern | 4-vendor self-built (rejected) | 9Router (chosen) |
|---|---|---|
| Provider classes to write | 4 (Claude / Gemini / OpenAI / Grok) | **2** (Claude CLI + 9Router HTTP client) |
| API keys Flowboard manages | 4 input fields + storage + masking | **0** — keys live in 9Router's dashboard, Flowboard only stores 1 endpoint key |
| Model coverage | 4 vendors | **100+ models, 40+ providers** |
| Built-in fallback chain | Out of scope (extra effort) | **Native** — 9Router "combos" are themselves selectable as a single model name |
| Subscription benefit (no API key) | Only Claude / Gemini CLI | **Claude Code, Codex, Cursor, GitHub Copilot OAuth all routable through 9Router**, plus FREE providers (Kiro unlimited Claude 4.5, OpenCode Free, Vertex $300 credits) |
| Token-saving | None | **RTK compresses tool_result by 20-40%** automatically |
| Vision support | Per-vendor ad-hoc | OpenAI-compat schema everywhere; vision via base64 data URL works on Gemini Flash / GPT-4o / Claude Haiku / Grok-2 Vision uniformly |
| Effort estimate | ~6 days | **~2-3 days** |
| Privacy | OK | OK — 9Router is local proxy (not cloud middleman like OpenRouter) |

## Decisions

| Decision | Default | Rationale |
|---|---|---|
| Default provider | **Claude CLI direct** (existing behavior) | Zero setup for new users; existing CLI subscription stays free. Switching to 9Router is opt-in. |
| 9Router endpoint | `http://localhost:20128/v1` (configurable) | 9Router's documented default. Configurable in Settings for users running it on a VPS / different port. |
| Model selection granularity | **Per-feature** (Auto-Prompt / Vision / Planner each pick a model) | Vision much cheaper on Gemini Flash; planner JSON extraction more reliable on Claude. One global model is a bad compromise. |
| Model list source | **`GET {endpoint}/v1/models`** at Settings panel open + after API-key change | 9Router exposes its full catalog (including user's custom combos) here. Caching: in-memory 5 min, refreshes on Settings open. |
| Per-feature config storage | `~/.flowboard/secrets.json` mode 600 | Single source of truth for both endpoint URL, 9Router key, and feature → model mapping. |
| API key transport | **Backend-only** — never exposed to browser | Frontend POSTs key once via `PUT /api/llm/9router`; status endpoint returns only `{configured: true}`. |
| Vision routing | **Auto-block at backend** if user picked a non-vision model | Backend `run_llm()` checks `model_capabilities` map (auto-bumps from `gpt-5` → `gpt-4o` style behavior is delegated to 9Router; we just pass the user's choice and surface 9Router's error if it complains). |
| Vision attachment transport | Hybrid by provider | Claude CLI: `@<path>`. 9Router: read bytes → base64 → data URL in `messages[].content[].image_url.url` (OpenAI-compat schema 9Router accepts). Caller passes file path; provider converts internally. |
| Backward compat | `FLOWBOARD_PLANNER_BACKEND=mock\|cli\|auto` still respected | Existing dev setups don't break. New env var: `FLOWBOARD_LLM_DEFAULT_PROVIDER=claude\|9router`. |
| Cost telemetry | **Out of scope** for v1 | 9Router has its own dashboard at `localhost:20128/dashboard` for spend tracking. Flowboard doesn't need to duplicate. |
| Custom OpenAI-compatible endpoints | **Out of scope** for v1 | Architecture supports it (the 9Router provider class is essentially a generic OpenAI-compat client), but UI surface limited to 9Router for now. Easy follow-up. |

## Acceptance Criteria

1. Settings panel has a new **AI Providers** section with a single radio choice: **Claude CLI** (default) | **9Router**.
2. With **Claude CLI** selected, Flowboard works exactly as today — no setup, no API key, no model picker. Existing tests pass unchanged.
3. With **9Router** selected, three new fields appear:
   - **Endpoint URL** (default `http://localhost:20128/v1`)
   - **API Key** (masked after save: `sk-9r-•••••••••`)
   - Per-feature model dropdowns (Auto-Prompt / Vision / Planner) populated from `GET {endpoint}/v1/models`
4. **Test connection** button hits `GET {endpoint}/v1/models` with the saved key. Reports success + count of models, or 4xx/5xx with the actual error message from 9Router.
5. After config saved, generating an image with **Auto-Prompt = `gemini/gemini-2.5-flash`** routes the synth call through 9Router → Gemini, not Claude. Verifiable via agent logs (`llm: provider=9router model=gemini/gemini-2.5-flash feature=auto_prompt`).
6. Uploading an image with **Vision = `kr/claude-sonnet-4.5`** (Kiro Free) routes through 9Router and returns aiBrief in the same 200-char format as the Claude CLI path.
7. Provider config persists across agent restart.
8. API key never appears in agent logs or HTTP responses (only `{configured: true}` returned by GET endpoint).
9. If 9Router is selected but `localhost:20128` is unreachable, dispatch fails immediately with `LLMError("9Router unreachable at http://localhost:20128/v1 — is `9router` running?")` — NOT a silent fallback to Claude.
10. All 30+ existing tests still pass after migration. New tests cover: 9Router model list fetch + cache, OpenAI-compat request shape, base64 vision attachment, error mapping (timeout / 401 / 5xx → `LLMError` with provider-named message).
11. README.md gets a new section "Configuring AI Providers" with the 9Router quickstart (`npm install -g 9router && 9router`) and a one-line note that Flowboard uses Claude CLI by default.

## Implementation Steps

### Step 1 — Backend: provider abstraction package

New package `agent/flowboard/services/llm/`:

```
llm/
  __init__.py        # Re-exports run_llm + LLMProvider
  base.py            # LLMProvider Protocol + LLMError
  claude.py          # Wraps existing claude_cli.py logic — cleanly conforms to protocol
  router9.py         # NEW — 9Router HTTP client (OpenAI-compat)
  registry.py        # Pick provider based on settings; route per feature
  secrets.py         # Read/write ~/.flowboard/secrets.json (mode 600, atomic write)
```

`base.py`:
```python
class LLMError(RuntimeError):
    pass

class LLMProvider(Protocol):
    name: str

    async def is_available(self) -> bool: ...

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: str | None = None,
        attachments: list[str] | None = None,
        timeout: float = 90.0,
        # Provider-specific routing — None means "use whatever the
        # provider considers default for this feature"
        model: str | None = None,
    ) -> str: ...
```

`registry.py`:
```python
async def run_llm(
    feature: Literal["auto_prompt", "vision", "planner"],
    user_prompt: str,
    **kwargs,
) -> str:
    cfg = secrets.read()
    provider_name = cfg.get("activeProvider", "claude")
    provider = _PROVIDERS[provider_name]
    if provider_name == "9router":
        # Pull per-feature model from settings; pass through to provider
        kwargs["model"] = cfg.get("featureModels", {}).get(feature)
    if not await provider.is_available():
        raise LLMError(f"{provider_name} is not available — check Settings → AI Providers")
    return await provider.run(user_prompt, **kwargs)
```

### Step 2 — Backend: 9Router provider implementation

`agent/flowboard/services/llm/router9.py`:

```python
import base64
import mimetypes
from pathlib import Path
import httpx

DEFAULT_ENDPOINT = "http://localhost:20128/v1"
DEFAULT_TIMEOUT = 90.0
MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024  # 5MB cap

class Router9Provider:
    name = "9router"

    def __init__(self, endpoint: str, api_key: str):
        self._endpoint = endpoint.rstrip("/")
        self._api_key = api_key
        self._models_cache: tuple[float, list[str]] | None = None
        self._models_cache_ttl = 300.0  # 5 min

    async def is_available(self) -> bool:
        # Cheap probe: GET /v1/models with auth. Cache result for 60s.
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(
                    f"{self._endpoint}/models",
                    headers={"Authorization": f"Bearer {self._api_key}"},
                )
                return r.status_code == 200
        except Exception:
            return False

    async def list_models(self) -> list[str]:
        # Cached; refreshed every 5 min or when cache miss.
        now = time.monotonic()
        if self._models_cache and now - self._models_cache[0] < self._models_cache_ttl:
            return self._models_cache[1]
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{self._endpoint}/models",
                headers={"Authorization": f"Bearer {self._api_key}"},
            )
            r.raise_for_status()
            data = r.json()
            ids = [m["id"] for m in data.get("data", []) if isinstance(m, dict) and m.get("id")]
        self._models_cache = (now, ids)
        return ids

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: str | None = None,
        attachments: list[str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        model: str | None = None,
    ) -> str:
        if not model:
            raise LLMError("9Router requires a model name (set in Settings → AI Providers)")

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        if attachments:
            # Vision request — embed each attachment as base64 data URL
            content = [{"type": "text", "text": user_prompt}]
            for path in attachments:
                p = Path(path)
                size = p.stat().st_size
                if size > MAX_ATTACHMENT_BYTES:
                    raise LLMError(f"attachment too large for 9Router: {size}B > {MAX_ATTACHMENT_BYTES}B cap")
                b64 = base64.b64encode(p.read_bytes()).decode()
                mime = mimetypes.guess_type(str(p))[0] or "image/jpeg"
                content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}"},
                })
            messages.append({"role": "user", "content": content})
        else:
            messages.append({"role": "user", "content": user_prompt})

        payload = {"model": model, "messages": messages}

        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                r = await client.post(
                    f"{self._endpoint}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
            except httpx.TimeoutException as e:
                raise LLMError(f"9Router timeout after {timeout}s") from e
            except httpx.RequestError as e:
                raise LLMError(f"9Router unreachable at {self._endpoint} — is `9router` running? ({e})") from e

        if r.status_code != 200:
            # Surface 9Router's own error message verbatim — it's already user-readable.
            try:
                err = r.json()
                msg = err.get("error", {}).get("message") or err.get("message") or r.text
            except Exception:
                msg = r.text
            raise LLMError(f"9Router {r.status_code}: {msg}")

        data = r.json()
        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"9Router returned unexpected response shape: {data}") from e
```

### Step 3 — Backend: Claude CLI provider (refactor existing)

`agent/flowboard/services/llm/claude.py` — extract logic from `claude_cli.py`, conform to LLMProvider protocol. No behavior change. The `model` argument is ignored (Claude CLI uses its own default).

`claude_cli.py` becomes a thin re-export of `claude.ClaudeProvider().run` for backward compat. Mark with deprecation note in docstring; remove in v1.3.

### Step 4 — Backend: secret storage

`agent/flowboard/services/llm/secrets.py`:

```python
# Schema:
# {
#   "activeProvider": "claude" | "9router",
#   "router9": {
#     "endpoint": "http://localhost:20128/v1",
#     "apiKey": "sk-9r-..."
#   },
#   "featureModels": {
#     "auto_prompt": "anthropic/claude-haiku-4.5",
#     "vision": "google/gemini-2.5-flash",
#     "planner": "anthropic/claude-sonnet-4.5"
#   }
# }
```

API:
```python
def read() -> dict
def write(payload: dict) -> None  # atomic, mode 600
def set_active_provider(name: str) -> None
def set_router9_config(endpoint: str, api_key: str | None) -> None
def set_feature_model(feature: str, model: str) -> None
```

`os.umask(0o077)` at agent startup (in `app.py`'s lifespan) as belt-and-braces.

### Step 5 — Backend: HTTP routes for provider config

`agent/flowboard/routes/llm.py`:

```
GET  /api/llm/config
  → {
      activeProvider: "claude" | "9router",
      router9: {endpoint: "...", configured: bool},  // apiKey NEVER returned
      featureModels: {auto_prompt: "...", vision: "...", planner: "..."}
    }

PUT  /api/llm/config
  body: {activeProvider?: "...", router9?: {endpoint?, apiKey? | null}, featureModels?: {...}}
  → {ok: true}

GET  /api/llm/9router/models
  → {models: ["anthropic/claude-haiku-4.5", "google/gemini-2.5-flash", ...]}
  // Proxies GET 9router-endpoint/v1/models with the configured key.

POST /api/llm/9router/test
  → {ok: true, modelCount: 47, latencyMs: 234} | {ok: false, error: "..."}
```

Mount in `flowboard/app.py`. Reject the request if user toggles activeProvider to "9router" without a configured key/endpoint (return 400 with helpful message).

### Step 6 — Migrate existing services

Three small refactors:
- `prompt_synth.py`: `from .claude_cli import run_claude` → `from .llm import run_llm`; replace each call site with `await run_llm("auto_prompt", prompt, system_prompt=...)`. ~6 call sites.
- `vision.py`: same pattern; route as `"vision"`.
- `planner.py`: same; route as `"planner"`. Keep the `FLOWBOARD_PLANNER_BACKEND=mock` short-circuit.

Existing 30+ tests mocking `run_claude` get a mechanical search/replace to mock `run_llm` instead. New tests added in Step 8.

### Step 7 — Frontend: API client

`frontend/src/api/client.ts` — add:
```ts
export interface LLMConfig {
  activeProvider: "claude" | "9router";
  router9: {endpoint: string; configured: boolean};
  featureModels: {auto_prompt: string; vision: string; planner: string};
}

getLlmConfig(): Promise<LLMConfig>;
setLlmConfig(partial: Partial<LLMConfig>): Promise<{ok: boolean}>;
listRouter9Models(): Promise<{models: string[]}>;
testRouter9(): Promise<{ok: boolean; modelCount?: number; latencyMs?: number; error?: string}>;
```

### Step 8 — Frontend: Settings AI Providers section

New file `frontend/src/components/AiProvidersSection.tsx`. Mounted in `SettingsPanel.tsx` between "Video model" and "Image model".

UI sketch:

```
═══ AI Providers ═══

○ Claude CLI       (default — uses your existing Claude subscription)
● 9Router          (route to 100+ models — requires `npm install -g 9router`)

[Setup guide ↗]   ← collapsible inline help

  Endpoint URL: [http://localhost:20128/v1                ]
  API Key:      [sk-9r-•••••••••••••••••]  [Test] [Save]

  ✓ Connected · 47 models available

  Per-feature model
  ─ Auto-Prompt: [anthropic/claude-haiku-4.5     ▼]
  ─ Vision:      [google/gemini-2.5-flash         ▼]
  ─ Planner:     [anthropic/claude-sonnet-4.5    ▼]
```

Behavior:
- Switching radio to 9Router with no key configured → expanded form, "Save" disabled until both endpoint + key entered
- Test button: shows latency + model count on success; shows full error message from 9Router on failure
- Per-feature dropdowns disabled until Test passes
- Model list fetched on Test success and on Settings panel open (if 9Router selected)
- Model dropdown is searchable (100+ models — `<datalist>` + filter input)

Setup guide modal contents:
```
1. Install 9Router globally:
   npm install -g 9router
2. Start it:
   9router
3. Open the dashboard at http://localhost:20128/dashboard
4. Connect at least one provider (Kiro AI is FREE and unlimited)
5. Copy the API key from the dashboard
6. Paste it here, click Test, then pick models per feature
```

### Step 9 — Tests

Backend (~12 new tests):
- `tests/test_llm_secrets.py`: secrets file roundtrip, file mode 600, atomic write, missing-file empty dict
- `tests/test_llm_registry.py`: claude/9router routing, error on unavailable provider, env var override
- `tests/test_llm_router9.py`: model list fetch + cache, OpenAI-compat request shape (text + vision), error mapping (timeout / 401 / 500 → LLMError), file-size guard
- `tests/test_llm_routes.py`: GET/PUT/POST endpoints, key masking in responses, test endpoint behavior
- Existing tests in `test_prompt_synth.py`, `test_vision.py`, `test_planner.py` — update mocks from `run_claude` → `run_llm`

Frontend: type-check only (no test runner currently).

### Step 10 — Documentation

`README.md` — new section "Configuring AI Providers":
- Default = Claude CLI (no setup, existing behavior)
- Optional: 9Router for 100+ models
  - Quickstart: `npm install -g 9router && 9router` → open `http://localhost:20128/dashboard`
  - Connect a provider (Kiro Free / Vertex Free / paid API / OAuth subscription)
  - Copy 9Router API key into Flowboard Settings → AI Providers
  - Pick a model per feature
- Where keys live: `~/.flowboard/secrets.json` (mode 600, gitignored by location)

`docs/llm-providers.md` (new) — deeper guide:
- Full 9Router setup walkthrough with screenshots
- Model recommendations per feature (e.g. "Vision: try `google/gemini-2.5-flash` for cheapest, `anthropic/claude-haiku-4.5` for best quality")
- Troubleshooting (9Router not reachable, model not in list, etc.)
- How to use 9Router custom combos as a model name (named fallback chains)

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| API key leak via logs | Wrap `httpx` calls in a redacting logger; assert in tests that the key never appears in any captured log line. |
| `secrets.json` world-readable on misconfigured systems | `os.chmod(path, 0o600)` after write; `os.umask(0o077)` at agent startup. Document in README. |
| 9Router endpoint changes between versions (path or auth header) | Version-pin tested setup in docs (`9router@3.x`). Probe endpoint shape on first connect, surface clear error if shape mismatches. |
| Model name format changes (e.g. `anthropic/claude-haiku` → `claude-haiku@anthropic`) | We don't parse model names — pass them through verbatim. Whatever 9Router lists in `/v1/models` is what user picks. |
| 9Router not running when user has it as active provider | `is_available()` fails fast (5s timeout). Dispatch raises `LLMError` immediately with helpful message ("is `9router` running?"). User can flip back to Claude CLI in Settings without restarting agent. |
| Large image attachments (5MB+) cause timeout on 9Router or downstream provider | Reject >5MB at `Router9Provider` boundary with a clear error. Flow's image outputs typically <2MB so non-issue in practice. |
| Vision-required call routes to non-vision model | Backend doesn't validate; passes model name through. 9Router (or downstream provider) will return an error. We surface that error verbatim — user updates Settings. Future improvement: cache model capabilities per provider. |
| Provider system prompts perform worse on non-Claude models | All system prompts stay generic-text; we don't tune to Claude internals. Document in README that quality varies. Add "Recommended models" hint per feature in Settings (e.g. "Vision: `gemini/gemini-2.5-flash` is cheapest"). |
| 9Router itself is a young project (3.4k stars but evolving fast) | Not a Flowboard concern — if 9Router has issues, users still have the Claude CLI default. Add a clear fallback path in docs. |
| Test suite shape changes break CI | Migrate tests in one commit (mechanical), verify 224/224 still pass before any provider work lands. |

## Verification Steps

1. `cd agent && .venv/bin/pytest -q` — all 224 existing tests pass + ~12 new tests pass.
2. Without 9Router installed: Settings shows "Claude CLI (default)" selected; everything works as today.
3. Install 9Router (`npm install -g 9router && 9router`), connect Kiro Free (no signup) in 9Router dashboard, copy API key. In Flowboard Settings: switch to 9Router, paste endpoint + key, click Test → "✓ Connected · N models". Pick `kr/claude-sonnet-4.5` for all 3 features. Save.
4. Generate an image without typing a prompt → auto-synth call routes through 9Router → Kiro free Claude. Verify in agent logs.
5. Upload an image → vision describe routes through 9Router → returns brief.
6. Open chat → planner routes through 9Router.
7. Restart agent — settings persist.
8. Stop 9Router process → next dispatch fails fast with clear error message.
9. Switch model for Vision to `google/gemini-2.5-flash` → re-upload image → describe runs through Gemini Flash, brief returned in 200-char format.
10. Test connection with wrong API key → returns 401 error message from 9Router verbatim, no silent fallback.
11. Verify `secrets.json` has mode `-rw-------` (600). Verify API key not in any HTTP response (only `{configured: true}` exposed).

## File touch list

**Backend (new):**
- `agent/flowboard/services/llm/__init__.py`
- `agent/flowboard/services/llm/base.py`
- `agent/flowboard/services/llm/claude.py`        ← refactored from claude_cli.py
- `agent/flowboard/services/llm/router9.py`
- `agent/flowboard/services/llm/registry.py`
- `agent/flowboard/services/llm/secrets.py`
- `agent/flowboard/routes/llm.py`
- `agent/tests/test_llm_secrets.py`
- `agent/tests/test_llm_registry.py`
- `agent/tests/test_llm_router9.py`
- `agent/tests/test_llm_routes.py`

**Backend (modified):**
- `agent/flowboard/services/claude_cli.py` — thin deprecation re-export
- `agent/flowboard/services/prompt_synth.py` — switch to `run_llm`
- `agent/flowboard/services/vision.py` — switch to `run_llm`
- `agent/flowboard/services/planner.py` — switch to `run_llm`
- `agent/flowboard/app.py` — mount `/api/llm` router; `os.umask(0o077)` in lifespan
- `agent/flowboard/config.py` — add `LLM_DEFAULT_PROVIDER` env var
- Existing tests in `test_prompt_synth.py`, `test_vision.py`, `test_planner.py` — update mocks

**Frontend (new):**
- `frontend/src/components/AiProvidersSection.tsx`

**Frontend (modified):**
- `frontend/src/components/SettingsPanel.tsx` — mount AiProvidersSection
- `frontend/src/api/client.ts` — add 4 LLM functions + 1 type
- `frontend/src/styles.css` — provider section styles

**Docs:**
- `README.md` — "Configuring AI Providers" section
- `docs/llm-providers.md` (new) — full 9Router setup guide

## Out of scope (follow-ups)

- Custom OpenAI-compatible endpoints (Ollama / vLLM / LiteLLM / OpenRouter direct) — architecture supports it; UI surface limited to 9Router for v1
- Per-call provider override (`this one Generate uses Claude even though default is 9Router`)
- Cost telemetry inside Flowboard (9Router's own dashboard already covers this)
- Streaming responses
- Encrypted secrets file (overkill for single-user local app)
- Auto-fetch 9Router model list on dispatch (cache once at Settings open is enough)
- Provider quality benchmarks / "recommended for X" UI hints powered by real data

## Effort estimate

| Phase | Days |
|---|---|
| Backend: provider abstraction + Claude refactor (no behavior change) | 0.5 |
| Backend: 9Router provider implementation + secrets + routes | 1 |
| Backend: migrate 3 services + update existing tests | 0.5 |
| Backend: write new tests | 0.5 |
| Frontend: API client + Settings UI + setup guide modal | 1 |
| Documentation + manual smoke testing with real 9Router | 0.5 |
| **Total** | **~4 days** |

Suggested release: **v1.2.0** (minor bump given the user-visible change).

## Comparison vs the dropped 4-vendor plan

The earlier draft (4 separate provider classes for Claude / Gemini / OpenAI / Grok) is preserved in git history at `c7c1647` for reference. Switching to 9Router cuts effort roughly in half (6d → 4d), provides 25× more model coverage (4 → 100+), and removes the API-key management surface area from Flowboard entirely (4 keys → 1 key, all vendor auth handled in 9Router's dashboard).

Net trade: Flowboard adds an external dependency (`9router`) for power users who want anything beyond Claude. The default UX (Claude CLI) is untouched.
