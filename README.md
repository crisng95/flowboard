<p align="center">
  <img src="docs/assets/logo-wordmark.svg" alt="Flowboard" width="480" />
</p>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"/></a>
  <img src="https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white" alt="Python 3.11+"/>
  <img src="https://img.shields.io/badge/Node-20+-339933?logo=node.js&logoColor=white" alt="Node 20+"/>
  <img src="https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white" alt="FastAPI"/>
  <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white" alt="React 18"/>
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/React%20Flow-12-8A2BE2?logo=react&logoColor=white" alt="React Flow"/>
  <img src="https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome MV3"/>
  <img src="https://img.shields.io/badge/Veo%203.1-i2v-FF6F00?logo=google&logoColor=white" alt="Veo 3.1"/>
  <img src="https://img.shields.io/badge/Flow-Pro%20%2F%20Ultra%20only-EA4335?logo=google&logoColor=white" alt="Flow Pro / Ultra only"/>
  <img src="https://img.shields.io/badge/Claude-CLI%20only-D97757?logo=anthropic&logoColor=white" alt="Claude CLI only"/>
  <img src="https://img.shields.io/badge/Tests-190%20passing-success?logo=pytest&logoColor=white" alt="190 passing"/>
  <img src="https://img.shields.io/badge/Status-personal%20local--only-orange" alt="Status"/>
</p>

<p align="center">
  <b>A local-only, single-user infinite-canvas workspace for AI media workflows.</b><br/>
  Compose characters, products, scenes, and videos as a directed graph. Drive generation through a Chrome extension that proxies requests to Google Flow (Veo 3.1 / GEM_PIX_2).<br/>
  Every node is reusable, every edge is a real data-dependency, every variant is independently regenerable.
</p>

> **⚠ Hard requirements — read this before cloning:**
>
> 1. **Google Flow plan: `Pro` or `Ultra` only.** Veo 3.1 i2v + GEM_PIX_2
>    are gated to paid tiers. The free tier and trial accounts cannot
>    drive video generation, so Flowboard cannot work on them. Confirm
>    your plan at [labs.google/fx](https://labs.google/fx/tools/flow)
>    before installing.
> 2. **Chrome extension is mandatory.** All generation requests are
>    proxied through `extension/` (Chrome MV3) so the agent can ride
>    your authenticated Flow session + reCAPTCHA token. Without the
>    extension loaded and connected to `labs.google/fx/tools/flow`, the
>    `▶ Generate` button does nothing.
> 3. **Claude CLI subprocess only.** Auto-prompt + vision rely **only**
>    on the [**Claude CLI**](https://docs.claude.com/claude-code/install)
>    shelled out as a local subprocess — Flowboard does not use the
>    Anthropic API, OpenAI, Gemini, or any cloud LLM endpoint. Your
>    existing Claude subscription does the work.

<p align="center">
  <a href="#why">Why</a> ·
  <a href="#showcase">Showcase</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#features">Features</a>
</p>

---

## Demo

<p align="center">
  <a href="docs/assets/flowboard-intro.mp4">
    <img src="docs/assets/flowboard-intro.gif" alt="Flowboard end-to-end walkthrough" width="720" />
  </a><br/>
  <sub>End-to-end walkthrough — refs → composed image → multi-source i2v. Click for full-quality MP4.</sub>
</p>

---

## Why

E-commerce video creative is repetitive: same model, same product, many
scenes, many short clips. Building it by hand in a generic Veo / Imagen UI
means re-uploading the same character ref every time, re-typing the same
"young Korean woman in the cream cropped tee" prompt every time, and
losing track of which 4-variant generation came from which source still.

Flowboard treats the workflow as a graph:

- **Refs are nodes** — upload a character once, upload a product once.
- **Composed shots are nodes** — `(Character) + (Product) → Image`.
- **Videos are nodes** — `(Image) → Video` via i2v, with multi-source batch
  so a 4-variant image spawns 4 videos in one click.
- **Prompts are auto-synthesised** from upstream context (Claude CLI
  vision → describes each ref → a downstream generator gets the brief
  spliced into a fashion-editorial prompt).

The result: one source-of-truth canvas for an entire campaign.

---

## Showcase

The graph below is a real export from a board in this project — two ref
nodes (`#op4v` product, `#0p1u` model) feeding three scene compositions
and three downstream videos. Every image and clip below was rendered by
the pipeline in this repo.

<p align="center">
  <img src="docs/assets/canvas-overview.png" alt="Flowboard canvas — real board export" width="100%" /><br/>
  <sub>The actual canvas in the app: 2 refs (left) → studio composition <code>#qowj</code> (centre) → scene-variant images (autumn / Seoul / Myeongdong) → 3 video nodes with 4-up i2v variant grids (right).</sub>
</p>

```mermaid
graph LR
    A[#op4v Visual asset<br/>cream The Famous tee]:::ref
    B[#0p1u Character<br/>Korean female model]:::ref
    C[#qowj Image<br/>studio composition]
    D[#nkov Image<br/>autumn road · 4 variants]
    E[#l7qd Image<br/>Seoul street · 4 variants]
    F[#xky5 Image<br/>Myeongdong dusk · 4 variants]
    G[#sncj Video<br/>studio motion]:::video
    H[#bwr4 Video<br/>autumn motion · 4 variants]:::video
    I[#uv1p Video<br/>Seoul motion · 4 variants]:::video

    A --> C
    B --> C
    C --> D
    C --> E
    C --> F
    D --> H
    E --> I
    C --> G

    classDef ref fill:#1d4d2e,stroke:#5db97a,color:#fff;
    classDef video fill:#2b1d4d,stroke:#7c5cff,color:#fff;
```

### Layer 0 — references (one-time setup)

<table>
<tr>
<td align="center" width="50%">
  <img src="docs/assets/visual-asset-tshirt.webp" alt="Visual asset — t-shirt" width="320" /><br/>
  <sub><b>#op4v · Visual asset</b><br/>Cropped boxy short-sleeve tee in cream ribbed cotton with brown "The Famous" centre-chest embroidery.</sub>
</td>
<td align="center" width="50%">
  <img src="docs/assets/character-model.jpg" alt="Character — Korean female model" width="320" /><br/>
  <sub><b>#0p1u · Character</b><br/>Studio portrait headshot, neutral closed-mouth expression — generated from gender + nationality presets, anchored for downstream identity consistency.</sub>
</td>
</tr>
</table>

### Layer 1 — composed studio shot

<p align="center">
  <img src="docs/assets/composition-base.jpg" alt="Image #qowj — composition" width="640" /><br/>
  <sub><b>#qowj · Image</b> — auto-prompt from upstream briefs: "Editorial photo, model engaging the camera with direct eye contact, both hands tucked in pockets, knees-up framing, neutral studio backdrop." 4 pose-distinct variants generated in one batch.</sub>
</p>

### Layer 2 — environment-aware variants

The synth detects scene context from each new image's brief and switches
motion vocabulary (street / studio / café / outdoor). Same character + same
product, three different worlds:

<table>
<tr>
<td align="center" width="33%">
  <img src="docs/assets/composition-autumn.jpg" alt="Autumn variant" width="280" /><br/>
  <sub><b>#nkov</b> · autumn mountain road, traditional Korean pavilion, red maple foliage</sub>
</td>
<td align="center" width="33%">
  <img src="docs/assets/composition-seoul-street.jpg" alt="Seoul street" width="280" /><br/>
  <sub><b>#l7qd</b> · Seoul street, food stalls, Korean signage</sub>
</td>
<td align="center" width="33%">
  <img src="docs/assets/composition-myeongdong.jpg" alt="Myeongdong dusk" width="280" /><br/>
  <sub><b>#xky5</b> · Myeongdong dusk, red-canopied stalls, Olive Young signage</sub>
</td>
</tr>
</table>

### Layer 3 — image-to-video (Veo 3.1 i2v)

Camera is locked-off (e-commerce default — keeps the product fully framed
the whole clip); the model performs a **time-coded 2–3 beat editorial
pose-shift** within the 8 seconds. (GitHub renders MP4 inline only when
hosted on its CDN, so we ship looping GIFs in the README — full-quality
MP4s live in [`docs/assets/`](docs/assets/).)

<table>
<tr>
<td align="center" width="33%">
  <img src="docs/assets/video-base.gif" alt="Studio motion video" width="280" /><br/>
  <sub><b>#sncj</b> · studio motion · half-step → glance → hair-tuck<br/><a href="docs/assets/video-base.mp4">▶ MP4</a></sub>
</td>
<td align="center" width="33%">
  <img src="docs/assets/video-autumn.gif" alt="Autumn motion video" width="280" /><br/>
  <sub><b>#bwr4</b> · autumn road · pivot → pocket → camera smirk<br/><a href="docs/assets/video-autumn.mp4">▶ MP4</a></sub>
</td>
<td align="center" width="33%">
  <img src="docs/assets/video-seoul.gif" alt="Seoul motion video" width="280" /><br/>
  <sub><b>#uv1p</b> · Seoul daylight · half-step → over-shoulder glance → hand in pocket<br/><a href="docs/assets/video-seoul.mp4">▶ MP4</a></sub>
</td>
</tr>
</table>

> All three videos were synthesised from a single click each: the
> auto-prompt reads the upstream image's `aiBrief`, picks scene-matched
> motion vocab, and locks the camera to keep the cropped tee in frame for
> the full clip.

---

## How it works

The mental model — read this once and the rest of the UI is obvious.

### 1. Refs are nodes you set up once

Two node types act as **anchors** for the rest of the graph:

| Node | Purpose | How to populate |
|------|---------|-----------------|
| **Character** | A person whose identity you want to keep stable across many shots. | Generate from gender + nationality presets (Nam / Nữ × VN / JP / KR / CN / TH / US / FR), or upload your own portrait. The synth hard-anchors it to a frontal, closed-mouth, neutral-expression studio headshot — Veo i2v can't keep identity stable from a smiling-with-teeth source. |
| **Visual asset** | A product / garment / object that needs to appear in scenes. | Upload (file or URL) or generate from a prompt. Inline `Refine` button uses Flow's `edit_image` to iterate without losing the original. |

Each ref node gets an `aiBrief` automatically (Claude vision describes the
image once, persists the description on the node). Downstream auto-prompt
walks upstream and pulls these briefs as context.

### 2. Composition is just connecting nodes

To build a composed image, drop an **Image** node and wire upstream refs
into it. Click `Generate` (or just press Enter with the prompt empty):

```
[Character #ujr1]  ───►
                        \
[Visual asset #sqpi] ───► [Image #target]
                        /
[Image #other-ref] ───►
```

All upstream `mediaId`s are fed to Flow as `IMAGE_INPUT_TYPE_REFERENCE`
inputs. The auto-prompt synth (`/api/prompt/auto-batch`) asks Claude to
compose **N pose-distinct prompts** in a single LLM call when you ask for
multiple variants — so 4 variants don't all collapse to the same
"hand-on-hip" stance. The prompt template is fashion-editorial style:
direct gaze, neutral closed-mouth, three-quarter angle, hand gesturing
toward the garment, knees-up framing.

### 3. Image → Video via Veo i2v

A **Video** node takes a single upstream Image. Connect it, click
`Generate`, pick:

- **Camera** = `Static` (default, e-commerce-safe — locked-off frame, no
  zoom or pan, product never crops out) or `Dynamic` (synth picks
  subtle dolly / pan based on scene).
- **Source variants** = checkbox per upstream variant + `All / None`
  bulk action. If the upstream image has 4 variants and you tick all 4,
  the dispatcher batches **one i2v op per variant** in a single Flow
  call — 4 source stills → 4 distinct videos.

The motion synth uses time-coded beats (`0–3s: …`, `3–6s: …`, `6–8s: …`)
so the model performs an editorial pose-shift sequence inside the 8 s
clip — never a frozen statue, never an open-mouth smile.

### 4. Auto-prompt is environment-aware

The synth reads the source still's `aiBrief` and switches motion
vocabulary based on detected scene:

| Scene type | Motion vocab |
|------------|-------------|
| Studio / plain backdrop | hand-on-hip, brush sleeve, head tilt, engage camera |
| Street / city / sidewalk | half-step forward, hair tuck, glance over shoulder, hand in pocket, smirk |
| Café / interior | sip from cup, lean back, glance toward window |
| Beach / nature / outdoor | hair flutter in breeze, slow exhale, look toward horizon |

A studio shot gets editorial poses; a NYC-street shot gets walk-and-glance
motion. No code branches — Claude detects the keyword and picks the
matching vocab from the system prompt.

---

## Architecture

```
┌──────────────────────┐    ┌────────────────────┐    ┌──────────────────────┐
│  Chrome MV3 ext      │◄───┤  FastAPI agent     ├───►│  SQLite (storage/)   │
│  - content script    │ WS │  127.0.0.1:8100    │    │  Board, Node, Edge,  │
│  - injected MAIN     │ ws │  + worker queue    │    │  Request, Asset,     │
│  - CDN URL allow     │9222│  + WS server :9222 │    │  Plan, ChatMessage,  │
│  - Captcha bridge    │    │  + Claude CLI      │    │  BoardFlowProject    │
└──────────────────────┘    └─────────┬──────────┘    └──────────────────────┘
        ▲                             │
        │                             ▼
        │                   ┌────────────────────┐
        └───── Google Flow  │  React + Vite      │
              labs.google   │  ReactFlow canvas  │
              (i2v / image) │  Zustand store     │
                            │  127.0.0.1:5175    │
                            └────────────────────┘
```

- **Frontend** — Vite + React 18 + ReactFlow 12 + Zustand 5 + TypeScript
  strict. Renders the infinite canvas, dialogs, sidebars. No direct
  calls to Google Flow.
- **Agent** — FastAPI + SQLModel + SQLite. Owns the board state, runs
  an in-process worker queue that proxies all generation requests
  through the extension, and shells out to the Claude CLI for vision +
  auto-prompt synthesis.
- **Extension** — Chrome MV3. Lives on `labs.google/fx/tools/flow`,
  intercepts Flow's API calls (multimodal-fetch in MAIN world for the
  reCAPTCHA token), proxies them over a localhost WebSocket so the
  agent never has to touch the browser cookie jar directly.
- **Storage** — local-only. SQLite for graph + history, a
  `storage/media/` folder for cached image / video bytes (lazy-fetched
  from Flow's signed CDN URLs and re-served from the agent so they
  outlive the 1-hour signed URL TTL).

---

## Quickstart

### Requirements

| Dependency | Why |
|------------|-----|
| **Python 3.11** | Agent runtime (FastAPI + SQLModel) |
| **Node 20+** | Frontend dev server (Vite) |
| **Chrome / Chromium** | **Mandatory** — hosts the MV3 extension that proxies every Google Flow API call. The agent has zero direct path to Flow without it. |
| **Claude CLI** on `PATH` | Vision describe + auto-prompt synth (no API key — uses your existing Claude subscription). [Install](https://docs.claude.com/claude-code/install) |
| **Google Flow `Pro` or `Ultra` plan** at [`labs.google/fx/tools/flow`](https://labs.google/fx/tools/flow) | **Free tier and trial accounts will not work.** Veo 3.1 i2v + GEM_PIX_2 image gen are gated to paid plans. |

> **Windows:** Use [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install). All commands assume a Unix shell.

### One-line setup (optional)

If you have `make` installed, the repo ships shortcut targets that wrap
Steps 2 + 3:

```bash
make install        # agent venv + frontend deps (uses uv if available, else pip)
make install-dev    # same, but adds ruff + pytest extras
make update         # upgrade agent + frontend deps in place
make agent          # run FastAPI on :8100
make frontend       # run Vite on :5175
```

`uv` is auto-detected (~10× faster installs). Install it once with
`curl -LsSf https://astral.sh/uv/install.sh | sh`, or skip it and the
Makefile falls back to stdlib `venv` + `pip`. Step 1 (loading the Chrome
extension) still has to be done manually.

### Step 1 — load the Chrome extension

```bash
git clone https://github.com/<your-fork>/flowboard.git
cd flowboard
```

1. Open `chrome://extensions/` → enable **Developer mode** (top-right).
2. Click **Load unpacked** → pick the `extension/` folder in this repo.
3. Open a tab to <https://labs.google/fx/tools/flow> and sign in.
4. The extension's icon should turn coloured once it captures a fresh
   Flow auth token (~5 s).

### Step 2 — start the agent

```bash
cd agent
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt

# `--timeout-graceful-shutdown 2` keeps `--reload` snappy when you save
# a Python file — without it, uvicorn waits forever for the WS to drain.
.venv/bin/uvicorn flowboard.main:app --reload --port 8100 \
  --timeout-graceful-shutdown 2
```

Smoke-test:

```bash
curl http://127.0.0.1:8100/api/health
# {"ok":true,"extension_connected":true,"ws_stats":{"connected":true,"flow_key_present":true,...}}
```

### Step 3 — start the frontend

```bash
cd frontend
npm install
npm run dev
# → http://localhost:5175
```

Open the URL. The first board ("Untitled") auto-creates if the DB is
empty. Add a Character node, generate it, drop a Visual asset, drop an
Image, wire them up, click **▶ Generate** — the full demo above is
about 15 minutes of clicking.

### Run tests

```bash
# Agent
cd agent && .venv/bin/python -m pytest -q
# 190 passed

# Frontend
cd frontend && npx tsc -p . --noEmit && npx vite build
```

---

## Features

### Ref-style nodes

- **Character** — generate via gender + nationality preset chips, or
  upload your own headshot. Hard-anchored to a frontal, closed-mouth,
  neutral-expression portrait so Veo i2v keeps identity stable across
  every downstream clip.
- **Visual asset** — upload (file / URL) or generate. Refine in-place
  with a different prompt (Flow `edit_image`, BASE_IMAGE preserved,
  optional reference list).

### Composition nodes

- **Image** — multi-ref aware. Connect any number of upstream
  characters, visual assets, or other images; all of them flow in as
  Flow's `IMAGE_INPUT_TYPE_REFERENCE` inputs.
  - 1–4 variants per gen, each with its own pose-distinct prompt
    (Claude rotates through an 8-stance pool per variant — never two
    "hand-on-hip" variants in the same gen).
  - Default aspect ratio inherits from upstream node; mismatched
    upstream aspects fall back to 9:16.
- **Video** — image-to-video via Veo. **Multi-source i2v**: a 4-variant
  upstream image dispatches a single batch with one item per variant →
  one video per source. Or pick a subset (toggleable thumbnails +
  All / None bulk action).
  - Camera = `Static` (locked-off, e-commerce default) or `Dynamic`
    (synth picks dolly / pan / micro-shift to fit the scene).
  - Motion synth uses time-coded beats so the model performs an
    editorial 2–3 pose-shift sequence inside the 8s clip — never a
    frozen statue.

### Auto-prompt synthesis

- Vision describes each new asset (Claude CLI multimodal attachments) →
  saved as `aiBrief` on the node.
- Downstream gen with empty prompt → `/api/prompt/auto` walks upstream
  edges, gathers briefs, asks Claude to compose a prompt that matches
  the scene + showcases the product.
- For multi-variant gens, `/api/prompt/auto-batch` returns N
  pose-distinct prompts in a single LLM call.

### Workflow ergonomics

- **Drop-add popover** — drag an edge into empty canvas, popover at the
  drop point with `Image` / `Video` quick-add → new node + auto-wired
  edge.
- **Easy edge editing** — click an edge to select (accent ring + glow),
  Backspace / Delete to remove. 24 px transparent hit-slop so edges are
  forgiving to grab.
- **Clone variant** — `New variant +` in the result viewer creates a
  sibling node with identical upstream connections, prefills the
  prompt, opens the gen dialog.
- **Project sidebar** — multiple boards on the same agent, each with
  its own Flow project mapping. Rename / delete with cascade (clears
  all child rows: nodes, edges, requests, assets, plans, runs).

---

## Repo layout

```
agent/                  FastAPI service (Python 3.11)
  flowboard/
    routes/             HTTP endpoints (boards, nodes, edges, requests,
                        upload, vision, prompt, plans, …)
    services/           Flow SDK, Claude CLI wrapper, prompt synth,
                        vision describe, pipeline executor
    worker/             In-process queue (gen_image, gen_video,
                        edit_image, upload_image)
    db/                 SQLModel definitions
  tests/                190+ pytest tests

frontend/               Vite + React + ReactFlow
  src/
    canvas/             Board.tsx, NodeCard.tsx, AddNodePalette.tsx
    components/         GenerationDialog, ResultViewer, ProjectSidebar,
                        ChatSidebar, Toolbar, Toaster
    store/              Zustand: board, generation, pipeline
    api/                client.ts, autoBrief.ts

extension/              Chrome MV3 (content script + injected MAIN)
docs/                   Static assets (this README, screenshots, demo media)
storage/                Local cache + SQLite (gitignored)
```

---

## Status

Personal local-only tool. **190 / 190 tests passing** (agent), tsc
clean (frontend). Caveats:

- ⚠ **Google Flow plan must be `Pro` or `Ultra`.** Free tier and trial
  accounts have no access to Veo 3.1 i2v / GEM_PIX_2 — every generation
  call will fail.
- ⚠ **Chrome extension must be loaded and connected.** The agent does
  not talk to Flow directly — all i2v / image / edit requests are
  proxied through `extension/` over a localhost WebSocket. No
  extension → no generation.
- ⚠ HMAC-secured WS (`X-Callback-Secret` per agent boot) — single
  loopback only, not multi-user.
- ⚠ Google Flow rate limits still apply within your paid tier.
- ⚠ Veo / Imagen content filters
  (`PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED`,
  `PUBLIC_ERROR_AUDIO_FILTERED`) — surfaced verbatim in the
  failed-request error so the user can diagnose / iterate.
- ⚠ Auto-prompt + vision require the `claude` CLI on `PATH`. Without
  it, the `Generate` button still works if you type your own prompt.

## Related

- [`crisng95/flowkit`](https://github.com/crisng95/flowkit) — the same
  Chrome-extension-bridge approach to Google Flow, but for **YouTube
  story videos** (multi-scene, narration, thumbnails). Flowboard
  borrows the bridge architecture.

## License

MIT (proposed — license file pending).

---

## Credits

Generated media in this README was produced through the pipeline using
[Google Flow](https://labs.google/flow). Auto-prompt + vision synthesis
runs through [Claude](https://claude.ai) via the local CLI.

---

## Community & Support

<p align="center">
  <a href="https://www.facebook.com/groups/flowkit.flowboard.community">
    <img src="https://img.shields.io/badge/Join%20the%20Community-FlowKit%20%26%20Flowboard%20on%20Facebook-1877F2?style=for-the-badge&logo=facebook&logoColor=white" alt="Join the FlowKit & Flowboard Facebook Group" />
  </a>
</p>

The shared community for both **FlowKit** and **Flowboard**. Drop in to:

- Post the shots and clips you've generated
- Share node-graph patterns, vibe presets, and prompt recipes that work for you
- Ask for help when an output isn't matching what you imagined
- Request features and report bugs you've hit in the wild
- Trade tips on Google Flow plan limits, Veo i2v behaviour, and Claude CLI setup

→ **[facebook.com/groups/flowkit.flowboard.community](https://www.facebook.com/groups/flowkit.flowboard.community)**
