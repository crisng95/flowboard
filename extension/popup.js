/**
 * Flowboard Bridge ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Popup UI Logic (v0.0.6)
 * Handles double-state UI routing, pairing tokens, synchronous user-gesture 
 * host permissions, and live dashboard synchronization.
 */

let _manualDisconnect = false;
let _settingsVisible = false;
let _manualFieldsVisible = false;

// Elements lookup
const onboardingView = document.getElementById('onboarding-view');
const dashboardView = document.getElementById('dashboard-view');
const btnSettingsToggle = document.getElementById('btn-settings-toggle');
const settingsView = document.getElementById('settings-view');
const onboardingErrorBox = document.getElementById('onboarding-error-box');

function formatTokenAge(ms) {
  if (ms === null || ms === undefined) return 'none';
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/**
 * Normalizes URL and extracts a strict Chrome host permission origin pattern.
 * e.g., "https://api.flowboard.app/v1" -> "https://api.flowboard.app/*"
 */

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}
function extractChromeOriginPattern(urlString) {
  try {
    let clean = urlString.trim();
    if (!/^https?:\/\//i.test(clean)) {
      clean = 'http://' + clean;
    }
    const parsed = new URL(clean);
    if (!parsed.hostname) {
      throw new Error('Invalid host');
    }
    // Strict origin matching with a trailing wildcard
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch (err) {
    throw new Error('Invalid URL format. Use http(s)://your-domain.com');
  }
}


function setPairButtonBusy(isBusy, label) {
  const btn = document.getElementById('btn-pair');
  if (!btn) return;
  btn.disabled = !!isBusy;
  btn.style.opacity = isBusy ? '0.65' : '';
  const text = label || 'Pair & Connect';
  btn.childNodes[0].nodeValue = text + ' ';
}
function showOnboardingError(message) {
  if (message) {
    onboardingErrorBox.textContent = message;
    onboardingErrorBox.style.display = 'block';
  } else {
    onboardingErrorBox.style.display = 'none';
  }
}

function render(status) {
  if (!status) return;

  _manualDisconnect = status.manualDisconnect;

  // Verify pairing state to switch views
  const hasCredentials = status.cloudConfig?.clientId && status.cloudConfig?.pairingSecret;
  if (!hasCredentials) {
    onboardingView.style.display = 'block';
    dashboardView.style.display = 'none';
    btnSettingsToggle.style.display = 'none';
    settingsView.style.display = 'none';
    _settingsVisible = false;
    return;
  }

  // Paired State: Show Dashboard
  onboardingView.style.display = 'none';
  dashboardView.style.display = 'block';
  btnSettingsToggle.style.display = 'flex';

  // Render status badge
  const badgeEl = document.getElementById('status-badge');
  if (status.manualDisconnect) {
    badgeEl.className = 'status-badge badge-offline';
    badgeEl.textContent = 'paused';
  } else if (!status.connected) {
    badgeEl.className = 'status-badge badge-offline';
    badgeEl.textContent = 'offline';
  } else if (status.state === 'running' || status.cloudWorkerBusy) {
    badgeEl.className = 'status-badge badge-running';
    badgeEl.textContent = 'running';
  } else {
    badgeEl.className = 'status-badge badge-connected';
    badgeEl.textContent = 'active';
  }

  // Render active mode
  const modeVal = status.mode === 'cloud-worker' ? 'Cloud Worker' : 'Local Bridge';
  document.getElementById('mode-row').textContent = modeVal;

  // Render token age
  document.getElementById('token-row').textContent =
    status.flowKeyPresent ? formatTokenAge(status.tokenAge) : 'none';

  // Render metrics stats
  const m = status.metrics || {};
  document.getElementById('stats-row').textContent = `${m.requestCount || 0} / ${m.successCount || 0} ok / ${m.failedCount || 0} fail`;

  // Error block
  const errSection = document.getElementById('error-section');
  const errRow     = document.getElementById('error-row');
  if (m.lastError) {
    errSection.style.display = 'block';
    errRow.textContent = m.lastError;
  } else {
    errSection.style.display = 'none';
  }

  // Disconnect button style
  const btn = document.getElementById('btn-toggle');
  const btnText = btn.querySelector('span');
  if (status.manualDisconnect) {
    if (btnText) btnText.textContent = 'Resume Worker';
    btn.className = 'ui-btn reconnect';
  } else {
    if (btnText) btnText.textContent = 'Pause Worker';
    btn.className = 'ui-btn disconnect';
  }
}

function fetchStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS' }, (reply) => {
    if (chrome.runtime.lastError) return;
    render(reply);
  });
}

// Collapsible Dashboard Settings
btnSettingsToggle.addEventListener('click', () => {
  _settingsVisible = !_settingsVisible;
  settingsView.style.display = _settingsVisible ? 'block' : 'none';
  if (_settingsVisible) {
    loadSettingsFromStorage();
  }
});

function loadSettingsFromStorage() {
  chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (reply) => {
    if (chrome.runtime.lastError || !reply) return;
    const cfg = reply.cloudConfig || {};
    
    document.getElementById('dash-mode').value = cfg.mode || 'cloud-worker';
    document.getElementById('dash-url').value = cfg.controlPlaneBaseUrl || '';
    document.getElementById('dash-client-id').value = cfg.clientId || '';
    document.getElementById('dash-secret').value = cfg.pairingSecret || '';
  });
}

// Advanced Manual Config Toggle
document.getElementById('btn-manual-toggle').addEventListener('click', () => {
  _manualFieldsVisible = !_manualFieldsVisible;
  const manualFields = document.getElementById('manual-config-fields');
  manualFields.style.display = _manualFieldsVisible ? 'block' : 'none';
  document.getElementById('btn-manual-toggle').textContent =
    _manualFieldsVisible ? 'Hide Manual Setup' : 'Advanced Manual Setup';
});

// Pairing Token Paste Handler (Synchronous User Gesture Host Request)
document.getElementById('btn-pair').addEventListener('click', () => {
  showOnboardingError('');
  setPairButtonBusy(true, 'Pairing...');
  const rawToken = document.getElementById('cfg-token').value.trim();
  const compactToken = rawToken.replace(/\s+/g, '');
  if (!rawToken) {
    showOnboardingError('Please paste a valid Pairing Token first');
    setPairButtonBusy(false);
    return;
  }

  let parsed = null;
  // 1. Try parsing raw JSON
  try {
    parsed = JSON.parse(rawToken);
  } catch (_) {
    // 2. Try Base64 JSON decoding
    try {
      const decoded = atob(compactToken);
      parsed = JSON.parse(decoded);
    } catch (__) {
      showOnboardingError('Invalid pairing token format. Must be a valid JSON string or Base64 JSON.');
      setPairButtonBusy(false);
      return;
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    showOnboardingError('Invalid pairing token schema.');
    setPairButtonBusy(false);
    return;
  }

  const controlPlaneBaseUrl = (parsed.controlPlaneBaseUrl || parsed.baseUrl || parsed.url || '').trim();
  const clientId = (parsed.clientId || parsed.client_id || '').trim();
  const pairingSecret = (parsed.pairingSecret || parsed.secret || '').trim();

  if (!controlPlaneBaseUrl) {
    showOnboardingError('Control Plane URL is missing in token');
    setPairButtonBusy(false);
    return;
  }
  if (!clientId || !pairingSecret) {
    showOnboardingError('Credentials (Client ID/Secret) missing in token');
    setPairButtonBusy(false);
    return;
  }

  let originPattern;
  try {
    originPattern = extractChromeOriginPattern(controlPlaneBaseUrl);
  } catch (err) {
    showOnboardingError(err.message);
    return;
  }

  // Request dynamic host permission synchronously within the click gesture
  chrome.permissions.request({
    origins: [originPattern]
  }, (granted) => {
    if (chrome.runtime.lastError) {
      showOnboardingError(chrome.runtime.lastError.message);
      return;
    }
    if (!granted) {
      showOnboardingError('Permission Denied. Dynamic host permissions are required to connect to the Control Plane.');
      return;
    }

    const cloudConfig = {
      mode: 'cloud-worker',
      controlPlaneBaseUrl,
      clientId,
      pairingSecret,
      provider: 'flow',
    };

    chrome.runtime.sendMessage({ type: 'SET_CONFIG', cloudConfig }, (reply) => {
      if (chrome.runtime.lastError || reply?.error) {
        showOnboardingError('Pairing failed: ' + (chrome.runtime.lastError?.message || reply?.error));
        return;
      }
      setPairButtonBusy(false, 'Connected');
      fetchStatus();
    });
  });
});

// Save Manual Config Handler (Synchronous User Gesture Host Request)
document.getElementById('btn-save-manual').addEventListener('click', () => {
  showOnboardingError('');
  const mode = document.getElementById('cfg-mode').value;
  const controlPlaneBaseUrl = document.getElementById('cfg-url').value.trim();
  const clientId = document.getElementById('cfg-client-id').value.trim();
  const pairingSecret = document.getElementById('cfg-secret').value.trim();

  if (!controlPlaneBaseUrl) {
    showOnboardingError('Control Plane URL is required');
    return;
  }
  if (!clientId || !pairingSecret) {
    showOnboardingError('Client ID and Pairing Secret are required');
    return;
  }

  let originPattern;
  try {
    originPattern = extractChromeOriginPattern(controlPlaneBaseUrl);
  } catch (err) {
    showOnboardingError(err.message);
    return;
  }

  // Request dynamic host permission synchronously within the click gesture
  chrome.permissions.request({
    origins: [originPattern]
  }, (granted) => {
    if (chrome.runtime.lastError) {
      showOnboardingError(chrome.runtime.lastError.message);
      return;
    }
    if (!granted) {
      showOnboardingError('Permission Denied. Dynamic host permissions are required to connect to the Control Plane.');
      return;
    }

    const cloudConfig = {
      mode,
      controlPlaneBaseUrl,
      clientId,
      pairingSecret,
      provider: 'flow',
    };

    chrome.runtime.sendMessage({ type: 'SET_CONFIG', cloudConfig }, (reply) => {
      if (chrome.runtime.lastError || reply?.error) {
        showOnboardingError('Pairing failed: ' + (chrome.runtime.lastError?.message || reply?.error));
        return;
      }
      fetchStatus();
    });
  });
});

// Dashboard settings updates (Synchronous User Gesture Host Request)
document.getElementById('btn-save-dash-settings').addEventListener('click', () => {
  const mode = document.getElementById('dash-mode').value;
  const controlPlaneBaseUrl = document.getElementById('dash-url').value.trim();
  
  if (!controlPlaneBaseUrl) {
    alert('Control Plane URL is required');
    return;
  }

  let originPattern;
  try {
    originPattern = extractChromeOriginPattern(controlPlaneBaseUrl);
  } catch (err) {
    alert(err.message);
    return;
  }

  // Request dynamic host permission synchronously within the click gesture
  chrome.permissions.request({
    origins: [originPattern]
  }, (granted) => {
    if (chrome.runtime.lastError) {
      alert(chrome.runtime.lastError.message);
      return;
    }
    if (!granted) {
      alert('Permission Denied. Cannot save settings without host domain access.');
      return;
    }

    chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (reply) => {
      if (chrome.runtime.lastError || !reply) return;
      const current = reply.cloudConfig || {};
      
      const cloudConfig = {
        ...current,
        mode,
        controlPlaneBaseUrl,
      };

      chrome.runtime.sendMessage({ type: 'SET_CONFIG', cloudConfig }, (setReply) => {
        if (chrome.runtime.lastError || setReply?.error) {
          alert('Failed to save config: ' + (chrome.runtime.lastError?.message || setReply?.error));
          return;
        }
        
        const saveBtn = document.getElementById('btn-save-dash-settings');
        const original = saveBtn.innerHTML;
        saveBtn.innerHTML = 'Saved Successfully! ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ';
        saveBtn.style.background = 'rgba(16, 185, 129, 0.2)';
        
        setTimeout(() => {
          saveBtn.innerHTML = original;
          saveBtn.style.background = '';
          _settingsVisible = false;
          settingsView.style.display = 'none';
          fetchStatus();
        }, 1200);
      });
    });
  });
});

// Unpair device handler
document.getElementById('btn-unpair-device').addEventListener('click', () => {
  if (!confirm('Are you sure you want to unpair and disconnect this device? This will wipe the credentials from memory.')) {
    return;
  }

  chrome.runtime.sendMessage({ type: 'CLEAR_CONFIG' }, () => {
    if (chrome.runtime.lastError) return;
    
    // Clear token input textarea
    document.getElementById('cfg-token').value = '';
    
    // Refresh status to transition back to Onboarding View
    fetchStatus();
  });
});

// Action button triggers
document.getElementById('btn-flow-tab').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_FLOW_TAB' });
});

document.getElementById('btn-refresh').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'REFRESH_TOKEN' });
});

document.getElementById('btn-diagnostics').addEventListener('click', () => {
  const diagView = document.getElementById('diagnostics-results-view');
  const diagLog = document.getElementById('diagnostics-log');
  
  diagView.style.display = 'block';
  diagLog.textContent = '⌛ Starting connection diagnostics...\n';

  let logs = [];
  function appendLog(line) {
    logs.push(line);
    diagLog.textContent = logs.join('\n');
  }

  chrome.runtime.sendMessage({ type: 'STATUS' }, (status) => {
    if (chrome.runtime.lastError || !status) {
      appendLog('✗ STATUS query: FAILED (' + (chrome.runtime.lastError?.message || 'No response') + ')');
      return;
    }

    const cfg = status.cloudConfig || {};
    const url = cfg.controlPlaneBaseUrl || '';

    // Step 1: Check Config
    if (url && cfg.clientId && cfg.pairingSecret) {
      appendLog('✓ Pairing Config: OK (' + cfg.clientId.slice(0, 8) + '...)');
    } else {
      appendLog('✗ Pairing Config: MISSING / INCOMPLETE');
    }

    // Step 2: Check Permissions
    if (url) {
      try {
        const origin = extractChromeOriginPattern(url);
        chrome.permissions.contains({ origins: [origin] }, (hasPerm) => {
          if (hasPerm) {
            appendLog('✓ Host Permissions: GRANTED (' + origin.replace('/*', '') + ')');
          } else {
            appendLog('✗ Host Permissions: MISSING (' + origin.replace('/*', '') + ')');
          }
          
          // Execute async reachability only after permission check completes
          testReachability();
        });
      } catch (e) {
        appendLog('✗ Host Permissions: INVALID URL (' + e.message + ')');
        testReachability();
      }
    } else {
      appendLog('✗ Host Permissions: SKIPPED (No Control Plane URL)');
      testReachability();
    }

    async function testReachability() {
      // Step 3: Test Control Plane Reachability
      if (url) {
        const start = Date.now();
        try {
          const cleanUrl = url.replace(/\/+$/, '') + '/api/health';
          const resp = await fetch(cleanUrl, { method: 'GET', credentials: 'omit' });
          const latency = Date.now() - start;
          if (resp.ok) {
            appendLog('✓ Gateway Reachability: ONLINE (' + latency + 'ms)');
          } else {
            appendLog('✗ Gateway Reachability: FAILED (HTTP ' + resp.status + ')');
          }
        } catch (err) {
          appendLog('✗ Gateway Reachability: UNREACHABLE (' + err.message + ')');
        }
      } else {
        appendLog('✗ Gateway Reachability: SKIPPED (No URL)');
      }

      // Step 4: Check Google Token
      if (status.flowKeyPresent) {
        const ageStr = formatTokenAge(status.tokenAge);
        appendLog('✓ Google Flow Token: ACTIVE (' + ageStr + ')');
      } else {
        appendLog('✗ Google Flow Token: MISSING (Open Google Flow tab to capture)');
      }

      // Step 5: Check Google Flow Tab
      chrome.tabs.query({
        url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
      }, (tabs) => {
        if (tabs && tabs.length > 0) {
          appendLog('✓ Google Flow Tab: OPEN (' + tabs.length + ' tab(s) found)');
        } else {
          appendLog('⚠ Google Flow Tab: NOT FOUND (Recommended to keep open)');
        }
        appendLog('\n🎉 Diagnostics completed!');
      });
    }
  });
});

document.getElementById('btn-toggle').addEventListener('click', () => {
  const type = _manualDisconnect ? 'RECONNECT' : 'DISCONNECT';
  chrome.runtime.sendMessage({ type }, () => {
    if (chrome.runtime.lastError) return;
    fetchStatus();
  });
});

// Initial load + live polling
fetchStatus();
setInterval(fetchStatus, 1500);

// Status Push handler
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_PUSH') fetchStatus();
});
