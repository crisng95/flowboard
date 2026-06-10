import type { Env } from '../types';
import { bucketName, collectReferencedStorageKeys } from './assetReferences';
import { SupabaseRest } from './supabase';

export const ASSET_GC_GRACE_HOURS = 24;
export const ASSET_GC_USER_BATCH = 100;
export const ASSET_GC_DELETE_BATCH = 500;

export type AssetRetentionState = 'active' | 'orphaned' | 'pinned';

export type AssetRow = {
  id: string;
  user_id: string;
  storage_key: string;
  retention_state?: AssetRetentionState | null;
  orphaned_at?: string | null;
};

export type AssetGcDecision = 'keep-active' | 'mark-orphaned' | 'revive-active' | 'purge' | 'skip-pinned';

export function classifyAssetRetention(
  asset: AssetRow,
  referencedKeys: Set<string>,
  nowMs: number,
  graceHours = ASSET_GC_GRACE_HOURS,
): AssetGcDecision {
  if (asset.retention_state === 'pinned') return 'skip-pinned';
  if (referencedKeys.has(asset.storage_key)) {
    return asset.retention_state === 'orphaned' ? 'revive-active' : 'keep-active';
  }
  if (asset.retention_state === 'orphaned') {
    const orphanedAtMs = asset.orphaned_at ? Date.parse(asset.orphaned_at) : Number.NaN;
    if (Number.isFinite(orphanedAtMs) && orphanedAtMs <= nowMs - (graceHours * 60 * 60 * 1000)) {
      return 'purge';
    }
  }
  return 'mark-orphaned';
}

async function listCandidateUserIds(db: SupabaseRest): Promise<string[]> {
  const rows = await db.get<Array<{ user_id?: string }>>('/rest/v1/assets', {
    select: 'user_id',
    retention_state: 'in.(active,orphaned)',
    order: 'user_id.asc',
    limit: ASSET_GC_USER_BATCH * 20,
  });
  const seen = new Set<string>();
  const userIds: string[] = [];
  for (const row of rows) {
    if (typeof row.user_id !== 'string' || !row.user_id || seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    userIds.push(row.user_id);
    if (userIds.length >= ASSET_GC_USER_BATCH) break;
  }
  return userIds;
}

async function listUserNodes(db: SupabaseRest, userId: string): Promise<Array<{ data?: unknown }>> {
  const boards = await db.get<Array<{ id: string }>>('/rest/v1/boards', {
    user_id: `eq.${userId}`,
    select: 'id',
    limit: 5000,
  });
  const boardIds = boards
    .map((row) => row.id)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (boardIds.length === 0) return [];
  return db.get<Array<{ data?: unknown }>>('/rest/v1/nodes', {
    user_id: `eq.${userId}`,
    board_id: `in.(${boardIds.join(',')})`,
    select: 'data',
    limit: 20000,
  });
}

async function listUserAssets(db: SupabaseRest, userId: string): Promise<AssetRow[]> {
  return db.get<AssetRow[]>('/rest/v1/assets', {
    user_id: `eq.${userId}`,
    retention_state: 'in.(active,orphaned,pinned)',
    select: 'id,user_id,storage_key,retention_state,orphaned_at',
    order: 'created_at.asc',
    limit: 20000,
  });
}

async function purgeAsset(env: Env, db: SupabaseRest, asset: AssetRow): Promise<void> {
  if (env.ASSETS_BUCKET) {
    try {
      await env.ASSETS_BUCKET.delete(asset.storage_key);
    } catch {
      return;
    }
  }
  await db.request('/rest/v1/assets', {
    method: 'DELETE',
    headers: { prefer: 'return=minimal' },
  }, {
    id: `eq.${asset.id}`,
    user_id: `eq.${asset.user_id}`,
  });
}

export async function runAssetGc(env: Env): Promise<void> {
  const db = new SupabaseRest(env);
  const userIds = await listCandidateUserIds(db);
  if (userIds.length === 0) return;

  const nowMs = Date.now();
  const bucket = bucketName(env);

  for (const userId of userIds) {
    const [nodes, assets] = await Promise.all([
      listUserNodes(db, userId),
      listUserAssets(db, userId),
    ]);
    if (assets.length === 0) continue;

    const referencedKeys = collectReferencedStorageKeys(nodes, userId, bucket);
    const toRevive: string[] = [];
    const toOrphan: string[] = [];
    const toPurge = assets
      .map((asset) => ({ asset, decision: classifyAssetRetention(asset, referencedKeys, nowMs) }))
      .filter((entry) => entry.decision === 'purge')
      .slice(0, ASSET_GC_DELETE_BATCH)
      .map((entry) => entry.asset);

    for (const asset of assets) {
      const decision = classifyAssetRetention(asset, referencedKeys, nowMs);
      if (decision === 'revive-active') toRevive.push(asset.id);
      if (decision === 'mark-orphaned' && asset.retention_state !== 'orphaned') toOrphan.push(asset.id);
    }

    if (toRevive.length > 0) {
      await db.patch('/rest/v1/assets', {
        retention_state: 'active',
        orphaned_at: null,
      }, {
        id: `in.(${toRevive.join(',')})`,
        user_id: `eq.${userId}`,
      });
    }

    if (toOrphan.length > 0) {
      await db.patch('/rest/v1/assets', {
        retention_state: 'orphaned',
        orphaned_at: new Date(nowMs).toISOString(),
      }, {
        id: `in.(${toOrphan.join(',')})`,
        user_id: `eq.${userId}`,
      });
    }

    for (const asset of toPurge) {
      await purgeAsset(env, db, asset);
    }
  }
}
