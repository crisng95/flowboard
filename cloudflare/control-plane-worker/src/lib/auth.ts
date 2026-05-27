import { createMiddleware } from 'hono/factory';
import { ApiError } from './errors';
import { SupabaseRest, verifySupabaseJwt } from './supabase';
import type { AppBindings, Env } from '../types';

type PairingRow = {
  id: string;
  user_id: string;
  extension_client_id: string;
  current_secret_hash?: string | null;
  previous_secret_hash?: string | null;
  previous_secret_valid_until?: string | null;
  is_active?: boolean;
};

type ClientRow = {
  id: string;
  user_id: string;
};

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}

export async function validatePairing(env: Env, clientId: string, secret: string): Promise<{ userId: string }> {
  const db = new SupabaseRest(env);
  const pairings = await db.get<PairingRow[]>('/rest/v1/pairings', {
    extension_client_id: `eq.${clientId}`,
    is_active: 'eq.true',
    select: 'id,user_id,extension_client_id,current_secret_hash,previous_secret_hash,previous_secret_valid_until,is_active',
  });
  if (!pairings.length) throw new ApiError(401, 'INVALID_PAIRING', 'Invalid Extension Client ID or Pairing Secret');

  const given = await sha256Hex(secret);
  const now = Date.now();
  for (const pairing of pairings) {
    if (pairing.current_secret_hash && constantTimeEqual(pairing.current_secret_hash, given)) {
      return { userId: pairing.user_id };
    }
    const previousValidUntil = pairing.previous_secret_valid_until ? Date.parse(pairing.previous_secret_valid_until) : 0;
    if (pairing.previous_secret_hash && previousValidUntil > now && constantTimeEqual(pairing.previous_secret_hash, given)) {
      return { userId: pairing.user_id };
    }
  }
  throw new ApiError(401, 'INVALID_PAIRING', 'Invalid Extension Client ID or Pairing Secret');
}

export const extensionAuth = createMiddleware<AppBindings>(async (c, next) => {
  const clientId = c.req.header('X-Client-Id') || '';
  const secret = c.req.header('X-Pairing-Secret') || '';
  if (!clientId || !secret) throw new ApiError(401, 'MISSING_PAIRING_HEADERS', 'Missing X-Client-Id or X-Pairing-Secret');
  const { userId } = await validatePairing(c.env, clientId, secret);
  c.set('clientId', clientId);
  c.set('clientUserId', userId);
  await next();
});

export async function requireUser(env: Env, authorization: string | undefined): Promise<string> {
  if (!authorization?.startsWith('Bearer ')) {
    throw new ApiError(401, 'INVALID_AUTHORIZATION', 'Authorization must be Bearer <token>');
  }
  const token = authorization.slice('Bearer '.length).trim();
  const userId = await verifySupabaseJwt(env, token);
  if (!userId) throw new ApiError(401, 'INVALID_AUTHORIZATION', 'Invalid or expired Supabase JWT token');
  return userId;
}

export async function getClientUserId(env: Env, clientId: string): Promise<string> {
  const db = new SupabaseRest(env);
  const clients = await db.get<ClientRow[]>('/rest/v1/extension_clients', {
    id: `eq.${clientId}`,
    select: 'id,user_id',
  });
  const userId = clients[0]?.user_id;
  if (!userId) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Extension client owner not found');
  return userId;
}
