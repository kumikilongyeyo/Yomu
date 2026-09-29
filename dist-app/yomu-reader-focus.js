/**
 * Yomu Reader Focus
 *
 * Proactive reliability layer for the reader. The existing continuity stack
 * remains the source of truth for exact chapter/source switching; this file
 * makes it act sooner by warming compatible backups, rescuing visible hung
 * pages aggressively, avoiding recently sick providers, and prefetching just
 * enough of the current/next chapter to keep scrolling smooth.
 */
(() => {
  'use strict';

  const browser = typeof document !== 'undefined';
  const CIRCUIT_KEY = 'yomu.v1.readerFocus.circuit';
  const CIRCUIT_WINDOW_MS = 60_000;
  const CIRCUIT_OPEN_MS = 4 * 60_000;
  const PAGE_FAIL_LIMIT = 3;
  const MANIFEST_FAIL_LIMIT = 2;
  const WARM_TTL_MS = 2 * 60_000;
  const VISIBLE_HANG_MS = 9_000;
  const SLOW_VISIBLE_HANG_MS = 18_000;
  const ALT_SWAP_GRACE_MS = 850;
  const WHOLE_SWITCH_GRACE_MS = 2_000;
  const NEXT_CHAPTER_AT = 0.72;

  const readJSON = (store, key, fallback) => {
    try { return JSON.parse(store.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
  };
  const writeJSON = (store, key, value) => {
    try { store.setItem(key, JSON.stringify(value)); } catch {}
  };
  const toProviderId = (id) => String(id || '').startsWith('yomuext-')
    ? 'ext:' + String(id).slice(8)
    : String(id || '').startsWith('mihon-') ? 'suwayomi:' + String(id).slice(6) : String(id || '');
  const toAppSource = (id) => String(id || '').startsWith('ext:')
    ? 'yomuext-' + String(id).slice(4)
    : String(id || '').startsWith('suwayomi:') ? 'mihon-' + String(id).slice(9) : String(id || '');
  const keyOf = (source, chapterId) => `${source}|${chapterId}`;

  function connectionSlow() {
    const c = navigator.connection;
    return !!c && (c.saveData || /(^|-)2g$/.test(String(c.effectiveType || '')));
  }

  function pruneTimes(values, now = Date.now()) {
    return (Array.isArray(values) ? values : []).filter((at) => now - Number(at || 0) < CIRCUIT_WINDOW_MS);
  }

  function shouldOpenCircuit(entry, now = Date.now()) {
    if (!entry) return false;
    const page = pruneTimes(entry.page, now);
    const manifest = pruneTimes(entry.manifest, now);
    return page.length >= PAGE_FAIL_LIMIT || manifest.length >= MANIFEST_FAIL_LIMIT;
  }

  function circuits(now = Date.now()) {
    const map = readJSON(sessionStorage, CIRCUIT_KEY, {});
    for (const [provider, entry] of Object.entries(map)) {
      entry.page = pruneTimes(entry.page, now);
      entry.manifest = pruneTimes(entry.manifest, now);
      if (Number(entry.openUntil || 0) <= now && !entry.page.length && !entry.manifest.length) delete map[provider];
    }
    writeJSON(sessionStorage, CIRCUIT_KEY, map);
    return map;
  }

  function circuitOpen(provider, now = Date.now()) {
    const entry = circuits(now)[String(provider || '')];
    return !!entry && Number(entry.openUntil || 0) > now;
  }

  function recordFailure(provider, kind, now = Date.now()) {
    provider = String(provider || '');
    if (!provider) return;
    const map = circuits(now);
    const entry = map[provider] || { page: [], manifest: [], openUntil: 0 };
    entry.page = pruneTimes(entry.page, now);
    entry.manifest = pruneTimes(entry.manifest, now);
    const bucket = kind === 'manifest' ? 'manifest' : 'page';
    entry[bucket].push(now);
    if (shouldOpenCircuit(entry, now)) entry.openUntil = Math.max(Number(entry.openUntil || 0), now + CIRCUIT_OPEN_MS);
    map[provider] = entry;
    writeJSON(sessionStorage, CIRCUIT_KEY, map);
    try { performance.mark(`reader-focus:circuit:${bucket}`); } catch {}
  }

  function recordSuccess(provider, kind, now = Date.now()) {
    provider = String(provider || '');
    if (!provider) return;
    const map = circuits(now);
    const entry = map[provider];
    if (!entry) return;
    const bucket = kind === 'manifest' ? 'manifest' : 'page';
    entry[bucket] = pruneTimes(entry[bucket], now).slice(-1);
    if (Number(entry.openUntil || 0) <= now) entry.openUntil = 0;
    map[provider] = entry;
    writeJSON(sessionStorage, CIRCUIT_KEY, map);
  }

  function currentState() {
    if (!browser || !location.pathname.startsWith('/read/')) return null;
    const source = new URLSearchParams(location.search).get('source') || '';
    let chapterId = location.pathname.slice('/read/'.length);
    try { chapterId = decodeURIComponent(chapterId); } catch {}
    if (!source || !chapterId) return null;
    const i = chapterId.indexOf(':');
    const reader = globalThis.__yomuReader;
    return {
      source,
      provider: toProviderId(source),
      chapterId,
      seriesId: i > 0 ? chapterId.slice(0, i) : String(reader?.seriesId || ''),
      key: keyOf(source, chapterId),
    };
  }

  function collectionSources() {
    return readJSON(localStorage, 'yomu.v1.collection', {})?.sources || [];
  }

  function manifestUrl(release) {
    const provider = String(release?.providerId || '');
    const chapter = encodeURIComponent(String(release?.chapterId || ''));
    if (!provider || !chapter) return null;
    if (provider.startsWith('ext:')) return `/api/ext/source/${encodeURIComponent(provider.slice(4))}/chapters/${chapter}/manifest`;
    if (provider.startsWith('suwayomi:')) return `/api/suwayomi/source/${encodeURIComponent(provider.slice(9))}/chapters/${chapter}/manifest`;
    const source = collectionSources().find((s) => String(s?.id || '') === toAppSource(provider));
    const api = String(source?.url || '').trim();
    if (source?.kind === 'api' && api) return api.replace(/\/?$/, '/') + 'chapters/' + chapter + '/manifest';
    return null;
  }

  function chapterNumber() {
    const text = String(document.querySelector('.rd-head__copy p')?.textContent || '');
    const m = text.match(/(?:chapter|ch\.?|episode|ep\.?)\s*([0-9]+(?:\.[0-9]+)?)/i) || text.match(/([0-9]+(?:\.[0-9]+)?)/);
    return m ? Number(m[1]) : null;
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
    params.set('prefer', state.provider);
    try {
      const response = await fetch(`/api/catalog/chapters?${params}`, {
        cache: 'no-store', headers: { 'x-yomu-quiet': '1' }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const body = await response.json().catch(() => null);
      return body && Array.isArray(body.rows) ? body : null;
    } catch { return null; }
  }

  function currentRow(ledger, state) {
    if (!ledger?.rows) return null;
    const bare = String(state.chapterId).includes(':')
      ? String(state.chapterId).slice(String(state.chapterId).indexOf(':') + 1)
      : String(state.chapterId);
    let row = ledger.rows.find((r) => (r.releases || []).some((rel) =>
      String(rel.providerId) === state.provider
      && (String(rel.chapterId) === bare || String(rel.chapterId) === state.chapterId)));
    const number = chapterNumber();
    if (!row && Number.isFinite(number)) row = ledger.rows.find((r) => Number(r.number) === number);
    return row || null;
  }

  function seriesFor(ledger, release) {
    return String((ledger?.sources || []).find((s) => String(s.providerId) === String(release?.providerId))?.seriesId || '');
  }

  function releaseRoute(ledger, release) {
    const seriesId = seriesFor(ledger, release);
    const switcher = window.YomuChapterSwitch;
    if (switcher?.routeFor) return switcher.routeFor(release, seriesId);
    const chapter = String(release?.chapterId || '');
    if (!chapter) return null;
    const id = seriesId && !chapter.includes(':') ? `${seriesId}:${chapter}` : chapter;
    return `/read/${encodeURIComponent(id)}?source=${encodeURIComponent(toAppSource(String(release.providerId || '')))}`;
  }

  function pagesAlike(ours, theirs, oursProvider, theirsProvider) {
    if (!Array.isArray(ours) || !Array.isArray(theirs) || !ours.length || ours.length !== theirs.length) return false;
    const hashed = ours.every((p) => p?.contentHash) && theirs.every((p) => p?.contentHash);
    if (hashed) return ours.every((p, i) => p.contentHash === theirs[i].contentHash);
    return window.YomuIntegrity?.sameSlicing?.(oursProvider, theirsProvider) === true;
  }

  function imageProbe(url, timeout = 5_500) {
    return new Promise((resolve) => {
      if (!url) { resolve(false); return; }
      const img = new Image();
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeout);
      img.decoding = 'async';
      img.onload = () => finish(img.naturalWidth > 0);
      img.onerror = () => finish(false);
      img.src = url;
    });
  }

  let warm = null;
  let warming = null;
  let warmTimer = 0;
  let switchedFor = '';
  const prefetched = new Set();
  const hangs = new WeakMap();
  let lastTick = performance.now();
  let nextWarmedFor = '';

  function warmValid(state) {
    return warm && warm.key === state?.key && Date.now() - warm.at < WARM_TTL_MS;
  }

  async function fetchManifest(release) {
    const provider = String(release?.providerId || '');
    if (circuitOpen(provider)) return null;
    const url = manifestUrl(release);
    if (!url) {
      if (provider === 'mangadex' || release?.kind === 'native') {
        return { release, pages: [], native: true, ready: true, proven: true };
      }
      return null;
    }
    const started = performance.now();
    try {
      const response = await fetch(url, {
        cache: 'no-store', headers: { 'x-yomu-quiet': '1' }, signal: AbortSignal.timeout(7_500),
      });
      const body = response.ok ? await response.json().catch(() => null) : null;
      const pages = Array.isArray(body?.pages) ? body.pages : [];
      if (!response.ok || !pages.length) {
        recordFailure(provider, 'manifest');
        return null;
      }
      recordSuccess(provider, 'manifest');
      return { release, pages, ready: true, ms: performance.now() - started };
    } catch {
      recordFailure(provider, 'manifest');
      return null;
    }
  }

  async function warmBackups(force = false) {
    const state = currentState();
    const reader = globalThis.__yomuReader;
    if (!state || !reader || !(reader.count > 0)) return null;
    if (!force && warmValid(state)) return warm;
    if (warming?.key === state.key) return warming.promise;

    const promise = (async () => {
      const ledger = await ledgerFor(state);
      const row = currentRow(ledger, state);
      if (!ledger || !row) return null;
      const enabled = new Set(collectionSources().filter((s) => s && s.enabled !== false).map((s) => String(s.id || '')));
      const candidates = (row.releases || [])
        .filter((rel) => String(rel.providerId || '') !== state.provider)
        .filter((rel) => enabled.has(toAppSource(String(rel.providerId || ''))))
        .filter((rel) => !circuitOpen(String(rel.providerId || '')))
        .slice(0, 6);

      const checked = (await Promise.all(candidates.map(fetchManifest))).filter(Boolean);
      const health = window.YomuIntegrity?.health;
      checked.sort((a, b) => {
        const ah = health ? Number(health(String(a.release.providerId)) || 0) : 0;
        const bh = health ? Number(health(String(b.release.providerId)) || 0) : 0;
        if (Math.abs(bh - ah) > 0.01) return bh - ah;
        return Number(a.ms || Infinity) - Number(b.ms || Infinity);
      });

      const currentPages = Array.isArray(reader.pages) ? reader.pages : [];
      for (const item of checked) {
        item.href = releaseRoute(ledger, item.release);
        item.providerId = String(item.release.providerId || '');
        item.providerName = String(item.release.providerName || toAppSource(item.providerId));
        item.compatible = pagesAlike(currentPages, item.pages, state.provider, item.providerId);
      }

      const probeCount = connectionSlow() ? 1 : 2;
      for (const item of checked.slice(0, probeCount)) {
        if (!item.pages?.[0]?.url) continue;
        item.proven = await imageProbe(item.pages[0].url);
        if (item.proven) recordSuccess(item.providerId, 'page');
        else recordFailure(item.providerId, 'page');
      }

      const compatible = checked.find((item) => item.compatible && item.proven !== false) || null;
      const whole = checked.find((item) => item.href && item.proven === true)
        || checked.find((item) => item.href && item.ready) || null;
      warm = { key: state.key, at: Date.now(), state, ledger, row, checked, compatible, whole };
      try { performance.mark('reader-focus:warm-ready'); } catch {}
      return warm;
    })().finally(() => { if (warming?.key === state.key) warming = null; });

    warming = { key: state.key, promise };
    return promise;
  }

  function scheduleWarm(force = false) {
    clearTimeout(warmTimer);
    warmTimer = setTimeout(() => {
      const run = () => warmBackups(force).catch(() => null);
      if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1400 });
      else run();
    }, force ? 50 : 700);
  }

  function activeStage() {
    const scroll = [...document.querySelectorAll('[data-testid="reader-scroll"]')].find((el) => el.clientHeight > 0);
    if (scroll) return scroll;
    return [...document.querySelectorAll('[data-testid="reader-paged"]')].find((el) => el.clientHeight > 0) || null;
  }

  function visible(holder) {
    if (!holder?.getBoundingClientRect) return false;
    const r = holder.getBoundingClientRect();
    return r.bottom > -120 && r.top < innerHeight + 120;
  }

  function pageIndex(img) {
    const holder = img?.closest?.('[data-page-index]');
    const index = Number(holder?.getAttribute('data-page-index'));
    return Number.isInteger(index) ? index : -1;
  }

  function fastAlternate(img, state, delay = ALT_SWAP_GRACE_MS) {
    const index = pageIndex(img);
    const backup = warmValid(state) ? warm?.compatible : null;
    const url = backup?.pages?.[index]?.url;
    if (!url || !img?.isConnected) return false;
    setTimeout(() => {
      const now = currentState();
      if (!now || now.key !== state.key || !img.isConnected) return;
      if (img.complete && img.naturalWidth > 0) return;
      img.dataset.yomuFocusSwap = backup.providerId;
      img.dataset.yomuRescue = 'pending';
      img.src = url;
      try { performance.mark('reader-focus:page-swap'); } catch {}
    }, delay);
    return true;
  }

  function wholeFallback(state, delay = WHOLE_SWITCH_GRACE_MS) {
    const backup = warmValid(state) ? warm?.whole : null;
    if (!backup?.href || switchedFor === state.key) return false;
    switchedFor = state.key;
    setTimeout(() => {
      const now = currentState();
      if (!now || now.key !== state.key) return;
      const stage = activeStage();
      const hasBlankVisible = [...(stage?.querySelectorAll('[data-page-index] img') || [])]
        .some((img) => visible(img.closest('[data-page-index]')) && !(img.complete && img.naturalWidth > 0));
      if (!hasBlankVisible) { switchedFor = ''; return; }
      window.YomuChapterSwitch?.open?.(backup.href, backup.providerName);
      try { performance.mark('reader-focus:whole-switch'); } catch {}
    }, delay);
    return true;
  }

  function prefetchAhead() {
    const state = currentState();
    const reader = globalThis.__yomuReader;
    if (!state || !reader || !(reader.count > 0) || !Array.isArray(reader.pages)) return;
    let index = Number(reader.page || 0);
    try {
      const pos = window.YomuChapterSwitch?.position?.();
      if (Number.isInteger(pos?.index)) index = pos.index;
    } catch {}
    const coarse = matchMedia?.('(pointer: coarse)')?.matches || navigator.maxTouchPoints > 0;
    const ahead = connectionSlow() ? 1 : coarse ? 2 : 4;
    for (let i = Math.max(0, index); i <= Math.min(reader.pages.length - 1, index + ahead); i++) {
      const url = reader.pages[i]?.url;
      if (!url || prefetched.has(url)) continue;
      prefetched.add(url);
      const img = new Image();
      img.decoding = 'async';
      img.fetchPriority = i === index ? 'high' : 'low';
      img.src = url;
    }

    const pos = window.YomuChapterSwitch?.position?.();
    const progress = pos?.count > 0 ? Math.min(1, (Number(pos.index || 0) + Number(pos.offset || 0) + 1) / pos.count) : 0;
    if (progress >= NEXT_CHAPTER_AT) warmNextChapter(state).catch(() => null);
  }

  async function warmNextChapter(state) {
    if (!warmValid(state)) await warmBackups();
    if (!warm?.ledger || nextWarmedFor === state.key) return;
    const currentNum = Number(warm.row?.number ?? chapterNumber());
    if (!Number.isFinite(currentNum)) return;
    const rows = warm.ledger.rows.filter((r) => Number.isFinite(Number(r.number)) && Number(r.number) > currentNum)
      .sort((a, b) => Number(a.number) - Number(b.number));
    const next = rows[0];
    if (!next) return;
    const preferred = (next.releases || []).find((rel) => String(rel.providerId || '') === state.provider && !circuitOpen(state.provider))
      || (next.releases || []).find((rel) => !circuitOpen(String(rel.providerId || '')));
    if (!preferred) return;
    nextWarmedFor = state.key;
    const item = await fetchManifest(preferred);
    if (item?.pages?.[0]?.url) {
      const img = new Image();
      img.decoding = 'async';
      img.fetchPriority = 'low';
      img.src = item.pages[0].url;
      try { performance.mark('reader-focus:next-chapter-warm'); } catch {}
    }
  }

  function tick() {
    const now = performance.now();
    const dt = Math.min(2000, Math.max(0, now - lastTick));
    lastTick = now;
    const state = currentState();
    const reader = globalThis.__yomuReader;
    if (!state || !reader || !(reader.count > 0)) return;

    if (!warmValid(state)) scheduleWarm(false);
    prefetchAhead();
    if (document.visibilityState !== 'visible' || navigator.onLine === false) return;

    const stage = activeStage();
    if (!stage) return;
    const threshold = connectionSlow() ? SLOW_VISIBLE_HANG_MS : VISIBLE_HANG_MS;
    for (const img of stage.querySelectorAll('[data-page-index] img')) {
      const src = img.getAttribute('src') || '';
      if (!src || (img.complete && img.naturalWidth > 0)) { hangs.delete(img); continue; }
      let h = hangs.get(img);
      if (!h || h.src !== src) { h = { src, waited: 0, acted: false }; hangs.set(img, h); }
      if (!visible(img.closest('[data-page-index]'))) continue;
      h.waited += dt;
      if (h.acted || h.waited < threshold) continue;
      h.acted = true;
      recordFailure(state.provider, 'page');
      try { performance.mark('reader-focus:visible-hang'); } catch {}
      window.YomuPageRescue?.__rescue?.(img);
      const swapped = fastAlternate(img, state);
      if (!swapped && circuitOpen(state.provider)) wholeFallback(state);
    }

    if (circuitOpen(state.provider) && warmValid(state) && warm?.whole && switchedFor !== state.key) wholeFallback(state, 500);
  }

  function onError(event) {
    const img = event.target;
    if (!img || img.tagName !== 'IMG') return;
    const state = currentState();
    if (!state || !img.closest?.('[data-page-index]')) return;
    recordFailure(state.provider, 'page');
    queueMicrotask(() => {
      if (!warmValid(state)) scheduleWarm(true);
      fastAlternate(img, state, 500);
      if (circuitOpen(state.provider)) wholeFallback(state, 1_200);
    });
  }

  function onLoad(event) {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || !(img.naturalWidth > 0)) return;
    if (!img.closest?.('[data-page-index]')) return;
    const state = currentState();
    if (!state) return;
    const swappedProvider = img.dataset?.yomuFocusSwap;
    if (swappedProvider) {
      recordSuccess(swappedProvider, 'page');
      delete img.dataset.yomuFocusSwap;
      delete img.dataset.yomuRescue;
    } else recordSuccess(state.provider, 'page');
  }

  function onReader() {
    const state = currentState();
    if (!state) return;
    if (!warm || warm.key !== state.key) {
      warm = null;
      prefetched.clear();
      switchedFor = '';
      nextWarmedFor = '';
      scheduleWarm(false);
    }
    prefetchAhead();
  }

  if (browser) {
    const style = document.createElement('style');
    style.id = 'yomu-reader-focus-style';
    style.textContent = '.yomu-rescue-note{display:none!important}';
    document.head.append(style);
    addEventListener('error', onError, true);
    document.addEventListener('load', onLoad, true);
    addEventListener('yomu:reader', onReader);
    addEventListener('popstate', onReader);
    addEventListener('hashchange', onReader);
    setInterval(tick, 1000);
    onReader();

    window.YomuReaderFocus = {
      warm: () => warmBackups(true),
      state: () => warm,
      circuitOpen,
      recordFailure,
      shouldOpenCircuit,
      prefetchAhead,
      constants: { VISIBLE_HANG_MS, SLOW_VISIBLE_HANG_MS, CIRCUIT_OPEN_MS, NEXT_CHAPTER_AT },
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      pruneTimes, shouldOpenCircuit,
      constants: { CIRCUIT_WINDOW_MS, CIRCUIT_OPEN_MS, PAGE_FAIL_LIMIT, MANIFEST_FAIL_LIMIT, VISIBLE_HANG_MS, SLOW_VISIBLE_HANG_MS },
    };
  }
})();
