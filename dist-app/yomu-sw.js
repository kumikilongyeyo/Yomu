/**
 * Yomu service worker registration.
 *
 * sw.js has been in the export for a long time and almost nobody was running
 * it: the only call to `serviceWorker.register` sits inside downloadChapter, so
 * the shell cache existed for people who had saved a chapter offline and for
 * nobody else. Every other visitor paid the network for the same files on every
 * full page load -- and Yomu has several real pages (find, more, sources), so
 * those are frequent.
 *
 * Registered after `load` rather than during it. A service worker's install
 * fetches `/` into its cache, and racing that against the page's own first
 * paint would make the first visit slower to make later ones faster.
 *
 * What it does and does not touch is worth knowing before turning it on for
 * everyone (see sw.js): /api/ and /title/ bypass it completely, so no source
 * resolution or reader data is ever served from cache; navigations are
 * network-first, so a bad release cannot pin a broken shell; only the hashed
 * Expo files are cache-first, and their names change when their contents do.
 *
 * Kill switch: `?sw=off` once, or localStorage['yomu.v1.sw'] = 'off', tears the
 * worker down and drops its caches. A service worker that can only be removed
 * by shipping another one is a bad thing to hand somebody.
 */
(() => {
  'use strict';
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const KEY = 'yomu.v1.sw';
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (value) => { try { localStorage.setItem(KEY, value); } catch {} };

  /* One visit with ?sw=off is enough to turn it off for good on this device. */
  try {
    if (new URLSearchParams(location.search).get('sw') === 'off') write('off');
  } catch {}

  async function remove() {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      /* Only the shell. yomu-downloads-v1 belongs to the reader and holds
         chapters somebody deliberately saved. */
      const names = await caches.keys();
      await Promise.all(names.filter((name) => /^yomu-shell-/.test(name)).map((name) => caches.delete(name)));
    } catch {}
  }

  if (read() === 'off') { remove(); return; }

  /* Registration throws outside a secure context, and localhost counts as one. */
  const secure = location.protocol === 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!secure) return;

  const start = () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); };
  if (document.readyState === 'complete') start();
  else addEventListener('load', start, { once: true });
})();
