import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { presignGet, presignPut, verifySignedRead } from '../lib/r2Presign';
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
const readQuerySchema = z.object({
  key: z.string().min(1),
  exp: z.coerce.number().int().positive(),
  sig: z.string().regex(/^[a-f0-9]{64}$/i),
});

function safeFileName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean.slice(0, 96) || 'upload.bin';
}

function isSafeReadKey(storageKey: string): boolean {
  return storageKey.startsWith('users/') && !storageKey.includes('..') && !storageKey.includes('\\');
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

assetRoutes.get('/assets/read', async (c) => {
  if (!c.env.ASSETS_BUCKET) throw new ApiError(500, 'R2_BINDING_MISSING', 'R2 bucket binding is not configured');

  const query = readQuerySchema.parse(c.req.query());
  if (!isSafeReadKey(query.key)) {
    throw new ApiError(400, 'INVALID_STORAGE_KEY', 'Invalid storage key');
  }
  const now = Math.floor(Date.now() / 1000);
  if (query.exp < now) {
    throw new ApiError(401, 'READ_URL_EXPIRED', 'Signed asset URL has expired');
  }
  const ok = await verifySignedRead(c.env, query.key, query.exp, query.sig);
  if (!ok) {
    throw new ApiError(401, 'READ_URL_INVALID', 'Signed asset URL is invalid');
  }

  const rangeHeader = c.req.header('range');
  const object = rangeHeader
    ? await c.env.ASSETS_BUCKET.get(query.key, { range: c.req.raw.headers })
    : await c.env.ASSETS_BUCKET.get(query.key);
  if (!object) {
    throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found');
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', `private, max-age=${Math.max(0, Math.min(300, query.exp - now))}`);
  headers.set('cross-origin-resource-policy', 'cross-origin');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-length', String(object.size));

  const objectRange = (object as R2ObjectBody & { range?: { offset?: number; length?: number } }).range;
  if (rangeHeader && objectRange && typeof objectRange.offset === 'number' && typeof objectRange.length === 'number') {
    const start = objectRange.offset;
    const end = start + objectRange.length - 1;
    headers.set('content-length', String(objectRange.length));
    headers.set('content-range', `bytes ${start}-${end}/${object.size}`);
  }

  return new Response(object.body, {
    status: rangeHeader ? 206 : 200,
    headers,
  });
});

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
  return c.json({ url: await presignGet(c.env, c.req.url, storageKey, 900), expires_in: 900 });
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
    retention_state: 'active',
    orphaned_at: null,
  });
  const assetId = rows[0]?.id;
  const signedUrl = await presignGet(c.env, c.req.url, storageKey, 3600);

  return c.json({
    media_id: signedUrl,
    asset_id: assetId,
    storage_key: storageKey,
    mime: contentType,
    size,
  });
});