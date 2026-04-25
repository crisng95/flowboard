# Autopilot Run 6 — Implementation Plan

Tracks `.omc/autopilot/spec.md`. Three waves.

## Wave A — Agent core (orchestrator)

1. `db/models.py` — extend Asset: `url: Optional[str]`, `node_id: Optional[int]`, unique index on `uuid_media_id`.
2. `db/__init__.py` / `db/session.py::init_db` — add a targeted migration: drop + recreate `asset` table only if its schema doesn't match. Safer than dropping everything. SQLite: `DROP TABLE IF EXISTS asset; ... create_all;` — but `create_all` only touches missing tables. Instead: if `asset` exists with old columns (check via pragma), drop + recreate.
   - Practical: `inspect(engine).has_table("asset")` + column list check. If mismatch → `Asset.__table__.drop(engine, checkfirst=True)` then `create_all`.
3. `services/media.py` — ingest + cache + fetch helpers. Uses httpx async client with 30s timeout. Validates GCS URL prefix server-side.
4. `services/flow_client.py` — add `media_urls_refresh` branch in `handle_message`. Opens its own DB session since it's called from the WS loop.
5. `routes/media.py` — GET routes for bytes + status.
6. `main.py` — register media router.

## Wave B — Extension (small)

1. `background.js` — inside the existing `chrome.runtime.onMessage` listener, add a `TRPC_MEDIA_URLS` branch: extract URLs, dedupe, send via WS.

## Wave C — Frontend (delegate to executor, Sonnet)

Touches `api/client.ts`, `components/ResultViewer.tsx`, `canvas/NodeCard.tsx`, and `styles.css` for new image + fallback rules.

## Wave D — Tests

Python tests:
- `test_media.py`: `ingest_urls` upsert/update, mock `httpx.AsyncClient` for fetch, /media/:id 404 / 200 with cache hit / 200 with fetch+cache, /api/media/:id/status shape, path traversal `../` rejected at the media_id param level.

## Wave E — QA

- pytest all green (≥78)
- tsc clean
- Agent restart (lifespan picks up new media router and the Asset schema migration)
- curl /api/media/nonexistent/status → 404

## Wave F — Validation (3 reviewers parallel)

- Architect: acceptance criteria 1-6 map to code
- Code-reviewer: cache lifecycle + polling + error surfaces + Asset schema migration safety
- Security: media_id path traversal, GCS URL re-validation prefix, disk write safety (filename sanitization), SSRF

## Wave G — Cleanup

Remove `.omc/autopilot/`. Write summary with smoke steps.

## Risks captured in spec

URL expiry, SSRF, path traversal, disk pressure, extension reload requirement.
