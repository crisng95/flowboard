import { describe, expect, it } from 'vitest';
import { completeSchema, validateAssets } from '../src/routes/extension';
import { buildCompletedOutputResult } from '../src/routes/canvas';

/**
 * Task 4.4 — text-only completion + read-back (Req 5.2, 5.4).
 *
 * Scope honesty: these tests exercise the *pure, callable* pieces of the
 * text_gen completion path — the `/extension/complete` zod body schema, the
 * `validateAssets` helper, and the canvas read-back merge. They confirm the
 * design claim that a text-only completion (empty assets + a text
 * output_result) and the GET /requests/:id read-back need NO schema change.
 *
 * The full HTTP round-trip (auth middleware, requireClaimedRequest against
 * Supabase, headObject against R2, complete_request_with_assets RPC) is NOT
 * stood up here: it would require a miniflare + Supabase/R2 mock harness that
 * does not exist in this package. That end-to-end path is covered by
 * manual/staging testing. What follows is the validator/transform-level
 * verification that the no-schema-change claim holds.
 */

describe('text_gen complete body schema (Req 5.2)', () => {
  const requestId = '216c8a2e-41ac-41fb-b3a7-15600e2f43ce';

  it('parses a body with empty assets and a text output_result without throwing', () => {
    const body = {
      request_id: requestId,
      output_result: { provider: 'flow', task_type: 'text_gen', text: 'hello world' },
      assets: [],
    };
    const parsed = completeSchema.parse(body);
    expect(parsed.request_id).toBe(requestId);
    expect(parsed.assets).toEqual([]);
    expect(parsed.output_result).toEqual({ provider: 'flow', task_type: 'text_gen', text: 'hello world' });
  });

  it('defaults assets to an empty array when omitted', () => {
    const parsed = completeSchema.parse({
      request_id: requestId,
      output_result: { provider: 'flow', task_type: 'text_gen', text: 'no assets key' },
    });
    expect(parsed.assets).toEqual([]);
  });

  it('validateAssets returns [] for an empty assets array (no asset record required)', () => {
    const parsed = completeSchema.parse({
      request_id: requestId,
      output_result: { provider: 'flow', task_type: 'text_gen', text: 'x' },
      assets: [],
    });
    // userId is irrelevant for an empty list — the per-asset loop never runs.
    expect(validateAssets(parsed.assets, 'any-user', requestId)).toEqual([]);
  });
});

describe('read-back transform preserves output_result.text for text_gen rows (Req 5.4)', () => {
  it('keeps the text field intact when there are no assets', () => {
    const stored = { provider: 'flow', task_type: 'text_gen', text: 'generated answer' };
    const result = buildCompletedOutputResult(stored, [], []);
    expect(result.text).toBe('generated answer');
    expect(result.provider).toBe('flow');
    expect(result.task_type).toBe('text_gen');
    // No assets → empty media arrays.
    expect(result.media_urls).toEqual([]);
    expect(result.media_ids).toEqual([]);
    expect(result.asset_ids).toEqual([]);
  });

  it('still augments media fields for an image row with assets (regression guard)', () => {
    const stored = { provider: 'flow', task_type: 'txt2img' };
    const result = buildCompletedOutputResult(stored, ['https://signed/url-0.jpg'], ['asset-1']);
    expect(result.media_urls).toEqual(['https://signed/url-0.jpg']);
    expect(result.media_ids).toEqual(['https://signed/url-0.jpg']);
    expect(result.asset_ids).toEqual(['asset-1']);
  });

  it('preserves provider media_urls when asset upload fallback completed with no assets', () => {
    const stored = {
      provider: 'flow',
      task_type: 'txt2img',
      media_urls: ['https://flow-content.google/generated.jpg'],
      media_ids: ['flow-media-id-1'],
    };
    const result = buildCompletedOutputResult(stored, [], []);
    expect(result.media_urls).toEqual(['https://flow-content.google/generated.jpg']);
    expect(result.media_ids).toEqual(['flow-media-id-1']);
    expect(result.asset_ids).toEqual([]);
  });
});
