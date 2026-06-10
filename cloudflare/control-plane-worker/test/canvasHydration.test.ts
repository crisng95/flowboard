import { describe, expect, it } from 'vitest';
import { buildCompletedOutputResult } from '../src/routes/canvas';

describe('canvas media hydration regressions', () => {
  it('preserves provider fallback URLs when no R2 assets exist', () => {
    const stored = {
      media_ids: ['flow-media-1'],
      media_urls: ['https://lh3.googleusercontent.com/fife/fallback-image'],
    };
    const result = buildCompletedOutputResult(stored, [], []);
    expect(result.media_urls).toEqual(['https://lh3.googleusercontent.com/fife/fallback-image']);
    expect(result.media_ids).toEqual(['flow-media-1']);
  });

  it('allows board hydration to recover storage keys from signed read URLs', async () => {
    const { __test__storageKeyFromSignedUrl } = await import('../src/routes/canvas');
    const signed = 'https://api.flowboard.bond/api/assets/read?key=users/user-1/uploads/file.png&exp=123&sig=abc';
    expect(__test__storageKeyFromSignedUrl(signed, 'flowboard-prod-assets')).toBe('users/user-1/uploads/file.png');
  });
});
