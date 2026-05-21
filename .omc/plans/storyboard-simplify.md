# Plan — Simplify Storyboard to a Template-Prompt Image Node

**Status**: Draft awaiting approval
**Owner**: anh Tuấn
**Target release**: 1.2.15
**Authors**: Claude (Opus 4.7)

---

## 1. Goal

Strip Storyboard from a multi-shot continuity-tree generator down to a
**single-image generator with a locked prompt template** — UX-equivalent to a
regular image node, but the prompt is auto-wrapped so Flow renders a single
composite grid that visually narrates the user's topic.

### New behavior

- User opens Storyboard dialog → 2 inputs:
  - **Topic** (free text): e.g. `Rùa và Thỏ`
  - **Grid**: `2x2` or `3x3`
- Variant count: **1-4** (same picker as image node)
- Source refs: from upstream edges (same flow as image node — character / image / visual_asset)
- Output: **up to 4 full-composite storyboard images**, each tile is one full grid

### Locked prompt template

```
Create visual storyboard for "<TOPIC>" as SINGLE IMAGE arranged in a <N>x<N> layout (<N> rows, <N> columns)
```

`<TOPIC>` = user input. `<N>` = 2 or 3. No auto-prompt synthesis runs for Storyboard.

### Why this matters

The current continuity-tree implementation has the bugs catalogued in the
2026-05-21 review (grid clamp, partial-status misdiagnose, retry node_status
stale, untested cancel path, deferred auto-cascade). Half-fixing each adds
complexity. The user has decided the multi-shot architecture is the wrong
mental model for what they want — a single composite IS the storyboard,
generated as one image. Reducing to that contract removes ~500 LOC of
dispatch + state code and inherits the well-tested image pipeline.

---

## 2. Requirements & Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| AC1 | Storyboard dispatches via the **existing `gen_image` handler** — no new backend handler | Inspect `Request.type` in DB for a new Storyboard request → must be `gen_image` |
| AC2 | Dialog shows only: Topic textarea, Grid radio (2x2/3x3), Variants picker (1-4), Refs chip list (auto) | Manual UI walkthrough |
| AC3 | Prompt sent to Flow = exact template literal with user topic + chosen N | Snapshot test on prompt builder fn |
| AC4 | Up to 4 variants render as image tiles in `StoryboardBody` (reuses `ImageBody` rendering) | Manual: pick 4 variants, observe 4 tiles |
| AC5 | Existing pre-1.2.15 Storyboard nodes (with old `shots[]` data) **do not crash** the canvas — they render an empty tile grid and reopen the new dialog cleanly | Load a pre-existing storyboard node from DB |
| AC6 | `gen_storyboard` and `retry_storyboard_shot` are removed from `_DEFAULT_HANDLERS`; the activity feed still renders any historic finished rows with those types (no schema migration) | Open activity bell with one of those historic rows present |
| AC7 | Refs flow exactly like image node — upstream image/character/visual_asset edges become `imageInputs` on the Flow request | Network log inspection |
| AC8 | `pytest` + `tsc --noEmit` green after deletion of storyboard test suites | CI gates |
| AC9 | No reference in code or types to `narrativeSeed`, `shotCount`, `parents`, `parentShotIdx`, or `Shot` shape after the change | `grep` check listed in §6 |
| AC10 | `"partial"` status removed from `NodeStatus` union (storyboard was the only producer) | Grep check |

---

## 3. Non-Goals

- **Migration script** for old `shots[]` data. The handful of test nodes either keep their old `mediaIds[]` (first variant only) or get re-generated. Acceptable trade-off for an early-stage tool the user is iterating on.
- **Auto-prompt synthesis** for Storyboard. Hard template only. (`auto_prompt_storyboard` is deleted.)
- **Per-tile re-roll** on the 4 variants. If user wants different output, click Generate again. (Same as current image node.)
- **Saving a single tile cell of the composite as a reference**. The entire composite is the unit; user saves the whole image via the existing ★ Save button. Cropping is out of scope.
- **Mixed grid sizes** like 2x3 or 1x4. Only square grids (2x2, 3x3). Keeps the template trivial; user explicitly asked for these two only.

---

## 4. Design Decisions (locked)

### D1 — Dispatch reuses `gen_image`, no new handler
Storyboard is now image-equivalent at the backend. Frontend builds the
template-wrapped prompt in `dispatchGeneration` and calls the existing
`gen_image` flow path. Less code, fewer test surfaces, fewer bug
opportunities than a thin wrapper handler.

### D2 — Prompt template lives in **one** constant on the frontend
File: `frontend/src/lib/storyboardPrompt.ts` (new, ~12 LOC).
```ts
export function buildStoryboardPrompt(topic: string, grid: "2x2" | "3x3"): string {
  const n = grid === "2x2" ? 2 : 3;
  return `Create visual storyboard for "${topic}" as SINGLE IMAGE arranged in a ${n}x${n} layout (${n} rows, ${n} columns)`;
}
```
Centralised so the user can tweak wording later without grep-and-replace.

### D3 — Default grid = `3x3`
Matches the user's example ("Rùa và Thỏ") and produces the richer composite.
Persisted on `node.data.storyboardGrid`. Falls back to `3x3` when missing
(true for new nodes and for the pre-1.2.15 nodes that don't have the field).

### D4 — `StoryboardBody` becomes a thin wrapper around `ImageBody`
Render reuse: pass the node through to `ImageBody`. Optional: overlay a small
`3x3` / `2x2` badge in the corner of the tile so the user remembers which
layout this node is configured for. Decision: include the badge. ~5 LOC.

### D5 — No "Storyboard" `"partial"` status — remove the union member
Storyboard was the only producer. `NodeStatus = "idle" | "queued" | "running" | "done" | "error"` after this change. Three files touched.

### D6 — Variant count picker is the existing image picker
The component already supports 1-4 with the same UI affordance. Storyboard
branch just renders it unconditionally (no `if (isStoryboard) hide` logic).

### D7 — Topic input is the node's `aiBrief` field
Reuses the existing free-text input convention used by character / image nodes.
No new schema column needed.

---

## 5. Implementation Steps

### 5.1 Backend deletes (one commit)

**File: `agent/flowboard/worker/processor.py`**
- Delete `_handle_gen_storyboard` (lines ~511-703)
- Delete `_handle_retry_storyboard_shot` (lines ~706-822)
- Delete `_propagate_blocked` (~455-470), `_aggregate_node_status`, `_persist_storyboard_progress` helpers
- Remove `"gen_storyboard"` and `"retry_storyboard_shot"` keys from `_DEFAULT_HANDLERS` (~processor.py:1021-1023)

**File: `agent/flowboard/services/prompt_synth.py`**
- Delete `_STORYBOARD_SUFFIX` template
- Delete `auto_prompt_storyboard()`
- Keep `"Storyboard"` in `_REF_SOURCE_TYPES` — so downstream image/video nodes still receive Storyboard outputs as refs (the composite IS an image)

**File: `agent/flowboard/routes/prompt.py`** (if it has a route for storyboard synth)
- Remove any endpoint or branch that calls `auto_prompt_storyboard`

**Tests**
- Delete `tests/test_processor_storyboard.py` (if exists)
- Delete any `test_prompt_synth_storyboard*` cases — search & purge

### 5.2 Frontend type & schema (one commit)

**File: `frontend/src/store/board.ts`**
- `FlowboardNodeData`:
  - Remove `shots?: Shot[]`
  - Remove `shotCount?: number`
  - Remove `narrativeSeed?: string`
  - Add `storyboardGrid?: "2x2" | "3x3"`
- `NodeStatus` union: remove `"partial"`
- Delete `Shot` interface entirely
- Any `addStoryboardNode` defaults must set `storyboardGrid: "3x3"`

**File: `frontend/src/api/client.ts`**
- `NodeStatus`: remove `"partial"`
- Remove `Shot`-related types if any

### 5.3 Frontend dispatch (one commit)

**File: `frontend/src/lib/storyboardPrompt.ts`** (new, ~15 LOC)
- Export `buildStoryboardPrompt(topic, grid)` as in D2

**File: `frontend/src/store/generation.ts`**
- Delete `dispatchStoryboard` function (~660-820)
- Delete `retryStoryboardShot` function
- In `dispatchGeneration`: storyboard branch now reads `node.data.aiBrief` (topic) + `node.data.storyboardGrid` (grid), calls `buildStoryboardPrompt()`, and falls through to the existing image dispatch path with `kind="gen_image"`, the wrapped prompt, and `variantCount` from settings
- Remove any `"gen_storyboard"` / `"retry_storyboard_shot"` request-type literals
- Remove `partial` from the status union literal at line 771 and the `partial` aggregation logic around lines 949-962

### 5.4 Frontend dialog (one commit)

**File: `frontend/src/components/GenerationDialog.tsx`**
- Storyboard branch (currently shows shot-count + narrative-seed):
  - Remove shot-count picker
  - Remove narrative-seed textarea
  - Add grid radio: `2x2` / `3x3` (binds to `node.data.storyboardGrid`)
  - Topic textarea = `node.data.aiBrief` (or rename label to "Topic" for clarity)
  - Reuse the image branch's variant-count picker (1-4)
  - Reuse the image branch's source refs chip list
- On Generate: dispatch builds prompt via `buildStoryboardPrompt`, calls the image dispatch path, with the locked prompt that overrides any auto-synth
- Remove `isStoryboard`-specific dispatch branch — fold into image

### 5.5 Frontend rendering (one commit)

**File: `frontend/src/canvas/NodeCard.tsx`**
- Delete `StoryboardBody` (~1430-1528 with continuation badges + retry per-shot)
- Replace with new minimal `StoryboardBody`:
  - Calls `ImageBody` (or shares its rendering helpers)
  - Adds a small corner badge: `3×3` or `2×2`
- Remove `isPartial` logic at line ~967 (was storyboard-only)
- Remove the `Math.min(shots.length, 4)` grid clamp (line ~1433) since we no longer have a shots array

### 5.6 Delete unused exports (sanity sweep)

Grep & remove dead helpers:
```
grep -rn "Shot\b" frontend/src   # delete interface + any imports
grep -rn "shotCount\|narrativeSeed\|parentShotIdx" frontend/src agent/flowboard
grep -rn "auto_prompt_storyboard\|_STORYBOARD_SUFFIX" agent/flowboard
grep -rn "gen_storyboard\|retry_storyboard_shot" agent/flowboard frontend/src
grep -rn "dispatchStoryboard\|retryStoryboardShot" frontend/src
```
Every hit after the edits should be in the changelog of this PR.

### 5.7 Plan-doc retirement

Move `.omc/plans/storyboard-image-node.md` → `.omc/plans/_archive/storyboard-image-node.md` (the architecture is superseded). Optional: add a 1-line header to the archived doc pointing at this plan.

---

## 6. Verification Plan

### Manual UI
1. Create a fresh Storyboard node → dialog shows Topic + Grid (3x3) + Variants (1-4) + Refs
2. Type `Rùa và Thỏ` → pick 2x2 → 4 variants → Generate
3. Watch network: payload prompt = `Create visual storyboard for "Rùa và Thỏ" as SINGLE IMAGE arranged in a 2x2 layout (2 rows, 2 columns)`
4. 4 tiles render with full 2x2 composite images
5. Connect a character node → Generate → ref media_id appears in the request as `imageInputs`
6. ★ Save one variant to References library → it shows up in the sidebar like any image
7. Reload page → Storyboard node opens cleanly, dialog reflects saved topic + grid

### Edge — pre-existing nodes
1. Find one Storyboard node from before 1.2.15 in dev DB
2. Reload canvas → no crash, tile grid empty (old `shots[]` is just ignored)
3. Open dialog → Topic empty, Grid defaults to 3x3 → user can regenerate

### Test gates
- `cd agent && .venv/bin/python -m pytest tests/ -q` → all green (after deleting storyboard tests)
- `cd frontend && npx tsc --noEmit` → clean
- `grep -rn "Shot\|shotCount\|narrativeSeed\|parentShotIdx\|partial\|gen_storyboard\|retry_storyboard_shot\|dispatchStoryboard\|retryStoryboardShot\|auto_prompt_storyboard" frontend/src agent/flowboard` → only legacy hits in `.omc/plans/_archive/`

---

## 7. Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Existing Storyboard nodes show as empty after deploy | Low | User has only test data; documented in §3 (Non-Goals). Old node still loads fine, dialog reopens cleanly. |
| User wants a 2x3 / 3x2 / 1x4 layout later | Medium | Centralised template in `storyboardPrompt.ts` — adding a new option is a 2-line change. |
| Flow's image gen produces a 9-cell grid that's actually 9 separate generations (collage), not a single composite | Medium | Empirically test 3x3 with several topics — Imagen/Veo handle "arranged in a 3x3 layout" reliably. If output drifts to separate generations, prefix template with "as a SINGLE collage image" — already in the locked template. |
| Removing `"partial"` breaks downstream code that filters/displays by it | Low | Grep confirmed only 4 files reference it, all storyboard-specific. Removed in §5.2-5.3. |
| Historic `gen_storyboard` requests in DB cause activity-bell render error | Low | Activity feed reads `request.type` as string and renders unknown types as muted — no enum constraint. ✅ |

---

## 8. Commit / Release Plan

Six commits, atomic & reviewable:

1. `feat(storyboard): simplify to single-composite template prompt — backend` (§5.1)
2. `feat(storyboard): drop shots[] / narrativeSeed from node data; remove "partial" status` (§5.2)
3. `feat(storyboard): dispatch via gen_image with locked template prompt` (§5.3)
4. `feat(storyboard): dialog shows topic + grid + variants + refs` (§5.4)
5. `feat(storyboard): render variants via ImageBody + grid badge` (§5.5)
6. `chore(release): 1.2.15`

Tag `v1.2.15`, push origin main + tag.

---

## 9. Open Questions

None. Decisions locked in §4. If user wants any of:
- Extra grid options (2x3, 4x4, etc.)
- Auto-prompt synthesis for the topic from upstream context
- Cropping a single cell of the composite back to a sub-reference
- Per-variant retry instead of full re-Generate

→ Spike separately. They're orthogonal additions to the simplified base.

---

## 10. Approval

Awaiting anh Tuấn's `go` to start implementation. Plan is written for sequential execution (one commit per section), but §5.1 (backend deletes) and §5.2 (frontend types) can run in parallel since they don't share files.
