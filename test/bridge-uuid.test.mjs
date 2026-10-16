import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bridgeSource = readFileSync(new URL('../bridge.js', import.meta.url), 'utf8');

function loadBridgeForUuidTest({ cryptoValue, randomImpl }) {
  const window = {
    __DSH_COMFYUI_BOOTSTRAP__: { token: 'test-token', bridgeBase: 'https://example.test' },
    __DSH_COMFYUI_BRIDGE_ACTIVE__: false,
    __DSH_BRIDGE_TOKEN__: 'test-token',
    location: { origin: 'https://comfy.test', search: '', href: 'https://comfy.test/' },
    parent: null,
    document: {
      referrer: 'https://dsh.test/',
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {}
    },
    localStorage: {
      getItem() { return null; },
      setItem() {}
    },
    addEventListener() {},
    removeEventListener() {},
    comfyAPI: {},
    console: { warn() {} },
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { token: 'test-token', bridgeProtocol: 5, commands: [] };
      },
      async text() {
        return '';
      }
    }),
    EventSource: class {
      constructor() {}
      close() {}
      onopen = null;
      onmessage = null;
      onerror = null;
    },
    setTimeout() { return 0; },
    clearTimeout() {}
  };

  const context = {
    window,
    self: window,
    globalThis: window,
    document: window.document,
    location: window.location,
    console: window.console,
    fetch: window.fetch,
    EventSource: window.EventSource,
    URL,
    URLSearchParams,
    localStorage: window.localStorage,
    crypto: cryptoValue,
    Math: Object.create(Math),
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout
  };

  context.Math.random = randomImpl;

  const patchedSource = bridgeSource.replace(
    '})();',
    'window.__test_randomUUID = randomUUID; window.__test_randomUUID_state = { warnedWeakUUID };})();'
  );

  vm.runInNewContext(patchedSource, context, { filename: 'bridge.js' });
  return window;
}

function makeDeterministicRandom() {
  let seed = 1;
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

test('bridge UUID fallback generates valid v4 UUIDs when crypto is unavailable', () => {
  const window = loadBridgeForUuidTest({
    cryptoValue: undefined,
    randomImpl: makeDeterministicRandom()
  });

  const uuid1 = window.__test_randomUUID();
  const uuid2 = window.__test_randomUUID();

  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  assert.match(uuid1, v4);
  assert.match(uuid2, v4);
  assert.notEqual(uuid1, uuid2);
});

test('bridge UUID fallback generates valid v4 UUIDs when randomUUID is missing and getRandomValues throws', () => {
  const window = loadBridgeForUuidTest({
    cryptoValue: {
      getRandomValues() {
        throw new Error('crypto.getRandomValues failed');
      }
    },
    randomImpl: makeDeterministicRandom()
  });

  const uuid1 = window.__test_randomUUID();
  const uuid2 = window.__test_randomUUID();

  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  assert.match(uuid1, v4);
  assert.match(uuid2, v4);
  assert.notEqual(uuid1, uuid2);
});
