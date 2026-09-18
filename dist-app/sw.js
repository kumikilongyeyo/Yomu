/**
 * Yomu's service worker: the offline shell, and nothing the app owns.
 *
 * Two caches with two different owners, and the distinction is the whole
 * reason this file has to be careful:
 *
 *   yomu-shell-<version>   this file's. The app shell and its static assets,
 *                          re-fetched when the version changes, bounded.
 *   yomu-downloads-v1      the *app's*. Chapters a reader explicitly asked to
 *                          keep. Never touched here. Deleting it would throw
 *                          away something somebody chose to download, on a
 *                          worker update they did not ask for.
 *
 * The previous version had one cache name, wrote every navigation and every
 * static asset into it forever, and never deleted anything. A rename shipped
 * a second copy of the whole shell beside the first, and an install that had
 * been used for a year carried every build it had ever seen.
 *
 * Bump SHELL_VERSION whenever the shell's contents must be re-fetched.
 */
const SHELL_VERSION = 'v2';
const SHELL = `yomu-shell-${SHELL_VERSION}`;

/** Ours to expire. Anything else with a yomu- prefix belongs to someone else. */
const OURS = /^yomu-shell-/;

/**
 * How many responses the shell cache may hold.
 *
 * Generous, because it is one entry per page and per static asset rather than
 * per image, and small enough that a long-lived install cannot grow without
 * limit. Eviction is oldest-first: the Cache API returns keys in insertion
 * order, so the front of the list is the least recently *added*. That is not
 * a true LRU and does not need to be -- every entry is re-fetchable, and the
 * cost of evicting the wrong one is a single network request.
 */
const SHELL_MAX_ENTRIES = 80;

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
    await self.clients.claim();
  })());
});

/** Keep the shell cache inside its budget, oldest first. */
async function trim(cache) {
  const keys = await cache.keys();
  const excess = keys.length - SHELL_MAX_ENTRIES;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

/** Network first, cache as a floor. A stale shell beats a blank page. */
async function shellFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL);
      await cache.put(request, response.clone());
      /* After the put, not before: trimming to the budget and then adding one
         is how a cache sits permanently one over it. */
      await trim(cache);
    }
    return response;
  } catch {
    return (await caches.match(request))
      || (request.mode === 'navigate' ? await caches.match('/') : null)
      || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  /* Explicitly downloaded chapters. Cache-only by design: this is the one
     thing that has to work with no network at all. */
  if (url.pathname.startsWith('/__offline/')) {
    event.respondWith(
      caches.open('yomu-downloads-v1')
        .then((cache) => cache.match(event.request))
        .then((hit) => hit || new Response('Download unavailable', { status: 404 })),
    );
    return;
  }

  /* The API is never cached here: it is reading state, source health and
     chapter manifests, and a stale one of those is worse than an error. */
  if (url.pathname.startsWith('/api/')) return;

  /* `/title/...` resolves to whichever source can serve a book right now.
     Caching that would pin a reader to a source that has since died, which is
     the opposite of what the route is for. */
  if (url.pathname.startsWith('/title/')) return;

  if (
    event.request.mode === 'navigate'
    || url.pathname.startsWith('/_expo/')
    || url.pathname.startsWith('/assets/')
    || url.pathname.startsWith('/fixtures/')
  ) {
    event.respondWith(shellFirst(event.request));
  }
});
