# Asset GC rollout

This rollout enables reference-aware garbage collection for cloud media.

## Scope

- add `assets.retention_state` and `assets.orphaned_at`
- keep referenced media `active`
- mark unreferenced media `orphaned`
- purge orphaned media after 24 hours
- run GC from the control-plane worker every 15 minutes

## Production steps

1. Apply `docs/migrations/add-asset-retention-gc.sql` to Supabase production.
2. Deploy `cloudflare/control-plane-worker`.
3. Verify the worker shows both cron triggers:
   - `*/2 * * * *`
   - `*/15 * * * *`

## Notes

- Board deletion now removes graph references first and lets GC decide storage liveness.
- Missing R2 objects during purge are treated as already deleted, and the stale DB row is removed.
