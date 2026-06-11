importScripts('cloud_client.js', 'asset_utils.js', 'flow_api.js');

/**
 * Flowboard Bridge — Chrome Extension Background Service Worker
 *
 * Connects to local Python agent via WebSocket (agent runs WS server).
 * Captures Bearer token and proxies API calls through the browser context.
 */

const AGENT_WS_URL  = 'ws://127.0.0.1:9223';
const CALLBACK_URL  = 'http://127.0.0.1:8101/api/ext/callback';
const FALLBACK_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

let ws               = null;
let flowKey          = null;
let callbackSecret   = null; // Auth secret received from agent on WS connect
let state            = 'off'; // off | idle | running
let manualDisconnect = false;
let activeRequests   = new Map();
let idleTimeout      = null;
let metrics = {
  tokenCapturedAt: null,
  requestCount:    0,
  successCount:    0,
  failedCount:     0,
  lastError:       null,
};
let observedCaptchaActions = {};
let observedFlowSdkInfo = null;
let cloudConfig = null;
let cloudWorkerBusy = false;
let cloudWorkerLastPollAt = null;
let cloudNoJobStreak = 0;
let cloudFastPollUntil = 0;
const FLOW_PROJECT_MEDIA_CACHE_KEY = 'flowProjectMediaCache';
const FLOW_PROJECT_MEDIA_CACHE_MAX = 500;
const CLOUD_FAST_POLL_SECONDS = 5;
const CLOUD_FAST_POLL_WINDOW_MS = 90 * 1000;
const CLOUD_IDLE_BACKOFF_SECONDS = [30, 60, 120, 300];
const CLOUD_HEARTBEAT_SECONDS = 60;
// Tier 3 seed for flowSdkInfo: known captured constants, overridable via
// cloudConfig.flowSdkInfoSeed so an applet-version bump needs no code change.
// See design 6c.
const DEFAULT_FLOW_SDK_INFO_SEED = {
  appletId: '96d388e5-41e3-4661-8102-57479ac91729',
  appletVersionId: 'fbca04f3-c5cc-4b69-8c91-4c88abb1e9a3',
};

if (typeof globalThis.FlowboardFlowApi === 'function' && typeof globalThis.FlowboardFlowApi.prototype.editImage !== 'function') {
  globalThis.FlowboardFlowApi.prototype.editImage = async function editImage(prompt, projectId, options) {
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
    if (!resp.ok) throw new Error(`editImage HTTP ${resp.status}`);
    return {
      raw: data,
      mediaEntries: extractMediaEntries(data),
    };
  };
}

const flowUrls = ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'];

// ─── URL → Log Type Classifier ─────────────────────────────

function classifyUrl(url) {
  if (url.includes('batchGenerateImages'))     return 'GEN_IMG';
  if (url.includes('batchAsyncGenerateVideo')) return 'GEN_VID';
  if (url.includes('batchCheckAsync'))         return 'POLL';
  return 'API';
}

// ─── Request Log (last 50 entries) ─────────────────────────

let requestLog = [];

function addRequestLog(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 50) requestLog.pop();
  broadcastRequestLog();
}

function updateRequestLog(id, updates) {
  const entry = requestLog.find((e) => e.id === id);
  if (entry) Object.assign(entry, updates);
  broadcastRequestLog();
}

function broadcastRequestLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => {});
}

// ─── Startup ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect') connectToAgent();
  if (alarm.name === 'keepAlive') keepAlive();
  if (alarm.name === 'cloudPoll') void pollCloudWorkerOnce();
});

async function init() {
  // Note: deliberately not restoring `userInfo` from storage. We used
  // to persist it here, but Google profile fields (name + email) are
  // PII and chrome.storage.local is plaintext + readable by other
  // extensions on the profile that hold the `storage` permission.
  // The agent replays user_info on every WS reconnect anyway via
  // fetchAndPushUserInfo(token), so persistence buys nothing.
  const data = await chrome.storage.local.get(['flowKey', 'metrics', 'callbackSecret', 'observedCaptchaActions', 'observedFlowSdkInfo', 'cloudConfig']);
  if (data.flowKey)        flowKey        = data.flowKey;
  if (data.metrics)        Object.assign(metrics, data.metrics);
  if (data.callbackSecret) callbackSecret = data.callbackSecret;
  if (data.observedCaptchaActions) observedCaptchaActions = data.observedCaptchaActions;
  if (data.observedFlowSdkInfo) observedFlowSdkInfo = data.observedFlowSdkInfo;
  if (data.cloudConfig) cloudConfig = data.cloudConfig;
  if (cloudConfig?.mode === 'cloud-worker') {
    startCloudWorkerLoop();
  } else {
    connectToAgent();
  }
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
}

// ─── Token Capture ──────────────────────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!value.startsWith('Bearer ya29.')) return;

    const token = value.replace(/^Bearer\s+/i, '').trim();
    if (!token) return;

    // Always update — even if same token string, refresh the timestamp
    const tokenChanged = flowKey !== token;
    flowKey = token;
    metrics.tokenCapturedAt = Date.now();
    chrome.storage.local.set({ flowKey, metrics });

    // Only emit on the WS when the token actually rotated. The listener
    // fires on EVERY outbound aisandbox-pa request — and the agent's
    // own poll loops generate dozens per minute. Re-sending the same
    // string each time pushed the agent into an effective infinite
    // /v1/credits refresh loop (one credits GET per poll). The agent
    // side has a defensive dedupe too, but quiet at the source first.
    if (tokenChanged) {
      console.log('[Flowboard] Bearer token captured');
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
      }
      // Resolve the user's identity (email/name/picture) once per token —
      // saves the popup + AccountPanel from showing "Connected via
      // extension" placeholders. The token already has the userinfo.email
      // + userinfo.profile scopes Flow needs anyway, so this is a free
      // call. Errors are non-fatal and silent.
      fetchAndPushUserInfo(token);
    }
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*'] },
  ['requestHeaders', 'extraHeaders'],
);

let cachedUserInfo = null;

async function fetchAndPushUserInfo(token) {
  try {
    const resp = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) {
      console.warn('[Flowboard] userinfo fetch returned', resp.status);
      return;
    }
    const info = await resp.json();
    // In-memory only — DO NOT persist to chrome.storage.local. PII
    // there is plaintext on disk and readable by other extensions
    // with the `storage` permission. Lifetime = service-worker
    // lifetime; rebuilt on next token rotation if the SW recycles.
    cachedUserInfo = info;
    console.log('[Flowboard] userinfo captured for', info?.email || '<no email>');
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'user_info', userInfo: info }));
    }
  } catch (e) {
    console.warn('[Flowboard] userinfo fetch failed:', e?.message || e);
  }
}

// ─── WebSocket to Agent ─────────────────────────────────────

function connectToAgent() {
  if (manualDisconnect) return;
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(AGENT_WS_URL);
  } catch (e) {
    console.error('[Flowboard] WS connect error:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[Flowboard] Connected to agent');
    chrome.alarms.clear('reconnect');
    setState('idle');

    const tokenAge = flowKey && metrics.tokenCapturedAt
      ? Date.now() - metrics.tokenCapturedAt
      : null;

    ws.send(JSON.stringify({
      type: 'extension_ready',
      flowKeyPresent: !!flowKey,
      tokenAge,
    }));

    // Resend token immediately so agent can start without waiting for a capture
    if (flowKey) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
    // Replay cached userinfo so the agent's AccountPanel populates on
    // reconnect without waiting for the next token rotation. If we
    // never resolved one yet but a token IS present, kick off a fetch.
    if (cachedUserInfo) {
      ws.send(JSON.stringify({ type: 'user_info', userInfo: cachedUserInfo }));
    } else if (flowKey) {
      fetchAndPushUserInfo(flowKey);
    }
    for (const [scope, snapshot] of Object.entries(observedCaptchaActions)) {
      if (snapshot?.action) {
        ws.send(JSON.stringify({
          type: 'captcha_action_observed',
          scope,
          action: snapshot.action,
          siteKey: snapshot.siteKey || null,
          href: snapshot.href || null,
          observedAt: snapshot.observedAt || Date.now(),
        }));
      }
    }
  };

  ws.onmessage = async ({ data }) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'callback_secret') {
        callbackSecret = msg.secret;
        chrome.storage.local.set({ callbackSecret: msg.secret });
        console.log('[Flowboard] Received callback secret');
      } else if (msg.type === 'pong') {
        // keepalive response — no-op
      } else if (msg.type === 'logout') {
        // Agent's /api/auth/logout invoked — drop in-memory identity
        // so the next reconnect picks up fresh credentials. Don't
        // touch chrome.storage (we don't persist identity there
        // anyway, but be explicit). The WS stays open; agent will
        // re-greet when the user logs back in.
        console.log('[Flowboard] logout requested by agent');
        cachedUserInfo = null;
        flowKey = null;
      } else if (msg.type === 'please_resend_userinfo') {
        // Agent's /api/auth/scan asks us to re-fetch userinfo when
        // its own cache is empty (e.g. agent restarted, or user
        // clicked "Scan extension" before WS finished its first
        // round-trip). If we have a cached profile, replay it
        // immediately; otherwise refetch from Google's userinfo
        // endpoint with whatever Bearer token we currently hold.
        if (cachedUserInfo) {
          ws.send(JSON.stringify({ type: 'user_info', userInfo: cachedUserInfo }));
        } else if (flowKey) {
          fetchAndPushUserInfo(flowKey);
        } else {
          console.log('[Flowboard] please_resend_userinfo: no token captured yet');
        }
      } else if (msg.method === 'api_request') {
        await handleApiRequest(msg);
      } else if (msg.method === 'trpc_request') {
        await handleTrpcRequest(msg);
      } else if (msg.method === 'get_status') {
        sendToAgent({
          id: msg.id,
          result: {
            state,
            flowKeyPresent: !!flowKey,
            manualDisconnect,
            tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
            metrics,
          },
        });
      }
    } catch (e) {
      console.error('[Flowboard] Message error:', e);
    }
  };

  ws.onclose = () => {
    setState('off');
    if (!manualDisconnect) scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('[Flowboard] WS error:', e);
    metrics.lastError = 'WS_ERROR';
    chrome.storage.local.set({ metrics });
  };
}

function scheduleReconnect() {
  chrome.alarms.create('reconnect', { delayInMinutes: 0.083 }); // ~5 s
}

function keepAlive() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  } else {
    connectToAgent();
  }
}

// ─── Send to Agent ──────────────────────────────────────────

/**
 * Route a message to the agent.
 * Responses (msg.id present) go via HTTP callback — immune to WS drops.
 * Falls back to WS on HTTP failure. Non-response messages use WS directly.
 */
function sendToAgent(msg) {
  if (msg.id) {
    fetch(CALLBACK_URL, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-Callback-Secret': callbackSecret || '',
      },
      body: JSON.stringify(msg),
    }).catch(() => {
      // HTTP failed — fall back to WS
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
    return;
  }
  // Non-response messages (ping, status, token_captured)
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── API Request Proxy ──────────────────────────────────────

function updateStateFromActiveRequests() {
  if (cloudConfig?.mode === 'cloud-worker') return;

  if (activeRequests.size > 0) {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
      idleTimeout = null;
    }
    setState('running');
  } else {
    if (!idleTimeout) {
      idleTimeout = setTimeout(() => {
        idleTimeout = null;
        if (activeRequests.size === 0) {
          setState('idle');
        }
      }, 4000);
    }
  }
}

/**
 * Inject a solved reCAPTCHA token into every recaptchaContext location that is
 * present on `body`, covering four locations:
 *   - top-level `body.recaptchaContext`          (flow:generateContent)
 *   - `body.clientContext.recaptchaContext`      (image/edit)
 *   - `body.agentClientContext.recaptchaContext` (Omni)
 *   - each `body.requests[].clientContext.recaptchaContext` (batch)
 *
 * Pure helper: each site is guarded by a presence + typeof object check, so no
 * recaptchaContext is created where absent, and only the `.token` field is
 * written — making the operation idempotent (applying twice == applying once).
 * Mutates and returns the passed `body`; callers that must not mutate their
 * input should deep-clone before calling.
 */
function injectCaptchaToken(body, token) {
  if (!body || typeof body !== 'object') return body;

  if (body.recaptchaContext && typeof body.recaptchaContext === 'object') {
    body.recaptchaContext.token = token;
  }
  if (body.clientContext && typeof body.clientContext === 'object'
      && body.clientContext.recaptchaContext && typeof body.clientContext.recaptchaContext === 'object') {
    body.clientContext.recaptchaContext.token = token;
  }
  if (body.agentClientContext && typeof body.agentClientContext === 'object'
      && body.agentClientContext.recaptchaContext && typeof body.agentClientContext.recaptchaContext === 'object') {
    body.agentClientContext.recaptchaContext.token = token;
    console.log('[Bridge] Successfully patched ReCAPTCHA token into agentClientContext for Omni');
  }
  if (Array.isArray(body.requests)) {
    for (const req of body.requests) {
      if (req && typeof req === 'object'
          && req.clientContext && typeof req.clientContext === 'object'
          && req.clientContext.recaptchaContext && typeof req.clientContext.recaptchaContext === 'object') {
        req.clientContext.recaptchaContext.token = token;
      }
    }
  }
  return body;
}

// Expose the pure helper for tests (service-worker global scope).
globalThis.injectCaptchaToken = injectCaptchaToken;

/**
 * Build the Gemini-style `contents` array for a `text_gen` job from its
 * `inputData`. Produces a single `user` content whose `parts` begins with
 * exactly one `{ text: ... }` entry, followed by exactly one
 * `{ inlineData: { mimeType, data } }` entry per attachment that carries a
 * string `data` (in order). When there are no valid attachments, `parts`
 * contains only the text entry. If the prompt is blank but attachments are
 * present, inject a minimal fallback instruction so Flow does not receive an
 * effectively image-only request.
 *
 * Pure helper (no side effects): `inputData.attachments` is treated as empty
 * when it is not an array. Mirrors the parts-building in design component 2b.
 *
 * @param {{ prompt?: string, attachments?: Array<{mimeType?: string, data?: string}> }} inputData
 * @returns {Array<{ role: string, parts: Array<object> }>}
 */
function buildTextGenContents(inputData) {
  const prompt = inputData ? inputData.prompt : undefined;
  const attachments = inputData && Array.isArray(inputData.attachments) ? inputData.attachments : [];
  const parts = [];
  const normalizedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  parts.push({ text: normalizedPrompt || 'Analyze the attached media.' });
  for (const att of attachments) {
    if (att && typeof att.data === 'string' && att.data) {
      parts.push({ inlineData: { mimeType: att.mimeType || 'image/png', data: att.data } });
    }
  }
  return [{ role: 'user', parts }];
}

// Expose the pure helper for tests (service-worker global scope).
globalThis.buildTextGenContents = buildTextGenContents;

async function handleApiRequest(msg) {
  const { id, params } = msg;
  const { url, method, headers, body, captchaAction } = params || {};

  if (!url || !url.startsWith('https://aisandbox-pa.googleapis.com/')) {
    sendToAgent({ id, status: 400, error: 'INVALID_URL' });
    return;
  }

  const type = classifyUrl(url);
  activeRequests.set(id, type);
  updateStateFromActiveRequests();

  const effectiveCaptchaAction = resolveCaptchaAction(url, captchaAction);
  const hasCaptcha = !!effectiveCaptchaAction;
  if (hasCaptcha) metrics.requestCount++;

  addRequestLog({
    id,
    type,
    time:   new Date().toISOString(),
    status: 'processing',
    url,
  });

  try {
    // Step 0: Fail fast if we have no bearer token. Avoids burning a reCAPTCHA
    // solve (rate-limited + single-use) only to discover later that we can't
    // send the request.
    if (!flowKey) {
      sendToAgent({ id, status: 503, error: 'NO_FLOW_KEY' });
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = 'NO_FLOW_KEY'; }
      updateRequestLog(id, { status: 'failed', error: 'NO_FLOW_KEY' });
      return;
    }

    // Step 1: Solve captcha if needed
    let captchaToken = null;
    if (effectiveCaptchaAction) {
      const captchaResult = await solveCaptcha(id, effectiveCaptchaAction);
      captchaToken = captchaResult?.token || null;
      if (!captchaToken) {
        const err = captchaResult?.error || 'CAPTCHA_FAILED';
        console.error(`[Flowboard] Captcha failed for ${effectiveCaptchaAction}: ${err}`);
        sendToAgent({ id, status: 403, error: `CAPTCHA_FAILED: ${err}` });
        if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `CAPTCHA_FAILED: ${err}`; }
        updateRequestLog(id, { status: 'failed', error: `CAPTCHA_FAILED: ${err}` });
        return;
      }
    }

    // Step 2: Inject captcha token into body clone if present.
    // Deep-clone first so the caller's object is never mutated, then patch the
    // token at every present recaptchaContext location via the pure helper.
    let finalBody = body;
    if (captchaToken && finalBody) {
      finalBody = JSON.parse(JSON.stringify(finalBody)); // deep clone
      injectCaptchaToken(finalBody, captchaToken);
    }

    const fetchHeaders = { ...(headers || {}) };
    const useOmniTabForward = url.includes('flowCreationAgent:streamChat');
    if (useOmniTabForward) {
      fetchHeaders.Authorization = `Bearer ${flowKey}`;
      fetchHeaders['Content-Type'] = 'application/json';
      fetchHeaders['X-Same-Domain'] = '1';
      fetchHeaders.Accept = 'text/event-stream, text/event-stream';
      fetchHeaders['sec-ch-ua'] = '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"';
      fetchHeaders['sec-ch-ua-platform'] = '"Windows"';
    } else {
      fetchHeaders.authorization = `Bearer ${flowKey}`;
    }

    let responseStatus;
    let responseText;
    if (useOmniTabForward) {
      const response = await fetch(url, {
        method: method || 'POST',
        headers: fetchHeaders,
        credentials: 'include',
        mode: 'cors',
        body: method === 'GET' ? undefined : JSON.stringify(finalBody),
      });
      responseStatus = response.status;
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('response body is not readable');
      }
      const decoder = new TextDecoder();
      let finalFullText = '';
      while (true) {
        const { value, done } = await reader.read();
        const rawChunk = decoder.decode(value || new Uint8Array(), { stream: !done });
        if (rawChunk) {
          console.log('[Bridge Omni Raw Chunk]:', rawChunk);
          finalFullText += rawChunk;
        }
        if (done) {
          finalFullText += decoder.decode();
          break;
        }
      }
      responseText = finalFullText;
    } else {
      const response = await fetch(url, {
        method:      method || 'POST',
        headers:     fetchHeaders,
        credentials: 'include',
        body:        method === 'GET' ? undefined : JSON.stringify(finalBody),
      });
      responseStatus = response.status;
      responseText = await response.text();
    }

    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }
    if (!(responseStatus >= 200 && responseStatus < 300)) {
      if (responseData && typeof responseData === 'object') {
        console.log('[Bridge] Omni error response JSON:\n' + JSON.stringify(responseData, null, 2));
      } else {
        console.log('[Bridge] Omni error response text:', responseData);
      }
    }

    sendToAgent({ id, status: responseStatus, data: responseData });

    if (responseStatus >= 200 && responseStatus < 300) {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      updateRequestLog(id, { status: 'success', httpStatus: responseStatus });
    } else {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `API_${responseStatus}`; }
      updateRequestLog(id, { status: 'failed', httpStatus: responseStatus, error: `API_${responseStatus}` });
    }
  } catch (e) {
    sendToAgent({ id, status: 500, error: e.message || 'API_REQUEST_FAILED' });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message || 'API_REQUEST_FAILED'; }
    updateRequestLog(id, { status: 'failed', error: e.message || 'API_REQUEST_FAILED' });
  } finally {
    activeRequests.delete(id);
    updateStateFromActiveRequests();
    chrome.storage.local.set({ metrics });
  }
}

function getBestObservedCaptchaSnapshot(url, requestedAction) {
  const snapshots = Object.values(observedCaptchaActions || {})
    .filter((entry) => entry && typeof entry === 'object');
  if (!snapshots.length) return null;

  const normalizedAction = typeof requestedAction === 'string' && requestedAction ? requestedAction : null;
  const hrefMatches = snapshots.filter((entry) => typeof entry.href === 'string' && url && entry.href.includes(url));
  const actionMatches = normalizedAction
    ? snapshots.filter((entry) => entry.action === normalizedAction)
    : [];

  const ranked = [...hrefMatches, ...actionMatches, ...snapshots]
    .filter((entry, index, list) => list.indexOf(entry) === index)
    .sort((a, b) => (Number(b.observedAt) || 0) - (Number(a.observedAt) || 0));

  return ranked[0] || null;
}

function resolveCaptchaAction(url, requestedAction) {
  const isStreamChat = url?.includes('flowCreationAgent:streamChat');
  const isGenerateContent = url?.includes('flow:generateContent');
  if (isStreamChat || isGenerateContent) {
    const observed = getBestObservedCaptchaSnapshot(url, requestedAction);
    if (observed?.action) {
      return observed.action;
    }
    // Preserve the OMNI_DYNAMIC "no captcha" behavior for the streamChat path.
    if (isStreamChat && requestedAction === 'OMNI_DYNAMIC') {
      return null;
    }
  }
  // For generateContent this falls through to requestedAction (TEXT_GENERATION
  // default supplied by the job / flow_api) when nothing has been observed.
  return requestedAction || null;
}

function resolveCaptchaSiteKey(url, requestedAction) {
  const observed = getBestObservedCaptchaSnapshot(url, requestedAction);
  if (typeof observed?.siteKey === 'string' && observed.siteKey) {
    return observed.siteKey;
  }
  console.warn('[Bridge] Dynamic siteKey not found; requesting captcha with tab-side discovery first.');
  return null;
}

/**
 * Resolve the Flow SDK telemetry (`flowSdkInfo`) for the Tier-2/Tier-3 retry of
 * a `generateContent` request. Precedence (design 6c):
 *   1. observedFlowSdkInfo — passively captured from the Flow page (component 6b)
 *   2. cloudConfig.flowSdkInfoSeed — config-overridable seed constants
 *      (falls back to DEFAULT_FLOW_SDK_INFO_SEED when no override is set)
 * Returns `{ appletId?, appletVersionId? }` or `null` when nothing is available.
 */
function resolveFlowSdkInfo() {
  // Tier 2 source: passively observed from the Flow page (9.2)
  if (observedFlowSdkInfo && (observedFlowSdkInfo.appletId || observedFlowSdkInfo.appletVersionId)) {
    return {
      appletId: observedFlowSdkInfo.appletId || undefined,
      appletVersionId: observedFlowSdkInfo.appletVersionId || undefined,
    };
  }
  // Tier 3 seed: config-overridable constants (default seed when no override)
  const seed = cloudConfig?.flowSdkInfoSeed || DEFAULT_FLOW_SDK_INFO_SEED;
  if (seed && (seed.appletId || seed.appletVersionId)) {
    return {
      appletId: seed.appletId || undefined,
      appletVersionId: seed.appletVersionId || undefined,
    };
  }
  return null;
}
// ─── Token Refresh (minimal) ────────────────────────────────

let _openingFlowTab = false;

const FLOW_URL = 'https://labs.google/fx/tools/flow';

/**
 * Open a Flow tab even when Chrome has zero windows. `chrome.tabs.create`
 * throws "No current window" in that state because it needs a window
 * context to attach to; `chrome.windows.create` spawns a fresh window
 * and tab in one call. Falls back through both paths so we recover from
 * "all-windows-closed but service-worker-still-alive" silently.
 */
async function openFlowTabResilient(active = false) {
  try {
    return await chrome.tabs.create({ url: FLOW_URL, active });
  } catch (e) {
    const msg = e?.message || '';
    if (!msg.includes('No current window')) throw e;
    console.log('[Flowboard] No Chrome window — spawning a fresh one for Flow');
    const win = await chrome.windows.create({
      url: FLOW_URL,
      focused: false,
      state: 'minimized',
    });
    return win.tabs?.[0] ?? null;
  }
}

async function captureTokenFromFlowTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
  });

  if (!tabs.length) {
    if (_openingFlowTab) return;
    _openingFlowTab = true;
    try {
      console.log('[Flowboard] No Flow tab — opening in background');
      await openFlowTabResilient(false);
    } catch (e) {
      console.error('[Flowboard] Failed to open Flow tab:', e);
    } finally {
      _openingFlowTab = false;
    }
    return;
  }

  try {
    // Trigger a credentialed request so the page re-issues an Authorization header
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func:   () => fetch('/fx/tools/flow', { credentials: 'include' }),
    });
    console.log('[Flowboard] Token refresh triggered on Flow tab');
  } catch (e) {
    console.error('[Flowboard] Token refresh failed:', e);
  }
}

// ─── reCAPTCHA Solving ──────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function requestCaptchaFromTab(tabId, requestId, pageAction) {
  const candidates = await chrome.tabs.query({ url: flowUrls });
  const flowTab = candidates.find((t) => t.id === tabId);
  const siteKey = resolveCaptchaSiteKey(flowTab?.url || '', pageAction);
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
      siteKey,
    });
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) throw error;

    // Inject content script and retry. Both the inject + re-send can
    // throw "No current window" / "No tab with id" if the tab dies in
    // between (Chrome aggressively discards background tabs). Surface
    // those verbatim so solveCaptcha's loop can move to the next
    // candidate instead of bubbling a confusing message to the user.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await sleep(200);
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
      siteKey,
    });
  }
}

async function requestOmniFetchFromTab(tabId, requestId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      action: 'FORWARD_OMNI_FETCH',
      requestId,
      payload,
    });
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) throw error;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await sleep(200);
    return await chrome.tabs.sendMessage(tabId, {
      action: 'FORWARD_OMNI_FETCH',
      requestId,
      payload,
    });
  }
}

/** Try to wake a discarded Flow tab so `sendMessage` can reach it.
 *  Chrome auto-discards backgrounded tabs to save memory; the tab still
 *  shows up in `chrome.tabs.query` but cross-context calls fail with
 *  "No current window" / "No tab with id". A reload re-hydrates it. */
async function reviveTabIfNeeded(tab) {
  if (!tab?.discarded) return tab;
  try {
    await chrome.tabs.reload(tab.id);
    await sleep(2500);
    const fresh = await chrome.tabs.get(tab.id);
    return fresh;
  } catch {
    return null;
  }
}

async function solveCaptcha(requestId, captchaAction) {
  const tabs = await chrome.tabs.query({ url: flowUrls });

  // No Flow tab at all — spawn one (handles "no Chrome window" via the
  // resilient helper).
  if (!tabs.length) {
    try {
      await openFlowTabResilient(false);
      await sleep(3000);
    } catch (e) {
      return { error: e.message || 'NO_FLOW_TAB' };
    }
  }

  // Try each Flow tab in turn — gracefully skip dead/discarded ones
  // instead of bubbling "No current window" up to the user. Re-query
  // because we might have just spawned a new one above.
  const candidates = await chrome.tabs.query({ url: flowUrls });
  const errors = [];
  for (const tab of candidates) {
    const live = await reviveTabIfNeeded(tab);
    if (!live) continue;
    try {
      const resp = await Promise.race([
        requestCaptchaFromTab(live.id, requestId, captchaAction),
        new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
      ]);
      return resp;
    } catch (e) {
      const msg = e?.message || '';
      errors.push(msg);
      // Tab evaporated mid-call (window closed, tab discarded again,
      // or page navigated away). Move on to the next candidate.
      if (
        msg.includes('No current window') ||
        msg.includes('No tab with id') ||
        msg.includes('Receiving end does not exist')
      ) {
        continue;
      }
      return { error: msg };
    }
  }

  // All candidates failed — last-ditch: spawn a fresh Flow tab and try
  // it once. This handles the case where every existing Flow tab was
  // in a closed window we couldn't recover from.
  try {
    await openFlowTabResilient(false);
    await sleep(3000);
    const fresh = await chrome.tabs.query({ url: flowUrls });
    const target = fresh.find((t) => !t.discarded) || fresh[0];
    if (!target) return { error: 'NO_FLOW_TAB' };
    const resp = await Promise.race([
      requestCaptchaFromTab(target.id, requestId, captchaAction),
      new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
    ]);
    return resp;
  } catch (e) {
    const msg = e?.message || (errors[0] ?? 'NO_FLOW_TAB');
    return { error: msg };
  }
}

async function forwardOmniFetchViaTab(requestId, payload) {
  const tabs = await chrome.tabs.query({ url: flowUrls });
  if (!tabs.length) {
    try {
      await openFlowTabResilient(false);
      await sleep(3000);
    } catch (e) {
      return { error: e.message || 'NO_FLOW_TAB' };
    }
  }

  const candidates = await chrome.tabs.query({ url: flowUrls });
  const errors = [];
  for (const tab of candidates) {
    const live = await reviveTabIfNeeded(tab);
    if (!live) continue;
    try {
      const resp = await Promise.race([
        requestOmniFetchFromTab(live.id, requestId, payload),
        new Promise((_, rej) => setTimeout(() => rej(new Error('OMNI_FORWARD_TIMEOUT')), 120000)),
      ]);
      return resp;
    } catch (e) {
      const msg = e?.message || '';
      errors.push(msg);
      if (
        msg.includes('No current window') ||
        msg.includes('No tab with id') ||
        msg.includes('Receiving end does not exist')
      ) {
        continue;
      }
      return { error: msg };
    }
  }

  try {
    await openFlowTabResilient(false);
    await sleep(3000);
    const fresh = await chrome.tabs.query({ url: flowUrls });
    const target = fresh.find((t) => !t.discarded) || fresh[0];
    if (!target) return { error: 'NO_FLOW_TAB' };
    return await Promise.race([
      requestOmniFetchFromTab(target.id, requestId, payload),
      new Promise((_, rej) => setTimeout(() => rej(new Error('OMNI_FORWARD_TIMEOUT')), 120000)),
    ]);
  } catch (e) {
    return { error: e?.message || (errors[0] ?? 'NO_FLOW_TAB') };
  }
}

function parseForwardedJsonResponse(rawText, label) {
  try {
    return rawText ? JSON.parse(rawText) : {};
  } catch (_) {
    throw new Error(`${label} malformed JSON response`);
  }
}

async function generateTextViaFlowTab(flowApi, requestId, contents, options, onStage) {
  const opts = options || {};
  const headers = {
    'content-type': 'text/plain;charset=UTF-8',
    'accept': '*/*',
    'origin': 'https://labs.google',
    'referer': 'https://labs.google/',
    'authorization': flowApi.bearerHeader(),
  };

  const attempt = async (requestContext) => {
    await onStage?.('captcha');
    const captchaToken = await solveCaptchaForCloud(opts.captchaAction || 'TEXT_GENERATION');
    const body = {
      model: opts.model || 'gemini-3-flash-preview',
      contents,
      recaptchaContext: {
        token: captchaToken,
        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
      },
    };
    if (opts.systemInstruction) body.systemInstruction = opts.systemInstruction;
    if (opts.thinkingConfig) body.thinkingConfig = opts.thinkingConfig;
    if (requestContext) body.requestContext = requestContext;

    await onStage?.('fetch');
    const forwarded = await forwardOmniFetchViaTab(`${requestId}-textgen-${Date.now()}`, {
      url: 'https://aisandbox-pa.googleapis.com/v1/flow:generateContent',
      method: 'POST',
      headers,
      body,
    });
    if (forwarded?.error) throw new Error(forwarded.error);

    const status = Number(forwarded?.status || 0);
    await onStage?.('parse');
    const data = parseForwardedJsonResponse(forwarded?.text || '', 'generateContent');
    if (!(status >= 200 && status < 300)) {
      const detail = typeof data?.error?.message === 'string'
        ? data.error.message
        : typeof data?.detail === 'string'
          ? data.detail
          : '';
      throw new Error(detail ? `generateContent HTTP ${status}: ${detail}` : `generateContent HTTP ${status}`);
    }
    return {
      raw: data,
      text: FlowboardFlowApiUtils?.extractGeneratedText
        ? FlowboardFlowApiUtils.extractGeneratedText(data)
        : '',
    };
  };

  try {
    return await attempt(opts.requestContext);
  } catch (err) {
    const msg = (err && err.message) || '';
    const sdk = resolveFlowSdkInfo();
    if (!opts.requestContext && sdk && /flowSdkInfo|requestContext|applet|INVALID_ARGUMENT|HTTP 400/i.test(msg)) {
      console.log('[Flowboard] text_gen retry with flowSdkInfo (tab path)');
      return await attempt({ flowSdkInfo: sdk });
    }
    throw err;
  }
}

globalThis.generateTextViaFlowTab = generateTextViaFlowTab;

// ─── TRPC Request Proxy ─────────────────────────────────────

async function handleTrpcRequest(msg) {
  const { id, params } = msg;
  const { url, method = 'POST', headers = {}, body } = params;

  // Tightly scoped to TRPC endpoints — prevents the agent from navigating to
  // arbitrary labs.google paths (e.g. /fx/api/trpc/account.deleteAccount would
  // also match /fx/api/trpc/ but account-level mutations should be gated server
  // side if they're ever needed).
  if (!url || !url.startsWith('https://labs.google/fx/api/trpc/')) {
    sendToAgent({ id, error: 'INVALID_TRPC_URL' });
    return;
  }

  setState('running');
  // TRPC calls are silent — don't add to request log, don't bump metrics

  const fetchHeaders = { 'Content-Type': 'application/json', ...headers };
  if (flowKey) {
    fetchHeaders['authorization'] = `Bearer ${flowKey}`;
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body:    body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const data = await resp.json();
    sendToAgent({ id, status: resp.status, data });
  } catch (e) {
    console.error('[Flowboard] tRPC request failed:', e);
    sendToAgent({ id, error: e.message || 'TRPC_FETCH_FAILED' });
  } finally {
    setState('idle');
  }
}

// ─── State & Badge ──────────────────────────────────────────

function setState(newState) {
  state = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors  = { idle: '#22c55e', running: '#f5b301', off: '#6b7280' };
  chrome.action.setBadgeText({ text: badges[newState] || '' });
  chrome.action.setBadgeBackgroundColor({ color: colors[newState] || '#000' });
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => {});
}

// ─── Popup Message Handlers ─────────────────────────────────


// --- Cloud Worker Mode -----------------------------------------------------

function formatWorkerError(error, fallback) {
  const stage = error?.stage ? `[${error.stage}] ` : '';
  const detail = error?.detail ? `: ${String(error.detail).slice(0, 220)}` : '';
  const message = error?.message || fallback || 'WORKER_ERROR';
  return `${stage}${sanitizeWorkerError(`${message}${detail}`)}`.slice(0, 300);
}

function sanitizeWorkerError(value) {
  return String(value || '')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, 'ya29.[redacted]')
    .replace(/([?&](?:X-Amz-|GoogleAccessId|Expires|Signature|Policy|Key-Pair-Id)[^\s]*)/gi, '?[signed-url-redacted]')
    .replace(/https:\/\/[^\s]+\?(?:X-Amz-|GoogleAccessId|Expires|Signature|Policy|Key-Pair-Id)[^\s]*/gi, '[signed-url-redacted]');
}

function stageError(stage, error, fallback) {
  if (error?.stage) return error;
  const wrapped = new Error(sanitizeWorkerError(error?.message || fallback || 'Stage failed'));
  wrapped.name = 'FlowboardStageError';
  wrapped.stage = stage;
  wrapped.cause = error || null;
  if (error?.detail) wrapped.detail = sanitizeWorkerError(error.detail);
  return wrapped;
}

async function withStage(stage, work, fallback) {
  try {
    return await work();
  } catch (error) {
    throw stageError(stage, error, fallback);
  }
}
function startCloudWorkerLoop() {
  if (cloudConfig?.mode !== 'cloud-worker') return;
  setState('idle');
  cloudNoJobStreak = 0;
  scheduleCloudPoll(2);
}

function scheduleCloudPoll(delaySeconds) {
  if (cloudConfig?.mode !== 'cloud-worker' || manualDisconnect) {
    chrome.alarms.clear('cloudPoll');
    return;
  }
  const seconds = Math.max(2, Math.min(300, Number(delaySeconds) || 300));
  chrome.alarms.create('cloudPoll', { delayInMinutes: seconds / 60 });
}

function nextCloudPollDelaySeconds() {
  if (Date.now() < cloudFastPollUntil) return CLOUD_FAST_POLL_SECONDS;
  const index = Math.min(Math.max(cloudNoJobStreak - 1, 0), CLOUD_IDLE_BACKOFF_SECONDS.length - 1);
  return CLOUD_IDLE_BACKOFF_SECONDS[index];
}

function nudgeCloudWorker(reason) {
  if (cloudConfig?.mode !== 'cloud-worker' || manualDisconnect) return false;
  cloudFastPollUntil = Date.now() + CLOUD_FAST_POLL_WINDOW_MS;
  cloudNoJobStreak = 0;
  scheduleCloudPoll(2);
  console.log(`[Flowboard] Cloud worker nudged${reason ? ` (${reason})` : ''}`);
  return true;
}

async function pollCloudWorkerOnce() {
  if (cloudConfig?.mode !== 'cloud-worker' || manualDisconnect) return;
  if (cloudWorkerBusy) {
    scheduleCloudPoll(15);
    return;
  }
  cloudWorkerBusy = true;
  cloudWorkerLastPollAt = Date.now();
  let hadJob = false;
  try {
    const cloud = new FlowboardCloudClient({
      baseUrl: cloudConfig.controlPlaneBaseUrl,
      clientId: cloudConfig.clientId,
      pairingSecret: cloudConfig.pairingSecret,
      timeoutMs: cloudConfig.timeoutMs || 15000,
    });
    let job = null;
    try {
      job = await withStage(
        'ERR_STAGE_CLAIM',
        () => cloud.claim(cloudConfig.provider || 'flow', cloudConfig.leaseDurationSec || 60),
        'Claim request failed'
      );
    } catch (error) {
      if (error?.name === 'FlowboardNoJobError') {
        cloudNoJobStreak++;
        return;
      }
      throw error;
    }
    if (job?.id) {
      hadJob = true;
      cloudNoJobStreak = 0;
      await runCloudFlowJob(cloud, job);
    }
  } catch (error) {
    cloudNoJobStreak = Math.min(cloudNoJobStreak + 1, CLOUD_IDLE_BACKOFF_SECONDS.length - 1);
    metrics.lastError = formatWorkerError(error, 'CLOUD_WORKER_ERROR');
    chrome.storage.local.set({ metrics });
  } finally {
    cloudWorkerBusy = false;
    if (cloudConfig?.mode === 'cloud-worker') setState('idle');
    scheduleCloudPoll(hadJob ? CLOUD_FAST_POLL_SECONDS : nextCloudPollDelaySeconds());
  }
}

async function solveCaptchaForCloud(action) {
  const requestId = `cloud-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result = await solveCaptcha(requestId, action);
  if (result?.token) return result.token;
  throw new Error(result?.error || 'CAPTCHA_FAILED');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMediaBytesWithRetry(url, attempts = 5) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await FlowboardAssetUtils.fetchMediaBytes(url);
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await delay(1500 * (i + 1));
    }
  }
  throw lastError || new Error('Media download failed');
}

function normalizeVideoUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return trimmed;
}

function walkObjects(value, visit, seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return;
  seen.add(value);
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit, seen, depth + 1);
    return;
  }
  for (const child of Object.values(value)) {
    walkObjects(child, visit, seen, depth + 1);
  }
}

function extractMediaNameToken(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\/(?:video|image|media)\/([a-zA-Z0-9\-_]+)/i);
  if (match) return match[1];
  return /^(?:video|image|media)[-_][a-zA-Z0-9\-_]+$/i.test(trimmed) ? trimmed : null;
}

function normalizeFlowMediaId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^(?:video|image|media)\//i, '') || null;
}

function extractSubmitVideoMediaIds(value) {
  const media = Array.isArray(value?.media) ? value.media : [];
  const ids = [];
  for (const entry of media) {
    if (!entry || typeof entry !== 'object') continue;
    const direct = normalizeFlowMediaId(entry.name);
    if (direct) {
      ids.push(direct);
      continue;
    }
    const nested =
      normalizeFlowMediaId(entry.mediaId)
      || normalizeFlowMediaId(entry.media_id)
      || normalizeFlowMediaId(entry.primaryMediaId)
      || normalizeFlowMediaId(entry.primary_media_id);
    if (nested) ids.push(nested);
  }
  return ids;
}

function extractVideoArtifact(value) {
  let best = null;
  walkObjects(value, (candidate) => {
    let encodedVideo = typeof candidate.encodedVideo === 'string' && candidate.encodedVideo ? candidate.encodedVideo : null;
    if (!encodedVideo) {
      for (const [key, rawValue] of Object.entries(candidate)) {
        if (typeof rawValue !== 'string' || !rawValue) continue;
        if (!/(encoded|base64|bytes|payload|blob|video)/i.test(key)) continue;
        if (/^[A-Za-z0-9+/=\r\n]+$/.test(rawValue) && rawValue.replace(/\s+/g, '').length > 128) {
          encodedVideo = rawValue.replace(/\s+/g, '');
          break;
        }
      }
    }

    let url = normalizeVideoUrl(
      candidate.fifeUrl || candidate.servingBaseUri || candidate.servingUrl || candidate.url || candidate.downloadUrl || candidate.playbackUrl || candidate.signedUrl || candidate.uri || candidate.contentUri || candidate.storageUri || candidate.gcsUri || null
    );
    if (!url) {
      for (const [key, rawValue] of Object.entries(candidate)) {
        if (typeof rawValue !== 'string' || !rawValue) continue;
        if (!/^https?:\/\//i.test(rawValue) && !rawValue.startsWith('//')) continue;
        if (!/(url|uri|location|download|playback|content|storage|serving)/i.test(key)) continue;
        url = normalizeVideoUrl(rawValue);
        if (url) break;
      }
    }

    const explicitMediaId = candidate.primaryMediaId || candidate.primary_media_id || candidate.mediaId || candidate.media_id || null;
    const mediaId =
      normalizeFlowMediaId(explicitMediaId)
      || extractMediaNameToken(candidate.name)
      || null;
    if (!encodedVideo && !url && !mediaId) return;
    if (!best || encodedVideo || url) {
      best = { encodedVideo, url, mediaId };
    }
  });
  return best;
}

function extractOperationMediaId(value, fallbackName) {
  let mediaId = null;
  walkObjects(value, (candidate) => {
    if (mediaId) return;
    const explicit = normalizeFlowMediaId(
      candidate.primaryMediaId || candidate.primary_media_id || candidate.mediaId || candidate.media_id || null
    );
    if (explicit) {
      mediaId = explicit;
      return;
    }
    const named = extractMediaNameToken(candidate.name);
    if (named) {
      mediaId = named;
    }
  });
  if (mediaId) return mediaId;
  return extractMediaNameToken(fallbackName) || null;
}

async function resolveCompletedVideo(flowApi, source, fallbackName, fallbackMediaId) {
  const artifact = extractVideoArtifact(source);
  if (artifact && (artifact.encodedVideo || artifact.url)) {
    return {
      done: true,
      media_id: artifact.mediaId || fallbackMediaId || extractOperationMediaId(source, fallbackName),
      fifeUrl: artifact.url || null,
      encodedVideo: artifact.encodedVideo || null,
    };
  }

  const mediaId = fallbackMediaId || extractOperationMediaId(source, fallbackName);
  if (!mediaId) {
    return { done: false };
  }

  try {
    const pollRes = await flowApi.getMediaWorkflow(mediaId);
    const fromWorkflow = extractVideoArtifact(pollRes.raw?.data || pollRes.raw);
    if (fromWorkflow && (fromWorkflow.encodedVideo || fromWorkflow.url)) {
      return {
        done: true,
        media_id: fromWorkflow.mediaId || mediaId,
        fifeUrl: fromWorkflow.url || null,
        encodedVideo: fromWorkflow.encodedVideo || null,
      };
    }
  } catch (error) {
    console.warn('[Flowboard] Fallback getMediaWorkflow failed', { mediaId, error: error?.message || String(error) });
  }

  return { done: false, media_id: mediaId };
}

async function completeCloudRequestWithRetry(cloud, requestId, outputResult, assets, attempts = 5) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await cloud.complete(requestId, outputResult, assets);
    } catch (error) {
      lastError = error;
      console.warn('[Flowboard] Complete request retry', {
        requestId,
        attempt: i + 1,
        attempts,
        error: error?.message || String(error),
      });
      if (i < attempts - 1) await delay(2000 * (i + 1));
    }
  }
  throw lastError || new Error('Complete request failed');
}

async function runEditImageWithFallback(flowApi, prompt, projectId, options) {
  if (flowApi && typeof flowApi.editImage === 'function') {
    return flowApi.editImage(prompt, projectId, options);
  }

  const opts = options || {};
  const paygateTier = opts.paygateTier || flowApi?.paygateTier || 'PAYGATE_TIER_ONE';
  const ctx = clientContext(projectId, paygateTier);
  const captchaToken = await flowApi?.solveCaptcha?.(CAPTCHA_IMAGE);
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
    imageModelName: resolveImageModel(opts.imageModel || flowApi?.imageModel),
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
      'authorization': flowApi.bearerHeader(),
    },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`editImage HTTP ${resp.status}`);
  return {
    raw: data,
    mediaEntries: extractMediaEntries(data),
  };
}

function shouldPromoteSingleRefToSourceMediaId(taskType, sourceMediaId, refMediaIds, isVideoTask) {
  if (isVideoTask) return false;
  if (taskType !== 'edit_image') return false;
  if (typeof sourceMediaId === 'string' && sourceMediaId) return false;
  return Array.isArray(refMediaIds) && refMediaIds.length === 1;
}

globalThis.shouldPromoteSingleRefToSourceMediaId = shouldPromoteSingleRefToSourceMediaId;

function shouldRetryImageJobWithFreshProject(error, taskType, rawSourceMediaId, rawRefMediaIds) {
  const message = String(error?.message || error || '');
  if (!/Image HTTP 500/i.test(message)) return false;
  if (taskType !== 'txt2img' && taskType !== 'edit_image') return false;
  if (typeof rawSourceMediaId === 'string' && /^https?:\/\//i.test(rawSourceMediaId)) return true;
  return Array.isArray(rawRefMediaIds) && rawRefMediaIds.some((ref) => typeof ref === 'string' && /^https?:\/\//i.test(ref));
}

globalThis.shouldRetryImageJobWithFreshProject = shouldRetryImageJobWithFreshProject;

async function runCloudFlowJob(cloud, job) {
  const requestId = job.id;
  const userId = job.user_id;
  const inputData = job?.input_data && typeof job.input_data === 'object' ? job.input_data : {};
  const prompt = inputData.prompt;
  const sourceMediaIdForLog = inputData.source_media_id || inputData.sourceMediaId || null;
  const hasSource = !!sourceMediaIdForLog;
  const taskType = job.task_type || 'unknown';
  const variantCountLog = inputData.variant_count || 1;

  // Safe debug log (no secrets, no full prompts)
  console.log('[Flowboard][cloud-worker]', {
    requestId: String(requestId).slice(0, 12),
    task_type: taskType,
    hasSourceMediaId: hasSource,
    branch: (taskType === 'edit_image' || hasSource) ? 'editImage' : 'generateImage',
    variantCount: variantCountLog,
  });

  let heartbeat = null;
  try {
    if (!userId) throw new Error('Claimed job missing user_id');
    if (typeof prompt !== 'string') throw new Error('Missing prompt in claimed job');
    if (taskType !== 'text_gen' && !prompt.trim()) throw new Error('Missing prompt in claimed job');
    if (taskType === 'text_gen' && !prompt.trim() && (!inputData.attachments || !inputData.attachments.length)) {
      throw new Error('Missing prompt or attachments in claimed job');
    }
    if (!flowKey) throw new Error('Missing Google Flow bearer token');

    setState('running');
    metrics.requestCount++;
    try {
      await cloud.progress(requestId, 'preparing', 10);
    } catch (error) {
      throw new Error('progress/preparing failed: ' + formatWorkerError(error));
    }
    const leaseDurationSec = Math.max(cloudConfig?.leaseDurationSec || 180, CLOUD_HEARTBEAT_SECONDS * 3);
    heartbeat = setInterval(() => cloud.heartbeat(requestId, leaseDurationSec).catch(() => {}), CLOUD_HEARTBEAT_SECONDS * 1000);

    const flowApi = new FlowboardFlowApi({
      getBearerToken: () => flowKey,
      solveCaptcha: solveCaptchaForCloud,
      paygateTier: inputData.paygate_tier || cloudConfig?.paygateTier || 'PAYGATE_TIER_ONE',
      imageModel: inputData.image_model || cloudConfig?.imageModel || null,
    });
    try {
      await cloud.progress(requestId, 'submitting', 30);
    } catch (error) {
      throw new Error('progress/submitting failed: ' + formatWorkerError(error));
    }

    // text_gen: pure text/multimodal generation via flow:generateContent.
    // Needs no Flow project and no R2 uploads, so it branches early (before
    // project creation / ref-media resolution) and completes with the
    // extracted text plus an empty assets array. See design 2b.
    if (taskType === 'text_gen') {
      const sysText = typeof inputData.system_prompt === 'string' && inputData.system_prompt
        ? inputData.system_prompt : null;
      const contents = buildTextGenContents(inputData);
      const options = {
        model: inputData.model || cloudConfig?.textModel || undefined,
        captchaAction: inputData.captcha_action || undefined,
      };
      if (sysText) options.systemInstruction = { parts: [{ text: sysText }] };
      const textGenStageProgress = async (stage) => {
        const mapping = {
          captcha: ['text_captcha', 40],
          fetch: ['text_fetch', 55],
          parse: ['text_parse', 70],
        };
        const pair = mapping[stage];
        if (!pair) return;
        await cloud.progress(requestId, pair[0], pair[1]).catch(() => {});
      };

      // 3-tier flowSdkInfo fallback chain (design 6c):
      //  Tier 1 — first attempt WITHOUT requestContext (preserves Req 1.6).
      //  Tier 2/3 — if the failure indicates flowSdkInfo is required, retry once
      //  with the resolved value (observed → cloudConfig seed → default seed).
      //  If the retry also fails (or no flowSdkInfo is available), the original
      //  error propagates to the existing catch → cloud.fail.
      const runGenerate = () => generateTextViaFlowTab(flowApi, requestId, contents, options, textGenStageProgress);

      const result = await withStage(
        'ERR_STAGE_GENERATE',
        runGenerate,
        'Google Flow text generation failed'
      );

      await withStage(
        'ERR_STAGE_COMPLETE',
        () => completeCloudRequestWithRetry(
          cloud, requestId,
          { provider: 'flow', task_type: 'text_gen', text: result.text || '' },
          []
        ),
        'Complete request failed'
      );
      metrics.successCount++;
      metrics.lastError = null;
      chrome.storage.local.set({ metrics });
      return;
    }

    let project = { projectId: inputData.project_id };
    if (typeof project.projectId !== 'string' || !project.projectId || project.projectId === 'cloud-worker') {
      project = await withStage(
        'ERR_STAGE_CREATE_PROJECT',
        () => flowApi.createProject(inputData.project_title || `flowboard-${String(requestId).slice(0, 8)}`),
        'Google Flow project creation failed'
      );
    }
    await cloud.bindProject(requestId, project.projectId).catch((error) => {
      console.warn('[Flowboard] Failed to persist Flow project id early:', error?.message || error);
    });
    const rawRefMediaIds = Array.isArray(inputData.ref_media_ids) && inputData.ref_media_ids.length > 0
      ? inputData.ref_media_ids
      : Array.isArray(inputData.source_media_ids) && inputData.source_media_ids.length > 0
        ? inputData.source_media_ids
        : Array.isArray(inputData.start_media_ids) && inputData.start_media_ids.length > 0
          ? inputData.start_media_ids
          : [];
    let refMediaIds = await withStage(
      'ERR_STAGE_GENERATE',
      () => resolveCloudRefMediaIds(flowApi, rawRefMediaIds, project.projectId),
      'Reference preparation failed'
    );

    const rawSourceMediaId = inputData.source_media_id || inputData.sourceMediaId || null;
    let sourceMediaId = rawSourceMediaId;
    console.log('[Flowboard][cloud-video-input]', {
      requestId: String(requestId).slice(0, 12),
      taskType,
      sourceMediaId,
      startMediaId: inputData.start_media_id || null,
      startMediaIds: Array.isArray(inputData.start_media_ids) ? inputData.start_media_ids : null,
      refMediaCount: Array.isArray(inputData.ref_media_ids) ? inputData.ref_media_ids.length : 0,
    });
    if (typeof sourceMediaId === 'string' && /^https?:\/\//i.test(sourceMediaId)) {
      const resolvedBaseIds = await withStage(
        'ERR_STAGE_GENERATE',
        () => resolveCloudRefMediaIds(flowApi, [sourceMediaId], project.projectId),
        'Base image preparation failed'
      );
      sourceMediaId = resolvedBaseIds[0] || null;
    }

    let generated;
    const isVideoTask = taskType === 'img2vid' || taskType === 'txt2vid_omni';
  if (shouldPromoteSingleRefToSourceMediaId(taskType, sourceMediaId, refMediaIds, isVideoTask)) {
    sourceMediaId = refMediaIds[0];
    refMediaIds = [];
    console.log('[Flowboard][cloud-worker] promoted single ref to source_media_id', {
      requestId: String(requestId).slice(0, 12),
      taskType,
        sourceMediaId,
      });
    }
    const isEditTask = !isVideoTask && (job.task_type === 'edit_image' || !!sourceMediaId);

    if (isVideoTask) {
      if (taskType === 'img2vid') {
        let startMediaIds = [];
        if (Array.isArray(inputData.start_media_ids) && inputData.start_media_ids.length > 0) {
          startMediaIds = inputData.start_media_ids;
        } else if (inputData.start_media_id) {
          startMediaIds = [inputData.start_media_id];
        }
        if (startMediaIds.length > 0) {
          startMediaIds = await withStage(
            'ERR_STAGE_GENERATE',
            () => resolveCloudRefMediaIds(flowApi, startMediaIds, project.projectId),
            'Base video images preparation failed'
          );
        } else {
          throw stageError('ERR_STAGE_GENERATE', new Error('Missing start_media_id/start_media_ids for img2vid'));
        }
        generated = await withStage(
          'ERR_STAGE_GENERATE',
          () => flowApi.generateVideo(prompt, project.projectId, {
            paygateTier: inputData.paygate_tier || cloudConfig?.paygateTier || 'PAYGATE_TIER_ONE',
            aspectRatio: inputData.aspect_ratio || 'VIDEO_ASPECT_RATIO_LANDSCAPE',
            videoQuality: inputData.video_quality || 'fast',
            startMediaIds,
            prompts: Array.isArray(inputData.prompts) ? inputData.prompts : undefined,
          }),
          'Google Flow video generation failed'
        );
      } else {
        // txt2vid_omni
        // Batch fan-out: when an image list feeds the node (start_media_ids),
        // resolve each source to a project-local media id (order preserved)
        // and forward them + per-variant prompts so Omni emits one video per
        // source — symmetric with the img2vid (Veo) branch above. Without a
        // batch this falls back to a single clip conditioned on refMediaIds.
        let omniStartMediaIds = [];
        if (Array.isArray(inputData.start_media_ids) && inputData.start_media_ids.length > 0) {
          omniStartMediaIds = await withStage(
            'ERR_STAGE_GENERATE',
            () => resolveCloudRefMediaIds(flowApi, inputData.start_media_ids, project.projectId),
            'Base video images preparation failed'
          );
        }
        generated = await withStage(
          'ERR_STAGE_GENERATE',
          () => flowApi.generateVideoOmni(prompt, project.projectId, {
            paygateTier: inputData.paygate_tier || cloudConfig?.paygateTier || 'PAYGATE_TIER_ONE',
            aspectRatio: inputData.aspect_ratio || 'VIDEO_ASPECT_RATIO_PORTRAIT',
            duration_s: inputData.duration_s || 4,
            refMediaIds,
            startMediaIds: omniStartMediaIds.length > 0 ? omniStartMediaIds : undefined,
            prompts: Array.isArray(inputData.prompts) ? inputData.prompts : undefined,
          }),
          'Google Flow omni video generation failed'
        );
      }

      const rawData = generated.raw?.data || generated.raw;
      const submitVideoMediaIds = extractSubmitVideoMediaIds(rawData);
      let workflows = [];
      let opNames = [];
      if (Array.isArray(rawData.workflows)) {
        workflows = rawData.workflows.map((wf, idx) => ({
          name: wf.name,
          primary_media_id:
            normalizeFlowMediaId(wf.metadata?.primaryMediaId || wf.primary_media_id || wf.primaryMediaId || null)
            || submitVideoMediaIds[idx]
            || null,
        })).filter(wf => wf.name && wf.primary_media_id);
        opNames = workflows.map(wf => wf.name);
      } else if (Array.isArray(rawData.operations)) {
        opNames = rawData.operations.map(op => op.name || op.operation?.name).filter(Boolean);
      }
      const opFallbackMediaIds = opNames.map((_, idx) => submitVideoMediaIds[idx] || null);
      
      if (opNames.length === 0) {
        throw stageError('ERR_STAGE_GENERATE', new Error('Flow API returned no operation names or workflows'));
      }

      await cloud.progress(requestId, 'waiting_provider', 50);

      
      let pollAttempts = 60; // up to 10 mins
      let finalOps = [];
      let finishedCount = 0;
      
      while (pollAttempts > 0) {
        await cloud.heartbeat(requestId, leaseDurationSec).catch(() => {});
        
        if (workflows.length > 0) {
          const currentOps = [];
          for (const wf of workflows) {
            try {
              const pollRes = wf.primary_media_id
                ? await flowApi.getMediaWorkflow(wf.primary_media_id)
                : { raw: wf };
              console.log('[Flowboard] getMediaWorkflow raw response:', JSON.stringify(pollRes));
              const wData = pollRes.raw?.data || pollRes.raw;
              const resolvedVideo = await resolveCompletedVideo(flowApi, wData, wf.name, wf.primary_media_id);
              if (resolvedVideo.done) {
                currentOps.push({
                  name: wf.name,
                  done: true,
                  media_id: resolvedVideo.media_id || wf.primary_media_id,
                  fifeUrl: resolvedVideo.fifeUrl || null,
                  encodedVideo: resolvedVideo.encodedVideo || null,
                });
              } else {
                currentOps.push({ name: wf.name, done: false, media_id: resolvedVideo.media_id || wf.primary_media_id || null });
              }
            } catch (e) {
              console.warn(`[Flowboard] Failed to check workflow ${wf.name}`, e);
              currentOps.push({ name: wf.name, done: false });
            }
          }
          finalOps = currentOps;
          finishedCount = finalOps.filter(o => o.done).length;
        } else {
          const pollRes = await flowApi.checkVideoOperations(opNames, project.projectId);
          console.log('[Flowboard] checkVideoOperations raw response:', JSON.stringify(pollRes));
          const pData = pollRes.raw?.data || pollRes.raw;
          const operations = Array.isArray(pData.operations) ? pData.operations : [];
          
          const currentOps = [];
          for (const opReqName of opNames) {
            const found = operations.find(o => (o.name === opReqName || o.operation?.name === opReqName));
            if (found) {
              const inner = found.operation || found;
              const isDone = found.status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' || inner.done === true;
              const isFailed = found.status === 'MEDIA_GENERATION_STATUS_FAILED' || inner.error;
              
              if (isFailed) {
                const errMsg = inner.error?.message || 'MEDIA_GENERATION_STATUS_FAILED';
                throw stageError('ERR_STAGE_GENERATE', new Error(`Video generation operation failed: ${errMsg}`));
              }
              
              if (isDone) {
                const opIndex = opNames.indexOf(opReqName);
                const fallbackMediaId =
                  extractOperationMediaId(found, opReqName)
                  || (opIndex >= 0 ? opFallbackMediaIds[opIndex] : null);
                const resolvedVideo = await resolveCompletedVideo(flowApi, found, opReqName, fallbackMediaId);
                if (resolvedVideo.done) {
                  currentOps.push({
                    name: opReqName,
                    done: true,
                    media_id: resolvedVideo.media_id || fallbackMediaId || opReqName,
                    fifeUrl: resolvedVideo.fifeUrl || null,
                    encodedVideo: resolvedVideo.encodedVideo || null,
                  });
                } else {
                  currentOps.push({ name: opReqName, done: false, media_id: resolvedVideo.media_id || fallbackMediaId || null });
                }
              } else {
                const opIndex = opNames.indexOf(opReqName);
                currentOps.push({
                  name: opReqName,
                  done: false,
                  media_id: opIndex >= 0 ? opFallbackMediaIds[opIndex] : null,
                });
              }
            } else {
              const opIndex = opNames.indexOf(opReqName);
              currentOps.push({
                name: opReqName,
                done: false,
                media_id: opIndex >= 0 ? opFallbackMediaIds[opIndex] : null,
              });
            }
          }
          finalOps = currentOps;
          finishedCount = finalOps.filter(o => o.done).length;
        }
        
        if (finishedCount === opNames.length) {
          break;
        }
        
        pollAttempts--;
        if (pollAttempts > 0) {
          await delay(10000);
        }
      }
      
      if (finishedCount < opNames.length) {
        throw stageError('ERR_STAGE_GENERATE', new Error('Video generation timed out'));
      }

      try {
        await cloud.progress(requestId, 'uploading', 85);
      } catch (error) {
        throw new Error('progress/uploading failed: ' + formatWorkerError(error));
      }

      const assets = [];
      const mediaUrls = [];
      const mediaIds = [];
      const videoDiagnostics = [];

      for (let i = 0; i < finalOps.length; i++) {
        const op = finalOps[i];
        if (op.encodedVideo) {
          try {
            const bytes = FlowboardAssetUtils.base64ToBytes(op.encodedVideo);
            const mimeType = FlowboardAssetUtils.sniffMime(bytes, 'video/mp4') || 'video/mp4';
            const checksum = await FlowboardAssetUtils.sha256Hex(bytes);
            const mediaAsset = {
              bytes,
              mimeType,
              byteSize: bytes.byteLength,
              checksum,
              extension: FlowboardAssetUtils.extensionForMime(mimeType),
            };
            const uploaded = await withStage(
              'ERR_STAGE_R2_PUT',
              () => FlowboardAssetUtils.uploadGeneratedAsset(cloud, mediaAsset, userId, requestId, i, prompt),
              'Asset upload failed'
            );
            assets.push(uploaded);
            mediaIds.push(op.media_id);
            if (op.fifeUrl) mediaUrls.push(op.fifeUrl);
          } catch (error) {
            videoDiagnostics.push(
              `slot ${i + 1}: encoded video upload failed (${error?.message || String(error)})`
            );
            console.warn('[Flowboard] Workflow video upload failed', error);
          }
        } else if (op.fifeUrl) {
          mediaUrls.push(op.fifeUrl);
          mediaIds.push(op.media_id);
          try {
            const mediaAsset = await withStage(
              'ERR_STAGE_DOWNLOAD',
              () => fetchMediaBytesWithRetry(op.fifeUrl),
              'Video download failed'
            );
            assets.push(await withStage(
              'ERR_STAGE_R2_PUT',
              () => FlowboardAssetUtils.uploadGeneratedAsset(cloud, mediaAsset, userId, requestId, i, prompt),
              'Asset upload failed'
            ));
          } catch (error) {
            videoDiagnostics.push(
              `slot ${i + 1}: url fallback upload skipped (${error?.message || String(error)})`
            );
            console.warn('[Flowboard] Video download/upload skipped', error);
          }
        } else {
          videoDiagnostics.push(
            `slot ${i + 1}: no encodedVideo or downloadable URL after poll`
          );
        }
      }

      if (!assets.length && !mediaUrls.length) {
        for (let i = 0; i < finalOps.length; i++) {
          const op = finalOps[i];
          if (!op?.media_id) continue;
          try {
            const recovered = await resolveCompletedVideo(flowApi, { mediaId: op.media_id }, op.name || `op-${i + 1}`, op.media_id);
            if (recovered?.fifeUrl) {
              mediaUrls.push(recovered.fifeUrl);
            }
            if (recovered?.encodedVideo) {
              const bytes = FlowboardAssetUtils.base64ToBytes(recovered.encodedVideo);
              const mimeType = FlowboardAssetUtils.sniffMime(bytes, 'video/mp4') || 'video/mp4';
              const checksum = await FlowboardAssetUtils.sha256Hex(bytes);
              const mediaAsset = {
                bytes,
                mimeType,
                byteSize: bytes.byteLength,
                checksum,
                extension: FlowboardAssetUtils.extensionForMime(mimeType),
              };
              assets.push(await withStage(
                'ERR_STAGE_R2_PUT',
                () => FlowboardAssetUtils.uploadGeneratedAsset(cloud, mediaAsset, userId, requestId, i, prompt),
                'Asset upload failed'
              ));
            } else if (recovered?.fifeUrl) {
              const mediaAsset = await withStage(
                'ERR_STAGE_DOWNLOAD',
                () => fetchMediaBytesWithRetry(recovered.fifeUrl),
                'Video download failed'
              );
              assets.push(await withStage(
                'ERR_STAGE_R2_PUT',
                () => FlowboardAssetUtils.uploadGeneratedAsset(cloud, mediaAsset, userId, requestId, i, prompt),
                'Asset upload failed'
              ));
            } else {
              videoDiagnostics.push(
                `slot ${i + 1}: recovery found no encodedVideo or downloadable URL`
              );
            }
            if ((recovered?.fifeUrl || recovered?.encodedVideo) && !mediaIds.includes(op.media_id)) {
              mediaIds.push(op.media_id);
            }
          } catch (error) {
            videoDiagnostics.push(
              `slot ${i + 1}: recovery failed (${error?.message || String(error)})`
            );
            console.warn('[Flowboard] Final video recovery failed', { mediaId: op.media_id, error: error?.message || String(error) });
          }
        }
      }

      if (!assets.length && !mediaUrls.length) {
        const debugSummary = videoDiagnostics.length > 0
          ? `; diagnostics: ${videoDiagnostics.join(' | ')}`
          : '';
        throw stageError(
          'ERR_STAGE_DOWNLOAD',
          new Error(`Generated videos had no downloadable URLs or raw bytes${debugSummary}`)
        );
      }

      await withStage(
        'ERR_STAGE_COMPLETE',
        () => completeCloudRequestWithRetry(cloud, requestId, {
          provider: 'flow',
          media_count: mediaUrls.length || assets.length,
          project_id: project.projectId,
          media_ids: mediaIds,
          media_urls: mediaUrls,
        }, assets),
        'Complete request failed'
      );
      metrics.successCount++;
      metrics.lastError = null;
      chrome.storage.local.set({ metrics });
    } else {
      // Pure or Edit Image Generation
      const runImageJob = (projectId, currentSourceMediaId, currentRefMediaIds) => {
        if (isEditTask) {
          if (!currentSourceMediaId || typeof currentSourceMediaId !== 'string') {
            throw stageError('ERR_STAGE_GENERATE', new Error('Missing source_media_id for edit_image / variant task'));
          }
          return runEditImageWithFallback(flowApi, prompt, projectId, {
            paygateTier: inputData.paygate_tier || cloudConfig?.paygateTier || 'PAYGATE_TIER_ONE',
            imageModel: inputData.image_model || cloudConfig?.imageModel || null,
            aspectRatio: inputData.aspect_ratio || 'IMAGE_ASPECT_RATIO_LANDSCAPE',
            variantCount: inputData.variant_count || 1,
            prompts: Array.isArray(inputData.prompts) ? inputData.prompts : undefined,
            sourceMediaId: currentSourceMediaId,
            refMediaIds: currentRefMediaIds,
          });
        }
        return flowApi.generateImage(prompt, projectId, {
          paygateTier: inputData.paygate_tier || cloudConfig?.paygateTier || 'PAYGATE_TIER_ONE',
          imageModel: inputData.image_model || cloudConfig?.imageModel || null,
          aspectRatio: inputData.aspect_ratio || 'IMAGE_ASPECT_RATIO_LANDSCAPE',
          variantCount: inputData.variant_count || 1,
          prompts: Array.isArray(inputData.prompts) ? inputData.prompts : undefined,
          refMediaIds: currentRefMediaIds,
        });
      };

      try {
        generated = await withStage(
          'ERR_STAGE_GENERATE',
          () => runImageJob(project.projectId, sourceMediaId, refMediaIds),
          isEditTask ? 'Google Flow edit/image generation failed' : 'Google Flow generation failed'
        );
      } catch (error) {
        if (!shouldRetryImageJobWithFreshProject(error, taskType, rawSourceMediaId, rawRefMediaIds)) {
          throw error;
        }
        console.warn('[Flowboard][cloud-worker] retrying image job with fresh project after provider 500', {
          requestId: String(requestId).slice(0, 12),
          taskType,
          previousProjectId: project.projectId,
        });
        project = await withStage(
          'ERR_STAGE_CREATE_PROJECT',
          () => flowApi.createProject(inputData.project_title || `flowboard-${String(requestId).slice(0, 8)}-retry`),
          'Google Flow project recreation failed'
        );
        await cloud.bindProject(requestId, project.projectId).catch((bindError) => {
          console.warn('[Flowboard] Failed to persist retried Flow project id:', bindError?.message || bindError);
        });
        refMediaIds = await withStage(
          'ERR_STAGE_GENERATE',
          () => resolveCloudRefMediaIds(flowApi, rawRefMediaIds, project.projectId),
          'Reference preparation failed'
        );
        let retriedSourceMediaId = rawSourceMediaId;
        if (typeof retriedSourceMediaId === 'string' && /^https?:\/\//i.test(retriedSourceMediaId)) {
          const resolvedBaseIds = await withStage(
            'ERR_STAGE_GENERATE',
            () => resolveCloudRefMediaIds(flowApi, [retriedSourceMediaId], project.projectId),
            'Base image preparation failed'
          );
          retriedSourceMediaId = resolvedBaseIds[0] || null;
        }
        if (shouldPromoteSingleRefToSourceMediaId(taskType, retriedSourceMediaId, refMediaIds, isVideoTask)) {
          retriedSourceMediaId = refMediaIds[0];
          refMediaIds = [];
        }
        sourceMediaId = retriedSourceMediaId;
        generated = await withStage(
          'ERR_STAGE_GENERATE',
          () => runImageJob(project.projectId, sourceMediaId, refMediaIds),
          isEditTask ? 'Google Flow edit/image generation failed' : 'Google Flow generation failed'
        );
      }
      const entries = generated.mediaEntries || [];
      if (!entries.length) throw stageError('ERR_STAGE_GENERATE', new Error('Flow API returned no media entries'));
      try {
        await cloud.progress(requestId, 'uploading', 80);
      } catch (error) {
        throw new Error('progress/uploading failed: ' + formatWorkerError(error));
      }
      const assets = [];
      const mediaUrls = entries.map((entry) => entry.url).filter(Boolean);
      for (let i = 0; i < entries.length; i++) {
        if (!entries[i]?.url) {
          console.warn('[Flowboard] Media entry has no fifeUrl; completing with media id only', { requestId, index: i });
          continue;
        }
        try {
          const mediaAsset = await withStage(
            'ERR_STAGE_DOWNLOAD',
            () => fetchMediaBytesWithRetry(entries[i].url),
            'Media download failed'
          );
          assets.push(await withStage(
            'ERR_STAGE_R2_PUT',
            () => FlowboardAssetUtils.uploadGeneratedAsset(cloud, mediaAsset, userId, requestId, i, prompt),
            'Asset upload failed'
          ));
        } catch (error) {
          console.warn('[Flowboard] Generated media upload skipped; falling back to Flow media URL', {
            requestId,
            index: i,
            error: error?.message || String(error),
          });
        }
      }
      if (!assets.length && !mediaUrls.length) {
        throw stageError('ERR_STAGE_DOWNLOAD', new Error('Generated media had no downloadable URLs'));
      }
      await withStage(
        'ERR_STAGE_COMPLETE',
        () => completeCloudRequestWithRetry(cloud, requestId, {
          provider: 'flow',
          media_count: mediaUrls.length || assets.length,
          project_id: project.projectId,
          media_ids: entries.map((entry) => entry.media_id).filter(Boolean),
          media_urls: mediaUrls,
        }, assets),
        'Complete request failed'
      );
      metrics.successCount++;
      metrics.lastError = null;
      chrome.storage.local.set({ metrics });
    }
  } catch (error) {
    await cloud.fail(requestId, error?.message || 'Flow cloud worker failed').catch(() => {});
    metrics.failedCount++;
    metrics.lastError = formatWorkerError(error, 'FLOW_CLOUD_JOB_FAILED');
    chrome.storage.local.set({ metrics });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

async function resolveCloudRefMediaIds(flowApi, refs, projectId) {
  if (!Array.isArray(refs)) return [];

  // Resolve each ref to a project-local media id. Non-URL ids and cache
  // hits are free; only genuine URLs need a fetch + uploadImage round-trip
  // to Google Flow. Those round-trips used to run strictly sequentially, so
  // an N-image batch took N × (fetch + upload). We now run them with a
  // bounded concurrency pool (UPLOAD_CONCURRENCY) so a batch resolves in
  // roughly the time of its slowest image instead of the sum — while
  // capping parallel uploads to avoid tripping Flow's rate limits on large
  // batches. Output order is preserved by writing each result into its
  // original index, independent of completion order (critical for keeping
  // prompt[i] ↔ source[i] alignment downstream).
  const UPLOAD_CONCURRENCY = 5;
  const out = new Array(refs.length).fill(null);

  async function resolveOne(i) {
    const ref = refs[i];
    if (typeof ref !== 'string' || !ref) return;
    if (!/^https?:\/\//i.test(ref)) {
      out[i] = ref;
      return;
    }
    const cached = await getCachedProjectMediaId(projectId, ref);
    if (cached) {
      out[i] = cached;
      return;
    }
    const asset = await FlowboardAssetUtils.fetchAnyImageBytes(ref);
    const upload = await flowApi.uploadImage(
      FlowboardAssetUtils.bytesToBase64(asset.bytes),
      asset.mimeType,
      projectId,
      `reference-${i + 1}.${asset.extension}`,
    );
    await setCachedProjectMediaId(projectId, ref, upload.mediaId);
    out[i] = upload.mediaId;
  }

  // Worker-pool pattern: a shared cursor hands the next index to each of
  // up to UPLOAD_CONCURRENCY workers running concurrently.
  let cursor = 0;
  async function worker() {
    while (cursor < refs.length) {
      const i = cursor++;
      await resolveOne(i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(UPLOAD_CONCURRENCY, refs.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Drop any slots that produced no id (skipped invalid refs), preserving
  // the relative order of the survivors.
  return out.filter((m) => typeof m === 'string' && m);
}

async function getCachedProjectMediaId(projectId, ref) {
  try {
    const key = await FlowboardAssetUtils.referenceCacheKey(projectId, ref);
    const data = await chrome.storage.local.get([FLOW_PROJECT_MEDIA_CACHE_KEY]);
    const cache = data?.[FLOW_PROJECT_MEDIA_CACHE_KEY] || {};
    const entry = cache[key];
    if (entry && typeof entry.mediaId === 'string' && entry.mediaId) {
      return entry.mediaId;
    }
  } catch (error) {
    console.warn('[Flowboard] Reference media cache read failed:', error?.message || error);
  }
  return null;
}

async function setCachedProjectMediaId(projectId, ref, mediaId) {
  if (typeof mediaId !== 'string' || !mediaId) return;
  try {
    const key = await FlowboardAssetUtils.referenceCacheKey(projectId, ref);
    const data = await chrome.storage.local.get([FLOW_PROJECT_MEDIA_CACHE_KEY]);
    const cache = data?.[FLOW_PROJECT_MEDIA_CACHE_KEY] || {};
    cache[key] = {
      mediaId,
      projectId,
      ref: FlowboardAssetUtils.canonicalReferenceUrl(ref),
      updatedAt: Date.now(),
    };
    const entries = Object.entries(cache);
    if (entries.length > FLOW_PROJECT_MEDIA_CACHE_MAX) {
      entries
        .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0))
        .slice(FLOW_PROJECT_MEDIA_CACHE_MAX)
        .forEach(([oldKey]) => delete cache[oldKey]);
    }
    await chrome.storage.local.set({ [FLOW_PROJECT_MEDIA_CACHE_KEY]: cache });
  } catch (error) {
    console.warn('[Flowboard] Reference media cache write failed:', error?.message || error);
  }
}
chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'CAPTCHA_ACTION_OBSERVED') {
    const action = typeof msg.action === 'string' ? msg.action.trim() : '';
    const siteKey = typeof msg.siteKey === 'string' ? msg.siteKey.trim() : '';
    const scope = typeof msg.scope === 'string' && msg.scope ? msg.scope : 'default';
    if (action && siteKey) {
      observedCaptchaActions[scope] = {
        action,
        siteKey,
        href: typeof msg.href === 'string' ? msg.href : null,
        observedAt: typeof msg.observedAt === 'number' ? msg.observedAt : Date.now(),
      };
      chrome.storage.local.set({ observedCaptchaActions });
      console.log(`[Flowboard] Observed grecaptcha action for ${scope}: ${action} (siteKey=${siteKey})`);
      sendToAgent({
        type: 'captcha_action_observed',
        scope,
        action,
        siteKey,
        href: observedCaptchaActions[scope].href,
        observedAt: observedCaptchaActions[scope].observedAt,
      });
    }
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'FLOW_SDK_INFO_OBSERVED') {
    const appletId = typeof msg.appletId === 'string' ? msg.appletId.trim() : '';
    const appletVersionId = typeof msg.appletVersionId === 'string' ? msg.appletVersionId.trim() : '';
    const appletProjectId = typeof msg.appletProjectId === 'string' ? msg.appletProjectId.trim() : '';
    if (appletId || appletVersionId) {
      observedFlowSdkInfo = {
        appletId: appletId || null,
        appletVersionId: appletVersionId || null,
        appletProjectId: appletProjectId || null,
        href: typeof msg.href === 'string' ? msg.href : null,
        observedAt: typeof msg.observedAt === 'number' ? msg.observedAt : Date.now(),
      };
      chrome.storage.local.set({ observedFlowSdkInfo });
      console.log('[Flowboard] Observed flowSdkInfo', appletId, appletVersionId);
    }
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'STATUS') {
    reply({
      connected:       cloudConfig?.mode === 'cloud-worker' ? !manualDisconnect : ws?.readyState === WebSocket.OPEN,
      mode:            cloudConfig?.mode || 'local-bridge',
      cloudWorkerBusy,
      cloudWorkerLastPollAt,
      flowKeyPresent:  !!flowKey,
      manualDisconnect,
      tokenAge:        metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      metrics: {
        requestCount: metrics.requestCount,
        successCount: metrics.successCount,
        failedCount:  metrics.failedCount,
        lastError:    metrics.lastError,
      },
      state,
      cloudConfig:     cloudConfig || null,
    });
    return true;
  }

  if (msg.type === 'FLOWBOARD_CLAIM_NOW') {
    reply({ ok: nudgeCloudWorker('web-generate') });
    return true;
  }

  if (msg.type === 'FLOWBOARD_RUN_ASSISTANT') {
    const requestId = typeof msg.requestId === 'string' && msg.requestId
      ? msg.requestId
      : `assistant-${Date.now()}`;
    const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    (async () => {
      try {
        if (!flowKey) throw new Error('Missing Google Flow bearer token');
        const inputData = {
          prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
          system_prompt: typeof payload.systemPrompt === 'string' ? payload.systemPrompt : '',
          attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
        };
        if (!String(inputData.prompt || '').trim() && (!inputData.attachments || inputData.attachments.length === 0)) {
          throw new Error('assistant_node_missing_prompt_or_inputs');
        }
        const contents = buildTextGenContents(inputData);
        const options = {
          model: typeof payload.model === 'string' && payload.model ? payload.model : 'gemini-3-flash-preview',
          captchaAction: typeof payload.captchaAction === 'string' && payload.captchaAction ? payload.captchaAction : undefined,
        };
        if (inputData.system_prompt) {
          options.systemInstruction = { parts: [{ text: inputData.system_prompt }] };
        }
        const flowApi = new FlowboardFlowApi({
          getBearerToken: () => flowKey,
          solveCaptcha: solveCaptchaForCloud,
          paygateTier: cloudConfig?.paygateTier || 'PAYGATE_TIER_ONE',
          imageModel: cloudConfig?.imageModel || null,
        });
        const runDirectGenerate = async () => {
          try {
            return await flowApi.generateContent(contents, options);
          } catch (err) {
            const msg = (err && err.message) || '';
            const sdk = resolveFlowSdkInfo();
            if (sdk && /flowSdkInfo|requestContext|applet|INVALID_ARGUMENT|HTTP 400/i.test(msg)) {
              console.log('[Flowboard] assistant direct generateContent retry with flowSdkInfo');
              return await flowApi.generateContent(contents, {
                ...options,
                requestContext: { flowSdkInfo: sdk },
              });
            }
            throw err;
          }
        };
        const result = await runDirectGenerate();
        reply({ ok: true, text: result.text || '' });
      } catch (error) {
        reply({ ok: false, error: sanitizeWorkerError(error?.message || 'Assistant run failed') });
      }
    })();
    return true;
  }

  if (msg.type === 'DISCONNECT') {
    manualDisconnect = true;
    chrome.alarms.clear('cloudPoll');
    ws?.close();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT') {
    manualDisconnect = false;
    connectToAgent();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'GET_CONFIG') {
    reply({ cloudConfig: cloudConfig || null });
    return true;
  }

  if (msg.type === 'SET_CONFIG') {
    const next = msg.cloudConfig || {};
    cloudConfig = {
      mode: next.mode || 'cloud-worker',
      controlPlaneBaseUrl: next.controlPlaneBaseUrl || next.baseUrl || next.url || '',
      clientId: next.clientId || '',
      pairingSecret: next.pairingSecret || '',
      provider: next.provider || 'flow',
      paygateTier: next.paygateTier || 'PAYGATE_TIER_ONE',
      imageModel: next.imageModel || null,
      leaseDurationSec: Number(next.leaseDurationSec || 180),
    };
    metrics.lastError = null;
    chrome.storage.local.set({ cloudConfig, metrics }, () => {
      if (chrome.runtime.lastError) {
        reply({ error: chrome.runtime.lastError.message });
        return;
      }
      if (cloudConfig.mode === 'cloud-worker') {
        manualDisconnect = false;
        ws?.close();
        startCloudWorkerLoop();
      } else {
        connectToAgent();
      }
      broadcastStatus();
      reply({ ok: true, cloudConfig });
    });
    return true;
  }

  if (msg.type === 'CLEAR_CONFIG') {
    cloudConfig = null;
    manualDisconnect = true;
    metrics.lastError = null;
    chrome.alarms.clear('cloudPoll');
    chrome.storage.local.remove(['cloudConfig'], () => {
      chrome.storage.local.set({ metrics }, () => {
        broadcastStatus();
        reply({ ok: true });
      });
    });
    return true;
  }  if (msg.type === 'REQUEST_LOG') {
    reply({ log: requestLog });
    return true;
  }

  if (msg.type === 'OPEN_FLOW_TAB') {
    chrome.tabs.query({
      url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
    }).then(async (tabs) => {
      try {
        if (tabs.length) {
          await chrome.tabs.update(tabs[0].id, { active: true });
          reply({ ok: true, tabId: tabs[0].id });
        } else {
          // User-initiated → focus the new window so they can see it.
          const tab = await openFlowTabResilient(true);
          reply({ ok: true, tabId: tab?.id });
        }
      } catch (e) {
        reply({ error: e.message });
      }
    }).catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_TOKEN') {
    captureTokenFromFlowTab()
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  return true;
});

// Run init immediately on service worker startup to ensure state is hydrated from storage
init();

console.log('[Flowboard] Extension loaded');








