/**
 * Live catalog glue.
 *
 * Keeps two browser-only truths aligned with the server catalog:
 *  - Discover is a rotating deck instead of replaying the same ordering forever.
 *  - API sources already enabled on this device still participate in Search even
 *    when they are not part of the Worker's shared extension registry yet.
 */
(() => {
  'use strict';

  const COLLECTION_KEY = 'yomu.v1.collection';
  const ROTATION_KEY = 'yomu.v1.discoverRotation';
  const previousFetch = window.fetch.bind(window);
  let registryMemo = null;
  let registryMemoAt = 0;

  const isDiscover = () => /(^|\/)discover(?:\.html)?\/?$/.test(location.pathname);

  function collectionSources() {
    try {
      const collection = JSON.parse(localStorage.getItem(COLLECTION_KEY) || 'null');
      return Array.isArray(collection?.sources) ? collection.sources : [];
    } catch {
      return [];
    }
  }

  function canonicalApi(value) {
    try {
      const url = new URL(String(value || ''), location.origin);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.hash = '';
      url.search = '';
      let out = url.toString();
      if (!out.endsWith('/')) out += '/';
      return out;
    } catch {
      return null;
    }
  }

  async function registeredSourceIds() {
    const now = Date.now();
    if (registryMemo && now - registryMemoAt < 5 * 60 * 1000) return registryMemo;
    try {
      const response = await previousFetch('/api/ext/sources', {
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      });
      const body = response.ok ? await response.json() : null;
      registryMemo = new Set((body?.extensions || []).map((e) => `yomuext-${e.id}`));
    } catch {
      registryMemo = new Set();
    }
    registryMemoAt = now;
    return registryMemo;
  }

  async function deviceOnlyApiSources() {
    const registered = await registeredSourceIds();
    const seen = new Set();
    const out = [];

    for (const source of collectionSources()) {
      if (!source || source.enabled === false || source.kind !== 'api') continue;
      const id = String(source.id || '').trim();
      if (!id || id === 'mangadex' || registered.has(id)) continue;
      const api = canonicalApi(source.url);
      if (!api || seen.has(api)) continue;
      seen.add(api);
      out.push({
        id,
        label: String(source.label || source.name || id),
        api,
      });
      // Keep a bad old profile from turning one keystroke into an unbounded fanout.
      if (out.length >= 16) break;
    }
    return out;
  }

  function providerIdFor(sourceId) {
    const id = String(sourceId || '');
    return id.startsWith('yomuext-') ? `ext:${id.slice(8)}` : id;
  }

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

  async function searchOne(source, query) {
    try {
      const endpoint = new URL('search', source.api);
      endpoint.searchParams.set('q', query);
      endpoint.searchParams.set('page', '1');
      const response = await previousFetch(endpoint.toString(), {
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) return null;
      const body = await response.json().catch(() => null);
      if (!Array.isArray(body?.series)) return null;
      return { source, series: body.series };
    } catch {
      return null;
    }
  }

  function mergeDeviceSearch(payload, batches) {
    if (!payload || !Array.isArray(payload.series)) return payload;
    const rows = payload.series.map((row) => ({ ...row }));
    const byTitle = new Map();
    for (const row of rows) {
      const key = normalize(row?.title);
      if (key && !byTitle.has(key)) byTitle.set(key, row);
    }

    let joined = 0;
    for (const batch of batches) {
      if (!batch) continue;
      joined += 1;
      const providerId = providerIdFor(batch.source.id);
      for (const item of batch.series) {
        if (!item?.id || !item?.title) continue;
        const key = normalize(item.title);
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
          }
          existing.cover ||= item.cover;
          existing.author ||= item.author;
          existing.synopsis ||= item.synopsis;
          existing.category ||= item.category;
          existing.status ||= item.status;
          existing.year ||= item.year;
          if (!existing.altTitles?.length && Array.isArray(item.altTitles)) existing.altTitles = item.altTitles;
        } else {
          const fresh = { ...item, providers: [provider] };
          rows.push(fresh);
          byTitle.set(key, fresh);
        }
      }
    }

    return {
      ...payload,
      series: rows,
      providersTried: Number(payload.providersTried || 0) + joined,
      providersTotal: Number(payload.providersTotal || 0) + batches.length,
      deviceSourcesJoined: joined,
    };
  }

  function nextRotation() {
    let value = 0;
    try { value = Number(sessionStorage.getItem(ROTATION_KEY) || '0') || 0; } catch {}
    value = (value + 1) >>> 0;
    try { sessionStorage.setItem(ROTATION_KEY, String(value)); } catch {}
    return value;
  }

  function seededShuffle(items, seed) {
    const out = [...items];
    let state = (seed || 1) >>> 0;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  async function rotateDiscover(response) {
    if (!response.ok) return response;
    const body = await response.clone().json().catch(() => null);
    if (!Array.isArray(body?.series) || body.series.length < 2) return response;

    // Keep the whole candidate pool, but give every refresh a new deterministic
    // deck. If the UI only renders the first N cards, the visible set changes as
    // soon as the merged provider pool is larger than N; otherwise the order
    // still changes rather than appearing frozen.
    const seed = (nextRotation() ^ Math.floor(Date.now() / 30000)) >>> 0;
    const series = seededShuffle(body.series, seed);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store, max-age=0');
    headers.set('x-yomu-discover-rotation', String(seed));
    return new Response(JSON.stringify({ ...body, series, rotated: true }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  window.fetch = async (input, init) => {
    let target;
    try {
      const raw = typeof input === 'string' || input instanceof URL
        ? input
        : (input && typeof input.url === 'string' ? input.url : '');
      target = new URL(String(raw || ''), location.href);
    } catch {
      return previousFetch(input, init);
    }

    const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    const sameOrigin = target.origin === location.origin;

    if (method === 'GET' && sameOrigin && target.pathname === '/api/catalog/search') {
      const query = target.searchParams.get('q')?.trim() || '';
      if (!query) return previousFetch(input, init);

      // Server registry + any locally enabled APIs run together. The local list
      // is deliberately limited to sources the Worker does not already know,
      // so this fixes the split-brain case without double-hitting every source.
      const sourcePromise = deviceOnlyApiSources();
      const basePromise = previousFetch(input, init);
      const [base, sources] = await Promise.all([basePromise, sourcePromise]);
      if (!base.ok || !sources.length) return base;

      const batches = await Promise.all(sources.map((source) => searchOne(source, query)));
      const payload = await base.clone().json().catch(() => null);
      const merged = mergeDeviceSearch(payload, batches);
      if (!merged) return base;

      const headers = new Headers(base.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      headers.set('content-type', 'application/json; charset=utf-8');
      headers.set('cache-control', 'no-store, max-age=0');
      headers.set('x-yomu-device-sources', String(merged.deviceSourcesJoined || 0));
      return new Response(JSON.stringify(merged), {
        status: base.status,
        statusText: base.statusText,
        headers,
      });
    }

    const response = await previousFetch(input, init);
    if (method === 'GET' && sameOrigin && isDiscover() && target.pathname === '/api/catalog/popular') {
      return rotateDiscover(response);
    }
    return response;
  };
})();
