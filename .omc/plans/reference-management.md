# Plan — Reference Management Library

> Status: **decisions locked, ready for executor**
> Last updated: 2026-05-10
> Author/owner: anh Tuan
> Grounding: 3 parallel `Explore` passes over `agent/flowboard/`, `frontend/src/`. Every claim cites `file:line`. Owner instruction: no clarifying questions — defaults are baked in.

---

## 0. TL;DR

A cross-board library of saved image references. The user picks any variant (or any media-bearing node — character / image / visual_asset / storyboard shot), clicks **★ Save**, and the `(media_id, url, aiBrief, aspect, kind)` is recorded in a new server-side `Reference` table. A right-side **Library** panel renders a vertical slider of those references — clicking or dragging one onto the canvas spawns a new `visual_asset` node at the cursor (or canvas center), pre-populated with that mediaId + cached aiBrief.

Cross-board reuse works **today** at the API level (Asset table is globally scoped, media URLs are board-agnostic, Flow accepts refs across projects). This plan adds a **curation layer** — a small subset of Assets the user explicitly wants surfaced as quick-spawn references — plus the UI to act on it.

No DB migrations to existing tables. Zero changes to gen/edit pipeline. Pure additive feature.

---

## 1. Current state — grounded facts

### 1.1 Why cross-board reuse already works

- **Asset table is globally scoped** (`agent/flowboard/db/models.py:63-76`). No `board_id` field. `uuid_media_id` is unique across the whole DB.
- **Media storage is flat** (`agent/flowboard/services/media.py:26-27`) — `storage/media/{media_id}.{ext}` regardless of board.
- **`mediaUrl(mediaId)`** (`frontend/src/api/client.ts:462-465`) returns `/media/{id}` — no board encoding.
- **Project_id only scopes the API endpoint** at dispatch time (`flow_sdk.py:580-666`). Ref media_ids passed into `imageInputs` are validated only by UUID format, not project origin (Explore A confirmed).

⇒ A media_id generated on board A can be used as a `IMAGE_INPUT_TYPE_REFERENCE` for `gen_image`/`edit_image` under board B's flow_project_id with no protocol issues.

### 1.2 Cheapest spawn-from-media path

- `createNode({type:"visual_asset", board_id, x, y, data:{mediaId, aiBrief}})` (`frontend/src/api/client.ts:183-193`). The node lands ready-to-use with thumbnail, no upload round-trip, no vision call.
- `visual_asset` is the canonical "uploaded ref" type (`agent/flowboard/services/prompt_synth.py:232` includes it in `_REF_SOURCE_TYPES`).

### 1.3 UI surface room

- **No right sidebar exists today** — `frontend/src/App.tsx` has `<ProjectSidebar/>` left + `<canvas-wrap>` only. Right edge of canvas-wrap is free space. (Explore B)
- **No right-click context menu** anywhere in the codebase (verified).
- **`ImageTile` overlay** (`frontend/src/canvas/NodeCard.tsx:298-350`) already hosts a "Use →" hover button — there's room next to it for a "★ Save" sibling. Both use `e.stopPropagation()` so they don't conflict with the tile's click-to-view.
- **`mediaUrl()` returns board-agnostic URL** — references can resolve thumbnails in any board.

### 1.4 aiBrief lifecycle

- aiBrief is stored in `Node.data`, NOT in `Asset` (Explore C). If we want zero re-vision when spawning across boards, we must **snapshot the aiBrief at save time** into the `Reference` row.

### 1.5 No prior art

- `grep -r "cross_board|import_asset|library|reference_manager"` returned zero hits. Green-field.

---

## 2. Goal

Add a `Reference` (curated, server-side, cross-board) library that:

1. Stores user-saved `(media_id, url, aiBrief snapshot, source_aspect, kind, label)` tuples.
2. Adds a **★ Save** affordance on:
   - every variant tile of an image/storyboard node (so any one of 4 variants can be saved independently);
   - the body of `visual_asset` and `character` nodes (single-mediaId case).
3. Exposes a right-side **Library panel** (collapsible) on the canvas — a vertical scrollable list of reference cards.
4. Lets the user spawn a new `visual_asset` node from a reference in two ways:
   - Click a card → spawn at canvas center;
   - Drag a card onto the canvas → spawn at drop position.
5. Persists references server-side (SQLite via new `Reference` table) so they survive board switches, page reloads, and (when storage moves to a shared backend) cross-host sessions.

### Non-goals (this phase)

- Folders / nested collections (refs are a flat list — tags handle grouping if needed later).
- Sharing references across users (single-user tool).
- Bytes import — only the `media_id` reference travels; bytes already live in `storage/media/{id}`. If the file is missing locally, the saved `url` is used to re-ingest (existing `media_service.ingest_urls()` pattern).
- Video reference saves (audio + storyboard shot saves are image-only for v1 — video assets need a different thumbnail strategy).
- Bulk export / import of the library as JSON. Deferred.
- Auto-tagging via LLM. Deferred.

---

## 3. Locked decisions

Owner instruction was "tự quyết". Defaults baked from grounding:

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Storage = backend SQLite table `Reference`, NOT localStorage. | Survives cross-host use, queryable for stats, schema migrations safe. |
| D2 | Snapshot `ai_brief` + `aspect_ratio` + `kind` + `label` into the Reference row at save time. | Cross-board spawn shouldn't need re-vision. Keeps "save" + "spawn" idempotent. |
| D3 | New `Reference` table — do NOT add columns to `Asset`. | Asset is the de-facto media cache index; references are a user-curated overlay with different lifetime/semantics. Keeping them separate avoids polluting the cache. |
| D4 | Spawned node type is always `visual_asset` (single mediaId). | Even when the source was a multi-variant image node, the saved reference is ONE specific variant — `visual_asset` semantics fit. Restoring a character/image-node with full variants is post-MVP. |
| D5 | Save button per-tile (not per-node) for multi-variant sources. | A 4-variant gen often has 1 good shot + 3 weak; saving per-tile matches user intent. |
| D6 | Library panel = right sidebar, collapsible, vertical list (not horizontal slider). | Vertical scroll matches the chip aspect ratio of saved refs and stays out of the way of the canvas. Horizontal slider in the original brief is harder to scale beyond ~6 items at usable thumbnail size. |
| D7 | Drag-drop uses custom `dataTransfer` payload `application/x-flowboard-reference` with `{media_id, ...}` JSON. | Doesn't conflict with the existing file-upload drop handlers (`dataTransfer.files`). |

---

## 4. Architecture

### 4.1 DB schema — new `Reference` table

```python
# agent/flowboard/db/models.py — append after Asset (~line 76)

class Reference(SQLModel, table=True):
    """User-curated saved media for cross-board reuse.

    Distinct from Asset (which is the auto-managed media cache index).
    Each Reference points at one media_id and carries enough metadata to
    spawn a brand-new visual_asset node in any board without re-vision
    or re-upload.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    media_id: str = Field(index=True, unique=True)  # one ref per media
    url: Optional[str] = None                       # signed CDN URL (may expire; storage/media/ is the canonical source)
    label: str = ""                                  # user-editable; default = first 80 chars of ai_brief or shortId
    kind: str                                        # "image" | "character" | "visual_asset" | "storyboard_shot"
    ai_brief: Optional[str] = None                   # snapshot from source Node.data.aiBrief at save time
    aspect_ratio: Optional[str] = None               # IMAGE_ASPECT_RATIO_* — inherited by spawned node
    tags: list = Field(default_factory=list, sa_column=Column(JSON))  # future-proof
    pinned: bool = False                             # surface at top of list
    position: int = 0                                # user-ordered (lower = earlier)
    source_board_id: Optional[int] = Field(default=None, foreign_key="board.id", index=True)
    source_node_short_id: Optional[str] = None       # provenance ("saved from #6hte")
    created_at: datetime = Field(default_factory=_utcnow)
```

**Migration:** add `Reference.__table_args__` if needed but the existing init pattern uses `SQLModel.metadata.create_all(engine)` on startup (`agent/flowboard/db/__init__.py` style) — new table is picked up automatically on next agent restart. Existing data untouched.

### 4.2 Backend API — new routes in `agent/flowboard/routes/references.py`

```python
# POST /api/references — save a new ref
class ReferenceCreate(BaseModel):
    media_id: str
    label: Optional[str] = None
    kind: str                                       # see model.kind
    ai_brief: Optional[str] = None
    aspect_ratio: Optional[str] = None
    url: Optional[str] = None                       # optional re-ingest hint
    source_board_id: Optional[int] = None
    source_node_short_id: Optional[str] = None
    tags: Optional[list[str]] = None

# Returns: { id, media_id, label, kind, ai_brief, aspect_ratio, pinned, position, tags, created_at, url }
# - 200 on success
# - 409 if media_id already saved (idempotent: return existing row instead of erroring)

# GET /api/references?limit=200&pinned_first=true&q=<text>
# - Sorted by (pinned DESC, position ASC, created_at DESC)
# - q is a substring match on label + ai_brief (case-insensitive)

# PATCH /api/references/{id}
class ReferencePatch(BaseModel):
    label: Optional[str] = None
    pinned: Optional[bool] = None
    position: Optional[int] = None
    tags: Optional[list[str]] = None

# DELETE /api/references/{id}
# - Hard delete. Underlying media file in storage/media/ is NOT touched (Asset row owns the cache lifetime).
```

Register in `agent/flowboard/main.py` next to the other route registrations.

### 4.3 Frontend — store + panel + actions

**New file `frontend/src/store/references.ts`** (Zustand store, mirrors patterns from `store/settings.ts` and `store/board.ts`):

```ts
export interface ReferenceItem {
  id: number;
  mediaId: string;
  url?: string | null;
  label: string;
  kind: "image" | "character" | "visual_asset" | "storyboard_shot";
  aiBrief?: string | null;
  aspectRatio?: string | null;
  tags: string[];
  pinned: boolean;
  position: number;
  sourceBoardId?: number | null;
  sourceNodeShortId?: string | null;
  createdAt: string;
}

interface ReferencesState {
  items: ReferenceItem[];
  loading: boolean;
  error: string | null;
  panelOpen: boolean;        // persisted to localStorage as the user's preferred mode
  query: string;

  load(): Promise<void>;
  save(input: SaveInput): Promise<ReferenceItem>;   // POST + insert into state
  remove(id: number): Promise<void>;
  rename(id: number, label: string): Promise<void>;
  togglePin(id: number): Promise<void>;
  setQuery(q: string): void;
  togglePanel(): void;       // persists the new value
}
```

**New file `frontend/src/components/ReferencesPanel.tsx`** — right-side collapsible panel:

```
┌─ ReferencesPanel ─────────────┐
│  ★ Library          [⌃] [×]   │  ← header: title + collapse + close
│  ┌─────────────────────────┐  │
│  │ 🔍 search references… │  │  ← optional filter
│  └─────────────────────────┘  │
│                               │
│  ┌────┐ #6hte                 │
│  │ 📷 │ Editorial portrait    │  ← reference card (clickable, draggable)
│  │    │ ◉ pin · 🗑️ delete    │
│  └────┘                       │
│                               │
│  ┌────┐ #yei3                 │
│  │ 📷 │ Light-blue jeans      │
│  └────┘                       │
│                               │
│  …                            │
└───────────────────────────────┘
```

- Mounted in `App.tsx` as a sibling of `<ProjectSidebar/>`, positioned absolute right of `<canvas-wrap>`, slides in/out (transform translateX).
- Each card: 64×64 thumbnail (`<img src={mediaUrl(r.mediaId)}>`) + label + shortId tag + hover-only actions (pin, delete, rename).
- Click → spawn at canvas center; drag → custom `dataTransfer` payload `{type:"flowboard:reference", mediaId, aiBrief, aspectRatio, kind, label}` (MIME `application/x-flowboard-reference`).

**Save button on tiles:**

- `ImageTile` (`frontend/src/canvas/NodeCard.tsx:298-350`) — add a second overlay button "★" next to "Use →". Visible only when `mediaId` is present and on hover. Clicking calls `useReferenceStore.save({media_id, kind: <source-node-type>, ai_brief: source.aiBrief, aspect_ratio: source.aspectRatio, label: source.aiBrief?.slice(0,80) ?? source.shortId, source_board_id, source_node_short_id})`.
- `CharacterBody` / `VisualAssetBody` / character-with-no-variants — add an inline "★ Save to library" button in the node toolbar.
- Visual feedback: on save, the button briefly flashes "★ saved" then reverts; the new card animates in at the top of the panel.

**Drop on canvas:**

- Extend `Board.tsx` drop handler (~line 197 area, `DropAddPopover` neighborhood) to inspect `e.dataTransfer.getData("application/x-flowboard-reference")`. If present, parse JSON and call `addReferenceNode(ref, dropPosition)` — a new store action that calls `createNode({type:"visual_asset", board_id, x, y, data:{mediaId, aiBrief, aspectRatio, title: ref.label}})`.
- Click-to-spawn path: same `addReferenceNode(ref, canvasCenter)` from the panel card click handler.

### 4.4 Sequence — save flow

```
User hovers a variant tile in a 4-variant image gen
  → "★" overlay appears beside "Use →"
  → user clicks "★"
       useReferenceStore.save({
         media_id: tile.mediaId,
         kind: source-node.type,
         ai_brief: source-node.aiBrief,
         aspect_ratio: source-node.aspectRatio,
         label: (ai_brief?.slice(0,80)) ?? "#" + source-node.shortId,
         source_board_id: useBoardStore.boardId,
         source_node_short_id: source-node.shortId,
       })
       → POST /api/references
       → 200: row inserted, returned
       → store.items.unshift(...)
       → panel auto-opens if closed (or just flashes the new card)
       → tile shows ✓ for 1.5s
```

### 4.5 Sequence — spawn flow

```
User drags a reference card from panel onto canvas
  → ondragstart: e.dataTransfer.setData("application/x-flowboard-reference",
                  JSON.stringify({mediaId, aiBrief, aspectRatio, kind, label}))
  → ondrop on canvas-wrap: parse payload, screenToFlowPosition(cursor)
  → board.addReferenceNode(payload, flowPos)
       → POST /api/nodes {board_id, type:"visual_asset",
                          x: flowPos.x, y: flowPos.y,
                          data: { mediaId, aiBrief, aspectRatio, title }}
       → store.upsertNode(newNodeDto)
       → canvas reveals the new node with a thumbnail already loaded
```

---

## 5. Phased implementation

3 phases. ~1.5 days executor.

### Phase 1 — Backend (½ day)

**Files:**
- `agent/flowboard/db/models.py` — add `Reference` SQLModel (per §4.1).
- `agent/flowboard/routes/references.py` — NEW. Implement 4 endpoints (POST, GET list, PATCH, DELETE).
- `agent/flowboard/main.py` — register the router.
- `agent/tests/test_references.py` — NEW. Unit tests for CRUD + idempotent save (re-saving same media_id returns existing row).

**Acceptance:**
- pytest 367+ ⇒ 372+ (5 new tests minimum)
- `curl -X POST /api/references -d '{"media_id":"foo","kind":"image"}'` returns 200 with row.
- Re-POST same media_id returns 200 with the existing row id (no duplicate).
- GET `/api/references?q=foo` filters correctly.

### Phase 2 — Frontend store + panel skeleton (½ day)

**Files:**
- `frontend/src/api/client.ts` — append `listReferences`, `createReference`, `patchReference`, `deleteReference` (mirror existing fetcher pattern).
- `frontend/src/store/references.ts` — NEW. Zustand store per §4.3. Persist `panelOpen` to `localStorage`.
- `frontend/src/components/ReferencesPanel.tsx` — NEW. Right sidebar, collapsible, list rendering, basic delete/rename/pin actions.
- `frontend/src/App.tsx` — mount `<ReferencesPanel/>` next to `<ProjectSidebar/>`. Wire panel toggle into a new `★` button in the Toolbar (or as a separate right-edge tab).
- `frontend/src/styles.css` — add `.references-panel`, `.reference-card`, `.reference-card__thumb`, `.reference-card__label`, panel slide animation.

**Acceptance:**
- `tsc --noEmit` clean.
- Panel opens/closes, persists open-state across page reload.
- Cards render with thumbnail, label, shortId, hover-actions.
- Empty state shows a hint: "Save a variant from any image node to start your library."

### Phase 3 — Save + Spawn actions (½ day)

**Files:**
- `frontend/src/canvas/NodeCard.tsx` — add "★" overlay button to `ImageTile` next to the existing "Use →"; add "★ Save to library" button to `CharacterBody`, `VisualAssetBody` toolbars.
- `frontend/src/canvas/Board.tsx` — extend the canvas onDrop handler to detect `application/x-flowboard-reference` and call `addReferenceNode`.
- `frontend/src/store/board.ts` — add `addReferenceNode(ref, position)` action (calls `createNode` with `{type:"visual_asset", data:{...}}`).
- Visual polish: save-success toast or per-tile checkmark for 1.5s.

**Acceptance:**
- Click ★ on any variant → reference appears in panel, persisted across reload.
- Drag card from panel → drop on canvas → new visual_asset node spawns at drop point with thumbnail + correct mediaId in `data.mediaId`.
- Click card (without drag) → new node spawns at canvas center.
- Spawned node can be used as upstream ref in a downstream image/video gen — verified manually with a real labs.google session.

---

## 6. Concrete artefacts

### 6.1 Save payload shape (frontend → POST /api/references)

```ts
type SaveInput = {
  media_id: string;
  kind: "image" | "character" | "visual_asset" | "storyboard_shot";
  label?: string;           // omitted → backend computes from ai_brief
  ai_brief?: string | null;
  aspect_ratio?: string | null;
  url?: string | null;      // optional — only sent if we want backend to re-ingest
  source_board_id?: number | null;
  source_node_short_id?: string | null;
  tags?: string[];
};
```

### 6.2 Drag payload (custom dataTransfer)

```ts
// On dragstart in ReferencesPanel:
e.dataTransfer.setData(
  "application/x-flowboard-reference",
  JSON.stringify({
    mediaId: r.mediaId,
    aiBrief: r.aiBrief,
    aspectRatio: r.aspectRatio,
    kind: r.kind,
    label: r.label,
  }),
);
e.dataTransfer.effectAllowed = "copy";

// In Board.tsx onDrop:
const raw = e.dataTransfer.getData("application/x-flowboard-reference");
if (raw) {
  const ref = JSON.parse(raw);
  const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
  await useBoardStore.getState().addReferenceNode(ref, pos);
  return;  // short-circuit — don't fall through to other drop handlers
}
```

### 6.3 `addReferenceNode` (store)

```ts
async addReferenceNode(ref, position) {
  const boardId = get().boardId;
  if (boardId === null) return null;
  const dto = await createNode({
    board_id: boardId,
    type: "visual_asset",
    x: position.x,
    y: position.y,
    data: {
      title: ref.label || "Reference",
      mediaId: ref.mediaId,
      aiBrief: ref.aiBrief ?? undefined,
      aspectRatio: ref.aspectRatio ?? undefined,
      status: "done",
      renderedAt: new Date().toISOString(),
    },
  });
  // Insert into local state (existing pattern after createNode)
  get()._upsertNodeDto(dto);
  return String(dto.id);
}
```

### 6.4 ★ Save button — JSX in `ImageTile`

```jsx
{onSaveToLibrary && (
  <button
    className="thumbnail-tile__save-btn"
    onClick={(e) => {
      e.stopPropagation();
      onSaveToLibrary();
    }}
    title="Save this variant to the library"
    aria-label="Save to library"
  >
    ★
  </button>
)}
```

The parent (`ImageBody` / `StoryboardBody`) passes `onSaveToLibrary` only when there's a real mediaId for that tile. CSS positions it as a sibling of the "Use →" overlay, top-right corner.

---

## 7. Acceptance criteria (testable)

1. **Schema** — A `Reference` row round-trips via `POST /api/references` → `GET /api/references` with all fields preserved.
2. **Idempotent save** — POSTing the same `media_id` twice returns the same `id` and does NOT create a duplicate row.
3. **Cross-board spawn** — On board A, save a media_id. Switch to board B (different `flow_project_id`). Spawn from panel → a new `visual_asset` node on board B carries the same `data.mediaId`. The thumbnail loads (via `/media/{id}`).
4. **Downstream gen works** — Use the spawned node as upstream ref in a downstream `gen_image` on board B. Verified end-to-end with a real labs.google session that the dispatch succeeds (the ref's media_id is accepted by Flow under board B's project).
5. **Drag-spawn position** — Drop coordinates map through `screenToFlowPosition` to the new node's `(x, y)`. Within ±5px tolerance of cursor.
6. **Empty state** — A fresh DB with zero references shows a panel hint ("Save a variant from any image node…") instead of blank.
7. **Delete** — DELETE `/api/references/{id}` removes the row. Underlying `storage/media/{media_id}` file is NOT touched.
8. **Rename** — PATCH updates `label`; the panel reflects within 1 frame.
9. **Pin** — Pinned refs sort first; unpinning moves them back to creation-order position.
10. **Backwards compat** — All existing 367 backend tests + tsc clean stay green.
11. **Persistence** — Panel open/close state survives page reload (`localStorage`). References themselves survive backend restart (SQLite).

---

## 8. Risks + mitigations

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R1 | Media file `storage/media/{id}.{ext}` deleted (manual cleanup, disk pressure) → broken thumbnail in panel | Medium | Reference row carries the original signed `url`. On `<img>` error, panel falls back to fetching `url` once and re-ingesting via `media_service.ingest_urls()`. If both fail, card shows a "missing" placeholder + offer to delete. |
| R2 | Signed CDN `url` expires (Flow fife URLs are ~1h) — re-ingest path also fails | Medium | Storage cache is the canonical source. Once ingested, file lives on disk indefinitely; the URL field is best-effort. Document: "Save references shortly after generation to ensure caching." |
| R3 | User saves 1000+ references → panel scrolling slow | Low | Server caps `limit` to 200 by default; client virtualises after 50 items (react-window-style) if performance pinches. Punt virtualisation until measured slow. |
| R4 | `application/x-flowboard-reference` MIME conflicts with browser-internal type | Low | Custom MIME with `x-` prefix and namespace — extremely unlikely to collide. Tested via integration test. |
| R5 | `aspect_ratio` not present on source node (older nodes pre-Phase-20 don't carry it) | Low | Spawn falls back to `IMAGE_ASPECT_RATIO_LANDSCAPE` default — matches the dispatch fallback already in `_handle_gen_image`. |
| R6 | Cross-board ref refs a media_id that Flow refuses ("not in this project") | Medium | Per Explore A, Flow only validates UUID format at refs level. If a real rejection surfaces (e.g. Flow changes), surface the error in the request row's `error` field and the activity log — user retries by uploading the bytes to the new project explicitly (existing upload flow). |
| R7 | Concurrent saves of the same media_id race | Low | Unique constraint on `media_id` + POST returns existing row on conflict — race outcomes converge. |
| R8 | Panel toggle button placement crowds the toolbar | Low | Place the ★ toggle in the right-edge of `<canvas-wrap>` as a vertical tab (always visible), independent of the toolbar. |
| R9 | `localStorage` filled with stale `panelOpen` value after schema change | Low | Single key (`flowboard.references.panel.v1`), versioned. Defaults to false on parse error. |
| R10 | New `★` button collides with the existing `Use →` button on the tile | Low | The two buttons sit in opposite corners (Use → bottom-right, ★ top-right). CSS positions them via `position: absolute` with non-overlapping insets. Visual audit during Phase 3. |

---

## 9. Test plan

### 9.1 Backend (pytest)

- `test_references_create_idempotent` — same media_id twice → single row, returns existing on second call.
- `test_references_list_pinned_first` — seed mixed pinned/unpinned, assert order.
- `test_references_list_query_filter` — seed labels {"red dress", "blue jeans"}, query "red" returns only the first.
- `test_references_patch_label_pinned` — round-trip mutations.
- `test_references_delete_does_not_touch_storage` — pre-create a file at `storage/media/X.png`, delete the reference, assert file still exists.

### 9.2 Frontend (tsc + manual smoke)

- `npx tsc --noEmit` clean.
- Manual smoke documented in PR: save a variant → see it in panel → switch boards → drag onto canvas → confirm node spawns with correct thumbnail → use as upstream ref → verify downstream gen succeeds.

### 9.3 No CI; gates are local pytest + tsc + one real-labs smoke.

---

## 10. ADR

**Decision:** Add a new server-side `Reference` table + REST API + frontend Zustand store + right sidebar panel with click-and-drag spawn-to-canvas. Persist user-curated `(media_id, label, aiBrief, kind, aspect)` tuples cross-board.

**Drivers:**
1. Owner intent: "save variant → reuse cross project, build UI list/slider for quick spawn".
2. Cross-board reuse already works at the protocol level (Asset has no board_id; `/media/{id}` route is flat; Flow accepts ref media_ids across projects) — verified by Explore A. The missing piece is curation + UI.
3. `Asset` table is the auto-managed cache index; mixing user curation into it confuses lifetimes (cache gc vs user pins).
4. `visual_asset` is the canonical "uploaded ref" node type — spawning into it requires no new node-kind machinery.

**Alternatives considered:**
- *Tag-flag on Asset row* (`Asset.is_reference: bool`). Rejected: mixes cache lifetime with user-curated lifetime; no place for `label`/`pinned`/`position`; touches a high-churn table.
- *localStorage-only references*. Rejected: per-host scope breaks the cross-host workflow many users have (laptop + desktop). Backend persistence is cheap.
- *Whole-node clone on save* (copies the entire source Node row). Rejected: source nodes have edges + N variants + per-edge pins — copying that is heavy and wrong semantically (the user wants ONE saved shot, not the whole composition graph).
- *Horizontal slider UI in original brief*. Rejected: doesn't scale past ~6 items at usable thumbnail size; vertical list with search scales to hundreds.

**Why chosen:** smallest blast radius. Pure additive table, additive API surface, additive UI panel. Zero changes to gen/edit/worker/dispatch pipeline. No DB migrations to existing tables. Cross-board reuse is already supported by the underlying protocol.

**Consequences:**
- Backend gets one new table + one new router file. SQLModel auto-create on next startup.
- Frontend gets one new store, one new panel component, one new dataTransfer MIME. Existing components get small additions (★ button on tiles, drop handler extension on canvas).
- New status surface: a reference whose underlying file is gc'd shows a "missing" placeholder; documented.
- Future work has a clean foundation: tags / collections / export / share are all additions to the Reference table without rework.

**Follow-ups (post-MVP):**
- Bulk tagging UI (multi-select cards + apply tag).
- Filter chips per tag in the panel header.
- Export library as JSON for backup or sharing.
- "Pin recent" auto-mode: surface the last N generated variants as transient quick-refs without explicit save.
- Right-click on a node header → "Save as reference (with all variants)" — multi-save shortcut.
- Re-vision button on a reference whose `ai_brief` is stale or missing.

---

## 11. Out of scope / future

- Video references (different thumbnail strategy needed).
- Audio references.
- Folders / nested collections (use tags).
- Multi-user sharing.
- Reference versioning / history.
- Bulk import from `storage/media/` directory scan.

---

## 12. Changelog

- **2026-05-10 v1** — initial draft after 3-agent grounding pass. All decisions baked from defaults per owner instruction (no interview).
