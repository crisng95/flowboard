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

export async function presignPut(env: Env, storageKey: string, contentType: string, expiresIn: number): Promise<string> {
  const signed = await awsClient(env).sign(withExpires(r2ObjectUrl(env, storageKey), expiresIn), {
    method: 'PUT',
    headers: { 'content-type': contentType },
    aws: { signQuery: true, allHeaders: true },
  });
  return signed.url;
}

export async function presignGet(env: Env, storageKey: string, expiresIn = 900): Promise<string> {
  const signed = await awsClient(env).sign(withExpires(r2ObjectUrl(env, storageKey), expiresIn), {
    method: 'GET',
    aws: { signQuery: true },
  });
  return signed.url;
}

export async function headObject(env: Env, storageKey: string): Promise<R2Object | null> {
  if (!env.ASSETS_BUCKET) throw new ApiError(500, 'R2_BINDING_MISSING', 'ASSETS_BUCKET binding is not configured');
  return env.ASSETS_BUCKET.head(storageKey);
}
