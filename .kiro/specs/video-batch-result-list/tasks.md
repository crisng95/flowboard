# Implementation Plan: Video Batch Result List

## Overview

This plan implements the batch-video result behavior entirely in the frontend
(`flowboard/frontend/src`). The strategy follows the design: extract three pure
logic helpers from `store/generation.ts` (`buildPlaceholderListItems`,
`buildVideoResultListItems`, `findReusableVideoResultList`) and cover them with
property-based tests (fast-check + Vitest) first, then wire them into
`runNodeDirect` (spawn the Batch_Result_List before dispatch), fill results in
the `dispatchGeneration` done-handler, force the single-video layout in
`VideoGeneratorNode.tsx`, and upgrade `ListNode.tsx` to render/play video items.

Implementation language: **TypeScript / React** (existing stack; Vitest +
fast-check already present — see `frontend/src/store/__tests__/videoBatch.test.ts`).

Property-based test tag format (per design Testing Strategy):
`// Feature: video-batch-result-list, Property {N}: {property text}`

## Tasks

- [x] 1. Extract and test pure logic helpers in `store/generation.ts`
  - [x] 1.1 Implement `buildPlaceholderListItems` and the `VideoListItem` type
    - Add and `export` `buildPlaceholderListItems(count, titles)` in `frontend/src/store/generation.ts`, returning `{ listItems, listSelectedIndexes: [], mediaIds: [], flowMediaIds: [], variantCount: count }` where `listItems` has exactly `count` entries with `kind: "video"`, `mediaId: null`, `flowMediaId: null`, `mediaUrl: null`, `mime: "video/mp4"`, `status: "pending"`, and `title` from `titles[i]`
    - Define the `VideoListItem` type (id, kind, title, text, mediaId, flowMediaId, mediaUrl, imageUrl, mime, width, height, duration, status, error) compatible with `normalizeListItemRecord`
    - Ensure each placeholder `id` is unique (e.g. `video-slot-${i}`)
    - _Requirements: 2.2, 6.2_

  - [x] 1.2 Implement `buildVideoResultListItems`
    - Add and `export` `buildVideoResultListItems(input)` in `frontend/src/store/generation.ts`, iterating positionally over `mediaIds` (no pre-filtering) so `listItems[i]` aligns with `prompts[i]`
    - For a successful slot, emit `{ id, kind: "video", title, mediaId, flowMediaId, mediaUrl, mime: "video/mp4", status: "done" }` with a unique `id` (`flowMediaId ?? mediaId ?? video-slot-${i}`)
    - For a null `mediaIds[i]` or non-null `slotErrors[i]`, emit an error item `{ kind: "video", status: "error", error: slotErrors[i], mediaId: null, title }` at the same index without shifting other slots
    - Guarantee `listItems.length === mediaIds.length` and `variantCount === mediaIds.length`; return `mediaIds`/`flowMediaIds` containing only successful slots for downstream use
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 7.3_

  - [x] 1.3 Implement `findReusableVideoResultList`
    - Add and `export` `findReusableVideoResultList(edges, videoRfId, nodes)` in `frontend/src/store/generation.ts`, returning the rfId of a `list` node connected from the Video_Node via a `source-video` edge, or `null`
    - Match only edges where `source === videoRfId` and `sourceHandle === "source-video"` whose `target` is a node of type `list`
    - _Requirements: 6.1, 6.3_

  - [x]* 1.4 Write property test: counts equal N
    - **Property 1: Số ô placeholder và số List_Item bằng N**
    - `frontend/src/store/__tests__/videoResultList.test.ts`; assert `buildPlaceholderListItems(N, ...)` and `buildVideoResultListItems(...)` both produce exactly N items with `variantCount === N`; `fc.assert(..., { numRuns: 100 })`
    - **Validates: Requirements 2.2, 3.5, 3.6**

  - [x]* 1.5 Write property test: slot/video/prompt alignment
    - **Property 2: Căn chỉnh thứ tự slot[i] ↔ video[i] ↔ prompt[i]**
    - In `videoResultList.test.ts`; for every i with non-null `mediaIds[i]`, assert `listItems[i].kind === "video"`, `listItems[i].mediaId === mediaIds[i]`, and the title corresponds to `prompts[i]`; min 100 iterations
    - **Validates: Requirements 3.1, 3.2, 3.5**

  - [x]* 1.6 Write property test: error slots keep their position
    - **Property 3: Slot lỗi giữ nguyên vị trí, không xô lệch**
    - In `videoResultList.test.ts`; generate arbitrary error-index sets (null `mediaIds[i]` or non-null `slotErrors[i]`); assert length stays N, error items land at the exact error indices with `status === "error"`, and successful slots remain at their original indices; min 100 iterations
    - **Validates: Requirements 3.3, 3.4**

  - [x]* 1.7 Write property test: non-empty and complete when N ≥ 1
    - **Property 4: Danh sách kết quả không rỗng và đầy đủ khi N ≥ 1**
    - In `videoResultList.test.ts`; for arrays of length N ≥ 1 including all-error cases, assert `listItems` is non-empty and has exactly N items; min 100 iterations
    - **Validates: Requirements 3.6, 3.7**

  - [x]* 1.8 Write property test: model independence (Veo vs Omni Flash)
    - **Property 7: Độc lập với Video_Model (Veo và Omni Flash)**
    - In `videoResultList.test.ts`; with `fc.constantFrom("veo","omni_flash")` and identical positional arrays, assert `buildVideoResultListItems` output is identical regardless of model; min 100 iterations
    - **Validates: Requirements 7.1, 7.2, 7.3**

  - [x]* 1.9 Write property test: placeholder fully replaced on reuse
    - **Property 8: Placeholder được thay thế hoàn toàn khi tái dùng**
    - In `videoResultList.test.ts`; for arbitrary old `listItems` and a new N, assert `buildPlaceholderListItems(N, ...)` returns exactly N items and contains none of the old items (full replacement, no append); min 100 iterations
    - **Validates: Requirements 6.2**

  - [x]* 1.10 Write property test: reuse detection vs create-new
    - **Property 6: Reuse thay vì tạo trùng**
    - `frontend/src/store/__tests__/findReusableVideoResultList.test.ts`; over random edge sets, assert `findReusableVideoResultList` returns a list rfId iff a `source-video` edge from the Video_Node to a `list` node exists, else `null`; min 100 iterations
    - **Validates: Requirements 6.1, 6.3**

  - [x]* 1.11 Write unit tests for builder edge cases
    - `frontend/src/store/__tests__/videoResultList.unit.test.ts`; example N=3 all-success; middle slot error (`[id0, null, id2]` + `slot_errors=[null, "blocked", null]`) → item[1] `status:"error"`, item[0]/item[2] correct positions; placeholder example (all `mediaId:null`, `status:"pending"`)
    - _Requirements: 3.3, 3.4, 3.5_

- [x] 2. Spawn Batch_Result_List before dispatch in `runNodeDirect`
  - [x] 2.1 Implement `spawnVideoResultList` I/O orchestration helper
    - Add `spawnVideoResultList(videoRfId, count, titles)` in `frontend/src/store/generation.ts`; read `boardId`/`nodes`/`edges` from `useBoardStore.getState()` and throw if `boardId === null`
    - Reuse path: use `findReusableVideoResultList` to locate an existing list; on hit, skip node/edge creation and replace its items with fresh placeholders
    - Create path: `createNode({ type: "list", ... })` positioned beside the Video_Node, then `createEdge({ kind: "video", source_handle: "source-video", target_handle: "target-video" })` (pass handles explicitly), appending to the store via `setNodes`/`setEdges`
    - Set placeholders via `buildPlaceholderListItems` → `updateNodeData(listRfId, ...)` (immediate UI) + `patchNode(listDbId, { status: "running", data })` (persist, `.catch` non-fatal); return the list rfId
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 6.1, 6.2_

  - [x] 2.2 Integrate `spawnVideoResultList` into the `hasBatchInputs` branch
    - In the `if (hasBatchInputs)` branch of `runNodeDirect`, build `titles` (`Video 1`..`Video N`) and call `spawnVideoResultList` immediately before `dispatchGeneration`
    - On failure, set `Video_Node.data` `{ status: "error", error: <explicit message> }` and `return` without dispatching
    - On success, store `batchResultListId` on `Video_Node.data` before dispatch; leave the N=1 (non-`hasBatchInputs`) path untouched so no list/edge is created
    - _Requirements: 2.1, 2.6, 2.7, 2.8, 4.2, 4.3_

  - [x]* 2.3 Write property test: N=1 does not spawn a list
    - **Property 5: N = 1 không sinh ra Batch_Result_List**
    - `frontend/src/store/__tests__/resultListGating.test.ts`; generate `upstreamPrompts`/`startMediaIds` so the batch-gating predicate is false, assert the decision is "do not create" (no node/edge call, `batchResultListId` unset); min 100 iterations
    - **Validates: Requirements 4.2, 4.3**

- [x] 3. Fill results into Batch_Result_List in the done-handler
  - [x] 3.1 Add the video result-fill branch in `dispatchGeneration`
    - In the done-handler (after the root node's `patchNode`, before the image auto-spawn block), read `batchResultListId` from the current root node; when `opts.kind === "video"` and it is set, call `buildVideoResultListItems` with the positional `mediaIds`/`flowMediaIds`/`assetIds`/`slotErrors`/`prompts`
    - Apply via `updateNodeData(batchResultListId, { status: "done", ...listData, renderedAt })` and persist via `patchNode(listDbId, ...)` (`.catch` non-fatal)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 7.1, 7.2_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Force single-video layout on Video_Node
  - [x] 5.1 Set `showVariantGrid = false` in `VideoGeneratorNode.tsx`
    - Change `showVariantGrid` (~line 309) to `false` so the node always uses the single-video layout and only shows the first video (`mediaIds[0]`/`mediaId`), matching ImageGeneratorNode
    - Verify the hover-play `useEffect` stays active for `mediaId` and that `mediaIds` still retains all N entries in `node.data`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 6. Upgrade ListNode to render and play video items
  - [x] 6.1 Add `VideoListThumb` component (poster + hover-to-play)
    - In `frontend/src/canvas/v2/ListNode.tsx`, add `VideoListThumb({ src, poster, fit })` rendering `<video muted loop playsInline preload="metadata" poster=...>`; `onMouseEnter` calls `play()`; `onMouseLeave` pauses + resets `currentTime` only when currently playing, otherwise no-op
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 6.2 Use `VideoListThumb` in grid and list views
    - Replace the `isItemVideo` `<img>` rendering in both grid view (~lines 584-655) and list view (~lines 659-748) with `VideoListThumb`; render an error frame for items with `status === "error"`/`mediaId === null`; keep the `<Video>` badge overlay and the outer `onDoubleClick → openResultViewer(rfId, idx)`
    - _Requirements: 5.1, 5.6, 5.7, 3.4_

  - [x]* 6.3 Write component tests for the ListNode video item
    - `frontend/src/canvas/v2/__tests__/ListNodeVideoItem.test.tsx` using `@testing-library/react` (mock `<video>` play/pause): renders `<video>` (not `<img>`) with poster/preload; `mouseEnter` calls `play()`; `mouseLeave` while playing pauses + resets `currentTime`; `mouseLeave` while not playing is a no-op; `<Video>` badge present; `doubleClick` calls `openResultViewer`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

- [x] 7. Intake validation and regression coverage for source-video connections
  - [x] 7.1 Ensure source-video intake accepts video items and blocks dead connections
    - In the connect/intake logic, ensure a List Node connected to the Video_Node via `source-video` continues to filter and accept `kind === "video"` items, accepts all video items of that connection, and prevents establishing a connection whose intake filter would receive nothing
    - _Requirements: 8.3, 8.4, 8.5_

  - [x]* 7.2 Write integration/regression tests
    - Image batch flow still spawns `add_reference` and is unaffected (8.1); snapshot of Video_Node handles unchanged (8.2); reload restores Video_Node, Batch_Result_List, edge, and listItems via `nodeFromDto`/`edgeFromDto` (8.6); N=1 shows a single video and creates no list (4.1)
    - _Requirements: 8.1, 8.2, 8.6, 4.1_

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP, but they encode the design's Correctness Properties and regression guards.
- Each property test is its own sub-task, tagged with its design property number and the requirements clause it validates, and runs at least 100 iterations (`fc.assert(..., { numRuns: 100 })`).
- Property sub-tasks are placed next to the helper they exercise so failures surface early.
- All changes are frontend-only; no DB tables, no worker contract changes.
- Checkpoints provide incremental validation points.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "5.1", "6.1", "7.1"] },
    { "id": 1, "tasks": ["1.2", "6.2", "1.9"] },
    { "id": 2, "tasks": ["1.3", "1.4", "6.3", "1.11"] },
    { "id": 3, "tasks": ["2.1", "1.5", "1.10"] },
    { "id": 4, "tasks": ["2.2", "1.6"] },
    { "id": 5, "tasks": ["3.1", "1.7", "2.3"] },
    { "id": 6, "tasks": ["1.8", "7.2"] }
  ]
}
```
