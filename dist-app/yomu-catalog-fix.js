/**
 * Catalog truth layer.
 *
 * Two jobs that should not be left to provider-specific behaviour:
 *  1. discard search rows that do not actually resemble the title the reader
 *     asked for after all source/alias merging has finished;
 *  2. stop presenting the sum of heterogeneous provider totals as if it were
 *     a deduplicated Yomu catalog size.
 *
 * This script intentionally wraps the fetch that yomu-gate.js already owns.
 * That means Source Fabric results are merged first, then this final gate sees
 * and validates the complete response the search UI is about to render.
 */
(() => {
  'use strict';

  const COLLECTION_KEY = 'yomu.v1.collection';
  const previousFetch = window.fetch.bind(window);

  function normalize(value) {
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

  function dice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const grams = (text) => {
      const out = new Map();
      for (let i = 0; i < text.length - 1; i += 1) {
        const gram = text.slice(i, i + 2);
        out.set(gram, (out.get(gram) || 0) + 1);
      }
      return out;
    };
    const A = grams(a);
    const B = grams(b);
    let shared = 0;
    let total = 0;
    for (const n of A.values()) total += n;
    for (const [gram, n] of B) {
      total += n;
      if (A.has(gram)) shared += Math.min(A.get(gram), n);
    }
    return total ? (2 * shared) / total : 0;
  }

  function words(value) {
    const n = normalize(value);
    return n ? n.split(' ').filter(Boolean) : [];
  }

  function nameScore(name, query) {
    const n = normalize(name);
    const q = normalize(query);
    if (!n || !q) return 0;
    if (n === q) return 1;

    const qWords = words(q);
    const nWords = words(n);
    if (n.includes(q)) return 0.96;
    if (qWords.length === 1 && n.startsWith(q)) return 0.92;

    // A shorter title may be a perfectly sensible shortened display name, but
    // one generic word from a long query is not evidence of identity.
    if (q.includes(n)) {
      const required = Math.max(2, Math.ceil(qWords.length * 0.6));
      if (nWords.length >= required) return 0.9;
    }

    const qSet = new Set(qWords);
    const nSet = new Set(nWords);
    let shared = 0;
    for (const token of qSet) if (nSet.has(token)) shared += 1;
    const coverage = qSet.size ? shared / qSet.size : 0;
    const precision = nSet.size ? shared / nSet.size : 0;
    const tokenScore = 0.58 * coverage + 0.42 * precision;
    return Math.max(dice(n, q), tokenScore);
  }

  function resultScore(entry, query) {
    const names = [entry?.title, ...(Array.isArray(entry?.altTitles) ? entry.altTitles : [])];
    let best = 0;
    for (const name of names) best = Math.max(best, nameScore(name, query));
    return best;
  }

  function relevanceFloor(query) {
    const count = words(query).length;
    if (count >= 7) return 0.46;
    if (count >= 4) return 0.49;
    if (count >= 2) return 0.52;
    return 0.58;
  }

  function sanitizeSearchPayload(payload, query) {
    if (!payload || !Array.isArray(payload.series) || !query) return { payload, changed: false };
    const floor = relevanceFloor(query);
    const scored = payload.series
      .map((entry, order) => ({ entry, order, score: resultScore(entry, query) }))
      .filter((row) => row.score >= floor)
      .sort((a, b) =>
        b.score - a.score ||
        (b.entry?.providers?.length || 0) - (a.entry?.providers?.length || 0) ||
        a.order - b.order,
      );

    const series = scored.map((row) => row.entry);
    const changed = series.length !== payload.series.length || series.some((entry, i) => entry !== payload.series[i]);
    return {
      payload: changed
        ? { ...payload, series, filteredIrrelevant: payload.series.length - series.length }
        : payload,
      changed,
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
      return previousFetch(input, init);
    }

    const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    const isSearch = method === 'GET'
      && target.origin === location.origin
      && target.pathname === '/api/catalog/search';
    if (!isSearch) return previousFetch(input, init);

    const response = await previousFetch(input, init);
    if (!response.ok) return response;

    const query = target.searchParams.get('q')?.trim() || '';
    if (!query) return response;
    const body = await response.clone().json().catch(() => null);
    const { payload, changed } = sanitizeSearchPayload(body, query);
    if (!changed) return response;

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store, max-age=0');
    headers.set('x-yomu-relevance-filter', String(payload.filteredIrrelevant || 0));
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  function enabledSourceCount() {
    try {
      const collection = JSON.parse(localStorage.getItem(COLLECTION_KEY) || 'null');
      const sources = Array.isArray(collection?.sources)
        ? collection.sources.filter((source) => source && source.enabled !== false)
        : [];
      const ids = new Set(sources.map((source) => String(source.id || '')).filter(Boolean));
      // MangaDex is a built-in and older profiles do not always persist it.
      ids.add('mangadex');
      return ids.size;
    } catch {
      return 1;
    }
  }

  function fixCatalogCount() {
    // The old value is a sum of incompatible provider totals (full MangaDex
    // count plus partial listSeries counts) and is neither unique nor complete.
    // Do not replace a real filtered/readable count from another surface.
    for (const node of document.querySelectorAll('.browse-count')) {
      const text = String(node.textContent || '').trim();
      if (!/^\d[\d,]*\s+titles match(?:\s+this filter)?$/i.test(text)) continue;
      const count = enabledSourceCount();
      node.textContent = `${count} enabled source${count === 1 ? '' : 's'} · merged catalog`;
      node.dataset.yomuCatalogTruth = 'sources';
    }
  }

  const start = () => {
    fixCatalogCount();
    new MutationObserver(fixCatalogCount).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
