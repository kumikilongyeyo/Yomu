/** Yomu Search V3 — fast /find search, text typeahead, progressive readable sources. */
(() => {
  'use strict';
  if (window.__YomuSearchV3) return;
  window.__YomuSearchV3 = true;

  const nativeFetch = window.fetch.bind(window);
  const COLLECTION_KEY = 'yomu.v1.collection';
  const CACHE_KEY = 'yomu.v3.searchCache';
  const SUGGEST_KEY = 'yomu.v3.suggestCache';
  const FAST_TIMEOUT = 1150;
  const SOURCE_TIMEOUT = 2100;
  const ALIAS_TIMEOUT = 950;
  const SUGGEST_TIMEOUT = 750;
  const CONCURRENCY = 8;
  const CACHE_MS = 10 * 60 * 1000;
  const FALLBACK_COVER = '/brand/yomu-loader-ink.webp';
  const MARK = '/brand/yomu-icon.svg';
  const isSearchRoute = () => /^(?:\/find(?:\.html)?|\/search)\/?$/.test(location.pathname);
  let searchRun = 0;
  let suggestRun = 0;
  let activeSearchAbort = null;
  let activeSuggestAbort = null;
  let quickRows = [];

  const norm = (v) => String(v || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|of|and|manga|manhwa|manhua|webtoon|comic|official|colou?red?|color|season|part|vol(?:ume)?|novel|remake|fan\s?colou?red)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();

  function dice(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const bag = new Map();
    for (let i = 0; i < a.length - 1; i++) {
      const g = a.slice(i, i + 2); bag.set(g, (bag.get(g) || 0) + 1);
    }
    let shared = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const g = b.slice(i, i + 2), n = bag.get(g) || 0;
      if (n) { shared++; bag.set(g, n - 1); }
    }
    return 2 * shared / Math.max(1, (a.length - 1) + (b.length - 1));
  }

  function score(item, query) {
    const q = norm(query); if (!q) return 0;
    const names = [item?.title, ...(Array.isArray(item?.altTitles) ? item.altTitles : [])].map(String).filter(Boolean);
    let best = 0;
    for (const raw of names) {
      const n = norm(raw); if (!n) continue;
      if (n === q) best = Math.max(best, 1);
      else if (n.startsWith(q)) best = Math.max(best, .97);
      else if (q.startsWith(n)) best = Math.max(best, .92);
      else if (n.includes(q)) best = Math.max(best, .89);
      else if (q.includes(n)) best = Math.max(best, .84);
      else {
        const qw = new Set(q.split(' ')), nw = new Set(n.split(' '));
        const hits = [...qw].filter((w) => nw.has(w)).length;
        const token = hits / Math.max(qw.size, nw.size, 1);
        best = Math.max(best, token * .88, dice(n, q) * .86);
      }
    }
    return best;
  }

  const providerId = (id) => String(id || '').startsWith('yomuext-') ? `ext:${String(id).slice(8)}`
    : String(id || '').startsWith('mihon-') ? `suwayomi:${String(id).slice(6)}` : String(id || '');

  function enabledSources() {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(COLLECTION_KEY) || '{}').sources || []; } catch {}
    const seen = new Set(), out = [];
    for (const s of rows) {
      if (!s || s.enabled === false || !s.id || s.id === 'mangadex') continue;
      let api;
      try {
        const u = new URL(String(s.api || s.url || ''), location.origin);
        if (!/^https?:$/.test(u.protocol)) continue;
        u.hash = ''; u.search = '';
        api = u.toString().replace(/\/?$/, '/');
      } catch { continue; }
      const apiLike = s.kind === 'api' || /^yomuext-|^mihon-/.test(String(s.id))
        || /fabric|extension|suwayomi/i.test(String(s.runtime || s.category || s.kind || ''))
        || /\/api\//i.test(new URL(api).pathname);
      if (!apiLike || seen.has(api)) continue;
      seen.add(api);
      out.push({ id: String(s.id), providerId: providerId(s.id), label: String(s.label || s.name || s.id), api });
    }
    return out;
  }

  function readStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; }
  }
  function writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
  function cachedSearch(query) {
    const row = readStore(CACHE_KEY)[norm(query)];
    return row && row.at > Date.now() - CACHE_MS && Array.isArray(row.series) ? row.series : [];
  }
  function saveSearch(query, series) {
    if (!query || !series.length) return;
    const all = readStore(CACHE_KEY);
    all[norm(query)] = { at: Date.now(), series: series.slice(0, 40) };
    const keys = Object.keys(all).sort((a, b) => Number(all[b]?.at || 0) - Number(all[a]?.at || 0)).slice(0, 24);
    writeStore(CACHE_KEY, Object.fromEntries(keys.map((k) => [k, all[k]])));
  }

  function injectCss() {
    if (document.getElementById('yomu-search-v3-css')) return;
    const s = document.createElement('style');
    s.id = 'yomu-search-v3-css';
    s.textContent = `
/* Global rule: ordinary network activity never blanks the page. */
#yomu-load{position:fixed!important;inset:auto 16px calc(16px + env(safe-area-inset-bottom,0px)) auto!important;width:34px!important;height:34px!important;padding:0!important;border:1px solid var(--line,#263747)!important;border-radius:10px!important;background:color-mix(in srgb,var(--bg,#071019) 91%,transparent)!important;box-shadow:0 8px 26px #0005!important;backdrop-filter:blur(8px)!important;-webkit-backdrop-filter:blur(8px)!important;pointer-events:none!important;opacity:0!important;display:grid!important;place-items:center!important;overflow:hidden!important;transform:translateY(4px)!important;transition:opacity .12s ease .48s,transform .12s ease .48s!important;z-index:2147483600!important}
#yomu-load.on{opacity:.96!important;transform:none!important;pointer-events:none!important}
#yomu-load .yl-card{display:none!important}#yomu-load::after{content:'';width:23px;height:23px;background:url('${MARK}') center/contain no-repeat;animation:yv3Pulse .86s ease-in-out infinite}
@keyframes yv3Pulse{0%,100%{transform:scale(.84);opacity:.5}50%{transform:scale(1.06);opacity:1}}
/* Actual standalone search page. */
body.yomu-search-v3 #yomu-load{display:none!important}
body.yomu-search-v3 .field .spin{right:12px!important;top:50%!important;width:22px!important;height:22px!important;margin-top:-11px!important;border:0!important;border-radius:0!important;background:url('${MARK}') center/contain no-repeat!important;animation:yv3Pulse .86s ease-in-out infinite!important}
body.yomu-search-v3 #results .shelf-line,body.yomu-search-v3 #results .tile[disabled]{display:none!important}
.yv3-wait{position:relative;isolation:isolate;overflow:hidden;aspect-ratio:2/3;border:1px solid var(--line,#263747);border-radius:12px;background:linear-gradient(145deg,#182839,#0e1722);display:grid;place-items:center;min-width:0}.yv3-wait__in{text-align:center;padding:12px}.yv3-wait img{width:34px;height:34px;animation:yv3Pulse .86s ease-in-out infinite}.yv3-wait b{display:block;margin-top:8px;font:750 10px/1.25 Archivo,-apple-system,sans-serif;color:var(--text,#f4f7fa);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px}.yv3-wait small{display:block;margin-top:4px;font:650 9px/1.25 Archivo,-apple-system,sans-serif;color:var(--muted,#91a8bb)}
#yomu-v3-suggest{position:fixed;z-index:2147483590;overflow:hidden;border:1px solid var(--line,#263747);border-radius:15px;background:color-mix(in srgb,var(--bg,#071019) 98%,transparent);box-shadow:0 18px 44px #0006;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);padding:6px;color:var(--text,#f4f7fa)}#yomu-v3-suggest[hidden]{display:none!important}.yv3-suggest-row{width:100%;display:flex;align-items:center;gap:10px;border:0;background:transparent;color:inherit;text-align:left;padding:10px 11px;border-radius:10px;cursor:pointer;font:inherit}.yv3-suggest-row:hover,.yv3-suggest-row.is-active{background:color-mix(in srgb,var(--surface,#172433) 88%,transparent)}.yv3-mag{width:18px;flex:0 0 18px;text-align:center;color:var(--muted,#91a8bb);font-size:15px}.yv3-suggest-title{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:760 13px/1.25 Archivo,-apple-system,sans-serif}.yv3-suggest-sub{margin-left:auto;color:var(--muted,#91a8bb);font:650 10px/1.2 Archivo,-apple-system,sans-serif;white-space:nowrap}
@media(max-width:640px){#yomu-load{right:10px!important;bottom:calc(10px + env(safe-area-inset-bottom,0px))!important}.yv3-suggest-sub{display:none}}
@media(prefers-reduced-motion:reduce){#yomu-load::after,.yv3-wait img,body.yomu-search-v3 .field .spin{animation:none!important}}
`;
    document.head.append(s);
  }
  injectCss();

  function targetOf(input) {
    try {
      const raw = typeof input === 'string' || input instanceof URL ? input : input?.url || '';
      return new URL(String(raw || ''), location.href);
    } catch { return null; }
  }
  const methodOf = (input, init) => String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
  const responseJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, max-age=0', 'x-yomu-search-v3': '1' } });

  function mdTitle(a) {
    const t = a?.title || {};
    return String(t.en || t['en-us'] || t['ja-ro'] || t['ko-ro'] || t['zh-hk'] || Object.values(t)[0] || 'Untitled');
  }
  function mdAlt(a) {
    const out = [];
    for (const e of Array.isArray(a?.altTitles) ? a.altTitles : []) for (const v of Object.values(e || {})) if (v) out.push(String(v));
    return [...new Set(out)].slice(0, 18);
  }
  function mdRow(item) {
    const a = item?.attributes || {}, rel = (item?.relationships || []).find((r) => r?.type === 'cover_art');
    const file = rel?.attributes?.fileName;
    const raw = file ? `https://uploads.mangadex.org/covers/${item.id}/${file}.256.jpg` : '';
    return {
      id: String(item.id), title: mdTitle(a), altTitles: mdAlt(a),
      cover: raw ? `/api/img?u=${encodeURIComponent(raw)}` : FALLBACK_COVER,
      synopsis: String(a.description?.en || Object.values(a.description || {})[0] || ''),
      year: Number(a.year) || undefined, status: a.status || undefined,
      nsfw: /erotica|pornographic/i.test(String(a.contentRating || '')),
      providers: [{ id: 'mangadex', name: 'MangaDex', kind: 'native', seriesId: String(item.id) }],
    };
  }

  async function quickMangaDex(query, limit = 18, timeout = FAST_TIMEOUT, outerSignal) {
    const u = new URL('/api/md/manga', location.origin);
    u.searchParams.set('title', query); u.searchParams.set('limit', String(limit));
    u.searchParams.set('order[relevance]', 'desc'); u.searchParams.append('includes[]', 'cover_art');
    let adult = false; try { adult = localStorage.getItem('yomu.v1.adult') === 'on'; } catch {}
    for (const r of adult ? ['safe','suggestive','erotica','pornographic'] : ['safe','suggestive']) u.searchParams.append('contentRating[]', r);
    const c = new AbortController(), timer = setTimeout(() => c.abort(), timeout);
    const abort = () => c.abort();
    if (outerSignal) outerSignal.aborted ? c.abort() : outerSignal.addEventListener('abort', abort, { once: true });
    try {
      const r = await nativeFetch(u.toString(), { cache: 'no-store', signal: c.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return (Array.isArray(j?.data) ? j.data : []).map(mdRow)
        .filter((x) => score(x, query) >= .46)
        .sort((a, b) => score(b, query) - score(a, query));
    } finally {
      clearTimeout(timer); if (outerSignal) outerSignal.removeEventListener('abort', abort);
    }
  }

  function findCover(item) {
    if (item?.cover) return String(item.cover);
    const names = [item?.title, ...(item?.altTitles || [])].map(norm).filter(Boolean);
    for (const row of quickRows) {
      const theirs = [row.title, ...(row.altTitles || [])].map(norm).filter(Boolean);
      if (names.some((n) => theirs.includes(n))) return row.cover || FALLBACK_COVER;
    }
    return FALLBACK_COVER;
  }

  function existingTiles() {
    const map = new Map();
    for (const tile of document.querySelectorAll('#results .tile:not([disabled])')) {
      const title = tile.querySelector('.tile-copy .t')?.textContent?.trim();
      if (title) map.set(norm(title), tile);
    }
    return map;
  }
  function mergeSourceIntoTile(tile, label) {
    const small = tile?.querySelector('.tile-copy small'); if (!small || !label) return;
    const names = small.textContent.split('·').map((x) => x.trim()).filter(Boolean);
    if (!names.some((x) => norm(x) === norm(label))) names.push(label);
    small.textContent = names.slice(0, 4).join(' · ') + (names.length > 4 ? ` · +${names.length - 4}` : '');
  }
  function makeTile(item, source) {
    const tile = document.createElement('button'); tile.type = 'button'; tile.className = 'tile yv3-hit';
    const art = document.createElement('span'); art.className = 'tile-art';
    const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.src = findCover(item);
    img.addEventListener('error', () => { if (!img.src.endsWith('yomu-loader-ink.webp')) img.src = FALLBACK_COVER; }, { once: true });
    art.append(img);
    const copy = document.createElement('span'); copy.className = 'tile-copy';
    const t = document.createElement('span'); t.className = 't'; t.textContent = String(item.title || 'Untitled');
    const sm = document.createElement('small'); sm.textContent = source.label;
    copy.append(t, sm); tile.append(art, copy);
    tile.addEventListener('click', () => { location.href = `/series/${encodeURIComponent(item.id)}?source=${encodeURIComponent(source.id)}`; });
    return tile;
  }
  function makeWait(source, run) {
    const n = document.createElement('div'); n.className = 'yv3-wait'; n.dataset.yv3Source = source.id; n.dataset.yv3Run = String(run);
    n.innerHTML = `<div class="yv3-wait__in"><img src="${MARK}" alt=""><b></b><small>Searching…</small></div>`;
    n.querySelector('b').textContent = source.label;
    return n;
  }
  function scrubUnreadable() {
    document.querySelectorAll('#results .shelf-line,#results .tile[disabled]').forEach((n) => n.remove());
    document.querySelectorAll('#results .tile-art img').forEach((img) => {
      if (img.dataset.yv3Repair) return; img.dataset.yv3Repair = '1';
      img.addEventListener('error', () => { if (!img.src.endsWith('yomu-loader-ink.webp')) img.src = FALLBACK_COVER; });
    });
  }
  function resultsGrid() { return document.getElementById('results') || document.querySelector('.grid'); }
  function setMeta(readable, done, total) {
    const m = document.getElementById('meta') || document.querySelector('.meta'); if (!m) return;
    const checked = Math.min(done, total);
    m.textContent = `${readable} readable title${readable === 1 ? '' : 's'} · ${checked}/${total} sources checked`;
  }

  async function sourceSearch(source, query, alias, signal) {
    const terms = [query, alias].filter(Boolean).slice(0, 2);
    let last = { ok: false, series: [] };
    for (let i = 0; i < terms.length; i++) {
      const c = new AbortController(), abort = () => c.abort(), timeout = i ? ALIAS_TIMEOUT : SOURCE_TIMEOUT;
      if (signal) signal.aborted ? c.abort() : signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => c.abort(), timeout);
      try {
        const u = new URL('search', source.api); u.searchParams.set('q', terms[i]); u.searchParams.set('page', '1');
        const r = await nativeFetch(u.toString(), { cache: 'no-store', signal: c.signal });
        const j = r.ok ? await r.json().catch(() => null) : null;
        last = { ok: r.ok && Array.isArray(j?.series), series: Array.isArray(j?.series) ? j.series : [] };
        if (last.series.some((x) => score(x, query) >= .66)) break;
      } catch { last = { ok: false, series: [] }; }
      finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); }
    }
    return last;
  }

  async function progressive(query, initial) {
    const run = ++searchRun;
    activeSearchAbort?.abort(); activeSearchAbort = new AbortController();
    const signal = activeSearchAbort.signal;
    quickRows = initial || [];
    const sources = enabledSources();
    const total = sources.length + 1;
    const merged = new Map();
    for (const row of initial || []) merged.set(norm(row.title), { ...row, providers: [...(row.providers || [])] });
    const top = [...(initial || [])].sort((a, b) => score(b, query) - score(a, query))[0];
    const alias = [top?.title, ...(top?.altTitles || [])].map(String).find((x) => x && norm(x) !== norm(query)) || '';

    const mount = () => {
      if (run !== searchRun) return;
      scrubUnreadable();
      const grid = resultsGrid(); if (!grid) return setTimeout(mount, 40);
      grid.querySelectorAll('.yv3-wait').forEach((n) => n.remove());
      for (const s of sources.slice(0, Math.min(CONCURRENCY, sources.length))) grid.append(makeWait(s, run));
      setMeta(existingTiles().size, 1, total);
    };
    setTimeout(mount, 30);

    let cursor = 0, done = 1;
    const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, sources.length)) }, async () => {
      while (run === searchRun && !signal.aborted) {
        const idx = cursor++; if (idx >= sources.length) return;
        const source = sources[idx];
        const grid = resultsGrid();
        let wait = grid?.querySelector(`.yv3-wait[data-yv3-source="${CSS.escape(source.id)}"]`);
        if (!wait && grid) { wait = makeWait(source, run); grid.append(wait); }
        const batch = await sourceSearch(source, query, alias, signal);
        if (run !== searchRun || signal.aborted) return;
        const best = [...(batch.series || [])].map((item) => ({ item, s: score(item, query) })).sort((a, b) => b.s - a.s)[0];
        const readableHit = best && best.s >= .58;
        if (readableHit) {
          const key = norm(best.item.title), tiles = existingTiles(), existing = tiles.get(key);
          const p = { id: source.providerId, name: source.label, kind: 'extension', seriesId: String(best.item.id) };
          if (existing) {
            mergeSourceIntoTile(existing, source.label); wait?.remove();
          } else if (grid) {
            const tile = makeTile(best.item, source); wait?.replaceWith(tile);
          }
          const row = merged.get(key) || { ...best.item, cover: findCover(best.item), providers: [] };
          if (!row.providers.some((x) => x.id === p.id && String(x.seriesId) === p.seriesId)) row.providers.push(p);
          row.cover ||= findCover(best.item); merged.set(key, row);
        } else wait?.remove();
        done++;
        scrubUnreadable();
        setMeta(existingTiles().size, done, total);
      }
    });
    await Promise.all(workers);
    if (run !== searchRun || signal.aborted) return;
    document.querySelectorAll(`.yv3-wait[data-yv3-run="${run}"]`).forEach((n) => n.remove());
    scrubUnreadable();
    const rows = [...merged.values()].sort((a, b) => score(b, query) - score(a, query));
    saveSearch(query, rows);
    setMeta(existingTiles().size, total, total);
  }

  async function fastSearch(query) {
    const cached = cachedSearch(query);
    if (cached.length) {
      quickRows = cached;
      setTimeout(() => progressive(query, cached), 0);
      return responseJson({ series: cached, providersTried: 0, providersTotal: enabledSources().length + 1, cached: true, progressive: true });
    }
    const c = new AbortController();
    try {
      const rows = await quickMangaDex(query, 18, FAST_TIMEOUT, c.signal);
      quickRows = rows;
      setTimeout(() => progressive(query, rows), 0);
      return responseJson({ series: rows, providersTried: 1, providersTotal: enabledSources().length + 1, progressive: true });
    } catch {
      setTimeout(() => progressive(query, []), 0);
      return responseJson({ series: [], providersTried: 0, providersTotal: enabledSources().length + 1, progressive: true });
    }
  }

  async function searchFetch(input, init) {
    const u = targetOf(input);
    if (isSearchRoute() && u && u.origin === location.origin && u.pathname === '/api/catalog/search' && u.searchParams.get('q')?.trim() && methodOf(input, init) === 'GET') {
      return fastSearch(u.searchParams.get('q').trim());
    }
    return nativeFetch(input, init);
  }
  function installFetch() { window.fetch = searchFetch; }
  installFetch();

  function suggestionCache(query) {
    const all = readStore(SUGGEST_KEY), q = norm(query);
    const rows = Object.values(all).filter((x) => x?.title && norm(x.title).startsWith(q)).sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
    return rows.slice(0, 8);
  }
  function saveSuggestions(rows) {
    const all = readStore(SUGGEST_KEY);
    for (const r of rows) all[norm(r.title)] = { title: r.title, at: Date.now() };
    const keys = Object.keys(all).sort((a, b) => Number(all[b]?.at || 0) - Number(all[a]?.at || 0)).slice(0, 80);
    writeStore(SUGGEST_KEY, Object.fromEntries(keys.map((k) => [k, all[k]])));
  }
  function suggestionBox(input) {
    let box = document.getElementById('yomu-v3-suggest');
    if (!box) { box = document.createElement('div'); box.id = 'yomu-v3-suggest'; box.hidden = true; document.body.append(box); }
    const place = () => {
      const r = input.getBoundingClientRect();
      box.style.left = `${Math.round(r.left)}px`; box.style.top = `${Math.round(r.bottom + 6)}px`; box.style.width = `${Math.round(r.width)}px`; box.style.maxHeight = `${Math.max(180, Math.min(420, innerHeight - r.bottom - 18))}px`;
    };
    place(); return { box, place };
  }
  function renderSuggestions(input, rows) {
    const { box, place } = suggestionBox(input); box.textContent = '';
    const seen = new Set();
    for (const row of rows) {
      const title = String(row.title || '').trim(), key = norm(title); if (!title || seen.has(key)) continue; seen.add(key);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'yv3-suggest-row'; b.dataset.title = title;
      const icon = document.createElement('span'); icon.className = 'yv3-mag'; icon.textContent = '⌕';
      const t = document.createElement('span'); t.className = 'yv3-suggest-title'; t.textContent = title;
      const sub = document.createElement('span'); sub.className = 'yv3-suggest-sub'; sub.textContent = 'title';
      b.append(icon, t, sub);
      b.addEventListener('mousedown', (e) => { e.preventDefault(); location.href = `/find?q=${encodeURIComponent(title)}`; });
      box.append(b); if (seen.size >= 8) break;
    }
    place(); box.hidden = !box.children.length;
  }
  function setupTypeahead() {
    if (!isSearchRoute()) return;
    const input = document.querySelector('.field input,input[type="search"],input[name="q"]'); if (!input || input.dataset.yv3Bound) return;
    input.dataset.yv3Bound = '1'; let timer = null, active = -1;
    const close = () => { const b = document.getElementById('yomu-v3-suggest'); if (b) b.hidden = true; active = -1; };
    const updateActive = () => document.querySelectorAll('#yomu-v3-suggest .yv3-suggest-row').forEach((n, i) => n.classList.toggle('is-active', i === active));
    const run = async () => {
      const query = input.value.trim(), id = ++suggestRun;
      activeSuggestAbort?.abort(); activeSuggestAbort = new AbortController();
      if (query.length < 2) return close();
      const cached = suggestionCache(query); if (cached.length) renderSuggestions(input, cached);
      try {
        const rows = await quickMangaDex(query, 8, SUGGEST_TIMEOUT, activeSuggestAbort.signal);
        if (id !== suggestRun) return;
        const strong = rows.filter((x) => score(x, query) >= .45).slice(0, 8);
        saveSuggestions(strong); renderSuggestions(input, strong.length ? strong : cached);
      } catch { if (!cached.length) close(); }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
    input.addEventListener('focus', () => { if (input.value.trim().length >= 2) run(); });
    input.addEventListener('keydown', (e) => {
      const box = document.getElementById('yomu-v3-suggest'), rows = [...(box?.querySelectorAll('.yv3-suggest-row') || [])];
      if (!rows.length || box.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(rows.length - 1, active + 1); updateActive(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); updateActive(); }
      else if (e.key === 'Escape') close();
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); location.href = `/find?q=${encodeURIComponent(rows[active].dataset.title)}`; }
    });
    document.addEventListener('pointerdown', (e) => { if (e.target !== input && !e.target.closest?.('#yomu-v3-suggest')) close(); });
    addEventListener('resize', () => { const x = document.getElementById('yomu-v3-suggest'); if (x && !x.hidden) suggestionBox(input).place(); }, { passive: true });
  }

  function setupDom() {
    installFetch();
    if (!isSearchRoute()) return;
    document.body.classList.add('yomu-search-v3');
    scrubUnreadable(); setupTypeahead();
    new MutationObserver(scrubUnreadable).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupDom, { once: true }); else setupDom();
  addEventListener('load', () => { installFetch(); setupDom(); }, { once: true });
})();
