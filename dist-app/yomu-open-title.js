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

  /* --- which providers can actually serve a page --------------------------- */

  let readOnly = null;
  let learning = null;

  function learnCapabilities() {
    if (readOnly) return Promise.resolve(readOnly);
    if (learning) return learning;
    learning = fetch('/api/ext/sources')
      .then((r) => r.json())
      .then((body) => {
        const out = new Set();
        for (const e of body.extensions || []) {
          if (!e.capabilities?.pages) out.add('yomuext-' + e.id);
        }
        readOnly = out;
        return out;
      })
      .catch(() => {
        /* Not knowing is survivable: ranking falls back to the catalog's own
           order, which is what happened before any of this existed. */
        readOnly = new Set();
        return readOnly;
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
   * @param entry    { providers: [{ id, name, kind, seriesId }], title }
   * @param have     Set of app source ids this device has enabled
   * @param noPages  Set of app source ids that cannot serve pages
   */
  function pick(entry, have, noPages) {
    const providers = entry?.providers;
    if (!Array.isArray(providers) || !providers.length) return null;
    const enabled = have || new Set();
    const blind = noPages || new Set();
    const rank = (p) => {
      const id = appSourceId(p.id);
      return (blind.has(id) ? 2 : 0) + (enabled.has(id) ? 0 : 1);
    };
    const best = [...providers].sort((a, b) => rank(a) - rank(b))[0];
    if (!best || blind.has(appSourceId(best.id))) return null;
    return { seriesId: best.seriesId, sourceId: appSourceId(best.id), name: best.name };
  }

  const href = (seriesId, sourceId) =>
    '/series/' + encodeURIComponent(seriesId) + '?source=' + encodeURIComponent(sourceId);

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
      await learnCapabilities();
      return pick(item, enabledSourceIds(), readOnly);
    }

    const title = String(item.title || '').trim();
    if (!title) return null;

    const key = keyOf(item);
    const hit = cache()[key];
    if (hit && hit.seriesId && hit.sourceId) return { seriesId: hit.seriesId, sourceId: hit.sourceId, name: hit.name || '' };
    if (hit && hit.miss) return null;

    let entries = [];
    try {
      await learnCapabilities();
      let adult = false;
      try { adult = localStorage.getItem('yomu.v1.adult') === 'on'; } catch {}
      const url = '/api/catalog/search?q=' + encodeURIComponent(title) + (adult ? '&adult=1' : '');
      const response = await fetch(url);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      entries = (await response.json()).series || [];
    } catch {
      return null;
    }

    const found = pick(match(entries, item), enabledSourceIds(), readOnly);
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
    const to = found
      ? href(found.seriesId, found.sourceId)
      : '/search?q=' + encodeURIComponent(String(item?.title || ''));
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
    node.href = '/search?q=' + encodeURIComponent(String(item?.title || ''));
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

  const api = { appSourceId, pick, match, href, resolve, open, bind, learnCapabilities, enabledSourceIds };
  if (typeof window !== 'undefined') window.YomuOpenTitle = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { appSourceId, pick, match, href };
  }

  /* Warm the capability list once the page is quiet, so the first click is
     one request rather than two. */
  if (browser) {
    const warm = () => { if (!document.hidden) learnCapabilities(); };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => setTimeout(warm, 1200));
    else setTimeout(warm, 1200);
  }
})();
