# Muse provider

**Muse** is Flowboard's delegated provider: an LLM backend and a
media-generation backend served by muse.ai (through the muse2api gateway)
or by Pax (this assistant) through a worker, instead of the CLI/API
providers (Claude / Gemini / Codex) and Google Flow.

- **LLM features** (Auto-prompt, Vision, Planner) and the ChatDock agent:
  pin any feature to `Muse` in Settings → AI Providers.
- **Media** (image / edit / video): pick **Muse** in the GenerationDialog's
  Backend chip. `gen_image`, `edit_image`, `gen_video`, `gen_video_omni`
  route to Muse instead of the Flow SDK — no Flow plan, no Chrome
  extension, no paygate tier needed.

Muse has two transports. Which one runs is decided by one setting:

```
FLOWBOARD_MUSE2API_BASE set    Flowboard ──HTTP──▶ muse2api ──▶ muse.ai
FLOWBOARD_MUSE2API_BASE unset  Flowboard ──provider-job queue──▶ Pax worker
```

## muse2api gateway

[muse2api](https://github.com/crisng95/muse2api) exposes muse.ai as an
OpenAI-compatible API with its own account pool, failover and video task
manager. Point Flowboard at it in `.env` at the repo root and restart the
agent:

```bash
FLOWBOARD_MUSE2API_BASE=http://127.0.0.1:18610
FLOWBOARD_MUSE2API_KEY=<muse2api's MUSE2API_API_KEY>
# FLOWBOARD_MUSE2API_POLL_S=3   # video task poll interval
```

No worker and no intermediate gateway are needed: muse2api already does
the account scheduling, retries and long-running task tracking that the
queue exists for. The agent calls it directly (`services/muse2api.py`):

| Flowboard | muse2api | Notes |
|---|---|---|
| LLM features, ChatDock agent | `POST /v1/chat/completions` | attachments sent as `image_url` data URLs |
| `gen_image` | `POST /v1/images/generations` | `b64_json`; `variant_count` > 4 is split, per-variant `prompts` → one call each; reference images are dropped (reported in `result.warnings`) |
| `edit_image` | `POST /v1/images/edits` | multipart, source then refs. muse2api v0.1 returns 501 for this route, so edits fail with that message until it ships |
| `gen_video` (i2v) | `POST /v1/videos` + poll `GET /v1/videos/{id}` | one task per start frame, frame as `image` |
| `gen_video_omni` (r2v) | same | first reference becomes the first frame, the rest are dropped (warned); `duration_s` → `duration` |

Orientation maps to muse2api's `size`: landscape `16:9`, portrait `9:16`.
Media links are fetched from the configured base URL even when muse2api
advertises another host, then ingested into the media cache so they serve
from `/media/{id}` like any Flow render.

`is_available()` (the Settings green tick) is muse2api's `/readyz`, cached
for 30s; the Muse model catalog is its live list of chat models. Errors
carry muse2api's own message (e.g. `muse2api HTTP 503: no account
available`) and never the key.

## Queue + Pax worker

Nothing is configured per-provider: no CLI to install, no API key, no
Flow project. `is_available()` (and the Settings green tick) is driven by
**worker presence** — a Pax worker that polled the queue within
`FLOWBOARD_MUSE_WORKER_TTL_S` (default 300s) means the provider is up.

### Running a worker

On the same host as the agent:

```bash
python agent/scripts/muse_worker.py --worker-id pax-1
```

The reference script (`agent/scripts/muse_worker.py`) long-polls
`GET /api/provider-jobs/wait-next`, heartbeats every lease/3 while
working, reports progress, and completes/fails jobs. Its `handle_llm`
and `handle_media` are **stubs** — wire in your real tooling:

- `handle_llm(job)`: `job["prompt"]`, `job["extra"]["system_prompt"]`,
  `job["extra"]["attachments"]` (absolute paths on this host — read them
  directly). Return `{"text": "..."}`.
- `handle_media(job)`: inputs arrive as `file://` URLs (same host) in
  `source_url` / `start_url` / `reference_urls`; `job["extra"]` carries
  `variant_count`, `duration_s`, etc. Render with your image/video tools
  and complete with:
  ```json
  {"outputs": [{"output_url": "file:///path/to/render.png",
                "media_id": "<optional uuid hex>"}]}
  ```
  One output per requested slot (variants / start frames). The agent
  reads the bytes and ingests them into the media cache, so they serve
  from `/media/{id}` like any Flow render.

### Queue protocol (`/api/provider-jobs`)

| Endpoint | Who | What |
|---|---|---|
| `POST /` | producer | create a QUEUED job → `{id, ...}` |
| `GET /{id}/wait?timeout_s=` | producer | long-poll to terminal status |
| `GET /wait-next?provider=muse&worker_id=` | worker | long-poll + atomic claim |
| `POST /{id}/heartbeat` | worker | extend lease (CLAIMED→RUNNING) |
| `POST /{id}/progress` | worker | `{worker_id, progress 0-100, message?}` |
| `POST /{id}/complete` | worker | `{worker_id, result}` |
| `POST /{id}/fail` | worker | `{worker_id, error}` |
| `POST /{id}/cancel` | producer | cancel while non-terminal |
| `GET /workers/status?provider=muse` | UI | worker presence (advisory) |

Lease semantics: heartbeat/progress/complete/fail are accepted only from
the lease holder (`claimed_by == worker_id`) on a live (CLAIMED/RUNNING)
job; strangers get 409. complete/fail are idempotent for the lease holder
on an already-terminal job. A crashed worker's lease expires and the job
becomes reclaimable — jobs are never stranded.

## Timeouts

- `FLOWBOARD_MUSE_LLM_TIMEOUT_S` (default 600): producer wait per LLM job
  (also caps a muse2api chat call).
- `FLOWBOARD_MUSE_MEDIA_TIMEOUT_S` (default 1800): producer wait per media job
  (also the muse2api image/video deadline).
- `FLOWBOARD_MEDIA_PROVIDER` (`flow`|`muse`, default `flow`): default
  media backend when a request doesn't stamp `media_provider`.

The GenerationDialog stamps the user's sticky choice (`media_provider`)
per request; the Settings AI-Providers card shows Muse presence.
