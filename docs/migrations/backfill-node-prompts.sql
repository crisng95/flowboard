-- Backfill `node.data.prompt` from latest done request — recovery script
-- for the regression introduced in Phase 20 (commit 3c83f0c) and fixed
-- in v1.1.3.
--
-- Symptom: many existing nodes show "(no prompt)" in the ResultViewer
-- detail panel after page reload, even though the image was clearly
-- generated with a prompt at the time.
--
-- Root cause: the Phase 20 "only deltas" patchNode refactor accidentally
-- dropped `prompt` from the data payload sent on generation completion.
-- Since the dispatch flow only stamped prompt to the in-memory store
-- (never to the backend), the field was silently lost on the next
-- board fetch.
--
-- The forward fix lives in `frontend/src/store/generation.ts` (re-adds
-- prompt to both polling-done patchNode payloads). This script recovers
-- existing nodes by reading their latest done request's `params.prompt`.
--
-- Usage:
--   sqlite3 storage/flowboard.db < docs/migrations/backfill-node-prompts.sql
--
-- Idempotent — re-running is safe (skips nodes that already have a prompt).
-- Affects only image/video/character nodes with status='done'.
-- Uploaded nodes (no request rows) are left alone — there is no prompt
-- to recover for those.

UPDATE node
SET data = json_set(
  coalesce(data, '{}'),
  '$.prompt',
  (
    SELECT json_extract(r.params, '$.prompt')
    FROM request r
    WHERE r.node_id = node.id
      AND r.type IN ('gen_image', 'gen_video', 'edit_image')
      AND r.status = 'done'
      AND json_extract(r.params, '$.prompt') IS NOT NULL
      AND json_extract(r.params, '$.prompt') != ''
    ORDER BY r.id DESC
    LIMIT 1
  )
)
WHERE type IN ('image', 'video', 'character')
  AND status = 'done'
  AND (json_extract(data, '$.prompt') IS NULL OR json_extract(data, '$.prompt') = '')
  AND EXISTS (
    SELECT 1 FROM request r
    WHERE r.node_id = node.id
      AND r.type IN ('gen_image', 'gen_video', 'edit_image')
      AND r.status = 'done'
      AND json_extract(r.params, '$.prompt') IS NOT NULL
      AND json_extract(r.params, '$.prompt') != ''
  );

SELECT changes() AS rows_updated;
