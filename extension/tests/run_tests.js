/**
 * Flowboard Extension Lightweight Test Runner
 * Run with: node extension/tests/run_tests.js
 */

const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');

// --- Setup Browser Mocks ---
global.self = global;
global.crypto = webcrypto;

let mockFetchHandler = null;
global.fetch = async (url, options) => {
  if (mockFetchHandler) {
    return mockFetchHandler(url, options);
  }
  throw new Error(`Unhandled mock fetch call to: ${url}`);
};

class MockResponse {
  constructor(status, bodyText, headers = {}) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.bodyText = bodyText;
    this.headers = {
      get: (name) => headers[name.toLowerCase()] || null,
    };
  }

  async text() {
    return this.bodyText;
  }

  async json() {
    return JSON.parse(this.bodyText);
  }

  async arrayBuffer() {
    const buf = Buffer.from(this.bodyText, 'utf-8');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
}

// --- Load Extension Modules ---
function loadModule(filename) {
  const filePath = path.join(__dirname, '..', filename);
  const code = fs.readFileSync(filePath, 'utf8');
  // Run inside global context
  eval(code);
}

loadModule('cloud_client.js');
loadModule('flow_api.js');
loadModule('asset_utils.js');

// --- Simple Test Framework ---
let testsRun = 0;
let testsFailed = 0;
let asyncChain = Promise.resolve();

function test(name, fn) {
  testsRun++;
  try {
    mockFetchHandler = null;
    fn();
    console.log(`[PASS] ${name}`);
  } catch (err) {
    testsFailed++;
    console.error(`[FAIL] ${name}`);
    console.error(err);
  }
}

async function testAsync(name, fn) {
  testsRun++;
  asyncChain = asyncChain.then(async () => {
    try {
      mockFetchHandler = null;
      await fn();
      console.log(`[PASS] ${name}`);
    } catch (err) {
      testsFailed++;
      console.error(`[FAIL] ${name}`);
      console.error(err);
    }
  });
}

function assert(condition, msg) {
  if (!condition) {
    throw new Error(msg || 'Assertion failed');
  }
}

function assertEquals(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'Expected equality'} | Got: ${actual}, Expected: ${expected}`);
  }
}

function assertThrows(fn, expectedErrorName) {
  try {
    fn();
  } catch (err) {
    if (expectedErrorName && err.name !== expectedErrorName) {
      throw new Error(`Expected error ${expectedErrorName} but got ${err.name} (${err.message})`);
    }
    return;
  }
  throw new Error('Expected function to throw but it succeeded');
}

async function assertThrowsAsync(fn, expectedErrorName) {
  try {
    await fn();
  } catch (err) {
    if (expectedErrorName && err.name !== expectedErrorName) {
      throw new Error(`Expected error ${expectedErrorName} but got ${err.name} (${err.message})`);
    }
    return;
  }
  throw new Error('Expected async function to throw but it succeeded');
}

// ============================================================================
// 1. TESTS FOR cloud_client.js (FlowboardCloudClient)
// ============================================================================

test('FlowboardCloudClient initialization', () => {
  const client = new global.FlowboardCloudClient({
    baseUrl: 'http://localhost:8101',
    clientId: 'client-123',
    pairingSecret: 'secret-xyz',
  });
  assertEquals(client.baseUrl, 'http://localhost:8101');
  assertEquals(client.clientId, 'client-123');
  assertEquals(client.pairingSecret, 'secret-xyz');

  // Trailing slash trimming
  const clientSlash = new global.FlowboardCloudClient({
    baseUrl: 'http://localhost:8101////',
    clientId: 'client-123',
    pairingSecret: 'secret-xyz',
  });
  assertEquals(clientSlash.baseUrl, 'http://localhost:8101');

  // Validation failures
  assertThrows(() => new global.FlowboardCloudClient({}), 'FlowboardCloudError');
  assertThrows(() => new global.FlowboardCloudClient({ baseUrl: 'http://localhost:8101' }), 'FlowboardCloudError');
});

testAsync('FlowboardCloudClient claim job success', async () => {
  const client = new global.FlowboardCloudClient({
    baseUrl: 'http://localhost:8101',
    clientId: 'client-123',
    pairingSecret: 'secret-xyz',
  });

  mockFetchHandler = async (url, options) => {
    assertEquals(url, 'http://localhost:8101/api/extension/claim');
    assertEquals(options.method, 'POST');
    assertEquals(options.headers['X-Client-Id'], 'client-123');
    assertEquals(options.headers['X-Pairing-Secret'], 'secret-xyz');
    
    const body = JSON.parse(options.body);
    assertEquals(body.provider, 'flow');
    assertEquals(body.lease_duration_sec, 60);

    return new MockResponse(200, JSON.stringify({ id: 'job-111', user_id: 'user-222', input_data: { prompt: 'a beautiful cat' } }));
  };

  const job = await client.claim('flow', 60);
  assertEquals(job.id, 'job-111');
  assertEquals(job.user_id, 'user-222');
  assertEquals(job.input_data.prompt, 'a beautiful cat');
});

testAsync('FlowboardCloudClient claim job empty (409)', async () => {
  const client = new global.FlowboardCloudClient({
    baseUrl: 'http://localhost:8101',
    clientId: 'client-123',
    pairingSecret: 'secret-xyz',
  });

  mockFetchHandler = async () => {
    return new MockResponse(409, JSON.stringify({ detail: 'No jobs available' }));
  };

  await assertThrowsAsync(async () => {
    await client.claim('flow', 60);
  }, 'FlowboardNoJobError');
});

testAsync('FlowboardCloudClient complete and fail APIs', async () => {
  const client = new global.FlowboardCloudClient({
    baseUrl: 'http://localhost:8101',
    clientId: 'client-123',
    pairingSecret: 'secret-xyz',
  });

  let completed = false;
  let failed = false;

  mockFetchHandler = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/api/extension/complete')) {
      assertEquals(body.request_id, 'job-111');
      assertEquals(body.output_result.media_count, 1);
      assertEquals(body.assets[0].file_name, 'test.png');
      completed = true;
      return new MockResponse(200, JSON.stringify({ ok: true }));
    } else if (url.endsWith('/api/extension/fail')) {
      assertEquals(body.request_id, 'job-111');
      assertEquals(body.error_message, 'Something went wrong');
      failed = true;
      return new MockResponse(200, JSON.stringify({ ok: true }));
    }
    return new MockResponse(500, 'Internal Server Error');
  };

  await client.complete('job-111', { media_count: 1 }, [{ file_name: 'test.png' }]);
  assert(completed, 'Complete API should have been called');

  await client.fail('job-111', 'Something went wrong');
  assert(failed, 'Fail API should have been called');
});


// ============================================================================
// 2. TESTS FOR flow_api.js (FlowboardFlowApi & Utils)
// ============================================================================

test('FlowboardFlowApiUtils resolveImageModel & clientContext', () => {
  const utils = global.FlowboardFlowApiUtils;
  
  // Model resolution
  assertEquals(utils.resolveImageModel('NANO_BANANA_PRO'), 'GEM_PIX_2');
  assertEquals(utils.resolveImageModel('NANO_OMNI'), 'GEM_OMNI_1');
  assertEquals(utils.resolveImageModel('NANO_BANANA_2'), 'NARWHAL');
  assertEquals(utils.resolveImageModel('INVALID'), 'GEM_PIX_2'); // Fallback

  // Client context payload
  const ctx = utils.clientContext('project-xyz', 'PAYGATE_TIER_ONE');
  assertEquals(ctx.projectId, 'project-xyz');
  assertEquals(ctx.userPaygateTier, 'PAYGATE_TIER_ONE');
  assertEquals(ctx.tool, 'PINHOLE');
  assert(ctx.sessionId.startsWith(';'), 'Session ID should start with semicolon');

  assertThrows(() => utils.clientContext('project-xyz', 'INVALID_TIER'), 'Error');
});

test('FlowboardFlowApiUtils extractProjectId', () => {
  const utils = global.FlowboardFlowApiUtils;

  // Path 1: result.data.json.project.name
  const resp1 = { result: { data: { json: { project: { name: 'proj-1' } } } } };
  assertEquals(utils.extractProjectId(resp1), 'proj-1');

  // Path 2: data.json.projectId
  const resp2 = { data: { json: { projectId: 'proj-2' } } };
  assertEquals(utils.extractProjectId(resp2), 'proj-2');

  // Path 3: json.name
  const resp3 = { json: { name: 'proj-3' } };
  assertEquals(utils.extractProjectId(resp3), 'proj-3');

  // Path 4: data.id
  const resp4 = { data: { id: 'proj-4' } };
  assertEquals(utils.extractProjectId(resp4), 'proj-4');

  // Empty cases
  assertEquals(utils.extractProjectId({}), null);
  assertEquals(utils.extractProjectId(null), null);
});

test('FlowboardFlowApiUtils extractMediaEntries', () => {
  const utils = global.FlowboardFlowApiUtils;

  const sampleResponse = {
    data: {
      media: [
        {
          name: 'media/1',
          image: {
            generatedImage: {
              fifeUrl: 'https://flow-content.google/image1.png',
            },
          },
        },
        {
          name: 'media/2',
          video: {
            generatedVideo: {
              fifeUrl: 'https://lh3.googleusercontent.com/video2.mp4',
            },
          },
        },
        {
          name: 'invalid-no-url',
        },
      ],
    },
  };

  const entries = utils.extractMediaEntries(sampleResponse);
  assertEquals(entries.length, 3);
  
  assertEquals(entries[0].media_id, 'media/1');
  assertEquals(entries[0].url, 'https://flow-content.google/image1.png');
  assertEquals(entries[0].mediaType, 'image');

  assertEquals(entries[1].media_id, 'media/2');
  assertEquals(entries[1].url, 'https://lh3.googleusercontent.com/video2.mp4');
  assertEquals(entries[1].mediaType, 'video');

  assertEquals(entries[2].media_id, 'invalid-no-url');
  assertEquals(entries[2].url, null);
  assertEquals(entries[2].mediaType, 'image');
});


// ============================================================================
// 3. TESTS FOR asset_utils.js (FlowboardAssetUtils)
// ============================================================================

test('FlowboardAssetUtils sniffMime & extensionForMime', () => {
  const utils = global.FlowboardAssetUtils;

  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assertEquals(utils.sniffMime(pngBytes), 'image/png');
  assertEquals(utils.extensionForMime('image/png'), 'png');

  // JPEG magic bytes: FF D8 FF
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  assertEquals(utils.sniffMime(jpegBytes), 'image/jpeg');
  assertEquals(utils.extensionForMime('image/jpeg'), 'jpg');

  // MP4 magic bytes: indices 4..7 contain "ftyp" (66 74 79 70)
  const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  assertEquals(utils.sniffMime(mp4Bytes), 'video/mp4');
  assertEquals(utils.extensionForMime('video/mp4'), 'mp4');

  // Fallback reported MIME
  assertEquals(utils.sniffMime(new Uint8Array([0x00]), 'image/png; charset=utf-8'), 'image/png');
  assertEquals(utils.sniffMime(new Uint8Array([0x00]), 'image/gif'), null); // not in allowed
});

testAsync('FlowboardAssetUtils sha256Hex', async () => {
  const utils = global.FlowboardAssetUtils;
  
  // Test with "hello"
  const bytes = new TextEncoder().encode('hello');
  const hash = await utils.sha256Hex(bytes);
  // "hello" sha256 is 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  assertEquals(hash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

testAsync('FlowboardAssetUtils fetchMediaBytes validations', async () => {
  const utils = global.FlowboardAssetUtils;

  // Case 1: Disallowed URL
  await assertThrowsAsync(async () => {
    await utils.fetchMediaBytes('https://hacker.com/image.png');
  }, 'Error');

  // Case 2: Allowed URL, successfully sniffing PNG
  mockFetchHandler = async (url) => {
    assert(url.startsWith('https://flow-content.google/'), 'Mock fetch called with allowed url');
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    // Convert to a string because MockResponse buffer converts it
    const bodyStr = Buffer.from(pngBytes).toString('binary');
    
    // We override MockResponse.arrayBuffer for testing to return the actual binary representation
    const resp = new MockResponse(200, bodyStr, { 'content-type': 'image/png' });
    resp.arrayBuffer = async () => {
      return pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength);
    };
    return resp;
  };

  const asset = await utils.fetchMediaBytes('https://flow-content.google/valid-image.png');
  assertEquals(asset.mimeType, 'image/png');
  assertEquals(asset.byteSize, 10);
  assertEquals(asset.extension, 'png');
  assert(asset.checksum, 'Should compute checksum');
});

testAsync('FlowboardAssetUtils uploadGeneratedAsset flow', async () => {
  const utils = global.FlowboardAssetUtils;

  const mockClient = {
    signUpload: async (storageKey, contentType) => {
      assertEquals(storageKey, 'users/user-1/flow/job-1/output-0.png');
      assertEquals(contentType, 'image/png');
      return { url: 'https://r2.cloudflarestorage.com/signed-put-url' };
    },
  };

  let putCalled = false;
  mockFetchHandler = async (url, options) => {
    assertEquals(url, 'https://r2.cloudflarestorage.com/signed-put-url');
    assertEquals(options.method, 'PUT');
    assertEquals(options.headers['Content-Type'], 'image/png');
    assertEquals(options.body.length, 5); // asset bytes length
    putCalled = true;
    return new MockResponse(200, '');
  };

  const dummyAsset = {
    bytes: new Uint8Array([1, 2, 3, 4, 5]),
    mimeType: 'image/png',
    byteSize: 5,
    checksum: 'dummy-checksum',
    extension: 'png',
  };

  const assetRow = await utils.uploadGeneratedAsset(
    mockClient,
    dummyAsset,
    'user-1',
    'job-1',
    0,
    'a test prompt'
  );

  assert(putCalled, 'PUT request to R2 should have been executed');
  assertEquals(assetRow.source_provider, 'flow');
  assertEquals(assetRow.file_name, 'flow_output.png');
  assertEquals(assetRow.storage_key, 'users/user-1/flow/job-1/output-0.png');
  assertEquals(assetRow.mime_type, 'image/png');
  assertEquals(assetRow.byte_size, 5);
  assertEquals(assetRow.checksum, 'dummy-checksum');
  assertEquals(assetRow.prompt_snapshot, 'a test prompt');
});

testAsync('FlowboardAssetUtils uploadGeneratedAsset sign-upload stage errors', async () => {
  const utils = global.FlowboardAssetUtils;
  const mockClient = {
    signUpload: async () => {
      throw new Error('/api/extension/sign-upload failed');
    },
  };
  const dummyAsset = {
    bytes: new Uint8Array([1]),
    mimeType: 'image/png',
    byteSize: 1,
    checksum: 'checksum',
    extension: 'png',
  };

  try {
    await utils.uploadGeneratedAsset(mockClient, dummyAsset, 'user-1', 'job-1', 0, 'prompt');
  } catch (err) {
    assertEquals(err.name, 'FlowboardAssetError');
    assertEquals(err.stage, 'ERR_STAGE_SIGN_UPLOAD');
    return;
  }
  throw new Error('Expected sign-upload stage error');
});

testAsync('FlowboardAssetUtils uploadGeneratedAsset R2 PUT stage errors', async () => {
  const utils = global.FlowboardAssetUtils;
  const mockClient = {
    signUpload: async () => ({ url: 'https://r2.cloudflarestorage.com/signed-put-url' }),
  };
  mockFetchHandler = async () => new MockResponse(403, 'Forbidden');
  const dummyAsset = {
    bytes: new Uint8Array([1]),
    mimeType: 'image/png',
    byteSize: 1,
    checksum: 'checksum',
    extension: 'png',
  };

  try {
    await utils.uploadGeneratedAsset(mockClient, dummyAsset, 'user-1', 'job-1', 0, 'prompt');
  } catch (err) {
    assertEquals(err.name, 'FlowboardAssetError');
    assertEquals(err.stage, 'ERR_STAGE_R2_PUT');
    assert(err.message.includes('403'), 'R2 status should be preserved');
    return;
  }
  throw new Error('Expected R2 PUT stage error');
});

// ============================================================================
// RUN RESULTS SUMMARY
// ============================================================================

asyncChain.then(() => {
  console.log('\n======================================');
  console.log(`Tests Run: ${testsRun}`);
  console.log(`Tests Passed: ${testsRun - testsFailed}`);
  console.log(`Tests Failed: ${testsFailed}`);
  console.log('======================================');

  if (testsFailed > 0) {
    process.exit(1);
  } else {
    console.log('All extension tests passed successfully!');
    process.exit(0);
  }
});
