(() => {
  'use strict';
  if (!location.pathname.startsWith('/sources')) return;

  const ROOT_ID = 'yomu-source-fabric-command';
  const PACK_ID = 'yomu-source-pack-mode';
  const COMMUNITY_PACK = '/source-packs/community.json';
  const RAW_COMMUNITY_PACK = 'https://raw.githubusercontent.com/kumikilongyeyo/Yomu/main/dist-app/source-packs/community.json';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const COMMUNITY_SEEN_KEY = 'yomu.v1.community-pack-seen';
  const MAX_URLS = 25;

  function cleanUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('Missing source URL.');
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Source URLs must be public http/https links.');
    url.hash = '';
    return url.toString();
  }

  function originKey(value) {
    try { return new URL(cleanUrl(value)).origin.toLowerCase(); }
    catch { return ''; }
  }

  function githubRawUrl(value) {
    const raw = String(value || '').trim();
    try {
      const url = new URL(raw, location.origin);
      if (url.hostname === 'github.com') {
        const parts = url.pathname.split('/').filter(Boolean);
        const blob = parts.indexOf('blob');
        if (blob === 2 && parts.length > 4) {
          const owner = parts[0];
          const repo = parts[1];
          const ref = parts[3];
          const path = parts.slice(4).join('/');
          return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
        }
      }
      return url.toString();
    } catch {
      throw new Error('Paste a valid JSON pack URL.');
    }
  }

  function isCommunityUrl(value) {
    try {
      const resolved = githubRawUrl(value);
      return resolved === new URL(COMMUNITY_PACK, location.origin).toString()
        || resolved === RAW_COMMUNITY_PACK
        || /\/dist-app\/source-packs\/community\.json(?:\?|$)/i.test(resolved)
        || /\/source-packs\/community\.json(?:\?|$)/i.test(resolved);
    } catch {
      return false;
    }
  }

  function parseDocument(document) {
    if (!document || typeof document !== 'object') throw new Error('Source pack is not valid JSON.');
    if (document.schema && document.schema !== 'yomu.source-pack/1') throw new Error(`Unsupported source pack schema: ${document.schema}`);
    if (!Array.isArray(document.sources)) throw new Error('Source pack must contain a sources array.');

    const urls = [];
    const seen = new Set();
    for (const item of document.sources) {
      const candidate = typeof item === 'string' ? item : item?.url ?? item?.site ?? item?.baseUrl;
      if (!candidate) continue;
      const url = cleanUrl(candidate);
      const key = new URL(url).origin.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(url);
      if (urls.length >= MAX_URLS) break;
    }
    if (!urls.length) throw new Error('This source pack contains no usable site URLs.');
    return {
      urls,
      name: String(document.name || document.id || 'Source pack'),
      version: document.version == null ? '' : String(document.version),
      truncated: document.sources.length > urls.length && urls.length >= MAX_URLS,
    };
  }

  async function loadJson(url) {
    const target = githubRawUrl(url);
    const response = await fetch(target, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Pack returned HTTP ${response.status}.`);
    const type = response.headers.get('content-type') || '';
    const text = await response.text();
    let document;
    try { document = JSON.parse(text); } catch { throw new Error(type.includes('text/html') ? 'That link returned a web page, not JSON. Use the GitHub file link or raw JSON URL.' : 'Pack is not valid JSON.'); }
    return parseDocument(document);
  }

  function readCollection() {
    try {
      const raw = localStorage.getItem(COLLECTION_KEY);
      if (!raw) return { sources: [] };
      const value = JSON.parse(raw);
      return value && Array.isArray(value.sources) ? value : { sources: [] };
    } catch {
      return { sources: [] };
    }
  }

  function readSeenOrigins() {
    try {
      const raw = localStorage.getItem(COMMUNITY_SEEN_KEY);
      if (!raw) return new Set();
      const value = JSON.parse(raw);
      return Array.isArray(value?.origins) ? new Set(value.origins.map(String)) : new Set();
    } catch {
      return new Set();
    }
  }

  function saveAddedOrigins(urls, version = '') {
    try {
      const seen = readSeenOrigins();
      for (const url of urls || []) {
        const key = originKey(url);
        if (key) seen.add(key);
      }
      localStorage.setItem(COMMUNITY_SEEN_KEY, JSON.stringify({
        version: String(version || ''),
        checkedAt: Date.now(),
        origins: [...seen],
      }));
    } catch {}
  }

  async function registry() {
    const response = await fetch('/api/ext/sources', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return [];
    const body = await response.json().catch(() => ({}));
    return Array.isArray(body.extensions) ? body.extensions : [];
  }

  function extensionForUrl(url, extensions) {
    let hostname = '';
    try { hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
    const matches = (extensions || []).filter((extension) => (extension.hosts || []).some((host) => {
      const wildcard = String(host).startsWith('*.');
      const domain = String(host).replace(/^\*\./, '').replace(/^www\./, '').toLowerCase();
      return hostname === domain || (wildcard && hostname.endsWith('.' + domain));
    }));
    if (!matches.length) return null;
    return matches.find((extension) => String(extension.runtime || '').startsWith('fabric-')) || matches[0];
  }

  function sourceMatchesUrl(source, url) {
    if (!source || source.enabled === false) return false;
    let host = '';
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
    const stem = host.split('.')[0].replace(/[^a-z0-9]/g, '');
    const compactHost = host.replace(/[^a-z0-9]/g, '');
    const haystack = [
      source.id,
      source.label,
      source.name,
      source.url,
      source.api,
      source.runtime,
      source.engine,
    ].filter(Boolean).map((value) => String(value).toLowerCase());

    return haystack.some((value) => {
      if (value.includes(host)) return true;
      const compact = value.replace(/[^a-z0-9]/g, '');
      if (compactHost.length >= 6 && compact.includes(compactHost)) return true;
      return stem.length >= 5 && compact.includes(stem);
    });
  }

  async function communityDelta(parsed) {
    const seen = readSeenOrigins();
    const collection = readCollection();
    const enabledSources = collection.sources.filter((source) => source && source.enabled !== false);
    const enabledIds = new Set(enabledSources
      .map((source) => String(source.id || ''))
      .filter(Boolean));

    let extensions = [];
    try { extensions = await registry(); } catch {}

    const fresh = [];
    const knownUrls = [];
    let known = 0;
    for (const url of parsed.urls) {
      const extension = extensionForUrl(url, extensions);
      const id = extension?.id ? 'yomuext-' + extension.id : '';
      const alreadyInstalled = (!!id && enabledIds.has(id)) || enabledSources.some((source) => sourceMatchesUrl(source, url));
      const alreadyAddedThroughPack = seen.has(originKey(url));
      if (alreadyInstalled || alreadyAddedThroughPack) {
        known += 1;
        knownUrls.push(url);
      } else {
        fresh.push(url);
      }
    }

    if (knownUrls.length) saveAddedOrigins(knownUrls, parsed.version || '');
    return { fresh, known, knownUrls, basis: 'installed+added+fingerprint' };
  }

  function mount() {
    const root = document.getElementById(ROOT_ID);
    const pack = document.getElementById(PACK_ID);
    if (!root || !pack || pack.querySelector('.sp-json-import')) return !!(root && pack);

    const textarea = pack.querySelector('textarea');
    const meta = pack.querySelector('.sp-meta');
    const summary = pack.querySelector('.sp-summary');
    const modeButton = root.querySelector('.sf-mode-switch button[data-mode="pack"]');
    if (!textarea || !meta) return false;

    const style = document.createElement('style');
    style.textContent = `
      #${PACK_ID} .sp-json-import{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;margin:0 0 10px}
      #${PACK_ID} .sp-json-import input{min-width:0;height:40px;padding:0 12px;border-radius:11px;border:1px solid var(--line,#263747);background:var(--bg,#09111a);color:var(--text,#f7f8fa);font:inherit;font-size:12px;outline:none}
      #${PACK_ID} .sp-json-import button{height:40px;padding:0 13px;border-radius:999px;font-size:11px;font-weight:800;white-space:nowrap;cursor:pointer}
      #${PACK_ID} .sp-json-load{border:1px solid var(--line,#263747);background:transparent;color:var(--text,#f7f8fa)}
      #${PACK_ID} .sp-json-community{border:0;background:color-mix(in srgb,var(--accent,#ffc15a) 18%,var(--surface,#111b25));color:var(--text,#f7f8fa);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent,#ffc15a) 38%,transparent)}
      #${PACK_ID} .sp-json-community[data-new]:not([data-new="0"]){box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent,#ffc15a) 68%,transparent),0 0 18px color-mix(in srgb,var(--accent,#ffc15a) 13%,transparent)}
      #${PACK_ID} .sp-json-status{grid-column:1/-1;min-height:14px;color:var(--dim,#8297aa);font-size:10.5px}
      #${ROOT_ID} .sf-mode-switch button[data-mode="pack"][data-new]:not([data-new="0"])::after{content:'+' attr(data-new);display:inline-flex;align-items:center;justify-content:center;margin-left:6px;min-width:20px;height:18px;padding:0 5px;border-radius:999px;background:var(--accent,#ffc15a);color:var(--accentText,#0c131b);font-size:9px;font-weight:900;line-height:1}
      @media(max-width:760px){#${PACK_ID} .sp-json-import{grid-template-columns:1fr 1fr}#${PACK_ID} .sp-json-import input{grid-column:1/-1}#${PACK_ID} .sp-json-import button{width:100%}}
    `;
    document.head.append(style);

    const box = document.createElement('div');
    box.className = 'sp-json-import';
    box.innerHTML = `
      <input type="url" inputmode="url" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="GitHub or JSON source-pack URL" aria-label="JSON source-pack URL">
      <button type="button" class="sp-json-load">Load JSON</button>
      <button type="button" class="sp-json-community" data-new="0">Community pack</button>
      <div class="sp-json-status">Portable packs contain site URLs only. Yomu still tests every new source before adding it.</div>`;
    meta.insertAdjacentElement('afterend', box);

    const input = box.querySelector('input');
    const load = box.querySelector('.sp-json-load');
    const community = box.querySelector('.sp-json-community');
    const status = box.querySelector('.sp-json-status');

    function paintBadge(count) {
      const safe = Math.max(0, Number(count) || 0);
      community.dataset.new = String(safe);
      community.textContent = safe ? `Community pack · +${safe} new` : 'Community pack · up to date';
      community.title = safe ? `${safe} new source${safe === 1 ? '' : 's'} available` : 'No new Community Pack sources';
      if (modeButton) modeButton.dataset.new = String(safe);
    }

    async function refreshCommunityBadge() {
      try {
        const parsed = await loadJson(RAW_COMMUNITY_PACK);
        const delta = await communityDelta(parsed);
        paintBadge(delta.fresh.length);
        if (delta.fresh.length) status.textContent = `${delta.fresh.length} new Community Pack source${delta.fresh.length === 1 ? '' : 's'} available.`;
        else status.textContent = 'Community Pack is up to date.';
        return { parsed, delta };
      } catch {
        paintBadge(0);
        return null;
      }
    }

    async function applyPack(url) {
      load.disabled = true;
      community.disabled = true;
      status.textContent = 'Loading source pack…';
      try {
        const parsed = await loadJson(url);
        const version = parsed.version ? ` v${parsed.version}` : '';

        if (isCommunityUrl(url)) {
          pack.dataset.communityPack = '1';
          pack.dataset.communityVersion = parsed.version || '';
          status.textContent = `Checking ${parsed.name}${version} against this device…`;
          const delta = await communityDelta(parsed);
          textarea.value = delta.fresh.join('\n');
          paintBadge(delta.fresh.length);

          if (delta.fresh.length) {
            status.textContent = `${parsed.name}${version} · ${delta.fresh.length} new. Only new sources are queued.`;
            if (summary) summary.textContent = `${delta.fresh.length} new Community Pack source${delta.fresh.length === 1 ? '' : 's'} ready to test.`;
          } else {
            status.textContent = `${parsed.name}${version} · You're up to date.`;
            if (summary) summary.textContent = 'Community Pack is up to date.';
          }
        } else {
          delete pack.dataset.communityPack;
          delete pack.dataset.communityVersion;
          textarea.value = parsed.urls.join('\n');
          status.textContent = `Loaded ${parsed.name}${version} · ${parsed.urls.length} sources${parsed.truncated ? ` · first ${MAX_URLS} shown` : ''}. Review, then press Test & add source pack.`;
          if (summary) summary.textContent = `${parsed.urls.length} sources loaded from JSON. Ready to test.`;
        }

        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (error) {
        status.textContent = error?.message || 'Could not load this source pack.';
      } finally {
        load.disabled = false;
        community.disabled = false;
      }
    }

    load.addEventListener('click', () => {
      const value = input.value.trim();
      if (!value) {
        status.textContent = 'Paste a GitHub or JSON pack URL first.';
        return;
      }
      applyPack(value);
    });

    community.addEventListener('click', () => {
      input.value = RAW_COMMUNITY_PACK;
      applyPack(RAW_COMMUNITY_PACK);
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        load.click();
      }
    });

    window.addEventListener('yomu:community-pack-added', (event) => {
      const urls = Array.isArray(event?.detail?.urls) ? event.detail.urls : [];
      if (urls.length) saveAddedOrigins(urls, event?.detail?.version || pack.dataset.communityVersion || '');
      refreshCommunityBadge();
    });

    window.addEventListener('storage', (event) => {
      if (event.key === COLLECTION_KEY) refreshCommunityBadge();
    });

    refreshCommunityBadge();
    return true;
  }

  if (mount()) return;
  const observer = new MutationObserver(() => {
    if (mount()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 12000);
})();
