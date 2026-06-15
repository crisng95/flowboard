/**
 * Flowboard app bridge.
 * Lets the web app wake the MV3 service worker immediately after a user queues
 * a generation request, while the extension keeps a slow idle fallback poll.
 *
 * Also handles SET_CONFIG so the web app can automatically push pairing
 * credentials to the extension without the user having to paste a JSON token
 * into the extension popup manually.
 */
(function () {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data || {};

    if (data.type === 'FLOWBOARD_CLAIM_NOW') {
      chrome.runtime.sendMessage({ type: 'FLOWBOARD_CLAIM_NOW' }).catch(() => {});
      return;
    }

    if (data.type === 'SET_CONFIG') {
      // Auto-pair: web app pushes cloudConfig so the extension switches to
      // cloud-worker mode without the user manually pasting the token.
      const cloudConfig = data.cloudConfig || {};
      chrome.runtime.sendMessage({ type: 'SET_CONFIG', cloudConfig }, (reply) => {
        const err = chrome.runtime.lastError;
        window.postMessage({
          type: 'SET_CONFIG_RESULT',
          ok: !err && !!reply?.ok,
          error: err?.message || reply?.error || null,
        }, '*');
      });
      return;
    }

    if (data.type !== 'FLOWBOARD_RUN_ASSISTANT') return;
    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    const payload = data.payload || {};
    chrome.runtime.sendMessage({ type: 'FLOWBOARD_RUN_ASSISTANT', requestId, payload }, (reply) => {
      const runtimeError = chrome.runtime.lastError;
      window.postMessage({
        type: 'FLOWBOARD_RUN_ASSISTANT_RESULT',
        requestId,
        ok: !runtimeError && !!reply?.ok,
        text: reply?.text || '',
        error: runtimeError?.message || reply?.error || null,
      }, '*');
    });
  });
})();
