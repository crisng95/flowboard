-- Cloud asset GC state for Supabase control-plane.
-- Apply on the cloud database before deploying the reference-aware R2 GC.
--
-- Example:
--   psql "$SUPABASE_DB_URL" -f docs/migrations/add-asset-retention-gc.sql
--   or run in Supabase SQL Editor.

alter table assets
  add column if not exists retention_state text not null default 'active',
  add column if not exists orphaned_at timestamptz null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'assets_retention_state_check'
  ) then
    alter table assets
      add constraint assets_retention_state_check
      check (retention_state in ('active', 'orphaned', 'pinned'));
  end if;
end $$;

create index if not exists assets_user_retention_orphaned_idx
  on assets (user_id, retention_state, orphaned_at);
