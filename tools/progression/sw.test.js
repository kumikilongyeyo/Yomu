/**
 * The service worker's cache policy.
 *
 * Two properties matter enough to hold down, and both are about *not*
 * deleting the wrong thing:
 *
 *   - an update must remove this file's own older caches, or an install that
 *     has been used for a year carries every build it has ever seen;
 *   - an update must never remove `yomu-downloads-v1`, which belongs to the
 *     app and holds chapters somebody explicitly chose to keep offline.
 *
 * The worker is loaded for real into a fake CacheStorage rather than having
 * its logic restated here, so a test cannot pass while the shipped file is
 * wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(new URL('../../dist-app/sw.js', import.meta.url), 'utf8');

class FakeCache {
  constructor() { this.map = new Map(); }
  async put(request, response) { this.map.set(request, response); }
  async add(request) { this.map.set(request, 'shell'); }
  async keys() { return [...this.map.keys()]; }
  async delete(key) { return this.map.delete(key); }
  async match(key) { return this.map.get(key); }
}

/** Loads the real worker and returns its listeners plus the cache store. */
function bootWorker({ fetchImpl } = {}) {
  const store = new Map();
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
    location: { origin: 'https://yomu.test' },
  };
  const fetchStub = fetchImpl || (async () => ({ ok: true, clone: () => 'body' }));
  class ResponseStub {
    constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; }
  }
  new Function('self', 'caches', 'fetch', 'Response', 'URL', SOURCE)(
    self, caches, fetchStub, ResponseStub, URL,
  );
  return { listeners, caches, store };
}

const run = async (listener) => {
  let settle;
  const waited = new Promise((resolve) => { settle = resolve; });
  listener({ waitUntil: (promise) => Promise.resolve(promise).then(settle) });
  await waited;
};

test('activating removes this worker\'s older caches', async () => {
  const { listeners, caches } = bootWorker();
  for (const name of ['yomu-shell-v1', 'yomu-shell-old', 'yomu-shell-v2']) await caches.open(name);

  await run(listeners.activate);

  const left = (await caches.keys()).sort();
  assert.deepEqual(left, ['yomu-shell-v2'], 'only the current shell survives');
});

test('activating never removes the downloads the reader asked for', async () => {
  const { listeners, caches } = bootWorker();
  for (const name of ['yomu-shell-v1', 'yomu-downloads-v1']) await caches.open(name);

  await run(listeners.activate);

  const left = await caches.keys();
  assert.ok(left.includes('yomu-downloads-v1'),
    'that cache belongs to the app, and holds chapters somebody chose to keep');
  assert.ok(!left.includes('yomu-shell-v1'));
});

test('a cache belonging to something else is left alone', async () => {
  const { listeners, caches } = bootWorker();
  for (const name of ['yomu-shell-v1', 'workbox-precache', 'some-other-app']) await caches.open(name);

  await run(listeners.activate);

  const left = (await caches.keys()).sort();
  assert.deepEqual(left, ['some-other-app', 'workbox-precache'],
    'only names this worker owns are expired');
});

test('the shell cache is bounded, and evicts oldest first', async () => {
  const { listeners, caches, store } = bootWorker();
  await run(listeners.install);

  const cache = await caches.open([...store.keys()].find((n) => n.startsWith('yomu-shell-')));
  for (let i = 0; i < 40; i++) await cache.put('asset-' + i, 'body');

  /* Drive the real fetch handler, which is what does the trimming. */
  const respondWith = [];
  for (let i = 40; i < 120; i++) {
    listeners.fetch({
      request: { url: 'https://yomu.test/_expo/asset-' + i, method: 'GET', mode: 'no-cors' },
      respondWith: (p) => respondWith.push(p),
    });
  }
  await Promise.all(respondWith);

  const keys = await cache.keys();
  assert.ok(keys.length <= 80, `bounded, got ${keys.length}`);
  assert.ok(!keys.includes('asset-0'), 'the oldest entries went first');
  assert.ok(keys.some((k) => String(k.url || k).includes('asset-119')), 'the newest is kept');
});

test('the API and the title router are never cached', () => {
  /* Reading state, source health, chapter manifests and "which source can
     serve this book right now" are all things a stale copy answers wrongly. */
  assert.match(SOURCE, /pathname\.startsWith\('\/api\/'\)\) return/);
  assert.match(SOURCE, /pathname\.startsWith\('\/title\/'\)\) return/);
});

test('an explicitly downloaded chapter is served without a network', () => {
  assert.match(SOURCE, /yomu-downloads-v1/);
  assert.match(SOURCE, /__offline\//);
  /* Cache-only: no fetch on that path, because offline is the whole point. */
  const branch = SOURCE.slice(SOURCE.indexOf('__offline/'), SOURCE.indexOf('/api/'));
  assert.ok(!branch.includes('fetch('), 'the offline branch must not reach for the network');
});
