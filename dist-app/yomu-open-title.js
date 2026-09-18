/**
 * One answer to "what happens when I click a title".
 *
 * Yomu draws titles in a dozen places -- the ranked rails on Home and
 * Discover, the genre grids, search results, the roulette, a series page's
 * recommendations -- and they did not all agree on where a click goes. The
 * hand-written pages open the Yomu series screen; the ranked rails opened
 * *search*, prefilled with the title, because a ranked AniList title has no
 * source-bound id and search is the screen that knows how to find one.
 *
 * That is a reasonable implementation and a bad destination. It asks the
 * reader to finish a job the app can do: they clicked a specific title, and
 * they get a list of results to pick the same title out of again. The fix is
 * not to teach every surface to resolve; it is to have exactly one resolver
 * and let every surface call it.
 *
 * The rules it keeps are the ones find.html already worked out, because they
 * are correct and were only ever written down once:
 *
 *   - A source that cannot serve pages is never the destination. Comick has
 *     the best metadata and the widest catalog, which is exactly why it comes
 *     back first, and asking it for a chapter is a 502.
 *   - A source this device has enabled beats one it has not.
 *   - Within those two, the catalog's own order is already best-first.
 *
 * `sourceId` is retrieval metadata. It decides *which* copy opens, never
 * *whether* the series screen is where the click lands.
 *
 * Nothing here fetches until something is clicked, and a resolution is
 * remembered for a day so the second click on the same rail is instant.
 */
(() => {
  'use strict';

  const CACHE_KEY = 'yomu.v1.openTitle';
  const CACHE_MS = 24 * 60 * 60 * 1000;
  const CACHE_MAX = 240;
  const COLLECTION_KEY = 'yomu.v1.collection';

  const browser = typeof document !== 'undefined';

  /* --- the two vocabularies ------------------------------------------------ *
   *
   * The catalog names a provider its own way; the app addresses a source by
   * the id it carries in the saved collection. Same source, two spellings.
   */
  function appSourceId(providerId) {
    const id = String(providerId || '');
    if (id.startsWith('ext:')) return 'yomuext-' + id.slice(4);
    if (id.startsWith('suwayomi:')) return 'mihon-' + id.slice(9);
    return id;
  }

  /* --- which providers can actually serve a page --------------------------- *
   *
   * This is safety-critical routing information, not a nicety, and the first
   * version got its failure mode backwards: a failed lookup produced an empty
   * "cannot serve pages" set, so *unknown* was read as *readable* and a
   * metadata-only provider became a destination that 502s on the first
   * chapter. One offline moment was enough to do it.
   *
   * Three sources, in order, and the last one always answers:
   *
   *   1. the live call, which is same-origin and cheap;
   *   2. the last successful answer, kept for a week -- capabilities change
   *      when an extension is rewritten, not between page loads;
   *   3. a baked table of providers known to be metadata-only.
   *
   * And the ranking below treats *known readable* as strictly better than
   * *unknown*, so a provider nobody has vouched for is only ever chosen when
   * there is nothing better. Blind providers are never chosen at all.
   */

  const CAPS_KEY = 'yomu.v1.capabilities';
  const CAPS_MS = 7 * 24 * 60 * 60 * 1000;

  /**
   * Known metadata-only, baked in.
   *
   * Comick is the one this exists for: it has the best metadata and the
   * widest catalog, which is exactly why it comes back first, and asking it
   * for a chapter is a 502. Being wrong here is cheap in one direction only
   * -- a source listed and readable just loses a little ranking -- so the
   * table errs toward listing.
   */
  const BAKED_BLIND = ['yomuext-comick'];

  /** Sources readable by definition, whatever the extension registry says. */
  const NATIVE_READABLE = ['mangadex'];

  /* { blind: Set, readable: Set, source: 'live'|'cache'|'baked' } */
  let caps = null;
  let learning = null;

  function cachedCaps() {
    try {
      const raw = JSON.parse(localStorage.getItem(CAPS_KEY) || 'null');
      if (!raw || !(raw.at > Date.now() - CAPS_MS)) return null;
      if (!Array.isArray(raw.blind) || !Array.isArray(raw.readable)) return null;
      return { blind: new Set(raw.blind), readable: new Set(raw.readable), source: 'cache' };
    } catch { return null; }
  }

  function bakedCaps() {
    return { blind: new Set(BAKED_BLIND), readable: new Set(NATIVE_READABLE), source: 'baked' };
  }

  /** Never returns null, and never returns an empty blind set by accident. */
  function fallbackCaps() {
    const hit = cachedCaps();
    if (!hit) return bakedCaps();
    /* Even a cached answer keeps the baked table under it: an extension that
       was readable last week and has since been rewritten as metadata-only
       should still not be a destination. */
    for (const id of BAKED_BLIND) { hit.blind.add(id); hit.readable.delete(id); }
    return hit;
  }

  function learnCapabilities() {
    if (caps) return Promise.resolve(caps);
    if (learning) return learning;
    learning = fetch('/api/ext/sources')
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((body) => {
        const list = body && Array.isArray(body.extensions) ? body.extensions : null;
        /* A 200 with the wrong shape is a failure, not an empty registry.
           Treating it as "no extension is blind" is the bug this replaces. */
        if (!list) throw new Error('malformed');
        const blind = new Set(BAKED_BLIND);
        const readable = new Set(NATIVE_READABLE);
        for (const e of list) {
          if (!e || !e.id) continue;
          const id = 'yomuext-' + e.id;
          if (e.capabilities && e.capabilities.pages) readable.add(id);
          else blind.add(id);
        }
        caps = { blind, readable, source: 'live' };
        try {
          localStorage.setItem(CAPS_KEY, JSON.stringify({
            at: Date.now(), blind: [...blind], readable: [...readable],
          }));
        } catch {}
        return caps;
      })
      .catch(() => {
        caps = fallbackCaps();
        return caps;
      })
      .finally(() => { learning = null; });
    return learning;
  }

  function enabledSourceIds() {
    try {
      const raw = JSON.parse(localStorage.getItem(COLLECTION_KEY) || 'null');
      const list = Array.isArray(raw?.sources) ? raw.sources : [];
      const ids = new Set(list.filter((s) => s.enabled !== false).map((s) => String(s.id)));
      /* MangaDex is built in and is not always written to the collection. */
      ids.add('mangadex');
      return ids;
    } catch { return new Set(['mangadex']); }
  }

  /**
   * Pure: a catalog entry and this device's situation -> where to send them.
   *
   * Three tiers, and the order between them is the safety property:
   *
   *   0  known readable        somebody said this source can serve pages
   *   1  unknown               nobody has said either way
   *   2  known metadata-only   never a destination, at any price
   *
   * Enablement breaks ties *within* a tier, never across one, so an enabled
   * source of unknown capability does not outrank a known-readable one the
   * reader has not enabled -- the reader can add a source, but they cannot
   * make a metadata mirror serve pages.
   *
   * @param entry  { providers: [{ id, name, kind, seriesId }], title }
   * @param have   Set of app source ids this device has enabled
   * @param caps   { blind: Set, readable: Set } -- never null in practice,
   *               because learnCapabilities() always resolves to something
   */
  function pick(entry, have, caps) {
    const providers = entry?.providers;
    if (!Array.isArray(providers) || !providers.length) return null;
    const enabled = have || new Set();
    const blind = (caps && caps.blind) || new Set();
    const readable = (caps && caps.readable) || new Set();
    const tier = (id) => (blind.has(id) ? 2 : readable.has(id) ? 0 : 1);
    const rank = (p) => {
      const id = appSourceId(p.id);
      return tier(id) * 10 + (enabled.has(id) ? 0 : 1);
    };
    const best = [...providers].sort((a, b) => rank(a) - rank(b))[0];
    if (!best || tier(appSourceId(best.id)) === 2) return null;
    return { seriesId: best.seriesId, sourceId: appSourceId(best.id), name: best.name };
  }

  const href = (seriesId, sourceId) =>
    '/series/' + encodeURIComponent(seriesId) + '?source=' + encodeURIComponent(sourceId);

  /* --- the address a title has before any of this runs --------------------- *
   *
   * A href cannot be made correct by intercepting the click on it. The first
   * version pointed every rail card at `/search?q=` and swapped in the series
   * screen from a click handler, which worked for a plain left click and for
   * nothing else: cmd-click, middle-click, "copy link address", a shared URL,
   * a bookmark and a restored session all followed the href into Search.
   *
   * `/title/<slug>?q=<name>&al=<anilistId>` is answered by the Worker
   * (worker/title.ts), which resolves it and 302s to the series screen. The
   * slug is decoration so a pasted link says what it is; `q` carries the exact
   * name, because the slug has already lost its punctuation.
   */

  const slugify = (name) => String(name || '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  function canonicalHref(item) {
    const name = String(item?.title || '').trim();
    if (!name) return '/';
    const id = Number(item?.anilistId ?? (item?.source === 'anilist' ? item?.id : null)) || null;
    const slug = slugify(name) || 'title';
    const query = new URLSearchParams({ q: name });
    if (id) query.set('al', String(id));
    return '/title/' + slug + '?' + query.toString();
  }

  /* --- remembering --------------------------------------------------------- */

  const keyOf = (item) =>
    (item && item.anilistId ? 'al:' + item.anilistId
      : item && item.id && item.source === 'anilist' ? 'al:' + item.id
        : 'q:' + String(item?.title || '').trim().toLowerCase());

  function cache() {
    try {
      const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {};
      const cutoff = Date.now() - CACHE_MS;
      for (const k of Object.keys(all)) if (!(all[k]?.at > cutoff)) delete all[k];
      return all;
    } catch { return {}; }
  }

  function remember(key, value) {
    try {
      const all = cache();
      all[key] = { ...value, at: Date.now() };
      const keys = Object.keys(all);
      if (keys.length > CACHE_MAX) {
        keys.sort((a, b) => all[a].at - all[b].at);
        for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete all[k];
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch {}
  }

  /* --- resolving ------------------------------------------------------------ */

  /**
   * Which of the search's entries is the title that was clicked.
   *
   * An AniList id on both sides is conclusive -- dedupe() carries it through
   * -- and otherwise the catalog has already ranked by relevance against the
   * query, so the first entry is the answer. A loose title match is not
   * second-guessed here: doing that well is what rankByRelevance already is.
   */
  function match(entries, item) {
    const rows = Array.isArray(entries) ? entries : [];
    if (!rows.length) return null;
    const wanted = Number(item?.anilistId ?? (item?.source === 'anilist' ? item?.id : null));
    if (Number.isFinite(wanted) && wanted > 0) {
      const exact = rows.find((e) => Number(e.anilistId) === wanted);
      if (exact) return exact;
    }
    const name = String(item?.title || '').trim().toLowerCase();
    const same = rows.find((e) => String(e.title || '').trim().toLowerCase() === name);
    return same || rows[0];
  }

  /**
   * @returns { seriesId, sourceId, name } or null when nothing readable
   *          carries this title.
   */
  async function resolve(item) {
    if (!item) return null;

    /* Already source-bound: a tile that knows its own series id is not a
       question, and must not become a network round trip. */
    if (item.seriesId && item.sourceId) {
      return { seriesId: String(item.seriesId), sourceId: String(item.sourceId), name: item.sourceName || '' };
    }
    if (Array.isArray(item.providers) && item.providers.length) {
      return pick(item, enabledSourceIds(), await learnCapabilities());
    }

    const title = String(item.title || '').trim();
    if (!title) return null;

    const key = keyOf(item);
    const hit = cache()[key];
    if (hit && hit.seriesId && hit.sourceId) return { seriesId: hit.seriesId, sourceId: hit.sourceId, name: hit.name || '' };
    if (hit && hit.miss) return null;

    let entries = [];
    let known;
    try {
      known = await learnCapabilities();
      let adult = false;
      try { adult = localStorage.getItem('yomu.v1.adult') === 'on'; } catch {}
      const url = '/api/catalog/search?q=' + encodeURIComponent(title) + (adult ? '&adult=1' : '');
      const response = await fetch(url);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      entries = (await response.json()).series || [];
    } catch {
      return null;
    }

    const found = pick(match(entries, item), enabledSourceIds(), known);
    remember(key, found || { miss: true });
    return found;
  }

  /**
   * The click itself.
   *
   * Falls back to search rather than to nothing: a title no enabled source
   * carries is a real answer, and the search screen is where a reader turns
   * a title into a source they can add. That is the honest version of what
   * the rails used to do unconditionally.
   */
  async function open(item, opts) {
    const found = await resolve(item);
    /* Unresolved goes to the canonical route rather than straight to Search:
       the Worker gets its own attempt with the whole catalog behind it, and
       falls through to Search itself if that fails too. One destination, one
       fallback, decided in one place. */
    const to = found ? href(found.seriesId, found.sourceId) : canonicalHref(item);
    if (opts?.dryRun) return to;
    location.href = to;
    return to;
  }

  /**
   * Wire an anchor to a title: the href is the fallback so middle-click and
   * "open in new tab" still land somewhere sensible, and a plain left click
   * is intercepted and resolved.
   */
  function bind(node, item, onClick) {
    if (!node) return node;
    /* Valid before JavaScript, and identical for every way of following a
       link. The handler below is a shortcut, not the thing that makes it
       work: it knows which sources this device has enabled, which the Worker
       cannot, so a plain click skips a round trip. */
    node.href = canonicalHref(item);
    node.addEventListener('click', (event) => {
      /* Leave the modified clicks to the browser -- they are how someone
         opens a second tab on purpose. */
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (onClick) { try { onClick(); } catch {} }
      node.classList.add('is-opening');
      open(item).finally(() => node.classList.remove('is-opening'));
    });
    return node;
  }

  const api = {
    appSourceId, pick, match, href, canonicalHref, slugify, resolve, open, bind, learnCapabilities, enabledSourceIds,
    /** What the router currently believes, and where it learnt it. */
    capabilities: () => (caps ? { blind: [...caps.blind], readable: [...caps.readable], source: caps.source } : null),
    BAKED_BLIND, NATIVE_READABLE,
  };
  if (typeof window !== 'undefined') window.YomuOpenTitle = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { appSourceId, pick, match, href, canonicalHref, slugify, BAKED_BLIND, NATIVE_READABLE };
  }

  /* Warm the capability list once the page is quiet, so the first click is
     one request rather than two. */
  if (browser) {
    const warm = () => { if (!document.hidden) learnCapabilities(); };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => setTimeout(warm, 1200));
    else setTimeout(warm, 1200);
  }
})();
