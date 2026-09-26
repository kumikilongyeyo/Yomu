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
 *   FIRST     a failed manifest is asked for once more, directly. A source
 *             that answers now was having a moment; its own Try again is
 *             pressed and nothing changes source. (Live, a manifest that the
 *             reader gave up on answered in 259ms seconds later.)
 *
 *   THEN      the other sources that carry this chapter are checked -- the
 *             chapter ledger names them, yomu-integrity.js ranks them
 *             complete-first -- and the best working copy opens, with a note
 *             saying which source it came from.
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
   * The reader URL for a release. HTTP-adapter sources route on
   * "<seriesId>:<chapterId>" -- without the series the reader opens the
   * chapter but cannot find its neighbours -- and MangaDex on the bare id.
   */
  function routeFor(release, seriesId) {
    const provider = String(release?.providerId || '');
    const chapter = String(release?.chapterId || '');
    if (!provider || !chapter) return null;
    const id = provider.startsWith('ext:') && seriesId && !chapter.includes(':') ? `${seriesId}:${chapter}` : chapter;
    return `/read/${encodeURIComponent(id)}?source=${encodeURIComponent(toAppSource(provider))}`;
  }

  /** The chapter id the ledger knows, from a reader route id ("series:chapter" or bare). */
  function ledgerChapterId(routeId) {
    const i = String(routeId).indexOf(':');
    return i > 0 ? String(routeId).slice(i + 1) : String(routeId);
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

  async function findWorkingCopy(state) {
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
    const candidates = (row.releases || [])
      .filter((rel) => String(rel.providerId) !== provider)
      .filter((rel) => { const s = saved.get(toAppSource(String(rel.providerId))); return s && s.enabled !== false; })
      .slice(0, 8);
    if (!candidates.length) return null;

    const checked = window.YomuIntegrity
      ? await window.YomuIntegrity.verifyAll(candidates, verifyOne, { concurrency: 3 })
      : (await Promise.all(candidates.map(verifyOne))).filter(Boolean);
    const best = checked.find((item) => item?.ready)?.release;
    if (!best) return null;
    const seriesId = (ledger.sources || []).find((s) => String(s.providerId) === String(best.providerId))?.seriesId;
    const href = routeFor(best, seriesId);
    return href ? { href, providerName: best.providerName || toAppSource(String(best.providerId)) } : null;
  }

  /* --- telling the reader --------------------------------------------------- */

  function note(text, { busy = false } = {}) {
    let node = document.getElementById('yomu-chapter-switch');
    if (!node) {
      node = document.createElement('div');
      node.id = 'yomu-chapter-switch';
      node.setAttribute('role', 'status');
      Object.assign(node.style, {
        position: 'fixed', left: '50%', top: '42%', transform: 'translate(-50%, -50%)', zIndex: '2147483645',
        maxWidth: 'min(86vw, 380px)', padding: '14px 18px', borderRadius: '16px', textAlign: 'center',
        background: 'rgba(12,14,18,.94)', color: '#f4f6fa', boxShadow: '0 18px 50px rgba(0,0,0,.4)',
        font: '600 14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      });
      document.body.append(node);
    }
    node.textContent = (busy ? '↻  ' : '') + text;
    return node;
  }
  const clearNote = (after = 0) => setTimeout(() => document.getElementById('yomu-chapter-switch')?.remove(), after);

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

  let running = false;

  function go(href) {
    try { performance.mark('reader:chapter-switch'); } catch {}
    location.replace(href);
  }

  async function sourceAnswers(state) {
    const release = { providerId: toProviderId(state.source), chapterId: ledgerChapterId(state.chapterId) };
    if (!manifestUrl(release)) return false;
    const result = await verifyOne(release);
    return !!result.ready;
  }

  async function handleFailure(kind) {
    const state = currentState();
    if (!state || running) return;
    const key = keyOf(state.source, state.chapterId);
    const known = remembered(state.source, state.chapterId);
    const history = tried()[key] || {};
    if (!known && history.searched) return; /* already looked this visit; a reload or a press looks again */
    running = true;
    try {
      const answers = kind === 'manifest' && !known && !history.retried ? await sourceAnswers(state) : false;
      const action = decide({ kind, known, retried: !!history.retried, sourceAnswers: answers });

      if (action === 'switch-known') {
        note(`Opening this chapter from ${known.providerName}…`, { busy: true });
        go(known.href);
        return;
      }
      if (action === 'retry') {
        markTried(key, 'retried');
        const button = document.querySelector('.rd-state--bad .m-btn');
        if (button) { retryingOwn = true; button.click(); retryingOwn = false; }
        return;
      }

      markTried(key, 'searched');
      note('This chapter isn’t loading here. Finding a working copy…', { busy: true });
      const found = await findWorkingCopy(state);
      if (currentState()?.chapterId !== state.chapterId) { clearNote(); return; }
      if (found) {
        remember(state.source, state.chapterId, { ...found, kind });
        note(`Opening this chapter from ${found.providerName}…`, { busy: true });
        go(found.href);
        return;
      }
      note('No other source has a working copy of this chapter right now.');
      clearNote(3200);
    } catch {
      clearNote();
    } finally {
      running = false;
    }
  }

  /* Dead pages: a page index whose image has failed DEAD_AFTER times and is
     still showing nothing a moment later -- by then page rescue has tried both
     proxies and, where it could, another source's copy of that page. */
  const errorsByPage = new Map();
  let pagesFor = '';
  function onImageError(event) {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || !reader()) return;
    const holder = img.closest?.('[data-page-index]');
    if (!holder) return;
    const state = currentState();
    const chapterKey = state ? keyOf(state.source, state.chapterId) : '';
    if (pagesFor !== chapterKey) { pagesFor = chapterKey; errorsByPage.clear(); }
    const index = Number(holder.getAttribute('data-page-index'));
    const count = (errorsByPage.get(index) || 0) + 1;
    errorsByPage.set(index, count);
    if (count < DEAD_AFTER) return;
    setTimeout(() => {
      const still = holder.querySelector('img');
      if (still && still.complete && still.naturalWidth > 0) return;
      const dead = [...errorsByPage.entries()].filter(([, n]) => n >= DEAD_AFTER).map(([i]) => i);
      if (dead.includes(0) || dead.length >= 2) handleFailure('pages');
    }, DEAD_CHECK_MS);
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
      note(`Opening this chapter from ${known.providerName}…`, { busy: true });
      go(known.href);
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
      if (known) { note(`Opening this chapter from ${known.providerName}…`, { busy: true }); go(known.href); }
    }
  }

  /* A chapter whose manifest failed and now opens is not broken any more. One
     whose *pages* died still opens its manifest fine, so that memory is kept
     until it expires. */
  function onReader() {
    const r = reader();
    if (!r || !(r.count > 0)) return;
    if (remembered(r.source, r.chapterId)?.kind === 'manifest') forget(r.source, r.chapterId);
  }

  if (browser) {
    window.YomuChapterSwitch = {
      /** yomu-source-reliability.js asks before running its own reader recovery. */
      owns: () => location.pathname.startsWith('/read/'),
      prune, decide, routeFor, ledgerChapterId,
    };
    addEventListener('error', onImageError, true);
    document.addEventListener('click', onClick, true);
    addEventListener('yomu:reader', onReader);
    new MutationObserver(watch).observe(document.documentElement, { childList: true, subtree: true });
    onArrive();
    watch();
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { prune, decide, routeFor, ledgerChapterId, MEMORY_MS };
  }
})();
