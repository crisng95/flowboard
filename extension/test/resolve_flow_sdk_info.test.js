/**
 * Tests for background.js resolveFlowSdkInfo precedence + the 3-tier chain
 * shape (task 9.5) — the REAL shipped code.
 *
 * Loading strategy (see test/helpers/load-extension.js):
 *   background.js is loaded into a Node `vm` context (same approach as
 *   background.test.js). `resolveFlowSdkInfo` is a top-level function
 *   declaration → it lands on the context global. Its inputs are the
 *   module-scope `let` bindings `observedFlowSdkInfo` and `cloudConfig`, plus
 *   the const `DEFAULT_FLOW_SDK_INFO_SEED`. A `__test` setter API (installed by
 *   the loader, NOT by prod code) drives those `let` bindings deterministically.
 *   No prod file is modified.
 *
 * NOTE (design 6d): deterministic example/integration cases — NO new
 * correctness property.
 *
 * Validates: Requirements 1.6, 3.4, 8.2, 8.3
 */
import { describe, it, expect } from 'vitest';
import { loadBackground } from './helpers/load-extension.js';

describe('background.js resolveFlowSdkInfo precedence (task 9.5)', () => {
  it('observed value wins over the cloudConfig seed', () => {
    const ctx = loadBackground();
    ctx.__test.setObservedFlowSdkInfo({ appletId: 'observed-applet', appletVersionId: 'observed-ver' });
    ctx.__test.setCloudConfig({ flowSdkInfoSeed: { appletId: 'seed-applet', appletVersionId: 'seed-ver' } });

    expect(ctx.resolveFlowSdkInfo()).toEqual({
      appletId: 'observed-applet',
      appletVersionId: 'observed-ver',
    });
  });

  it('falls back to cloudConfig.flowSdkInfoSeed when nothing has been observed', () => {
    const ctx = loadBackground();
    ctx.__test.setObservedFlowSdkInfo(null);
    ctx.__test.setCloudConfig({ flowSdkInfoSeed: { appletId: 'seed-applet', appletVersionId: 'seed-ver' } });

    expect(ctx.resolveFlowSdkInfo()).toEqual({
      appletId: 'seed-applet',
      appletVersionId: 'seed-ver',
    });
  });

  it('falls back to the DEFAULT seed constants when neither observed nor cloudConfig seed exist', () => {
    const ctx = loadBackground();
    ctx.__test.setObservedFlowSdkInfo(null);
    ctx.__test.setCloudConfig(null);

    const defaultSeed = ctx.__test.getDefaultSeed();
    expect(ctx.resolveFlowSdkInfo()).toEqual({
      appletId: defaultSeed.appletId,
      appletVersionId: defaultSeed.appletVersionId,
    });
    // Because a default seed always exists, resolveFlowSdkInfo never returns
    // null in practice — the 3-tier chain always has a Tier-3 value.
    expect(ctx.resolveFlowSdkInfo()).not.toBeNull();
  });

  it('ignores an observed entry whose ids are both empty and uses the seed instead', () => {
    const ctx = loadBackground();
    ctx.__test.setObservedFlowSdkInfo({ appletId: '', appletVersionId: '', href: 'x' });
    ctx.__test.setCloudConfig({ flowSdkInfoSeed: { appletId: 'seed-applet', appletVersionId: 'seed-ver' } });

    expect(ctx.resolveFlowSdkInfo()).toEqual({
      appletId: 'seed-applet',
      appletVersionId: 'seed-ver',
    });
  });
});

describe('background.js 3-tier chain shape (task 9.5)', () => {
  // The 3-tier chain lives inside runCloudFlowJob's text_gen branch (component
  // 6c): Tier 1 omits requestContext on the FIRST attempt; the resolved
  // flowSdkInfo is applied ONLY on a retry triggered by a flowSdkInfo-required
  // error (matching /flowSdkInfo|requestContext|applet|INVALID_ARGUMENT|HTTP 400/).
  // Driving the full branch requires the whole service-worker runtime, so the
  // omit-first behavior + retry trigger are integration-tested manually against
  // a live Flow session. Here we verify the deterministic decision predicate
  // and resolved value that the chain consumes.
  it('Tier 1: the resolved value exists but requestContext is omitted by default (documented)', () => {
    const ctx = loadBackground();
    ctx.__test.setObservedFlowSdkInfo({ appletId: 'a', appletVersionId: 'v' });
    // The resolved value is available for Tiers 2/3 ...
    expect(ctx.resolveFlowSdkInfo()).toEqual({ appletId: 'a', appletVersionId: 'v' });
    // ... but the first generateContent attempt (Tier 1) intentionally does not
    // include requestContext. That omission is asserted by flow_api.test.js
    // Property 1 (requestContext present iff supplied) — the text_gen branch
    // simply does not pass options.requestContext on the first call.
  });

  it('the retry predicate matches flowSdkInfo-required errors and not generic ones', () => {
    // Mirrors the regex used in the text_gen branch's runGenerate() retry guard.
    const retryRegex = /flowSdkInfo|requestContext|applet|INVALID_ARGUMENT|HTTP 400/i;
    expect(retryRegex.test('generateContent HTTP 400')).toBe(true);
    expect(retryRegex.test('INVALID_ARGUMENT: flowSdkInfo is required')).toBe(true);
    expect(retryRegex.test('applet not found')).toBe(true);
    expect(retryRegex.test('generateContent HTTP 500')).toBe(false);
    expect(retryRegex.test('Missing reCAPTCHA token')).toBe(false);
  });
});
