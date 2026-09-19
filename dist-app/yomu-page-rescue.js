/**
 * A page that fails to load, quietly rescued.
 *
 * The reader's own handler for a broken page is one line: mark it failed and
 * print "This page could not be loaded." There is no retry. A chapter with one
 * dead image is a chapter you cannot finish, and the cause is almost never
 * permanent -- a hotlink check, an edge blip, an upstream that rate-limited
 * the third request in a burst of twenty.
 *
 * So: try again, through a different door, and say nothing when it works.
 * Silence on success is the whole point. The reader should not learn that
 * Yomu has a source system; they should just see page eighteen.
 *
 * The ladder, in order, at most twice per image:
 *
 *   1. The same URL with a cache-buster. Chapter pages are already proxied
 *      through this origin, so a failure here is usually the edge or the
 *      upstream having a moment, and asking again is the whole fix.
 *
 *   2. The other proxy. An extension page is `/api/ext/image?ext=…&u=<upstream>`,
 *      which enforces that extension's host allowlist; `/api/img?u=<upstream>`
 *      is a different path with its own allowlist, its own Referer (the image's
 *      own origin, which is what defeats a hotlink check) and a thirty-day edge
 *      cache. When the first proxy is the thing that is broken, this is a
 *      genuinely different attempt rather than the same one repeated.
 *
 * Then it stops. A third try on a page that has refused twice is a spinner,
 * and the reader's own message is a better answer than a spinner.
 *
 * Nothing here retries a UI image. A missing avatar is not worth a request.
 */
(() => {
  'use strict';

  const browser = typeof document !== 'undefined';
  /* The ladder is pure and is exercised without a DOM, so every `location`
     read goes through these two rather than the global. */
  const HERE = browser ? location.href : 'https://yomu.test/read/x';
  const ORIGIN = browser ? location.origin : 'https://yomu.test';

  /** Rescues per image. Two doors; after that the answer is no. */
  const MAX_TRIES = 2;

  /** Images that are furniture, not chapter pages. */
  const FURNITURE = /^\/(brand|pets|tags|icons|assets|_expo)\//;

  /* --- the ladder, as a pure function -------------------------------------- *
   *
   * Exported for the tests: given the URL that failed and how many times this
   * image has already been rescued, the next thing to try, or null.
   */

  /** The upstream URL a proxied page is standing in for, if it is one. */
  function upstreamOf(href) {
    try {
      const url = new URL(href, HERE);
      if (url.origin !== ORIGIN) return null;
      if (url.pathname !== '/api/ext/image' && url.pathname !== '/api/img') return null;
      const target = url.searchParams.get('u');
      if (!target) return null;
      /* Only an absolute http(s) target. Anything else is not ours to fetch
         and /api/img would refuse it anyway. */
      const parsed = new URL(target);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      return parsed.toString();
    } catch { return null; }
  }

  function nextAttempt(href, tries) {
    if (!href || tries >= MAX_TRIES) return null;
    let url;
    try { url = new URL(href, HERE); } catch { return null; }

    /* Only a page this origin proxied. Every chapter image goes out through
       /api/ (the extension proxy, the general one, or the MangaDex relay), so
       anything else is either furniture or a relative string that resolved
       against the reader's own path -- and retrying that is a request nobody
       asked for. Knowing how to retry something means knowing what it was. */
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/api/')) return null;

    if (tries === 0) {
      /* Same door, once, without whatever the browser or the edge cached. */
      url.searchParams.set('yomuRetry', '1');
      return url.toString();
    }

    /* The other door. Only from the extension proxy to the general one --
       going the other way would hand /api/img's allowlist a host it has
       already declined. */
    if (url.pathname !== '/api/ext/image') return null;
    const upstream = upstreamOf(href);
    if (!upstream) return null;
    return `${ORIGIN}/api/img?u=${encodeURIComponent(upstream)}&yomuRetry=2`;
  }

  /* --- doing it ------------------------------------------------------------ */

  const isReader = () => browser && location.pathname.startsWith('/read/');

  /** Attempts so far, keyed by the URL the image started from. */
  const tries = new Map();

  /** The src an image began with, before any rescue rewrote it. */
  const origin = new WeakMap();

  function rescue(img) {
    if (!isReader() || !(img instanceof HTMLImageElement)) return;

    const current = img.getAttribute('src') || img.currentSrc || '';
    if (!current) return;

    let path;
    try { path = new URL(current, HERE).pathname; } catch { return; }
    if (FURNITURE.test(path)) return;

    const first = origin.get(img) || current;
    origin.set(img, first);

    const count = tries.get(first) || 0;
    const next = nextAttempt(current, count);
    if (!next) return;

    tries.set(first, count + 1);
    /* A performance mark rather than a console line: the reader already emits
       image:failed/image:ready, so a rescue belongs in the same timeline and
       costs nothing when nobody is looking. */
    try { performance.mark(`image:rescue:${count + 1}`); } catch {}
    img.src = next;
  }

  if (browser) {
    /* `error` does not bubble, so it is caught on the way down. One listener
       for the document rather than one per image: React owns these nodes and
       replaces them, and a listener attached to a node it recycles is a leak
       and a missed failure. */
    addEventListener('error', (event) => {
      const target = event.target;
      if (target && target.tagName === 'IMG') rescue(target);
    }, true);

    /* Leaving the chapter drops the counters. The next chapter's page eighteen
       deserves its own two attempts, and a reader who comes back to a chapter
       that failed an hour ago should not be told no immediately. */
    for (const type of ['popstate', 'hashchange']) {
      addEventListener(type, () => { if (!isReader()) tries.clear(); });
    }
  }

  if (typeof window !== 'undefined') {
    window.YomuPageRescue = { nextAttempt, upstreamOf, MAX_TRIES, __rescue: rescue };
  }
  /* An object literal, not a variable: Node's CJS lexer reads named exports
     statically, and `module.exports = api` gives an importing test nothing but
     a default. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { nextAttempt, upstreamOf, MAX_TRIES };
  }
})();
