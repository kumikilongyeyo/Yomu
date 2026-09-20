/**
 * Yomu Library Engine
 *
 * Browse is a different problem from search. Search can fan out once for one
 * title; a library has to keep walking every enabled source without freezing
 * the page, repeating the first page forever, or letting the fastest provider
 * become the whole product.
 *
 * This engine is deliberately device-side because sources added from Source
 * Fabric live in yomu.v1.collection before the Worker registry knows about
 * them. Every enabled API source participates. Work is bounded by concurrency,
 * never by silently slicing the source list.
 */
(() => {
  'use strict';

  const COLLECTION_KEY = 'yomu.v1.collection';
  const ADULT_KEY = 'yomu.v1.adult';
  const CACHE_KEY = 'yomu.v1.libraryEngine';
  const CACHE_MS = 5 * 60 * 1000;
  const CONCURRENCY = 5;
  /* The first wave of a cold view opens wider: nothing is cached, nothing is
     queued, and every extra source in flight is another chance that the
     segment is complete before the slow ones answer. Later waves settle back
     to CONCURRENCY so browsing does not keep 8 sockets busy. */
  const FIRST_WAVE_CONCURRENCY = 8;
  /* No single wave may hold the visible batch longer than this. Stragglers
     keep running and land in their own queue for the next segment. */
  const WAVE_BUDGET_MS = 2600;
  const WAVE_TIMEOUT = Symbol('wave-timeout');
  const DEFAULT_SEGMENT = 10;
  const BLOCKED_SOURCE = /(?:^|[^a-z])nami[\s._-]*comi(?:[^a-z]|$)|namicomi/i;
  const OFFICIAL_SOURCE = /manga\s*plus|mangaplus|viz|webtoon|tapas|tappytoon|lezhin|kakao|naver|official/i;
  const baseFetch = window.fetch.bind(window);

  const states = new Map();
  const canonical = new Map();
  const catalog = [];
  const delivered = new Map();
  const inFlight = new Map();
  let sourceCursor = 0;
  let sourceMemo = null;
  let sourceMemoAt = 0;
  let prefetched = null;

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };

  const adultAllowed = () => {
    try { return localStorage.getItem(ADULT_KEY) === 'on'; }
    catch { return false; }
  };

  function normalize(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[’'`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(the|a|an|of|and|manga|manhwa|manhua|webtoon|comic|official|colou?red?|color|season|part|vol(?:ume)?|novel|remake|fan\s?colou?red)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function canonicalApi(value) {
    try {
      const url = new URL(String(value || ''), location.origin);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.hash = '';
      url.search = '';
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      return url.toString();
    } catch { return null; }
  }

  function blocked(source) {
    return BLOCKED_SOURCE.test([
      source?.id,
      source?.label,
      source?.name,
      source?.url,
      source?.api,
    ].filter(Boolean).join(' '));
  }

  function providerId(source) {
    const id = String(source.id || '');
    if (id.startsWith('yomuext-')) return `ext:${id.slice(8)}`;
    if (id.startsWith('mihon-')) return `suwayomi:${id.slice(6)}`;
    return id;
  }

  function collectionSources() {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    return Array.isArray(collection.sources) ? collection.sources : [];
  }

  async function registryApis() {
    try {
      const response = await baseFetch('/api/ext/sources', {
        cache: 'no-store',
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined,
      });
      if (!response.ok) return new Map();
      const body = await response.json().catch(() => null);
      const map = new Map();
      for (const ext of body?.extensions || []) {
        if (!ext?.id || !ext?.api) continue;
        map.set(`yomuext-${ext.id}`, {
          api: canonicalApi(ext.api),
          capabilities: ext.capabilities || {},
          nsfw: !!ext.nsfw,
          name: String(ext.name || ext.id),
        });
      }
      return map;
    } catch { return new Map(); }
  }

  /**
   * Every enabled source the reader chose. There is intentionally no .slice()
   * or fixed source-count cap here; request pressure is controlled by the pool.
   */
  async function sources(force = false) {
    const now = Date.now();
    if (!force && sourceMemo && now - sourceMemoAt < 30_000) return sourceMemo;
    const registry = await registryApis();
    const seen = new Set();
    const out = [];

    for (const raw of collectionSources()) {
      if (!raw || raw.enabled === false || raw.kind !== 'api' || blocked(raw)) continue;
      const id = String(raw.id || '').trim();
      if (!id || seen.has(id)) continue;
      const reg = registry.get(id);
      const api = canonicalApi(raw.url) || reg?.api;
      if (!api) continue;
      if (!adultAllowed() && (raw.nsfw || reg?.nsfw)) continue;
      seen.add(id);
      out.push({
        id,
        label: String(raw.label || raw.name || reg?.name || id),
        api,
        capabilities: reg?.capabilities || raw.capabilities || {},
        official: OFFICIAL_SOURCE.test(`${raw.label || ''} ${raw.name || ''} ${raw.url || ''}`),
      });
    }

    // MangaDex is built-in and older profiles do not persist it. It remains a
    // fallback source, not a monopoly: fairMix() caps any one provider's share.
    if (!seen.has('mangadex')) {
      out.push({
        id: 'mangadex',
        label: 'MangaDex',
        api: null,
        capabilities: { popular: true, latest: true, search: true },
        official: false,
        catalogFallback: true,
      });
    }

    out.sort((a, b) => Number(b.official) - Number(a.official));
    sourceMemo = out;
    sourceMemoAt = now;
    return out;
  }

  function stateFor(source, mode) {
    const key = `${source.id}|${mode}`;
    let state = states.get(key);
    if (!state) {
      state = { page: 1, queue: [], exhausted: false, failures: 0, fingerprint: '', lastMs: 0 };
      states.set(key, state);
    }
    return state;
  }

  /**
   * Which sources have actually answered.
   *
   * The explorer used to count only live `ok` health events, which made the
   * counter lie in the one case it mattered: a warm revisit. The cache serves
   * the first segment, nothing is fetched, no event fires, and the page reads
   * "43 enabled sources · 0 responding" underneath ten source-backed covers.
   * That is Figure 3 of the recovery spec, and it is a telemetry bug, not a
   * source bug.
   *
   * A source is responding when its data is what the reader is looking at:
   * it answered a page this session, it has rows queued, or rows it served
   * earlier are in the catalog this render came from. Sources the reader has
   * since disabled do not count, however warm their rows are.
   */
  function respondingIds(list) {
    const enabled = new Set((list || sourceMemo || []).map((source) => source.id));
    const ids = new Set();
    for (const [key, state] of states) {
      const id = key.slice(0, key.lastIndexOf('|'));
      if (!enabled.has(id)) continue;
      if (state.failures === 0 && (state.page > 1 || state.queue.length)) ids.add(id);
    }
    for (const row of catalog) {
      for (const id of row.__sourceIds || []) if (enabled.has(id)) ids.add(id);
    }
    return ids;
  }

  function sourceCategoryHint(source) {
    const text = `${source.label || ''} ${source.id || ''}`.toLowerCase();
    if (/manhwa|korean/.test(text)) return 'manhwa';
    if (/manhua|chinese/.test(text)) return 'manhua';
    if (/manga|japan/.test(text)) return 'manga';
    return '';
  }

  function categoryOf(item, source) {
    const direct = String(item?.category || '').toLowerCase();
    if (/manhwa/.test(direct)) return 'manhwa';
    if (/manhua/.test(direct)) return 'manhua';
    if (/manga/.test(direct)) return 'manga';
    const text = [item?.title, ...(item?.genres || [])].join(' ').toLowerCase();
    if (/manhwa|korean/.test(text)) return 'manhwa';
    if (/manhua|chinese|wuxia|xianxia|cultivation/.test(text)) return 'manhua';
    if (/manga|japanese/.test(text)) return 'manga';
    return sourceCategoryHint(source);
  }

  function makeProvider(source, item) {
    return {
      id: providerId(source),
      name: source.label,
      kind: source.id === 'mangadex' ? 'native' : 'extension',
      seriesId: String(item.id || ''),
    };
  }

  function mergeItem(source, item) {
    if (!item?.id || !item?.title || blocked(source)) return null;
    if (!adultAllowed() && item.nsfw) return null;
    const key = normalize(item.title);
    if (!key) return null;
    const provider = makeProvider(source, item);
    let row = canonical.get(key);
    if (!row) {
      row = {
        ...item,
        id: String(item.id),
        title: String(item.title),
        category: categoryOf(item, source) || item.category || '',
        providers: [provider],
        __sourceIds: [source.id],
        __firstSource: source.label,
        __official: !!source.official,
      };
      canonical.set(key, row);
      catalog.push(row);
      return row;
    }

    const providers = Array.isArray(row.providers) ? row.providers : [];
    if (!providers.some((p) => p.id === provider.id && String(p.seriesId) === provider.seriesId)) {
      row.providers = [...providers, provider];
    }
    if (!row.__sourceIds.includes(source.id)) row.__sourceIds.push(source.id);
    row.cover ||= item.cover;
    row.author ||= item.author;
    row.synopsis ||= item.synopsis;
    row.category ||= categoryOf(item, source) || item.category;
    row.status ||= item.status;
    row.year ||= item.year;
    row.updatedAt = Math.max(Number(row.updatedAt || 0), Number(item.updatedAt || 0));
    if (Array.isArray(item.genres) && item.genres.length) {
      row.genres = [...new Set([...(row.genres || []), ...item.genres])].slice(0, 30);
    }
    if (Array.isArray(item.altTitles) && item.altTitles.length) {
      row.altTitles = [...new Set([...(row.altTitles || []), ...item.altTitles])].slice(0, 16);
    }
    return row;
  }

  function endpointFor(source, mode, page) {
    if (source.catalogFallback) {
      const path = mode === 'latest' ? '/api/catalog/latest' : '/api/catalog/popular';
      const url = new URL(path, location.origin);
      url.searchParams.set('page', String(page));
      if (adultAllowed()) url.searchParams.set('adult', '1');
      return url;
    }
    const url = new URL(mode === 'latest' ? 'latest' : 'series', source.api);
    url.searchParams.set('page', String(page));
    return url;
  }

  async function fetchSourcePage(source, mode = 'popular') {
    const state = stateFor(source, mode);
    if (state.exhausted) return [];
    const key = `${source.id}|${mode}|${state.page}`;
    if (inFlight.has(key)) return inFlight.get(key);

    const task = (async () => {
      const started = performance.now();
      try {
        const endpoint = endpointFor(source, mode, state.page);
        const response = await baseFetch(endpoint.toString(), {
          cache: 'no-store',
          /* A backstop, not the thing a reader waits for: the wave stops
             waiting at WAVE_BUDGET_MS and this only decides when a hopeless
             request gives its slot back. */
          signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(9000) : undefined,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json().catch(() => null);
        const series = Array.isArray(body?.series) ? body.series : [];
        const fingerprint = series.slice(0, 12).map((item) => normalize(item?.title)).filter(Boolean).join('|');
        if (!series.length || (fingerprint && fingerprint === state.fingerprint)) {
          state.exhausted = true;
          return [];
        }
        state.fingerprint = fingerprint;
        state.page += 1;
        state.failures = 0;
        state.lastMs = Math.round(performance.now() - started);
        const fresh = [];
        for (const item of series) {
          const merged = mergeItem(source, item);
          if (merged) fresh.push(merged);
        }
        state.queue.push(...fresh);
        dispatchEvent(new CustomEvent('yomu:library-source-health', {
          detail: { id: source.id, ok: true, ms: state.lastMs, page: state.page - 1, count: series.length },
        }));
        return fresh;
      } catch (error) {
        state.failures += 1;
        state.lastMs = Math.round(performance.now() - started);
        if (state.failures >= 3) state.exhausted = true;
        dispatchEvent(new CustomEvent('yomu:library-source-health', {
          detail: { id: source.id, ok: false, failures: state.failures, error: String(error?.message || error) },
        }));
        return [];
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, task);
    return task;
  }

  function matches(row, type, genre) {
    if (!row) return false;
    if (type === 'completed' && !/completed|finished|complete/i.test(String(row.status || ''))) return false;
    if (type && !['all', 'completed'].includes(type) && String(row.category || '').toLowerCase() !== type) return false;
    if (genre) {
      const wanted = normalize(genre);
      const hay = [row.title, ...(row.genres || [])].map(normalize);
      if (!hay.some((value) => value && (value === wanted || value.includes(wanted)))) return false;
    }
    return true;
  }

  function viewKey(opts) {
    return [opts.mode || 'popular', opts.type || 'all', normalize(opts.genre || '')].join('|');
  }

  function deliveredFor(key) {
    let set = delivered.get(key);
    if (!set) { set = new Set(); delivered.set(key, set); }
    return set;
  }

  /**
   * Keep one provider from swallowing a segment. When at least two providers
   * can contribute, no source gets more than 40% unless the alternatives are
   * exhausted. This is a browse policy, not a relevance ranking.
   */
  function fairMix(rows, count) {
    const out = [];
    const perSource = new Map();
    const uniqueSources = new Set(rows.flatMap((row) => row.__sourceIds || []));
    const cap = uniqueSources.size >= 2 ? Math.max(2, Math.ceil(count * 0.4)) : count;
    const deferred = [];
    for (const row of rows) {
      const primary = row.__sourceIds?.[0] || row.providers?.[0]?.id || 'unknown';
      const used = perSource.get(primary) || 0;
      if (used >= cap) { deferred.push(row); continue; }
      perSource.set(primary, used + 1);
      out.push(row);
      if (out.length >= count) return out;
    }
    for (const row of deferred) {
      out.push(row);
      if (out.length >= count) break;
    }
    return out;
  }

  function availableFromCatalog(opts, take) {
    const key = viewKey(opts);
    const seen = deliveredFor(key);
    const candidates = catalog.filter((row) => matches(row, opts.type || 'all', opts.genre || '') && !seen.has(normalize(row.title)));
    return fairMix(candidates, take);
  }

  async function loadNext(raw = {}) {
    const opts = {
      mode: raw.mode === 'latest' ? 'latest' : 'popular',
      type: raw.type || 'all',
      genre: raw.genre || '',
      count: Math.max(1, Math.min(30, Number(raw.count || DEFAULT_SEGMENT) || DEFAULT_SEGMENT)),
    };
    const key = viewKey(opts);
    const seen = deliveredFor(key);
    /* Rows are handed over the moment they exist rather than at the end of the
       segment, so the grid fills in front of the reader instead of appearing
       all at once when the slowest provider is done. A caller that does not
       care gets the same array back at the end either way. */
    const onRow = typeof raw.onRow === 'function' ? (row) => { try { raw.onRow(row); } catch {} } : () => {};
    let out = availableFromCatalog(opts, opts.count);
    for (const row of out) onRow(row);
    const list = await sources();
    if (!list.length) return { items: out, hasMore: false, sources: [], sourceCount: 0, responding: [], respondingCount: 0 };

    // Each wave visits new sources before returning to one already visited.
    // This is what makes source #31 actually appear instead of the first five
    // refilling the screen forever.
    const requestBudget = Math.max(list.length * 2, opts.count * 2);
    let requests = 0;
    let wavesRun = 0;
    while (out.length < opts.count && requests < requestBudget) {
      const width = wavesRun === 0 ? FIRST_WAVE_CONCURRENCY : CONCURRENCY;
      wavesRun += 1;
      const needed = Math.min(width, list.length, Math.max(opts.count - out.length, 1));
      const wave = [];
      for (let i = 0; i < needed; i += 1) {
        const source = list[sourceCursor % list.length];
        sourceCursor = (sourceCursor + 1) % list.length;
        wave.push(source);
      }
      requests += wave.length;

      /**
       * The wave settles one source at a time, not all at once.
       *
       * This used to `await withPool(wave)` -- every request in the wave had
       * to finish before a single title could be taken from any of them, so
       * the segment was as slow as its slowest member and a provider sitting
       * on its timeout held ten ready covers off the screen. Racing them and
       * draining each as it lands is what "paint the first useful segment and
       * continue filling progressively" actually means.
       *
       * Nothing is thrown away. A source that answers after the wave is over
       * still resolves into its own queue through the in-flight map, and the
       * next segment finds it already fetched.
       */
      const drain = (source) => {
        const state = stateFor(source, opts.mode);
        while (state.queue.length) {
          const row = state.queue.shift();
          if (!matches(row, opts.type, opts.genre)) continue;
          const titleKey = normalize(row.title);
          if (!titleKey || seen.has(titleKey) || out.some((x) => normalize(x.title) === titleKey)) continue;
          out.push(row);
          onRow(row);
          return true;
        }
        return false;
      };

      /**
       * Finish the segment from pages already in hand.
       *
       * One row per source per pass is the fair-mix rule, and taken literally
       * it means the tenth card waits for the tenth source -- so a provider
       * that answers in 2.6s decided when ten ready covers appeared, even
       * though four other sources had twenty-four rows each sitting in the
       * catalog. Fairness is already enforced by fairMix()'s 40% cap, so the
       * remainder is filled from what has arrived and the stragglers get
       * their turn in the next segment instead of holding this one.
       */
      const topUp = () => {
        if (out.length >= opts.count) return;
        for (const row of availableFromCatalog(opts, opts.count - out.length)) {
          if (out.some((x) => normalize(x.title) === normalize(row.title))) continue;
          out.push(row);
          onRow(row);
          if (out.length >= opts.count) return;
        }
      };

      const pending = new Map();
      for (const source of new Set(wave)) {
        const state = stateFor(source, opts.mode);
        if (state.queue.length || state.exhausted) {
          /* Only while the segment still has room. Draining every already-warm
             source in the wave regardless would push past `count`, and the
             trim at the end would then drop rows the caller has already been
             handed and painted. */
          if (out.length < opts.count) drain(source);
          continue;
        }
        pending.set(source, fetchSourcePage(source, opts.mode).then(() => source, () => source));
      }

      /* One wave cannot outlive the segment budget either. A straggler keeps
         running; it just stops being something the reader waits for. */
      let deadline = null;
      const clock = new Promise((resolve) => { deadline = setTimeout(() => resolve(WAVE_TIMEOUT), WAVE_BUDGET_MS); });
      while (pending.size && out.length < opts.count) {
        const winner = await Promise.race([...pending.values(), clock]);
        if (winner === WAVE_TIMEOUT) break;
        pending.delete(winner);
        drain(winner);
        topUp();
      }
      clearTimeout(deadline);
      /* Also covers the case a duplicate merged a new provider into an old
         canonical row rather than adding one. */
      topUp();

      if (wave.every((source) => stateFor(source, opts.mode).exhausted && !stateFor(source, opts.mode).queue.length)) {
        const anyMore = list.some((source) => !stateFor(source, opts.mode).exhausted || stateFor(source, opts.mode).queue.length);
        if (!anyMore) break;
      }
    }

    out = fairMix(out, opts.count).slice(0, opts.count);
    for (const row of out) seen.add(normalize(row.title));
    const hasMore = list.some((source) => {
      const state = stateFor(source, opts.mode);
      return !state.exhausted || state.queue.length > 0;
    });

    const responding = [...respondingIds(list)];
    const result = { items: out, hasMore, sources: list, sourceCount: list.length, responding, respondingCount: responding.length };
    dispatchEvent(new CustomEvent('yomu:library-segment', { detail: { ...result, options: opts } }));
    return result;
  }

  function prefetch(raw = {}) {
    const opts = { ...raw, count: raw.count || DEFAULT_SEGMENT };
    const key = JSON.stringify(opts);
    if (prefetched?.key === key) return prefetched.promise;
    const promise = loadNext(opts).then((value) => {
      if (prefetched?.key === key) prefetched.value = value;
      return value;
    });
    prefetched = { key, promise, value: null };
    return promise;
  }

  async function next(raw = {}) {
    const opts = { ...raw, count: raw.count || DEFAULT_SEGMENT };
    const key = JSON.stringify(opts);
    if (prefetched?.key === key) {
      const hit = prefetched.value || await prefetched.promise;
      prefetched = null;
      return hit;
    }
    return loadNext(opts);
  }

  function resetView(raw = {}) {
    delivered.delete(viewKey({ mode: raw.mode || 'popular', type: raw.type || 'all', genre: raw.genre || '' }));
    prefetched = null;
  }

  function stats() {
    const health = [];
    for (const [key, state] of states) health.push({ key, ...state, queue: state.queue.length });
    return {
      catalogSize: catalog.length,
      canonicalTitles: canonical.size,
      sources: sourceMemo?.length || 0,
      health,
      blockedPattern: BLOCKED_SOURCE.source,
      concurrency: CONCURRENCY,
      segment: DEFAULT_SEGMENT,
    };
  }

  // Small warm cache: enough to make a back-navigation feel instant, never a
  // second database. Only metadata already fetched by this browser is stored.
  try {
    const saved = readJSON(CACHE_KEY, null);
    if (saved?.at > Date.now() - CACHE_MS && Array.isArray(saved.rows)) {
      for (const row of saved.rows.slice(0, 120)) {
        const key = normalize(row?.title);
        if (!key || canonical.has(key)) continue;
        canonical.set(key, row);
        catalog.push(row);
      }
    }
  } catch {}

  addEventListener('pagehide', () => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), rows: catalog.slice(-120) })); } catch {}
  });
  addEventListener('storage', (event) => {
    if (event.key === COLLECTION_KEY || event.key === ADULT_KEY) {
      sourceMemo = null;
      sourceMemoAt = 0;
      prefetched = null;
    }
  });

  window.YomuLibraryEngine = {
    sources,
    next,
    prefetch,
    loadNext,
    resetView,
    respondingIds,
    stats,
    normalize,
    matches,
    BLOCKED_SOURCE,
    CONCURRENCY,
    DEFAULT_SEGMENT,
  };
})();
