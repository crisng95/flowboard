import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { presignGet, presignPut } from '../lib/r2Presign';
import { assertContentType, clampUploadTtl, validateStorageKey } from '../lib/requestGuards';
import { SupabaseRest } from '../lib/supabase';
import type { AppBindings } from '../types';

export const assetRoutes = new Hono<AppBindings>();

const signReadSchema = z.object({ asset_id: z.string().uuid() });
const signUploadSchema = z.object({
  storage_key: z.string(),
  content_type: z.string(),
  expires_in: z.number().int().optional(),
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
