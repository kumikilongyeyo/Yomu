/**
 * Browser-side compatibility layer for Expo-built Yomu screens.
 *
 * Until the Expo source is available this file owns three small pieces of UI
 * glue that have to survive React re-renders:
 *   1. the 18+ settings entry and adult-media veil;
 *   2. removal of the obsolete duplicate "Find and add sources" shortcut;
 *   3. federation of locally-added Source Fabric APIs into global catalog search.
 *
 * The third item fixes an important split-brain bug: /sources could successfully
 * add a dynamic web source to this browser's collection, while /api/catalog/search
 * only knew the server registry. A source could therefore say "Added" and still
 * never appear as a readable provider in Search. Local API sources now join the
 * same search response immediately, without waiting for Source Forge's Git mirror.
 */
(() => {
  'use strict';

  const ADULT_KEY = 'yomu.v1.adult';
  const TITLES_KEY = 'yomu.v1.adultTitles';
  const BLUR_KEY = 'yomu.v1.adultBlur';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const VEIL = 'data-yomu-veil';
  const BADGE = 'data-yomu-veil-badge';

  const read = (key, fallback) => {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  };
  const adultAllowed = () => read(ADULT_KEY, 'off') === 'on';
  // Blur is on until turned off: the safer default, and reversible in Settings.
  const blurAdult = () => read(BLUR_KEY, 'on') !== 'off';

  /** Titles a provider rated adult, recorded by find.html as "<sourceId>:<seriesId>". */
  function adultTitles() {
    try {
      const raw = JSON.parse(localStorage.getItem(TITLES_KEY) || '[]');
      return new Set(Array.isArray(raw) ? raw.map(String) : []);
    } catch { return new Set(); }
  }

  /* ------------------------------------------------------------------ *
   * Local Source Fabric -> global catalog search
   * ------------------------------------------------------------------ */

  const baseFetch = window.fetch.bind(window);

  function collectionSources() {
    try {
      const collection = JSON.parse(localStorage.getItem(COLLECTION_KEY) || 'null');
      return Array.isArray(collection?.sources) ? collection.sources : [];
    } catch { return []; }
  }

  function localCatalogSources() {
    const seen = new Set();
    const out = [];
    for (const source of collectionSources()) {
      if (!source || source.enabled === false || source.kind !== 'api') continue;
      // Only sources created by Source Fabric belong in this bridge. Ordinary
      // registry extensions are already part of the server catalog.
      if (String(source.category || '') !== 'Source Fabric') continue;
      const api = String(source.url || '').trim();
      if (!/^https?:\/\//i.test(api)) continue;
      const key = api.replace(/\/+$/, '/');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: String(source.id || ''),
        label: String(source.label || source.name || 'Local source'),
        api: key,
      });
      // A browser with dozens of old experiments should not turn one search
      // into an unbounded fan-out. Eight is already more than the UI can show.
      if (out.length >= 8) break;
    }
    return out;
  }

  function normalizedTitle(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[’'`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(the|a|an|of|and|manga|manhwa|manhua|webtoon|comic|official|colou?red?|color|season|part|vol(ume)?|novel|remake|fan\s?colou?red)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function providerIdFor(sourceId) {
    const id = String(sourceId || '');
    return id.startsWith('yomuext-') ? `ext:${id.slice(8)}` : id;
  }

  async function searchOneLocalSource(source, query) {
    try {
      const endpoint = new URL('search', source.api);
      endpoint.searchParams.set('q', query);
      endpoint.searchParams.set('page', '1');
      const response = await baseFetch(endpoint.toString(), {
        cache: 'no-store',
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return null;
      const body = await response.json().catch(() => null);
      if (!body || !Array.isArray(body.series)) return null;
      return { source, series: body.series };
    } catch {
      return null;
    }
  }

  function mergeLocalSearch(payload, batches, query) {
    if (!payload || !Array.isArray(payload.series)) return null;
    const rows = payload.series.map((row, index) => ({ ...row, __yomuOrder: index }));
    const byTitle = new Map();
    for (const row of rows) {
      const key = normalizedTitle(row?.title);
      if (key && !byTitle.has(key)) byTitle.set(key, row);
    }

    let touched = false;
    let successfulSources = 0;
    for (const batch of batches) {
      if (!batch) continue;
      successfulSources += 1;
      const providerId = providerIdFor(batch.source.id);
      for (const item of batch.series) {
        if (!item || !item.id || !item.title) continue;
        const key = normalizedTitle(item.title);
        if (!key) continue;
        const provider = {
          id: providerId,
          name: batch.source.label,
          kind: 'extension',
          seriesId: String(item.id),
        };
        const existing = byTitle.get(key);
        if (existing) {
          const providers = Array.isArray(existing.providers) ? existing.providers : [];
          if (!providers.some((p) => String(p?.id || '') === providerId)) {
            existing.providers = [...providers, provider];
            touched = true;
          }
          // Local adapters sometimes have the cover/metadata the discovery
          // provider lacks. Fill blanks only; never overwrite canonical data.
          existing.cover ||= item.cover;
          existing.author ||= item.author;
          existing.synopsis ||= item.synopsis;
          existing.category ||= item.category;
          existing.status ||= item.status;
          existing.year ||= item.year;
          if (!existing.altTitles?.length && Array.isArray(item.altTitles)) existing.altTitles = item.altTitles;
        } else {
          const fresh = { ...item, providers: [provider], __yomuOrder: rows.length };
          rows.push(fresh);
          byTitle.set(key, fresh);
          touched = true;
        }
      }
    }

    if (!touched) return null;

    const wanted = normalizedTitle(query);
    const score = (row) => {
      const names = [row?.title, ...(Array.isArray(row?.altTitles) ? row.altTitles : [])]
        .map(normalizedTitle)
        .filter(Boolean);
      let best = 0;
      for (const name of names) {
        if (name === wanted) best = Math.max(best, 4);
        else if (name.startsWith(wanted) || wanted.startsWith(name)) best = Math.max(best, 3);
        else if (name.includes(wanted) || wanted.includes(name)) best = Math.max(best, 2);
      }
      return best;
    };
    rows.sort((a, b) => score(b) - score(a) || a.__yomuOrder - b.__yomuOrder);
    for (const row of rows) delete row.__yomuOrder;

    return {
      ...payload,
      series: rows,
      providersTried: Number(payload.providersTried || 0) + successfulSources,
      providersTotal: Number(payload.providersTotal || 0) + batches.length,
      localSourcesJoined: successfulSources,
    };
  }

  window.fetch = async (input, init) => {
    let target;
    try {
      const raw = typeof input === 'string' || input instanceof URL
        ? input
        : (input && typeof input.url === 'string' ? input.url : '');
      target = new URL(String(raw || ''), location.href);
    } catch {
      return baseFetch(input, init);
    }

    const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    const isCatalogSearch = method === 'GET'
      && target.origin === location.origin
      && target.pathname === '/api/catalog/search';
    if (!isCatalogSearch) return baseFetch(input, init);

    const query = target.searchParams.get('q')?.trim() || '';
    const localSources = query ? localCatalogSources() : [];
    if (!localSources.length) return baseFetch(input, init);

    // Run the server catalog and the browser-local sources together so adding
    // local sources does not add their latency serially to every search.
    const basePromise = baseFetch(input, init);
    const localPromise = Promise.all(localSources.map((source) => searchOneLocalSource(source, query)));
    const [response, batches] = await Promise.all([basePromise, localPromise]);
    if (!response.ok) return response;

    const payload = await response.clone().json().catch(() => null);
    const merged = mergeLocalSearch(payload, batches, query);
    if (!merged) return response;

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store, max-age=0');
    headers.set('x-yomu-local-sources', String(merged.localSourcesJoined || 0));
    return new Response(JSON.stringify(merged), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  const SETTINGS_ROW_ID = 'yomu-adult-setting';

  function removeObsoleteSourceShortcut() {
    if (!location.pathname.startsWith('/settings')) return;
    for (const row of document.querySelectorAll('button.setting-link')) {
      const heading = row.querySelector('.row-copy h3');
      if (String(heading?.textContent || '').trim() === 'Find and add sources') row.remove();
    }
  }

  function buildSettingsRow() {
    const label = document.createElement('div');
    label.className = 'group-label';
    label.id = SETTINGS_ROW_ID + '-label';
    label.textContent = 'Content';

    const group = document.createElement('section');
    group.className = 'settings-group glass';
    group.id = SETTINGS_ROW_ID;

    // A link, not a switch. Adult titles are kept out of Home, Search,
    // Library and Continue Reading entirely, so there is nothing here for a
    // toggle to reveal -- 18+ has its own page, and the switch lives on it
    // next to the thing it governs.
    const row = document.createElement('a');
    row.className = 'setting-link';
    row.href = '/adult.html';
    row.style.textDecoration = 'none';

    const copy = document.createElement('div');
    copy.className = 'row-copy';
    const h3 = document.createElement('h3');
    h3.textContent = '18+ content';
    const small = document.createElement('small');
    small.textContent = adultAllowed()
      ? 'On. Adult titles appear only on the 18+ page.'
      : 'Off. Adult titles are hidden everywhere.';
    copy.append(h3, small);

    const chevron = document.createElement('span');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    chevron.style.cssText = 'color:var(--dim);font-size:20px;flex:none';

    row.append(copy, chevron);
    group.append(row);
    return { label, group };
  }

  function mountSettingsRow() {
    if (!location.pathname.startsWith('/settings')) return;
    if (document.getElementById(SETTINGS_ROW_ID)) return;

    // Sit above Storage, so content sits with the other "what you see" settings
    // rather than among the destructive ones.
    const labels = [...document.querySelectorAll('.group-label')];
    const storage = labels.find((l) => /storage/i.test(l.textContent || ''));
    const anchor = storage ?? labels[labels.length - 1];
    if (!anchor?.parentNode) return;

    const { label, group } = buildSettingsRow();
    anchor.parentNode.insertBefore(label, anchor);
    anchor.parentNode.insertBefore(group, anchor);
  }

  /* ------------------------------------------------------------------ *
   * The veil
   * ------------------------------------------------------------------ */

  /** The title this screen is showing, as the key find.html recorded. */
  function currentTitleKey() {
    const source = new URLSearchParams(location.search).get('source');
    if (!source) return null;

    const series = location.pathname.match(/^\/series\/([^/?#]+)/);
    if (series) return `${source}:${decodeURIComponent(series[1])}`;

    // A chapter id usually carries its series as a leading segment or as the
    // reader's own prefix, which is what the worker derives sourceSeriesId from.
    const readMatch = location.pathname.match(/^\/read\/([^/?#]+)/);
    if (readMatch) {
      const chapterId = decodeURIComponent(readMatch[1]);
      const head = chapterId.split(/[:/]/)[0];
      return head ? `${source}:${head}` : null;
    }
    return null;
  }

  let veilThisScreen = false;
  let revealed = false;

  /** Whether a parent hugs an image closely enough to carry the veil badge. */
  function wrapsTightly(parent, el) {
    if (!parent) return false;
    const p = parent.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    if (!e.width || !e.height) return false;
    return p.width * p.height < e.width * e.height * 2;
  }

  function applyVeil() {
    const key = currentTitleKey();
    veilThisScreen = !!key && adultTitles().has(key) && blurAdult();
    const on = veilThisScreen && !revealed;

    const media = new Set([...document.images, ...document.querySelectorAll('.cover')]);
    for (const el of document.querySelectorAll(`[${VEIL}]`)) if (!media.has(el)) el.removeAttribute(VEIL);
    for (const el of document.querySelectorAll(`[${BADGE}]`)) el.removeAttribute(BADGE);

    for (const el of media) {
      if (!on) { el.removeAttribute(VEIL); continue; }
      el.setAttribute(VEIL, 'on');
      if (wrapsTightly(el.parentElement, el)) el.parentElement.setAttribute(BADGE, '');
    }
  }

  // One tap anywhere on a veiled screen clears it for this visit. Capture phase
  // so the tap is spent on revealing rather than on whatever is underneath.
  document.addEventListener(
    'click',
    (event) => {
      if (!veilThisScreen || revealed) return;
      const holder = event.target instanceof Element
        ? event.target.closest(`[${BADGE}]`) ?? event.target.closest(`[${VEIL}="on"]`)
        : null;
      if (!holder) return;
      event.stopPropagation();
      event.preventDefault();
      revealed = true;
      applyVeil();
    },
    true,
  );

  /* ------------------------------------------------------------------ *
   * Keep compatibility DOM in sync with React
   * ------------------------------------------------------------------ */

  let lastUrl = location.href;

  function tick() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      revealed = false;
    }
    removeObsoleteSourceShortcut();
    mountSettingsRow();
    applyVeil();
  }

  const start = () => {
    tick();
    new MutationObserver(() => {
      // All jobs are idempotent and bail early when there is nothing to do.
      tick();
    }).observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
