import { ApiError } from './errors';
import { SupabaseRest } from './supabase';
import type { Env, RequestRow } from '../types';

export const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'video/mp4']);
const ALLOWED_PROGRESS_STAGES = new Set(['preparing', 'submitting', 'waiting_provider', 'extracting', 'uploading', 'completed', 'failed']);

export function clampLease(seconds: unknown): number {
  const value = Number(seconds || 300);
  return Math.max(180, Math.min(300, Number.isFinite(value) ? value : 300));
}

export function clampUploadTtl(seconds: unknown): number {
  const value = Number(seconds || 900);
  return Math.max(600, Math.min(900, Number.isFinite(value) ? value : 900));
}

export function assertProgressStage(stage: unknown): string {
  if (typeof stage !== 'string' || !ALLOWED_PROGRESS_STAGES.has(stage)) {
    throw new ApiError(400, 'INVALID_PROGRESS_STAGE', 'Progress must use a known coarse stage');
  }
  return stage;
}

export function assertContentType(contentType: unknown): string {
  if (typeof contentType !== 'string' || !ALLOWED_MIMES.has(contentType)) {
    throw new ApiError(400, 'UNSUPPORTED_MIME', 'Unsupported MIME type');
  }
  return contentType;
}

export function validateStorageKey(storageKey: unknown, userId: string): string {
  if (typeof storageKey !== 'string' || !storageKey) throw new ApiError(400, 'INVALID_STORAGE_KEY', 'storage_key is required');
  const expectedPrefix = `users/${userId}/`;
  if (!storageKey.startsWith(expectedPrefix)) {
    throw new ApiError(403, 'STORAGE_KEY_FORBIDDEN', `storage_key must start with ${expectedPrefix}`);
  }
  if (storageKey.startsWith('/') || storageKey.includes('..') || storageKey.includes('\\') || storageKey.includes('//') || /[\x00-\x1f\x7f-\x9f]/.test(storageKey)) {
    throw new ApiError(400, 'INVALID_STORAGE_KEY', 'storage_key contains forbidden characters');
  }
  return storageKey;
}

export function parseRequestIdFromStorageKey(storageKey: string): string {
  const match = /^users\/[^/]+\/flow\/([^/]+)\/[^/]+$/.exec(storageKey);
  if (!match) throw new ApiError(400, 'INVALID_STORAGE_KEY', 'storage_key must include users/{user_id}/flow/{request_id}/file');
  return match[1];
}

export async function requireClaimedRequest(env: Env, requestId: string, clientId: string, userId: string): Promise<RequestRow> {
  const db = new SupabaseRest(env);
  const rows = await db.get<RequestRow[]>('/rest/v1/requests', {
    id: `eq.${requestId}`,
    claimed_by: `eq.${clientId}`,
    user_id: `eq.${userId}`,
    select: 'id,user_id,provider,status,claimed_by,lease_expires_at,input_data,output_result',
    limit: 1,
  });
  const req = rows[0];
  if (!req) throw new ApiError(403, 'REQUEST_NOT_CLAIMED_BY_CLIENT', 'Request is not claimed by this extension client');
  if (req.status !== 'claimed' && req.status !== 'running') {
    throw new ApiError(409, 'REQUEST_NOT_RUNNING', `Request status is ${req.status}`);
  }
  const expiry = req.lease_expires_at ? Date.parse(req.lease_expires_at) : 0;
  if (!expiry || expiry <= Date.now()) throw new ApiError(409, 'LEASE_EXPIRED', 'Request lease expired');
  return req;
}

export function assertAssetQuota(byteSize: unknown): number {
  const size = Number(byteSize || 0);
  if (!Number.isFinite(size) || size <= 0) throw new ApiError(400, 'INVALID_ASSET_SIZE', 'byte_size must be positive');
  const max = 100 * 1024 * 1024;
  if (size > max) throw new ApiError(413, 'ASSET_TOO_LARGE', 'Asset exceeds 100 MB beta limit');
  return size;
}
