/**
 * Tests for extension/flow_api.js — the REAL shipped code.
 *
 * Loading strategy (see test/helpers/load-extension.js):
 *   flow_api.js is an IIFE `(function (global) { ... })(self)`. We evaluate it
 *   inside a Node `vm` context whose global object is also bound to `self`, so
 *   the IIFE assigns `FlowboardFlowApi` and `FlowboardFlowApiUtils` onto the
 *   context. `crypto` (webcrypto) and `fetch` are provided as shims; `fetch` is
 *   replaced per-test to capture/stub the outbound request. No prod file is
 *   modified.
 *
 * Covers tasks:
 *   1.3 — PBT Property 1 (generateContent body builder)
 *   1.4 — PBT Property 2 (extractGeneratedText round-trip)
 *   1.5 — example tests for generateContent (URL/headers/credentials, return
 *         shape, non-2xx, malformed JSON)
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { loadFlowApi } from './helpers/load-extension.js';

const GEN_URL = 'https://aisandbox-pa.googleapis.com/v1/flow:generateContent';
const DEFAULT_MODEL = 'gemini-3-flash-preview';

// Build a FlowboardFlowApi instance with stubbed bearer + captcha, plus a
// capturing fetch. Returns { api, calls, setResponse }.
function makeApi(context, { token = 'tok-captcha', bearer = 'ya29.fake' } = {}) {
  const calls = [];
  let responder = () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
  context.fetch = async (url, options) => {
    calls.push({ url, options });
    return responder(url, options);
  };
  const api = new context.FlowboardFlowApi({
    getBearerToken: () => bearer,
    solveCaptcha: async () => token,
  });
  return { api, calls, setResponse: (fn) => { responder = fn; } };
}

describe('flow_api.js generateContent — Property 1 (task 1.3)', () => {
  // Feature: gemini-via-flow-generatecontent, Property 1: For all options
  // (model present/absent; any subset of systemInstruction/thinkingConfig/
  // requestContext) and any contents array, generateContent produces a body
  // with correct model default, deep-equal contents, optional fields present
  // iff supplied, a top-level recaptchaContext with applicationType
  // RECAPTCHA_APPLICATION_TYPE_WEB, and no clientContext key.
  // Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.9
  it('builds the request body correctly for all option subsets', async () => {
    const context = loadFlowApi();

    // A present optional field is any truthy object (the prod code uses a
    // truthy check `if (opts.systemInstruction)`); absent === undefined.
    const optionalObj = (key) =>
      fc.option(fc.record({ [key]: fc.string() }), { nil: undefined });

    await fc.assert(
      fc.asyncProperty(
        // contents: arbitrary JSON array (deep-equal after JSON round-trip)
        fc.array(fc.jsonValue()),
        // model present (non-empty string) or absent (undefined)
        fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        optionalObj('parts'), // systemInstruction
        optionalObj('thinkingLevel'), // thinkingConfig
        optionalObj('flowSdkInfo'), // requestContext
        async (contents, model, systemInstruction, thinkingConfig, requestContext) => {
          const { api, calls } = makeApi(context);
          const options = {};
          if (model !== undefined) options.model = model;
          if (systemInstruction !== undefined) options.systemInstruction = systemInstruction;
          if (thinkingConfig !== undefined) options.thinkingConfig = thinkingConfig;
          if (requestContext !== undefined) options.requestContext = requestContext;

          await api.generateContent(contents, options);

          expect(calls).toHaveLength(1);
          const body = JSON.parse(calls[0].options.body);

          // model default when absent
          expect(body.model).toBe(model !== undefined ? model : DEFAULT_MODEL);
          // contents deep-equal. `body` is read back from the serialized wire
          // payload (JSON.stringify in generateContent), so compare against the
          // JSON-normalized form of the supplied contents. This faithfully
          // validates Req 1.3 ("set contents to the supplied argument") under
          // JSON wire semantics — JSON has no -0, so a generated `-0` is sent
          // as `0`, which is correct and equal (-0 === 0 in JS).
          expect(body.contents).toEqual(JSON.parse(JSON.stringify(contents)));
          // optional fields present iff supplied
          expect('systemInstruction' in body).toBe(systemInstruction !== undefined);
          expect('thinkingConfig' in body).toBe(thinkingConfig !== undefined);
          expect('requestContext' in body).toBe(requestContext !== undefined);
          if (systemInstruction !== undefined) expect(body.systemInstruction).toEqual(systemInstruction);
          if (thinkingConfig !== undefined) expect(body.thinkingConfig).toEqual(thinkingConfig);
          if (requestContext !== undefined) expect(body.requestContext).toEqual(requestContext);
          // top-level recaptchaContext
          expect(body.recaptchaContext).toBeDefined();
          expect(body.recaptchaContext.applicationType).toBe('RECAPTCHA_APPLICATION_TYPE_WEB');
          // no clientContext key
          expect('clientContext' in body).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('flow_api.js extractGeneratedText — Property 2 (task 1.4)', () => {
  // Feature: gemini-via-flow-generatecontent, Property 2: For all lists of text
  // strings, synthesizing a response whose candidates[].content.parts[] carry
  // those strings (interleaved with non-text parts and empty candidates) then
  // applying extractGeneratedText reproduces the in-order concatenation; and
  // for responses with no candidates/text parts it returns the empty string.
  // Validates: Requirements 2.1, 2.2, 2.3, 2.4
  it('round-trips the in-order text concatenation across arbitrary candidates', () => {
    const { FlowboardFlowApiUtils } = loadFlowApi();
    const { extractGeneratedText } = FlowboardFlowApiUtils;

    // A part descriptor is either a text part (carries a string) or a non-text
    // part (no string `.text` field — must be ignored by the extractor).
    const partDesc = fc.oneof(
      fc.record({ kind: fc.constant('text'), value: fc.string() }),
      fc.constant({ kind: 'nontext-inline' }),
      fc.constant({ kind: 'nontext-empty' }),
      // a part with a non-string `text` must also be ignored
      fc.record({ kind: fc.constant('nontext-numeric') }),
    );

    // A candidate descriptor: empty (no content), no parts, or a list of parts.
    const candidateDesc = fc.oneof(
      fc.constant({ type: 'empty' }),
      fc.constant({ type: 'noparts' }),
      fc.record({ type: fc.constant('parts'), parts: fc.array(partDesc) }),
    );

    fc.assert(
      fc.property(fc.array(candidateDesc), (candidateDescs) => {
        // Expected = in-order concatenation of every text part's value.
        let expected = '';
        for (const c of candidateDescs) {
          if (c.type !== 'parts') continue;
          for (const p of c.parts) {
            if (p.kind === 'text') expected += p.value;
          }
        }

        const toPart = (p) => {
          switch (p.kind) {
            case 'text':
              return { text: p.value };
            case 'nontext-inline':
              return { inlineData: { mimeType: 'image/png', data: 'AAAA' } };
            case 'nontext-numeric':
              return { text: 123 }; // non-string text → ignored
            default:
              return {}; // empty part
          }
        };
        const candidates = candidateDescs.map((c) => {
          if (c.type === 'empty') return {};
          if (c.type === 'noparts') return { content: {} };
          return { content: { parts: c.parts.map(toPart) } };
        });

        expect(extractGeneratedText({ candidates })).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it('returns empty string when there are no candidates or no text parts', () => {
    const { extractGeneratedText } = loadFlowApi().FlowboardFlowApiUtils;
    expect(extractGeneratedText({})).toBe('');
    expect(extractGeneratedText(null)).toBe('');
    expect(extractGeneratedText({ candidates: [] })).toBe('');
    expect(extractGeneratedText({ candidates: [{ content: { parts: [] } }] })).toBe('');
    expect(extractGeneratedText({ candidates: [{ content: { parts: [{ inlineData: {} }] } }] })).toBe('');
  });

  it('tolerates a {data:{...}} envelope (consistent with extractMediaEntries)', () => {
    const { extractGeneratedText } = loadFlowApi().FlowboardFlowApiUtils;
    const envelope = { data: { candidates: [{ content: { parts: [{ text: 'hi ' }, { text: 'there' }] } }] } };
    expect(extractGeneratedText(envelope)).toBe('hi there');
  });
});

describe('flow_api.js generateContent — example tests (task 1.5)', () => {
  it('POSTs to flow:generateContent with Bearer authorization and credentials:include; returns {raw,text} (Req 1.1, 1.8)', async () => {
    const context = loadFlowApi();
    const { api, calls, setResponse } = makeApi(context, { bearer: 'ya29.secret' });
    const raw = { candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }] };
    setResponse(() => ({ ok: true, status: 200, json: async () => raw }));

    const result = await api.generateContent([{ role: 'user', parts: [{ text: 'hi' }] }], {});

    expect(calls).toHaveLength(1);
    const { url, options } = calls[0];
    expect(url).toBe(GEN_URL);
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(options.headers.authorization).toBe('Bearer ya29.secret');

    expect(result.raw).toEqual(raw);
    expect(result.text).toBe('hello world');
  });

  it('throws an error including the HTTP status on a non-2xx response (Req 8.3)', async () => {
    const context = loadFlowApi();
    const { api, setResponse } = makeApi(context);
    setResponse(() => ({ ok: false, status: 429, json: async () => ({ error: 'rate limited' }) }));

    await expect(api.generateContent([], {})).rejects.toThrow('generateContent HTTP 429');
  });

  it('throws a malformed-JSON error when the response body cannot be parsed (Req 8.6)', async () => {
    const context = loadFlowApi();
    const { api, setResponse } = makeApi(context);
    setResponse(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }));

    await expect(api.generateContent([], {})).rejects.toThrow('generateContent malformed JSON response');
  });

  it('throws before fetch when reCAPTCHA solving yields no token (Req 8.2)', async () => {
    const context = loadFlowApi();
    const calls = [];
    context.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({}) }; };
    const api = new context.FlowboardFlowApi({
      getBearerToken: () => 'ya29.fake',
      solveCaptcha: async () => null, // captcha failed
    });
    await expect(api.generateContent([], {})).rejects.toThrow('Missing reCAPTCHA token');
    expect(calls).toHaveLength(0);
  });
});
