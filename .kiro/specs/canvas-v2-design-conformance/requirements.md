# Requirements Document

## Introduction

This feature brings all Canvas V2 node components into conformance with the Flowboard Canvas V2 Design System Rules defined in `.agents/rules/canvas-v2-design-rules.md`, and adds a regression test layer that fails if any of the corrected deviations are reintroduced. The gold-standard reference nodes are `frontend/src/canvas/v2/ImageGeneratorNode.tsx` and `frontend/src/canvas/v2/VariantNode.tsx`.

The live application renders V2 nodes by default (`getUiVersion()` returns `"v2"` in `frontend/src/lib/utils.ts`; `Board.tsx` maps all node types to V2 components), so these deviations affect production behavior, not a legacy code path.

This is a surgical conformance cleanup, not a redesign. The work is scoped to four concrete deviation classes plus regression tests:

1. **§5 Active Connection Hit-Testing** — VideoGeneratorNode target handles do not force the drag-override classes during an active connection, degrading edge-drop hit-testing (Priority 1, functional).
2. **§5 at the shared layer** — `NodeShell.tsx` + `shared/edgeHandle.ts` do not apply the drag-override classes, so any future NodeShell node with a target handle would inherit non-conformant behavior (Priority 1, latent).
3. **§1 Selected Ring** — `ListNode.tsx` and `NoteNode.tsx` use non-conformant selected-ring tokens (Priority 2, visual).
4. **§11 Portal Dropdowns** — `ListNode.tsx` intake-mode dropdown renders inline instead of through a `createPortal` floating dropdown (Priority 3, structural).

All other styling differences are explicitly out of scope (see Requirement 7).

## Glossary

- **Canvas_V2**: The ReactFlow v12 custom-node rendering layer under `frontend/src/canvas/v2/`.
- **Design_Rules**: The conformance contract in `.agents/rules/canvas-v2-design-rules.md` (referenced by section number, e.g. §5).
- **Gold_Standard_Node**: A node component already conformant with the Design_Rules and used as the reference implementation; specifically `ImageGeneratorNode.tsx` and `VariantNode.tsx`.
- **Target_Handle**: A ReactFlow `<Handle type="target" />` element representing a node input port.
- **Source_Handle**: A ReactFlow `<Handle type="source" />` element representing a node output port.
- **Drag_Override_Classes**: The exact CSS class set `!opacity-100 !pointer-events-auto !z-50` that the Design_Rules §5 require on every Target_Handle while a connection gesture is in progress.
- **Active_Connection**: The state in which `useConnection().inProgress` is `true` (a user is dragging an edge on the canvas).
- **Selected_Ring**: The focus ring applied to a selected node card; Design_Rules §1 mandate `ring-2 ring-accent/50`.
- **Portal_Dropdown**: A dropdown menu rendered into `document.body` via React `createPortal`, position-tracked against its trigger button with a `requestAnimationFrame` `getBoundingClientRect()` loop, as implemented by `shared/PickerDropdown.tsx` and `shared/useFloatingDropdownPosition.ts`.
- **VideoGeneratorNode**: `frontend/src/canvas/v2/VideoGeneratorNode.tsx`.
- **NodeShell**: `frontend/src/canvas/v2/NodeShell.tsx`, the shared base wrapper for simple V2 nodes.
- **edgeHandle_Helper**: `frontend/src/canvas/v2/shared/edgeHandle.ts`, exporting `edgeHandleClass(...)`.
- **ListNode**: `frontend/src/canvas/v2/ListNode.tsx`.
- **NoteNode**: `frontend/src/canvas/v2/NoteNode.tsx`.
- **Forbidden_Radius**: A main-card outer border radius other than `16px` (`rounded-2xl` / `borderRadius: 16`), specifically the larger values `20px` or `24px` that Design_Rules §1 prohibit on main node cards.
- **Conformance_Test_Suite**: The vitest + @testing-library/react (+ fast-check where applicable) tests added by this feature under `frontend/src/`.
- **Test_Runner**: The frontend vitest runner invoked by `npm test` in `frontend/`.
- **Type_Check**: The TypeScript build check invoked by `npm run lint` (`tsc -b --noEmit`) in `frontend/`.

## Requirements

### Requirement 1: VideoGeneratorNode target-handle drag visibility (§5)

**User Story:** As a Flowboard user dragging an edge toward a Video Generator node, I want all four video input ports to become reliably droppable during the drag, so that connections land on the correct typed input instead of being rejected by collision detection.

#### Acceptance Criteria

1. WHILE an Active_Connection is in progress, THE VideoGeneratorNode SHALL apply the Drag_Override_Classes (`!opacity-100 !pointer-events-auto !z-50`) to each of its four Target_Handles (`target-text`, `target-start-image`, `target-end-image`, `target-references`).
2. WHILE no Active_Connection is in progress AND the node is not hovered, not selected, and the specific Target_Handle has no connected edge, THE VideoGeneratorNode SHALL apply `!opacity-0 !pointer-events-none` to that Target_Handle.
3. THE VideoGeneratorNode SHALL call `useConnection()` and treat `connection.inProgress` as a global active-gesture signal for Target_Handle visibility, consistent with the Gold_Standard_Node `ImageGeneratorNode`.
4. WHILE an Active_Connection is in progress, THE VideoGeneratorNode SHALL preserve the existing visibility behavior of its Source_Handles (`source-start-image`, `source-end-image`, `source-video`, `source-audio`), which remain tied to hover, selection, an existing source edge, or this node initiating the connection.

### Requirement 2: Shared-layer target-handle drag visibility (§5)

**User Story:** As a Flowboard developer adding a new NodeShell-based node with an input port, I want the shared handle layer to enforce §5 by default, so that I inherit correct edge-drop hit-testing without re-implementing it per node.

#### Acceptance Criteria

1. WHILE an Active_Connection is in progress, THE NodeShell SHALL apply the Drag_Override_Classes (`!opacity-100 !pointer-events-auto !z-50`) to its Target_Handle when a `targetHandle` spec is provided.
2. WHILE no Active_Connection is in progress AND the NodeShell node is not hovered, not selected, and its Target_Handle has no connected edge, THE NodeShell SHALL apply `!opacity-0 !pointer-events-none` to its Target_Handle.
3. WHERE a caller requests the Drag_Override_Classes for an active gesture, THE edgeHandle_Helper SHALL provide a documented way to emit `!pointer-events-auto !z-50` in addition to the existing visibility classes, so that NodeShell and node components can opt into §5 behavior through the shared helper rather than ad-hoc class strings.
4. THE NodeShell SHALL preserve the existing visibility behavior of its Source_Handle, which remains tied to hover, selection, an existing source edge, or this node initiating the connection.
5. THE edgeHandle_Helper SHALL preserve the existing `EDGE_HANDLE_TOP_OFFSET` (`48`) and `EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET` (`72`) exports and their current values.
6. WHILE an Active_Connection is in progress, THE NodeShell SHALL apply the Drag_Override_Classes to its Target_Handle in precedence over the idle-hidden tokens, so that the §5 drag override supersedes the `!opacity-0 !pointer-events-none` idle hiding defined in Acceptance Criterion 2.

### Requirement 3: ListNode selected-ring conformance (§1)

**User Story:** As a Flowboard user, I want the List node's selected state to match every other generator node, so that the canvas has a consistent selection appearance.

#### Acceptance Criteria

1. WHILE the ListNode is selected, THE ListNode SHALL apply the Selected_Ring tokens `ring-2 ring-accent/50` to its main card.
2. THE ListNode SHALL NOT apply the non-conformant selected-state tokens `ring-1 ring-accent/30` to its main card.
3. THE ListNode main card SHALL retain its `16px` outer border radius (`BORDER_RADIUS`), its `#1a1a1a` background, and its `border-[3px]` border width.
4. THE ListNode SHALL preserve its existing connecting-state and hover-state affordances except for the corrected Selected_Ring tokens.

### Requirement 4: NoteNode selected-ring conformance (§1)

**User Story:** As a Flowboard user, I want the Note node's selected ring to use the same accent opacity as other nodes, so that selection styling is uniform.

#### Acceptance Criteria

1. WHILE the NoteNode is selected, THE NoteNode SHALL apply the Selected_Ring tokens `ring-2 ring-accent/50` to its card.
2. THE NoteNode SHALL NOT apply the non-conformant token `ring-accent/60` to its card.
3. THE NoteNode SHALL preserve its intentional pastel card background, its border color, and its handle-less sticky-note layout (see Requirement 7).

### Requirement 5: ListNode intake dropdown portal conformance (§11)

**User Story:** As a Flowboard user opening the List node's intake-mode menu, I want the menu to render above the card without being clipped, so that I can read and pick "Keep Items" or "Replace Items" reliably.

#### Acceptance Criteria

1. WHILE the ListNode intake-mode dropdown is open, THE ListNode SHALL render the dropdown menu into `document.body` through React `createPortal` rather than as an inline `absolute` element inside the card subtree.
2. WHILE the ListNode intake-mode dropdown is open, THE ListNode SHALL track the trigger button position using a `requestAnimationFrame` loop that reads `getBoundingClientRect()`, reusing the shared `PickerDropdown` / `useFloatingDropdownPosition` pattern.
3. WHEN a pointer event occurs outside both the trigger button and the open dropdown menu, THE ListNode SHALL close the intake-mode dropdown.
4. THE ListNode SHALL apply `nowheel` isolation and a document-portal z-index (`z-[9999]`) to the intake-mode dropdown container.
5. WHEN a user selects "Keep Items" or "Replace Items", THE ListNode SHALL update `listIntakeMode` to the chosen value, persist the change, and close the dropdown, preserving the existing intake-mode behavior.
6. THE ListNode SHALL remove the bespoke inline dropdown markup and its manual `document` `mousedown` listener that the shared Portal_Dropdown pattern replaces.

### Requirement 6: Regression test coverage and conformance guards

**User Story:** As a Flowboard maintainer, I want automated tests that fail when a node reverts a corrected deviation, so that conformance does not silently regress.

#### Acceptance Criteria

1. THE Conformance_Test_Suite SHALL mount the real VideoGeneratorNode within a ReactFlow context as a required precondition, and assert that, while an Active_Connection is simulated, every VideoGeneratorNode Target_Handle carries the Drag_Override_Classes (`!opacity-100`, `!pointer-events-auto`, `!z-50`); IF the real VideoGeneratorNode cannot be mounted, THEN THE Conformance_Test_Suite SHALL fail rather than pass trivially.
2. THE Conformance_Test_Suite SHALL mount the real NodeShell with a `targetHandle` within a ReactFlow context as a required precondition, and assert that, while an Active_Connection is simulated, the NodeShell Target_Handle carries the same specific Drag_Override_Classes asserted for VideoGeneratorNode (the exact class set `!opacity-100 !pointer-events-auto !z-50`, not a general or abstract drag-override approach); IF the real NodeShell cannot be mounted, THEN THE Conformance_Test_Suite SHALL fail rather than pass trivially.
3. THE Conformance_Test_Suite SHALL mount the real ListNode and the real NoteNode as a required precondition, and assert that, while selected, each card carries `ring-2` and `ring-accent/50` and does not carry `ring-1`, `ring-accent/30`, or `ring-accent/60`; IF either real component cannot be mounted, THEN THE Conformance_Test_Suite SHALL fail rather than pass trivially.
4. THE Conformance_Test_Suite SHALL mount the real ListNode as a required precondition, and WHILE its intake-mode dropdown is open, SHALL assert that the menu options are rendered through a `document.body` portal rather than as descendants of the node card element; IF the real ListNode cannot be mounted, THEN THE Conformance_Test_Suite SHALL fail rather than pass trivially.
5. WHERE a node type exposes one or more Target_Handles and a `connection.inProgress` state can be enumerated, THE Conformance_Test_Suite SHALL include a fast-check property asserting that for every such node-with-target-handles, every Target_Handle applies the Drag_Override_Classes while a connection is in progress.
6. THE Conformance_Test_Suite SHALL include a guard test that fails if any audited main node card declares a Forbidden_Radius (`20px` or `24px`) for its outer card radius.
7. WHEN any corrected deviation is reintroduced into the audited components, THE Conformance_Test_Suite SHALL fail (each assertion above must be capable of failing on regression, not merely pass trivially).
8. THE Conformance_Test_Suite SHALL exercise the real component implementations under test rather than reimplemented or mocked copies of the node markup.

### Requirement 7: Preserve existing behavior and by-design exceptions

**User Story:** As a Flowboard user, I want the conformance cleanup to leave intentional designs and existing functionality untouched, so that no feature or deliberate UX choice regresses.

#### Acceptance Criteria

1. THE Canvas_V2 nodes SHALL preserve all existing functional and UX behavior of the Gold_Standard_Nodes (`ImageGeneratorNode`, `VariantNode`) without modification arising from this feature.
2. THE feature SHALL leave the NoteNode pastel card background, border, and handle-less sticky-note design unchanged except for the Selected_Ring token correction in Requirement 4.
3. THE feature SHALL leave `GroupNodeShell` frameless group styling unchanged.
4. THE feature SHALL leave the VariantNode `object-contain` 12-cell grid and the ListNode bespoke selectable tile grid unchanged.
5. THE feature SHALL leave the `PickerDropdown` panel styling (`#1f232b` background, `rounded-[20px]`) unchanged, treating its divergence from the Design_Rules' documented `#2a2a2a` panel color as a documentation matter outside this code-change scope.
6. THE feature SHALL leave external-header nodes' `EXTERNAL_HEADER_EDGE_HANDLE_TOP_OFFSET` value of `72` unchanged, treating the Design_Rules' literal `48` as the no-external-header case.
7. THE feature SHALL leave connection validation, body-drop routing, and edge persistence logic in `Board.tsx` and `store/board.ts` unchanged, since this feature only adjusts node-component presentation and handle hit-target visibility.

### Requirement 8: Verification gates

**User Story:** As a Flowboard maintainer, I want the type checker and test runner to pass after the conformance changes, so that the change is safe to merge.

#### Acceptance Criteria

1. WHEN `npm run lint` (`tsc -b --noEmit`) runs in `frontend/`, THE Type_Check SHALL complete with no errors.
2. WHEN `npm test` (`vitest run`) runs in `frontend/`, THE Test_Runner SHALL complete with all tests passing, including the Conformance_Test_Suite.
3. WHERE the Conformance_Test_Suite requires DOM rendering of real components, THE frontend vitest configuration SHALL provide a `jsdom` environment for those tests while preserving the existing `node`-environment tests.
4. IF a Conformance_Test_Suite assertion cannot be satisfied without altering a by-design exception listed in Requirement 7, THEN THE feature SHALL exclude that assertion rather than change the by-design exception.
