/**
 * Injected into MAIN world on labs.google — has access to window.grecaptcha.
 * Used solely for reCAPTCHA solving. Media URLs come from the generation API
 * response directly (agent extracts fifeUrl from data.media[].image), so no
 * TRPC response interception is needed.
 */
const OBSERVE_EVENT = 'FLOWBOARD_GRECAPTCHA_EXECUTE_OBSERVED';
const FORWARD_FETCH_EVENT = 'FLOWBOARD_FORWARD_OMNI_FETCH';
const FORWARD_FETCH_RESULT_EVENT = 'FLOWBOARD_FORWARD_OMNI_FETCH_RESULT';
let extensionExecuting = false;

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
    if (typeof observedSiteKey !== 'string' || !observedSiteKey) {
      throw new Error('missing siteKey');
    }
    extensionExecuting = true;
    console.log('[Injected Omni Action/SiteKey]:', pageAction, observedSiteKey);
    const token = await window.grecaptcha.enterprise.execute(observedSiteKey, {
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
        console.log('[Injected Stream Raw Chunk]:', rawChunk);
        finalFullText += rawChunk;
      }
      if (done) {
        finalFullText += decoder.decode();
        break;
      }
    }
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
