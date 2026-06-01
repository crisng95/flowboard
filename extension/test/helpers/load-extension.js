/**
 * Loading strategy for the Flowboard extension production files.
 *
 * The shipped extension files are NOT ES modules:
 *   - `flow_api.js`  is an IIFE  `(function (global) { ... })(self);`  that
 *                    assigns `global.FlowboardFlowApi` /
 *                    `global.FlowboardFlowApiUtils` (incl. `extractGeneratedText`).
 *   - `background.js` is a service-worker script that begins with
 *                    `importScripts(...)`, touches `chrome.*` at load, exposes
 *                    pure helpers on `globalThis`
 *                    (`injectCaptchaToken`, `buildTextGenContents`) and declares
 *                    `resolveCaptchaAction` / `resolveFlowSdkInfo` as top-level
 *                    functions, and finally calls `init()`.
 *   - `injected.js`  is a MAIN-world script that wraps `window.fetch` and
 *                    declares `extractFlowSdkInfo` at top level.
 *
 * Rather than modify production code, each file is evaluated INSIDE a dedicated
 * Node `vm` context whose global object carries the right shims (`self`,
 * `window`, `chrome`, `fetch`, ...). This exercises the ACTUAL shipped code:
 *   - Top-level `function` declarations and `globalThis.x = ...` assignments
 *     attach to the vm context global, so they are returned for direct testing.
 *   - Module-scope `let` bindings (e.g. `observedFlowSdkInfo`, `cloudConfig`)
 *     are shared across `runInContext` calls in the same context, so tiny
 *     setter helpers (installed via `__test`) can drive them deterministically.
 *
 * No production file is modified by these tests.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// helpers -> test -> extension
const EXT_DIR = path.resolve(__dirname, '..', '..');

function quietConsole() {
  return {
    log: () => {},
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: (...args) => console.error(...args),
  };
}

/**
 * Load `flow_api.js`. Returns the vm context whose globals include
 * `FlowboardFlowApi` and `FlowboardFlowApiUtils`. Pass `fetchImpl` to stub the
 * global `fetch` used by `generateContent`; it can also be reassigned later via
 * `context.fetch = ...`.
 */
export function loadFlowApi({ fetchImpl } = {}) {
  const code = fs.readFileSync(path.join(EXT_DIR, 'flow_api.js'), 'utf8');
  const context = {
    console: quietConsole(),
    crypto: webcrypto,
    fetch: fetchImpl || (async () => {
      throw new Error('flow_api test: unexpected fetch (no stub installed)');
    }),
    TextEncoder,
    TextDecoder,
  };
  context.self = context; // the IIFE is invoked with `self`
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'flow_api.js' });
  return context;
}

class WebSocketStub {
  constructor() {
    this.readyState = 0;
  }
  send() {}
  close() {}
}
WebSocketStub.CONNECTING = 0;
WebSocketStub.OPEN = 1;
WebSocketStub.CLOSING = 2;
WebSocketStub.CLOSED = 3;

function makeChromeStub() {
  const noopListener = { addListener: () => {} };
  return {
    runtime: {
      onInstalled: noopListener,
      onStartup: noopListener,
      onMessage: noopListener,
      sendMessage: () => Promise.resolve(),
      lastError: null,
    },
    alarms: {
      onAlarm: noopListener,
      create: () => {},
      clear: () => {},
    },
    webRequest: {
      onBeforeSendHeaders: { addListener: () => {} },
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
      },
    },
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
      setTitle: () => {},
    },
    tabs: {
      query: () => Promise.resolve([]),
      create: () => Promise.resolve({}),
    },
  };
}

/**
 * Load `background.js`. `importScripts` is stubbed to a no-op (the pure helpers
 * under test have no dependency on cloud_client/asset_utils/flow_api), `chrome`
 * and `WebSocket` are stubbed so the load-time `init()` runs harmlessly, and a
 * `__test` setter API is installed so module-scope `let` state can be driven.
 *
 * Returns the vm context. Useful globals:
 *   - context.injectCaptchaToken
 *   - context.buildTextGenContents
 *   - context.resolveCaptchaAction
 *   - context.resolveFlowSdkInfo
 *   - context.__test.{ setObservedFlowSdkInfo, setCloudConfig,
 *                      setObservedCaptchaActions, getDefaultSeed }
 */
export function loadBackground() {
  const code = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
  const context = {
    console: quietConsole(),
    crypto: webcrypto,
    fetch: async () => {
      throw new Error('background test: unexpected fetch (no stub installed)');
    },
    importScripts: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    WebSocket: WebSocketStub,
    chrome: makeChromeStub(),
    TextEncoder,
    TextDecoder,
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'background.js' });

  // Install setters for the module-scope `let` bindings so tests can drive the
  // resolveFlowSdkInfo / resolveCaptchaAction inputs without touching prod code.
  vm.runInContext(
    `globalThis.__test = {
       setObservedFlowSdkInfo(v) { observedFlowSdkInfo = v; },
       setCloudConfig(v) { cloudConfig = v; },
       setObservedCaptchaActions(v) { observedCaptchaActions = v; },
       getDefaultSeed() { return DEFAULT_FLOW_SDK_INFO_SEED; },
     };`,
    context,
    { filename: 'background.test-setup.js' },
  );
  return context;
}

/**
 * Minimal `window` shim with a working event bus and a recordable `fetch`.
 * `fetchImpl` becomes the ORIGINAL fetch that the injected wrap forwards to.
 */
export function makeWindow({ href = 'https://labs.google/fx/tools/flow', fetchImpl } = {}) {
  const listeners = Object.create(null);
  const win = {
    location: { href },
    grecaptcha: undefined,
    ___grecaptcha_cfg: undefined,
    addEventListener(type, handler) {
      (listeners[type] || (listeners[type] = [])).push(handler);
    },
    removeEventListener(type, handler) {
      const arr = listeners[type];
      if (arr) {
        const i = arr.indexOf(handler);
        if (i >= 0) arr.splice(i, 1);
      }
    },
    dispatchEvent(evt) {
      const arr = listeners[evt && evt.type];
      if (arr) for (const h of arr.slice()) h(evt);
      return true;
    },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, body: null })),
    __listeners: listeners,
  };
  return win;
}

/**
 * Load `injected.js` into a vm context with a `window`/`document`/`CustomEvent`
 * shim. The bottom-of-file `ensureWrapped()` short-circuits cleanly (no
 * `grecaptcha`), and `ensureFetchObserved()` wraps `window.fetch`.
 *
 * Returns { context, window }. Useful globals: context.extractFlowSdkInfo.
 */
export function loadInjected({ window } = {}) {
  const win = window || makeWindow();
  class CustomEventShim {
    constructor(type, init) {
      this.type = type;
      this.detail = init ? init.detail : undefined;
    }
  }
  const context = {
    console: quietConsole(),
    window: win,
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    CustomEvent: CustomEventShim,
    URL,
    // Intentionally NO setTimeout: keeps waitForGrecaptcha() pending instead of
    // looping; ensureWrapped()'s promise is harmlessly never settled.
    TextDecoder,
    TextEncoder,
    AbortController,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, 'injected.js'), 'utf8'), context, {
    filename: 'injected.js',
  });
  return { context, window: win };
}
