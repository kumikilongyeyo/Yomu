/**
 * Turn a pasted website link into an enabled Yomu source.
 *
 * It matches the link's host against the hosts an adapter already declares, so
 * it can only ever enable something the Worker has loaded. It writes nothing
 * but the collection, fetches nothing, and cannot bring a new site into scope.
 *
 * From the yomu-paste-sources package; the adult filter is wired to the app's
 * 18+ gate here rather than hardcoded off.
 */
(function (root) {
  'use strict';
  const KEY = 'yomu.v1.collection';
  function host(input) {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : 'https://' + input);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) throw new Error('Paste a website link.');
    return url.hostname.toLowerCase().replace(/^www\./, '');
  }
  /**
   * @param options.allowAdult  Adult adapters are excluded unless the reader
   *   has turned 18+ on. It defaults to false, so a caller that does not know
   *   about the gate keeps the safe behaviour.
   */
  function match(input, extensions, options) {
    const allowAdult = !!(options && options.allowAdult);
    const name = host(input.trim());
    const matches = extensions.filter(e => (allowAdult || (!e.nsfw && !(e.content || []).includes('adult'))) && (e.hosts || []).some(h => {
      const wildcard = h.startsWith('*.');
      const domain = h.replace(/^\*\./, '').replace(/^www\./, '').toLowerCase();
      return name === domain || (wildcard && name.endsWith('.' + domain));
    }));
    if (!matches.length) throw new Error('No supported adapter found. This website needs an adapter before Yomu can add it.');
    if (matches.length > 1) throw new Error('Several adapters match. Choose one in Extensions.');
    return matches[0];
  }
  function add(storage, extension, origin) {
    const raw = storage.getItem(KEY);
    const col = raw === null ? { revision: 0, sources: [], library: [], progress: {} } : JSON.parse(raw);
    if (!col || typeof col !== 'object' || !Array.isArray(col.sources)) throw new Error('Saved collection could not be read. Nothing was changed.');
    const id = 'yomuext-' + extension.id;
    const existing = col.sources.find(s => s.id === id);
    if (existing && existing.enabled !== false) return false;
    const source = { ...existing, id, label: extension.name, category: 'Yomu Extensions', kind: 'api', url: origin + '/api/ext/source/' + encodeURIComponent(extension.id) + '/', enabled: true };
    storage.setItem(KEY, JSON.stringify({ ...col, revision: (Number.isInteger(col.revision) ? col.revision : 0) + 1, sources: [...col.sources.filter(s => s.id !== id), source] }));
    return true;
  }
  const api = { host, match, add };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YomuSourceImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
