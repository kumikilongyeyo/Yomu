(() => {
  'use strict';

  if (!location.pathname.startsWith('/series/')) return;

  const COLLECTION_KEY = 'yomu.v1.collection';
  const LINKS_KEY = 'yomu.v1.ledgerLinks';
  const GUARD_KEY = 'yomu.v1.autoSourceSwitch';
  const GUARD_MS = 15_000;

  let running = false;
  let timer = null;

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch {
      return fallback;
    }
  };

  const toProviderId = (sourceId) => {
    if (sourceId.startsWith('yomuext-')) return 'ext:' + sourceId.slice(8);
    if (sourceId.startsWith('mihon-')) return 'suwayomi:' + sourceId.slice(6);
    return sourceId;
  };

  const toAppSource = (providerId) => {
    if (providerId.startsWith('ext:')) return 'yomuext-' + providerId.slice(4);
    if (providerId.startsWith('suwayomi:')) return 'mihon-' + providerId.slice(9);
    return providerId;
  };

  function context() {
    const raw = location.pathname.slice('/series/'.length);
    if (!raw) return null;
    let seriesId = raw;
    try { seriesId = decodeURIComponent(raw); } catch {}
    const sourceId = new URLSearchParams(location.search).get('source') || '';
    return sourceId ? { sourceId, seriesId, key: sourceId + ':' + seriesId } : null;
  }

  function enabledSourceIds() {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    return new Set(
      (Array.isArray(collection.sources) ? collection.sources : [])
        .filter((source) => source && source.enabled !== false)
        .map((source) => String(source.id || ''))
        .filter(Boolean),
    );
  }

  function pageSaysActiveSourceIsEmpty() {
    const list = document.querySelector('.chapter-list');
    if (!list) return false;

    // Never move away from a source that is already showing real native rows.
    if (list.querySelector('.chapter-line[data-chn]')) return false;

    const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
    return /hosts no chapters for it/i.test(text) || /(?:^|[·\s])0\s+chapters(?:[·\s]|$)/i.test(text);
  }

  function pageTitle() {
    const candidates = [
      document.querySelector('[data-series-title]'),
      document.querySelector('.series-title'),
      document.querySelector('h1'),
    ];
    for (const node of candidates) {
      const value = String(node?.textContent || '').trim();
      if (value) return value;
    }
    return '';
  }

  function recentlyRedirectedTo(signature) {
    try {
      const value = JSON.parse(sessionStorage.getItem(GUARD_KEY) || 'null');
      return value && value.signature === signature && Date.now() - Number(value.at || 0) < GUARD_MS;
    } catch {
      return false;
    }
  }

  function setRedirectGuard(signature) {
    try {
      sessionStorage.setItem(GUARD_KEY, JSON.stringify({ signature, at: Date.now() }));
    } catch {}
  }

  function showSwitchNotice(name) {
    const old = document.getElementById('yomu-auto-source-note');
    old?.remove();
    const note = document.createElement('div');
    note.id = 'yomu-auto-source-note';
    note.textContent = `No chapters here. Switching to ${name}…`;
    Object.assign(note.style, {
      position: 'fixed',
      left: '50%',
      bottom: 'calc(94px + env(safe-area-inset-bottom, 0px))',
      transform: 'translateX(-50%)',
      zIndex: '9999',
      maxWidth: 'min(88vw, 520px)',
      padding: '10px 14px',
      borderRadius: '999px',
      border: '1px solid rgba(255,196,95,.45)',
      background: 'rgba(20,33,43,.96)',
      color: '#f4f6fa',
      font: '600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      boxShadow: '0 10px 34px rgba(0,0,0,.3)',
      textAlign: 'center',
    });
    document.body.append(note);
  }

  const kindRank = (kind) => ({ extension: 0, native: 1, suwayomi: 2 }[kind] ?? 3);

  async function trySwitch() {
    if (running || !pageSaysActiveSourceIsEmpty()) return;

    const ctx = context();
    if (!ctx || recentlyRedirectedTo(ctx.key)) return;

    const enabled = enabledSourceIds();
    if (!enabled.size) return;

    const params = new URLSearchParams();
    const links = readJSON(LINKS_KEY, {})?.[ctx.key];
    if (Array.isArray(links) && links.length) {
      for (const link of links) params.append('link', String(link));
    } else {
      const title = pageTitle();
      if (!title) return;
      params.set('title', title);
    }
    params.set('prefer', toProviderId(ctx.sourceId));

    running = true;
    try {
      const response = await fetch('/api/catalog/chapters?' + params.toString(), {
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !Array.isArray(data.sources)) return;

      const activeProvider = toProviderId(ctx.sourceId);
      const candidates = data.sources
        .filter((source) => source && source.ok !== false)
        .filter((source) => source.providerId !== activeProvider)
        .filter((source) => enabled.has(toAppSource(String(source.providerId || ''))))
        .filter((source) => String(source.seriesId || '') && Number(source.chapterCount || 0) > 0)
        .sort((a, b) =>
          Number(b.chapterCount || 0) - Number(a.chapterCount || 0)
          || kindRank(a.kind) - kindRank(b.kind)
          || String(a.providerName || '').localeCompare(String(b.providerName || '')),
        );

      const best = candidates[0];
      if (!best) return;

      const sourceId = toAppSource(String(best.providerId));
      const seriesId = String(best.seriesId);
      const signature = sourceId + ':' + seriesId;
      if (signature === ctx.key) return;

      setRedirectGuard(signature);
      showSwitchNotice(best.providerName || 'a source with chapters');

      const target = new URL('/series/' + encodeURIComponent(seriesId), location.origin);
      target.searchParams.set('source', sourceId);
      setTimeout(() => location.replace(target.toString()), 350);
    } catch {
      // Auto-switching is a convenience. If the catalog check fails, leave the
      // current series page alone and keep the manual source choices available.
    } finally {
      running = false;
    }
  }

  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(trySwitch, 180);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setTimeout(trySwitch, 300);
})();
