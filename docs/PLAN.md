# Flowboard Plan

Personal local use. No team, no cloud, no auth.

## Concept

Infinite canvas + node-based workflow for AI media. Nodes are typed cards
(`character`, `image`, `video`, `prompt`, `note`). Edges express
"use as reference". Generation is brokered through a Chrome MV3 extension that
proxies requests to Google Flow (same pattern as flowkit).

A chat sidebar lets the user describe intent; an LLM (Claude) produces a
pipeline spec (DAG). The executor materializes nodes/edges on the canvas in
realtime over WebSocket as generation completes.

## Architecture

```
[React Canvas] ─HTTP/WS─► [FastAPI Agent + SQLite]
                                ▲
                                │ WebSocket :8355
                                ▼
                      [Chrome MV3 Extension]
                                │
                                ▼
                          labs.google (Flow)
```

## Data model (SQLite via SQLModel)

```
Board(id, name, created_at)
Node(id, board_id, short_id, type, x, y, w, h, data_json, status, created_at)
Edge(id, board_id, source_id, target_id, kind)
Request(id, node_id, type, params_json, status, result_json, created_at)
Asset(id, node_id, kind, uuid_media_id, local_path, mime)
ChatMessage(id, board_id, role, content, mentions_json, created_at)
Plan(id, board_id, spec_json, status, created_at)
PlanRevision(id, plan_id, rev_no, spec_json, edits_json, created_at)
PipelineRun(id, plan_id, status, started_at, finished_at)
```

## API surface

```
GET    /api/boards
POST   /api/boards
GET    /api/boards/:id
PATCH  /api/boards/:id
POST   /api/nodes
PATCH  /api/nodes/:id
DELETE /api/nodes/:id
POST   /api/edges
DELETE /api/edges/:id
POST   /api/requests                     {node_id, type, params}
GET    /api/requests/:id
POST   /api/chat                         {board_id, message, mentions[]}
POST   /api/plans                        create from chat
POST   /api/plans/:id/run                execute pipeline
GET    /media/:uuid                      serve asset
WS     /ws/extension                     extension bridge
WS     /ws/board/:id                     client live updates
```

## WS events (board channel)

```
plan.started      {plan_id, nodes_count}
node.created      {node_id, type, x, y, params, short_id}
node.updated      {node_id, status, data, thumbnail_url}
edge.created      {edge_id, source, target, kind}
plan.finished     {plan_id, ok, errors[]}
chat.message      {message_id, role, content}
```

## Plan JSON (LLM output)

```json
{
  "plan_id": "pln_01",
  "nodes": [
    {"tmp_id": "a", "type": "character", "params": {"prompt": "..."}},
    {"tmp_id": "b", "type": "image", "params": {"prompt": "...", "refs": ["a"]}},
    {"tmp_id": "c", "type": "video", "params": {"prompt": "...", "refs": ["b"]}}
  ],
  "edges": [
    {"from": "a", "to": "b", "kind": "ref"},
    {"from": "b", "to": "c", "kind": "ref"}
  ],
  "layout_hint": "left_to_right"
}
```

## Node mention

Every node has a `short_id` (base36, 4 chars, unique per board) shown on the
card. Chat input autocompletes `#` → node list. On submit, mentions are
resolved to node data and included in the LLM context.

## Phases

- **Phase 0** Skeleton monorepo, SQLite schema (this commit)
- **Phase 1** Canvas basics (React Flow, manual nodes, persistence)
- **Phase 2** Extension bridge (port flowkit's flow_client + processor)
- **Phase 3** Manual generation workflows (character/image/video)
- **Phase 4** Chat sidebar + Claude planner
- **Phase 5** Pipeline executor + WS streaming + auto-layout
- **Phase 6** Node short-ID + mention autocomplete
- **Phase 7** UX polish
- **Phase 7.5** Storyboard node (continuity-tree N=1..8 narrative shots)
  — see `.omc/plans/storyboard-image-node.md`

## Post-MVP

- **Phase 8**  Review Mode (ghost nodes, human-in-the-loop replan)
- **Phase 9**  Advanced generation (upscale, multi-ref, inpaint, batch)
- **Phase 10** Agent auto-loop (self-review, circuit breaker)
- **Phase 11** Export & timeline (ffmpeg composite, presets)
- **Phase 12** Extension abstraction (multi-provider registry)

## Explicitly out of scope

- Realtime collab, presence, avatars
- Auth, multi-tenant, share links
- Cloud DB, object storage
- YouTube auto-upload (manual export only)
- Comments on nodes
