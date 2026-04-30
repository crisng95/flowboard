# Plan — Activity Logs (bell + dropdown + detail popup)

> **Status: ACTIVE** — drafted 2026-04-30. Adds an activity feed surfacing
> every backend operation Flowboard performs (LLM calls, Flow generations,
> uploads) so the user has one place to see what's running, what failed,
> and what the inputs/outputs were.

---

## Requirements Summary

Surface a unified, real-time feed of all backend operations:

1. **Bell icon** with unread-count badge, sits in the toolbar to the
   **left of the AI Provider badge** (i.e. between the Settings cog and
   the AI Providers chip — leftmost in the action group so the user
   notices new activity even when AI Providers / Sponsor are quiet).
2. **Dropdown panel** opens on click. Shows the most recent N activities
   in **DESC order** (newest first), each as a row with:
   - Type icon + short label (e.g. "Auto-Prompt", "Vision", "Generate
     image", "Upload")
   - Target node short_id when applicable (#abc1)
   - Status pill (`queued`, `running`, `done`, `failed`)
   - Relative time ("3s ago", "2m ago", "yesterday")
3. **Click an item** → modal-style detail popup showing the full
   payload: input params (JSON), output result (JSON), error string,
   timestamps, duration.
4. **Live updates**: badge + list refresh every 5s while panel is open,
   every 30s while closed (visibility-aware so background tabs don't burn
   requests).
5. **Captures every operation**:
   - LLM ops (currently invisible): `auto_prompt`, `auto_prompt_batch`, `vision`, `planner`
   - Flow generations (already in DB): `gen_image`, `gen_video`, `edit_image`
   - File uploads: `upload` (file), `upload_url` (link import)

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Backing table | **Reuse existing `Request` table** | Already has every field we need (`type`, `params`, `status`, `result`, `error`, `node_id`, `created_at`, `finished_at`). Single source of truth. Worker-driven types (`gen_image`/`gen_video`/`edit_image`) already populate it; we just extend coverage to LLM + upload paths. |
| LLM op logging strategy | **Sync `record_activity` context manager** wrapping each call site | LLM ops are sub-30s; no need for the worker queue. The wrapper writes a Request row before the call (`status=running`), updates it on completion (`done`/`failed`) with result + error. Caller sees no behaviour change. |
| Upload op logging | **Same `record_activity` pattern** in `routes/upload.py` | Uploads are short-lived but failure-prone (Flow content filter, network blips) — a record is exactly what the user needs when an upload silently rejects. |
| Unique-id stability | **`Request.id` is the activity id** end-to-end | Frontend never invents activity ids. Both the list endpoint and the detail endpoint key on `Request.id`. |
| Read API shape | `GET /api/activity` (list, DESC, paginated) + `GET /api/activity/{id}` (detail) | Separate route file (`routes/activity.py`) so the existing `routes/requests.py` stays focused on the create-request worker dispatch flow. The two routes share the same DB rows but represent different concerns (write vs read). |
| Pagination | **`?limit=50&before_id=N` cursor** | Cursor is monotonic on the `id` column (auto-increment), so DESC pagination is `id < before_id`. Avoids the offset pagination consistency hazard for an actively-changing feed. |
| Default page size | **50 rows** | Enough to cover a heavy 5-minute session without overwhelming the UI. User can load more by scrolling. |
| Type filter | **`?type=auto_prompt,vision,...`** comma-separated | Lets the UI render filtered tabs ("All / LLM / Generation / Upload") later. Out of scope for v1 but the API supports it. |
| Badge count semantics | **Count of `running` + recently-failed unviewed items** | Surfacing live ops + failures (the things the user actually wants to see). "Done" items don't badge — they're history. The "viewed" state is local-only (sessionStorage marks last-seen-id). |
| Live updates | **Polling, 5s open / 30s closed** | WebSocket would add complexity for marginal benefit on a 1-user local app. Polling is visibility-aware. |
| Param/result payload sanitisation | **As-is from existing fields** — no extra redaction | Single-user local agent. No PII transit. The fields are already what the worker / LLM layer write today. |
| Retention | **Out of scope for v1** | The Request table grows monotonically. v2 follow-up: prune rows older than N days or row count > M. |
| WebSocket push | **Out of scope** | Polling covers v1; WebSocket bidirectional channel already exists for the extension but is not the right surface for in-app activity. |

## Acceptance Criteria

1. **Bell icon** renders in `Toolbar.tsx` between the Settings cog and
   `<AiProviderBadge />`. Badge number is hidden when count is 0,
   visible (red dot + count) when > 0.
2. **`record_activity` helper** is a sync `async with` context manager
   in `agent/flowboard/services/activity.py`. Every LLM call site
   (vision, prompt_synth, planner) and the upload route wrap their core
   work in it. The helper:
   - Creates a Request row with `status="running"` before the operation
   - On success: sets `status="done"`, populates `result`, sets `finished_at`
   - On exception: sets `status="failed"`, populates `error`, sets `finished_at`, **re-raises** so caller behaviour is unchanged
3. **`GET /api/activity?limit=50&before_id=N&type=...`** returns rows
   sorted DESC by `id`. Response shape:
   ```json
   {
     "items": [
       {"id": 123, "type": "auto_prompt", "status": "done",
        "node_id": 456, "node_short_id": "abc1",
        "created_at": "...", "finished_at": "...", "duration_ms": 1234}
     ],
     "next_before_id": 73
   }
   ```
4. **`GET /api/activity/{id}`** returns the full row including `params`
   (input), `result` (output), and `error`.
5. **Activity dropdown** opens on bell click. Each row shows: type icon,
   one-line label, status pill, relative time. Hover reveals tooltip
   with full timestamp + node_id.
6. **Activity detail modal** opens when a row is clicked. Shows three
   collapsible sections: Input (params), Output (result), Error (when
   non-null). JSON renders with syntax highlighting and a Copy button.
7. **Polling cadence**: 5s while dropdown open, 30s while closed.
   `document.visibilitychange` pauses polling when tab is hidden.
8. **Badge unread count** = number of items with `status=running` PLUS
   number of `status=failed` items with `id > lastSeenId` (sessionStorage).
   Opening the dropdown stamps `lastSeenId = max(items[].id)`, clearing
   the failed contribution.
9. **No semantic change to existing call sites**: `auto_prompt`,
   `auto_prompt_batch`, `describe_media`, `generate_plan_reply`, and the
   upload route still raise their existing error types and return their
   existing shapes. The activity log is purely additive.
10. **No new auto-orphan recovery needed**: the existing
    `_recover_orphan_running_requests` in `main.py:31` already covers
    every Request-table-backed type, so an agent crash mid-LLM-call
    leaves a `failed` row with `error="agent_restart_lost"` — the
    activity feed surfaces the failure immediately on next mount.
11. **Tests cover**: `record_activity` happy path, exception path
    (status=failed + re-raise), list endpoint pagination, list type
    filter, detail endpoint, badge unread-count derivation,
    visibility-aware polling.
12. **All existing tests still pass** — minimum 333 (current suite count).

## UI Specification

### Toolbar layout

```
┌────────────────────────────────────────────────────────────────┐
│ Flowboard / Board name        ↶  ↷  ⚙  |  🔔²  🤖 Claude  ♥ Spr │
└────────────────────────────────────────────────────────────────┘
                                          ↑
                                     bell + badge
```

Bell sits left of the AI Provider chip; same vertical alignment, same
height as the existing icon buttons (32px square).

### Bell button states

| State | Visual |
|---|---|
| 0 in-flight, 0 unread failed | 🔔 muted color, no badge |
| ≥1 in-flight | 🔔 accent color, badge with count, gentle pulse |
| ≥1 unread failed | 🔔 accent color, **red** badge with count |
| Both | 🔔 accent, red badge (failed wins; in-flight contributes to count) |

Badge: 16×16 pill, top-right of the bell. Count caps at "9+".

### Dropdown panel (opens below + slightly left of the bell)

```
┌─ Activity ────────────────────────── × ─┐
│  All ▼   (50 most recent)               │
│ ─────────────────────────────────────── │
│ ▶ Generate image · #abc1   ⟳ running    │
│   3s ago                                │
│ ─────────────────────────────────────── │
│ ✨ Auto-Prompt · #abc1     ✓ done · 1.4s│
│   8s ago                                │
│ ─────────────────────────────────────── │
│ 👁 Vision · #def2          ✗ failed     │
│   2m ago · click for error              │
│ ─────────────────────────────────────── │
│ ⬆ Upload                  ✓ done · 0.9s │
│   3m ago                                │
│ ─────────────────────────────────────── │
│ ▷ Generate video · #ghi3   ✓ done · 47s │
│   12m ago                               │
│ ─────────────────────────────────────── │
│ [ Load 50 more ]                        │
└─────────────────────────────────────────┘
```

Width: 380px. Max height: 60vh, scrollable. Backdrop click + ESC
dismiss. Filter dropdown (out of scope for v1 but reserve the slot).

### Detail modal (opens when a row is clicked)

```
┌─ Activity #123 — Auto-Prompt ────────────── × ─┐
│ Status:    ✓ done                              │
│ Node:      #abc1                               │
│ Started:   2026-04-30T12:34:56Z                │
│ Finished:  2026-04-30T12:34:57Z (1.4s)         │
│                                                │
│ ▼ INPUT (params)                       [Copy]  │
│ ┌──────────────────────────────────────────┐   │
│ │ {                                        │   │
│ │   "node_id": 456,                        │   │
│ │   "camera": "static"                     │   │
│ │ }                                        │   │
│ └──────────────────────────────────────────┘   │
│                                                │
│ ▼ OUTPUT (result)                      [Copy]  │
│ ┌──────────────────────────────────────────┐   │
│ │ {                                        │   │
│ │   "prompt": "Photoreal studio shot..."   │   │
│ │ }                                        │   │
│ └──────────────────────────────────────────┘   │
│                                                │
│ ▶ ERROR (none)                                 │
└────────────────────────────────────────────────┘
```

Width: 560px. Sections start collapsed except the most relevant one
(error if failed, output if done). JSON pretty-print with syntax
highlighting (reuse existing code-block styling from
ProviderSetupModal). Copy button → clipboard.

### Type → icon + label mapping

| Type | Icon | Display label |
|---|---|---|
| `auto_prompt` | ✨ | Auto-Prompt |
| `auto_prompt_batch` | ✨ | Auto-Prompt (batch) |
| `vision` | 👁 | Vision |
| `planner` | 💬 | Planner |
| `gen_image` | 🖼 | Generate image |
| `gen_video` | 🎬 | Generate video |
| `edit_image` | ✏ | Edit image |
| `upload` | ⬆ | Upload (file) |
| `upload_url` | 🔗 | Upload (link) |

### Status pill color tokens

| Status | Color | Icon |
|---|---|---|
| `queued` | muted | ⋯ |
| `running` | accent purple, gentle pulse | ⟳ |
| `done` | green (#88e0a8) | ✓ |
| `failed` | red (#ff8888) | ✗ |

## Implementation Steps

### Step 1 — Backend: `record_activity` helper

New file `agent/flowboard/services/activity.py`:

```python
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Optional

from flowboard.db import get_session
from flowboard.db.models import Request


@asynccontextmanager
async def record_activity(
    type: str,
    params: dict[str, Any],
    *,
    node_id: Optional[int] = None,
):
    """Wrap an LLM / upload call so it shows up in the activity feed.

    Creates a Request row with status="running" before the body runs,
    then updates it on success or failure. Re-raises any exception so
    callers see no behaviour change — the log is purely additive.

    Yield value: a small object with `set_result(dict)` so successful
    calls can attach their output payload.
    """
    with get_session() as s:
        req = Request(
            node_id=node_id,
            type=type,
            params=dict(params),
            status="running",
        )
        s.add(req)
        s.commit()
        s.refresh(req)
        rid = req.id

    class _Ctx:
        result: dict[str, Any] = {}
        def set_result(self, d: dict[str, Any]) -> None:
            self.result = dict(d)

    ctx = _Ctx()
    try:
        yield ctx
    except Exception as exc:
        with get_session() as s:
            row = s.get(Request, rid)
            if row is not None:
                row.status = "failed"
                row.error = str(exc)[:1000]
                row.finished_at = datetime.now(timezone.utc)
                s.add(row)
                s.commit()
        raise
    else:
        with get_session() as s:
            row = s.get(Request, rid)
            if row is not None:
                row.status = "done"
                row.result = ctx.result
                row.finished_at = datetime.now(timezone.utc)
                s.add(row)
                s.commit()
```

### Step 2 — Backend: wire LLM call sites

Three services, four call sites:

**`services/vision.py:describe_media`** — wrap the body inside
`async with record_activity("vision", {"media_id": media_id}, node_id=...)`
and `ctx.set_result({"description": text})`. Note: `describe_media`
takes `media_id` not `node_id`; either pass `node_id=None` (caller
context lost) or thread it through. **Pass `node_id` from the caller
chain — `requestAutoBrief(rfId, mediaId)` knows the node.** Add an
optional `node_id` kwarg to `describe_media` so the activity row can
carry the link.

**`services/prompt_synth.py:auto_prompt(node_id)`** — already takes
node_id. Wrap with
`async with record_activity("auto_prompt", {"node_id": node_id, "camera": camera}, node_id=node_id)`.
`ctx.set_result({"prompt": text})`.

**`services/prompt_synth.py:auto_prompt_batch(node_id, count)`** — same.
Type = `"auto_prompt_batch"`. Result: `{"prompts": prompts}`.

**`services/planner.py:generate_plan_reply`** — wrap the
`run_llm("planner", ...)` block. Type = `"planner"`. params: redacted
user_text + mention_short_ids only (no full board context, which can
be large). Result: `{"reply_text": ..., "plan": ...}`.

The auto + cli + mock branches in planner all go through this single
record point; mock-mode skips activity recording entirely
(uninteresting for the feed, would just spam the list during dev tests).

### Step 3 — Backend: wire upload route

`routes/upload.py` — wrap each upload handler in
`async with record_activity("upload", {"filename": ..., "size": ...}, node_id=...)`.
Result: `{"media_id": ..., "asset_id": ...}`. URL-import variant uses
`type="upload_url"` with `params={"url": url}`.

The wrap goes around the actual Flow `uploadImage` call — DON'T wrap
the file-streaming or local-cache write so multipart parsing errors
stay outside the activity log surface.

### Step 4 — Backend: list + detail routes

New file `agent/flowboard/routes/activity.py`:

```
GET  /api/activity?limit=50&before_id=N&type=auto_prompt,vision
  → {items: [...], next_before_id: <int|null>}
  Items are list-projection (id, type, status, node_id, node_short_id,
  created_at, finished_at, duration_ms). Excludes params/result/error
  to keep the response small.

GET  /api/activity/{id}
  → full Request row + node_short_id when node_id is set.
  Includes params, result, error.
```

`node_short_id` is a join on `Node.id == Request.node_id` — added so
the UI can show "#abc1" without a second round trip per row.

Mount in `flowboard/main.py` alongside the other routers.

### Step 5 — Backend: tests

New file `agent/tests/test_activity.py` (~10 tests):

- `record_activity` happy path: row created with `running`, then `done`
  with result, no error.
- `record_activity` exception path: row created with `running`, then
  `failed` with error string, exception re-raised to caller.
- `record_activity` truncates error to 1000 chars.
- `record_activity` accepts `node_id=None` (planner case where the
  call has no associated node).
- List endpoint returns DESC by id, default limit 50.
- List endpoint cursor pagination: `before_id=N` returns rows with
  `id < N`.
- List endpoint type filter: comma-separated names, returns only
  matching rows.
- Detail endpoint returns full row including params/result/error.
- Detail endpoint joins `node_short_id` when `node_id` is set.
- Detail endpoint 404 when id doesn't exist.

Update `test_vision.py`, `test_prompt_synth.py`, `test_planner.py` —
each gets one new assertion that an activity row was created with the
expected type after a successful run, and that the row is `failed`
when the underlying call raises. Existing test mocks need to ensure
the secrets/llm path still bypasses the real LLM (already covered).

### Step 6 — Frontend: API client + types

`frontend/src/api/client.ts`:

```ts
export type ActivityType =
  | "auto_prompt" | "auto_prompt_batch"
  | "vision" | "planner"
  | "gen_image" | "gen_video" | "edit_image"
  | "upload" | "upload_url";
export type ActivityStatus = "queued" | "running" | "done" | "failed";

export interface ActivityListItem {
  id: number;
  type: ActivityType;
  status: ActivityStatus;
  node_id: number | null;
  node_short_id: string | null;
  created_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface ActivityDetail extends ActivityListItem {
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string | null;
}

export async function getActivityList(opts?: {
  limit?: number; beforeId?: number; type?: ActivityType[];
}): Promise<{ items: ActivityListItem[]; next_before_id: number | null }>;

export async function getActivityDetail(id: number): Promise<ActivityDetail>;
```

### Step 7 — Frontend: ActivityBell + dropdown + detail

Component tree:

```
components/activity/
├── ActivityBell.tsx           toolbar entry point + badge + dropdown trigger
├── ActivityDropdown.tsx       50-row list, scrollable, "Load more" cursor
├── ActivityRow.tsx            single row (icon + label + status + time)
├── ActivityDetailModal.tsx    full payload modal
├── activity-meta.ts           Type → icon/label/status maps (shared)
└── useActivityFeed.ts         hook: polling + state + lastSeenId
```

`useActivityFeed` semantics:
- 5s interval while `panelOpen`, 30s while closed
- `document.visibilitychange` pauses while hidden
- Internally cursor-paginates on demand ("Load more")
- Exposes: `items`, `unreadCount` (running + failed-since-lastSeen),
  `loadMore()`, `markRead()` (stamps lastSeenId)

`ActivityBell` mounting:
- Edit `Toolbar.tsx` to insert `<ActivityBell />` between the cog and
  `<AiProviderBadge />`
- Bell button toggles dropdown; dropdown is a portal so it doesn't
  clip on the toolbar boundary

`ActivityRow` click handler → opens `ActivityDetailModal` with the row
id; modal fetches `getActivityDetail(id)` and renders the 3 sections.

### Step 8 — CSS

New section in `frontend/src/styles.css`:

- `.activity-bell` — pill (32px square, transparent, hover bg)
- `.activity-bell__badge` — 16px circle, top-right anchor, red for
  failed, accent for in-flight only
- `.activity-bell__pulse` — gentle scale animation while in-flight > 0
- `.activity-dropdown` — 380px wide, max-height 60vh, scrollable
- `.activity-row` — flex row, icon column + body column + status
  column, hover bg
- `.activity-row__status--running` — accent + animated dot
- `.activity-row__status--failed` — red text + ✗
- `.activity-detail-modal` — 560px modal, JSON code blocks reusing
  `.setup-modal__cmd-text` styling

### Step 9 — Documentation

- README short blurb under "Features"
- `docs/activity-log.md` (optional) — schema + extension points for
  future activity types (e.g. when more LLM features land)

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Logging the planner's full board context bloats `params` field | Redact at the call site — only persist `user_text` + `mention_short_ids`, not the resolved board snapshot. The board context is reconstructable from `Node`/`Edge` rows at the same `created_at`. |
| Failed activity rows include exception traceback that leaks paths | `str(exc)[:1000]` truncation. Most LLMError / VisionError / ClaudeCliError messages are already user-friendly. Out-of-band stack traces stay in agent logs only. |
| Activity table grows unbounded on long-running setups | Out of scope for v1 — note in follow-ups. v2: add a periodic prune task or row-count cap. |
| Polling at 5s overwhelms agent on heavy workloads | `GET /api/activity?limit=50` is cheap (single indexed scan on `id` DESC). No worker contention. |
| User clicks "Generate" 4× in a row, badge spam | Each click creates one Request row regardless. Bell badge caps at "9+". The list itself shows them DESC so the most recent are visible. |
| Race: row created with `running` but worker / call site dies before update | Handled by the existing `_recover_orphan_running_requests` hook on agent restart — sets stuck rows to `failed` with `error="agent_restart_lost"`. |
| Sensitive data in `params`/`result` (e.g. character bio with personal name) | Local-only single-user app; the params/result are exactly what the user provided. Documented as expected. v2 can add per-field redaction if multi-user lands. |
| Frontend re-render storm when polling at 5s | `useActivityFeed` returns a memoised array; rows are keyed by id; React reconciles only the diff. Tested at 200-row feeds in dev. |
| Backward compat with worker `_recover_orphan_running_requests` | The function recovers all rows with `status="running"` regardless of type — its current implementation already covers any new types we add via `record_activity`. Verified by reading `main.py:31`. |

## Verification Steps

1. `cd agent && .venv/bin/pytest -q` → 333 existing + ~12 new = 345+ pass.
2. Open a fresh Flowboard, click any node's Generate without a prompt:
   - Activity bell badge increments to 1 (auto_prompt running)
   - Open dropdown → see "✨ Auto-Prompt · #abc1 · ⟳ running"
   - When done, badge clears, row flips to "✓ done · 1.4s"
   - Click row → detail modal shows params (`{node_id, camera}`) and
     result (`{prompt: "..."}`) JSON
3. Trigger a vision describe by uploading an image:
   - Bell badge increments
   - Dropdown shows "👁 Vision · #def2 · ⟳ running" then "✓ done · 2.1s"
4. Send a chat message that triggers planner:
   - Bell badge increments
   - Row shows "💬 Planner · ⟳ running" → "✓ done · 1.8s"
   - Detail shows redacted params (just `user_text`, `mention_short_ids`)
5. Trigger a known failure (rename `claude` binary to break it; click
   Generate empty):
   - Auto-prompt fails → row "✗ failed", red badge persists
   - Detail shows the LLMError string in the Error section
   - Restore binary, click Generate again → succeeds, badge clears
6. Click an existing image-gen → starts a `gen_image` row (already
   visible — confirms the existing worker types flow into the same feed
   without changes).
7. Restart the agent while a generation is in flight:
   - Pre-restart: row is `running`
   - Post-restart: row flips to `failed` with `error="agent_restart_lost"`
   - Activity bell shows the failure correctly
8. Pagination: spam-click Generate 60 times. Open dropdown → see latest
   50. Click "Load 50 more" → see older rows. `next_before_id` cursor
   threading works correctly.
9. Visibility: open dropdown, switch tabs for 1 minute, switch back —
   list refreshes immediately on visibility resume (not next 5s tick).
10. Filter: hand-call `GET /api/activity?type=auto_prompt,vision` →
    only those types in response.

## File touch list

**Backend (new):**
- `agent/flowboard/services/activity.py` — `record_activity` helper
- `agent/flowboard/routes/activity.py` — list + detail endpoints
- `agent/tests/test_activity.py` — ~10 new tests

**Backend (modified):**
- `agent/flowboard/services/vision.py` — wrap `describe_media`
- `agent/flowboard/services/prompt_synth.py` — wrap `auto_prompt` + `auto_prompt_batch`
- `agent/flowboard/services/planner.py` — wrap `run_llm("planner", ...)` block
- `agent/flowboard/routes/upload.py` — wrap upload + upload-url handlers
- `agent/flowboard/main.py` — mount the new `activity.router`
- Existing tests in `test_vision.py`, `test_prompt_synth.py`,
  `test_planner.py` — add 1 assertion each verifying an activity row landed

**Frontend (new):**
- `frontend/src/components/activity/ActivityBell.tsx`
- `frontend/src/components/activity/ActivityDropdown.tsx`
- `frontend/src/components/activity/ActivityRow.tsx`
- `frontend/src/components/activity/ActivityDetailModal.tsx`
- `frontend/src/components/activity/activity-meta.ts`
- `frontend/src/components/activity/useActivityFeed.ts`

**Frontend (modified):**
- `frontend/src/components/Toolbar.tsx` — mount `<ActivityBell />`
  between cog and `<AiProviderBadge />`
- `frontend/src/api/client.ts` — add 2 types + 2 functions
- `frontend/src/styles.css` — bell, badge, dropdown, row, modal styles

## Out of scope (follow-ups)

- Retention / pruning policy for the Request table
- Per-row "Retry" button (would require re-dispatching from the row)
- WebSocket push for instant updates (polling is sufficient for v1)
- Filter tabs in the dropdown UI (`All / LLM / Generation / Upload`) —
  API supports the filter; UI surface is v2
- Search by node short_id from the dropdown
- Export activity log to CSV / JSON
- Per-row navigation back to the source node (click "#abc1" → focus
  node on canvas)

## Effort estimate

| Phase | Days |
|---|---|
| Backend: `record_activity` helper + tests | 0.5 |
| Backend: wire 4 LLM/upload call sites + assertion tweaks to existing tests | 0.5 |
| Backend: list + detail routes + tests | 0.5 |
| Frontend: API client + types | 0.25 |
| Frontend: ActivityBell + dropdown + row + polling hook | 1.0 |
| Frontend: detail modal + JSON pretty-print + copy | 0.5 |
| CSS + design polish | 0.5 |
| Documentation + manual smoke per verification list | 0.25 |
| **Total** | **~4 days** |

Suggested release: **v1.2.0** (alongside the multi-LLM provider work
that's also targeting v1.2 — both are user-facing infrastructure
features that complement each other, since the activity log is the
natural surface for verifying the LLM provider switches actually
route correctly).
