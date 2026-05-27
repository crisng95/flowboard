import { ApiError, sanitizeError } from './errors';
import type { Env } from '../types';

type Query = Record<string, string | number | boolean | undefined | null>;

function buildUrl(env: Env, path: string, query?: Query): string {
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export class SupabaseRest {
  constructor(private readonly env: Env) {}

  private headers(prefer = 'return=representation'): HeadersInit {
    return {
      apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      prefer,
    };
  }

  async request<T>(path: string, init: RequestInit = {}, query?: Query): Promise<T> {
    const resp = await fetch(buildUrl(this.env, path, query), {
      ...init,
      headers: {
        ...this.headers(),
        ...(init.headers || {}),
      },
    });
    const text = await resp.text();
    const data = text ? safeJson(text) : null;
    if (!resp.ok) {
      throw new ApiError(502, 'SUPABASE_ERROR', `Supabase HTTP ${resp.status}: ${sanitizeError(text || resp.statusText)}`);
    }
    return data as T;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>(path, { method: 'GET' }, query);
  }

  post<T>(path: string, body: unknown, prefer = 'return=representation'): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body || {}), headers: { prefer } });
  }

  patch<T>(path: string, body: unknown, query?: Query): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body || {}) }, query);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

export async function verifySupabaseJwt(env: Env, token: string): Promise<string | null> {
  const resp = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${token}`,
    },
  });
  if (!resp.ok) return null;
  const data = await resp.json<{ id?: string }>();
  return data.id || null;
}
