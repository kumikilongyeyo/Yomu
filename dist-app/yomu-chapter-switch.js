/**
 * A chapter that will not open is swapped for one that will.
 *
 * The reader's failure screen (`.rd-state--bad`, "Could not reach the
 * source...", with a Try again that asks the same source again) was a dead end
 * whenever the source was the problem, and the reliability layer only reacted
 * to five exact error phrases -- "Could not reach the source" was not one of
 * them. This file owns reader failures instead, by state rather than wording:
 *
 *   BROKEN    the reader shows its error screen, or chapter images stay dead
 *             after every rescue (the first page, or any two pages).
 *
 *   STALLED   the manifest opened, page images were asked for, and not one
 *             has painted after STALL_MS of visible time. No error event ever
 *             fires for an image that simply hangs, so the two signals above
 *             never see this chapter; it just sits there looking dead. A page
 *             that hangs while its neighbours load is handed to page rescue as
 *             if it had failed, and counts toward BROKEN.
 *
 *   FIRST     a failed manifest is asked for once more, directly. A source
 *             that answers now was having a moment; its own Try again is
 *             pressed and nothing changes source. (Live, a manifest that the
 *             reader gave up on answered in 259ms seconds later.)
 *
 *   THEN      the other sources that carry this chapter are checked -- the
 *             chapter ledger names them, yomu-integrity.js ranks them
 *             complete-first -- and the best working copy opens. When images
 *             are the problem (BROKEN pages, STALLED), a copy only counts if
 *             one of its page images actually decoded: a manifest listing 42
 *             pages on a dead CDN is the failure we are running from.
 *
 *   KEEP      the place. The page and how far into it, as a fraction of the
 *             chapter, travel with the switch and are put back once the new
 *             copy has laid out -- exactly when both copies have the same page
 *             count, by fraction when they slice the strip differently. A
 *             small note says which source it is now; nothing else shows.
 *
 *   REMEMBER  the broken chapter maps to its working copy for 12 hours. Opening
 *             it again, reloading it, or pressing Try again on it switches
 *             straight away instead of failing first.
 *
 * Only sources the reader has saved and not disabled are candidates: the app
 * says "This source was removed" for one it does not know, and a disabled
 * source was disabled on purpose.
 */
(() => {
  'use strict';

  const browser = typeof document !== 'undefined';

  const SWITCH_KEY = 'yomu.v1.chapterSwitch';
  const TRIED_KEY = 'yomu.v1.chapterSwitch.tried';
  const MEMORY_MS = 12 * 60 * 60 * 1000;
  const MAX_ENTRIES = 200;
  /** Image errors on one page before it is a candidate for dead: the original
      and page rescue's cache-bust. (Only extension images get rescue's second
      proxy, so waiting for three would never fire on /api/img pages.) Dead
      means still blank DEAD_CHECK_MS later, after any rescue in flight. */
  const DEAD_AFTER = 2;
  const DEAD_CHECK_MS = 5000;
  /** Visible time with page images requested and none painted before the
      other copies are checked. Checking is silent; a switch also needs a copy
      whose own image loaded while ours did not, so a slow connection (where
      that probe is slow too) never trades one slow copy for another. */
  const STALL_MS = 6000;
  /** One page still loading this long while another page finished after it
      started is hung, not slow. Without that evidence, twice as long, and never
      on a connection that says it is 2G or saving data. */
  const HANG_MS = 15000;
  const HANDOFF_KEY = 'yomu.v1.chapterSwitch.handoff';
  const HANDOFF_MS = 90 * 1000;
  /** A copy found by a stall check that the reader then outgrew is kept this
      long for the dead-page path to use without searching again. */
  const PREFOUND_MS = 2 * 60 * 1000;

  /* --- decisions, pure ------------------------------------------------------ */

  const toProviderId = (id) => (id.startsWith('yomuext-') ? 'ext:' + id.slice(8) : id.startsWith('mihon-') ? 'suwayomi:' + id.slice(6) : id);
  const toAppSource = (id) => (id.startsWith('ext:') ? 'yomuext-' + id.slice(4) : id.startsWith('suwayomi:') ? 'mihon-' + id.slice(9) : id);
  const keyOf = (source, chapterId) => `${source}|${chapterId}`;

  /** Entries younger than MEMORY_MS, newest MAX_ENTRIES. */
  function prune(map, now = Date.now()) {
    const out = {};
    const keys = Object.keys(map || {})
      .filter((k) => map[k] && now - Number(map[k].at || 0) < MEMORY_MS)
      .sort((a, b) => map[b].at - map[a].at)
      .slice(0, MAX_ENTRIES);
    for (const k of keys) out[k] = map[k];
    return out;
  }

  /**
   * What to do about a failure.
   *   kind: 'manifest' (the error screen) | 'pages' (dead images)
   *   known: a remembered working copy, or null
   *   retried: whether this chapter already had its one same-source retry
   *   sourceAnswers: for 'manifest', whether a direct re-fetch just worked
   */
  function decide({ kind, known, retried, sourceAnswers }) {
    if (known) return 'switch-known';
    if (kind === 'manifest' && !retried && sourceAnswers) return 'retry';
    return 'search';
  }

  /**
   * The reader URL for a release. Every adapter routes on
   * "<seriesId>:<chapterId>": the reader takes its series from the part before
   * the colon, MangaDex's getManifest rejects a bare id as malformed, and an
   * HTTP source without its series cannot find the chapter's neighbours. The
   * ledger lists bare ids, so the series goes on here.
   */
  function routeFor(release, seriesId) {
    const provider = String(release?.providerId || '');
    const chapter = String(release?.chapterId || '');
    if (!provider || !chapter) return null;
    const id = seriesId && !chapter.includes(':') ? `${seriesId}:${chapter}` : chapter;
    return `/read/${encodeURIComponent(id)}?source=${encodeURIComponent(toAppSource(provider))}`;
  }

  /** The chapter id the ledger knows, from a reader route id ("series:chapter" or bare). */
  function ledgerChapterId(routeId) {
    const i = String(routeId).indexOf(':');
    return i > 0 ? String(routeId).slice(i + 1) : String(routeId);
  }

  const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

  /**
   * Where a scroll offset sits: the page whose box starts at or above it, and
   * how far into that page, 0-1. `boxes` are { index, top, height }, top-sorted
   * -- the reader's own layout, read off the page holders.
   */
  function positionOf(boxes, top) {
    if (!boxes?.length) return { index: 0, offset: 0 };
    let pick = boxes[0];
    for (const box of boxes) { if (box.top <= top) pick = box; else break; }
    return { index: pick.index, offset: clamp01(pick.height > 0 ? (top - pick.top) / pick.height : 0) };
  }

  /**
   * The same place in a copy with `count` pages. The same count is the same
   * slicing, so the same page; a different count means the strip was cut
   * differently (15, 18 and 49 pages for one chapter on three sites), and only
   * the fraction of the chapter survives.
   */
  function carryPosition(from, count) {
    if (!from || !(from.count > 0) || !(count > 0)) return { index: 0, offset: 0 };
    const offset = clamp01(from.offset);
    if (from.count === count) return { index: Math.min(Math.max(0, from.index | 0), count - 1), offset };
    const at = clamp01((from.index + offset) / from.count) * count;
    const index = Math.min(count - 1, Math.floor(at));
    return { index, offset: clamp01(at - index) };
  }

  /** A chapter whose images were asked for and none has painted. */
  function stalled({ waited, painted, requested }) {
    return !painted && !!requested && waited >= STALL_MS;
  }

  /** One page image that is not coming. See HANG_MS. Restarting a big page
      that was merely slow throws its progress away, so the bar is high. */
  function hung({ waited, loadedSince, slow }) {
    if (waited >= 2 * HANG_MS && loadedSince) return true;
    return !slow && waited >= 4 * HANG_MS;
  }

  /**
   * Which checked copy to open. `checked` is best-first. When the manifest was
   * the problem, the best ready copy. When images were, only a copy with a
   * page that decoded (or MangaDex, trusted without a fetch): a probe that
   * timed out is "unknown", and unknown is how the copy we are leaving looks
   * too. Without the integrity layer there are no probes to ask, and the old
   * rule stands.
   */
  function pickCopy(checked, { strict = false, probed = true, first = false } = {}) {
    const ready = (checked || []).filter((item) => item?.ready);
    if (!strict || !probed) return ready[0] || null;
    /* Proof is a page that decoded -- the first page, for a stall, since that
       is the one not painting. MangaDex is trusted without a fetch elsewhere,
       but trust is not proof, and "unknown" is how the copy we are leaving
       looks too. */
    return ready.find((item) => item.probes?.first?.ok === true || (!first && item.probes?.last?.ok === true)) || null;
  }

  /* --- the device's memory -------------------------------------------------- */

  const readJSON = (store, key, fallback) => {
    try { return JSON.parse(store.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
  };
  const writeJSON = (store, key, value) => { try { store.setItem(key, JSON.stringify(value)); } catch {} };

  function remembered(source, chapterId) {
    return prune(readJSON(localStorage, SWITCH_KEY, {}))[keyOf(source, chapterId)] || null;
  }
  function remember(source, chapterId, target) {
    const map = prune(readJSON(localStorage, SWITCH_KEY, {}));
    map[keyOf(source, chapterId)] = { ...target, at: Date.now() };
    writeJSON(localStorage, SWITCH_KEY, prune(map));
  }
  function forget(source, chapterId) {
    const map = readJSON(localStorage, SWITCH_KEY, {});
    if (map[keyOf(source, chapterId)]) { delete map[keyOf(source, chapterId)]; writeJSON(localStorage, SWITCH_KEY, map); }
  }
  /* Per tab: one search and one retry per chapter, until a reload or a press. */
  const tried = () => readJSON(sessionStorage, TRIED_KEY, {});
  function markTried(key, what) { const t = tried(); t[key] = { ...(t[key] || {}), [what]: Date.now() }; writeJSON(sessionStorage, TRIED_KEY, t); }
  function clearTried(key) { const t = tried(); delete t[key]; writeJSON(sessionStorage, TRIED_KEY, t); }

  /* --- finding a working copy ---------------------------------------------- */

  function collectionSources() {
    return readJSON(localStorage, 'yomu.v1.collection', {})?.sources || [];
  }

  function manifestUrl(release) {
    const provider = String(release?.providerId || '');
    const chapter = encodeURIComponent(String(release?.chapterId || ''));
    if (provider.startsWith('ext:')) return `/api/ext/source/${encodeURIComponent(provider.slice(4))}/chapters/${chapter}/manifest`;
    if (provider.startsWith('suwayomi:')) return `/api/suwayomi/source/${encodeURIComponent(provider.slice(9))}/chapters/${chapter}/manifest`;
    const source = collectionSources().find((s) => String(s?.id) === toAppSource(provider));
    const api = String(source?.url || '').trim();
    if (source?.kind === 'api' && api) return api.replace(/\/?$/, '/') + 'chapters/' + chapter + '/manifest';
    return null;
  }

  async function verifyOne(release) {
    const url = manifestUrl(release);
    if (!url) {
      const native = String(release?.providerId) === 'mangadex' || release?.kind === 'native';
      return { release, ready: native, pageCount: Number(release?.pageCount || 0), trustedNative: native };
    }
    try {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const body = response.ok ? await response.json().catch(() => null) : null;
      const pages = Array.isArray(body?.pages) ? body.pages : [];
      return { release, ready: response.ok && pages.length > 0, pageCount: pages.length, pages };
    } catch {
      return { release, ready: false };
    }
  }

  async function ledgerFor(state) {
    const params = new URLSearchParams();
    const links = readJSON(localStorage, 'yomu.v1.readerContext', {})?.[`${state.source}:${state.chapterId}`]?.links
      || readJSON(localStorage, 'yomu.v1.ledgerLinks', {})?.[`${state.source}:${state.seriesId}`];
    if (Array.isArray(links) && links.length) for (const link of links) params.append('link', String(link));
    else {
      const title = String(document.querySelector('.rd-head__copy h1')?.textContent || '').trim();
      if (!title || /^loading/i.test(title)) return null;
      params.set('title', title);
    }
    params.set('prefer', toProviderId(state.source));
    const response = await fetch(`/api/catalog/chapters?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const body = response.ok ? await response.json().catch(() => null) : null;
    return Array.isArray(body?.rows) ? body : null;
  }

  function chapterNumber() {
    const text = String(document.querySelector('.rd-head__copy p')?.textContent || '');
    const m = text.match(/([0-9]+(?:\.[0-9]+)?)/);
    return m ? Number(m[1]) : null;
  }

  async function findWorkingCopy(state, kind) {
    const ledger = await ledgerFor(state);
    if (!ledger) return null;
    const provider = toProviderId(state.source);
    const bare = ledgerChapterId(state.chapterId);
    let row = ledger.rows.find((r) => (r.releases || []).some((rel) =>
      String(rel.providerId) === provider && (String(rel.chapterId) === bare || String(rel.chapterId) === state.chapterId)));
    const number = chapterNumber();
    if (!row && Number.isFinite(number)) row = ledger.rows.find((r) => Number(r.number) === number);
    if (!row) return null;

    const saved = new Map(collectionSources().filter(Boolean).map((s) => [String(s.id), s]));
    const seriesFor = (rel) => (ledger.sources || []).find((s) => String(s.providerId) === String(rel.providerId))?.seriesId;
    const candidates = (row.releases || [])
      .filter((rel) => String(rel.providerId) !== provider)
      .filter((rel) => { const s = saved.get(toAppSource(String(rel.providerId))); return s && s.enabled !== false; })
      /* Not a copy already known to be broken: A -> B -> A is a loop. */
      .filter((rel) => {
        const k = hrefKey(routeFor(rel, seriesFor(rel)) || '');
        const i = k.indexOf('|');
        return !(i > 0 && remembered(k.slice(0, i), k.slice(i + 1)));
      })
      .slice(0, 8);
    if (!candidates.length) return null;

    const probed = !!window.YomuIntegrity;
    const checked = probed
      ? await window.YomuIntegrity.verifyAll(candidates, verifyOne, { concurrency: 3 })
      : (await Promise.all(candidates.map(verifyOne))).filter(Boolean);
    const best = pickCopy(checked, { strict: kind !== 'manifest', probed, first: kind === 'stall' })?.release;
    if (!best) return null;
    const seriesId = seriesFor(best);
    const href = routeFor(best, seriesId);
    return href ? { href, providerName: best.providerName || toAppSource(String(best.providerId)) } : null;
  }

  /* --- telling the reader --------------------------------------------------- *
   *
   * As little as possible. A switch that works shows the new copy and one
   * small line saying where it came from. While the error screen is being
   * recovered, its message and its Try again are hidden (they would be wrong
   * in a second) and a quiet line appears only if the search takes a while.
   * A stall is recovered with nothing on screen at all. The only thing that
   * interrupts is every source having failed.
   */

  function pill(text, ms = 0) {
    let node = document.getElementById('yomu-chapter-switch');
    if (!node) {
      node = document.createElement('div');
      node.id = 'yomu-chapter-switch';
      node.setAttribute('role', 'status');
      Object.assign(node.style, {
        position: 'fixed', left: '50%', bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))', transform: 'translateX(-50%)',
        zIndex: '9999', maxWidth: 'min(88vw, 420px)', padding: '8px 14px', borderRadius: '999px', textAlign: 'center',
        background: 'rgba(12,14,18,.9)', color: '#f4f6fa', boxShadow: '0 8px 28px rgba(0,0,0,.3)', pointerEvents: 'none',
        font: '600 12.5px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', transition: 'opacity .4s',
      });
      document.body.append(node);
    }
    clearTimeout(pill.timer);
    node.style.opacity = '1';
    node.textContent = text;
    if (ms > 0) pill.timer = setTimeout(clearPill, ms);
    return node;
  }
  function clearPill() {
    const node = document.getElementById('yomu-chapter-switch');
    if (!node) return;
    node.style.opacity = '0';
    setTimeout(() => { if (node.style.opacity === '0') node.remove(); }, 450);
  }

  let recoveringTimer = null;
  function recovering(on) {
    const root = document.documentElement;
    clearTimeout(recoveringTimer);
    if (!on) { root.removeAttribute('data-yomu-recovering'); return; }
    if (!document.getElementById('yomu-chapter-switch-style')) {
      const style = document.createElement('style');
      style.id = 'yomu-chapter-switch-style';
      style.textContent = 'html[data-yomu-recovering] .rd-stage .rd-state--bad{visibility:hidden}';
      document.head.append(style);
    }
    root.setAttribute('data-yomu-recovering', '');
    recoveringTimer = setTimeout(() => pill('Finding a working copy…'), 1200);
  }

  /* --- the flow ------------------------------------------------------------- */

  const reader = () => (browser && location.pathname.startsWith('/read/') ? globalThis.__yomuReader : null);

  function currentState() {
    const params = new URLSearchParams(location.search);
    const source = params.get('source') || '';
    let chapterId = location.pathname.slice('/read/'.length);
    try { chapterId = decodeURIComponent(chapterId); } catch {}
    if (!source || !chapterId) return null;
    const i = chapterId.indexOf(':');
    return { source, chapterId, seriesId: i > 0 ? chapterId.slice(0, i) : (reader()?.seriesId || '') };
  }

  /** The chapter key a reader href opens. */
  function hrefKey(href) {
    try {
      const url = new URL(href, location.href);
      let id = url.pathname.slice('/read/'.length);
      try { id = decodeURIComponent(id); } catch {}
      return keyOf(url.searchParams.get('source') || '', id);
    } catch { return ''; }
  }

  /* Visited reader screens stay mounted at zero height, so "the" strip is the
     one with a size. */
  function scroller() {
    for (const el of document.querySelectorAll('[data-testid="reader-scroll"]')) if (el.clientHeight > 0) return el;
    return null;
  }

  /** Where the reader is now, for the next copy: { index, offset, count }. */
  function capturePosition() {
    const r = reader();
    const el = scroller();
    if (r?.mode === 'page' && r.count > 0) return { index: r.page, offset: 0, count: r.count };
    if (!r || !(r.count > 0) || !el) return null;
    const boxes = [...el.querySelectorAll('[data-page-index]')]
      .map((node) => ({ index: Number(node.getAttribute('data-page-index')), top: node.offsetTop, height: node.offsetHeight }))
      .filter((box) => Number.isInteger(box.index))
      .sort((a, b) => a.top - b.top);
    const at = positionOf(boxes, el.scrollTop);
    return { ...at, count: r.count };
  }

  let running = false;

  /**
   * Leave for another copy, taking the place along. A chapter that failed
   * before it laid out has no place of its own; if it was itself the target
   * of a switch, the place that switch carried is still the reader's.
   */
  function go(href, providerName) {
    try { performance.mark('reader:chapter-switch'); } catch {}
    const state = currentState();
    const prior = readJSON(sessionStorage, HANDOFF_KEY, null);
    const inherited = prior && Date.now() - Number(prior.at || 0) < HANDOFF_MS && state && prior.to === keyOf(state.source, state.chapterId)
      ? prior.position : null;
    writeJSON(sessionStorage, HANDOFF_KEY, {
      to: hrefKey(href), providerName: providerName || '', position: capturePosition() || inherited || null, at: Date.now(),
    });
    /* Through the app's router, not a page load: no reload, no new shell, the
       handoff read back in memory. A page load is the fallback, and it works
       for slash ids too (worker/asset-path.ts). See patch-bundle.mjs, "a Save
       button that saves, and the router published". */
    const router = reader() ? globalThis.__yomuRouter : null;
    if (router?.replace) {
      recovering(false);
      clearPill();
      try { router.replace(href); return; } catch {}
    }
    location.replace(href);
  }

  async function sourceAnswers(state) {
    const release = { providerId: toProviderId(state.source), chapterId: ledgerChapterId(state.chapterId) };
    if (!manifestUrl(release)) return false;
    const result = await verifyOne(release);
    return !!result.ready;
  }

  /* A stall check whose chapter then started painting leaves its answer here. */
  let prefound = null;

  async function handleFailure(kind) {
    const state = currentState();
    if (!state || running) return;
    const key = keyOf(state.source, state.chapterId);
    const known = remembered(state.source, state.chapterId);
    const history = tried()[key] || {};
    if (!known && history.searched) return; /* already looked this visit; a reload or a press looks again */
    /* A copy we just switched to that stalls too says the link is slow, not
       the copy: hopping again would only restart every download. */
    if (kind === 'stall' && (arrivedKey === key || slowLink())) return;
    running = true;
    const loud = kind === 'manifest';
    try {
      const answers = kind === 'manifest' && !known && !history.retried ? await sourceAnswers(state) : false;
      const action = decide({ kind, known, retried: !!history.retried, sourceAnswers: answers });

      if (action === 'switch-known') { go(known.href, known.providerName); return; }
      if (action === 'retry') {
        markTried(key, 'retried');
        const button = document.querySelector('.rd-state--bad .m-btn');
        if (button) { retryingOwn = true; button.click(); retryingOwn = false; }
        return;
      }

      let found = prefound && prefound.key === key && Date.now() - prefound.at < PREFOUND_MS ? prefound.found : null;
      prefound = null;
      if (!found) {
        if (loud) recovering(true);
        found = await findWorkingCopy(state, kind);
      }
      if (currentState()?.chapterId !== state.chapterId) { recovering(false); clearPill(); return; }
      /* The chapter came alive while we looked: keep the answer for later
         instead of pulling the reader off a strip that is now working. */
      if (kind === 'stall' && painting.key === key && painting.painted) {
        if (found) prefound = { key, found, at: Date.now() };
        return;
      }
      markTried(key, 'searched');
      if (found) {
        remember(state.source, state.chapterId, { ...found, kind });
        go(found.href, found.providerName);
        return;
      }
      recovering(false);
      if (loud || kind === 'pages') pill('No other source has a working copy of this chapter right now.', 3200);
    } catch {
      recovering(false);
      clearPill();
    } finally {
      running = false;
    }
  }

  /* Dead pages: a page index whose image has failed DEAD_AFTER times and is
     still showing nothing a moment later -- by then page rescue has tried both
     proxies and, where it could, another source's copy of that page. A hung
     image counts as a failure here too (see watchdog). */
  const errorsByPage = new Map();
  let pagesFor = '';
  function countFailure(holder) {
    const state = currentState();
    const chapterKey = state ? keyOf(state.source, state.chapterId) : '';
    if (pagesFor !== chapterKey) { pagesFor = chapterKey; errorsByPage.clear(); }
    const index = Number(holder.getAttribute('data-page-index'));
    const count = (errorsByPage.get(index) || 0) + 1;
    errorsByPage.set(index, count);
    if (count < DEAD_AFTER) return;
    setTimeout(() => {
      /* The reader may have moved on (or been switched) in the meantime. */
      const now = currentState();
      if (!now || keyOf(now.source, now.chapterId) !== chapterKey || !holder.isConnected) return;
      const still = holder.querySelector('img');
      if (still && still.complete && still.naturalWidth > 0) return;
      const dead = [...errorsByPage.entries()].filter(([, n]) => n >= DEAD_AFTER).map(([i]) => i);
      if (dead.includes(0) || dead.length >= 2) handleFailure('pages');
    }, DEAD_CHECK_MS);
  }
  function onImageError(event) {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || !reader()) return;
    const holder = img.closest?.('[data-page-index]');
    if (holder) countFailure(holder);
  }

  /* --- the watchdog --------------------------------------------------------- *
   *
   * Errors are what a broken image says. A hung one says nothing: the request
   * never finishes, the reader's page stays "loading", and neither the error
   * screen nor the dead-page count ever moves. So the watchdog measures the
   * thing the reader actually wants -- a page that painted -- and counts only
   * time the tab was visible and online, so a phone in a pocket is not a stall.
   */

  const painting = { key: '', painted: false, waited: 0, lastLoad: 0 };
  const hangs = new WeakMap();
  let lastTick = 0;

  const pageImages = (el) => (el ? el.querySelectorAll('[data-page-index] img') : []);
  const isPainted = (img) => img.complete && img.naturalWidth > 0;
  const slowLink = () => {
    const c = navigator.connection;
    return !!c && (c.saveData || /(^|-)2g$/.test(String(c.effectiveType || '')));
  };

  /** A new chapter starts a new clock. Images can load before the first tick sees it. */
  function track(key) {
    if (painting.key !== key) Object.assign(painting, { key, painted: false, waited: 0, lastLoad: 0 });
  }

  function onImageLoad(event) {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || !reader() || !(img.naturalWidth > 0)) return;
    if (!img.closest?.('[data-page-index]')) return;
    const state = currentState();
    if (!state) return;
    track(keyOf(state.source, state.chapterId));
    painting.painted = true;
    painting.lastLoad = performance.now();
    if (arrival && arrival.key === painting.key) announce();
  }

  function tick() {
    const now = performance.now();
    const dt = lastTick ? Math.min(now - lastTick, 2000) : 0;
    lastTick = now;
    const r = reader();
    const state = r && r.count > 0 ? currentState() : null;
    if (!state) return;
    const key = keyOf(state.source, state.chapterId);
    track(key);
    if (document.visibilityState !== 'visible' || navigator.onLine === false) return;

    const images = [...pageImages(scroller())];
    if (!painting.painted && images.some(isPainted)) painting.painted = true;
    if (painting.painted && arrival?.key === key) announce();
    const requested = images.some((img) => img.getAttribute('src'));
    if (!painting.painted && requested) painting.waited += dt;
    if (stalled({ waited: painting.waited, painted: painting.painted, requested })) {
      painting.waited = -Infinity; /* once per chapter visit */
      try { performance.mark('reader:stall'); } catch {}
      handleFailure('stall');
    }

    /* Hung pages, each on its own clock. */
    const slow = slowLink();
    for (const img of images) {
      const src = img.getAttribute('src') || '';
      if (!src || img.complete) { hangs.delete(img); continue; }
      let t = hangs.get(img);
      if (!t || t.src !== src) { t = { src, since: now, waited: 0, handled: false }; hangs.set(img, t); }
      t.waited += dt;
      if (t.handled || !hung({ waited: t.waited, loadedSince: painting.lastLoad > t.since, slow })) continue;
      t.handled = true;
      try { performance.mark('image:hung'); } catch {}
      const holder = img.closest('[data-page-index]');
      /* Page rescue's next door for this image (a new src cancels the hung
         request), and one mark toward dead for the whole-chapter path. */
      window.YomuPageRescue?.__rescue?.(img);
      if (holder) countFailure(holder);
      /* No door left on this source (the src did not move): as good as a second failure. */
      if (holder && img.getAttribute('src') === src) countFailure(holder);
    }
  }

  /* --- arriving on the new copy --------------------------------------------- */

  let arrival = null;
  /** The chapter the last switch landed on. */
  let arrivedKey = '';

  function announce() {
    const a = arrival;
    arrival = null;
    if (a?.name) pill(`Switched to ${a.name} to keep reading`, 2200);
  }

  /**
   * Put the reader back where it was. Waits for the new strip to lay out, sets
   * the place, and re-checks twice in case the reader's own restore landed
   * after us -- but never once the reader has touched anything.
   */
  function restore(position) {
    if (!position || (position.index === 0 && position.offset < 0.02)) return;
    const started = performance.now();
    let touched = false;
    const touch = () => { touched = true; };
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) addEventListener(type, touch, { capture: true, passive: true, once: true });
    const target = () => {
      const r = reader();
      const el = scroller();
      if (!r || !(r.count > 0)) return null;
      if (r.mode === "page") return { paged: carryPosition(position, r.count).index };
      if (!el || !el.clientWidth) return null;
      const want = carryPosition(position, r.count);
      const box = el.querySelector(`[data-page-index="${want.index}"]`);
      return box ? { el, top: box.offsetTop + want.offset * box.offsetHeight } : null;
    };
    const apply = (slack) => {
      const t = target();
      if (!t) return false;
      if (t.paged != null) { dispatchEvent(new CustomEvent("yomu:seek-page", { detail: t.paged })); return true; }
      if (Math.abs(t.el.scrollTop - t.top) > slack(t.el)) t.el.scrollTop = t.top;
      return true;
    };
    const attempt = () => {
      if (touched) return;
      if (apply(() => 2)) {
        try { performance.mark('reader:chapter-switch:restored'); } catch {}
        for (const ms of [350, 1200]) setTimeout(() => { if (!touched) apply((el) => el.clientHeight / 2); }, ms);
        return;
      }
      if (performance.now() - started < 8000) requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  }

  function onArrival() {
    const state = currentState();
    const r = reader();
    if (!state || !r || !(r.count > 0)) return;
    const handoff = readJSON(sessionStorage, HANDOFF_KEY, null);
    if (!handoff) return;
    const key = keyOf(state.source, state.chapterId);
    if (Date.now() - Number(handoff.at || 0) > HANDOFF_MS) { try { sessionStorage.removeItem(HANDOFF_KEY); } catch {} return; }
    if (handoff.to !== key) return;
    try { sessionStorage.removeItem(HANDOFF_KEY); } catch {}
    arrival = { key, name: handoff.providerName };
    arrivedKey = key;
    restore(handoff.position);
    if (painting.key === key && painting.painted) announce();
  }

  /* The error screen, by state. */
  let lastError = '';
  function watch() {
    const bad = document.querySelector('.rd-stage .rd-state--bad');
    const state = currentState();
    const key = bad && state ? keyOf(state.source, state.chapterId) : '';
    if (key && key !== lastError) { lastError = key; setTimeout(() => handleFailure('manifest'), 250); }
    if (!bad) lastError = '';
  }

  /* Try again on a chapter already known to be broken goes to the working
     copy; otherwise it is a fresh start for this chapter's one search. */
  let retryingOwn = false;
  function onClick(event) {
    const button = event.target?.closest?.('.rd-state--bad .m-btn');
    if (!button || retryingOwn) return;
    const state = currentState();
    if (!state) return;
    const known = remembered(state.source, state.chapterId);
    if (known) {
      event.preventDefault();
      event.stopImmediatePropagation();
      go(known.href, known.providerName);
      return;
    }
    clearTried(keyOf(state.source, state.chapterId));
    lastError = '';
  }

  /* A reload of a chapter known to be broken goes straight to the working copy. */
  function onArrive() {
    const state = currentState();
    if (!state) return;
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    if (nav?.type === 'reload') {
      clearTried(keyOf(state.source, state.chapterId));
      const known = remembered(state.source, state.chapterId);
      if (known) go(known.href, known.providerName);
    }
  }

  /* A chapter whose manifest failed and now opens is not broken any more. One
     whose *pages* died (or stalled) still opens its manifest fine, so that
     memory is kept until it expires. */
  let ticking = null;
  function onReader() {
    const r = reader();
    if (!r || !(r.count > 0)) return;
    if (remembered(r.source, r.chapterId)?.kind === 'manifest') forget(r.source, r.chapterId);
    onArrival();
    ticking ||= setInterval(tick, 1000);
  }

  if (browser) {
    window.YomuChapterSwitch = {
      /** yomu-source-reliability.js asks before running its own reader recovery. */
      owns: () => location.pathname.startsWith('/read/'),
      prune, decide, routeFor, ledgerChapterId, positionOf, carryPosition, stalled, hung, pickCopy,
      /** For the console: where a switch would carry the reader right now. */
      position: capturePosition,
      /** Open another copy of this chapter, keeping the place (source-auto-switch.js's picker). */
      open: (href, providerName) => go(href, providerName),
    };
    addEventListener('error', onImageError, true);
    addEventListener('load', onImageLoad, true);
    document.addEventListener('click', onClick, true);
    addEventListener('yomu:reader', onReader);
    new MutationObserver(watch).observe(document.documentElement, { childList: true, subtree: true });
    onArrive();
    watch();
    onReader(); /* loaded after the reader's last render: do not wait for the next */
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { prune, decide, routeFor, ledgerChapterId, positionOf, carryPosition, stalled, hung, pickCopy, MEMORY_MS, STALL_MS, HANG_MS };
  }
})();
