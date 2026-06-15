/**
 * Content script — bridge between background.js and injected.js.
 * Injects injected.js into MAIN world and forwards GET_CAPTCHA messages.
 */
(function () {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

window.addEventListener('FLOWBOARD_GRECAPTCHA_EXECUTE_OBSERVED', (e) => {
  const action = e.detail?.action;
  const siteKey = e.detail?.siteKey;
  if (typeof action !== 'string' || !action) return;
  if (typeof siteKey !== 'string' || !siteKey) return;
  chrome.runtime.sendMessage({
    type: 'CAPTCHA_ACTION_OBSERVED',
    scope: action || 'default',
    action,
    siteKey,
    href: e.detail?.href || window.location.href,
    observedAt: e.detail?.observedAt || Date.now(),
  }).catch(() => {});
});

window.addEventListener('FLOWBOARD_FLOW_SDK_INFO_OBSERVED', (e) => {
  const appletId = e.detail?.appletId;
  const appletVersionId = e.detail?.appletVersionId;
  const appletProjectId = e.detail?.appletProjectId;
  // Relay even if only one id is present; background.js skips fully-empty.
  if (!appletId && !appletVersionId && !appletProjectId) return;
  chrome.runtime.sendMessage({
    type: 'FLOW_SDK_INFO_OBSERVED',
    appletId: appletId || null,
    appletVersionId: appletVersionId || null,
    appletProjectId: appletProjectId || null,
    href: e.detail?.href || window.location.href,
    observedAt: e.detail?.observedAt || Date.now(),
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'GET_CAPTCHA') {
    const { requestId, pageAction, siteKey } = msg;

    const handler = (e) => {
      if (e.detail?.requestId === requestId) {
        window.removeEventListener('CAPTCHA_RESULT', handler);
        clearTimeout(timer);
        reply({ token: e.detail.token, error: e.detail.error });
      }
    };

    const timer = setTimeout(() => {
      window.removeEventListener('CAPTCHA_RESULT', handler);
      reply({ error: 'CONTENT_TIMEOUT' });
    }, 25000);

    window.addEventListener('CAPTCHA_RESULT', handler);

    window.dispatchEvent(new CustomEvent('GET_CAPTCHA', {
      detail: { requestId, pageAction, siteKey },
    }));

    return true; // keep channel open for async reply
  }

  if (msg.action === 'FORWARD_OMNI_FETCH') {
    const requestId = msg.requestId;
    const payload = msg.payload || {};

    const handler = (e) => {
      if (e.detail?.requestId === requestId) {
        window.removeEventListener('FLOWBOARD_FORWARD_OMNI_FETCH_RESULT', handler);
        clearTimeout(timer);
        reply({
          status: e.detail.status,
          ok: e.detail.ok,
          text: e.detail.text,
          error: e.detail.error,
        });
      }
    };

    const timer = setTimeout(() => {
      window.removeEventListener('FLOWBOARD_FORWARD_OMNI_FETCH_RESULT', handler);
      reply({ error: 'CONTENT_TIMEOUT' });
    }, 120000);

    window.addEventListener('FLOWBOARD_FORWARD_OMNI_FETCH_RESULT', handler);

    window.dispatchEvent(new CustomEvent('FLOWBOARD_FORWARD_OMNI_FETCH', {
      detail: { requestId, payload },
    }));

    return true;
  }

  return undefined;
});
