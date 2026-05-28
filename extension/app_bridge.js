/**
 * Flowboard app bridge.
 * Lets the web app wake the MV3 service worker immediately after a user queues
 * a generation request, while the extension keeps a slow idle fallback poll.
 */
(function () {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.type !== 'FLOWBOARD_CLAIM_NOW') return;
    chrome.runtime.sendMessage({ type: 'FLOWBOARD_CLAIM_NOW' }).catch(() => {});
  });
})();
