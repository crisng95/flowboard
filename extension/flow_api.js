(function(global) {
  'use strict';

  const FLOW_API_BASE = 'https://aisandbox-pa.googleapis.com';
  const TRPC_CREATE_PROJECT = 'https://labs.google/fx/api/trpc/project.createProject';
  const CAPTCHA_IMAGE = 'IMAGE_GENERATION';
  const VALID_TIERS = new Set(['PAYGATE_TIER_ONE', 'PAYGATE_TIER_TWO']);
  const IMAGE_MODELS = {
    NANO_BANANA_PRO: 'GEM_PIX_2',
    NANO_OMNI: 'GEM_OMNI_1',
    NANO_BANANA_2: 'NARWHAL',
  };

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
      const body = {
        clientContext: ctx,
        mediaGenerationContext: { batchId: crypto.randomUUID() },
        useNewMedia: true,
        requests: [{
          clientContext: { ...ctx, sessionId: `;${now}` },
          seed: now % 1000000,
          structuredPrompt: { parts: [{ text: prompt }] },
          imageAspectRatio: opts.aspectRatio || 'IMAGE_ASPECT_RATIO_LANDSCAPE',
          imageModelName: resolveImageModel(opts.imageModel || this.imageModel),
        }],
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
      if (!resp.ok) throw new Error(`generateImage HTTP ${resp.status}`);
      return {
        raw: data,
        mediaEntries: extractMediaEntries(data),
      };
    }
  }

  global.FlowboardFlowApi = FlowboardFlowApi;
  global.FlowboardFlowApiUtils = {
    extractMediaEntries,
    extractProjectId,
    clientContext,
    resolveImageModel,
  };
})(self);
