-- Clear polluted `paygate_tier` from existing request.params rows.
--
-- Background: Phase 1 of the v1.1.5 fix removed the worker's silent
-- fallback to PAYGATE_TIER_ONE when no live tier signal was present.
-- Before that fix, every gen dispatched while the extension hadn't
-- finished sniffing would stamp `paygate_tier: "PAYGATE_TIER_ONE"`
-- into request.params, regardless of the user's actual plan. That
-- value then fed back through `_last_observed_paygate_tier_from_db()`
-- in /api/auth/me as a permanent (and possibly wrong) Pro reading
-- until a fresh known-good gen overwrote it. Ultra users were
-- silently being served at the Pro checkpoint with no warning.
--
-- The forward fix (worker fail-loud + auth route trusts only the live
-- signal) prevents new pollution, but existing rows still carry stale
-- tier values. /api/auth/me no longer reads from them — but anything
-- else that scans request.params for tier (and there could be future
-- consumers) would still see bad data. Strip them out so the DB
-- reflects "tier unknown for past requests, will be re-stamped on
-- the next dispatch with a known-good live signal".
--
-- Idempotent — re-running is safe. Only touches the `paygate_tier` key.
--
-- Usage:
--   sqlite3 storage/flowboard.db < docs/migrations/clear-polluted-paygate-tier.sql

UPDATE request
SET params = json_remove(params, '$.paygate_tier')
WHERE json_extract(params, '$.paygate_tier') IS NOT NULL;

SELECT changes() AS rows_cleared;
