/**
 * Yomu's service worker: fast shell delivery without owning reader data.
 *
 * yomu-shell-<version> is disposable and belongs to this worker.
 * yomu-downloads-v1 belongs to the reader and is never deleted here.
 */
const SHELL_VERSION = 'v3';
/* The bundle's hash, written by tools/patch-bundle.mjs -- never by hand. It is
   separate from SHELL_VERSION because the deploy's live check greps for the
   literal SHELL_VERSION = 'v3', and a release that fails it is rolled back. */
const BUNDLE_STAMP = '76493106f8';
const SHELL = `yomu-shell-${SHELL_VERSION}-${BUNDLE_STAMP}`;
const OURS = /^yomu-shell-/;
const SHELL_MAX_ENTRIES = 160;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.add('/'))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => OURS.test(name) && name !== SHELL)
        .map((name) => caches.delete(name)),
    );

    /* Navigation preload starts the HTML request while the worker wakes up,
       removing a service-worker startup round trip on real navigations. */
    try {
      if (self.registration?.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
    } catch {}

    await self.clients.claim();
  })());
});

async function trim(cache) {
  const keys = await cache.keys();
  const excess = keys.length - SHELL_MAX_ENTRIES;
  for (let i = 0; i < excess; i += 1) await cache.delete(keys[i]);
}

async function store(request, response) {
  if (!response?.ok) return;
  const cache = await caches.open(SHELL);
  await cache.put(request, response.clone());
  await trim(cache);
}

/* Never make a successful response wait for CacheStorage I/O. Caching is a
   reliability side effect, not part of the critical rendering path. */
function storeInBackground(event, request, response) {
  const task = store(request, response).catch(() => {});
  if (typeof event.waitUntil === 'function') event.waitUntil(task);
}

function offlineResponse() {
  return new Response('Offline', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** Network-first HTML with navigation preload and a cached shell fallback. */
async function navigationNetworkFirst(event) {
  const request = event.request;
  try {
    const preloaded = event.preloadResponse ? await event.preloadResponse : null;
    const response = preloaded || await fetch(request);
    storeInBackground(event, request, response);
    return response;
  } catch {
    return (await caches.match(request)) || (await caches.match('/')) || offlineResponse();
  }
}

/** Hashed Expo files are immutable. Repeat loads should not touch the wire. */
async function cacheFirst(event) {
  const request = event.request;
  const hit = await caches.match(request);
  if (hit) return hit;

  try {
    const response = await fetch(request);
    storeInBackground(event, request, response);
    return response;
  } catch {
    return offlineResponse();
  }
}

/** Unversioned Yomu JS/CSS/assets return instantly when warm and refresh in
    the background, so fixes still propagate without blocking navigation. */
async function staleWhileRevalidate(event) {
  const request = event.request;
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);

  if (hit) {
    const refresh = fetch(request)
      .then((response) => store(request, response))
      .catch(() => {});
    if (typeof event.waitUntil === 'function') event.waitUntil(refresh);
    return hit;
  }

  try {
    const response = await fetch(request);
    storeInBackground(event, request, response);
    return response;
  } catch {
    return offlineResponse();
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  /* Explicit downloads are cache-only by design. */
  if (url.pathname.startsWith('/__offline/')) {
    event.respondWith(
      caches.open('yomu-downloads-v1')
        .then((cache) => cache.match(event.request))
        .then((hit) => hit || new Response('Download unavailable', { status: 404 })),
    );
    return;
  }

  /* Dynamic state and source resolution must never be pinned by this cache. */
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/title/')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(navigationNetworkFirst(event));
    return;
  }

  if (url.pathname.startsWith('/_expo/static/')) {
    event.respondWith(cacheFirst(event));
    return;
  }

  if (
    url.pathname.startsWith('/_expo/')
    || url.pathname.startsWith('/assets/')
    || url.pathname.startsWith('/fixtures/')
    || event.request.destination === 'script'
    || event.request.destination === 'style'
    || event.request.destination === 'font'
  ) {
    event.respondWith(staleWhileRevalidate(event));
  }
});
