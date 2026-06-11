/**
 * Injected into MAIN world on labs.google — has access to window.grecaptcha.
 * Used solely for reCAPTCHA solving. Media URLs come from the generation API
 * response directly (agent extracts fifeUrl from data.media[].image), so no
 * TRPC response interception is needed.
 */
const OBSERVE_EVENT = 'FLOWBOARD_GRECAPTCHA_EXECUTE_OBSERVED';
const FORWARD_FETCH_EVENT = 'FLOWBOARD_FORWARD_OMNI_FETCH';
const FORWARD_FETCH_RESULT_EVENT = 'FLOWBOARD_FORWARD_OMNI_FETCH_RESULT';
const FLOW_SDK_INFO_OBSERVE_EVENT = 'FLOWBOARD_FLOW_SDK_INFO_OBSERVED';
let extensionExecuting = false;

/**
 * Pure, tolerant field-reader for flowSdkInfo (parallels flow_api.js
 * extractGeneratedText): present → value, absent/malformed → null.
 * @param {string|object} rawBody  The outbound request body (string or object).
 * @returns {{appletId: string|null, appletVersionId: string|null, appletProjectId: string|null}|null}
 */
function extractFlowSdkInfo(rawBody) {
  let body;
  if (typeof rawBody === 'string') {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return null;
    }
  } else if (rawBody && typeof rawBody === 'object') {
    body = rawBody;
  } else {
    return null;
  }
  const sdk = body?.requestContext?.flowSdkInfo;
  const appletId = sdk?.appletId || body?.agentClientContext?.appletId || null;
  const appletVersionId = sdk?.appletVersionId || null;
  const appletProjectId = body?.appletProjectId || body?.agentClientContext?.appletProjectId || null;
  if (!appletId && !appletVersionId && !appletProjectId) {
    return null;
  }
  return { appletId, appletVersionId, appletProjectId };
}

// Passively observe outbound window.fetch calls so flowSdkInfo (appletId,
// appletVersionId, appletProjectId) can be auto-captured from the page's own
// flow:generateContent / flowAgent:* requests. Wrapped once, always forwards
// to the original fetch so the page behavior is never changed.
function ensureFetchObserved() {
  if (window.fetch.__flowboardSdkObserved) {
    return;
  }
  const originalFetch = window.fetch.bind(window);
  const wrapped = function(input, init) {
    try {
      const url = typeof input === 'string' ? input : (input?.url || '');
      if (/flow:generateContent|flowAgent:/.test(url)) {
        const info = extractFlowSdkInfo(init?.body);
        if (info) {
          window.dispatchEvent(new CustomEvent(FLOW_SDK_INFO_OBSERVE_EVENT, {
            detail: {
              ...info,
              href: window.location.href,
              observedAt: Date.now(),
            },
          }));
        }
      }
    } catch {}
    return originalFetch(input, init);
  };
  wrapped.__flowboardSdkObserved = true;
  window.fetch = wrapped;
}

function collectSiteKeysFromValue(value, found = new Set(), seen = new Set(), depth = 0) {
  if (!value || depth > 6) return found;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^6[Lc][A-Za-z0-9_-]{20,}$/.test(trimmed)) {
      found.add(trimmed);
    }
    return found;
  }
  if (typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSiteKeysFromValue(entry, found, seen, depth + 1);
    }
    return found;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && /(sitekey|site_key|render)/i.test(key)) {
      collectSiteKeysFromValue(entry, found, seen, depth + 1);
      continue;
    }
    collectSiteKeysFromValue(entry, found, seen, depth + 1);
  }
  return found;
}

function discoverSiteKey(preferredSiteKey) {
  if (typeof preferredSiteKey === 'string' && preferredSiteKey.trim()) {
    return preferredSiteKey.trim();
  }

  for (const script of document.querySelectorAll('script[src]')) {
    try {
      const src = new URL(script.src, window.location.href);
      const render = src.searchParams.get('render');
      if (render && render !== 'explicit') {
        return render;
      }
    } catch {}
  }

  const keyedElement = document.querySelector('[data-sitekey]');
  if (keyedElement) {
    const siteKey = keyedElement.getAttribute('data-sitekey');
    if (siteKey && siteKey.trim()) {
      return siteKey.trim();
    }
  }

  const discovered = Array.from(collectSiteKeysFromValue(window.___grecaptcha_cfg));
  if (discovered.length > 0) {
    return discovered[0];
  }

  return null;
}
async function ensureWrapped() {
  await waitForGrecaptcha();
  const enterprise = window.grecaptcha?.enterprise;
  if (!enterprise?.execute) {
    throw new Error('grecaptcha not available');
  }
  if (enterprise.execute.__flowboardWrapped) {
    return;
  }
  const originalExecute = enterprise.execute.bind(enterprise);
  const wrappedExecute = async function(siteKey, options) {
    const action = options?.action;
    if (!extensionExecuting && typeof action === 'string' && action) {
      window.dispatchEvent(new CustomEvent(OBSERVE_EVENT, {
        detail: {
          action,
          scope: action,
          siteKey: typeof siteKey === 'string' ? siteKey : null,
          href: window.location.href,
          observedAt: Date.now(),
        },
      }));
    }
    return await originalExecute(siteKey, options);
  };
  wrappedExecute.__flowboardWrapped = true;
  enterprise.execute = wrappedExecute;
}

window.addEventListener('GET_CAPTCHA', async ({ detail }) => {
  const { requestId, pageAction, siteKey: observedSiteKey } = detail;
  try {
    await ensureWrapped();
    const siteKey = discoverSiteKey(observedSiteKey);
    if (typeof siteKey !== 'string' || !siteKey) {
      throw new Error('missing siteKey');
    }
    extensionExecuting = true;
    console.log('[Injected Omni Action/SiteKey]:', pageAction, siteKey);
    const token = await window.grecaptcha.enterprise.execute(siteKey, {
      action: pageAction,
    });
    window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
      detail: { requestId, token },
    }));
  } catch (e) {
    window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
      detail: { requestId, error: e.message },
    }));
  } finally {
    extensionExecuting = false;
  }
});

window.addEventListener(FORWARD_FETCH_EVENT, async ({ detail }) => {
  const { requestId, payload } = detail || {};
  const controller = new AbortController();
  const timeoutMs = 60000;
  const timeoutId = setTimeout(() => controller.abort(new Error('OMNI_STREAM_TIMEOUT')), timeoutMs);
  try {
    const url = payload?.url;
    const method = payload?.method || 'POST';
    const headers = { ...(payload?.headers || {}) };
    const body = payload?.body;
    if (typeof requestId !== 'string' || !requestId) {
      throw new Error('missing requestId');
    }
    if (typeof url !== 'string' || !url) {
      throw new Error('missing url');
    }

    const response = await window.fetch(url, {
      method,
      headers,
      credentials: 'include',
      signal: controller.signal,
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    const finalFullText = await response.text();
    const errorText = response.ok ? '' : finalFullText;
    console.log('[Injected Omni HTTP Status/Error Body]:', response.status, errorText);
    window.dispatchEvent(new CustomEvent(FORWARD_FETCH_RESULT_EVENT, {
      detail: {
        requestId,
        status: response.status,
        ok: response.ok,
        text: finalFullText,
      },
    }));
  } catch (e) {
    window.dispatchEvent(new CustomEvent(FORWARD_FETCH_RESULT_EVENT, {
      detail: {
        requestId,
        error: e?.message || String(e),
      },
    }));
  } finally {
    clearTimeout(timeoutId);
  }
});

// Wrap as early as possible so we can observe the page's own execute() calls.
void ensureWrapped().catch(() => {});

// Observe the page's own outbound fetches to passively capture flowSdkInfo.
ensureFetchObserved();

function waitForGrecaptcha(timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.grecaptcha?.enterprise?.execute) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('grecaptcha not available'));
      setTimeout(check, 200);
    };
    check();
  });
}
