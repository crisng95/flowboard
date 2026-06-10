# Requirements — Fix Omni Flash video batch fan-out (x3 produces only 1 video)

## Bug summary

When two list nodes are connected to a Video node — a prompt list containing 3 prompts
and an image list containing 3 images — and the user selects **x3** and runs **Generate
video**, only **1 video** is produced instead of 3. The equivalent setup for **image**
generation correctly produces 3 outputs.

## Bug condition

The collapse happens in the frontend dispatch layer, not the backend.

- File: `frontend/src/store/generation.ts`
- Function: `dispatchGeneration`, video branch (`kind === "video"`)
- Sub-branch: the **Omni Flash** path (`if (isOmni)`, ~lines 1451–1481)

In that branch the code:

1. Discards the batch arrays the caller already built (`opts.prompts`,
   `opts.sourceMediaIds`).
2. Re-derives inputs via `getVideoNodeInputs(rfId)` and bundles every upstream image into
   a single `ref_media_ids` list.
3. Issues exactly **one** `gen_video_omni` request with a single `prompt`.

Result: regardless of the x3 multiplier or how many prompt/image pairs exist, Omni Flash
emits a single video conditioned on all images bundled together.

By contrast:
- The Veo branch (the `else` after `isOmni`) forwards `start_media_ids` + `prompts`, and
  the backend `gen_video` SDK fans out one operation per source.
- The backend `gen_video_omni` SDK (`agent/flowboard/services/flow_sdk.py`) and worker
  (`agent/flowboard/worker/processor.py`) **already support** batch fan-out via
  `start_media_ids` + `prompts` — one operation per source image. The frontend simply
  never sends those fields for Omni.

## Confirmed scope

- Video model in use when the bug was observed: **Omni Flash** (`omni_flash`).
- The default video model is `veo`, so this fix targets the Omni Flash path specifically.
- Backend changes are expected to be unnecessary; the SDK/worker batch contract exists.
  Any backend touch is limited to verification.

## Requirements

### Requirement 1 — Omni Flash honors the batch fan-out

**User story:** As a user connecting a 3-prompt list and a 3-image list to a Video node
with x3 selected, I want Omni Flash to generate 3 distinct videos, so that batch video
generation matches the behavior of batch image generation.

#### Acceptance criteria

1. WHEN the Video node is set to Omni Flash AND the caller supplies
   `opts.sourceMediaIds` with length N (> 1) THEN the dispatch SHALL produce N video
   operations (one per source image) rather than a single request.
2. WHEN `opts.prompts` is provided alongside `opts.sourceMediaIds` THEN each video
   operation i SHALL use `prompts[i]`, falling back to the shared `opts.prompt` when
   `prompts[i]` is missing or empty.
3. WHEN the Omni Flash dispatch forwards a batch THEN it SHALL pass `start_media_ids`
   (and `prompts` when present) to the `gen_video_omni` request params, consistent with
   what the backend SDK already consumes.
4. The batch pairing SHALL respect the node's `batchMode` (`zip` vs `cross`) exactly as
   the upstream video-node fan-out already computes `finalPrompts` / `finalRefs`.

### Requirement 2 — Single-input Omni Flash behavior is preserved

**User story:** As a user generating a single Omni Flash video from one or more
ingredient images (no batch), I want the existing single-clip behavior to remain
unchanged, so that non-batch generation is not regressed.

#### Acceptance criteria

1. WHEN no batch arrays are supplied (`opts.sourceMediaIds` empty/absent) THEN the Omni
   Flash dispatch SHALL continue to bundle ingredients into a single `ref_media_ids`
   request producing one video (current behavior).
2. WHEN Omni Flash has zero usable ingredients THEN the existing validation error
   ("Omni Flash needs at least one ingredient…") SHALL still fire.
3. The shared-reference "ingredient" semantics (multiple images conditioning one clip)
   SHALL remain available for the non-batch case.

### Requirement 3 — Veo path remains correct and visible alignment is preserved

**User story:** As a user, I want the Veo path and the result placeholders to keep working
so the fix is isolated to the Omni Flash regression.

#### Acceptance criteria

1. WHEN the Video node uses Veo THEN dispatch behavior SHALL be unchanged.
2. WHEN N videos are dispatched as a batch THEN the node's `variantCount` and result-slot
   alignment SHALL reflect N variants, consistent with the existing positional
   `media_ids` / `slot_errors` contract returned by the worker.

## Out of scope

- Changing the input-handle wiring requirement (start-image vs references). The observed
  bug is Omni Flash specific; handle-asymmetry on the Veo path is noted but not addressed
  here unless verification shows it blocks Requirement 1.
- Backend SDK/worker changes beyond verification that the existing batch contract works.
