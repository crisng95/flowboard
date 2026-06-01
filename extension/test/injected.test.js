/**
 * Tests for extension/injected.js observer — the REAL shipped code (task 9.4).
 *
 * Loading strategy (see test/helpers/load-extension.js):
 *   injected.js is a MAIN-world script that references `window` at load time
 *   (`void ensureWrapped()` and `ensureFetchObserved()`), and declares
 *   `extractFlowSdkInfo` as a top-level function. We evaluate it inside a Node
 *   `vm` context that provides a `window` shim with a working event bus and a
 *   recordable `fetch`, a `document` stub, and a `CustomEvent` shim. There is
 *   deliberately NO real `setTimeout` loop, so `waitForGrecaptcha()` inside
 *   `ensureWrapped()` simply stays pending (harmless) while
 *   `ensureFetchObserved()` wraps `window.fetch`. The top-level
 *   `extractFlowSdkInfo` lands on the context global for direct testing.
 *   No prod file is modified.
 *
 * NOTE (design 6d): this is observer WIRING — example/edge-case tests only,
 * NO new correctness property (do NOT add a Property 6).
 *
 * Validates: Requirement 1.6
 */
import { describe, it, expect, vi } from 'vitest';
import { loadInjected, makeWindow } from './helpers/load-extension.js';

const SDK_EVENT = 'FLOWBOARD_FLOW_SDK_INFO_OBSERVED';

describe('injected.js extractFlowSdkInfo (task 9.4)', () => {
  it('returns {appletId, appletVersionId, appletProjectId} for a body carrying requestContext.flowSdkInfo', () => {
    const { context } = loadInjected();
    const body = {
      requestContext: { flowSdkInfo: { appletId: 'applet-1', appletVersionId: 'ver-1' } },
      appletProjectId: 'proj-1',
    };
    expect(context.extractFlowSdkInfo(JSON.stringify(body))).toEqual({
      appletId: 'applet-1',
      appletVersionId: 'ver-1',
      appletProjectId: 'proj-1',
    });
  });

  it('accepts an already-parsed object body too', () => {
    const { context } = loadInjected();
    const body = { requestContext: { flowSdkInfo: { appletId: 'a', appletVersionId: 'v' } } };
    expect(context.extractFlowSdkInfo(body)).toEqual({
      appletId: 'a',
      appletVersionId: 'v',
      appletProjectId: null,
    });
  });

  it('returns null for a body without any flow sdk fields', () => {
    const { context } = loadInjected();
    expect(context.extractFlowSdkInfo(JSON.stringify({ model: 'gemini', contents: [] }))).toBeNull();
  });

  it('returns null for a non-JSON string body', () => {
    const { context } = loadInjected();
    expect(context.extractFlowSdkInfo('not-json {{{')).toBeNull();
    expect(context.extractFlowSdkInfo(undefined)).toBeNull();
    expect(context.extractFlowSdkInfo(null)).toBeNull();
  });
});

describe('injected.js fetch wrap dispatches FLOWBOARD_FLOW_SDK_INFO_OBSERVED (task 9.4)', () => {
  it('dispatches the observe event for flow:generateContent URLs and forwards to the original fetch', async () => {
    const originalFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const window = makeWindow({ fetchImpl: originalFetch });
    loadInjected({ window });

    const observed = [];
    window.addEventListener(SDK_EVENT, (e) => observed.push(e.detail));

    const url = 'https://aisandbox-pa.googleapis.com/v1/flow:generateContent';
    const body = JSON.stringify({ requestContext: { flowSdkInfo: { appletId: 'a-1', appletVersionId: 'v-1' } } });
    await window.fetch(url, { method: 'POST', body });

    expect(observed).toHaveLength(1);
    expect(observed[0].appletId).toBe('a-1');
    expect(observed[0].appletVersionId).toBe('v-1');
    expect(observed[0].href).toBe(window.location.href);
    expect(typeof observed[0].observedAt).toBe('number');
    // always forwards to the original fetch
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch).toHaveBeenCalledWith(url, { method: 'POST', body });
  });

  it('dispatches for flowAgent:* URLs as well', async () => {
    const originalFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const window = makeWindow({ fetchImpl: originalFetch });
    loadInjected({ window });

    const observed = [];
    window.addEventListener(SDK_EVENT, (e) => observed.push(e.detail));

    const url = 'https://aisandbox-pa.googleapis.com/v1/flowAgent:runAppletAgentSse';
    await window.fetch(url, { body: JSON.stringify({ requestContext: { flowSdkInfo: { appletId: 'x' } } }) });

    expect(observed).toHaveLength(1);
    expect(observed[0].appletId).toBe('x');
    expect(originalFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT dispatch for unrelated URLs but still forwards to the original fetch', async () => {
    const originalFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const window = makeWindow({ fetchImpl: originalFetch });
    loadInjected({ window });

    const observed = [];
    window.addEventListener(SDK_EVENT, (e) => observed.push(e.detail));

    const url = 'https://aisandbox-pa.googleapis.com/v1/flowMedia:batchGenerateImages';
    await window.fetch(url, { body: JSON.stringify({ requestContext: { flowSdkInfo: { appletId: 'a' } } }) });

    expect(observed).toHaveLength(0);
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch).toHaveBeenCalledWith(url, expect.objectContaining({ body: expect.any(String) }));
  });

  it('does not dispatch for a matching URL when the body has no flow sdk info, but still forwards', async () => {
    const originalFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const window = makeWindow({ fetchImpl: originalFetch });
    loadInjected({ window });

    const observed = [];
    window.addEventListener(SDK_EVENT, (e) => observed.push(e.detail));

    const url = 'https://aisandbox-pa.googleapis.com/v1/flow:generateContent';
    await window.fetch(url, { body: JSON.stringify({ model: 'gemini', contents: [] }) });

    expect(observed).toHaveLength(0);
    expect(originalFetch).toHaveBeenCalledTimes(1);
  });
});
