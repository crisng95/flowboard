import { describe, expect, it } from 'vitest';
import { sha256Hex, constantTimeEqual } from '../src/lib/auth';
import { ApiError } from '../src/lib/errors';
import {
  assertContentType,
  assertProgressStage,
  assertTaskType,
  clampLease,
  clampUploadTtl,
  parseRequestIdFromStorageKey,
  validateStorageKey,
} from '../src/lib/requestGuards';

describe('request guards', () => {
  it('clamps lease and upload TTL to zero-cost-safe bounds', () => {
    expect(clampLease(15)).toBe(180);
    expect(clampLease(999)).toBe(300);
    expect(clampLease(240)).toBe(240);
    expect(clampUploadTtl(30)).toBe(600);
    expect(clampUploadTtl(9999)).toBe(900);
    expect(clampUploadTtl(700)).toBe(700);
  });

  it('allows only coarse progress stages', () => {
    expect(assertProgressStage('preparing')).toBe('preparing');
    expect(assertProgressStage('uploading')).toBe('uploading');
    expect(() => assertProgressStage('42-percent')).toThrow(ApiError);
  });

  it('allows only supported asset MIME types', () => {
    expect(assertContentType('image/png')).toBe('image/png');
    expect(assertContentType('image/jpeg')).toBe('image/jpeg');
    expect(assertContentType('video/mp4')).toBe('video/mp4');
    expect(() => assertContentType('image/gif')).toThrow(ApiError);
  });

  // Task 4.3 — task_type validation (Req 5.1, 5.3)
  it('accepts every recognized task_type and returns it unchanged', () => {
    expect(assertTaskType('text_gen')).toBe('text_gen');
    expect(assertTaskType('txt2img')).toBe('txt2img');
    expect(assertTaskType('edit_image')).toBe('edit_image');
    expect(assertTaskType('img2vid')).toBe('img2vid');
    expect(assertTaskType('txt2vid_omni')).toBe('txt2vid_omni');
  });

  it('defaults missing or empty task_type to txt2img', () => {
    expect(assertTaskType(undefined)).toBe('txt2img');
    expect(assertTaskType('')).toBe('txt2img');
  });

  it('rejects an unrecognized task_type with ApiError 400 INVALID_TASK_TYPE', () => {
    expect(() => assertTaskType('bogus')).toThrow(ApiError);
    try {
      assertTaskType('bogus');
      throw new Error('expected assertTaskType to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).code).toBe('INVALID_TASK_TYPE');
    }
  });

  it('validates storage keys by owner prefix and path safety', () => {
    const userId = '04f92ad6-527d-4bb2-83d9-f24fbba8d280';
    const requestId = '216c8a2e-41ac-41fb-b3a7-15600e2f43ce';
    const key = `users/${userId}/flow/${requestId}/output-0.jpg`;
    expect(validateStorageKey(key, userId)).toBe(key);
    expect(parseRequestIdFromStorageKey(key)).toBe(requestId);
    expect(() => validateStorageKey(`users/other/flow/${requestId}/output-0.jpg`, userId)).toThrow(ApiError);
    expect(() => validateStorageKey(`users/${userId}/flow/${requestId}/../x.jpg`, userId)).toThrow(ApiError);
    expect(() => validateStorageKey(`users/${userId}/flow/${requestId}//x.jpg`, userId)).toThrow(ApiError);
  });
});

describe('pairing secret helpers', () => {
  it('hashes secrets with SHA-256 hex and compares without early length success', async () => {
    const hash = await sha256Hex('secret-xyz');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(constantTimeEqual(hash, hash)).toBe(true);
    expect(constantTimeEqual(hash, hash.slice(0, -1) + '0')).toBe(false);
    expect(constantTimeEqual(hash, hash.slice(0, 12))).toBe(false);
  });
});
