import { describe, expect, it } from 'vitest';
import { classifyAssetRetention } from '../src/lib/assetGc';
import { collectReferencedStorageKeys, storageKeyFromSignedUrl, userStorageKey } from '../src/lib/assetReferences';

describe('asset reference extraction', () => {
  it('collects user-owned storage keys from node fields and list items', () => {
    const userId = 'user-1';
    const bucketName = 'flowboard-prod-assets';
    const nodes = [
      {
        data: {
          storageKey: 'users/user-1/uploads/raw.png',
          mediaId: 'https://api.flowboard.bond/api/assets/read?key=users/user-1/flow/r1/output-0.png&exp=1&sig=abc',
          mediaIds: [
            'users/user-1/flow/r1/output-1.png',
            'https://lh3.googleusercontent.com/provider-only',
          ],
          listItems: [
            {
              storageKey: 'users/user-1/uploads/list-ref.png',
              mediaUrl: 'https://api.flowboard.bond/api/assets/read?key=users/user-1/flow/r1/output-2.png&exp=1&sig=abc',
              imageUrl: 'https://flow-content.google/provider-image',
            },
          ],
        },
      },
    ];

    const refs = collectReferencedStorageKeys(nodes, userId, bucketName);
    expect(Array.from(refs).sort()).toEqual([
      'users/user-1/flow/r1/output-0.png',
      'users/user-1/flow/r1/output-1.png',
      'users/user-1/flow/r1/output-2.png',
      'users/user-1/uploads/list-ref.png',
      'users/user-1/uploads/raw.png',
    ]);
  });

  it('parses storage keys from signed worker URLs and ignores non-owned values', () => {
    expect(storageKeyFromSignedUrl(
      'https://api.flowboard.bond/api/assets/read?key=users/user-1/uploads/file.png&exp=123&sig=abc',
      'flowboard-prod-assets',
    )).toBe('users/user-1/uploads/file.png');
    expect(userStorageKey('https://lh3.googleusercontent.com/provider', 'user-1', 'flowboard-prod-assets')).toBeNull();
    expect(userStorageKey('users/other-user/uploads/file.png', 'user-1', 'flowboard-prod-assets')).toBeNull();
  });
});

describe('asset GC retention state machine', () => {
  const now = Date.parse('2026-06-10T12:00:00Z');

  it('keeps referenced active assets active', () => {
    const decision = classifyAssetRetention({
      id: 'a1',
      user_id: 'user-1',
      storage_key: 'users/user-1/flow/r1/output-0.png',
      retention_state: 'active',
      orphaned_at: null,
    }, new Set(['users/user-1/flow/r1/output-0.png']), now);
    expect(decision).toBe('keep-active');
  });

  it('marks unreferenced active assets orphaned', () => {
    const decision = classifyAssetRetention({
      id: 'a2',
      user_id: 'user-1',
      storage_key: 'users/user-1/flow/r1/output-1.png',
      retention_state: 'active',
      orphaned_at: null,
    }, new Set(), now);
    expect(decision).toBe('mark-orphaned');
  });

  it('revives referenced orphaned assets', () => {
    const decision = classifyAssetRetention({
      id: 'a3',
      user_id: 'user-1',
      storage_key: 'users/user-1/flow/r1/output-2.png',
      retention_state: 'orphaned',
      orphaned_at: '2026-06-10T00:00:00Z',
    }, new Set(['users/user-1/flow/r1/output-2.png']), now);
    expect(decision).toBe('revive-active');
  });

  it('does not purge orphaned assets before the grace window', () => {
    const decision = classifyAssetRetention({
      id: 'a4',
      user_id: 'user-1',
      storage_key: 'users/user-1/flow/r1/output-3.png',
      retention_state: 'orphaned',
      orphaned_at: '2026-06-10T00:30:00Z',
    }, new Set(), now);
    expect(decision).toBe('mark-orphaned');
  });

  it('purges orphaned assets after the grace window', () => {
    const decision = classifyAssetRetention({
      id: 'a5',
      user_id: 'user-1',
      storage_key: 'users/user-1/flow/r1/output-4.png',
      retention_state: 'orphaned',
      orphaned_at: '2026-06-09T11:59:00Z',
    }, new Set(), now);
    expect(decision).toBe('purge');
  });

  it('never purges pinned assets', () => {
    const decision = classifyAssetRetention({
      id: 'a6',
      user_id: 'user-1',
      storage_key: 'users/user-1/flow/r1/output-5.png',
      retention_state: 'pinned',
      orphaned_at: '2026-06-01T00:00:00Z',
    }, new Set(), now);
    expect(decision).toBe('skip-pinned');
  });
});
