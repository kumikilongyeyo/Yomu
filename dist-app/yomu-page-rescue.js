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
 *   3. Another source's copy of the same page. When both doors refuse, the
 *      page is usually gone upstream, not blocked. The chapter ledger knows
 *      who else carries this chapter; a copy with *exactly* the same page
 *      count is fetched (one lookup per chapter, remembered) and page N is
 *      taken from it. Only an exact count: sites slice strips differently
 *      (Solo Leveling ch.200 is 15, 18 and 49 pages on three sites), so a
 *      different count has no page N that is this page N. A mismatched
 *      chapter is the whole-chapter recovery's job, not this one's.
 *
 * Then it stops. Another try on a page that has refused every door is a
 * spinner, and the reader's own message is a better answer than a spinner.
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

  /**
   * Which alternate copy to take page `index` from, given the copies that
   * matched the page count and how many this image has already tried.
   * Pure; exported for the tests.
   */
  function pickAlternate(alternates, index, tried) {
    const usable = (alternates || []).filter((alt) => alt && typeof alt.pages?.[index]?.url === 'string');
    const alt = usable[tried];
    return alt ? { providerId: alt.providerId, providerName: alt.providerName, url: alt.pages[index].url } : null;
  }

  /* --- doing it ------------------------------------------------------------ */

  const isReader = () => browser && location.pathname.startsWith('/read/');

  /** Attempts so far, keyed by the URL the image started from. */
  const tries = new Map();

  /** The src an image began with, before any rescue rewrote it. */
  const origin = new WeakMap();

  /* --- the third door: the same page from another source ------------------- */

  const CROSS_TRIES = 2;
  const crossTries = new Map();
  /** chapter key -> Promise of copies with this chapter's exact page count. */
  const alternates = new Map();
  let toldFor = '';

  const readJSON = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const toProviderId = (id) => (id.startsWith('yomuext-') ? 'ext:' + id.slice(8) : id.startsWith('mihon-') ? 'suwayomi:' + id.slice(6) : id);
  const toAppSource = (id) => (id.startsWith('ext:') ? 'yomuext-' + id.slice(4) : id.startsWith('suwayomi:') ? 'mihon-' + id.slice(9) : id);

  function manifestUrl(release) {
    const provider = String(release?.providerId || '');
    const chapter = encodeURIComponent(String(release?.chapterId || ''));
    if (provider.startsWith('ext:')) return `/api/ext/source/${encodeURIComponent(provider.slice(4))}/chapters/${chapter}/manifest`;
    if (provider.startsWith('suwayomi:')) return `/api/suwayomi/source/${encodeURIComponent(provider.slice(9))}/chapters/${chapter}/manifest`;
    return null;
  }

  async function findAlternates(state) {
    const source = state.source;
    const provider = toProviderId(source);
    const params = new URLSearchParams();
    const links = readJSON('yomu.v1.readerContext')?.[`${source}:${state.chapterId}`]?.links
      || readJSON('yomu.v1.ledgerLinks')?.[`${source}:${state.seriesId}`];
    if (Array.isArray(links) && links.length) for (const link of links) params.append('link', String(link));
    else {
      const title = String(document.querySelector('.rd-head__copy h1')?.textContent || '').trim();
      if (!title || /^loading/i.test(title)) return [];
      params.set('title', title);
    }
    params.set('prefer', provider);
    const response = await fetch(`/api/catalog/chapters?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const ledger = response.ok ? await response.json().catch(() => null) : null;
    if (!Array.isArray(ledger?.rows)) return [];

    let row = ledger.rows.find((r) => (r.releases || []).some((rel) =>
      String(rel.providerId) === provider && String(rel.chapterId) === state.chapterId));
    if (!row) {
      const text = String(document.querySelector('.rd-head__copy p')?.textContent || '');
      const m = text.match(/(?:chapter|ch\.?|episode|ep\.?)\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (m) row = ledger.rows.find((r) => Number(r.number) === Number(m[1]));
    }
    const disabled = new Set((readJSON('yomu.v1.collection')?.sources || [])
      .filter((s) => s && s.enabled === false).map((s) => String(s.id)));
    const candidates = (row?.releases || [])
      .filter((rel) => String(rel.providerId) !== provider && manifestUrl(rel))
      .filter((rel) => !disabled.has(toAppSource(String(rel.providerId))))
      .slice(0, 4);

    const out = [];
    await Promise.all(candidates.map(async (rel) => {
      try {
        const r = await fetch(manifestUrl(rel), { cache: 'no-store', signal: AbortSignal.timeout(12000) });
        const body = r.ok ? await r.json().catch(() => null) : null;
        if (Array.isArray(body?.pages) && body.pages.length === state.count) {
          out.push({ providerId: rel.providerId, providerName: rel.providerName, pages: body.pages });
        }
      } catch {}
    }));
    /* Most reliable first, when the integrity layer has an opinion. */
    const health = window.YomuIntegrity?.health;
    if (health) out.sort((a, b) => health(b.providerId) - health(a.providerId));
    return out;
  }

  function tell(state, name) {
    const key = `${state.source}|${state.chapterId}`;
    if (toldFor === key) return;
    toldFor = key;
    const note = document.createElement('div');
    note.className = 'yomu-rescue-note';
    note.setAttribute('role', 'status');
    note.textContent = `Switched a page to ${name || 'another source'} to keep reading`;
    Object.assign(note.style, {
      position: 'fixed', left: '50%', bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))', transform: 'translateX(-50%)',
      zIndex: '9999', maxWidth: 'min(88vw, 420px)', padding: '8px 14px', borderRadius: '999px',
      background: 'rgba(12,14,18,.9)', color: '#f4f6fa', font: '600 12.5px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      boxShadow: '0 8px 28px rgba(0,0,0,.3)', pointerEvents: 'none', transition: 'opacity .4s', textAlign: 'center',
    });
    document.body.append(note);
    setTimeout(() => { note.style.opacity = '0'; }, 2400);
    setTimeout(() => note.remove(), 2900);
  }

  async function crossSource(img, first) {
    const state = globalThis.__yomuReader;
    const holder = img.closest?.('[data-page-index]');
    const index = Number(holder?.getAttribute('data-page-index'));
    if (!state?.chapterId || !state.source || !(state.count > 0) || !Number.isInteger(index)) return;
    const tried = crossTries.get(first) || 0;
    if (tried >= CROSS_TRIES) return;
    crossTries.set(first, tried + 1);

    const key = `${state.source}|${state.chapterId}`;
    if (!alternates.has(key)) alternates.set(key, findAlternates(state).catch(() => []));
    const pick = pickAlternate(await alternates.get(key), index, tried);
    if (!pick || !img.isConnected || origin.get(img) !== first) return;
    try { performance.mark('image:rescue:cross'); } catch {}
    img.src = pick.url;
    tell(state, pick.providerName);
  }

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
    if (!next) {
      /* Out of doors on this source: the third door has its own cap. */
      crossSource(img, first);
      return;
    }

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
      addEventListener(type, () => { if (!isReader()) { tries.clear(); crossTries.clear(); alternates.clear(); } });
    }
  }

  if (typeof window !== 'undefined') {
    window.YomuPageRescue = { nextAttempt, upstreamOf, pickAlternate, MAX_TRIES, __rescue: rescue };
  }
  /* An object literal, not a variable: Node's CJS lexer reads named exports
     statically, and `module.exports = api` gives an importing test nothing but
     a default. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { nextAttempt, upstreamOf, pickAlternate, MAX_TRIES };
  }
})();
