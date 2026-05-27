import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { presignGet, presignPut } from '../lib/r2Presign';
import { assertAssetQuota, assertContentType, clampUploadTtl, validateStorageKey } from '../lib/requestGuards';
import { SupabaseRest } from '../lib/supabase';
import type { AppBindings } from '../types';

export const assetRoutes = new Hono<AppBindings>();

const signReadSchema = z.object({ asset_id: z.string().uuid() });
const signUploadSchema = z.object({
  storage_key: z.string(),
  content_type: z.string(),
  expires_in: z.number().int().optional(),
});

function safeFileName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean.slice(0, 96) || 'upload.bin';
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function ensureNodeOwner(db: SupabaseRest, userId: string, nodeId: string): Promise<void> {
  const rows = await db.get<Array<{ id: string }>>('/rest/v1/nodes', {
    id: `eq.${nodeId}`,
    user_id: `eq.${userId}`,
    select: 'id',
    limit: 1,
  });
  if (!rows.length) throw new ApiError(403, 'NODE_ACCESS_DENIED', 'Node access denied or node does not exist');
}

assetRoutes.post('/assets/sign-read', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const body = signReadSchema.parse(await c.req.json());
  const db = new SupabaseRest(c.env);
  const assets = await db.get<Array<{ storage_key?: string }>>('/rest/v1/assets', {
    id: `eq.${body.asset_id}`,
    user_id: `eq.${userId}`,
    select: 'storage_key',
    limit: 1,
  });
  const storageKey = assets[0]?.storage_key;
  if (!storageKey) throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found or access denied');
  return c.json({ url: await presignGet(c.env, storageKey, 900), expires_in: 900 });
});

assetRoutes.post('/assets/sign-upload', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const body = signUploadSchema.parse(await c.req.json());
  const contentType = assertContentType(body.content_type);
  const storageKey = validateStorageKey(body.storage_key, userId);
  const expiresIn = clampUploadTtl(body.expires_in);
  return c.json({ url: await presignPut(c.env, storageKey, contentType, expiresIn), expires_in: expiresIn });
});

assetRoutes.post('/upload', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  if (!c.env.ASSETS_BUCKET) throw new ApiError(500, 'R2_BINDING_MISSING', 'R2 bucket binding is not configured');

  const form = await c.req.formData();
  const file = form.get('file') as unknown as File | null;
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    throw new ApiError(400, 'FILE_REQUIRED', 'Upload requires a file field');
  }

  const contentType = assertContentType(file.type || 'application/octet-stream');
  const size = assertAssetQuota(file.size);
  const nodeId = form.get('node_id');
  const nodeUuid = typeof nodeId === 'string' && nodeId.trim() ? nodeId.trim() : null;

  const db = new SupabaseRest(c.env);
  if (nodeUuid) await ensureNodeOwner(db, userId, nodeUuid);

  const bytes = await file.arrayBuffer();
  const checksum = await sha256Hex(bytes);
  const fileName = safeFileName(file.name || 'upload');
  const storageKey = `users/${userId}/uploads/${crypto.randomUUID()}-${fileName}`;

  await c.env.ASSETS_BUCKET.put(storageKey, bytes, {
    httpMetadata: { contentType },
    customMetadata: { user_id: userId, checksum, source: 'web_upload' },
  });

  const rows = await db.post<Array<{ id: string }>>('/rest/v1/assets', {
    user_id: userId,
    source_provider: 'web_upload',
    file_name: fileName,
    bucket_name: c.env.R2_BUCKET_NAME,
    storage_key: storageKey,
    mime_type: contentType,
    byte_size: size,
    checksum,
  });
  const assetId = rows[0]?.id;
  const signedUrl = await presignGet(c.env, storageKey, 3600);

  return c.json({
    media_id: signedUrl,
    asset_id: assetId,
    storage_key: storageKey,
    mime: contentType,
    size,
  });
});
