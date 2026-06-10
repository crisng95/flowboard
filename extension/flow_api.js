(function(global) {
  'use strict';

  const FLOW_API_BASE = 'https://aisandbox-pa.googleapis.com';
  const TRPC_CREATE_PROJECT = 'https://labs.google/fx/api/trpc/project.createProject';
  const UPLOAD_IMAGE_URL = `${FLOW_API_BASE}/v1/flow/uploadImage`;
  const CAPTCHA_IMAGE = 'IMAGE_GENERATION';
  const VALID_TIERS = new Set(['PAYGATE_TIER_ONE', 'PAYGATE_TIER_TWO']);
  const IMAGE_MODELS = {
    NANO_BANANA_PRO: 'GEM_PIX_2',
    NANO_OMNI: 'GEM_OMNI_1',
    NANO_BANANA_2: 'NARWHAL',
  };

  const VIDEO_I2V_URL = `${FLOW_API_BASE}/v1/video:batchAsyncGenerateVideoStartImage`;
  const VIDEO_OMNI_URL = `${FLOW_API_BASE}/v1/video:batchAsyncGenerateVideoReferenceImages`;
  const VIDEO_POLL_URL = `${FLOW_API_BASE}/v1/video:batchCheckAsyncVideoGenerationStatus`;
  const CAPTCHA_VIDEO = 'VIDEO_GENERATION';

  const GENERATE_CONTENT_URL = `${FLOW_API_BASE}/v1/flow:generateContent`;
  const DEFAULT_TEXT_MODEL = 'gemini-3-flash-preview';
  // reCAPTCHA action for flow:generateContent. Verified empirically against a
  // live Flow session (port-9222 CDP E2E): only TEXT_GENERATION is accepted —
  // IMAGE_GENERATION / GENERATE_CONTENT / GEMINI etc. all return
  // 403 PUBLIC_ERROR_UNUSUAL_ACTIVITY. The injected.js OBSERVE_EVENT path can
  // still override this if the Flow page ever uses a different action.
  const CAPTCHA_TEXT = 'TEXT_GENERATION';

  const VIDEO_MODEL_KEYS = {
    PAYGATE_TIER_ONE: {
      lite: {
        VIDEO_ASPECT_RATIO_LANDSCAPE: "veo_3_1_i2v_lite",
        VIDEO_ASPECT_RATIO_PORTRAIT: "veo_3_1_i2v_lite",
      },
      fast: {
        VIDEO_ASPECT_RATIO_LANDSCAPE: "veo_3_1_i2v_s_fast",
        VIDEO_ASPECT_RATIO_PORTRAIT: "veo_3_1_i2v_s_fast_portrait",
      },
      quality: {
        VIDEO_ASPECT_RATIO_LANDSCAPE: "veo_3_1_i2v_s",
        VIDEO_ASPECT_RATIO_PORTRAIT: "veo_3_1_i2v_s_portrait",
      },
    },
    PAYGATE_TIER_TWO: {
      lite: {
        VIDEO_ASPECT_RATIO_LANDSCAPE: "veo_3_1_i2v_lite",
        VIDEO_ASPECT_RATIO_PORTRAIT: "veo_3_1_i2v_lite",
      },
      fast: {
        VIDEO_ASPECT_RATIO_LANDSCAPE: "veo_3_1_i2v_s_fast_ultra",
        VIDEO_ASPECT_RATIO_PORTRAIT: "veo_3_1_i2v_s_fast_portrait_ultra",
      },
      quality: {
        VIDEO_ASPECT_RATIO_LANDSCAPE: "veo_3_1_i2v_s",
        VIDEO_ASPECT_RATIO_PORTRAIT: "veo_3_1_i2v_s_portrait",
      },
      lite_relaxed: {
        VIDEO_ASPECT_RATIO_LANDSCAPE: "veo_3_1_i2v_lite_low_priority",
        VIDEO_ASPECT_RATIO_PORTRAIT: "veo_3_1_i2v_lite_low_priority",
      },
      fast_relaxed: {
        VIDEO_ASPECT_RATIO_LANDSCAPE: "veo_3_1_i2v_s_fast_ultra_relaxed",
        VIDEO_ASPECT_RATIO_PORTRAIT: "veo_3_1_i2v_s_fast_ultra_relaxed",
      },
    },
  };

  const OMNI_FLASH_DURATION_KEYS = {
    4: "abra_r2v_4s",
    6: "abra_r2v_6s",
    8: "abra_r2v_8s",
    10: "abra_r2v_10s",
  };

  function resolveVideoModel(tier, aspect, quality) {
    const activeTier = tier || 'PAYGATE_TIER_ONE';
    const activeAspect = aspect || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
    const activeQuality = quality || 'fast';
    const tierMap = VIDEO_MODEL_KEYS[activeTier] || VIDEO_MODEL_KEYS.PAYGATE_TIER_ONE;
    const qualityMap = tierMap[activeQuality] || tierMap.fast;
    return qualityMap[activeAspect] || qualityMap.VIDEO_ASPECT_RATIO_LANDSCAPE;
  }

  function resolveOmniFlashModel(duration) {
    const d = Number(duration) || 4;
    return OMNI_FLASH_DURATION_KEYS[d] || OMNI_FLASH_DURATION_KEYS[4];
  }

  function resolveImageModel(key) {
    return IMAGE_MODELS[key] || IMAGE_MODELS.NANO_BANANA_PRO;
  }

  function clientContext(projectId, paygateTier) {
    if (!VALID_TIERS.has(paygateTier)) {
      throw new Error(`Invalid paygate tier: ${paygateTier}`);
    }
    return {
      projectId: String(projectId),
      recaptchaContext: {
        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
        token: '',
      },
      sessionId: `;${Date.now()}`,
      tool: 'PINHOLE',
      userPaygateTier: paygateTier,
    };
  }

  function findProjectId(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return null;
    if (typeof value.projectId === 'string' && value.projectId) return value.projectId;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findProjectId(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const child of Object.values(value)) {
      const found = findProjectId(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function extractProjectId(resp) {
    const direct = resp?.data?.result?.data?.json?.result?.projectId;
    if (typeof direct === 'string' && direct) return direct;

    const json = resp?.result?.data?.json || resp?.data?.json || resp?.json || resp?.data;
    const candidates = [
      json?.result?.projectId,
      json?.project?.name,
      json?.projectId,
      json?.name,
      json?.id,
    ];
    const candidate = candidates.find((v) => typeof v === 'string' && v);
    return candidate || findProjectId(resp);
  }

  function extractMediaEntries(resp) {
    const media = resp?.data?.media || resp?.media || resp?.result?.media || resp?.data?.result?.media;
    if (!Array.isArray(media)) return [];
    const out = [];
    for (const item of media) {
      if (!item || typeof item !== 'object') continue;
      const mediaId = typeof item.name === 'string' ? item.name : '';
      if (!mediaId) continue;
      let url = null;
      let mediaType = 'image';
      const image = item.image && typeof item.image === 'object' ? item.image : null;
      const video = item.video && typeof item.video === 'object' ? item.video : null;
      if (image?.generatedImage && typeof image.generatedImage.fifeUrl === 'string') {
        url = image.generatedImage.fifeUrl;
        mediaType = 'image';
      } else if (video) {
        const gen = video.generatedVideo || video.generatedImage;
        if (gen && typeof gen.fifeUrl === 'string') url = gen.fifeUrl;
        mediaType = 'video';
      }
      out.push({ media_id: mediaId, url, mediaType });
    }
    return out;
  }

  function extractGeneratedText(data) {
    const source = data?.data || data;
    const candidates = source?.candidates;
    if (!Array.isArray(candidates)) return '';
    let out = '';
    for (const cand of candidates) {
      const parts = cand?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (part && typeof part.text === 'string') out += part.text;
      }
    }
    return out;
  }

  function compactErrorPayload(data) {
    if (data == null) return '';
    try {
      const text = JSON.stringify(data);
      return text.length > 300 ? `${text.slice(0, 300)}...` : text;
    } catch (_) {
      return '';
    }
  }

  function buildHttpErrorMessage(label, resp, data) {
    const payload = compactErrorPayload(data);
    return payload ? `${label} HTTP ${resp.status}: ${payload}` : `${label} HTTP ${resp.status}`;
  }

  function findUploadedMediaId(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return null;
    if (typeof value.name === 'string' && value.name) return value.name;
    if (typeof value.mediaId === 'string' && value.mediaId) return value.mediaId;
    if (typeof value.media_id === 'string' && value.media_id) return value.media_id;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findUploadedMediaId(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const child of Object.values(value)) {
      const found = findUploadedMediaId(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  class FlowboardFlowApi {
    constructor(options) {
      const opts = options || {};
      this.getBearerToken = opts.getBearerToken;
      this.solveCaptcha = opts.solveCaptcha;
      this.paygateTier = opts.paygateTier || 'PAYGATE_TIER_ONE';
      this.imageModel = opts.imageModel || null;
    }

    bearerHeader() {
      const token = this.getBearerToken && this.getBearerToken();
      if (!token) throw new Error('Missing Google Flow bearer token');
      return `Bearer ${token}`;
    }

    async createProject(title) {
      const resp = await fetch(TRPC_CREATE_PROJECT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': '*/*',
          'authorization': this.bearerHeader(),
        },
        credentials: 'include',
        body: JSON.stringify({ json: { projectTitle: title, toolName: 'PINHOLE' } }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(`createProject HTTP ${resp.status}`);
      const projectId = extractProjectId(data);
      if (!projectId) throw new Error('createProject returned no project id');
      return { projectId, raw: data };
    }

    async generateImage(prompt, projectId, options) {
      const opts = options || {};
      const paygateTier = opts.paygateTier || this.paygateTier;
      const ctx = clientContext(projectId, paygateTier);
      const captchaToken = await this.solveCaptcha?.(CAPTCHA_IMAGE);
      if (!captchaToken) throw new Error('Missing reCAPTCHA token');
      ctx.recaptchaContext.token = captchaToken;

      const now = Date.now();
      const variantCount = Math.max(1, Math.min(Number(opts.variantCount || 1), 99));
      const refMediaIds = Array.isArray(opts.refMediaIds) ? opts.refMediaIds.filter((m) => typeof m === 'string' && m) : [];
      const prompts = Array.isArray(opts.prompts) ? opts.prompts : [];
      const requests = [];
      for (let i = 0; i < variantCount; i++) {
        const item = {
          clientContext: { ...ctx, sessionId: `;${now + i}` },
          seed: (now + i * 9973) % 1000000,
          structuredPrompt: { parts: [{ text: typeof prompts[i] === 'string' && prompts[i] ? prompts[i] : prompt }] },
          imageAspectRatio: opts.aspectRatio || 'IMAGE_ASPECT_RATIO_LANDSCAPE',
          imageModelName: resolveImageModel(opts.imageModel || this.imageModel),
        };
        if (refMediaIds.length > 0) {
          if (prompts.length === refMediaIds.length && i < refMediaIds.length) {
            item.imageInputs = [{ name: refMediaIds[i], imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE' }];
          } else {
            item.imageInputs = refMediaIds.map((mediaId) => ({ name: mediaId, imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE' }));
          }
        }
        requests.push(item);
      }
      const body = {
        clientContext: ctx,
        mediaGenerationContext: { batchId: crypto.randomUUID() },
        useNewMedia: true,
        requests,
      };

      const resp = await fetch(`${FLOW_API_BASE}/v1/projects/${projectId}/flowMedia:batchGenerateImages`, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
          'accept': '*/*',
          'origin': 'https://labs.google',
          'referer': 'https://labs.google/',
          'authorization': this.bearerHeader(),
        },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(buildHttpErrorMessage('generateImage', resp, data));
      return {
        raw: data,
        mediaEntries: extractMediaEntries(data),
      };
    }


    async editImage(prompt, projectId, options) {
      const opts = options || {};
      const paygateTier = opts.paygateTier || this.paygateTier;
      const ctx = clientContext(projectId, paygateTier);
      const captchaToken = await this.solveCaptcha?.(CAPTCHA_IMAGE);
      if (!captchaToken) throw new Error('Missing reCAPTCHA token');
      ctx.recaptchaContext.token = captchaToken;

      const sourceMediaId = typeof opts.sourceMediaId === 'string' ? opts.sourceMediaId : '';
      if (!sourceMediaId) throw new Error('Missing source media id');
      const refMediaIds = Array.isArray(opts.refMediaIds) ? opts.refMediaIds.filter((m) => typeof m === 'string' && m) : [];
      const requestItem = {
        clientContext: { ...ctx, sessionId: `;${Date.now()}` },
        seed: Date.now() % 1000000,
        structuredPrompt: { parts: [{ text: prompt }] },
        imageAspectRatio: opts.aspectRatio || 'IMAGE_ASPECT_RATIO_LANDSCAPE',
        imageModelName: resolveImageModel(opts.imageModel || this.imageModel),
        imageInputs: [
          { name: sourceMediaId, imageInputType: 'IMAGE_INPUT_TYPE_BASE_IMAGE' },
          ...refMediaIds.map((mediaId) => ({ name: mediaId, imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE' })),
        ],
      };

      const body = {
        clientContext: ctx,
        mediaGenerationContext: { batchId: crypto.randomUUID() },
        useNewMedia: true,
        requests: [requestItem],
      };

      const resp = await fetch(`${FLOW_API_BASE}/v1/projects/${projectId}/flowMedia:batchGenerateImages`, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
          'accept': '*/*',
          'origin': 'https://labs.google',
          'referer': 'https://labs.google/',
          'authorization': this.bearerHeader(),
        },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(buildHttpErrorMessage('editImage', resp, data));
      return {
        raw: data,
        mediaEntries: extractMediaEntries(data),
      };
    }

    async uploadImage(imageBytesBase64, mimeType, projectId, fileName) {
      const resp = await fetch(UPLOAD_IMAGE_URL, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
          'accept': '*/*',
          'origin': 'https://labs.google',
          'referer': 'https://labs.google/',
          'authorization': this.bearerHeader(),
        },
        credentials: 'include',
        body: JSON.stringify({
          clientContext: { projectId: String(projectId), tool: 'PINHOLE' },
          fileName: fileName || 'reference.png',
          imageBytes: imageBytesBase64,
          isHidden: false,
          isUserUploaded: true,
          mimeType,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(`uploadImage HTTP ${resp.status}`);
      const mediaId = data?.data?.media?.name || findUploadedMediaId(data);
      if (typeof mediaId !== 'string' || !mediaId) throw new Error('uploadImage returned no media id');
      return { mediaId, raw: data };
    }

    async generateVideo(prompt, projectId, options) {
      const opts = options || {};
      const paygateTier = opts.paygateTier || this.paygateTier;
      const ctx = clientContext(projectId, paygateTier);
      const captchaToken = await this.solveCaptcha?.(CAPTCHA_VIDEO);
      if (!captchaToken) throw new Error('Missing reCAPTCHA token');
      ctx.recaptchaContext.token = captchaToken;

      const sources = Array.isArray(opts.startMediaIds) && opts.startMediaIds.length > 0
        ? opts.startMediaIds
        : [opts.startMediaId];
      
      const prompts = Array.isArray(opts.prompts) ? opts.prompts : [];
      const modelKey = resolveVideoModel(paygateTier, opts.aspectRatio, opts.videoQuality);
      const now = Date.now();

      const requests = sources.map((mid, i) => ({
        aspectRatio: opts.aspectRatio || 'VIDEO_ASPECT_RATIO_LANDSCAPE',
        seed: (now + i * 9973) % 1000000,
        textInput: { structuredPrompt: { parts: [{ text: typeof prompts[i] === 'string' && prompts[i] ? prompts[i] : prompt }] } },
        videoModelKey: modelKey,
        startImage: { mediaId: mid },
        metadata: { sceneId: crypto.randomUUID() }
      }));

      const body = {
        clientContext: ctx,
        mediaGenerationContext: { batchId: crypto.randomUUID() },
        requests,
        useV2ModelConfig: true,
      };

      const resp = await fetch(VIDEO_I2V_URL, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
          'accept': '*/*',
          'origin': 'https://labs.google',
          'referer': 'https://labs.google/',
          'authorization': this.bearerHeader(),
        },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(`generateVideo HTTP ${resp.status}`);
      return { raw: data };
    }

    async generateVideoOmni(prompt, projectId, options) {
      const opts = options || {};
      const paygateTier = opts.paygateTier || this.paygateTier;
      const ctx = clientContext(projectId, paygateTier);
      const captchaToken = await this.solveCaptcha?.(CAPTCHA_VIDEO);
      if (!captchaToken) throw new Error('Missing reCAPTCHA token');
      ctx.recaptchaContext.token = captchaToken;

      const refMediaIds = Array.isArray(opts.refMediaIds) ? opts.refMediaIds.filter(Boolean) : [];
      // Batch fan-out: when the caller supplies a list of source images
      // (a connected image list × N), emit one request item per source so
      // Omni produces N distinct videos — symmetric with generateVideo (Veo).
      // Each item is conditioned on its own source image plus any shared
      // ingredients (refMediaIds). When no batch sources are supplied we fall
      // back to a single item conditioned on the shared refMediaIds (the
      // legacy single-clip behaviour, unchanged).
      const batchSources = Array.isArray(opts.startMediaIds)
        ? opts.startMediaIds.filter(Boolean)
        : [];
      const prompts = Array.isArray(opts.prompts) ? opts.prompts : [];
      const modelKey = resolveOmniFlashModel(opts.duration_s);
      const now = Date.now();
      const aspectRatio = opts.aspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT';

      const makeRefImages = (ids) => ids.map((mid) => ({
        mediaId: mid,
        imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
      }));

      let requests;
      if (batchSources.length > 0) {
        // Genuinely-shared ingredients are the refs that are NOT themselves
        // batch sources. In the common case the upstream image list is wired
        // as both ref_media_ids and start_media_ids, so this filter leaves
        // each video conditioned solely on its own source image (mirroring
        // the Veo path). A genuinely separate ingredient (e.g. a style ref)
        // still applies to every clip.
        const sharedRefs = refMediaIds.filter((r) => !batchSources.includes(r));
        requests = batchSources.map((mid, i) => ({
          aspectRatio,
          // Per-variant prompt: pair prompts[i] with source[i]; fall back to
          // the shared prompt when the list is missing/short/empty.
          textInput: {
            structuredPrompt: {
              parts: [{ text: typeof prompts[i] === 'string' && prompts[i] ? prompts[i] : prompt }],
            },
          },
          videoModelKey: modelKey,
          // Distinct seed per item so Flow doesn't dedupe identical clips.
          seed: (now + i * 9973) % 1000000,
          metadata: {},
          // This source image leads, followed by any genuinely-shared refs.
          referenceImages: makeRefImages([mid, ...sharedRefs]),
        }));
      } else {
        requests = [{
          aspectRatio,
          textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
          videoModelKey: modelKey,
          seed: now % 1000000,
          metadata: {},
          referenceImages: makeRefImages(refMediaIds),
        }];
      }

      const body = {
        mediaGenerationContext: {
          batchId: crypto.randomUUID(),
          audioFailurePreference: 'BLOCK_SILENCED_VIDEOS',
        },
        clientContext: ctx,
        requests,
        useV2ModelConfig: true,
      };

      const resp = await fetch(VIDEO_OMNI_URL, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
          'accept': '*/*',
          'origin': 'https://labs.google',
          'referer': 'https://labs.google/',
          'authorization': this.bearerHeader(),
        },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(`generateVideoOmni HTTP ${resp.status}`);
      return { raw: data };
    }

    /**
     * @param {Array} contents  [{ role, parts: [{text}|{inlineData:{mimeType,data}}] }]
     * @param {Object} [options] { model, systemInstruction, thinkingConfig,
     *                             requestContext, captchaAction }
     * @returns {Promise<{ raw: object, text: string }>}
     */
    async generateContent(contents, options) {
      const opts = options || {};
      const captchaToken = await this.solveCaptcha?.(opts.captchaAction || CAPTCHA_TEXT);
      if (!captchaToken) throw new Error('Missing reCAPTCHA token');

      const body = {
        model: opts.model || DEFAULT_TEXT_MODEL,
        contents,
        recaptchaContext: {
          token: captchaToken,
          applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
        },
      };
      if (opts.systemInstruction) body.systemInstruction = opts.systemInstruction;
      if (opts.thinkingConfig)    body.thinkingConfig = opts.thinkingConfig;
      if (opts.requestContext)    body.requestContext = opts.requestContext;
      // NOTE: clientContext is intentionally never set for generateContent.

      const resp = await fetch(GENERATE_CONTENT_URL, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
          'accept': '*/*',
          'origin': 'https://labs.google',
          'referer': 'https://labs.google/',
          'authorization': this.bearerHeader(),
        },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      let data;
      try {
        data = await resp.json();
      } catch (e) {
        throw new Error('generateContent malformed JSON response');
      }
      if (!resp.ok) throw new Error(`generateContent HTTP ${resp.status}`);
      return { raw: data, text: extractGeneratedText(data) };
    }

    async checkVideoOperations(operationNames, projectId) {
      const body = {
        operations: operationNames.map((name) => ({ operation: { name } })),
      };
      const resp = await fetch(VIDEO_POLL_URL, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
          'accept': '*/*',
          'origin': 'https://labs.google',
          'referer': 'https://labs.google/',
          'authorization': this.bearerHeader(),
        },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(`checkVideoOperations HTTP ${resp.status}`);
      return { raw: data };
    }

    async getMediaWorkflow(mediaId) {
      const resp = await fetch(`${FLOW_API_BASE}/v1/media/${mediaId}?clientContext.tool=PINHOLE`, {
        method: 'GET',
        headers: {
          'accept': '*/*',
          'origin': 'https://labs.google',
          'referer': 'https://labs.google/',
          'authorization': this.bearerHeader(),
        },
        credentials: 'include',
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(`getMediaWorkflow HTTP ${resp.status}`);
      return { raw: data };
    }
  }

  global.FlowboardFlowApi = FlowboardFlowApi;
  global.FlowboardFlowApiUtils = {
    extractMediaEntries,
    extractProjectId,
    clientContext,
    resolveImageModel,
    extractGeneratedText,
  };
})(self);
