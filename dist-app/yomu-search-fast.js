/** Yomu search fast lane + compact loading UI + typeahead. */
(() => {
  'use strict';
  if (window.__YomuSearchFast) return;
  window.__YomuSearchFast = true;

  const wrappedFetch = window.fetch.bind(window);
  const baseFetch = typeof window.__YomuSearchFastBaseFetch === 'function'
    ? window.__YomuSearchFastBaseFetch
    : wrappedFetch;
  const COLLECTION_KEY = 'yomu.v1.collection';
  const SUGGEST_KEY = 'yomu.v1.searchSuggest';
  const QUERY_TIMEOUT_MS = 2200;
  const ALIAS_TIMEOUT_MS = 1200;
  const FAST_LANE_TIMEOUT_MS = 1800;
  const SUGGEST_TIMEOUT_MS = 900;
  const CONCURRENCY = 8;
  let runId = 0;
  let suggestController = null;
  let searchController = null;

  const normalize = (value) => String(value || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|of|and|manga|manhwa|manhua|webtoon|comic|official|colou?red?|color|season|part|vol(?:ume)?|novel|remake|fan\s?colou?red)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();

  function dice(a, b) {
    a = normalize(a); b = normalize(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const bag = new Map();
    for (let i = 0; i < a.length - 1; i += 1) {
      const g = a.slice(i, i + 2); bag.set(g, (bag.get(g) || 0) + 1);
    }
    let hit = 0;
    for (let i = 0; i < b.length - 1; i += 1) {
      const g = b.slice(i, i + 2), n = bag.get(g) || 0;
      if (n) { hit += 1; bag.set(g, n - 1); }
    }
    return (2 * hit) / Math.max(1, (a.length - 1) + (b.length - 1));
  }

  function score(item, query) {
    const q = normalize(query);
    if (!q) return 0;
    const names = [item?.title, ...(Array.isArray(item?.altTitles) ? item.altTitles : [])]
      .map(String).filter(Boolean);
    let best = 0;
    for (const raw of names) {
      const n = normalize(raw);
      if (!n) continue;
      if (n === q) best = Math.max(best, 1);
      else if (n.startsWith(q) || q.startsWith(n)) best = Math.max(best, .94);
      else if (n.includes(q) || q.includes(n)) best = Math.max(best, .88);
      else {
        const qw = new Set(q.split(' ')), nw = new Set(n.split(' '));
        const hit = [...qw].filter((w) => nw.has(w)).length;
        const token = hit / Math.max(qw.size, nw.size, 1);
        best = Math.max(best, token * .88, dice(n, q) * .84);
      }
    }
    return best;
  }

  const toProviderId = (id) => String(id || '').startsWith('yomuext-')
    ? `ext:${String(id).slice(8)}`
    : String(id || '').startsWith('mihon-')
      ? `suwayomi:${String(id).slice(6)}`
      : String(id || '');

  function enabledSources() {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(COLLECTION_KEY) || '{}').sources || []; } catch {}
    const seen = new Set(), out = [];
    for (const source of rows) {
      if (!source || source.enabled === false || !source.id || source.id === 'mangadex') continue;
      let api;
      try {
        const url = new URL(String(source.url || source.api || ''), location.origin);
        if (!/^https?:$/.test(url.protocol)) continue;
        url.hash = ''; url.search = '';
        api = url.toString().replace(/\/?$/, '/');
      } catch { continue; }
      const apiLike = source.kind === 'api' || /^yomuext-|^mihon-/.test(String(source.id))
        || /fabric/i.test(String(source.runtime || source.category || '')) || /\/api\//i.test(new URL(api).pathname);
      if (!apiLike || seen.has(api)) continue;
      seen.add(api);
      out.push({ id: String(source.id), providerId: toProviderId(source.id), label: String(source.label || source.name || source.id), api });
    }
    return out;
  }

  function requestTarget(input) {
    try {
      const raw = typeof input === 'string' || input instanceof URL ? input : input?.url || '';
      return new URL(String(raw || ''), location.href);
    } catch { return null; }
  }
  function requestMethod(input, init) {
    return String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
  }

  function addStyles() {
    if (document.getElementById('yomu-search-fast-css')) return;
    const s = document.createElement('style');
    s.id = 'yomu-search-fast-css';
    s.textContent = `
/* Never blank the app for ordinary network work. The old loader still exists,
   but is now a tiny non-blocking status pill and only becomes visible after a
   half-second, so fast actions produce no loader at all. */
#yomu-load{position:fixed!important;inset:auto 18px calc(18px + env(safe-area-inset-bottom,0px)) auto!important;width:auto!important;height:auto!important;display:block!important;place-items:unset!important;padding:7px 10px!important;border:1px solid var(--line,#263747)!important;border-radius:999px!important;background:color-mix(in srgb,var(--bg,#070b10) 90%,transparent)!important;backdrop-filter:blur(8px)!important;-webkit-backdrop-filter:blur(8px)!important;box-shadow:0 8px 28px rgba(0,0,0,.2)!important;color:var(--text,#f5f7fa)!important;opacity:0!important;pointer-events:none!important;transform:translateY(5px)!important;transition:opacity .12s ease 0s,transform .12s ease 0s!important;z-index:2147483600!important}
#yomu-load.on{opacity:.96!important;transform:translateY(0)!important;pointer-events:none!important;transition-delay:.55s!important}
#yomu-load .yl-card{width:auto!important;display:flex!important;align-items:center!important;gap:7px!important;text-align:left!important}.yl-book{width:25px!important;height:19px!important;flex:0 0 25px!important}.yl-book i,.yl-book b,.yl-book em{top:3px!important;width:11px!important;height:14px!important;border-radius:2px 2px 4px 4px!important}.yl-book i{left:1px!important}.yl-book b,.yl-book em{right:1px!important}.yl-brand{font:850 11px/1 Archivo,-apple-system,sans-serif!important}.yl-title,.yl-detail,.yl-track,.yl-count{display:none!important}
#yomu-fast-search{margin:10px 0 16px;color:var(--text,#f5f7fa)}.yfs-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 8px}.yfs-title{font:800 11px/1.2 Archivo,-apple-system,sans-serif}.yfs-meta{font:700 9px/1.2 Archivo,-apple-system,sans-serif;color:var(--muted,#91a8bb);white-space:nowrap}.yfs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:8px}.yfs-card{min-width:0;min-height:168px;border:1px solid var(--line,#263747);border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--surface,#111b25) 68%,transparent);position:relative;transition:opacity .16s,transform .16s,border-color .16s}.yfs-card.is-done{min-height:0}.yfs-card.is-miss{opacity:.35;min-height:64px}.yfs-card.is-miss .yfs-wait{min-height:64px}.yfs-wait{min-height:168px;display:grid;place-items:center;text-align:center;padding:12px;box-sizing:border-box}.yfs-logo{width:30px;height:30px;display:block;margin:0 auto 7px;animation:yfsPulse 1s ease-in-out infinite}.yfs-source{font:800 9px/1.2 Archivo,-apple-system,sans-serif}.yfs-state{margin-top:4px;color:var(--muted,#91a8bb);font:650 8.5px/1.25 Archivo,-apple-system,sans-serif}.yfs-link{display:block;color:inherit;text-decoration:none;height:100%}.yfs-cover{width:100%;aspect-ratio:3/4;object-fit:cover;background:var(--surface,#111b25);display:block}.yfs-copy{padding:7px 8px 8px}.yfs-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font:800 10px/1.25 Archivo,-apple-system,sans-serif}.yfs-from{margin-top:3px;color:var(--muted,#91a8bb);font:700 8px/1.2 Archivo,-apple-system,sans-serif}.yfs-card.is-hit{border-color:color-mix(in srgb,var(--accent,#ffc45f) 42%,var(--line,#263747))}.yfs-card.is-hit:hover{transform:translateY(-2px)}
#yomu-search-suggest{position:fixed;z-index:2147483590;max-height:min(420px,54vh);overflow:auto;border:1px solid var(--line,#263747);border-radius:13px;background:color-mix(in srgb,var(--bg,#070b10) 97%,transparent);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);box-shadow:0 18px 45px rgba(0,0,0,.28);padding:6px;box-sizing:border-box;color:var(--text,#f5f7fa)}#yomu-search-suggest[hidden]{display:none!important}.yss-row{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:9px;color:inherit;text-decoration:none;cursor:pointer}.yss-row:hover,.yss-row.active{background:color-mix(in srgb,var(--surface,#172433) 82%,transparent)}.yss-cover{width:30px;height:42px;border-radius:5px;object-fit:cover;background:var(--surface,#111b25);flex:0 0 auto}.yss-copy{min-width:0}.yss-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:800 11px/1.2 Archivo,-apple-system,sans-serif}.yss-meta{margin-top:3px;color:var(--muted,#91a8bb);font:650 9px/1.2 Archivo,-apple-system,sans-serif}
@keyframes yfsPulse{0%,100%{transform:scale(.92);opacity:.45}50%{transform:scale(1.06);opacity:1}}@media(max-width:640px){.yfs-grid{grid-template-columns:repeat(2,minmax(0,1fr))}#yomu-load{right:12px!important;bottom:calc(12px + env(safe-area-inset-bottom,0px))!important}}@media(prefers-reduced-motion:reduce){.yfs-logo{animation:none}.yfs-card{transition:none}}
`;
    document.head.append(s);
  }

  function pickTitle(attrs) {
    const titles = attrs?.title || {};
    const preferred = titles.en || titles['en-us'] || titles['ja-ro'] || titles['ko-ro'] || titles['zh-hk'];
    if (preferred) return String(preferred);
    return String(Object.values(titles)[0] || 'Untitled');
  }
  function altTitles(attrs) {
    const out = [];
    for (const entry of Array.isArray(attrs?.altTitles) ? attrs.altTitles : []) {
      for (const value of Object.values(entry || {})) if (value) out.push(String(value));
    }
    return [...new Set(out)].slice(0, 18);
  }
  function categoryOf(lang) {
    const l = String(lang || '').toLowerCase();
    if (l === 'ko') return 'manhwa';
    if (l === 'zh' || l === 'zh-hk') return 'manhua';
    if (l === 'ja') return 'manga';
    return undefined;
  }
  function mangaDexRow(item) {
    const a = item?.attributes || {};
    const rels = Array.isArray(item?.relationships) ? item.relationships : [];
    const coverRel = rels.find((r) => r?.type === 'cover_art');
    const file = coverRel?.attributes?.fileName;
    const rawCover = file ? `https://uploads.mangadex.org/covers/${item.id}/${file}.256.jpg` : '';
    const cover = rawCover ? `/api/img?u=${encodeURIComponent(rawCover)}` : '/brand/yomu-loader-ink.webp';
    const title = pickTitle(a);
    return {
      id: String(item.id), title, altTitles: altTitles(a), cover,
      synopsis: String(a.description?.en || Object.values(a.description || {})[0] || ''),
      status: a.status || undefined, year: Number(a.year) || undefined,
      category: categoryOf(a.originalLanguage), nsfw: /erotica|pornographic/i.test(String(a.contentRating || '')),
      providers: [{ id: 'mangadex', name: 'MangaDex', kind: 'native', seriesId: String(item.id) }],
    };
  }

  async function quickMangaDex(query, { limit = 14, timeout = FAST_LANE_TIMEOUT_MS, signal } = {}) {
    const u = new URL('/api/md/manga', location.origin);
    u.searchParams.set('title', query);
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('order[relevance]', 'desc');
    u.searchParams.append('includes[]', 'cover_art');
    const adult = (() => { try { return localStorage.getItem('yomu.v1.adult') === 'on'; } catch { return false; } })();
    for (const rating of adult ? ['safe','suggestive','erotica','pornographic'] : ['safe','suggestive']) u.searchParams.append('contentRating[]', rating);
    let timer;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    timer = setTimeout(() => controller.abort(), timeout);
    try {
      const r = await baseFetch(u.toString(), { cache: 'no-store', signal: controller.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const rows = (Array.isArray(j?.data) ? j.data : []).map(mangaDexRow)
        .sort((a, b) => score(b, query) - score(a, query));
      return rows;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }

  function mountPanel(id, query, sources) {
    const create = () => {
      if (id !== runId) return null;
      document.getElementById('yomu-fast-search')?.remove();
      if (!sources.length) return null;
      const form = document.querySelector('main form,.g-main form,form');
      const parent = form?.parentElement || document.querySelector('main') || document.body;
      const panel = document.createElement('section');
      panel.id = 'yomu-fast-search'; panel.dataset.run = String(id);
      const head = document.createElement('div'); head.className = 'yfs-head';
      const title = document.createElement('div'); title.className = 'yfs-title'; title.textContent = 'Checking more sources';
      const meta = document.createElement('div'); meta.className = 'yfs-meta'; meta.textContent = `0 / ${sources.length} checked`;
      head.append(title, meta);
      const grid = document.createElement('div'); grid.className = 'yfs-grid';
      for (const source of sources) {
        const card = document.createElement('article'); card.className = 'yfs-card'; card.dataset.sourceId = source.id;
        const wait = document.createElement('div'); wait.className = 'yfs-wait';
        const inner = document.createElement('div');
        const logo = document.createElement('img'); logo.className = 'yfs-logo'; logo.src = '/brand/yomu-mark.svg'; logo.alt = 'Yomu';
        const name = document.createElement('div'); name.className = 'yfs-source'; name.textContent = source.label;
        const state = document.createElement('div'); state.className = 'yfs-state'; state.textContent = 'Searching…';
        inner.append(logo, name, state); wait.append(inner); card.append(wait); grid.append(card);
      }
      panel.append(head, grid);
      if (form?.nextSibling) parent.insertBefore(panel, form.nextSibling); else parent.append(panel);
      return panel;
    };
    const panel = create(); if (!panel) setTimeout(create, 50); return panel;
  }
  function panelFor(id) { const p = document.getElementById('yomu-fast-search'); return p?.dataset.run === String(id) ? p : null; }
  function updateMeta(id, done, total, hits) {
    const meta = panelFor(id)?.querySelector('.yfs-meta');
    if (meta) meta.textContent = `${done} / ${total} checked · ${hits} match${hits === 1 ? '' : 'es'}`;
  }
  function markMiss(id, source, text) {
    const card = panelFor(id)?.querySelector(`.yfs-card[data-source-id="${CSS.escape(source.id)}"]`); if (!card) return;
    card.classList.add('is-miss'); const state = card.querySelector('.yfs-state'); if (state) state.textContent = text;
    setTimeout(() => { if (id === runId && card.isConnected) card.remove(); }, 900);
  }
  function markHit(id, source, item) {
    const card = panelFor(id)?.querySelector(`.yfs-card[data-source-id="${CSS.escape(source.id)}"]`); if (!card) return;
    card.className = 'yfs-card is-done is-hit'; card.textContent = '';
    const a = document.createElement('a'); a.className = 'yfs-link';
    const bound = { ...item, seriesId: String(item.id), sourceId: source.id, sourceName: source.label, providers: [{ id: source.providerId, name: source.label, kind: 'extension', seriesId: String(item.id) }] };
    a.href = `/series/${encodeURIComponent(item.id)}?source=${encodeURIComponent(source.id)}`;
    if (window.YomuOpenTitle?.bind) window.YomuOpenTitle.bind(a, bound);
    const cover = document.createElement('img'); cover.className = 'yfs-cover'; cover.loading = 'lazy'; cover.alt = ''; cover.src = String(item.cover || '/brand/yomu-loader-ink.webp');
    cover.addEventListener('error', () => { cover.src = '/brand/yomu-loader-ink.webp'; }, { once: true });
    const copy = document.createElement('div'); copy.className = 'yfs-copy';
    const name = document.createElement('div'); name.className = 'yfs-name'; name.textContent = String(item.title || 'Untitled');
    const from = document.createElement('div'); from.className = 'yfs-from'; from.textContent = source.label;
    copy.append(name, from); a.append(cover, copy); card.append(a);
  }

  async function searchSource(source, query, aliases) {
    const terms = [query, ...aliases].filter(Boolean).slice(0, 2);
    let last = { source, ok: false, series: [] };
    for (let i = 0; i < terms.length; i += 1) {
      try {
        const u = new URL('search', source.api); u.searchParams.set('q', terms[i]); u.searchParams.set('page', '1');
        const r = await baseFetch(u.toString(), { cache: 'no-store', signal: AbortSignal.timeout(i ? ALIAS_TIMEOUT_MS : QUERY_TIMEOUT_MS) });
        const j = r.ok ? await r.json().catch(() => null) : null;
        last = { source, ok: r.ok && Array.isArray(j?.series), series: Array.isArray(j?.series) ? j.series : [], status: r.status };
        if (last.series.some((x) => score(x, query) >= .58)) break;
      } catch (e) { last = { source, ok: false, series: [], error: String(e?.message || e) }; }
    }
    return last;
  }
  async function streamSources(id, query, sources, aliases) {
    let cursor = 0, done = 0, hits = 0;
    const runner = async () => {
      while (id === runId) {
        const index = cursor++; if (index >= sources.length) return;
        const source = sources[index], batch = await searchSource(source, query, aliases);
        if (id !== runId) return;
        const best = [...(batch.series || [])].map((item) => ({ item, score: score(item, query) })).sort((a, b) => b.score - a.score)[0];
        if (best?.score >= .48) { hits += 1; markHit(id, source, best.item); }
        else markMiss(id, source, batch.ok ? 'No close match' : 'No response');
        done += 1; updateMeta(id, done, sources.length, hits);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, sources.length)) }, runner));
    if (id !== runId) return;
    const title = panelFor(id)?.querySelector('.yfs-title');
    if (title) title.textContent = hits ? 'More source matches' : 'Other sources checked';
  }
  function startProgressiveSearch(query, body) {
    const id = ++runId, sources = enabledSources();
    const represented = new Set((body?.series || []).filter((x) => score(x, query) >= .62).flatMap((x) => (x.providers || []).map((p) => String(p?.id || ''))));
    const missing = sources.filter((s) => !represented.has(s.providerId));
    const top = [...(body?.series || [])].sort((a, b) => score(b, query) - score(a, query))[0];
    const aliases = [top?.title, ...(top?.altTitles || [])].map(String).filter((x) => x && normalize(x) !== normalize(query)).slice(0, 1);
    if (!missing.length) { document.getElementById('yomu-fast-search')?.remove(); return; }
    mountPanel(id, query, missing); streamSources(id, query, missing, aliases).catch(() => {});
  }

  function readSuggestCache(query) {
    try {
      const rows = JSON.parse(localStorage.getItem(SUGGEST_KEY) || '[]');
      return (Array.isArray(rows) ? rows : []).map((x) => ({ ...x, _score: score(x, query) })).filter((x) => x._score >= .5).sort((a, b) => b._score - a._score).slice(0, 7);
    } catch { return []; }
  }
  function rememberSuggestions(rows) {
    try {
      const old = JSON.parse(localStorage.getItem(SUGGEST_KEY) || '[]');
      const map = new Map();
      for (const x of [...rows, ...(Array.isArray(old) ? old : [])]) if (x?.title) map.set(normalize(x.title), { title: x.title, cover: x.cover || '', category: x.category || '' });
      localStorage.setItem(SUGGEST_KEY, JSON.stringify([...map.values()].slice(0, 80)));
    } catch {}
  }
  function suggestNode() {
    let n = document.getElementById('yomu-search-suggest');
    if (!n) { n = document.createElement('div'); n.id = 'yomu-search-suggest'; n.hidden = true; document.body.append(n); }
    return n;
  }
  function positionSuggest(input) {
    const n = suggestNode(), r = input.getBoundingClientRect();
    n.style.left = `${Math.max(8, r.left)}px`; n.style.top = `${r.bottom + 6}px`; n.style.width = `${Math.max(240, r.width)}px`;
  }
  function renderSuggest(input, rows) {
    const n = suggestNode(); n.textContent = '';
    if (!rows.length || document.activeElement !== input) { n.hidden = true; return; }
    for (const row of rows.slice(0, 8)) {
      const a = document.createElement('a'); a.className = 'yss-row'; a.href = `/search?q=${encodeURIComponent(row.title)}`;
      const img = document.createElement('img'); img.className = 'yss-cover'; img.alt = ''; img.src = row.cover || '/brand/yomu-loader-ink.webp'; img.addEventListener('error', () => { img.src = '/brand/yomu-loader-ink.webp'; }, { once: true });
      const copy = document.createElement('div'); copy.className = 'yss-copy';
      const name = document.createElement('div'); name.className = 'yss-name'; name.textContent = row.title;
      const meta = document.createElement('div'); meta.className = 'yss-meta'; meta.textContent = row.category ? `Suggested · ${row.category}` : 'Suggested title';
      copy.append(name, meta); a.append(img, copy); n.append(a);
    }
    positionSuggest(input); n.hidden = false;
  }
  function installSuggest() {
    if (!(location.pathname === '/search' || location.pathname === '/search/')) return;
    const boot = () => {
      const input = document.querySelector('input[type="search"],input[placeholder*="search" i],form input[type="text"]');
      if (!input || input.dataset.yomuSuggest === '1') return !!input;
      input.dataset.yomuSuggest = '1'; let timer = 0, active = -1;
      const rows = () => [...suggestNode().querySelectorAll('.yss-row')];
      input.addEventListener('input', () => {
        clearTimeout(timer); active = -1; const q = input.value.trim();
        suggestController?.abort(); suggestController = null;
        if (q.length < 2) { suggestNode().hidden = true; return; }
        renderSuggest(input, readSuggestCache(q));
        timer = setTimeout(async () => {
          const controller = new AbortController(); suggestController = controller;
          try {
            const fresh = await quickMangaDex(q, { limit: 8, timeout: SUGGEST_TIMEOUT_MS, signal: controller.signal });
            if (controller.signal.aborted || input.value.trim() !== q) return;
            rememberSuggestions(fresh); renderSuggest(input, fresh);
          } catch {}
        }, 120);
      });
      input.addEventListener('keydown', (e) => {
        const all = rows(); if (!all.length || suggestNode().hidden) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault(); active = e.key === 'ArrowDown' ? Math.min(all.length - 1, active + 1) : Math.max(0, active - 1);
          all.forEach((x, i) => x.classList.toggle('active', i === active));
        } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); all[active].click(); }
        else if (e.key === 'Escape') suggestNode().hidden = true;
      });
      input.addEventListener('focus', () => { const q = input.value.trim(); if (q.length >= 2) renderSuggest(input, readSuggestCache(q)); });
      input.addEventListener('blur', () => setTimeout(() => { suggestNode().hidden = true; }, 140));
      addEventListener('resize', () => !suggestNode().hidden && positionSuggest(input));
      addEventListener('scroll', () => !suggestNode().hidden && positionSuggest(input), true);
      return true;
    };
    if (!boot()) {
      const mo = new MutationObserver(() => { if (boot()) mo.disconnect(); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 8000);
    }
  }

  window.fetch = async (input, init) => {
    const target = requestTarget(input);
    const searchPage = location.pathname === '/search' || location.pathname === '/search/';
    if (!target || requestMethod(input, init) !== 'GET' || !searchPage || target.origin !== location.origin || target.pathname !== '/api/catalog/search' || !target.searchParams.get('q')?.trim()) {
      return wrappedFetch(input, init);
    }

    const query = target.searchParams.get('q').trim();
    searchController?.abort();
    const controller = new AbortController(); searchController = controller;
    let rows = [];
    try { rows = await quickMangaDex(query, { limit: 14, timeout: FAST_LANE_TIMEOUT_MS, signal: controller.signal }); }
    catch (e) { if (controller.signal.aborted) throw e; }

    // Never make Search wait for every provider. The fast lane returns the first
    // useful result set now; enabled sources continue as independent tile jobs.
    const body = {
      series: rows,
      providersTried: rows.length ? 1 : 0,
      providersTotal: 1 + enabledSources().length,
      allEnabledSourcesSearched: rows.length ? 1 : 0,
      allEnabledSourcesResponded: rows.length ? 1 : 0,
      fastLane: 'mangadex',
    };
    rememberSuggestions(rows);
    setTimeout(() => startProgressiveSearch(query, body), 0);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, max-age=0', 'x-yomu-progressive-search': '2' },
    });
  };

  addStyles();
  installSuggest();
})();
