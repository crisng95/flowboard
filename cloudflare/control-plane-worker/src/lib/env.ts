import { ApiError } from './errors';
import type { Env } from '../types';

const REQUIRED: Array<keyof Env> = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
];

export function validateEnv(env: Env): void {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length) {
    throw new ApiError(500, 'MISCONFIGURED_ENV', `Missing Worker env: ${missing.join(', ')}`);
  }
}

export function allowedOrigins(env: Env): string[] {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(env: Env, origin: string | null): boolean {
  if (!origin) return true;
  const allowed = allowedOrigins(env);
  if (!allowed.length) return false;
  return allowed.some((pattern) => {
    if (pattern === origin) return true;
    if (pattern === 'chrome-extension://*') return origin.startsWith('chrome-extension://');
    if (pattern.endsWith('*')) return origin.startsWith(pattern.slice(0, -1));
    return false;
  });
}
