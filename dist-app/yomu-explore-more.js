/**
 * Yomu progressive exploration controls.
 *
 * Every ranked rail gets one More button. Search gets one More results button
 * that walks page 2+ of the reader's enabled sources instead of pretending
 * page 1 is the whole catalog. Work stays segmented and concurrency-bounded.
 *
 * ## What changed, and why it had to
 *
 * This file used to bind rails twice. The first pass appended a real pager to
 * every `.yr-rail__head`. The second pass walked every `h2`, called
 * `heading.closest('section,div')` to find the shelf it belonged to, and
 * skipped it when that node was a `.yr-rail` -- except a rail's heading lives
 * inside `.yr-rail__head`, which is a *div*, so `closest()` never returned the
 * rail and the guard never fired. Every rail therefore also got a second pill
 * that did something else entirely: `location.href = /find?browse=...`. That
 * is Figure 1 of the recovery spec, and Figure 2 is the same bug with a failed
 * page 2 leaving `Retry` on one control and `More` on the other.
 *
 * The generic pass is gone rather than guarded. A shelf that genuinely is not
 * a `.yr-rail` is a React surface this file does not own, and the honest
 * answer to "it has no More button" is to make it a rail, not to staple a
 * navigation link to its heading and call it pagination.
 *
 * Ownership now lives in yomu-pager.js: one control per host, deterministic
 * labels, in-flight guard, retry in place. Cards come from
 * yomu-titlecard.js, so a title appended by More is the same card as the ones
 * already on screen.
 */
(() => {
  'use strict';
  if (window.__YomuExploreMore) return;
  window.__YomuExploreMore = true;

  const COLLECTION_KEY = 'yomu.v1.collection';
  const NAMI = /(?:^|[^a-z])nami[\s._-]*comi(?:[^a-z]|$)|namicomi/i;
  const SEARCH_CONCURRENCY = 8;
  const SEARCH_SEGMENT = 16;
  const RAIL_SEGMENT = 14;
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
      .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
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

  /**
   * One more page for one rail.
   *
   * Returns false when the source is exhausted (the pager settles on End) and
   * throws when the page failed (the pager offers Retry and the cards already
   * on screen are untouched). It never removes a card and never navigates.
   */
  async function moreRail(section, config, page) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: railQuery(config, page, currentCountry()) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body?.errors?.length) throw new Error(body.errors[0]?.message || 'graphql');
      const rows = (body?.data?.Page?.media || []).map(shape).filter(Boolean);
      const strip = section.querySelector('.yr-strip');
      if (!strip || !rows.length) return false;

      const existing = new Set([...strip.querySelectorAll('.yt-card')]
        .map((node) => norm(node.getAttribute('aria-label') || node.querySelector('.yt-card__title')?.textContent)));
      let added = 0;
      for (const row of rows) {
        if (existing.has(norm(row.title))) continue;
        existing.add(norm(row.title));
        const card = window.YomuRails?.card?.(row, config.badge);
        if (card) { strip.append(card); added += 1; }
      }
      /* A page of nothing but titles already on the rail is not the end of the
         catalog -- the next press asks for the page after it. */
      return added > 0 || rows.length > 0;
    } finally {
      clearTimeout(timer);
    }
  }

  function bindRails() {
    if (!window.YomuPager) return;
    for (const section of document.querySelectorAll('.yr-rail')) {
      const config = railConfig(section);
      const head = section.querySelector('.yr-rail__head');
      if (!config || !head) continue;
      window.YomuPager.claim(head, {
        key: `rail:${config.id}`,
        scope: 'rail',
        aria: `Load more ${section.querySelector('.yr-rail__title')?.textContent || 'titles'}`,
        onMore: ({ page }) => moreRail(section, config, page),
      });
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
        const apiLike = row.kind === 'api' || /^yomuext-|^mihon-/.test(String(row.id || ''))
          || /fabric|extension|suwayomi/i.test(String(row.runtime || row.category || row.kind || ''))
          || /\/api\//i.test(u.pathname);
        if (!apiLike) continue;
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

  function activeQuery() {
    return String(document.querySelector('input[type="search"]')?.value || new URLSearchParams(location.search).get('q') || '').trim();
  }

  async function sourcePage(source, query, page) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
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

  /**
   * Deeper pages of the reader's enabled sources, appended after the results
   * already on the page. Per-source page state advances on every press, which
   * is what stops the button from re-fetching page 1 forever.
   */
  async function moreSearch(grid, note, page) {
    const query = activeQuery();
    if (!query) return false;
    const sources = collectionSources();
    if (!sources.length) return false;
    note.textContent = `Checking page ${page} across ${sources.length} enabled sources…`;

    const batches = await pool(sources, async (source) => ({ source, rows: await sourcePage(source, query, page) }));
    const existing = new Set([...grid.querySelectorAll('.yt-card__title, .tile .t')].map((n) => norm(n.textContent)));
    const picked = [];
    let offered = 0;
    for (const batch of batches) {
      offered += batch?.rows?.length || 0;
      if (!batch?.rows?.length) continue;
      let kept = 0;
      for (const item of batch.rows) {
        if (!item?.id || !item?.title || existing.has(norm(item.title))) continue;
        existing.add(norm(item.title));
        picked.push({ item, source: batch.source });
        if (++kept >= 3) break;
      }
    }

    const rows = picked.slice(0, SEARCH_SEGMENT);
    const anchor = grid.querySelector('.yomu-search-more-wrap');
    for (const row of rows) {
      const card = window.YomuTitleCard.create(
        { ...row.item, providers: [{ id: row.source.id, name: row.source.label, seriesId: row.item.id }] },
        {
          href: `/series/${encodeURIComponent(row.item.id)}?source=${encodeURIComponent(row.source.id)}`,
          onOpen: (event) => {
            event.preventDefault();
            location.href = `/series/${encodeURIComponent(row.item.id)}?source=${encodeURIComponent(row.source.id)}`;
          },
        },
      );
      if (anchor) grid.insertBefore(card, anchor);
      else grid.append(card);
    }

    searchPages.set(norm(query), page + 1);
    note.textContent = rows.length
      ? `${rows.length} more titles added · page ${page}`
      : `No new titles on page ${page} · try the next page`;
    /* A page whose titles were all already on screen is not the end -- several
       sources repeat across pages. A page where every source returned nothing
       at all is, and the pager settles on End rather than offering a press
       that cannot do anything. */
    return offered > 0;
  }

  function ensureSearchFooter() {
    if (!window.YomuPager) return;
    const grid = document.getElementById('results') || document.querySelector('.grid');
    if (!grid || !activeQuery()) return;

    let wrap = grid.querySelector('.yomu-search-more-wrap');
    if (!wrap) {
      wrap = el('div', 'yomu-search-more-wrap');
      wrap.append(el('span', 'yomu-search-more-note', 'Explore deeper pages from your enabled sources'));
      grid.append(wrap);
    }
    const note = wrap.querySelector('.yomu-search-more-note');
    window.YomuPager.claim(wrap, {
      key: 'search',
      scope: 'search',
      label: 'More results',
      aria: 'Load more search results from your enabled sources',
      onMore: ({ page }) => moreSearch(grid, note, Math.max(page, searchPages.get(norm(activeQuery())) || 2)),
    });
  }

  function focusBrowseRail() {
    const wanted = new URLSearchParams(location.search).get('browse');
    if (!wanted) return;
    const section = [...document.querySelectorAll('.yr-rail')].find((node) => railConfig(node)?.id === wanted);
    if (!section || section.dataset.yomuBrowseFocused) return;
    section.dataset.yomuBrowseFocused = '1';
    section.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function sync() {
    bindRails();
    if (/\/(?:find|search)(?:\.html)?\/?$/.test(location.pathname)) {
      ensureSearchFooter();
      focusBrowseRail();
    }
  }

  const start = () => {
    sync();
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      /* rAF is frozen in a background tab, and a rail that only binds when the
         tab is visible is a rail with no More button for anyone who opened it
         in a second tab. The timeout is the floor under that. */
      const run = () => { queued = false; sync(); };
      requestAnimationFrame(run);
      setTimeout(() => { if (queued) run(); }, 250);
    };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    addEventListener('popstate', schedule);
    addEventListener('hashchange', schedule);
    document.querySelector('input[type="search"]')?.addEventListener('input', () => setTimeout(sync, 0));
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
