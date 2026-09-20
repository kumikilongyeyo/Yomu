/**
 * Yomu progressive exploration controls.
 *
 * Every ranked rail gets a real More button. Search gets a More results button
 * that walks page 2+ of the user's enabled sources instead of pretending page 1
 * is the whole catalog. Work stays segmented and concurrency-bounded.
 */
(() => {
  'use strict';
  if (window.__YomuExploreMore) return;
  window.__YomuExploreMore = true;

  const MARK = '/brand/yomu-icon.svg';
  const FALLBACK = '/brand/yomu-loader-ink.webp';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const NAMI = /(?:^|[^a-z])nami[\s._-]*comi(?:[^a-z]|$)|namicomi/i;
  const SEARCH_CONCURRENCY = 8;
  const SEARCH_SEGMENT = 16;
  const RAIL_SEGMENT = 14;
  const railPages = new WeakMap();
  const searchPages = new Map();

  const RAILS = {
    'trending now': { id: 'trending', sort: 'TRENDING_DESC', badge: 'Trending' },
    'popular right now': { id: 'popular', sort: 'POPULARITY_DESC', badge: null },
    'most read': { id: 'popular', sort: 'POPULARITY_DESC', badge: null },
    'highest rated': { id: 'top', sort: 'SCORE_DESC', badge: null },
    'hidden gems': { id: 'gems', sort: 'SCORE_DESC', badge: 'Gem', extra: 'averageScore_greater:75,popularity_lesser:20000' },
    'new series': { id: 'fresh', sort: 'START_DATE_DESC', badge: 'New', extra: 'status:RELEASING' },
  };

  function norm(v) {
    return String(v || '').toLowerCase().normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function installCss() {
    if (document.getElementById('yomu-explore-more-css')) return;
    const style = document.createElement('style');
    style.id = 'yomu-explore-more-css';
    style.textContent = `
.yr-rail__head{display:flex!important;align-items:baseline!important;gap:10px!important}
.yr-rail__head .yomu-rail-more{margin-left:auto;flex:none}
.yomu-rail-more,.yomu-search-more{
  min-height:34px;padding:0 13px;border:1px solid var(--accentLine,#ffc45f66);
  border-radius:999px;background:var(--accentSoft,#ffc45f1f);color:var(--accent,#ffc45f);
  font:800 11px/1 var(--uiFont,system-ui);cursor:pointer
}
.yomu-rail-more:hover,.yomu-search-more:hover{background:color-mix(in srgb,var(--accentSoft,#ffc45f1f) 72%,var(--accent,#ffc45f) 28%)}
.yomu-rail-more:disabled,.yomu-search-more:disabled{opacity:.55;cursor:wait}
.yomu-rail-more:focus-visible,.yomu-search-more:focus-visible{outline:2px solid var(--accent,#ffc45f);outline-offset:3px}
.yomu-search-more-wrap{grid-column:1/-1;display:flex;justify-content:center;align-items:center;gap:10px;padding:14px 0 4px}
.yomu-search-more-note{color:var(--dim,#8fa0b4);font:600 11px/1.35 var(--uiFont,system-ui)}
.yomu-search-more-hit .tile-art{background:var(--raised,#25333e)}
@media(max-width:620px){.yomu-rail-more,.yomu-search-more{min-height:40px}}
`;
    document.head.append(style);
  }

  function currentCountry() {
    const selected = document.querySelector('[role="tab"][aria-selected="true"]');
    const label = norm(selected?.textContent);
    if (label === 'manga') return 'JP';
    if (label === 'manhwa') return 'KR';
    if (label === 'manhua') return 'CN';
    return '';
  }

  function railConfig(section) {
    const title = section.querySelector('.yr-rail__title,h2')?.textContent || '';
    return RAILS[norm(title)] || null;
  }

  function railQuery(config, page, country) {
    const args = [
      'type:MANGA',
      `sort:${config.sort}`,
      'isAdult:false',
      country ? `countryOfOrigin:${country}` : '',
      config.extra || '',
    ].filter(Boolean).join(',');
    return `query{Page(page:${page},perPage:${RAIL_SEGMENT}){media(${args}){id title{english romaji native} coverImage{large medium} genres averageScore popularity trending status countryOfOrigin startDate{year}}}}`;
  }

  function shape(media) {
    if (!media) return null;
    const title = media.title?.english || media.title?.romaji || media.title?.native;
    if (!title) return null;
    return {
      id: media.id,
      title,
      cover: media.coverImage?.large || media.coverImage?.medium || '',
      genres: media.genres || [],
      score: media.averageScore ?? null,
      popularity: media.popularity ?? 0,
      trending: media.trending ?? 0,
      status: media.status || '',
      country: media.countryOfOrigin || '',
      year: media.startDate?.year ?? null,
    };
  }

  async function moreRail(section, button, config) {
    if (button.disabled) return;
    const page = railPages.get(section) || 2;
    button.disabled = true;
    button.textContent = 'Loading…';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3600);
    try {
      const response = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: railQuery(config, page, currentCountry()) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const rows = (body?.data?.Page?.media || []).map(shape).filter(Boolean);
      const strip = section.querySelector('.yr-strip');
      if (!strip || !rows.length) {
        button.textContent = 'End';
        button.disabled = true;
        return;
      }
      const existing = new Set([...strip.querySelectorAll('.yr-card')].map((n) => norm(n.getAttribute('aria-label') || n.querySelector('.yr-card__title')?.textContent)));
      let added = 0;
      for (const row of rows) {
        if (existing.has(norm(row.title))) continue;
        const card = window.YomuRails?.card?.(row, config.badge);
        if (card) { strip.append(card); added++; }
      }
      railPages.set(section, page + 1);
      button.disabled = false;
      button.textContent = added ? 'More' : 'Try next';
      strip.scrollBy?.({ left: Math.max(220, strip.clientWidth * .72), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } catch {
      button.disabled = false;
      button.textContent = 'Retry';
    } finally {
      clearTimeout(timer);
    }
  }

  function bindRails() {
    for (const section of document.querySelectorAll('.yr-rail')) {
      if (section.dataset.yomuMoreBound) continue;
      const config = railConfig(section);
      if (!config) continue;
      const head = section.querySelector('.yr-rail__head');
      if (!head) continue;
      section.dataset.yomuMoreBound = '1';
      const button = el('button', 'yomu-rail-more', 'More');
      button.type = 'button';
      button.setAttribute('aria-label', `Load more ${section.querySelector('.yr-rail__title')?.textContent || 'titles'}`);
      button.addEventListener('click', () => moreRail(section, button, config));
      head.append(button);
    }
  }

  function collectionSources() {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(COLLECTION_KEY) || '{}')?.sources || []; } catch {}
    const out = [], seen = new Set();
    for (const row of rows) {
      if (!row || row.enabled === false || !row.id || NAMI.test(`${row.id || ''} ${row.label || ''} ${row.url || ''}`)) continue;
      const raw = row.api || row.url;
      if (!raw) continue;
      try {
        const u = new URL(String(raw), location.origin);
        if (!/^https?:$/.test(u.protocol)) continue;
        u.hash = ''; u.search = '';
        if (!u.pathname.endsWith('/')) u.pathname += '/';
        const api = u.toString();
        if (seen.has(api)) continue;
        seen.add(api);
        out.push({ id: String(row.id), label: String(row.label || row.name || row.id), api });
      } catch {}
    }
    return out;
  }

  async function pool(items, run, limit = SEARCH_CONCURRENCY) {
    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await run(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  function searchTile(item, source) {
    const tile = el('button', 'tile yv3-hit yomu-search-more-hit');
    tile.type = 'button';
    const art = el('span', 'tile-art');
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = item.cover || FALLBACK;
    img.addEventListener('error', () => { img.src = FALLBACK; }, { once: true });
    art.append(img);
    const copy = el('span', 'tile-copy');
    copy.append(el('span', 't', item.title || 'Untitled'), el('small', null, source.label));
    tile.append(art, copy);
    tile.addEventListener('click', () => {
      location.href = `/series/${encodeURIComponent(item.id)}?source=${encodeURIComponent(source.id)}`;
    });
    return tile;
  }

  function activeQuery() {
    return String(document.querySelector('input[type="search"]')?.value || new URLSearchParams(location.search).get('q') || '').trim();
  }

  async function sourcePage(source, query, page) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2300);
    try {
      const u = new URL('search', source.api);
      u.searchParams.set('q', query);
      u.searchParams.set('page', String(page));
      const response = await fetch(u.toString(), { cache: 'no-store', signal: controller.signal });
      const body = response.ok ? await response.json().catch(() => null) : null;
      return Array.isArray(body?.series) ? body.series : [];
    } catch { return []; }
    finally { clearTimeout(timer); }
  }

  function ensureSearchFooter() {
    const grid = document.getElementById('results') || document.querySelector('.grid');
    const query = activeQuery();
    if (!grid || !query) return;
    let wrap = grid.querySelector('.yomu-search-more-wrap');
    if (wrap) return;
    wrap = el('div', 'yomu-search-more-wrap');
    const note = el('span', 'yomu-search-more-note', 'Explore deeper pages from your enabled sources');
    const button = el('button', 'yomu-search-more', 'More results');
    button.type = 'button';
    button.addEventListener('click', async () => {
      const q = activeQuery();
      if (!q || button.disabled) return;
      const page = searchPages.get(norm(q)) || 2;
      const sources = collectionSources();
      button.disabled = true;
      button.textContent = 'Loading…';
      note.textContent = `Checking page ${page} across ${sources.length} enabled sources…`;
      const batches = await pool(sources, async (source) => ({ source, rows: await sourcePage(source, q, page) }));
      const existing = new Set([...grid.querySelectorAll('.tile .t')].map((n) => norm(n.textContent)));
      const bySource = [];
      for (const batch of batches) {
        if (!batch?.rows?.length) continue;
        let kept = 0;
        for (const item of batch.rows) {
          if (!item?.id || !item?.title || existing.has(norm(item.title))) continue;
          bySource.push({ item, source: batch.source });
          existing.add(norm(item.title));
          if (++kept >= 3) break; // fair mix: one source never floods a segment.
        }
      }
      const rows = bySource.slice(0, SEARCH_SEGMENT);
      for (const row of rows) grid.insertBefore(searchTile(row.item, row.source), wrap);
      searchPages.set(norm(q), page + 1);
      button.disabled = false;
      button.textContent = 'More results';
      note.textContent = rows.length
        ? `${rows.length} more titles added · page ${page}`
        : `No new titles on page ${page} · try the next page`;
    });
    wrap.append(note, button);
    grid.append(wrap);
  }

  function sync() {
    bindRails();
    if (/\/(?:find|search)(?:\.html)?\/?$/.test(location.pathname)) ensureSearchFooter();
  }

  installCss();
  const start = () => {
    sync();
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; sync(); });
    }).observe(document.body, { childList: true, subtree: true });
    document.querySelector('input[type="search"]')?.addEventListener('input', () => setTimeout(sync, 0));
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
