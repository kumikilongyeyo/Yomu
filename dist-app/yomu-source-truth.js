(() => {
  'use strict';
  if (window.__YomuSourceTruth) return;
  window.__YomuSourceTruth = true;

  const COLLECTION_KEY = 'yomu.v1.collection';
  const onSourcesRoute = () => /^\/sources(?:\.html)?\/?$/.test(location.pathname);

  function readCollection() {
    try {
      const value = JSON.parse(localStorage.getItem(COLLECTION_KEY) || '{}');
      return value && Array.isArray(value.sources) ? value : { revision: 0, sources: [], library: [], progress: {} };
    } catch {
      return { revision: 0, sources: [], library: [], progress: {} };
    }
  }

  async function registry() {
    const response = await fetch('/api/ext/sources', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
    const body = await response.json();
    return Array.isArray(body.extensions) ? body.extensions : [];
  }

  function reconcile(extensions) {
    const activeIds = new Set(extensions.map((x) => String(x?.id || '')).filter(Boolean));
    const collection = readCollection();
    let changed = false;
    let quarantined = 0;
    let validatedEnabled = 0;
    let legacyEnabled = 0;

    const sources = collection.sources.map((source) => {
      if (!source || typeof source !== 'object') return source;
      const id = String(source.id || '');
      if (!id.startsWith('yomuext-')) {
        if (source.enabled !== false) legacyEnabled += 1;
        return source;
      }

      const extensionId = id.slice('yomuext-'.length);
      if (!activeIds.has(extensionId)) {
        quarantined += 1;
        const next = {
          ...source,
          enabled: false,
          registryValidated: false,
          quarantined: true,
          quarantineReason: 'Not present in the validated Yomu registry',
        };
        if (source.enabled !== false || source.quarantined !== true || source.registryValidated !== false) changed = true;
        return next;
      }

      if (source.enabled !== false) validatedEnabled += 1;
      const next = {
        ...source,
        registryValidated: true,
        quarantined: false,
        quarantineReason: '',
      };
      if (source.registryValidated !== true || source.quarantined === true || source.quarantineReason) changed = true;
      return next;
    });

    if (changed) {
      const next = {
        ...collection,
        revision: (Number.isInteger(collection.revision) ? collection.revision : 0) + 1,
        sources,
      };
      const serialized = JSON.stringify(next);
      localStorage.setItem(COLLECTION_KEY, serialized);
      try {
        window.dispatchEvent(new StorageEvent('storage', {
          key: COLLECTION_KEY,
          oldValue: null,
          newValue: serialized,
          storageArea: localStorage,
          url: location.href,
        }));
      } catch {}
    }

    return {
      registryCount: extensions.length,
      validatedEnabled,
      quarantined,
      legacyEnabled,
      localEnabled: sources.filter((x) => x && x.enabled !== false).length,
    };
  }

  function renderTruth(metrics) {
    if (!onSourcesRoute()) {
      document.getElementById('yomu-source-truth-banner')?.remove();
      return;
    }

    let banner = document.getElementById('yomu-source-truth-banner');
    if (!banner) {
      banner = document.createElement('section');
      banner.id = 'yomu-source-truth-banner';
      banner.style.cssText = 'margin:0 0 14px;padding:12px 14px;border:1px solid var(--line,#263747);border-radius:14px;background:color-mix(in srgb,var(--surface,#111b25) 94%,transparent);font:700 11px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--muted,#91a8bb)';
      const anchor = document.getElementById('yomu-source-fabric-command');
      if (anchor?.parentNode) anchor.parentNode.insertBefore(banner, anchor);
      else document.querySelector('.g-main,main')?.prepend(banner);
    }

    banner.innerHTML = `<strong style="color:var(--text,#f7f8fa)">${metrics.registryCount} validated registry sources</strong> · ${metrics.validatedEnabled} enabled on this device${metrics.quarantined ? ` · <span style="color:#f4c66d">${metrics.quarantined} legacy source${metrics.quarantined === 1 ? '' : 's'} quarantined</span>` : ''}`;

    const main = document.querySelector('.g-main,main');
    if (!main) return;
    const candidates = [...main.querySelectorAll('span,div')].filter((node) => {
      const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      return /sources?\s*[·•]\s*saved on this device/i.test(text) || /enabled sources?/i.test(text);
    });
    for (const node of candidates.slice(0, 3)) {
      if (node.closest('#yomu-source-truth-banner')) continue;
      const text = String(node.textContent || '');
      if (/saved on this device/i.test(text)) node.textContent = `${metrics.validatedEnabled} reader-ready sources · ${metrics.localEnabled} enabled on this device`;
      else if (/enabled sources?/i.test(text) && /\d/.test(text)) node.textContent = `${metrics.validatedEnabled} reader-ready sources`;
    }
  }

  async function refresh() {
    if (!onSourcesRoute()) return renderTruth({});
    try {
      const extensions = await registry();
      renderTruth(reconcile(extensions));
    } catch (error) {
      let banner = document.getElementById('yomu-source-truth-banner');
      if (!banner) {
        banner = document.createElement('section');
        banner.id = 'yomu-source-truth-banner';
        document.querySelector('.g-main,main')?.prepend(banner);
      }
      if (banner) {
        banner.style.cssText = 'margin:0 0 14px;padding:12px 14px;border:1px solid rgba(255,120,110,.35);border-radius:14px;color:#ff9b94;font:700 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
        banner.textContent = `Source registry unavailable: ${error?.message || error}`;
      }
    }
  }

  refresh();
  window.addEventListener('yomu:route', refresh);
  window.addEventListener('yomu:source-truth-refresh', refresh);
  window.addEventListener('storage', (event) => { if (event.key === COLLECTION_KEY) setTimeout(refresh, 50); });
  setInterval(() => { if (onSourcesRoute()) refresh(); }, 30000);
})();
