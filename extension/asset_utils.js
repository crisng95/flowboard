(function(global) {
  'use strict';

  const MAX_ASSET_BYTES = 25 * 1024 * 1024;
  const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'video/mp4']);
  const ALLOWED_MEDIA_PREFIXES = [
    'https://flow-content.google/',
    'https://lh3.googleusercontent.com/',
  ];

  function assertAllowedMediaUrl(url) {
    if (typeof url !== 'string' || !ALLOWED_MEDIA_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      throw new Error('Disallowed media URL');
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

  async function sha256Hex(bytes) {
    const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function fetchMediaBytes(url) {
    assertAllowedMediaUrl(url);
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

  async function uploadGeneratedAsset(cloudClient, asset, userId, requestId, index, promptSnapshot) {
    const ext = asset.extension || extensionForMime(asset.mimeType);
    const storageKey = `users/${userId}/flow/${requestId}/output-${index}.${ext}`;
    const signed = await cloudClient.signUpload(storageKey, asset.mimeType, 900);
    if (!signed?.url) {
      throw new Error('Control Plane did not return signed upload URL');
    }
    const putResp = await fetch(signed.url, {
      method: 'PUT',
      headers: { 'Content-Type': asset.mimeType },
      body: asset.bytes,
    });
    if (!putResp.ok) {
      throw new Error(`R2 upload HTTP ${putResp.status}`);
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
    sniffMime,
    sha256Hex,
    extensionForMime,
    uploadGeneratedAsset,
  };
})(self);
