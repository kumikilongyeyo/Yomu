/**
 * Shared source import helpers.
 * Normal add-source navigation now collapses into /sources, where one input
 * accepts either a reading website or a GitHub source repository.
 */
(function (root) {
  'use strict';
  const KEY = 'yomu.v1.collection';

  function host(input) {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : 'https://' + input);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) throw new Error('Paste a website link.');
    return url.hostname.toLowerCase().replace(/^www\./, '');
  }

  function match(input, extensions, options) {
    const allowAdult = !!(options && options.allowAdult);
    const name = host(input.trim());
    const matches = extensions.filter(e => (allowAdult || (!e.nsfw && !(e.content || []).includes('adult'))) && (e.hosts || []).some(h => {
      const wildcard = h.startsWith('*.');
      const domain = h.replace(/^\*\./, '').replace(/^www\./, '').toLowerCase();
      return name === domain || (wildcard && name.endsWith('.' + domain));
    }));
    if (!matches.length) throw new Error('No supported adapter found. This website needs an adapter before Yomu can add it.');
    if (matches.length > 1) {
      const ready = matches.filter(e => e.api && (e.runtime || '').startsWith('fabric-'));
      if (ready.length === 1) return ready[0];
      throw new Error('Several adapters match. Choose one in Extensions.');
    }
    return matches[0];
  }

  function add(storage, extension, origin) {
    const raw = storage.getItem(KEY);
    const col = raw === null ? { revision: 0, sources: [], library: [], progress: {} } : JSON.parse(raw);
    if (!col || typeof col !== 'object' || !Array.isArray(col.sources)) throw new Error('Saved collection could not be read. Nothing was changed.');
    const id = 'yomuext-' + extension.id;
    const existing = col.sources.find(s => s.id === id);
    if (existing && existing.enabled !== false) return false;
    let api = String(extension.api || '').trim();
    if (!api) api = origin + '/api/ext/source/' + encodeURIComponent(extension.id) + '/';
    else if (api.startsWith('/')) api = origin + api;
    if (!/^https?:\/\//i.test(api)) throw new Error('This source does not expose a valid Yomu API endpoint.');
    if (!api.endsWith('/')) api += '/';
    const source = { ...existing, id, label:extension.name, category:extension.runtime ? 'Source Fabric' : 'Yomu Extensions', kind:'api', url:api, enabled:true, ...(extension.runtime ? {runtime:extension.runtime}:{}), ...(extension.engine ? {engine:extension.engine}:{}), ...(Number.isFinite(extension.score) ? {forgeScore:extension.score}:{}) };
    storage.setItem(KEY, JSON.stringify({ ...col, revision:(Number.isInteger(col.revision)?col.revision:0)+1, sources:[...col.sources.filter(s=>s.id!==id),source] }));
    return true;
  }

  const api = { host, match, add };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YomuSourceImport = api;

  if (typeof document !== 'undefined' && /\/add-sources(?:\.html)?\/?$/.test(location.pathname)) {
    const params = new URLSearchParams(location.search);
    // ?auto=1 is the legacy post-publish callback and still needs this page.
    if (params.get('auto') !== '1') {
      const seed = params.get('url') || params.get('source') || '';
      const target = '/sources' + (seed ? `?url=${encodeURIComponent(seed)}` : '') + '#add-source';
      location.replace(target);
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
