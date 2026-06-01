# Implementation Plan: Canvas V2 Design Conformance

## Overview

This plan implements the surgical §5/§1/§11 conformance fixes from the design across five
production files plus one new shared helper, then adds the regression test layer. Work proceeds
in dependency order: the shared `edgeHandle.ts` helper is extended first (it is the root
dependency for the VideoGeneratorNode and NodeShell target-handle fixes), followed by the
independent ring-token and dropdown-portal fixes, and finally the conformance test suite and the
`npm run lint` + `npm test` verification gate.

All paths are under `c:\Frog\Tool\Flow_workflow\flowboard`. Test commands run in `frontend/`:
`npm run lint` (`tsc -b --noEmit`) and `npm test` (`vitest run`). DOM tests opt into jsdom
per-file via the `// @vitest-environment jsdom` docblock — the global vitest environment in
`frontend/vite.config.ts` stays `"node"` and MUST NOT be changed.

Implementation language: TypeScript / React (matches the design and the existing codebase).

## Tasks

- [ ] 1. Extend the shared handle layer for §5 drag-override
  - [ ] 1.1 Add an opt-in `dragActive` flag to `edgeHandleClass(...)`
    - Edit `frontend/src/canvas/v2/shared/edgeHandle.ts`: add optional `dragActive` param (default `false`) to the `edgeHandleClass({ side, visible })` signature
    - When `dragActive` is true, force `showByState` true (so `!opacity-100`, never the idle-hidden tokens) and append `!pointer-events-auto !z-50` last so the drag-override wins over idle-hidden (precedence)
    - When `dragActive` is omitted/false, output MUST be byte-for-byte identical to today (backward compatible for all existing source-handle callers)
    - Keep `EDGE_HANDLE_TOP_OFFSET = 48` and `EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET = 72` exports and values unchanged
    - _Requirements: 2.3, 2.5, 2.6_

  - [ ] 1.2 Add the pure `targetHandleDropState(...)` class-decision helper
    - Create `frontend/src/canvas/v2/shared/handleClassParts.ts`
    - Export `HandleDropState` (`inProgress`, `hovered`, `selected`, `hasEdge`), `HandleDropDecision` (`"droppable" | "visible-idle" | "idle-hidden"`), and `targetHandleDropState(s)` returning `"droppable"` when `inProgress`, else `"visible-idle"` when `hovered || selected || hasEdge`, else `"idle-hidden"`
    - This is the deterministic, jsdom-free surface the §5 property test exercises
    - _Requirements: 6.5_

  - [ ]* 1.3 Write the fast-check property + unit tests for the shared helpers
    - Create `frontend/src/canvas/v2/shared/__tests__/edgeHandle.test.ts` (node env — no `// @vitest-environment jsdom` docblock; no DOM needed)
    - **Property 1: Target-handle drop-state invariant** — `fc.assert(fc.property(...), { numRuns: 100 })` over `fc.record({ inProgress, hovered, selected, hasEdge })` × `fc.constantFrom("left","right")`, asserting: `inProgress` ⇒ class set contains `!opacity-100` + `!pointer-events-auto` + `!z-50` and excludes `!opacity-0`/`!pointer-events-none`; `!inProgress` & none-of-state ⇒ contains `!opacity-0` + `!pointer-events-none` and excludes `!pointer-events-auto`/`!z-50`; `!inProgress` & some-state ⇒ contains `!opacity-100` and excludes the drag-override tokens. Cross-check against `targetHandleDropState`
    - Tag with comment `// Feature: canvas-v2-design-conformance, Property 1: Target-handle drop-state invariant`
    - Unit examples: `edgeHandleClass({ visible:false, dragActive:true })` contains the three override tokens; `edgeHandleClass({ visible:false })` equals current output (backward-compat); assert `EDGE_HANDLE_TOP_OFFSET === 48` and `EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET === 72`
    - **Validates: Requirements 6.5, 2.3, 2.5, 2.6**

- [ ] 2. Make VideoGeneratorNode target handles force the §5 drag-override
  - [ ] 2.1 Thread `dragActive` into `VideoGeneratorNode` `handleClass`
    - Edit `frontend/src/canvas/v2/VideoGeneratorNode.tsx`: update `handleClass(role, active)` to call `edgeHandleClass({ side, visible: active, dragActive: role === "target" && connection.inProgress })`
    - Source handles pass `dragActive: false`, preserving their hover/selection/edge/`isConnectingFromThisNode` visibility (no change to source behavior)
    - Leave the four target `<Handle>` declarations (`target-text`, `target-start-image`, `target-end-image`, `target-references`) and the existing `useConnection()` usage as-is; the change is confined to `handleClass`
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [ ] 3. Make NodeShell target handle force the §5 drag-override
  - [ ] 3.1 Opt the NodeShell target handle into `dragActive`
    - Edit `frontend/src/canvas/v2/NodeShell.tsx`: change the target `<Handle>` className to `edgeHandleClass({ side: "left", visible: showTargetHandle, dragActive: connection.inProgress })`
    - Leave the source `<Handle>` className unchanged (`edgeHandleClass({ side: "right", visible: showSourceHandle })`) and leave the `EDGE_HANDLE_TOP_OFFSET` import/usage untouched
    - _Requirements: 2.1, 2.2, 2.4, 2.6_

- [ ] 4. Bring ListNode and NoteNode selected rings into §1 conformance
  - [ ] 4.1 Swap the ListNode selected-ring token
    - Edit `frontend/src/canvas/v2/ListNode.tsx`: change the selected/connecting card branch `border-accent ring-1 ring-accent/30` → `border-accent ring-2 ring-accent/50`
    - Do not touch `BORDER_RADIUS = 16`, `backgroundColor: "#1a1a1a"`, `border-[3px]`, or the hover/connecting affordances
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ] 4.2 Swap the NoteNode selected-ring token
    - Edit `frontend/src/canvas/v2/NoteNode.tsx`: change `selected && "ring-2 ring-accent/60"` → `selected && "ring-2 ring-accent/50"`
    - Leave the pastel background, border color, and handle-less sticky-note layout unchanged
    - _Requirements: 4.1, 4.2, 4.3_

- [ ] 5. Migrate the ListNode intake dropdown to the shared portal pattern (Route A)
  - [ ] 5.1 Replace the inline intake dropdown with `PickerDropdown`
    - Edit `frontend/src/canvas/v2/ListNode.tsx`: import and render shared `PickerDropdown`, anchored to a new `intakeButtonRef` on the trigger button, driven by `isOpen={showIntakeDropdown}` / `onClose` / `onPick`
    - Map the two modes to `PickerItem`s (`{ key: "keep", label: "Keep Items", hint }`, `{ key: "replace", label: "Replace Items", hint }`); set `activeKey={listIntakeMode}`
    - Keep `setIntakeMode` updating `listIntakeMode` via the store and persisting via `persistNodeData`, then closing the dropdown (preserve `"replace"` default and persistence contract)
    - Delete the inline `absolute` popover markup, the `dropdownRef`, and the manual `document` `mousedown` `useEffect`; keep the `ChevronDown` import; rely on `PickerDropdown` for portal-to-`document.body`, rAF `getBoundingClientRect` tracking (`useFloatingDropdownPosition`), outside-`mousedown`/Escape close, and `nowheel` + `z-[9999]`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [ ] 6. Checkpoint - implementation complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Add the conformance regression test suite
  - [ ]* 7.1 RTL test: VideoGeneratorNode target handles get the drag-override
    - Add to `frontend/src/canvas/v2/__tests__/DesignConformance.test.tsx` (`// @vitest-environment jsdom`), reusing the `VideoGeneratorNodeHandles.test.tsx` harness (stub `Handle` to record `className`, stub `useEdges`, stub `useConnection` to inject `{ inProgress: true, fromNode }`, stub `ResizeHandle` → `null`)
    - Mount the real `VideoGeneratorNode`; assert each of `target-text`, `target-start-image`, `target-end-image`, `target-references` carries `!opacity-100`, `!pointer-events-auto`, `!z-50`; fail if zero handles render (required-precondition guard). Negative: source handles do not gain `!z-50` from `inProgress` alone
    - _Requirements: 6.1, 1.1, 1.4, 6.7, 6.8_

  - [ ]* 7.2 RTL test: NodeShell target handle gets the exact drag-override set
    - In the same suite, mount the real `NodeShell` with a `targetHandle` spec and stubbed `useConnection` `{ inProgress: true }`; assert the target handle className contains the exact set `!opacity-100 !pointer-events-auto !z-50`; fail if NodeShell cannot mount. Negative: source handle lacks the override
    - _Requirements: 6.2, 2.1, 2.4, 6.7, 6.8_

  - [ ]* 7.3 RTL test: ListNode + NoteNode selected ring
    - Mount the real `ListNode` (selected) and real `NoteNode` (selected); assert each card class contains `ring-2` and `ring-accent/50` and does not contain `ring-1`, `ring-accent/30`, or `ring-accent/60`; fail if either cannot mount
    - _Requirements: 6.3, 3.1, 3.2, 4.1, 4.2, 6.7, 6.8_

  - [ ]* 7.4 RTL test: ListNode intake dropdown portal placement + behavior
    - Mount the real `ListNode`, open the intake dropdown via the trigger; assert the "Keep Items"/"Replace Items" options are reachable from `document.body` and are NOT descendants of the node card element, and that the portal container carries `nowheel` and `z-[9999]`
    - Spy on `useBoardStore.getState().updateNodeData` and `persistNodeData`: picking an option fires the `{ listIntakeMode }` update + persist and closes the menu; an outside `mousedown` on `document.body` closes the menu
    - Avoid `<video>` listItems in fixtures to sidestep jsdom media polyfills; do not assert pixel positions (jsdom rAF/`getBoundingClientRect` limitation)
    - _Requirements: 6.4, 5.1, 5.3, 5.4, 5.5, 6.7, 6.8_

  - [ ]* 7.5 Forbidden-radius (§1) guard test
    - In the same suite, assert each audited main card outer radius is `16` (`rounded-2xl` / `borderRadius: 16`) and never the Forbidden_Radius `20`/`24` across `ImageGeneratorNode`, `VideoGeneratorNode`, `ListNode`, `NoteNode` (constant check plus rendered card-style check)
    - _Requirements: 6.6, 6.7, 6.8_

- [ ] 8. Final verification gate
  - Run `npm run lint` in `frontend/` (`tsc -b --noEmit`) and confirm zero type errors (R8.1)
  - Run `npm test` in `frontend/` (`vitest run`) and confirm all tests pass, including the new `edgeHandle.test.ts` property/unit tests and `DesignConformance.test.tsx` (R8.2); fix any failures before completing
  - Use PowerShell `;` to chain commands (not `&&`); use `vitest run` (single execution), never watch mode
  - _Requirements: 8.1, 8.2_

## Notes

- Tasks marked with `*` are test-only sub-tasks and may be skipped for a faster MVP, but R6 (the regression layer) and R8.2 require them for full conformance — they are strongly recommended.
- The fast-check property (Property 1) lives in `shared/__tests__/edgeHandle.test.ts` in the **node** env (task 1.3, close to the shared implementation it validates). The real-component RTL mounts and the forbidden-radius guard live in `__tests__/DesignConformance.test.tsx` in **jsdom** (task 7).
- `edgeHandle.ts` (task 1.1) is the shared root dependency for the VideoGeneratorNode (2.1) and NodeShell (3.1) fixes.
- `ListNode.tsx` is touched by both the ring swap (4.1) and the dropdown migration (5.1); those two are sequenced into different waves so the same file is never written in parallel.
- The five `DesignConformance.test.tsx` sub-tasks (7.1–7.5) all write the same file, so each is scheduled in its own wave to avoid write conflicts.
- Global vitest config (`frontend/vite.config.ts`) stays `environment: "node"`; jsdom is opted into per-file via docblock. No DTO, `Board.tsx`, or `store/board.ts` changes (R7.7).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "4.1", "4.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "3.1", "5.1"] },
    { "id": 2, "tasks": ["7.1"] },
    { "id": 3, "tasks": ["7.2"] },
    { "id": 4, "tasks": ["7.3"] },
    { "id": 5, "tasks": ["7.4"] },
    { "id": 6, "tasks": ["7.5"] }
  ]
}
```
