# Plan — Multi-LLM Provider support (Claude / Gemini / OpenAI / Grok)

> **Status: ACTIVE** — chosen path for v1.2.0. Replaces the 9Router-proxy
> alternative (`.omc/plans/multi-llm-provider.md`) which is preserved as
> reference. The "legacy" suffix in this filename is historical (originally
> drafted as the alternative) — kept for git history continuity.
>
> **Scope shift vs prior draft (2026-04-30)**: DeepSeek dropped — no end-user
> CLI exists, doesn't fit the "use your existing subscription" philosophy.
> Down to 4 providers from 5. UI specification massively expanded so the
> implementation is unambiguous.
>
> Last updated: 2026-04-30 (DeepSeek removal + full UI spec).

---

## Why this approach

Match Flowboard's **"no API key, use your existing subscription"** philosophy by
integrating each vendor's official CLI directly. Three of the four providers
ship CLIs with OAuth flows that authenticate against the user's existing
subscription:

| Provider | Auth | Cost to user |
|---|---|---|
| **Claude** | `@anthropic-ai/claude-code` CLI · OAuth | Free with Claude subscription (existing dependency) |
| **Gemini** | `@google/gemini-cli` CLI · OAuth | Free with Gemini subscription |
| **OpenAI** | `@openai/codex` CLI · OAuth (preferred) **or** API key (fallback) | Free with ChatGPT Plus/Pro **or** pay-per-token |
| **Grok** | API key only (xAI hasn't shipped a CLI) | Pay-per-token |

DeepSeek deliberately excluded — no end-user CLI, doesn't match the
philosophy. Power users who want DeepSeek can route through 9Router (the
preserved alternative plan).

## Requirements Summary

Replace the single Claude-CLI dependency with a swappable provider layer so
users can pick which LLM powers each Flowboard feature. Provide:

1. **Backend abstraction** with 4 providers (Claude, Gemini, OpenAI, Grok).
2. **Per-feature provider routing** — Auto-Prompt / Vision / Planner each
   pick a provider independently.
3. **Settings UI** for per-feature routing + provider connection state +
   setup guides for CLI-based providers + API key entry for Grok (and
   optional OpenAI fallback) + Test buttons.
4. **Secret storage** that survives restart but stays local — no cloud, no
   PII to backend logs.
5. **Backward-compatible** with existing `FLOWBOARD_PLANNER_BACKEND` env var.
   Default = Claude (current behavior; existing users see no change).
6. **Vision-capability enforcement** — backend rejects when a non-vision
   provider is set as Vision; UI dropdown disables them. (All 4 currently
   support vision; the gate is future-proofing for adding text-only
   providers later.)

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Provider granularity | **Per-feature** (Auto-Prompt / Vision / Planner each pick) | Vision much cheaper on Gemini Flash; planner JSON extraction more reliable on Claude. One global setting forces a bad compromise. |
| Auth — Claude / Gemini | **CLI subscription** (existing `claude` + new `gemini` CLI) | Matches Flowboard's no-API-key philosophy. Both vendors ship official CLIs. |
| Auth — OpenAI | **Tier 1: Codex CLI (OAuth with ChatGPT Plus/Pro)** · **Tier 2: API key fallback** | OpenAI's `@openai/codex` CLI authenticates against ChatGPT subscription. Same subscription benefit as Claude/Gemini. CLI is preferred when `codex` is detected + authenticated; API key is the documented fallback for users without ChatGPT Plus or when the user's Codex version doesn't support vision. The `OpenAIProvider` class probes at init and selects the mode automatically. |
| Auth — Grok | **API key entry in UI** | xAI hasn't shipped an end-user CLI. Direct REST API + user-supplied key. xAI is OpenAI-compatible (`https://api.x.ai/v1`) so the same `httpx` client shape works. |
| Secret storage | **Plain JSON at `~/.flowboard/secrets.json` mode 600** | Single-user local app. OS-level file permissions sufficient. Encryption adds key-management surface area without real benefit. Outside repo — no risk of accidental commit. |
| API key transport | **Backend-only** — never expose to browser | Frontend POSTs key once via `PUT /api/llm/providers/{name}`. Status endpoint returns only `{configured: true}`. |
| Per-feature config storage | **Same `secrets.json`** under `activeProviders` key | One source of truth. Hot-reloads on every dispatch (no caching pitfalls). |
| Vision routing | **Reject at backend** if user picked a non-vision-capable provider | All 4 currently support vision. The gate fires only when future providers add. |
| Vision attachment transport | **Hybrid — caller passes file path; provider converts internally** | CLI providers (Claude / Gemini / OpenAI Codex) attach via native flag (`@<path>` / `--image <path>`) — preserves the subscription benefit. API providers (Grok / OpenAI API fallback) base64 → data URL. Unified caller signature: `attachments: list[str]` of file paths. |
| Backward compat | **`FLOWBOARD_PLANNER_BACKEND=mock\|cli\|auto`** still respected; new env vars overlay | Existing dev setups don't break. New env: `FLOWBOARD_LLM_DEFAULT_PROVIDER=claude` for headless. |
| Cost telemetry | **Out of scope** for v1 | Token counters, monthly spend dashboards — nice-to-have but not blocking. |
| Fallback chain | **Out of scope** for v1 | "Primary fails → switch to next" complexity not justified. Surface clean errors; let user decide. |

## Acceptance Criteria

1. **Settings panel grows an "AI Providers" section** with two subsections:
   - **Per-feature routing** — three dropdowns (Auto-Prompt / Vision / Planner)
     listing all 4 providers with a status icon (`✓ ready` / `⚠ needs setup` /
     `✗ unavailable`).
   - **Provider connections** — four rows (Claude / Gemini / OpenAI / Grok)
     each showing current state + Setup help button.
2. **Claude / Gemini rows** show `✓ Connected` only when CLI is installed AND
   authenticated. "Setup help →" opens a modal with `npm install -g …` +
   auth command, both copyable.
3. **OpenAI row** dynamic states (full state machine in UI Spec section):
   - Codex CLI present + authenticated + vision-capable → `✓ Connected via
     Codex CLI (ChatGPT OAuth)`.
   - Codex CLI present + authenticated + text-only → `✓ Connected via
     Codex CLI` + inline note "ⓘ Your Codex version is text-only. Add API
     key for Vision feature." + collapsible "+ Add API key fallback".
   - No Codex CLI → `⚠ Setup needed` with two paths: "Install Codex CLI"
     (modal) or "Use API key" (expands input).
   - API key configured (with or without Codex CLI) → `✓ Connected via
     API key` + masked key + Edit/Clear.
4. **Grok row** has API key field, Test, Save, Clear buttons. States:
   `⚠ API key needed` → `✓ Connected (API key)` → `✗ Test failed: {error}`.
5. **Auto-Prompt = Gemini** dispatches the synth call through Gemini CLI,
   not Claude. Verify: agent log line `llm: provider=gemini feature=auto_prompt`.
6. **Vision = OpenAI** dispatches through Codex CLI if vision-capable, else
   through API. The aiBrief returns in the same 200-char factual format as
   the current Claude path.
7. **Provider config persists** across agent restart.
8. **API keys never leak** — not in agent logs (filter at logger level), not
   in HTTP responses (only `{configured: true}` returned by GET endpoint),
   not in browser localStorage.
9. **Clear key** sets the row back to `⚠ no key` and disables that provider
   in dropdowns until re-entered.
10. **Picking an unavailable provider** + dispatching → request fails with a
    clear error naming the missing provider — no silent fallback.
11. **All 232 existing tests pass** after migration. No backend test reaches
    a real provider — the abstraction is mockable.
12. **New tests cover**: provider registry routing, secret-file roundtrip
    + mode 600, per-feature dispatch, vision-capability gate (defense even
    though all 4 providers support vision today), OpenAI dual-mode probe +
    vision fallback to API mode, Codex CLI image-flag detection.

---

## UI Specification

This section is the implementation contract for the frontend. Every state,
copy string, and component boundary is named here so the frontend pass is
mechanical.

### Component tree

```
SettingsPanel.tsx                   (existing — adds new section between
│                                    "Video model" and "Image model")
│
└── AiProvidersSection.tsx          (new — section wrapper, owns data fetch)
    │
    ├── FeatureRoutingTable.tsx     (3-row table of dropdowns)
    │   └── ProviderDropdown.tsx    (single dropdown — used 3×)
    │
    ├── ProviderConnections.tsx     (header + 4 rows)
    │   ├── CliProviderRow.tsx      (used by Claude + Gemini, identical machine)
    │   ├── OpenAiRow.tsx           (dual-mode — most complex)
    │   └── GrokRow.tsx             (API-key only)
    │
    └── ProviderSetupModal.tsx      (portal — content varies by `provider` prop)
```

Reused primitives from the existing design system: `Button`, `Modal`/dialog
(used by Sponsor), input fields with the existing focus styling.

### Top-level layout

```
┌─ AI Providers ──────────────────────────────────────────────┐
│  Pick which AI powers each Flowboard feature.               │
│  Claude / Gemini / OpenAI use your existing subscription    │
│  via their official CLIs — no API key needed. Grok uses     │
│  a direct API key (xAI hasn't shipped a CLI yet).           │
│                                                             │
│  ─── Per-feature routing ──────────────────────────────     │
│  Auto-Prompt   [ Claude  ✓                          ▼ ]    │
│  Vision        [ Gemini  ✓                          ▼ ]    │
│  Planner       [ Claude  ✓                          ▼ ]    │
│                                                             │
│  ─── Provider connections ─────────────────────────────     │
│  ⚪ Claude     ✓ Connected (Claude CLI · OAuth)             │
│                                              [ Setup help ] │
│                                                             │
│  🔵 Gemini     ⚠ CLI not found                              │
│                Run `npm install -g @google/gemini-cli`.     │
│                                              [ Setup help ] │
│                                                             │
│  🟢 OpenAI     ✓ Connected via Codex CLI (ChatGPT OAuth)    │
│                ⓘ Your Codex version is text-only.           │
│                  Vision dispatches need an API key.         │
│                [+ Add API key for vision]    [ Setup help ] │
│                                                             │
│  ⚫ Grok       ⚠ API key needed                             │
│                [ xai-_______________________ ] 👁           │
│                [ Test ]  [ Save ]            [ Setup help ] │
└─────────────────────────────────────────────────────────────┘
```

### Section copy

Header description (immutable strings, used as-is):

> Pick which AI powers each Flowboard feature.
> Claude / Gemini / OpenAI use your existing subscription via their official
> CLIs — no API key needed. Grok uses a direct API key (xAI hasn't shipped
> a CLI yet).

Subsection titles: `Per-feature routing` · `Provider connections`.

### Per-feature routing — dropdown spec

Three dropdowns, each `<ProviderDropdown feature="auto_prompt|vision|planner" />`.

**Closed state**: `[ {ProviderName}  {StatusIcon}  ▼ ]`

- Width: full row (flex 1), height matches existing Settings inputs.
- StatusIcon mapping:
  - `✓` (green) — provider available + configured
  - `⚠` (amber) — provider needs setup
  - `✗` (red) — last test failed

**Open state**: floating list of 4 options. Each option:

```
{Name}  {StatusIcon}  {AuthHintText}
```

AuthHintText (small, muted color):
- Claude: `via CLI`
- Gemini: `via CLI`
- OpenAI: `via Codex CLI (ChatGPT OAuth)` OR `via API key` depending on mode
- Grok: `API key`

Disabled options (provider not configured) render greyed out with a tooltip
on hover: `{Provider} not configured — see Provider connections below.`

**Vision dropdown specifically**: filters out providers where
`supportsVision === false`. Currently no provider is filtered (all 4 support
vision); the filter logic is wired but inert in v1.

**Selection commit**:
- Optimistic update (dropdown shows new value immediately).
- `PUT /api/llm/config` with `{auto_prompt: "gemini"}` (or whichever feature).
- On 4xx/5xx: dropdown reverts; toast bottom-right: `Couldn't save — {error}`.

### CliProviderRow — Claude + Gemini (identical state machine)

Four states. The component receives `provider: "claude" | "gemini"` and
renders the right copy.

| State | Trigger | Layout |
|---|---|---|
| **S1** ✓ Connected | `available && configured && !lastError` | Single-line: `✓ Connected ({CLI name} · OAuth)` |
| **S2** ⚠ CLI not found | `lastError === "not_installed"` | Two lines: `⚠ CLI not found` + `Run \`npm install -g {pkg}\` to enable.` |
| **S3** ⚠ Not authenticated | `lastError === "not_authenticated"` | Two lines: `⚠ CLI installed but not signed in` + `Run \`{provider} login\` to authenticate.` |
| **S4** ✗ Test failed | `lastTest && !lastTest.ok` | Two lines: `✗ Last test failed: {error}` + button `[ Retry test ]` |

All states show a `[ Setup help ]` button at the row's right edge that opens
the `ProviderSetupModal`.

Backend → frontend contract for state derivation, in `GET /api/llm/providers`:

```ts
{
  name: "claude",
  available: boolean,           // CLI binary present AND authenticated
  configured: true,             // CLI providers are always "configured" semantically
  supportsVision: true,
  requiresKey: false,
  lastError?: "not_installed" | "not_authenticated",
  lastTest?: { ok: boolean, latencyMs?: number, error?: string },
  mode: "cli"                   // present for OpenAI; "cli" for Claude/Gemini for symmetry
}
```

### OpenAiRow — dual-mode state machine

The most stateful row. The visible content depends on the cross-product of
**Codex CLI availability × API key configuration × Codex vision support**.

#### State table

| Codex CLI | API key | Vision flag detected on Codex | UI state | Primary message |
|---|---|---|---|---|
| not installed | absent | n/a | **OA0** | `⚠ Setup needed` + 2 buttons |
| not installed | present | n/a | **OA3** | `✓ Connected via API key` |
| installed not auth | absent | n/a | **OA1** | `⚠ Codex CLI installed but not signed in` |
| installed not auth | present | n/a | **OA3** | `✓ Connected via API key` (with hint to also `codex login`) |
| installed + auth | absent | yes | **OA2-vision** | `✓ Connected via Codex CLI (ChatGPT OAuth)` |
| installed + auth | absent | no | **OA2-text** | `✓ Connected via Codex CLI` + ⓘ text-only note + "+ Add API key" |
| installed + auth | present | yes | **OA2-vision+key** | `✓ Connected via Codex CLI` (key shown collapsed under "Manage API key") |
| installed + auth | present | no | **OA2-text+key** | `✓ Connected via Codex CLI (text) · API key (vision)` |

#### Visible layouts

**OA0 — Setup needed**
```
🟢 OpenAI     ⚠ Setup needed
              Choose: install Codex CLI to use your ChatGPT
              subscription (preferred), or paste an OpenAI API key.
              [ Install Codex CLI ]   [ Use API key ]
                                              [ Setup help ]
```
- "Install Codex CLI" → opens setup modal on the Codex tab.
- "Use API key" → expands the inline API key field below the row.

**OA1 — Codex installed, not auth**
```
🟢 OpenAI     ⚠ Codex CLI installed but not signed in
              Run `codex login` to authenticate, or paste an
              OpenAI API key as a fallback.
              [ Use API key ]                 [ Setup help ]
```

**OA2-vision — Best case**
```
🟢 OpenAI     ✓ Connected via Codex CLI (ChatGPT OAuth)
              [+ Manage API key fallback]    [ Setup help ]
```
- "Manage API key fallback" expands optional key field (state OA3 sub-content).
- Quietly muted; not the primary CTA.

**OA2-text — Codex text-only, no key**
```
🟢 OpenAI     ✓ Connected via Codex CLI (ChatGPT OAuth)
              ⓘ Your Codex version is text-only. Vision
                dispatches will fail unless you add an API key.
              [+ Add API key for vision]     [ Setup help ]
```
- "+ Add API key" inline-expands the key field.
- After save, transitions to OA2-text+key.

**OA2-text+key — Best of both**
```
🟢 OpenAI     ✓ Connected · text via Codex CLI · vision via API key
              API key: [ sk-1234••••••••5678 ]  [ Edit ] [ Clear ]
                                              [ Setup help ]
```

**OA3 — API only**
```
🟢 OpenAI     ✓ Connected via API key
              [ sk-1234••••••••5678 ]  [ Edit ] [ Clear ]
              [ Test ]                        [ Setup help ]
```
- If Codex CLI is installed but not auth, also show small hint:
  `ⓘ Run \`codex login\` to use your ChatGPT subscription instead.`

The expanded API key field (used inline by OA0 / OA1 / OA2-text) is always
the same component — see "API key field behavior" below.

### GrokRow — API-only

Three states.

**GR1 — Empty**
```
⚫ Grok       ⚠ API key needed
              [ xai-_______________________ ] 👁
              [ Test ]  [ Save ]              [ Setup help ]
```

**GR2 — Connected**
```
⚫ Grok       ✓ Connected (API key)
              [ xai-1234••••••••wxyz ]  [ Edit ] [ Clear ]
              [ Test ]                        [ Setup help ]
```

**GR3 — Test failed**
```
⚫ Grok       ✗ Test failed: 401 Unauthorized (invalid key)
              [ xai-1234••••••••wxyz ]  [ Edit ] [ Clear ]
              [ Retry test ]                  [ Setup help ]
```

### API key field behavior (shared by OpenAI fallback + Grok)

Single component (`ApiKeyField.tsx`) with these states + transitions:

- **Empty**: `<input type="password" placeholder="sk-..." />` + reveal eye
  toggle (`👁`). Save button disabled. Test disabled.
- **Editing** (typing): live regex check (`^sk-...` for OpenAI, `^xai-...`
  for Grok). Invalid → input has red border + below-field hint
  `Doesn't match expected format`. Save still enabled (let backend be the
  arbiter — regex is a hint, not a gate); Test stays disabled until format
  passes the hint.
- **Saved**: input collapses to masked form (first 4 chars + `••••••••` +
  last 4). `[ Edit ]` button + `[ Clear ]` button.
  - **Edit** clears the input and gives focus; Save/Test re-enabled on type.
  - **Clear** opens an inline confirmation: `Remove this key? [ Yes ] [ No ]`.
    Yes → `PUT /api/llm/providers/{name}` with `{apiKey: null}` → state
    reverts to Empty.
- **Reveal toggle (👁)**: while in Editing, toggles input `type` between
  `password` and `text` so user can verify what they typed. Reverts to
  `password` after blur.

### Test button behavior

Used by Grok always, OpenAI in API mode.

1. Click Test → button content changes to `Testing… ⏳`, goes disabled,
   10s deadline.
2. `POST /api/llm/providers/{name}/test` (backend pings the provider with a
   1-token "ping" prompt — `messages: [{"role":"user","content":"."}]`,
   `max_tokens: 1`).
3. **Success** (HTTP 200, body `{ok: true, latencyMs}`): button reverts;
   inline next to row appears for 3s: `✓ Connected · {latency}ms` then fades.
4. **Failure** (4xx/5xx or `{ok: false, error}`): button reverts; row state
   transitions to S4/GR3 with the `error` string copied verbatim into the
   visible message.

### Setup help modal

One component (`ProviderSetupModal.tsx`) with `provider` prop selecting
content. Dimensions: 480px wide × auto height, max 600px tall (scroll if
overflow). Backdrop click + ESC + Close button all dismiss.

#### Claude modal

```
─────────────────────────────────────────────
🤖 Claude CLI Setup
─────────────────────────────────────────────

Flowboard uses your existing Claude subscription via the
official CLI — no API key needed.

1. Install
   ┌─────────────────────────────────────────┐
   │ npm install -g @anthropic-ai/claude-code│  [ Copy ]
   └─────────────────────────────────────────┘

2. Authenticate
   ┌─────────────────────────────────────────┐
   │ claude                                  │  [ Copy ]
   └─────────────────────────────────────────┘
   Opens browser for OAuth — sign in with your Claude account.

3. Verify
   ┌─────────────────────────────────────────┐
   │ claude --version                        │  [ Copy ]
   └─────────────────────────────────────────┘

Once installed + authenticated, the Claude row above flips to
✓ Connected automatically (the panel polls every 30s).

[ Open Anthropic docs ↗ ]              [ Close ]
```

`[ Open Anthropic docs ↗ ]` → `https://docs.anthropic.com/en/docs/claude-code/quickstart`

#### Gemini modal

Same structure, substituting:
- Install: `npm install -g @google/gemini-cli`
- Auth: `gemini auth login`
- Verify: `gemini --version`
- Docs link: `https://github.com/google/gemini-cli`

#### OpenAI modal — two-tab layout

```
─────────────────────────────────────────────
🤖 OpenAI Setup
─────────────────────────────────────────────

[ Codex CLI (recommended) ] [ API key ]
─────────────────────────────────────────────

(Codex CLI tab — default selected)
ChatGPT Plus or Pro subscription required.

1. Install
   npm install -g @openai/codex                   [ Copy ]
2. Authenticate
   codex login                                    [ Copy ]
3. Verify
   codex --version                                [ Copy ]

If your Codex version is text-only, you can add an OpenAI
API key as a Vision fallback in the OpenAI row above.

(API key tab)
For users without ChatGPT Plus or Pro.

1. Get a key
   https://platform.openai.com/api-keys
2. Save it
   Paste in the OpenAI row above and click Save.

The key stays in ~/.flowboard/secrets.json (mode 600,
local only) and is never sent anywhere except api.openai.com.

[ Open OpenAI docs ↗ ]                 [ Close ]
```

Docs link → `https://platform.openai.com/docs/quickstart`

#### Grok modal — single panel

```
─────────────────────────────────────────────
🤖 Grok API Key
─────────────────────────────────────────────

xAI hasn't shipped an end-user CLI yet — Flowboard
uses their REST API directly with your key.

1. Get a key
   Go to https://console.x.ai/api-keys
   Create a new key with the chat:completions scope.

2. Save it
   Paste the key in the Grok row above and click Save.
   The key stays in ~/.flowboard/secrets.json (mode 600,
   local only) and is never sent anywhere except api.x.ai.

3. Test
   Click "Test" to verify the key works.

Cost note: Grok bills per-token. See xAI pricing for rates.

[ Open xAI console ↗ ]                 [ Close ]
```

Docs link → `https://docs.x.ai/api/quickstart`

### Loading / empty / error states

- **Section mount**: `GET /api/llm/providers` + `GET /api/llm/config` fire
  in parallel. While in flight, render skeleton: 3 dropdown placeholder rows
  + 4 provider row placeholders (each ~48px tall, animated shimmer).
- **Mount failure** (any of the two GETs returns 5xx): banner above the
  section: `⚠ Couldn't load AI provider state. [ Retry ]`. Both subsections
  render their disabled / empty state.
- **Optimistic dropdown change → backend rejection**: toast bottom-right
  `Couldn't save selection: {error}`, dropdown reverts to previous value.
- **API key save failure**: inline error under the field (red text), key is
  NOT collapsed to masked form — input stays editable with the value still
  in it.
- **Test failure**: row transitions to S4/GR3, error stays visible until
  next successful test or until user edits the key.

### Periodic state refresh

While the Settings panel is open AND the AI Providers section is mounted,
poll `GET /api/llm/providers` every **30s**. This catches the case where the
user installs a CLI in another terminal while the panel is open.

Stop polling on:
- Panel close.
- AiProvidersSection unmount (collapsed).
- Tab visibility hidden (browser visibility API).

### Accessibility

- Each dropdown: `aria-label="{Feature} provider"`, `role="combobox"`.
- Status icons (`✓ ⚠ ✗`) accompanied by visually-hidden `aria-label="ready"`
  / `"needs setup"` / `"failed"` for screen readers.
- API key fields: `type="password"` with `autocomplete="off"`. Reveal toggle
  flips to `type="text"`; restores to password on blur.
- Modal: focus trapped on open, focus returns to triggering button on close.
- Color is never the only signal — every status has icon + text label.
- Keyboard: dropdowns open on `Enter`/`Space`, navigate with arrow keys,
  commit on `Enter`, dismiss on `Escape`.

### Frontend ↔ backend contract (full)

| Action | HTTP | Endpoint | Request | Response |
|---|---|---|---|---|
| Section mount — list providers | `GET` | `/api/llm/providers` | — | `[{name, available, configured, supportsVision, requiresKey, mode, lastError?, lastTest?}]` |
| Section mount — read config | `GET` | `/api/llm/config` | — | `{auto_prompt, vision, planner}` |
| Save / clear key | `PUT` | `/api/llm/providers/{name}` | `{apiKey: string \| null}` | `{ok: true}` |
| Test connection | `POST` | `/api/llm/providers/{name}/test` | — | `{ok: true, latencyMs}` or `{ok: false, error}` |
| Switch feature provider | `PUT` | `/api/llm/config` | `{auto_prompt? \| vision? \| planner?}` | `{ok: true}` |

`lastError` enum (string): `"not_installed"` · `"not_authenticated"` · `"no_key"` · `"unreachable"` · `"unknown"`.

`mode` enum (string): `"cli"` · `"api"` · `"none"` (only OpenAI varies; the
others always return their fixed mode for symmetry).

---

## Implementation Steps

### Step 1 — Backend: provider abstraction package

New package `agent/flowboard/services/llm/`:

```
llm/
  __init__.py        # Re-exports run_llm + LLMProvider
  base.py            # Protocol + LLMRequest/LLMResponse dataclasses + LLMError
  claude.py          # Wraps existing claude_cli.py (rename + adapt)
  gemini.py          # NEW — subprocess wrapper for `gemini` CLI
  openai.py          # NEW — dual-mode (Codex CLI subprocess + httpx API client)
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
    config = secrets.read_active_providers()
    provider_name = config.get(feature, "claude")
    provider = _PROVIDERS[provider_name]
    if (attachments := kwargs.get("attachments")):
        if not provider.supports_vision:
            raise LLMError(f"{provider_name} doesn't support vision; reconfigure Vision provider")
    if not await provider.is_available():
        raise LLMError(f"{provider_name} is not configured (no API key / CLI missing)")
    return await provider.run(user_prompt, **kwargs)
```

### Step 2 — Backend: secret storage

`agent/flowboard/services/llm/secrets.py`:
```python
import json, os
from pathlib import Path

_PATH = Path.home() / ".flowboard" / "secrets.json"

# Schema:
# {
#   "apiKeys": {"openai": "sk-...", "grok": "xai-..."},
#   "activeProviders": {"auto_prompt": "claude", "vision": "gemini", "planner": "claude"}
# }

def read() -> dict: ...
def write(payload: dict) -> None: ...   # atomic write via .tmp + replace, chmod 0o600
def get_api_key(provider: str) -> str | None: ...
def set_api_key(provider: str, key: str | None) -> None: ...
def read_active_providers() -> dict[str, str]: ...
def set_feature_provider(feature: str, provider: str) -> None: ...
```

Filter setup at logger init: any log record carrying a string matching
`/sk-[A-Za-z0-9-]+|xai-[A-Za-z0-9-]+/` gets the match redacted to
`sk-•••REDACTED•••`. Belt-and-braces — providers should never log the key
in the first place.

### Step 3 — Backend: 4 provider implementations

**Vision attachment strategy** — caller signature is identical across all 4
providers (`attachments: list[str]` of file paths). Each provider converts
internally based on its transport.

| Provider | Vision | Transport | Attachment handling |
|---|---|---|---|
| Claude | ✓ | CLI subprocess | Pass `@<absolute_path>` arg + `--add-dir <parent> --permission-mode bypassPermissions` (existing pattern) |
| Gemini | ✓ | CLI subprocess | Pass `--image <absolute_path>` per attachment (verify exact flag via `gemini --help` at provider init) |
| OpenAI Codex CLI mode | ✓ if CLI supports it · ✗ otherwise | CLI subprocess | If `codex --help` advertises an image flag (`--image`/`--attach`/`--file` — verify at provider init), use it. If Codex lacks vision, OpenAIProvider falls back to API mode for vision dispatches only (text features stay on Codex). |
| OpenAI API mode | ✓ | REST (httpx) | base64 → data URL in `messages[].content[].image_url.url` |
| Grok | ✓ | REST (httpx) | Same base64 data-URL pattern (xAI uses OpenAI-compatible message schema) |

**File-size guard** — vision-capable provider modules reject attachments
>5MB before sending. Surface as
`LLMError("attachment too large for {provider}: {size}MB > 5MB cap")`.

`claude.py`: copy logic from current `claude_cli.py`, conform to LLMProvider
protocol. Keep `@<path>` attachment handling. `supports_vision = True`.

`gemini.py`: subprocess `gemini -p <prompt> --json` (verify exact CLI flags
via `gemini --help`). Vision attachments via `--image <path>` per file.
`supports_vision = True`.

`openai.py` — dual-mode:

```python
class OpenAIProvider:
    name = "openai"
    supports_vision = True   # via at least one of the modes

    async def __init_async__(self):
        if await _probe_codex_cli():
            self._mode = "cli"
            self._cli_image_flag = await _detect_codex_image_flag()  # str | None
        elif secrets.get_api_key("openai"):
            self._mode = "api"
        else:
            self._mode = None

    async def run(self, prompt, *, system_prompt=None, attachments=None, timeout=90.0, model=None):
        if self._mode == "cli":
            if attachments and self._cli_image_flag is None:
                if not secrets.get_api_key("openai"):
                    raise LLMError(
                        "OpenAI Codex CLI does not support vision in your version. "
                        "Either upgrade Codex CLI or configure an OpenAI API key."
                    )
                return await self._run_via_api(prompt, system_prompt, attachments, timeout, model)
            return await self._run_via_cli(prompt, system_prompt, attachments, timeout, model)
        return await self._run_via_api(prompt, system_prompt, attachments, timeout, model)
```

CLI mode: `codex exec --output-format json -p <prompt> [--image <path>]`.
JSON envelope parsing reuses the structure from `claude_cli.py`.

API mode: `POST https://api.openai.com/v1/chat/completions`. Default model:
`gpt-5` for text, auto-bump to `gpt-4o` (or current vision-capable variant)
when attachments present. JSON mode for planner:
`response_format={"type":"json_object"}`.

`grok.py`: httpx client. `POST https://api.x.ai/v1/chat/completions`.
Default model `grok-4`; auto-bump to `grok-2-vision-1212` when attachments
present. Same base64 data-URL message shape as OpenAI API. `supports_vision = True`.

Each provider's `is_available()`:
- Claude / Gemini: probe CLI binary with `--version` (5s timeout, cached for the agent's lifetime).
- OpenAI: True if EITHER Codex CLI is installed + authenticated OR an API key is configured.
- Grok: True if `secrets.get_api_key("grok")` is set + a `/v1/models` ping with that key returns 200 (cached 60s).

### Step 4 — Backend: HTTP routes

`agent/flowboard/routes/llm.py`:
```
GET  /api/llm/providers
PUT  /api/llm/providers/{name}     body: {"apiKey": "..."} | {"apiKey": null}
POST /api/llm/providers/{name}/test
GET  /api/llm/config
PUT  /api/llm/config               body: {auto_prompt?, vision?, planner?}
```

Mount in `flowboard/app.py`. Tests in `tests/test_llm_routes.py`.

### Step 5 — Migrate existing services to use registry

- `prompt_synth.py`: `from .claude_cli import run_claude` →
  `from .llm import run_llm`. Replace each call site
  `await run_claude(prompt, system_prompt=...)` →
  `await run_llm("auto_prompt", prompt, system_prompt=...)`. ~6 call sites.
- `vision.py`: same pattern; route as `"vision"`. ~1 call site.
- `planner.py`: same; route as `"planner"`. Keep the `FLOWBOARD_PLANNER_BACKEND=mock`
  short-circuit so deterministic tests don't break.

`claude_cli.py` becomes a thin re-export of `llm.claude.ClaudeProvider`
for backward compat (deprecation note in docstring; remove in v1.3).

### Step 6 — Frontend: API client + types

`frontend/src/api/client.ts` — add:
```ts
export interface LLMProviderInfo {
  name: "claude" | "gemini" | "openai" | "grok";
  supportsVision: boolean;
  available: boolean;
  configured: boolean;
  requiresKey: boolean;
  mode: "cli" | "api" | "none";
  lastError?: "not_installed" | "not_authenticated" | "no_key" | "unreachable" | "unknown";
  lastTest?: { ok: boolean; latencyMs?: number; error?: string };
}

export interface LLMConfig { auto_prompt: string; vision: string; planner: string; }

getLlmProviders(): Promise<LLMProviderInfo[]>;
setLlmApiKey(name: string, apiKey: string | null): Promise<{ok: boolean}>;
testLlmProvider(name: string): Promise<{ok: boolean; latencyMs?: number; error?: string}>;
getLlmConfig(): Promise<LLMConfig>;
setLlmConfig(partial: Partial<LLMConfig>): Promise<{ok: boolean}>;
```

### Step 7 — Frontend: AiProvidersSection (per UI Spec above)

Implementation order (each is a discrete commit):

1. **Skeleton + data fetch** — TypeScript types, parallel mount fetch, loading
   skeletons, retry on mount failure.
2. **FeatureRoutingTable + ProviderDropdown** — wire to `PUT /api/llm/config`,
   optimistic update + revert on error.
3. **CliProviderRow** — Claude + Gemini state machine (S1-S4), Setup help button.
4. **GrokRow** — API key field component (Empty / Editing / Saved transitions),
   Test/Save/Clear buttons, GR1-GR3 states.
5. **OpenAiRow** — dual-mode state machine (OA0-OA3 + sub-states), inline
   API key expander, "+ Add API key" affordance.
6. **ProviderSetupModal** — 3 modal contents (Claude, Gemini, OpenAI 2-tab,
   Grok), copy buttons on each command, docs link.
7. **Periodic state refresh** — 30s polling while panel open, paused on
   visibility hidden.
8. **Toasts + inline error states** for all failure modes.
9. **Accessibility pass** — aria-labels, focus management, keyboard nav.
10. **Manual smoke + screenshot review** against UI Spec sketches.

### Step 8 — Tests

Backend (~12 new tests):
- `tests/test_llm_secrets.py` — file roundtrip, mode 600, atomic write, missing-file empty dict, redaction filter.
- `tests/test_llm_registry.py` — feature → provider routing, vision-capability gate, fallback to default when config empty, error on unavailable.
- `tests/test_llm_providers.py` — each provider's `is_available()` probe path with subprocess + httpx mocks.
- `tests/test_llm_routes.py` — GET/PUT/POST endpoints, key masking in responses, test endpoint invokes provider correctly.
- `tests/test_llm_openai_dual_mode.py` — Codex CLI probe with various `--help` outputs, mode selection logic, vision fallback to API mode when CLI is text-only, error path when neither CLI nor API key present.
- Existing tests: update mocks `run_claude` → `run_llm` (mechanical search/replace).

Frontend: type-check only (no test runner currently).

### Step 9 — Documentation

`README.md` — new section "Configuring AI Providers":
- Default = Claude (existing behavior, no change for current users).
- Switching: Settings → AI Providers.
- Auth model per provider: Claude/Gemini/OpenAI via CLI subscription, Grok via API key.
- Where keys are stored (`~/.flowboard/secrets.json`, mode 600).
- Cost notes: which providers are free with subscription vs. pay-per-token.

`docs/llm-providers.md` (new) — full setup guides for each provider, mirroring
the in-app modal content but with screenshots.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| API key leak via logs | Logger redaction filter (Step 2); assert in tests that key never appears in any captured log line. |
| `secrets.json` world-readable on misconfigured systems | `os.chmod(path, 0o600)` after every write; `os.umask(0o077)` at agent startup. Document in README. |
| Provider API breaking changes | Each provider in its own module; failures in one don't cascade. Pin `httpx`. |
| Vision-required call routes to text-only provider | `run_llm()` raises `LLMError` immediately if `attachments` present and `provider.supports_vision == False`. Frontend dropdown also flags it. |
| `FLOWBOARD_PLANNER_BACKEND=mock` users break | `planner.py` keeps the mock short-circuit before calling `run_llm`. Add a regression test. |
| Long timeouts on rate-limited OpenAI/Grok | Per-provider configurable timeout (default 90s). Surface clear error to UI with provider name. |
| Provider system prompts perform worse on non-Claude models | All system prompts stay generic-text; we don't tune to Claude internals. Document that Auto-Prompt quality may vary. Add a "Recommended for X" hint per feature in Settings (e.g. "Vision: Gemini cheaper, Claude more accurate"). |
| Large image attachments timeout API providers | Reject >5MB at provider boundary with clear error. Flow's outputs are typically <2MB so defensive only. |
| Gemini CLI flag drift between versions | Detect at provider init: probe `gemini --help`, parse for `--image`/`--input`, cache resolved flag. Falls back to error with install-version notice if no recognised flag found. |
| Codex CLI vision support unverified at plan time | OpenAIProvider probes `codex --help` at init and parses for image flag. If found, Codex handles vision; if not, fall back to API mode for vision dispatches only — text features stay on Codex. UI surfaces this so users know they need an API key as backup *only if* their Codex version is text-only. The capability is detected, not assumed. |
| Codex CLI image flag drift | Same mitigation as Gemini drift — probe `--help` at init, cache resolved flag, treat as text-only if unrecognised. |
| Users without ChatGPT subscription can't use Codex CLI | Documented clearly in OpenAI modal: "Codex CLI requires ChatGPT Plus or Pro." API key path remains. |
| Test suite shape changes break CI | Migrate tests in one commit (mechanical), verify 232/232 still pass before any provider work lands. |

## Verification Steps

1. `cd agent && .venv/bin/pytest -q` — all 232 existing tests pass + ~12 new tests pass (target ≥244).
2. Set `~/.flowboard/secrets.json` manually with an OpenAI key, restart agent. `curl /api/llm/providers` returns OpenAI as `{available: true, configured: true, mode: "api"}`.
3. In Settings UI, switch Vision to OpenAI. Upload a character image. aiBrief returns within 10s and matches the 200-char factual format.
4. Switch Vision to Grok with no key set → dropdown shows `⚠ needs setup` and disables it.
5. Set Auto-Prompt to Gemini. Click Generate without prompt on an image node. Synth call routes through `gemini` CLI (verify in agent logs: `llm: provider=gemini feature=auto_prompt`).
6. Restart agent; settings persist.
7. Clear OpenAI key in UI → row reverts to OA1 / OA2-text / OA0 (depending on Codex CLI presence). Provider disabled in dropdowns until re-entered.
8. Verify `secrets.json` has mode `-rw-------` (0600).
9. **Vision parity** — set Vision provider to each of Claude / Gemini / OpenAI / Grok in turn, upload the SAME test image each time. All 4 produce a non-empty 80-200 char factual brief. Confirms hybrid attachment pipeline works for both CLI (`@<path>`, `--image <path>`) and API (base64 data URL) transports.
10. **OpenAI Codex CLI mode** — install `npm install -g @openai/codex`, authenticate via `codex login`. Without setting any API key, set Auto-Prompt = OpenAI. Click Generate → synth routes through Codex CLI subprocess (agent logs: `llm: provider=openai mode=cli feature=auto_prompt`). No API call to api.openai.com observed.
11. **OpenAI Codex CLI vision fallback** — with Codex authenticated but no API key, set Vision = OpenAI. Upload an image. If `_cli_image_flag is None` (text-only Codex), dispatch fails with the documented error pointing to the Settings panel. After adding API key + retry, Vision dispatch succeeds via API mode.
12. **Reject 6MB test image** — provider returns `LLMError("attachment too large…")` consistently across all 4 vision-capable providers.
13. **Periodic refresh** — install `gemini` CLI in another terminal while Settings panel is open. Within 30s the Gemini row flips from `⚠ CLI not found` → `✓ Connected` without manual reload.

## File touch list

**Backend (new):**
- `agent/flowboard/services/llm/__init__.py`
- `agent/flowboard/services/llm/base.py`
- `agent/flowboard/services/llm/claude.py`
- `agent/flowboard/services/llm/gemini.py`
- `agent/flowboard/services/llm/openai.py` — dual-mode (Codex CLI subprocess + httpx API fallback, capability probe at init)
- `agent/flowboard/services/llm/grok.py`
- `agent/flowboard/services/llm/registry.py`
- `agent/flowboard/services/llm/secrets.py`
- `agent/flowboard/routes/llm.py`
- `agent/tests/test_llm_secrets.py`
- `agent/tests/test_llm_registry.py`
- `agent/tests/test_llm_providers.py`
- `agent/tests/test_llm_routes.py`
- `agent/tests/test_llm_openai_dual_mode.py`

**Backend (modified):**
- `agent/flowboard/services/claude_cli.py` — thin re-export → deprecate
- `agent/flowboard/services/prompt_synth.py` — switch to `run_llm`
- `agent/flowboard/services/vision.py` — switch to `run_llm`
- `agent/flowboard/services/planner.py` — switch to `run_llm`
- `agent/flowboard/app.py` — mount `/api/llm` router
- `agent/flowboard/config.py` — add `LLM_DEFAULT_PROVIDER` env var
- `agent/pyproject.toml` — confirm `httpx` already present (it is) — no new deps
- Existing tests in `test_prompt_synth.py`, `test_vision.py`, `test_planner.py` — update mocks

**Frontend (new):**
- `frontend/src/components/settings/AiProvidersSection.tsx`
- `frontend/src/components/settings/FeatureRoutingTable.tsx`
- `frontend/src/components/settings/ProviderDropdown.tsx`
- `frontend/src/components/settings/ProviderConnections.tsx`
- `frontend/src/components/settings/CliProviderRow.tsx`
- `frontend/src/components/settings/OpenAiRow.tsx`
- `frontend/src/components/settings/GrokRow.tsx`
- `frontend/src/components/settings/ApiKeyField.tsx`
- `frontend/src/components/settings/ProviderSetupModal.tsx`

**Frontend (modified):**
- `frontend/src/components/SettingsPanel.tsx` — mount `AiProvidersSection`
- `frontend/src/api/client.ts` — add 5 LLM functions + 2 types + enums
- `frontend/src/styles.css` — provider rows, status icons, dropdown options, key field, modal contents

**Docs:**
- `README.md` — "Configuring AI Providers" section
- `docs/llm-providers.md` (new) — full setup guides per provider with screenshots

## Out of scope (follow-ups)

- Cost telemetry (token counters, monthly spend dashboard)
- Automatic fallback chain on provider failure
- Per-call provider override ("this one Generate uses GPT-5")
- Self-hosted local models (Ollama / LM Studio integration)
- Streaming responses (currently all 3 features are batch / single-shot)
- Encrypted secrets file (only worth it if multi-user environments)
- Provider quality benchmarks / "recommended for X" UI hints powered by real data
- BYO model — let user enter custom OpenAI-compatible endpoint URL (Ollama, vLLM, custom)
- DeepSeek (rejected here; available via 9Router alternative if user demand emerges)

## Effort estimate

| Phase | Days |
|---|---|
| Backend: abstraction + 2 pure CLI providers (Claude, Gemini) | 1.0 |
| Backend: OpenAI dual-mode (Codex CLI + API fallback, capability probe, mode-switching logic) | 1.25 |
| Backend: Grok API provider + secrets + routes | 0.5 |
| Backend: migrate 3 services + update existing tests | 0.5 |
| Backend: write new tests (incl. OpenAI dual-mode probe + fallback, Codex CLI image-flag detection) | 1.25 |
| Frontend: AiProvidersSection (component tree, dropdowns, state machines, modals, accessibility per UI Spec) | 2.25 |
| Documentation + manual smoke testing | 0.5 |
| **Total** | **~7.25 days** |

Suggested release: **v1.2.0** (feature-complete enough for minor version bump).
