/** Yomu progressive search: return fast results first, stream source matches after. */
(() => {
  'use strict';
  if (window.__YomuSearchFast) return;
  window.__YomuSearchFast = true;

  const wrappedFetch = window.fetch.bind(window);
  const baseFetch = typeof window.__YomuSearchFastBaseFetch === 'function'
    ? window.__YomuSearchFastBaseFetch
    : wrappedFetch;
  const COLLECTION_KEY = 'yomu.v1.collection';
  const QUERY_TIMEOUT_MS = 4200;
  const ALIAS_TIMEOUT_MS = 2600;
  const CONCURRENCY = 8;
  let runId = 0;

  const normalize = (value) => String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|of|and|manga|manhwa|manhua|webtoon|comic|official|colou?red?|color|season|part|vol(?:ume)?|novel|remake|fan\s?colou?red)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const toProviderId = (id) => String(id || '').startsWith('yomuext-')
    ? `ext:${String(id).slice(8)}`
    : String(id || '').startsWith('mihon-')
      ? `suwayomi:${String(id).slice(6)}`
      : String(id || '');

  function score(item, query) {
    const q = normalize(query);
    if (!q) return 0;
    const names = [item?.title, ...(Array.isArray(item?.altTitles) ? item.altTitles : [])]
      .map(normalize).filter(Boolean);
    if (names.includes(q)) return 1;
    if (names.some((name) => name.includes(q) || q.includes(name))) return 0.9;
    const qWords = new Set(q.split(' '));
    let best = 0;
    for (const name of names) {
      const words = new Set(name.split(' '));
      const hits = [...qWords].filter((word) => words.has(word)).length;
      best = Math.max(best, hits / Math.max(qWords.size, words.size, 1));
    }
    return best;
  }

  function enabledSources() {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(COLLECTION_KEY) || '{}').sources || []; } catch {}
    const seen = new Set();
    const out = [];
    for (const source of rows) {
      if (!source || source.enabled === false || !source.id || source.id === 'mangadex') continue;
      let api;
      try {
        const url = new URL(String(source.url || source.api || ''), location.origin);
        if (!/^https?:$/.test(url.protocol)) continue;
        url.hash = '';
        url.search = '';
        api = url.toString().replace(/\/?$/, '/');
      } catch { continue; }
      const apiLike = source.kind === 'api'
        || /^yomuext-|^mihon-/.test(String(source.id))
        || /fabric/i.test(String(source.runtime || source.category || ''))
        || /\/api\//i.test(new URL(api).pathname);
      if (!apiLike || seen.has(api)) continue;
      seen.add(api);
      out.push({
        id: String(source.id),
        providerId: toProviderId(source.id),
        label: String(source.label || source.name || source.id),
        api,
      });
    }
    return out;
  }

  function requestTarget(input) {
    try {
      const raw = typeof input === 'string' || input instanceof URL
        ? input
        : (input && typeof input.url === 'string' ? input.url : '');
      return new URL(String(raw || ''), location.href);
    } catch { return null; }
  }

  function requestMethod(input, init) {
    return String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
  }

  function addStyles() {
    if (document.getElementById('yomu-search-fast-css')) return;
    const style = document.createElement('style');
    style.id = 'yomu-search-fast-css';
    style.textContent = `
#yomu-fast-search{margin:12px 0 18px;padding:12px;border:1px solid var(--line,#263747);border-radius:14px;background:color-mix(in srgb,var(--surface,#111b25) 78%,transparent);color:var(--text,#f5f7fa)}
.yfs-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.yfs-title{font:800 12px/1.2 Archivo,-apple-system,sans-serif}.yfs-meta{font:700 10px/1.2 Archivo,-apple-system,sans-serif;color:var(--muted,#91a8bb);white-space:nowrap}.yfs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:9px}.yfs-card{min-width:0;min-height:188px;border:1px solid var(--line,#263747);border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--bg,#070b10) 88%,transparent);position:relative;transition:opacity .18s,transform .18s,border-color .18s}.yfs-card.is-done{min-height:0}.yfs-card.is-miss{opacity:.45;min-height:72px}.yfs-card.is-miss .yfs-wait{min-height:72px}.yfs-wait{min-height:188px;display:grid;place-items:center;text-align:center;padding:14px;box-sizing:border-box}.yfs-logo{width:34px;height:34px;display:block;margin:0 auto 8px;animation:yfsPulse 1.05s ease-in-out infinite}.yfs-source{font:800 10px/1.2 Archivo,-apple-system,sans-serif}.yfs-state{margin-top:4px;color:var(--muted,#91a8bb);font:650 9px/1.25 Archivo,-apple-system,sans-serif}.yfs-link{display:block;color:inherit;text-decoration:none;height:100%}.yfs-cover{width:100%;aspect-ratio:3/4;object-fit:cover;background:var(--surface,#111b25);display:block}.yfs-copy{padding:8px 9px 9px}.yfs-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font:800 11px/1.25 Archivo,-apple-system,sans-serif}.yfs-from{margin-top:4px;color:var(--muted,#91a8bb);font:700 9px/1.2 Archivo,-apple-system,sans-serif}.yfs-card.is-hit{border-color:color-mix(in srgb,var(--accent,#ffc45f) 46%,var(--line,#263747))}.yfs-card.is-hit:hover{transform:translateY(-2px)}
@keyframes yfsPulse{0%,100%{transform:scale(.94);opacity:.52}50%{transform:scale(1.06);opacity:1}}@media(max-width:640px){#yomu-fast-search{padding:10px}.yfs-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(prefers-reduced-motion:reduce){.yfs-logo{animation:none}.yfs-card{transition:none}}
`;
    document.head.append(style);
  }

  function mountPanel(id, query, sources) {
    addStyles();
    const create = () => {
      if (id !== runId) return null;
      document.getElementById('yomu-fast-search')?.remove();
      const form = document.querySelector('main form,.g-main form,form');
      const parent = form?.parentElement || document.querySelector('main') || document.body;
      const panel = document.createElement('section');
      panel.id = 'yomu-fast-search';
      panel.dataset.run = String(id);

      const head = document.createElement('div');
      head.className = 'yfs-head';
      const title = document.createElement('div');
      title.className = 'yfs-title';
      title.textContent = `Matches for “${query}”`;
      const meta = document.createElement('div');
      meta.className = 'yfs-meta';
      meta.textContent = sources.length ? `0 / ${sources.length} sources checked` : 'Fast results ready';
      head.append(title, meta);

      const grid = document.createElement('div');
      grid.className = 'yfs-grid';
      for (const source of sources) {
        const card = document.createElement('article');
        card.className = 'yfs-card';
        card.dataset.sourceId = source.id;
        const wait = document.createElement('div');
        wait.className = 'yfs-wait';
        const inner = document.createElement('div');
        const logo = document.createElement('img');
        logo.className = 'yfs-logo';
        logo.src = '/brand/yomu-mark.svg';
        logo.alt = 'Yomu';
        const name = document.createElement('div');
        name.className = 'yfs-source';
        name.textContent = source.label;
        const state = document.createElement('div');
        state.className = 'yfs-state';
        state.textContent = 'Checking this source…';
        inner.append(logo, name, state);
        wait.append(inner);
        card.append(wait);
        grid.append(card);
      }
      panel.append(head, grid);
      if (form?.nextSibling) parent.insertBefore(panel, form.nextSibling);
      else parent.append(panel);
      return panel;
    };
    const panel = create();
    if (!panel) setTimeout(create, 60);
    return panel;
  }

  function panelFor(id) {
    const panel = document.getElementById('yomu-fast-search');
    return panel?.dataset.run === String(id) ? panel : null;
  }

  function updateMeta(id, done, total, hits) {
    const panel = panelFor(id);
    const meta = panel?.querySelector('.yfs-meta');
    if (meta) meta.textContent = `${done} / ${total} sources checked · ${hits} match${hits === 1 ? '' : 'es'} found`;
  }

  function markMiss(id, source, message) {
    const panel = panelFor(id);
    const card = panel?.querySelector(`.yfs-card[data-source-id="${CSS.escape(source.id)}"]`);
    if (!card) return;
    card.classList.add('is-miss');
    const state = card.querySelector('.yfs-state');
    if (state) state.textContent = message;
    setTimeout(() => {
      if (id === runId && card.isConnected) card.remove();
    }, 1300);
  }

  function markHit(id, source, item) {
    const panel = panelFor(id);
    const card = panel?.querySelector(`.yfs-card[data-source-id="${CSS.escape(source.id)}"]`);
    if (!card) return;
    card.className = 'yfs-card is-done is-hit';
    card.textContent = '';

    const anchor = document.createElement('a');
    anchor.className = 'yfs-link';
    const bound = {
      ...item,
      seriesId: String(item.id),
      sourceId: source.id,
      sourceName: source.label,
      providers: [{ id: source.providerId, name: source.label, kind: 'extension', seriesId: String(item.id) }],
    };
    anchor.href = `/series/${encodeURIComponent(item.id)}?source=${encodeURIComponent(source.id)}`;
    if (window.YomuOpenTitle?.bind) window.YomuOpenTitle.bind(anchor, bound);

    const cover = document.createElement('img');
    cover.className = 'yfs-cover';
    cover.loading = 'lazy';
    cover.alt = '';
    cover.src = String(item.cover || '/brand/yomu-loader-ink.webp');
    const copy = document.createElement('div');
    copy.className = 'yfs-copy';
    const title = document.createElement('div');
    title.className = 'yfs-name';
    title.textContent = String(item.title || 'Untitled');
    const from = document.createElement('div');
    from.className = 'yfs-from';
    from.textContent = `${source.label} · ready`;
    copy.append(title, from);
    anchor.append(cover, copy);
    card.append(anchor);
  }

  async function searchSource(source, query, aliases) {
    const terms = [query, ...aliases].filter(Boolean).slice(0, 2);
    let last = { source, ok: false, series: [] };
    for (let i = 0; i < terms.length; i += 1) {
      try {
        const endpoint = new URL('search', source.api);
        endpoint.searchParams.set('q', terms[i]);
        endpoint.searchParams.set('page', '1');
        const response = await baseFetch(endpoint.toString(), {
          cache: 'no-store',
          signal: AbortSignal.timeout(i === 0 ? QUERY_TIMEOUT_MS : ALIAS_TIMEOUT_MS),
        });
        const body = response.ok ? await response.json().catch(() => null) : null;
        const series = Array.isArray(body?.series) ? body.series : [];
        last = { source, ok: response.ok && Array.isArray(body?.series), series, status: response.status };
        if (series.some((item) => score(item, query) >= 0.58)) break;
      } catch (error) {
        last = { source, ok: false, series: [], error: String(error?.message || error || 'search failed') };
      }
    }
    return last;
  }

  async function streamSources(id, query, sources, aliases) {
    let cursor = 0;
    let done = 0;
    let hits = 0;
    const runner = async () => {
      while (id === runId) {
        const index = cursor++;
        if (index >= sources.length) return;
        const source = sources[index];
        const batch = await searchSource(source, query, aliases);
        if (id !== runId) return;
        const best = [...(batch.series || [])]
          .map((item) => ({ item, score: score(item, query) }))
          .sort((a, b) => b.score - a.score)[0];
        if (best?.score >= 0.48) {
          hits += 1;
          markHit(id, source, best.item);
        } else {
          markMiss(id, source, batch.ok ? 'No close match here' : 'Source did not answer');
        }
        done += 1;
        updateMeta(id, done, sources.length, hits);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, sources.length)) }, runner));
    if (id !== runId) return;
    const panel = panelFor(id);
    const title = panel?.querySelector('.yfs-title');
    if (title) title.textContent = hits ? `More matches for “${query}”` : `Search finished for “${query}”`;
  }

  function startProgressiveSearch(query, body) {
    const id = ++runId;
    const sources = enabledSources();
    const represented = new Set((body?.series || [])
      .filter((item) => score(item, query) >= 0.62)
      .flatMap((item) => (item.providers || []).map((provider) => String(provider?.id || ''))));
    const missing = sources.filter((source) => !represented.has(source.providerId));
    const top = [...(body?.series || [])].sort((a, b) => score(b, query) - score(a, query))[0];
    const aliases = [top?.title, ...(top?.altTitles || [])]
      .map(String)
      .filter((title) => title && normalize(title) !== normalize(query))
      .slice(0, 1);

    if (!missing.length) {
      document.getElementById('yomu-fast-search')?.remove();
      return;
    }
    mountPanel(id, query, missing);
    streamSources(id, query, missing, aliases).catch(() => {});
  }

  window.fetch = async (input, init) => {
    const target = requestTarget(input);
    if (!target || requestMethod(input, init) !== 'GET') return wrappedFetch(input, init);
    if (target.origin !== location.origin || target.pathname !== '/api/catalog/search' || !target.searchParams.get('q')?.trim()) {
      return wrappedFetch(input, init);
    }

    const query = target.searchParams.get('q').trim();
    const response = await baseFetch(input, init);
    if (!response.ok) return response;
    const body = await response.clone().json().catch(() => null);
    if (!Array.isArray(body?.series)) return response;

    // Give React the server-ranked matches immediately. Slow device sources are
    // streamed into Yomu tiles in the background instead of blocking the page.
    setTimeout(() => startProgressiveSearch(query, body), 0);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('cache-control', 'no-store, max-age=0');
    headers.set('x-yomu-progressive-search', '1');
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
})();
