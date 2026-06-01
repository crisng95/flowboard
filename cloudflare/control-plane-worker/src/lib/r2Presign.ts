import { AwsClient } from 'aws4fetch';
import { ApiError } from './errors';
import type { Env } from '../types';

function r2ObjectUrl(env: Env, storageKey: string): string {
  const endpoint = env.R2_ENDPOINT.replace(/\/+$/, '');
  const encodedKey = storageKey.split('/').map(encodeURIComponent).join('/');
  return `${endpoint}/${env.R2_BUCKET_NAME}/${encodedKey}`;
}

function withExpires(url: string, expiresIn: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set('X-Amz-Expires', String(expiresIn));
  return parsed.toString();
}

function awsClient(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readTokenPayload(storageKey: string, expiresAt: number): string {
  return `${expiresAt}:${storageKey}`;
}

export async function presignPut(env: Env, storageKey: string, contentType: string, expiresIn: number): Promise<string> {
  const signed = await awsClient(env).sign(withExpires(r2ObjectUrl(env, storageKey), expiresIn), {
    method: 'PUT',
    headers: { 'content-type': contentType },
    aws: { signQuery: true, allHeaders: true },
  });
  return signed.url;
}

export async function presignGet(env: Env, baseUrl: string, storageKey: string, expiresIn = 900): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  const sig = await sha256Hex(`${env.R2_SECRET_ACCESS_KEY}:${readTokenPayload(storageKey, expiresAt)}`);
  const url = new URL('/api/assets/read', baseUrl);
  url.searchParams.set('key', storageKey);
  url.searchParams.set('exp', String(expiresAt));
  url.searchParams.set('sig', sig);
  return url.toString();
}

export async function verifySignedRead(env: Env, storageKey: string, expiresAt: number, signature: string): Promise<boolean> {
  const expected = await sha256Hex(`${env.R2_SECRET_ACCESS_KEY}:${readTokenPayload(storageKey, expiresAt)}`);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

export async function headObject(env: Env, storageKey: string): Promise<R2Object | null> {
  if (!env.ASSETS_BUCKET) throw new ApiError(500, 'R2_BINDING_MISSING', 'ASSETS_BUCKET binding is not configured');
  return env.ASSETS_BUCKET.head(storageKey);
}