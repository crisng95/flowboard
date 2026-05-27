import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, sha256Hex } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { SupabaseRest } from '../lib/supabase';
import type { AppBindings } from '../types';

export const pairingRoutes = new Hono<AppBindings>();

const registerSchema = z.object({
  client_name: z.string().min(1).max(100),
  client_installation_id: z.string().uuid(),
  secret: z.string().min(24).max(512),
});

const rotateSchema = z.object({
  pairing_id: z.string().uuid(),
  new_secret: z.string().min(24).max(512),
});

pairingRoutes.post('/pairings/register', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const body = registerSchema.parse(await c.req.json());
  const db = new SupabaseRest(c.env);

  const existing = await db.get<Array<{ id: string }>>('/rest/v1/extension_clients', {
    user_id: `eq.${userId}`,
    client_installation_id: `eq.${body.client_installation_id}`,
    select: 'id',
    limit: 1,
  });

  let clientId = existing[0]?.id;
  if (!clientId) {
    const inserted = await db.post<Array<{ id: string }>>('/rest/v1/extension_clients', {
      user_id: userId,
      client_name: body.client_name,
      client_installation_id: body.client_installation_id,
      is_online: true,
    });
    clientId = inserted[0]?.id;
  }
  if (!clientId) throw new ApiError(500, 'PAIRING_CREATE_FAILED', 'Failed to create extension client');

  await db.patch('/rest/v1/pairings', { is_active: false }, {
    user_id: `eq.${userId}`,
    extension_client_id: `eq.${clientId}`,
    is_active: 'eq.true',
  });

  const pairing = await db.post<Array<Record<string, unknown>>>('/rest/v1/pairings', {
    user_id: userId,
    extension_client_id: clientId,
    current_secret_hash: await sha256Hex(body.secret),
    is_active: true,
  });

  return c.json({ client_id: clientId, pairing: pairing[0] || null });
});

pairingRoutes.post('/pairings/rotate-secret', async (c) => {
  const userId = await requireUser(c.env, c.req.header('authorization'));
  const body = rotateSchema.parse(await c.req.json());
  const db = new SupabaseRest(c.env);
  const rows = await db.get<Array<{ id: string; current_secret_hash?: string }>>('/rest/v1/pairings', {
    id: `eq.${body.pairing_id}`,
    user_id: `eq.${userId}`,
    select: 'id,current_secret_hash',
    limit: 1,
  });
  const old = rows[0];
  if (!old) throw new ApiError(404, 'PAIRING_NOT_FOUND', 'Pairing not found or access denied');

  const now = new Date();
  const grace = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const updated = await db.patch<Array<Record<string, unknown>>>('/rest/v1/pairings', {
    current_secret_hash: await sha256Hex(body.new_secret),
    previous_secret_hash: old.current_secret_hash || null,
    previous_secret_valid_until: grace.toISOString(),
    rotated_at: now.toISOString(),
  }, {
    id: `eq.${body.pairing_id}`,
    user_id: `eq.${userId}`,
  });

  return c.json(updated[0] || { ok: true });
});
