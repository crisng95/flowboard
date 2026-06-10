import type { Env } from '../types';

function objectData(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

export function storageKeyFromSignedUrl(value: string, bucketName: string): string | null {
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.pathname === '/api/assets/read') {
      const key = url.searchParams.get('key');
      return key && key.length > 0 ? key : null;
    }
    const marker = `/${bucketName}/`;
    const idx = url.pathname.indexOf(marker);
    if (idx === -1) return null;
    return decodeURIComponent(url.pathname.slice(idx + marker.length));
  } catch {
    return null;
  }
}

export function userStorageKey(value: unknown, userId: string, bucketName: string): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith(`users/${userId}/`)) return value;
  const fromUrl = storageKeyFromSignedUrl(value, bucketName);
  return fromUrl?.startsWith(`users/${userId}/`) ? fromUrl : null;
}

function maybeAdd(set: Set<string>, value: unknown, userId: string, bucketName: string): void {
  const key = userStorageKey(value, userId, bucketName);
  if (key) set.add(key);
}

export function collectReferencedStorageKeys(
  nodes: Array<{ data?: unknown }>,
  userId: string,
  bucketName: string,
): Set<string> {
  const refs = new Set<string>();
  for (const node of nodes) {
    const data = objectData(node?.data);
    maybeAdd(refs, data.storageKey, userId, bucketName);
    maybeAdd(refs, data.mediaId, userId, bucketName);
    maybeAdd(refs, data.flowMediaId, userId, bucketName);

    if (Array.isArray(data.storageKeys)) {
      for (const value of data.storageKeys) maybeAdd(refs, value, userId, bucketName);
    }
    if (Array.isArray(data.mediaIds)) {
      for (const value of data.mediaIds) maybeAdd(refs, value, userId, bucketName);
    }
    if (Array.isArray(data.listItems)) {
      for (const rawItem of data.listItems) {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
        const item = rawItem as Record<string, unknown>;
        maybeAdd(refs, item.storageKey, userId, bucketName);
        maybeAdd(refs, item.mediaId, userId, bucketName);
        maybeAdd(refs, item.mediaUrl, userId, bucketName);
        maybeAdd(refs, item.imageUrl, userId, bucketName);
        maybeAdd(refs, item.flowMediaId, userId, bucketName);
      }
    }
  }
  return refs;
}

export function bucketName(env: Env): string {
  return env.R2_BUCKET_NAME || 'flowboard-prod-assets';
}

export const __test__objectData = objectData;
