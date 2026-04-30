# Plan — Display model badge in node detail panel

## Requirements Summary

Show which model produced each rendered node, **inside the ResultViewer detail panel only** (NOT on the canvas node card). The detail panel already has a METADATA grid with a `model` row — make it accurate, support the new Quality tier, and style as a pill.

- **Image / character / visual_asset nodes**: `Banana Pro` (NANO_BANANA_PRO) or `Banana 2` (NANO_BANANA_2)
- **Video nodes**: `Lite` / `Fast` / `Quality` (Veo 3.1 quality tier picked at dispatch)

## Current state

`frontend/src/components/ResultViewer.tsx:79-86` — there is already a `metadataModel` calculation rendered as plain text inside the METADATA grid (line 444-446):
```ts
const metadataModel =
  data?.type === "video"
    ? settingsVideoQuality === "lite" ? "Veo 3.1 Lite" : "Veo 3.1 Fast"
    : data && ["image", "character", "visual_asset"].includes(data.type)
      ? settingsImageModel
      : "—";
```

Two issues:
1. **Reads from current settings, not from node data** — if user changes setting after gen, badge mis-states reality.
2. **Doesn't know about Quality** — only `lite`/`fast` branch; `quality` (added v1.1.3) silently shows "Veo 3.1 Fast".

## Decisions

| Decision | Default | Rationale |
|---|---|---|
| Badge placement | **Replace plain "model" value in METADATA grid with a styled pill** | Existing row label "model" is already the natural surface; just promote the value. |
| Backfill historical nodes? | **No** | Confirmed by anh. Old nodes show plain-text fallback to current settings. |
| Pill style | **Reuse `.settings-panel__badge` gradient → rename to shared `.model-badge`** | Same visual language as Settings "Ultra only" pill. |
| Show on uploaded image nodes? | **No** | `data.imageModel` is unset for uploads → falls through to plain text fallback. |
| Need backend to stamp effective model? | **No** | Tier 1 UI locks Lite + Quality (v1.1.3 shipped), so Tier 1 can never dispatch a value that triggers backend fallback. Trust `req.params` directly. |

## Acceptance Criteria

1. Open detail panel of a fresh image node generated with `imageModel = NANO_BANANA_PRO` → "model" row shows pill **Banana Pro**.
2. Toggle Settings to NANO_BANANA_2, gen another → pill **Banana 2**.
3. Tier 2 user generates video with `videoQuality = quality` → pill **Quality**.
4. Same flow with `lite` → pill **Lite**. With `fast` → pill **Fast**.
5. **Settings changed after gen**: open detail of a node generated with Pro, then switch settings to Banana 2, reopen detail → pill still says **Banana Pro** (reflects dispatch-time, not current setting).
6. Reload page → badges persist (read from `node.data`).
7. Uploaded image node detail → "model" row shows plain `"—"` (no pill).
8. Old nodes (gen before this feature) → "model" row falls back to current settings as plain text — NO pill (visually distinct so the user knows it's an estimate).
9. Pill uses same gradient + sizing as the Settings "Ultra only" badge for consistency.

## Implementation Steps

### Step 1 — Frontend: persist model on node when generation completes

File: `frontend/src/store/generation.ts`

Around lines 252-281 (the polling-done branch for image / video) and around lines 414-423 (refineImage poll), extract `image_model` / `video_quality` from `req.params` and stamp into the node data update + patch:

```ts
const stamp: Partial<FlowboardNodeData> = { mediaId, mediaIds, ... };
if (req.type === "gen_image" || req.type === "edit_image") {
  const m = req.params?.image_model;
  if (typeof m === "string") stamp.imageModel = m;
}
if (req.type === "gen_video") {
  const q = req.params?.video_quality;
  if (typeof q === "string") stamp.videoQuality = q;
}
useBoardStore.getState().updateNodeData(rfId, stamp);
patchNode(dbId, { data: stamp }).catch(() => {});
```

### Step 2 — Extend FlowboardNodeData type

File: `frontend/src/store/board.ts`

- Add `imageModel?: string` and `videoQuality?: string` to `FlowboardNodeData` interface.
- Wire up the parsers (lines 184, 237, 318) to extract `imageModel` / `videoQuality` from `n.data` on board load / refresh so reload preserves badges.

### Step 3 — Update ResultViewer: read from node data, add Quality, render pill

File: `frontend/src/components/ResultViewer.tsx`

Replace lines 79-86 with:
```ts
const IMAGE_MODEL_LABELS: Record<string, string> = {
  NANO_BANANA_PRO: "Banana Pro",
  NANO_BANANA_2: "Banana 2",
};
const VIDEO_QUALITY_LABELS: Record<string, string> = {
  lite: "Lite",
  fast: "Fast",
  quality: "Quality",
};

const metadataModel: { label: string; isBadge: boolean } = (() => {
  if (data?.type === "video") {
    if (data.videoQuality) {
      return { label: VIDEO_QUALITY_LABELS[data.videoQuality] ?? data.videoQuality, isBadge: true };
    }
    // Old node — fall back to current settings as plain text
    return {
      label: VIDEO_QUALITY_LABELS[settingsVideoQuality] ?? settingsVideoQuality,
      isBadge: false,
    };
  }
  if (data && ["image", "character", "visual_asset"].includes(data.type)) {
    if (data.imageModel) {
      return { label: IMAGE_MODEL_LABELS[data.imageModel] ?? data.imageModel, isBadge: true };
    }
    return { label: IMAGE_MODEL_LABELS[settingsImageModel] ?? settingsImageModel, isBadge: false };
  }
  return { label: "—", isBadge: false };
})();
```

Then in the metadata grid (line 444-446):
```tsx
<dt>model</dt>
<dd>
  {metadataModel.isBadge ? (
    <span className="model-badge">{metadataModel.label}</span>
  ) : (
    metadataModel.label
  )}
</dd>
```

### Step 4 — Share badge CSS

File: `frontend/src/styles.css`

- Rename `.settings-panel__badge` → `.model-badge`. Keep the same gradient, padding, font-size.

File: `frontend/src/components/SettingsPanel.tsx`

- Update class name reference from `.settings-panel__badge` → `.model-badge`.

### Step 5 — Type check + smoke test

- `cd frontend && npm run lint`
- `cd agent && .venv/bin/pytest -q` (no backend changes — should be green untouched)
- Manual: gen Pro image → "Banana Pro" pill; gen Banana 2 → "Banana 2" pill; Tier 2 gen Lite/Fast/Quality video → 3 pills; reload → persists; upload image → "—" plain text; open old node → plain text fallback.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| `req.params` shape changes break the extract | Defensive `typeof m === "string"` check; only stamp when present. |
| Old nodes' fallback might mismatch reality if user changed settings | Acceptable — they show plain text, NOT the styled pill, so the visual difference signals "estimate vs ground truth". |
| Refine image: does worker pass `image_model`? | Yes — `_handle_edit_image` reads it. Same param shape. |

## Verification Steps

1. `npm run lint` — frontend type-check passes.
2. `pytest` — backend untouched, all tests still green.
3. Generate 1 Pro + 1 Banana 2 image → 2 distinct pills.
4. Tier 2: generate Lite + Fast + Quality video → 3 distinct pills.
5. Old node detail → plain text fallback (no pill).
6. Upload-only node detail → "—".
7. Reload page → all pills persist.

## Out of scope

- Backfill historical node data with `imageModel` / `videoQuality`.
- Badge on canvas node card (anh đã reject — detail panel only).
- Click-badge-to-open-Settings.

## File touch list

- `frontend/src/store/generation.ts` — persist params model on poll completion (image, edit_image, video, refine paths)
- `frontend/src/store/board.ts` — extend FlowboardNodeData with `imageModel?` / `videoQuality?`
- `frontend/src/components/ResultViewer.tsx` — read from node data, add Quality, render pill conditionally
- `frontend/src/components/SettingsPanel.tsx` — rename badge class to `.model-badge`
- `frontend/src/styles.css` — rename `.settings-panel__badge` → `.model-badge`

**No backend changes.** 5 frontend files only.
