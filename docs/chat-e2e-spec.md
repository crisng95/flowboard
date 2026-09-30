# Chat E2E Spec — bottom dock, Muse-compatible agentic video builder

Decisions (Cris, 2026-09-30):
- ChatDock docked at the bottom is the chat UI. `ChatSidebar` is already
  unmounted in `App.tsx` (commented out) — leave it as is.
- **Auto-run**: sending a message immediately runs the agent E2E. No
  approval gate (the old plan-draft flow stays untouched for API compat,
  but the dock does not use it).
- **Muse-compatible**: all LLM reasoning goes through `run_llm` → the
  `muse` provider queue. All media goes through `run_muse_media`. No
  Claude CLI, no Google Flow, no extension dependency. If no Muse worker
  is present, the dock disables send and says so (reuse provider-presence
  logic, not a silent fail).

## Architecture

```
[ChatDock] ──POST /api/chat/attachments (multipart, ≤5 images)──▶ [FastAPI]
[ChatDock] ──POST /api/chat {board_id, message, mentions, attachment_ids}
      │                        │ saves user msg + ChatAttachment rows
      │                        │ spawns BackgroundTask: chat_agent loop
      │                        ◀── {user, run_id} (returns fast)
      │                    ┌── services/chat_agent.py (server-side ReAct loop)
      │                    │     context → run_llm("chat_agent") → tool JSON
      │                    │     → execute tool (direct service calls)
      │                    │     → run_muse_media for image/video (queue+wait)
      │                    │     → repeat, max 12 turns
      │                    │     → writes final assistant ChatMessage
      │                    └── progress via activity feed + ChatRun status
      └──poll GET /api/boards/{id}/chat/runs/active every 3s
         on done/failed → reload messages + board nodes
```

Why server-side loop (not worker-side): tool execution is direct function
calls (create node/edge, ffmpeg concat). Only LLM reasoning needs the Muse
worker, via the existing `llm` provider-job kind. This is the same
enqueue+wait pattern `run_muse_media` already uses.

## Backend

### 1. DB (`agent/flowboard/db/models.py`)

```python
class ChatAttachment(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    message_id: int = Field(foreign_key="chatmessage.id", index=True)
    asset_id: int = Field(foreign_key="asset.id", index=True)
    created_at: datetime = Field(default_factory=_utcnow)

class ChatRun(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    board_id: int = Field(foreign_key="board.id", index=True)
    user_message_id: int = Field(foreign_key="chatmessage.id")
    status: str = "running"  # running | done | failed
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)
    finished_at: Optional[datetime] = None
```

Check `main.py` lifespan for `create_all` — if tables are auto-created,
no migration file needed; otherwise follow `docs/migrations/` pattern.

### 2. Upload route (`agent/flowboard/routes/chat.py`)

`POST /api/chat/attachments` — multipart form: `board_id` (int),
`files` (1–5). Rules: `image/*` only, 10 MB each (mirror
`routes/upload.py` caps). Save bytes to
`storage/chat_uploads/<uuid4hex>.<ext>`. Create `Asset(kind="image",
node_id=None, local_path=..., mime=...)`. Response:
`{"assets": [{"id", "mime", "url"}]}` where `url` is a new
`GET /api/chat/attachments/{asset_id}/file` byte-serving route (check for
an existing media-file route first and reuse if suitable).

### 3. Chat send (`agent/flowboard/routes/chat.py`)

Extend `ChatSendRequest`: `attachment_ids: List[int] = Field(default_factory=list, max_length=5)`.
Validate: assets exist, `kind == "image"`, `node_id IS NULL` (not already
bound), all belong to this board's upload space (board check optional —
assets are board-agnostic uploads; keep simple: must exist and be
unbound images).

New behavior: create user `ChatMessage`, create `ChatAttachment` rows,
create `ChatRun(status="running")`, schedule `chat_agent.run(...)` via
FastAPI `BackgroundTasks`, return `{"user": ..., "run_id": ...}` immediately.
Do NOT call the old planner here. Keep `GET /api/boards/{board_id}/chat`
but include per-message `attachments: [{id, asset_id, mime, url}]`.

New: `GET /api/boards/{board_id}/chat/runs/active` → the running `ChatRun`
or `null`.

### 4. Agent service (`agent/flowboard/services/chat_agent.py`)

`async def run_chat_agent(board_id: int, run_id: int, message: str,
attachment_asset_ids: list[int], mentions: list[str]) -> None`
(completes the ChatRun row + writes the assistant message; never raises —
catch-all → ChatRun failed + assistant message with the error).

**Context builder** (`build_board_context(board_id) -> str`):
- Last 20 ChatMessages for the board (role + content; user messages note
  `[N image(s) attached]`).
- Nodes: `short_id, type, status, x, y`, plus a one-line `data` summary
  (prompt / media count — truncate to ~120 chars each).
- Edges: `from_short_id -> to_short_id (kind)`.
- The current message text + attached asset ids/paths.

**System prompt**: defines the toolset (JSON function-call convention —
worker returns exactly one JSON object per turn:
`{"tool": "<name>", "args": {...}}` or `{"done": true, "reply": "<text>"}`).
Tools:

| tool | args | implementation |
|---|---|---|
| `create_node` | `type, x, y, data?` | insert Node; types: `character image video prompt note merge` |
| `add_edge` | `from_short_id, to_short_id, kind="ref"` | insert Edge |
| `gen_image` | `prompt, node_short_id?, reference_asset_ids?` | `run_muse_media(kind="image", ...)` → bind output asset to node (create image node if none given) |
| `gen_video` | `prompt, source_asset_id, node_short_id?` | `run_muse_media(kind="video", source_media_ids=[...])` → bind to video node (create if none) |
| `concat_videos` | `video_asset_ids[], node_short_id?` | ffmpeg concat (see below); create `merge` node if none given; output video asset bound to it |
| `update_node` | `short_id, data_patch` | shallow-merge `data` (same semantics as `routes/nodes.py`) |
| `refresh` | — | re-read board context (after many mutations) |

**Loop**: max 12 LLM turns, `run_llm("chat_agent", user_prompt, system_prompt=..., attachments=[abs paths...], timeout=120)`.
Parse worker JSON (tolerate fenced code blocks). Unknown tool / bad JSON →
feed back as observation, continue. Each step: `record_activity(...)`
so the dock/activity feed shows progress ("Tạo node ảnh 2/5", …).
On `done` (or turn budget out): write assistant `ChatMessage` with the
reply/summary, mark ChatRun done.

**LLM feature**: add `"chat_agent"` to `Feature` in
`services/llm/registry.py`. Mirror how `planner` resolves its default
provider so a fresh `secrets.json` still routes to muse (check
`services/llm/secrets.py` for the defaulting logic).

**Attachments to the worker**: absolute host paths
(`storage/chat_uploads/...`) — the muse protocol never ships bytes
(see `services/llm/muse.py` docstring).

**concat implementation** (`services/chat_agent.py` or new
`services/video_concat.py`):
- Resolve asset ids → `local_path` (must exist, video).
- `ffmpeg -f concat -safe 0 -i <list.txt> -c copy <out.mp4>`; if `-c copy`
  fails (codec mismatch), retry with re-encode
  (`-c:v libx264 -pix_fmt yuv420p -c:a aac`).
- `shutil.which("ffmpeg")` — if missing, return a clear error (do not
  crash the run).
- Save to `storage/media/concat_<uuid>.mp4`, create `Asset(kind="video",
  local_path, mime="video/mp4")`, bind to the merge node
  (`data["mediaIds"]` append — check the node data convention used by
  media binding in `services/media.py`).

### 5. Merge node type

New type string `"merge"` alongside the existing five. No executor change
needed (chat_agent owns it). Frontend renders it with a distinct glyph.

## Frontend

### 1. `ChatDock.tsx` (new, `frontend/src/components/`)

Bottom-docked panel: fixed to viewport bottom, centered, `max-width`
~720px, height resizable via drag handle (default 320px, min 160, max
70vh), collapsible to a 48px bar ("Chat — hỏi AI làm video…"). Mount in
`App.tsx` where `ChatSidebar` is commented out.

Sections: header (title + muse presence badge + collapse), message list
(user right / assistant left, attachment thumbnails, error styling),
agent-step line (latest activity text while a run is active), input row
(attach button, textarea, send button).

### 2. Upload (≤5 images)

`api/client.ts`: `uploadChatAttachments(boardId, files: File[])` →
`POST /api/chat/attachments` (FormData). Client-side: max 5 files,
`image/*`, 10 MB each — refuse with a toast otherwise.
Dock input: paperclip button → file picker (`multiple, accept="image/*"`),
thumbnail strip with per-image remove. `sendMessage` uploads first, then
`POST /api/chat` with returned asset ids.

### 3. Store (`frontend/src/store/chat.ts`)

Extend: `sendMessage(message, mentions, attachmentIds)`; `activeRun`
state; `pollRun()` — every 3s `GET .../runs/active`; when run leaves
`running`, `loadChat(boardId)` + `useBoardStore` node refresh (find the
existing board reload action — check `store/board.ts`) and stop polling.
Send disabled while a run is active or muse worker absent.

### 4. Muse presence

Find the existing provider-status endpoint used by `AiProviderBadge`
(grep `AiProviderBadge.tsx`) and reuse it in the dock header. No worker →
notice "Chưa có Muse worker — chạy `python agent/scripts/muse_worker.py`"
and disable send.

### 5. DTOs (`api/client.ts`)

`ChatMessageDTO` += `attachments: Array<{id, asset_id, mime, url}>`.
`ChatSendResponse` → `{user: ChatMessageDTO, run_id: number}` (update the
old shape; `ChatSidebar` is unmounted so nothing else consumes it —
verify with grep).

### 6. Merge glyph

Add `merge: "⧉"` to the node icon maps (dock mentions + canvas NodeCard
if it has its own map — check `canvas/` for the icon map and update both).

## Multi-turn

No new tables. Context = last 20 messages + board snapshot, so turn 2
("sửa cảnh 2", "gen lại video 3") resolves via short_ids and the
existing `mentions` array. Attachment assets stay linked to their message
for follow-up reference (`reference_asset_ids`).

## Tests

Backend (`agent/tests/`):
- `test_chat_attachments.py`: upload 1–5 ok; 6th rejected; non-image
  rejected; >10MB rejected; bytes land under `storage/chat_uploads/`;
  `GET .../file` serves them.
- `test_chat_agent.py`: mock `run_llm` with a scripted tool-call sequence
  (create_node → gen_image → done); assert nodes/edges created, ChatRun
  done, assistant message written. Mock `run_muse_media` (no worker).
- `test_video_concat.py`: build 2 tiny mp4s with ffmpeg (skip if no
  ffmpeg), concat, assert output duration ≈ sum.
- `test_chat_send.py`: POST /api/chat returns fast with run_id; active
  run endpoint transitions running → done.

Frontend: `npm run build` + lint clean. No new unit tests required, but
keep existing ones passing.

## Non-goals

- Old planner endpoint behavior for `ChatSidebar` (unmounted) — keep the
  route working, don't improve it.
- Flow/extension paths — untouched.
- Public sharing — the artifact stays private.

## Deploy note (for later)

Repo first, green tests, push. Hosted `flowboard` artifact update goes
through `artifact.edit` with this spec; smoke test via published actions
(`createboard`, `uploadimage`, chat send, `getboard`, `listactivity`).
