# Muse provider

**Muse** is Flowboard's delegated provider: Pax (this assistant) acting as
both an LLM backend and a media-generation backend, instead of the
CLI/API providers (Claude / Gemini / Codex) and Google Flow.

- **LLM features** (Auto-prompt, Vision, Planner): pin any feature to
  `Muse (Pax)` in Settings → AI Providers. `run()` publishes an `llm` job
  to the provider-job queue and waits for a Pax worker to answer it with
  its own language/vision tools.
- **Media** (image / edit / video): pick **Muse** in the GenerationDialog's
  Backend chip. `gen_image`, `edit_image`, `gen_video`, `gen_video_omni`
  route to the queue instead of the Flow SDK — no Flow plan, no Chrome
  extension, no paygate tier needed.

Nothing is configured per-provider: no CLI to install, no API key, no
Flow project. `is_available()` (and the Settings green tick) is driven by
**worker presence** — a Pax worker that polled the queue within
`FLOWBOARD_MUSE_WORKER_TTL_S` (default 300s) means the provider is up.

## Running a worker

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

## Queue protocol (`/api/provider-jobs`)

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

- `FLOWBOARD_MUSE_LLM_TIMEOUT_S` (default 600): producer wait per LLM job.
- `FLOWBOARD_MUSE_MEDIA_TIMEOUT_S` (default 1800): producer wait per media job.
- `FLOWBOARD_MEDIA_PROVIDER` (`flow`|`muse`, default `flow`): default
  media backend when a request doesn't stamp `media_provider`.

The GenerationDialog stamps the user's sticky choice (`media_provider`)
per request; the Settings AI-Providers card shows Muse presence.
