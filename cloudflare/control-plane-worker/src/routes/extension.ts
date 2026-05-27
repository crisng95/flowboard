import { Hono } from 'hono';
import { z } from 'zod';
import { extensionAuth } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { headObject, presignPut } from '../lib/r2Presign';
import {
  assertAssetQuota,
  assertContentType,
  assertProgressStage,
  clampLease,
  clampUploadTtl,
  parseRequestIdFromStorageKey,
  requireClaimedRequest,
  validateStorageKey,
} from '../lib/requestGuards';
import { SupabaseRest } from '../lib/supabase';
import type { AppBindings, AssetInput } from '../types';

export const extensionRoutes = new Hono<AppBindings>();

extensionRoutes.use('/extension/*', extensionAuth);

const claimSchema = z.object({
  provider: z.string().min(1).max(40),
  lease_duration_sec: z.number().int().optional(),
});
const requestLeaseSchema = z.object({
  request_id: z.string().uuid(),
  lease_duration_sec: z.number().int().optional(),
});
const progressSchema = z.object({
  request_id: z.string().uuid(),
  progress_stage: z.string(),
  progress: z.number().int().min(0).max(100),
});
const projectSchema = z.object({
  request_id: z.string().uuid(),
  project_id: z.string().min(1).max(160),
});
const signUploadSchema = z.object({
  storage_key: z.string(),
  content_type: z.string(),
  expires_in: z.number().int().optional(),
});
const completeSchema = z.object({
  request_id: z.string().uuid(),
  output_result: z.record(z.unknown()).default({}),
  assets: z.array(z.record(z.unknown())).default([]),
});
const failSchema = z.object({
  request_id: z.string().uuid(),
  error_message: z.string().min(1).max(1000),
  debug_snapshot_bucket: z.string().optional().nullable(),
  debug_snapshot_key: z.string().optional().nullable(),
});
const confirmUploadSchema = z.object({
  request_id: z.string().uuid(),
  storage_key: z.string(),
  mime_type: z.string(),
  byte_size: z.number().int().positive(),
  checksum: z.string().min(16).max(128).optional(),
});

extensionRoutes.post('/extension/claim', async (c) => {
  const body = claimSchema.parse(await c.req.json());
  const db = new SupabaseRest(c.env);
  const rows = await db.post<Record<string, unknown>[]>('/rest/v1/rpc/claim_next_request', {
    p_provider: body.provider,
    p_client_id: c.get('clientId'),
    p_lease_duration_sec: clampLease(body.lease_duration_sec),
  });
  const job = rows[0];
  if (!job) throw new ApiError(409, 'NO_QUEUED_REQUESTS', 'No queued requests available for claim under this provider');
  return c.json(job);
});

extensionRoutes.post('/extension/heartbeat', async (c) => {
  const body = requestLeaseSchema.parse(await c.req.json());
  await requireClaimedRequest(c.env, body.request_id, c.get('clientId'), c.get('clientUserId'));
  const db = new SupabaseRest(c.env);
  const rows = await db.post<Record<string, unknown>[]>('/rest/v1/rpc/renew_request_lease', {
    p_request_id: body.request_id,
    p_client_id: c.get('clientId'),
    p_lease_duration_sec: clampLease(body.lease_duration_sec),
  });
  return c.json(rows[0] || { ok: true });
});

extensionRoutes.post('/extension/progress', async (c) => {
  const body = progressSchema.parse(await c.req.json());
  const stage = assertProgressStage(body.progress_stage);
  await requireClaimedRequest(c.env, body.request_id, c.get('clientId'), c.get('clientUserId'));
  const db = new SupabaseRest(c.env);
  const rows = await db.post<Record<string, unknown>[]>('/rest/v1/rpc/update_request_progress', {
    p_request_id: body.request_id,
    p_client_id: c.get('clientId'),
    p_progress_stage: stage,
    p_progress: body.progress,
  });
  return c.json(rows[0] || { ok: true });
});

extensionRoutes.post('/extension/project', async (c) => {
  const body = projectSchema.parse(await c.req.json());
  const userId = c.get('clientUserId');
  const req = await requireClaimedRequest(c.env, body.request_id, c.get('clientId'), userId);
  const db = new SupabaseRest(c.env);
  const output = { ...(req.output_result ?? {}), project_id: body.project_id };
  const input = { ...(req.input_data ?? {}), project_id: body.project_id };
  const rows = await db.patch<Record<string, unknown>[]>('/rest/v1/requests', {
    input_data: input,
    output_result: output,
  }, {
    id: `eq.${body.request_id}`,
    user_id: `eq.${userId}`,
  });
  return c.json(rows[0] || { ok: true, project_id: body.project_id });
});

extensionRoutes.post('/extension/sign-upload', async (c) => {
  const body = signUploadSchema.parse(await c.req.json());
  const userId = c.get('clientUserId');
  const storageKey = validateStorageKey(body.storage_key, userId);
  const requestId = parseRequestIdFromStorageKey(storageKey);
  await requireClaimedRequest(c.env, requestId, c.get('clientId'), userId);
  const contentType = assertContentType(body.content_type);
  const expiresIn = clampUploadTtl(body.expires_in);
  return c.json({ url: await presignPut(c.env, storageKey, contentType, expiresIn), expires_in: expiresIn });
});

extensionRoutes.post('/extension/confirm-upload', async (c) => {
  const body = confirmUploadSchema.parse(await c.req.json());
  const userId = c.get('clientUserId');
  const storageKey = validateStorageKey(body.storage_key, userId);
  const keyRequestId = parseRequestIdFromStorageKey(storageKey);
  if (keyRequestId !== body.request_id) throw new ApiError(400, 'REQUEST_KEY_MISMATCH', 'storage_key request id does not match request_id');
  await requireClaimedRequest(c.env, body.request_id, c.get('clientId'), userId);
  assertContentType(body.mime_type);
  assertAssetQuota(body.byte_size);
  const object = await headObject(c.env, storageKey);
  if (!object) throw new ApiError(404, 'R2_OBJECT_NOT_FOUND', 'Uploaded object was not found in R2');
  if (object.size !== body.byte_size) throw new ApiError(409, 'R2_SIZE_MISMATCH', 'Uploaded object size does not match metadata');
  return c.json({ ok: true, size: object.size, uploaded_at: object.uploaded?.toISOString?.() || null });
});

extensionRoutes.post('/extension/complete', async (c) => {
  const body = completeSchema.parse(await c.req.json());
  const userId = c.get('clientUserId');
  await requireClaimedRequest(c.env, body.request_id, c.get('clientId'), userId);
  const assets = validateAssets(body.assets, userId, body.request_id);
  for (const asset of assets) {
    const object = await headObject(c.env, asset.storage_key || '');
    if (!object) throw new ApiError(404, 'R2_OBJECT_NOT_FOUND', `Uploaded object not found: ${asset.storage_key}`);
    if (object.size !== asset.byte_size) throw new ApiError(409, 'R2_SIZE_MISMATCH', `Uploaded object size mismatch: ${asset.storage_key}`);
  }
  const db = new SupabaseRest(c.env);
  const rows = await db.post<Record<string, unknown>[]>('/rest/v1/rpc/complete_request_with_assets', {
    p_request_id: body.request_id,
    p_client_id: c.get('clientId'),
    p_output_result: body.output_result,
    p_assets: assets,
  });
  return c.json(rows[0] || { ok: true });
});

extensionRoutes.post('/extension/fail', async (c) => {
  const body = failSchema.parse(await c.req.json());
  await requireClaimedRequest(c.env, body.request_id, c.get('clientId'), c.get('clientUserId'));
  const db = new SupabaseRest(c.env);
  const rows = await db.post<Record<string, unknown>[]>('/rest/v1/rpc/fail_request_with_event', {
    p_request_id: body.request_id,
    p_client_id: c.get('clientId'),
    p_error_message: body.error_message,
    p_debug_snapshot_bucket: body.debug_snapshot_bucket || null,
    p_debug_snapshot_key: body.debug_snapshot_key || null,
  });
  return c.json(rows[0] || { ok: true });
});

function validateAssets(values: Array<Record<string, unknown>>, userId: string, requestId: string): AssetInput[] {
  return values.map((asset, index) => {
    const storageKey = validateStorageKey(asset.storage_key, userId);
    const keyRequestId = parseRequestIdFromStorageKey(storageKey);
    if (keyRequestId !== requestId) throw new ApiError(400, 'ASSET_REQUEST_MISMATCH', `Asset ${index} storage_key does not match request_id`);
    const mimeType = assertContentType(asset.mime_type);
    const byteSize = assertAssetQuota(asset.byte_size);
    return {
      source_provider: typeof asset.source_provider === 'string' ? asset.source_provider : 'flow',
      file_name: typeof asset.file_name === 'string' ? asset.file_name : `output-${index}`,
      storage_key: storageKey,
      mime_type: mimeType,
      byte_size: byteSize,
      checksum: typeof asset.checksum === 'string' ? asset.checksum : undefined,
      prompt_snapshot: typeof asset.prompt_snapshot === 'string' ? asset.prompt_snapshot : null,
    };
  });
}
