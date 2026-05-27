# Zero-Cost MVP/Beta Deployment

This is the production-facing path for a zero-maintenance-cost Flowboard beta.
It replaces the always-on FastAPI Control Plane with a thin Cloudflare Worker.

## Target Architecture

```text
Cloudflare Pages      -> app.flowboard.bond
Cloudflare Worker     -> api.flowboard.bond
Supabase Free         -> Auth + Postgres
Cloudflare R2         -> generated asset storage
Chrome Extension      -> authenticated execution worker
```

The local FastAPI app, local WebSocket bridge, CDP, and Playwright flows remain
development-only harnesses. End users must not need a local backend process.

## Required Invariants

- Do not use FastAPI as the zero-cost production Control Plane.
- Do not let the extension write directly to Supabase.
- Do not put `SUPABASE_SERVICE_ROLE_KEY`, R2 access keys, or signing secrets in the extension.
- Extension calls Worker endpoints; Worker verifies pairing, claimed request, owner, and lease before writing DB state.
- Large uploads use presigned PUT URLs. Do not proxy video bytes through the Worker.
- Worker is a thin Control Plane, not an execution worker.
- Heartbeat must be 60 seconds or slower.
- Lease should be 3-5 minutes.
- Progress updates are stage-based, not continuous percentage streaming.
- R2 and Supabase quota guards are required during beta.

## Cloudflare Worker

Worker source lives in:

```text
cloudflare/control-plane-worker
```

Primary routes:

```text
GET  /api/health
POST /api/pairings/register
POST /api/pairings/rotate-secret
POST /api/assets/sign-read
POST /api/assets/sign-upload
POST /api/extension/claim
POST /api/extension/heartbeat
POST /api/extension/progress
POST /api/extension/sign-upload
POST /api/extension/confirm-upload
POST /api/extension/complete
POST /api/extension/fail
```

Important behavior:

- `/api/extension/claim` calls Supabase RPC `claim_next_request`; there is no non-atomic select+patch fallback.
- `/api/extension/sign-upload` parses `request_id` from `users/{user_id}/flow/{request_id}/...` and verifies the request is claimed by the calling client before signing.
- `/api/extension/confirm-upload` checks the R2 object through the R2 binding before accepting metadata.
- `/api/extension/complete` validates asset storage keys, MIME types, request ownership, and beta asset size limit before calling `complete_request_with_assets`.

## Worker Secrets

Set these with Wrangler. Do not commit them.

```powershell
cd C:\Frog\Tool\Flow_workflow\flowboard\cloudflare\control-plane-worker
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put R2_ENDPOINT
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

`R2_BUCKET_NAME`, `ALLOWED_ORIGINS`, and the R2 binding are configured in `wrangler.toml`.

## DNS

Recommended records after deploy target exists:

```text
api.flowboard.bond -> Cloudflare Worker custom domain
app.flowboard.bond -> Cloudflare Pages project
www.flowboard.bond -> landing or redirect
flowboard.bond     -> landing or redirect
```

Keep DNSSEC off until DNS, Pages, Worker, and smoke tests are stable.

## Quota Policy For Beta

- Heartbeat: 60-120 seconds.
- Lease: 180-300 seconds.
- Progress: only coarse stages such as `preparing`, `submitting`, `waiting_provider`, `extracting`, `uploading`, `completed`, `failed`.
- Signed URL TTL: 10-15 minutes.
- Asset beta limit: 100 MB/job output object until paid storage policy exists.
- Request events retention: 7-14 days.
- Debug snapshots: error/critical only.

## Verification

Worker local checks:

```powershell
cd C:\Frog\Tool\Flow_workflow\flowboard\cloudflare\control-plane-worker
npm run typecheck
npm test
```

Deployment smoke should verify:

```text
queued -> running -> completed
extension claimed the request
real Flow asset uploaded to R2
asset row written through Worker
R2 object exists
checksum and metadata match
cleanup succeeds
```
