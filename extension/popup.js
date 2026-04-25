/**
 * Flowboard Bridge — Popup UI
 * Polls background status every 1.5 s and renders it.
 */

let _manualDisconnect = false;

function formatTokenAge(ms) {
  if (ms === null || ms === undefined) return 'none';
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `captured ${s} s ago`;
  if (s < 3600) return `captured ${Math.floor(s / 60)} m ago`;
  return `captured ${Math.floor(s / 3600)} h ago`;
}

function render(status) {
  if (!status) return;

  _manualDisconnect = status.manualDisconnect;

  // Status dot
  const dotEl = document.getElementById('status-dot');
  if (status.manualDisconnect || !status.connected) {
    dotEl.className = 'section-value dot-offline';
    dotEl.textContent = '○ offline';
  } else if (status.state === 'running') {
    dotEl.className = 'section-value dot-running';
    dotEl.textContent = '▶ running';
  } else {
    dotEl.className = 'section-value dot-connected';
    dotEl.textContent = '● connected';
  }

  // Token
  document.getElementById('token-row').textContent =
    status.flowKeyPresent ? formatTokenAge(status.tokenAge) : 'none';

  // Stats
  const m = status.metrics || {};
  document.getElementById('stats-row').textContent =
    `${m.requestCount || 0} · ✓ ${m.successCount || 0} · ✗ ${m.failedCount || 0}`;

  // Error
  const errSection = document.getElementById('error-section');
  const errRow     = document.getElementById('error-row');
  if (m.lastError) {
    errSection.style.display = 'flex';
    errRow.textContent = m.lastError;
  } else {
    errSection.style.display = 'none';
  }

  // Toggle button
  const btn = document.getElementById('btn-toggle');
  if (status.manualDisconnect) {
    btn.textContent = 'Reconnect';
    btn.className   = 'reconnect';
  } else {
    btn.textContent = 'Disconnect';
    btn.className   = 'disconnect';
  }
}

function fetchStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS' }, (reply) => {
    if (chrome.runtime.lastError) return;
    render(reply);
  });
}

// Initial fetch + poll
fetchStatus();
setInterval(fetchStatus, 1500);

// Re-render on push from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_PUSH') fetchStatus();
});

// Buttons
document.getElementById('btn-flow-tab').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_FLOW_TAB' });
});

document.getElementById('btn-refresh').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' });
});

document.getElementById('btn-toggle').addEventListener('click', () => {
  const type = _manualDisconnect ? 'RECONNECT' : 'DISCONNECT';
  chrome.runtime.sendMessage({ type }, () => {
    if (chrome.runtime.lastError) return;
    fetchStatus();
  });
});
