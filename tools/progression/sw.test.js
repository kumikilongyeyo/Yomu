/**
 * Service-worker release contract: shell caches stay bounded, reader downloads
 * survive updates, dynamic API/title routes are never cached, and warm hashed
 * assets can be served without a network round trip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(new URL('../../dist-app/sw.js', import.meta.url), 'utf8');
// The current shell cache, read from the worker: patch-bundle.mjs stamps the
// bundle's hash into SHELL_VERSION, so the name changes with every bundle edit.
const CURRENT = `yomu-shell-${SOURCE.match(/const SHELL_VERSION = '([^']+)'/)[1]}`;

class FakeCache {
  constructor() { this.map = new Map(); }
  async put(request, response) { this.map.set(request, response); }
  async add(request) { this.map.set(request, 'shell'); }
  async keys() { return [...this.map.keys()]; }
  async delete(key) { return this.map.delete(key); }
  async match(key) { return this.map.get(key); }
}

function bootWorker({ fetchImpl } = {}) {
  const store = new Map();
  const state = { preloadEnabled: false };
  const caches = {
    async open(name) {
      if (!store.has(name)) store.set(name, new FakeCache());
      return store.get(name);
    },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    async match(key) {
      for (const cache of store.values()) {
        const hit = await cache.match(key);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const listeners = {};
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: {
      navigationPreload: {
        enable: async () => { state.preloadEnabled = true; },
      },
    },
    location: { origin: 'https://yomu.test' },
  };
  const fetchStub = fetchImpl || (async () => ({ ok: true, clone: () => 'body' }));
  class ResponseStub {
    constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; }
  }
  new Function('self', 'caches', 'fetch', 'Response', 'URL', SOURCE)(
    self, caches, fetchStub, ResponseStub, URL,
  );
  return { listeners, caches, store, state };
}

const runLifecycle = async (listener) => {
  const pending = [];
  listener({ waitUntil: (promise) => pending.push(Promise.resolve(promise)) });
  await Promise.all(pending);
};

async function runFetch(listener, request) {
  const pending = [];
  let responsePromise;
  listener({
    request,
    respondWith: (promise) => { responsePromise = Promise.resolve(promise); },
    waitUntil: (promise) => pending.push(Promise.resolve(promise)),
  });
  const response = responsePromise ? await responsePromise : undefined;
  await Promise.all(pending);
  return response;
}

test('activating removes only older shell caches and enables navigation preload', async () => {
  const { listeners, caches, state } = bootWorker();
  for (const name of ['yomu-shell-v1', 'yomu-shell-v2', 'yomu-shell-v3', CURRENT]) await caches.open(name);

  await runLifecycle(listeners.activate);

  assert.deepEqual((await caches.keys()).sort(), [CURRENT]);
  assert.equal(state.preloadEnabled, true, 'navigation preload should remove worker startup latency');
});

test('activating never removes the downloads the reader asked for', async () => {
  const { listeners, caches } = bootWorker();
  for (const name of ['yomu-shell-v2', 'yomu-downloads-v1']) await caches.open(name);

  await runLifecycle(listeners.activate);

  const left = await caches.keys();
  assert.ok(left.includes('yomu-downloads-v1'));
  assert.ok(!left.includes('yomu-shell-v2'));
});

test('a cache belonging to something else is left alone', async () => {
  const { listeners, caches } = bootWorker();
  for (const name of ['yomu-shell-v2', 'workbox-precache', 'some-other-app']) await caches.open(name);

  await runLifecycle(listeners.activate);

  assert.deepEqual((await caches.keys()).sort(), ['some-other-app', 'workbox-precache']);
});

test('the shell cache is bounded and evicts oldest entries', async () => {
  const { listeners, caches, store } = bootWorker();
  await runLifecycle(listeners.install);

  const cache = await caches.open([...store.keys()].find((n) => n.startsWith('yomu-shell-')));
  for (let i = 0; i < 140; i += 1) await cache.put(`asset-${i}`, 'body');

  for (let i = 140; i < 220; i += 1) {
    await runFetch(listeners.fetch, {
      url: `https://yomu.test/_expo/asset-${i}`,
      method: 'GET',
      mode: 'no-cors',
      destination: 'script',
    });
  }

  const keys = await cache.keys();
  assert.ok(keys.length <= 160, `bounded, got ${keys.length}`);
  assert.ok(!keys.includes('asset-0'), 'the oldest entries went first');
  assert.ok(keys.some((key) => String(key.url || key).includes('asset-219')), 'the newest is kept');
});

test('a warm hashed Expo asset is cache-first', async () => {
  let networkCalls = 0;
  const { listeners, caches } = bootWorker({
    fetchImpl: async () => {
      networkCalls += 1;
      return { ok: true, clone: () => 'network' };
    },
  });
  const request = {
    url: 'https://yomu.test/_expo/static/js/web/entry-hash.js',
    method: 'GET',
    mode: 'no-cors',
    destination: 'script',
  };
  const cache = await caches.open(CURRENT);
  await cache.put(request, 'cached-entry');

  const response = await runFetch(listeners.fetch, request);
  assert.equal(response, 'cached-entry');
  assert.equal(networkCalls, 0, 'repeat visits should not refetch immutable bundles');
});

test('API and title-router responses are never cached by the shell worker', () => {
  assert.match(SOURCE, /pathname\.startsWith\('\/api\/'\)\) return/);
  assert.match(SOURCE, /pathname\.startsWith\('\/title\/'\)\) return/);
});

test('an explicitly downloaded chapter is served without a network', () => {
  assert.match(SOURCE, /yomu-downloads-v1/);
  assert.match(SOURCE, /__offline\//);
  const branch = SOURCE.slice(SOURCE.indexOf('__offline/'), SOURCE.indexOf('/api/'));
  assert.ok(!branch.includes('fetch('), 'the offline branch must not reach for the network');
});

test('successful network responses are cached outside the response critical path', () => {
  assert.match(SOURCE, /storeInBackground\(event, request, response\)/);
  assert.match(SOURCE, /event\.waitUntil\(task\)/);
  assert.doesNotMatch(SOURCE, /await cache\.put\(request, response\.clone\(\)\);[\s\S]{0,160}return response;/);
});
