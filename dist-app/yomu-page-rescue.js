/**
 * A page that fails to load, quietly rescued.
 *
 * The reader's own handler for a broken page was one line: mark it failed and
 * print "This page could not be loaded." A chapter with one dead image is a
 * chapter you cannot finish, and the cause is almost never permanent -- a
 * hotlink check, an edge blip, an upstream that rate-limited the third request
 * in a burst of twenty.
 *
 * So: try again, through a different door, and say nothing when it works.
 * Silence on success is the whole point. The reader should not learn that
 * Yomu has a source system; they should just see page eighteen.
 *
 * The ladder, per image:
 *
 *   1. At once: the same URL with a cache-buster. Chapter pages are proxied
 *      through this origin, so a failure here is usually the edge or the
 *      upstream having a moment, and asking again is the whole fix.
 *
 *   2. After a short pause: the other proxy. An extension page is
 *      `/api/ext/image?ext=…&u=<upstream>`, which enforces that extension's
 *      host allowlist; `/api/img?u=<upstream>` is a different path with its
 *      own allowlist, its own Referer (the image's own origin, which is what
 *      defeats a hotlink check) and a thirty-day edge cache.
 *
 *   3. Another source's copy of the same page -- only when that source is
 *      known to cut the chapter exactly the same way: the same page count
 *      here *and* the same count on every chapter this device has seen the
 *      two carry together (yomu-integrity.js learns that), or matching content
 *      hashes. Sites slice strips differently (Solo Leveling ch.200 is 15, 18
 *      and 49 pages on three sites), so an equal count on one chapter alone
 *      is a coincidence, not a page N that is this page N.
 *
 *   4. After a longer pause: the last door once more. A rate limit that
 *      refused a burst answers a single request a few seconds later.
 *
 * While any of that is in flight the image carries data-yomu-rescue="pending",
 * which the reader reads (patch-bundle.mjs, "a page being rescued is still
 * loading, not failed") so the page keeps its loading state instead of
 * flashing "unavailable". When every door has refused, it becomes "exhausted"
 * and the reader is told, by the same error event it would have had.
 * yomu-chapter-switch.js counts exhausted pages toward swapping the chapter.
 *
 * Offline is not a failure: the page waits for the connection and then asks.
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

  /** Door changes per image: the same door fresh, then the other door. */
  const MAX_TRIES = 2;
  /** Before the second door, and before the last late try. */
  const SECOND_DOOR_MS = 700;
  const LATE_TRY_MS = 3500;

  /** Images that are furniture, not chapter pages. */
  const FURNITURE = /^\/(brand|pets|tags|icons|assets|_expo)\//;

  /* --- the ladder, as pure functions -------------------------------------- *
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

  /** Only a page this origin proxied: every chapter image goes out through /api/. */
  function isOurs(href) {
    try {
      const url = new URL(href, HERE);
      return url.origin === ORIGIN && url.pathname.startsWith('/api/');
    } catch { return false; }
  }

  function nextAttempt(href, tries) {
    if (!href || tries >= MAX_TRIES) return null;
    let url;
    try { url = new URL(href, HERE); } catch { return null; }

    /* Only a page this origin proxied. Anything else is either furniture or a
       relative string that resolved against the reader's own path -- and
       retrying that is a request nobody asked for. Knowing how to retry
       something means knowing what it was. */
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

  /** How long to wait before try number `tries` (0-based) of nextAttempt. */
  function retryDelay(tries) {
    return tries <= 0 ? 0 : SECOND_DOOR_MS;
  }

  /** The late try: the door that failed last, asked once more, fresh. */
  function lateAttempt(href) {
    if (!isOurs(href)) return null;
    const url = new URL(href, HERE);
    url.searchParams.set('yomuRetry', 'late');
    return url.toString();
  }

  /**
   * Which alternate copy to take page `index` from, given the copies proven
   * to slice like this one and how many this image has already tried.
   */
  function pickAlternate(alternates, index, tried) {
    const usable = (alternates || []).filter((alt) => alt && typeof alt.pages?.[index]?.url === 'string');
    const alt = usable[tried];
    return alt ? { providerId: alt.providerId, providerName: alt.providerName, url: alt.pages[index].url } : null;
  }

  /**
   * Whether another source's manifest cuts this chapter exactly as ours does.
   * Content hashes settle it when both have them. Otherwise the same count
   * here AND a learned history of the same count together (`sameSlicing`).
   */
  function slicesAlike(ours, theirs, sameSlicing) {
    if (!Array.isArray(ours) || !Array.isArray(theirs) || !ours.length || ours.length !== theirs.length) return false;
    const hashed = ours.every((p) => p?.contentHash) && theirs.every((p) => p?.contentHash);
    if (hashed) return ours.every((p, i) => p.contentHash === theirs[i].contentHash);
    return sameSlicing === true;
  }

  /* --- doing it ------------------------------------------------------------ */

  const isReader = () => browser && location.pathname.startsWith('/read/');

  /**
   * Per image element: where it started, how far up the ladder it is. Per
   * element rather than per URL, so a page the reader unmounts and mounts
   * again later -- or one the reader's own Retry recreates -- gets a fresh
   * ladder; a failure an hour ago is not a reason to refuse now.
   */
  const ladder = new WeakMap();
  /** Synthetic error events this file dispatched, so it does not rescue them. */
  const ours = new WeakSet();

  function stateOf(img, current) {
    let state = ladder.get(img);
    if (!state || state.src !== img.getAttribute('src') && !state.expect.has(img.getAttribute('src'))) {
      state = { first: current, tries: 0, cross: 0, late: false, expect: new Set(), timer: 0 };
      ladder.set(img, state);
    }
    return state;
  }

  const pending = (img) => { img.dataset.yomuRescue = 'pending'; };

  /** Every door refused: tell the reader with the error event it would have had. */
  function exhausted(img) {
    if (!img.isConnected) return;
    img.dataset.yomuRescue = 'exhausted';
    try { performance.mark('image:rescue:exhausted'); } catch {}
    const event = new Event('error');
    ours.add(event);
    img.dispatchEvent(event);
  }

  function knock(img, state, url, delay) {
    clearTimeout(state.timer);
    pending(img);
    state.expect.add(url);
    const go = () => {
      if (!img.isConnected || ladder.get(img) !== state) return;
      state.src = url;
      img.src = url;
    };
    if (delay > 0) state.timer = setTimeout(go, delay);
    else go();
  }

  /* --- the third door: the same page from another source ------------------- */

  const CROSS_TRIES = 2;
  /** chapter key -> Promise of copies proven to slice like this one. */
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
    const sameSlicing = (other) => window.YomuIntegrity?.sameSlicing?.(provider, other) === true;
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
    const response = await fetch(`/api/catalog/chapters?${params}`, { cache: 'no-store', headers: { 'x-yomu-quiet': '1' }, signal: AbortSignal.timeout(15000) });
    const ledger = response.ok ? await response.json().catch(() => null) : null;
    if (!Array.isArray(ledger?.rows)) return [];

    const bare = String(state.chapterId).includes(':') ? String(state.chapterId).slice(String(state.chapterId).indexOf(':') + 1) : String(state.chapterId);
    let row = ledger.rows.find((r) => (r.releases || []).some((rel) =>
      String(rel.providerId) === provider && (String(rel.chapterId) === state.chapterId || String(rel.chapterId) === bare)));
    if (!row) {
      const text = String(document.querySelector('.rd-head__copy p')?.textContent || '');
      const m = text.match(/(?:chapter|ch\.?|episode|ep\.?)\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (m) row = ledger.rows.find((r) => Number(r.number) === Number(m[1]));
    }
    const disabled = new Set((readJSON('yomu.v1.collection')?.sources || [])
      .filter((s) => s && s.enabled === false).map((s) => String(s.id)));
    const hashed = Array.isArray(state.pages) && state.pages.length > 0 && state.pages.every((p) => p?.contentHash);
    const candidates = (row?.releases || [])
      .filter((rel) => String(rel.providerId) !== provider && manifestUrl(rel))
      .filter((rel) => !disabled.has(toAppSource(String(rel.providerId))))
      /* Nothing to fetch for a pair with no history and no hashes to compare. */
      .filter((rel) => hashed || sameSlicing(String(rel.providerId)))
      .slice(0, 4);

    const out = [];
    await Promise.all(candidates.map(async (rel) => {
      try {
        const r = await fetch(manifestUrl(rel), { cache: 'no-store', headers: { 'x-yomu-quiet': '1' }, signal: AbortSignal.timeout(12000) });
        const body = r.ok ? await r.json().catch(() => null) : null;
        if (slicesAlike(state.pages, body?.pages, sameSlicing(String(rel.providerId)))) {
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
    note.textContent = `A page came from ${name || 'another source'}`;
    document.body.append(note);
    setTimeout(() => { note.classList.add('is-leaving'); }, 2400);
    setTimeout(() => note.remove(), 2900);
  }

  /** Resolves true when it put another source's page in; false when there was none. */
  async function crossSource(img, state) {
    const reader = globalThis.__yomuReader;
    const holder = img.closest?.('[data-page-index]');
    const index = Number(holder?.getAttribute('data-page-index'));
    if (!reader?.chapterId || !reader.source || !(reader.count > 0) || !Number.isInteger(index)) return false;
    if (state.cross >= CROSS_TRIES) return false;
    const tried = state.cross++;

    const key = `${reader.source}|${reader.chapterId}`;
    if (!alternates.has(key)) alternates.set(key, findAlternates(reader).catch(() => []));
    const pick = pickAlternate(await alternates.get(key), index, tried);
    if (!pick || !img.isConnected || ladder.get(img) !== state) return false;
    try { performance.mark('image:rescue:cross'); } catch {}
    knock(img, state, pick.url, 0);
    tell(reader, pick.providerName);
    return true;
  }

  function rescue(img) {
    if (!isReader() || !(img instanceof HTMLImageElement)) return;

    const current = img.getAttribute('src') || img.currentSrc || '';
    if (!current) return;

    let path;
    try { path = new URL(current, HERE).pathname; } catch { return; }
    if (FURNITURE.test(path)) return;
    if (!isOurs(current) && !ladder.has(img)) return;

    const state = stateOf(img, current);
    state.src = current;

    /* Offline is not the page's fault. Wait for the line, then ask again. */
    if (navigator.onLine === false) {
      pending(img);
      addEventListener('online', () => knock(img, state, lateAttempt(current) || current, 400), { once: true });
      return;
    }

    const next = nextAttempt(current, state.tries);
    if (next) {
      const delay = retryDelay(state.tries);
      state.tries++;
      /* A performance mark rather than a console line: the reader already
         emits image:failed/image:ready, so a rescue belongs in the same
         timeline and costs nothing when nobody is looking. */
      try { performance.mark(`image:rescue:${state.tries}`); } catch {}
      knock(img, state, next, delay);
      return;
    }

    /* Out of doors on this source. Another source's copy of the page, if one
       is proven to match; then the last door once more, later; then no. */
    pending(img);
    const lastTry = () => {
      if (!img.isConnected || ladder.get(img) !== state) return;
      if (!state.late) {
        state.late = true;
        const late = lateAttempt(current);
        if (late) { knock(img, state, late, LATE_TRY_MS); return; }
      }
      exhausted(img);
    };
    if (state.cross < CROSS_TRIES) crossSource(img, state).then((ok) => { if (!ok) lastTry(); }, lastTry);
    else lastTry();
  }

  if (browser) {
    /* `error` does not bubble, so it is caught on the way down. One listener
       for the document rather than one per image: React owns these nodes and
       replaces them, and a listener attached to a node it recycles is a leak
       and a missed failure. */
    addEventListener('error', (event) => {
      const target = event.target;
      if (!target || target.tagName !== 'IMG' || ours.has(event)) return;
      rescue(target);
    }, true);

    /* A rescued page that loads is simply a page again. On the document: a
       load event fired at an element never reaches the window. */
    document.addEventListener('load', (event) => {
      const target = event.target;
      if (target && target.tagName === 'IMG' && target.dataset?.yomuRescue) delete target.dataset.yomuRescue;
    }, true);

    /* Leaving the chapter drops the lookups. The next chapter's page eighteen
       deserves its own attempts. */
    for (const type of ['popstate', 'hashchange', 'yomu:route']) {
      addEventListener(type, () => { if (!isReader()) alternates.clear(); });
    }
  }

  if (typeof window !== 'undefined') {
    window.YomuPageRescue = {
      nextAttempt, upstreamOf, pickAlternate, slicesAlike, retryDelay, lateAttempt, MAX_TRIES,
      __rescue: rescue,
      /** A retry the reader asked for starts a fresh ladder (the image element is new anyway). */
      reset: () => {},
    };
  }
  /* An object literal, not a variable: Node's CJS lexer reads named exports
     statically, and `module.exports = api` gives an importing test nothing but
     a default. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { nextAttempt, upstreamOf, pickAlternate, slicesAlike, retryDelay, lateAttempt, MAX_TRIES, SECOND_DOOR_MS, LATE_TRY_MS };
  }
})();
