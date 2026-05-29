(function(global) {
  'use strict';

  const MAX_ASSET_BYTES = 25 * 1024 * 1024;
  const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'video/mp4']);
  const ALLOWED_MEDIA_HOSTS = new Set([
    'flow-content.google',
    'lh3.googleusercontent.com',
    'lh4.googleusercontent.com',
    'lh5.googleusercontent.com',
    'lh6.googleusercontent.com',
    'storage.googleapis.com',
  ]);
  const ALLOWED_MEDIA_HOST_SUFFIXES = [
    '.googleusercontent.com',
    '.googlevideo.com',
  ];

  class FlowboardAssetError extends Error {
    constructor(stage, message, cause) {
      super(message || 'Asset pipeline failed');
      this.name = 'FlowboardAssetError';
      this.stage = stage;
      this.cause = cause || null;
    }
  }

  function assertAllowedMediaUrl(url) {
    if (typeof url !== 'string' || !url.trim()) {
      throw new Error('Disallowed media URL');
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      throw new Error('Disallowed media URL');
    }
    const host = String(parsed.hostname || '').toLowerCase();
    const allowed = ALLOWED_MEDIA_HOSTS.has(host)
      || ALLOWED_MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
    if (!allowed) {
      throw new Error(`Disallowed media URL host: ${host || 'unknown'}`);
    }
  }

  function sniffMime(bytes, reportedMime) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (view.length >= 8 && view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47 && view[4] === 0x0d && view[5] === 0x0a && view[6] === 0x1a && view[7] === 0x0a) {
      return 'image/png';
    }
    if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) {
      return 'image/jpeg';
    }
    if (view.length >= 12 && view[4] === 0x66 && view[5] === 0x74 && view[6] === 0x79 && view[7] === 0x70) {
      return 'video/mp4';
    }
    const normalized = String(reportedMime || '').split(';')[0].trim().toLowerCase();
    return ALLOWED_MIMES.has(normalized) ? normalized : null;
  }

  function extensionForMime(mime) {
    if (mime === 'image/png') return 'png';
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'video/mp4') return 'mp4';
    throw new Error(`Unsupported MIME type: ${mime}`);
  }

  function canonicalReferenceUrl(url) {
    if (typeof url !== 'string' || !url.trim()) return '';
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      parsed.search = '';
      return `${parsed.origin}${parsed.pathname}`;
    } catch (_) {
      return url.trim();
    }
  }

  async function referenceCacheKey(projectId, ref) {
    const canonical = `${projectId || ''}\n${canonicalReferenceUrl(ref)}`;
    const bytes = new TextEncoder().encode(canonical);
    return `v1:${await sha256Hex(bytes)}`;
  }

  async function sha256Hex(bytes) {
    const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function fetchMediaBytes(url) {
    assertAllowedMediaUrl(url);
    return fetchImageBytesUnchecked(url);
  }

  async function fetchImageBytesUnchecked(url) {
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) {
      throw new Error(`Media download HTTP ${resp.status}`);
    }
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > MAX_ASSET_BYTES) {
      throw new Error(`Asset exceeds ${MAX_ASSET_BYTES} byte limit`);
    }
    const bytes = new Uint8Array(buffer);
    const mimeType = sniffMime(bytes, resp.headers.get('content-type'));
    if (!ALLOWED_MIMES.has(mimeType)) {
      throw new Error('Unsupported or unrecognised media MIME type');
    }
    const checksum = await sha256Hex(bytes);
    return {
      bytes,
      mimeType,
      byteSize: bytes.byteLength,
      checksum,
      extension: extensionForMime(mimeType),
    };
  }

  function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < view.length; i += chunk) {
      binary += String.fromCharCode(...view.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    if (typeof base64 !== 'string' || !base64) {
      throw new Error('Invalid base64 payload');
    }
    const normalized = base64.replace(/\s+/g, '');
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function uploadGeneratedAsset(cloudClient, asset, userId, requestId, index, promptSnapshot) {
    const ext = asset.extension || extensionForMime(asset.mimeType);
    const storageKey = `users/${userId}/flow/${requestId}/output-${index}.${ext}`;
    let signed = null;
    try {
      signed = await cloudClient.signUpload(storageKey, asset.mimeType, 900);
    } catch (error) {
      throw new FlowboardAssetError('ERR_STAGE_SIGN_UPLOAD', error?.message || 'Failed to sign upload URL', error);
    }
    if (!signed?.url) {
      throw new FlowboardAssetError('ERR_STAGE_SIGN_UPLOAD', 'Control Plane did not return signed upload URL');
    }
    let putResp = null;
    try {
      putResp = await fetch(signed.url, {
        method: 'PUT',
        headers: { 'Content-Type': asset.mimeType },
        body: asset.bytes,
      });
    } catch (error) {
      throw new FlowboardAssetError('ERR_STAGE_R2_PUT', error?.message || 'R2 upload failed', error);
    }
    if (!putResp.ok) {
      throw new FlowboardAssetError('ERR_STAGE_R2_PUT', `R2 upload HTTP ${putResp.status}`);
    }
    return {
      source_provider: 'flow',
      file_name: `flow_output.${ext}`,
      storage_key: storageKey,
      mime_type: asset.mimeType,
      byte_size: asset.byteSize,
      checksum: asset.checksum,
      prompt_snapshot: promptSnapshot || null,
    };
  }

  global.FlowboardAssetUtils = {
    MAX_ASSET_BYTES,
    ALLOWED_MIMES,
    fetchMediaBytes,
    fetchAnyImageBytes: fetchImageBytesUnchecked,
    bytesToBase64,
    base64ToBytes,
    sniffMime,
    sha256Hex,
    canonicalReferenceUrl,
    referenceCacheKey,
    extensionForMime,
    uploadGeneratedAsset,
    FlowboardAssetError,
  };
})(self);

