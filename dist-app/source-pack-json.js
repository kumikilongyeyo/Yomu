(() => {
  'use strict';
  if (!location.pathname.startsWith('/sources')) return;

  const ROOT_ID = 'yomu-source-fabric-command';
  const PACK_ID = 'yomu-source-pack-mode';
  const COMMUNITY_PACK = '/source-packs/community.json';
  const MAX_URLS = 25;

  function cleanUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('Missing source URL.');
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Source URLs must be public http/https links.');
    url.hash = '';
    return url.toString();
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

  function mount() {
    const root = document.getElementById(ROOT_ID);
    const pack = document.getElementById(PACK_ID);
    if (!root || !pack || pack.querySelector('.sp-json-import')) return !!(root && pack);

    const textarea = pack.querySelector('textarea');
    const meta = pack.querySelector('.sp-meta');
    const summary = pack.querySelector('.sp-summary');
    if (!textarea || !meta) return false;

    const style = document.createElement('style');
    style.textContent = `
      #${PACK_ID} .sp-json-import{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;margin:0 0 10px}
      #${PACK_ID} .sp-json-import input{min-width:0;height:40px;padding:0 12px;border-radius:11px;border:1px solid var(--line,#263747);background:var(--bg,#09111a);color:var(--text,#f7f8fa);font:inherit;font-size:12px;outline:none}
      #${PACK_ID} .sp-json-import button{height:40px;padding:0 13px;border-radius:999px;font-size:11px;font-weight:800;white-space:nowrap;cursor:pointer}
      #${PACK_ID} .sp-json-load{border:1px solid var(--line,#263747);background:transparent;color:var(--text,#f7f8fa)}
      #${PACK_ID} .sp-json-community{border:0;background:color-mix(in srgb,var(--accent,#ffc15a) 18%,var(--surface,#111b25));color:var(--text,#f7f8fa);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent,#ffc15a) 38%,transparent)}
      #${PACK_ID} .sp-json-status{grid-column:1/-1;min-height:14px;color:var(--dim,#8297aa);font-size:10.5px}
      @media(max-width:760px){#${PACK_ID} .sp-json-import{grid-template-columns:1fr 1fr}#${PACK_ID} .sp-json-import input{grid-column:1/-1}#${PACK_ID} .sp-json-import button{width:100%}}
    `;
    document.head.append(style);

    const box = document.createElement('div');
    box.className = 'sp-json-import';
    box.innerHTML = `
      <input type="url" inputmode="url" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="GitHub or JSON source-pack URL" aria-label="JSON source-pack URL">
      <button type="button" class="sp-json-load">Load JSON</button>
      <button type="button" class="sp-json-community">Community pack</button>
      <div class="sp-json-status">Portable packs contain site URLs only. Yomu still tests every source before adding it.</div>`;
    meta.insertAdjacentElement('afterend', box);

    const input = box.querySelector('input');
    const load = box.querySelector('.sp-json-load');
    const community = box.querySelector('.sp-json-community');
    const status = box.querySelector('.sp-json-status');

    async function applyPack(url) {
      load.disabled = true;
      community.disabled = true;
      status.textContent = 'Loading source pack…';
      try {
        const parsed = await loadJson(url);
        textarea.value = parsed.urls.join('\n');
        const version = parsed.version ? ` v${parsed.version}` : '';
        status.textContent = `Loaded ${parsed.name}${version} · ${parsed.urls.length} sources${parsed.truncated ? ` · first ${MAX_URLS} shown` : ''}. Review, then press Test & add source pack.`;
        if (summary) summary.textContent = `${parsed.urls.length} sources loaded from JSON. Ready to test.`;
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
      input.value = COMMUNITY_PACK;
      applyPack(COMMUNITY_PACK);
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        load.click();
      }
    });

    return true;
  }

  if (mount()) return;
  const observer = new MutationObserver(() => {
    if (mount()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 12000);
})();
