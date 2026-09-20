/**
 * Yomu performance fast lane.
 *
 * Goals:
 * - never let one dead source hold a visible title batch for 14 seconds;
 * - dedupe identical GETs already in flight;
 * - return warm JSON results immediately and revalidate in the background;
 * - prefetch likely title destinations only when the connection can afford it.
 *
 * The pattern is intentionally small: bounded concurrency like p-limit and
 * viewport/idle prefetch like quicklink, without shipping either dependency.
 */
(() => {
  'use strict';
  if (window.__YomuPerformance) return;
  window.__YomuPerformance = true;

  const rawFetch = window.fetch.bind(window);
  const STORE_KEY = 'yomu.v1.netFastLane';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const FRESH_MS = 10 * 60 * 1000;
  const STALE_MS = 60 * 60 * 1000;
  const SOURCE_BUDGET_MS = 4200; // < 1/3 of the old 14s source wait.
  const MAX_ROWS = 80;
  const MAX_BODY = 280_000;
  const WARM_CONCURRENCY = 6;
  const NAMI = /(?:^|[^a-z])nami[\s._-]*comi(?:[^a-z]|$)|namicomi/i;
  const inflight = new Map();
  let store = null;

  function readStore() {
    if (store) return store;
    try {
      const parsed = JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}');
      store = parsed && typeof parsed === 'object' ? parsed : {};
    } catch { store = {}; }
    return store;
  }
  function saveStore() {
    try {
      const rows = Object.entries(readStore())
        .sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0))
        .slice(0, MAX_ROWS);
      store = Object.fromEntries(rows);
      sessionStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch {}
  }

  function targetOf(input) {
    try {
      const raw = typeof input === 'string' || input instanceof URL ? input : input?.url || '';
      return new URL(String(raw || ''), location.href);
    } catch { return null; }
  }
  function methodOf(input, init) {
    return String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
  }
  function isJsonLane(url) {
    if (!url || !/^https?:$/.test(url.protocol)) return false;
    const path = url.pathname.toLowerCase();
    if (url.origin === location.origin) {
      return path.startsWith('/api/catalog/') || path.startsWith('/api/md/manga') || path.startsWith('/api/ext/');
    }
    return /\/(?:series|latest|search)\/?$/.test(path);
  }
  function keyFor(url) {
    const u = new URL(url.toString());
    u.hash = '';
    return u.toString();
  }
  function cachedResponse(row, state) {
    const headers = new Headers(row.headers || {});
    headers.set('content-type', headers.get('content-type') || 'application/json; charset=utf-8');
    headers.set('x-yomu-fast-lane', state);
    return new Response(row.body, { status: row.status || 200, headers });
  }

  async function remember(key, response) {
    try {
      if (!response?.ok) return;
      const type = response.headers.get('content-type') || '';
      if (!/json/i.test(type)) return;
      const text = await response.clone().text();
      if (!text || text.length > MAX_BODY) return;
      readStore()[key] = {
        at: Date.now(),
        status: response.status,
        headers: { 'content-type': type },
        body: text,
      };
      saveStore();
    } catch {}
  }

  function combinedSignal(original, timeoutMs) {
    const controller = new AbortController();
    let timer = 0;
    const abort = () => controller.abort(original?.reason);
    if (original?.aborted) controller.abort(original.reason);
    else original?.addEventListener?.('abort', abort, { once: true });
    timer = setTimeout(() => controller.abort(new DOMException('Yomu source budget exceeded', 'TimeoutError')), timeoutMs);
    return {
      signal: controller.signal,
      cleanup() {
        clearTimeout(timer);
        original?.removeEventListener?.('abort', abort);
      },
    };
  }

  function network(key, input, init = {}, background = false) {
    if (inflight.has(key)) return inflight.get(key).then((r) => r.clone());
    const task = (async () => {
      const merged = combinedSignal(init.signal || (input instanceof Request ? input.signal : null), SOURCE_BUDGET_MS);
      try {
        const response = await rawFetch(input, { ...init, cache: 'no-store', signal: merged.signal });
        if (response.ok) remember(key, response);
        return response;
      } finally {
        merged.cleanup();
        inflight.delete(key);
      }
    })();
    inflight.set(key, task);
    if (background) task.catch(() => {});
    return task.then((r) => r.clone());
  }

  window.fetch = function yomuFastFetch(input, init = {}) {
    const url = targetOf(input);
    if (methodOf(input, init) !== 'GET' || !isJsonLane(url)) return rawFetch(input, init);

    const key = keyFor(url);
    const row = readStore()[key];
    const age = row ? Date.now() - Number(row.at || 0) : Infinity;

    if (row && age <= FRESH_MS) {
      // Warm navigation/search: paint now, refresh without blocking the user.
      network(key, input, init, true).catch(() => {});
      return Promise.resolve(cachedResponse(row, 'fresh'));
    }
    if (row && age <= STALE_MS) {
      // A stale title list is dramatically more useful than a blank grid while
      // a source wakes up. Revalidation replaces it for the next interaction.
      network(key, input, init, true).catch(() => {});
      return Promise.resolve(cachedResponse(row, 'stale'));
    }
    return network(key, input, init, false);
  };

  async function pool(items, run, limit = WARM_CONCURRENCY) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        try { await run(item); } catch {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  function enabledApis() {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(COLLECTION_KEY) || '{}')?.sources || []; } catch {}
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      if (!row || row.enabled === false || NAMI.test(`${row.id || ''} ${row.label || ''} ${row.url || ''}`)) continue;
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
        out.push(api);
      } catch {}
    }
    return out;
  }

  function warmSourcePages() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (connection?.saveData || /(^|-)2g$/.test(String(connection?.effectiveType || ''))) return;
    const apis = enabledApis();
    if (!apis.length) return;
    pool(apis, async (api) => {
      const url = new URL('series', api);
      url.searchParams.set('page', '1');
      await window.fetch(url.toString(), { priority: 'low' }).catch(() => null);
    }).catch(() => {});
  }

  // quicklink-style destination prefetch: only visible/near-visible title links,
  // only on connections where speculative traffic is appropriate.
  const prefetchedLinks = new Set();
  function prefetchHref(href) {
    try {
      const u = new URL(href, location.href);
      if (u.origin !== location.origin || prefetchedLinks.has(u.href)) return;
      if (!/^\/(?:series|read)\//.test(u.pathname)) return;
      prefetchedLinks.add(u.href);
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = u.href;
      document.head.append(link);
    } catch {}
  }

  function installViewportPrefetch() {
    if (!('IntersectionObserver' in window)) return;
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (connection?.saveData || /(^|-)2g$/.test(String(connection?.effectiveType || ''))) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const node = entry.target;
        observer.unobserve(node);
        prefetchHref(node.href);
      }
    }, { rootMargin: '500px 0px', threshold: 0.01 });
    const scan = () => {
      for (const a of document.querySelectorAll('a[href^="/series/"],a[href^="/read/"]')) {
        if (a.dataset.yomuPerfObserved) continue;
        a.dataset.yomuPerfObserved = '1';
        observer.observe(a);
      }
    };
    scan();
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  }

  const start = () => {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 80));
    idle(warmSourcePages, { timeout: 250 });
    installViewportPrefetch();
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.YomuPerformance = {
    targetFactor: 2,
    sourceBudgetMs: SOURCE_BUDGET_MS,
    freshMs: FRESH_MS,
    staleMs: STALE_MS,
  };
})();
