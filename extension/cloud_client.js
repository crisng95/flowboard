(function(global) {
  'use strict';

  const NO_JOB_STATUS = 409;

  class FlowboardCloudError extends Error {
    constructor(message, status, detail) {
      super(message);
      this.name = 'FlowboardCloudError';
      this.status = status || 0;
      this.detail = detail || message;
    }
  }

  class FlowboardNoJobError extends Error {
    constructor() {
      super('No queued job available');
      this.name = 'FlowboardNoJobError';
      this.status = NO_JOB_STATUS;
    }
  }

  function trimBaseUrl(baseUrl) {
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
      throw new FlowboardCloudError('Missing control plane base URL');
    }
    return baseUrl.replace(/\/+$/, '');
  }

  class FlowboardCloudClient {
    constructor(config) {
      const cfg = config || {};
      this.baseUrl = trimBaseUrl(cfg.baseUrl || cfg.controlPlaneBaseUrl || '');
      this.clientId = cfg.clientId || '';
      this.pairingSecret = cfg.pairingSecret || '';
      this.timeoutMs = Number(cfg.timeoutMs || 15000);
      if (!this.clientId || !this.pairingSecret) {
        throw new FlowboardCloudError('Missing extension pairing credentials');
      }
    }

    headers() {
      return {
        'Content-Type': 'application/json',
        'X-Client-Id': this.clientId,
        'X-Pairing-Secret': this.pairingSecret,
      };
    }

    async request(path, body, options) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const resp = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body || {}),
          signal: controller.signal,
        });
        let data = null;
        const text = await resp.text();
        if (text) {
          try { data = JSON.parse(text); } catch (_) { data = { detail: text }; }
        }
        if (resp.status === NO_JOB_STATUS && options?.allowNoJob) {
          throw new FlowboardNoJobError();
        }
        if (!resp.ok) {
          const detail = data?.detail || resp.statusText || 'Control Plane request failed';
          throw new FlowboardCloudError(`${path}: Control Plane HTTP ${resp.status}: ${String(detail).slice(0, 220)}`, resp.status, detail);
        }
        return data || {};
      } finally {
        clearTimeout(timeout);
      }
    }

    claim(provider, leaseDurationSec) {
      return this.request('/api/extension/claim', {
        provider: provider || 'flow',
        lease_duration_sec: leaseDurationSec || 60,
      }, { allowNoJob: true });
    }

    heartbeat(requestId, leaseDurationSec) {
      return this.request('/api/extension/heartbeat', {
        request_id: requestId,
        lease_duration_sec: leaseDurationSec || 60,
      });
    }

    progress(requestId, progressStage, progress) {
      return this.request('/api/extension/progress', {
        request_id: requestId,
        progress_stage: progressStage,
        progress,
      });
    }

    signUpload(storageKey, contentType, expiresIn) {
      return this.request('/api/extension/sign-upload', {
        storage_key: storageKey,
        content_type: contentType,
        expires_in: expiresIn || 900,
      });
    }

    complete(requestId, outputResult, assets) {
      return this.request('/api/extension/complete', {
        request_id: requestId,
        output_result: outputResult || {},
        assets: assets || [],
      });
    }

    fail(requestId, errorMessage) {
      return this.request('/api/extension/fail', {
        request_id: requestId,
        error_message: String(errorMessage || 'Extension worker failed').slice(0, 1000),
      });
    }
  }

  global.FlowboardCloudClient = FlowboardCloudClient;
  global.FlowboardCloudError = FlowboardCloudError;
  global.FlowboardNoJobError = FlowboardNoJobError;
})(self);
