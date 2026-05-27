import type { Context } from 'hono';
import type { WorkerErrorBody } from '../types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function sanitizeError(value: unknown): string {
  return String(value || '')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, 'ya29.[redacted]')
    .replace(/https:\/\/[^\s]+\?(?:X-Amz-|GoogleAccessId|Expires|Signature|Policy|Key-Pair-Id)[^\s]*/gi, '[signed-url-redacted]')
    .slice(0, 500);
}

export function jsonError(c: Context, error: unknown) {
  const requestId = c.req.header('cf-ray') || crypto.randomUUID();
  if (error instanceof ApiError) {
    const body: WorkerErrorBody = {
      error: error.code,
      detail: sanitizeError(error.message),
      request_id: requestId,
    };
    return c.json(body, error.status as never);
  }
  const body: WorkerErrorBody = {
    error: 'INTERNAL_ERROR',
    detail: sanitizeError(error instanceof Error ? error.message : error),
    request_id: requestId,
  };
  return c.json(body, 500);
}

export function assertUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, 'INVALID_UUID', `${label} must be a UUID`);
  }
  return value;
}
