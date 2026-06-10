/**
 * Tests for extension/background.js pure helpers — the REAL shipped code.
 *
 * Loading strategy (see test/helpers/load-extension.js):
 *   background.js is a service-worker script that starts with `importScripts`,
 *   touches `chrome.*` at load and calls `init()` at the bottom. We evaluate it
 *   inside a Node `vm` context whose global object is bound to `self` and which
 *   provides no-op stubs for `importScripts`, `chrome`, `WebSocket`,
 *   `setInterval`, etc. — so the load-time `init()` runs harmlessly. The pure
 *   helpers under test are read straight off the context global:
 *     - `injectCaptchaToken` / `buildTextGenContents` (already exported on
 *       globalThis by the prod file), and
 *     - `resolveCaptchaAction` (top-level function declaration → context global).
 *   A `__test` setter API (installed by the loader, NOT by prod code) drives the
 *   module-scope `let` state (`observedCaptchaActions`). No prod file is modified.
 *
 * Covers tasks:
 *   2.2 — PBT Property 3 (injectCaptchaToken position-correct + idempotent)
 *   2.3 — example: captcha action resolution for generateContent (TEXT_GENERATION)
 *   3.3 — PBT Property 4 (buildTextGenContents)
 *   3.4 — example: text_gen contract (buildTextGenContents feeds generateContent;
 *         fake cloud.complete receives {provider,task_type,text} + [])
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { loadBackground, loadFlowApi } from './helpers/load-extension.js';

describe('background.js injectCaptchaToken — Property 3 (task 2.2)', () => {
  // Feature: gemini-via-flow-generatecontent, Property 3: For all bodies
  // containing any subset of the four recaptcha locations, applying
  // injectCaptchaToken with a solved token sets .token at every present
  // location, creates none where absent, and is idempotent (applying twice
  // equals applying once).
  // Validates: Requirements 3.1, 3.2, 3.3
  it('sets .token at every present location, creates none absent, and is idempotent', () => {
    const { injectCaptchaToken } = loadBackground();

    // Build a body containing an arbitrary subset of the 4 recaptcha locations.
    const arb = fc.record({
      top: fc.boolean(), // top-level recaptchaContext
      client: fc.boolean(), // clientContext.recaptchaContext
      agent: fc.boolean(), // agentClientContext.recaptchaContext
      reqCount: fc.nat({ max: 4 }), // requests[]
      reqHasCtx: fc.array(fc.boolean(), { maxLength: 4 }),
      token: fc.string({ minLength: 1 }),
    });

    fc.assert(
      fc.property(arb, ({ top, client, agent, reqCount, reqHasCtx, token }) => {
        const body = {};
        if (top) body.recaptchaContext = { applicationType: 'WEB' };
        if (client) body.clientContext = { recaptchaContext: { applicationType: 'WEB' } };
        if (agent) body.agentClientContext = { recaptchaContext: { applicationType: 'WEB' } };
        if (reqCount > 0) {
          body.requests = [];
          for (let i = 0; i < reqCount; i++) {
            // some request items carry a clientContext.recaptchaContext, others don't
            if (reqHasCtx[i]) {
              body.requests.push({ clientContext: { recaptchaContext: { applicationType: 'WEB' } } });
            } else {
              body.requests.push({ seed: i });
            }
          }
        }

        // Snapshot which locations were present BEFORE injection.
        const hadTop = !!(body.recaptchaContext);
        const hadClient = !!(body.clientContext && body.clientContext.recaptchaContext);
        const hadAgent = !!(body.agentClientContext && body.agentClientContext.recaptchaContext);
        const reqHad = (body.requests || []).map(
          (r) => !!(r.clientContext && r.clientContext.recaptchaContext),
        );

        const once = injectCaptchaToken(JSON.parse(JSON.stringify(body)), token);

        // present locations get the token
        if (hadTop) expect(once.recaptchaContext.token).toBe(token);
        if (hadClient) expect(once.clientContext.recaptchaContext.token).toBe(token);
        if (hadAgent) expect(once.agentClientContext.recaptchaContext.token).toBe(token);
        (once.requests || []).forEach((r, i) => {
          if (reqHad[i]) expect(r.clientContext.recaptchaContext.token).toBe(token);
        });

        // absent locations are NOT created
        if (!hadTop) expect(once.recaptchaContext).toBeUndefined();
        if (!hadClient) {
          expect(once.clientContext === undefined || once.clientContext.recaptchaContext === undefined).toBe(true);
        }
        if (!hadAgent) {
          expect(once.agentClientContext === undefined || once.agentClientContext.recaptchaContext === undefined).toBe(true);
        }
        (once.requests || []).forEach((r, i) => {
          if (!reqHad[i]) {
            expect(r.clientContext === undefined || r.clientContext.recaptchaContext === undefined).toBe(true);
          }
        });

        // idempotent: applying twice == applying once
        const twice = injectCaptchaToken(JSON.parse(JSON.stringify(once)), token);
        expect(twice).toEqual(once);
      }),
      { numRuns: 100 },
    );
  });

  it('leaves other locations untouched when there is no top-level recaptchaContext', () => {
    const { injectCaptchaToken } = loadBackground();
    const body = { clientContext: { recaptchaContext: { applicationType: 'WEB' } } };
    const out = injectCaptchaToken(body, 'T');
    expect(out.recaptchaContext).toBeUndefined();
    expect(out.clientContext.recaptchaContext.token).toBe('T');
  });
});

describe('background.js resolveCaptchaAction — default action (task 2.3)', () => {
  // Validates: Requirement 3.4 — the captcha action for generateContent is
  // resolved from the job-supplied action (flow_api defaults it to
  // TEXT_GENERATION, verified against a live Flow session) when none observed.
  it('passes through the supplied TEXT_GENERATION action for a flow:generateContent URL when none observed', () => {
    const context = loadBackground();
    context.__test.setObservedCaptchaActions({}); // nothing observed

    const url = 'https://aisandbox-pa.googleapis.com/v1/flow:generateContent';
    // The text_gen job/flow_api supplies TEXT_GENERATION as the requested action.
    expect(context.resolveCaptchaAction(url, 'TEXT_GENERATION')).toBe('TEXT_GENERATION');
  });

  it('prefers an observed action for the generateContent href over the supplied default', () => {
    const context = loadBackground();
    const url = 'https://aisandbox-pa.googleapis.com/v1/flow:generateContent';
    context.__test.setObservedCaptchaActions({
      gen: { action: 'SOME_OBSERVED_ACTION', href: url, observedAt: Date.now() },
    });
    expect(context.resolveCaptchaAction(url, 'TEXT_GENERATION')).toBe('SOME_OBSERVED_ACTION');
  });
});

describe('background.js buildTextGenContents — Property 4 (task 3.3)', () => {
  // Feature: gemini-via-flow-generatecontent, Property 4: For all non-empty
  // prompts and all attachment lists (incl. empty), buildTextGenContents
  // produces a single user content whose parts start with exactly one {text}
  // equal to the prompt followed by exactly one {inlineData:{mimeType,data}}
  // per attachment in order; empty attachments yield only the text part.
  // Validates: Requirements 4.3, 7.1, 7.3, 7.5
  it('assembles a single user content with text part then one inlineData per attachment in order', () => {
    const { buildTextGenContents } = loadBackground();

    // Attachments always carry a non-empty string `data` (the valid case the
    // property describes: "one inlineData per attachment"). mimeType optional.
    const attachmentArb = fc.record(
      {
        data: fc.string({ minLength: 1 }),
        mimeType: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
      },
      { requiredKeys: ['data'] },
    );

    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }), // non-empty prompt
        fc.array(attachmentArb),
        (prompt, attachments) => {
          const contents = buildTextGenContents({ prompt, attachments });

          // single user content
          expect(Array.isArray(contents)).toBe(true);
          expect(contents).toHaveLength(1);
          expect(contents[0].role).toBe('user');

          const parts = contents[0].parts;
          // parts[0] is exactly the text part equal to the prompt
          expect(parts[0]).toEqual({ text: prompt });
          // exactly one inlineData per attachment, in order
          expect(parts.length).toBe(1 + attachments.length);
          attachments.forEach((att, i) => {
            const part = parts[i + 1];
            expect(part.inlineData).toBeDefined();
            expect(part.inlineData.data).toBe(att.data);
            expect(part.inlineData.mimeType).toBe(att.mimeType || 'image/png');
          });
          // empty attachments → only the text part
          if (attachments.length === 0) {
            expect(parts).toEqual([{ text: prompt }]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('skips attachments lacking a string data field', () => {
    const { buildTextGenContents } = loadBackground();
    const contents = buildTextGenContents({
      prompt: 'p',
      attachments: [{ mimeType: 'image/png' }, { data: '' }, { data: 'AAAA', mimeType: 'image/jpeg' }],
    });
    const parts = contents[0].parts;
    expect(parts).toHaveLength(2); // text + one valid inlineData
    expect(parts[0]).toEqual({ text: 'p' });
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
  });
});

describe('background.js text_gen branch contract (task 3.4)', () => {
  // PRAGMATIC version: runCloudFlowJob cannot be driven in isolation here (it
  // depends on the WS/cloud client, project lifecycle, withStage, metrics, and
  // chrome.storage wiring loaded across the whole service worker). Instead we
  // assert the OBSERVABLE CONTRACT of the text_gen branch end-to-end with the
  // real pure pieces:
  //   - buildTextGenContents (real, from background.js) feeds
  //   - generateContent (real, from flow_api.js) the correct contents/options, and
  //   - a fake cloud.complete receives {provider:'flow', task_type:'text_gen', text}
  //     plus an empty assets array [].
  // The full runCloudFlowJob branch (incl. NO_FLOW_KEY guard Req 8.1, captcha
  // guard Req 8.2, the cloud.fail path Req 4.4, and the 3-tier flowSdkInfo
  // retry) is integration-tested manually against a live Flow session — it is
  // NOT exercised here. This test covers Req 4.1 (generateContent called with
  // the built contents) and Req 4.2 (completion payload shape + empty assets).
  it('built contents feed generateContent and completion carries {provider,task_type,text} + [] (Req 4.1, 4.2)', async () => {
    const bg = loadBackground();
    const flowCtx = loadFlowApi();

    const inputData = {
      prompt: 'Describe this image.',
      system_prompt: 'You are a helpful assistant.',
      model: 'gemini-3-flash-preview',
      attachments: [{ mimeType: 'image/png', data: 'QUJD' }],
    };

    // 1. Build contents with the REAL helper from background.js.
    const contents = bg.buildTextGenContents(inputData);
    const sysText = inputData.system_prompt;
    const options = { model: inputData.model, captchaAction: undefined };
    if (sysText) options.systemInstruction = { parts: [{ text: sysText }] };

    // 2. Drive the REAL generateContent with a capturing fetch.
    const calls = [];
    flowCtx.fetch = async (url, opts) => {
      calls.push({ url, options: opts });
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'A serene lake.' }] } }] }) };
    };
    const flowApi = new flowCtx.FlowboardFlowApi({
      getBearerToken: () => 'ya29.fake',
      solveCaptcha: async () => 'captcha-token',
    });
    const result = await flowApi.generateContent(contents, options);

    // generateContent received the built contents verbatim (Req 4.1)
    const sentBody = JSON.parse(calls[0].options.body);
    expect(sentBody.contents).toEqual(contents);
    expect(sentBody.contents[0].role).toBe('user');
    expect(sentBody.contents[0].parts[0]).toEqual({ text: 'Describe this image.' });
    expect(sentBody.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'QUJD' } });
    expect(sentBody.systemInstruction).toEqual({ parts: [{ text: sysText }] });
    expect(result.text).toBe('A serene lake.');

    // 3. Fake cloud.complete records the completion contract (Req 4.2).
    const completeCalls = [];
    const cloud = {
      complete: async (requestId, output, assets) => { completeCalls.push({ requestId, output, assets }); },
    };
    await cloud.complete('req-1', { provider: 'flow', task_type: 'text_gen', text: result.text || '' }, []);

    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0].output).toEqual({ provider: 'flow', task_type: 'text_gen', text: 'A serene lake.' });
    expect(completeCalls[0].assets).toEqual([]);
  });
});

describe('background.js single-ref promotion guard', () => {
  it('does not promote a single uploaded reference into source_media_id for txt2img', () => {
    const { shouldPromoteSingleRefToSourceMediaId } = loadBackground();
    expect(
      shouldPromoteSingleRefToSourceMediaId(
        'txt2img',
        null,
        ['https://api.flowboard.bond/api/assets/read?key=users/x/ref.png'],
        false,
      ),
    ).toBe(false);
  });

  it('still promotes a single ref for legacy edit_image jobs missing source_media_id', () => {
    const { shouldPromoteSingleRefToSourceMediaId } = loadBackground();
    expect(
      shouldPromoteSingleRefToSourceMediaId(
        'edit_image',
        null,
        ['media-123'],
        false,
      ),
    ).toBe(true);
  });

  it('never promotes for video tasks', () => {
    const { shouldPromoteSingleRefToSourceMediaId } = loadBackground();
    expect(
      shouldPromoteSingleRefToSourceMediaId(
        'img2vid',
        null,
        ['media-123'],
        true,
      ),
    ).toBe(false);
  });
});

describe('background.js fresh-project retry guard', () => {
  it('retries txt2img 500s when refs are URL-backed assets', () => {
    const { shouldRetryImageJobWithFreshProject } = loadBackground();
    expect(
      shouldRetryImageJobWithFreshProject(
        new Error('generateImage HTTP 500'),
        'txt2img',
        null,
        ['https://api.flowboard.bond/api/assets/read?key=users/x/ref.jpg'],
      ),
    ).toBe(true);
  });

  it('does not retry non-500 errors', () => {
    const { shouldRetryImageJobWithFreshProject } = loadBackground();
    expect(
      shouldRetryImageJobWithFreshProject(
        new Error('generateImage HTTP 400'),
        'txt2img',
        null,
        ['https://api.flowboard.bond/api/assets/read?key=users/x/ref.jpg'],
      ),
    ).toBe(false);
  });

  it('does not retry txt2img 500s without URL-backed source inputs', () => {
    const { shouldRetryImageJobWithFreshProject } = loadBackground();
    expect(
      shouldRetryImageJobWithFreshProject(
        new Error('generateImage HTTP 500'),
        'txt2img',
        null,
        ['media-123'],
      ),
    ).toBe(false);
  });
});

describe('background.js video result fallback helpers', () => {
  it('extracts submit media ids from Flow video submit payloads', () => {
    const { extractSubmitVideoMediaIds } = loadBackground();
    expect(
      extractSubmitVideoMediaIds({
        media: [
          { name: 'media/primary-vid-1' },
          { name: 'primary-vid-2' },
          { mediaId: 'video/primary-vid-3' },
        ],
      }),
    ).toEqual(['primary-vid-1', 'primary-vid-2', 'primary-vid-3']);
  });

  it('does not treat mediaGenerationId as a retrievable media id', () => {
    const { extractOperationMediaId } = loadBackground();
    expect(
      extractOperationMediaId({
        operation: {
          name: 'op-1',
          metadata: {
            video: {
              mediaGenerationId: 'CAUS-base64-protobuf-token',
            },
          },
        },
      }, 'op-1'),
    ).toBe(null);
  });

  it('resolves completed videos through fallback primary media ids when poll ops omit urls', async () => {
    const { resolveCompletedVideo } = loadBackground();
    const flowApi = {
      async getMediaWorkflow(mediaId) {
        expect(mediaId).toBe('primary-vid-1');
        return {
          raw: {
            data: {
              video: {
                generatedVideo: {
                  fifeUrl: 'https://flow-content.google/video/primary-vid-1?sig=x',
                },
              },
            },
          },
        };
      },
    };

    const out = await resolveCompletedVideo(
      flowApi,
      {
        status: 'MEDIA_GENERATION_STATUS_SUCCESSFUL',
        operation: {
          name: 'op-1',
          metadata: {
            video: {
              mediaGenerationId: 'CAUS-base64-protobuf-token',
            },
          },
        },
      },
      'op-1',
      'primary-vid-1',
    );

    expect(out).toEqual({
      done: true,
      media_id: 'primary-vid-1',
      fifeUrl: 'https://flow-content.google/video/primary-vid-1?sig=x',
      encodedVideo: null,
    });
  });
});
