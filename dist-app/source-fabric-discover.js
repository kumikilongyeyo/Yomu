(() => {
  'use strict';
  if (!location.pathname.startsWith('/discover')) return;

  const PANEL_ID = 'yomu-expanded-catalog';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const MAX_RESULTS = 36;

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };

  const adultAllowed = () => {
    try { return localStorage.getItem('yomu.v1.adult') === 'on'; }
    catch { return false; }
  };

  function normalizeTitle(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(the|a|an|of|and|manga|manhwa|manhua|webtoon|comic|official|colored|coloured)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function appSourceId(providerId) {
    const id = String(providerId || '');
    if (id.startsWith('ext:')) return 'yomuext-' + id.slice(4);
    if (id.startsWith('suwayomi:')) return 'mihon-' + id.slice(9);
    return id;
  }

  function collection() {
    const value = readJSON(COLLECTION_KEY, {});
    return value && typeof value === 'object' ? value : {};
  }

  function fabricSources() {
    return (Array.isArray(collection().sources) ? collection().sources : [])
      .filter((source) => source && source.enabled !== false && source.kind === 'api')
      .filter((source) => source.category === 'Source Fabric' || source.runtime || /remote/i.test(String(source.engine || '')))
      .flatMap((source) => {
        try {
          const base = new URL(String(source.url || ''), location.origin);
          if (base.origin !== location.origin || !base.pathname.startsWith('/api/')) return [];
          if (!base.pathname.endsWith('/')) base.pathname += '/';
          return [{
            id: String(source.id || ''),
            label: String(source.label || source.id || 'Source Fabric'),
            url: base.toString(),
            runtime: String(source.runtime || ''),
          }];
        } catch { return []; }
      });
  }

  async function getJson(url, timeout = 16000) {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeout) });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) throw new Error(body?.error || `HTTP ${response.status}`);
    return body;
  }

  function fromCatalog(item) {
    const providers = Array.isArray(item?.providers) ? item.providers.map((provider) => ({
      sourceId: appSourceId(provider.id),
      seriesId: String(provider.seriesId || item.id || ''),
      label: String(provider.name || provider.id || 'Yomu'),
      fabric: false,
    })).filter((provider) => provider.sourceId && provider.seriesId) : [];

    if (!providers.length && item?.id) {
      providers.push({ sourceId: 'mangadex', seriesId: String(item.id), label: 'Yomu', fabric: false });
    }

    return {
      title: String(item?.title || 'Untitled'),
      author: String(item?.author || ''),
      synopsis: String(item?.synopsis || ''),
      cover: String(item?.cover || ''),
      category: String(item?.category || ''),
      status: String(item?.status || ''),
      nsfw: !!item?.nsfw,
      updatedAt: Number(item?.updatedAt || 0),
      providers,
    };
  }

  function fromFabric(item, source) {
    if (!item?.id) return null;
    return {
      title: String(item.title || 'Untitled'),
      author: String(item.author || ''),
      synopsis: String(item.synopsis || ''),
      cover: String(item.cover || ''),
      category: String(item.category || ''),
      status: String(item.status || ''),
      nsfw: !!item.nsfw,
      updatedAt: Number(item.updatedAt || 0),
      providers: [{ sourceId: source.id, seriesId: String(item.id), label: source.label, fabric: true }],
    };
  }

  function mergeRows(rows) {
    const map = new Map();
    for (const row of rows) {
      if (!row?.title || (!adultAllowed() && row.nsfw)) continue;
      const key = normalizeTitle(row.title);
      if (!key) continue;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...row, providers: [...(row.providers || [])] });
        continue;
      }
      existing.author ||= row.author;
      existing.synopsis ||= row.synopsis;
      existing.cover ||= row.cover;
      existing.category ||= row.category;
      existing.status ||= row.status;
      existing.nsfw ||= row.nsfw;
      existing.updatedAt = Math.max(existing.updatedAt || 0, row.updatedAt || 0);
      const seen = new Set(existing.providers.map((provider) => `${provider.sourceId}|${provider.seriesId}`));
      for (const provider of row.providers || []) {
        const providerKey = `${provider.sourceId}|${provider.seriesId}`;
        if (!seen.has(providerKey)) {
          seen.add(providerKey);
          existing.providers.push(provider);
        }
      }
      existing.providers.sort((a, b) => Number(b.fabric) - Number(a.fabric));
    }
    return [...map.values()];
  }

  function searchScore(row, query) {
    const title = normalizeTitle(row.title);
    const q = normalizeTitle(query);
    if (!q || !title) return 0;
    if (title === q) return 100;
    if (title.startsWith(q)) return 90;
    if (title.includes(q)) return 80;
    const words = q.split(' ').filter(Boolean);
    return words.reduce((score, word) => score + (title.includes(word) ? 8 : 0), 0);
  }

  async function loadExpanded(query = '') {
    const sources = fabricSources();
    const adult = adultAllowed() ? '&adult=1' : '';
    const builtInUrl = query
      ? `/api/catalog/search?q=${encodeURIComponent(query)}${adult}`
      : `/api/catalog/popular?${adult.slice(1)}`;

    const requests = [
      getJson(builtInUrl, 20000)
        .then((body) => (Array.isArray(body.series) ? body.series.map(fromCatalog) : []))
        .catch(() => []),
      ...sources.map((source) => {
        const endpoint = query
          ? `${source.url}search?q=${encodeURIComponent(query)}&page=1`
          : `${source.url}series?page=1`;
        return getJson(endpoint, 18000)
          .then((body) => (Array.isArray(body.series) ? body.series.map((item) => fromFabric(item, source)).filter(Boolean) : []))
          .catch(() => []);
      }),
    ];

    const chunks = await Promise.all(requests);
    let rows = mergeRows(chunks.flat());
    if (query) {
      rows = rows
        .map((row) => ({ row, score: searchScore(row, query) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || b.row.providers.length - a.row.providers.length || a.row.title.localeCompare(b.row.title))
        .map((entry) => entry.row);
    } else {
      rows.sort((a, b) => {
        const af = a.providers.some((provider) => provider.fabric) ? 1 : 0;
        const bf = b.providers.some((provider) => provider.fabric) ? 1 : 0;
        return bf - af || (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    }
    return { rows: rows.slice(0, MAX_RESULTS), sourceCount: sources.length, sources };
  }

  const css = document.createElement('style');
  css.textContent = `
    #${PANEL_ID}{margin:0 0 20px;padding:18px;border:1px solid var(--line,#263747);border-radius:18px;background:linear-gradient(180deg,color-mix(in srgb,var(--surface,#17232d) 94%,var(--accent,#ffc45f) 6%),var(--surface,#17232d));color:var(--text,#f4f6fa);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
    #${PANEL_ID} *{box-sizing:border-box}
    #${PANEL_ID} .xf-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
    #${PANEL_ID} .xf-kicker{font-size:10.5px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:var(--dim,#8fa0b4);margin-bottom:5px}
    #${PANEL_ID} h2{font-size:21px;line-height:1.1;letter-spacing:-.02em;margin:0}
    #${PANEL_ID} .xf-copy{margin:5px 0 0;font-size:12.5px;line-height:1.45;color:var(--muted,#a8b6c7);max-width:720px}
    #${PANEL_ID} .xf-count{flex:none;border:1px solid var(--accentLine,#ffc45f66);border-radius:999px;padding:6px 9px;font-size:10.5px;color:var(--accent,#ffc45f);white-space:nowrap}
    #${PANEL_ID} .xf-form{display:flex;gap:9px;margin-top:14px}
    #${PANEL_ID} .xf-form input{flex:1;min-width:0;height:46px;border-radius:12px;border:1px solid var(--line,#263747);background:var(--bg,#0c131b);color:var(--text,#f4f6fa);font:inherit;font-size:14px;padding:0 13px;outline:none}
    #${PANEL_ID} .xf-form input:focus{border-color:var(--accentLine,#ffc45f66);box-shadow:0 0 0 3px var(--accentSoft,#ffc45f1f)}
    #${PANEL_ID} .xf-form button{height:46px;border:0;border-radius:999px;padding:0 18px;background:var(--accent,#ffc45f);color:var(--accentText,#18212a);font:inherit;font-weight:800;cursor:pointer}
    #${PANEL_ID} .xf-form button:disabled{opacity:.55;cursor:wait}
    #${PANEL_ID} .xf-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0 10px;color:var(--muted,#a8b6c7);font-size:11.5px}
    #${PANEL_ID} .xf-source-list{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%}
    #${PANEL_ID} .xf-reset{appearance:none;border:0;background:none;color:var(--accent,#ffc45f);font:inherit;font-weight:700;cursor:pointer;padding:3px}
    #${PANEL_ID} .xf-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:11px}
    #${PANEL_ID} .xf-card{position:relative;display:block;aspect-ratio:2/3;border-radius:12px;overflow:hidden;background:var(--raised,#25333e);border:1px solid var(--line,#263747);text-decoration:none;color:var(--text,#f4f6fa);isolation:isolate;min-width:0}
    #${PANEL_ID} .xf-card img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:var(--raised,#25333e)}
    #${PANEL_ID} .xf-shade{position:absolute;inset:0;background:linear-gradient(180deg,transparent 37%,rgba(5,10,14,.2) 52%,rgba(5,10,14,.94) 100%);z-index:1}
    #${PANEL_ID} .xf-source{position:absolute;top:7px;left:7px;right:49px;z-index:2;display:flex;gap:4px;align-items:center;overflow:hidden}
    #${PANEL_ID} .xf-chip{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 7px;border-radius:999px;background:rgba(10,17,24,.82);backdrop-filter:blur(8px);font-size:9.5px;font-weight:750;color:#f4f6fa;border:1px solid rgba(255,255,255,.12)}
    #${PANEL_ID} .xf-fabric{border-color:var(--accentLine,#ffc45f66);color:var(--accent,#ffc45f)}
    #${PANEL_ID} .xf-more{position:absolute;top:7px;right:7px;z-index:2;padding:4px 7px;border-radius:999px;background:rgba(10,17,24,.82);font-size:9.5px;color:#fff}
    #${PANEL_ID} .xf-info{position:absolute;left:10px;right:10px;bottom:10px;z-index:2}
    #${PANEL_ID} .xf-title{font-size:12.5px;line-height:1.25;font-weight:800;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    #${PANEL_ID} .xf-meta{margin-top:4px;color:#b9c6d4;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #${PANEL_ID} .xf-empty{grid-column:1/-1;padding:28px 12px;text-align:center;border:1px dashed var(--line,#263747);border-radius:12px;color:var(--muted,#a8b6c7);font-size:12px}
    #${PANEL_ID} .xf-loading{display:inline-block;width:11px;height:11px;margin-right:6px;border:2px solid rgba(255,255,255,.18);border-top-color:var(--accent,#ffc45f);border-radius:50%;animation:xfspin .7s linear infinite;vertical-align:-2px}@keyframes xfspin{to{transform:rotate(360deg)}}
    @media(max-width:1100px){#${PANEL_ID} .xf-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
    @media(max-width:700px){#${PANEL_ID}{padding:14px;border-radius:16px}#${PANEL_ID} .xf-head{display:block}#${PANEL_ID} .xf-count{display:inline-flex;margin-top:8px}#${PANEL_ID} .xf-form{flex-direction:column}#${PANEL_ID} .xf-form button{width:100%}#${PANEL_ID} .xf-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}#${PANEL_ID} .xf-source-list{max-width:62%}}
  `;
  document.head.append(css);

  function panel() {
    const sources = fabricSources();
    const el = document.createElement('section');
    el.id = PANEL_ID;
    el.innerHTML = `
      <div class="xf-head">
        <div>
          <div class="xf-kicker">Expanded catalog</div>
          <h2>Search everything Yomu can read.</h2>
          <p class="xf-copy">Built-in providers plus every Source Fabric site you add are searched on demand. Titles are not bulk-downloaded into your device.</p>
        </div>
        <span class="xf-count">${sources.length} added source${sources.length === 1 ? '' : 's'}</span>
      </div>
      <form class="xf-form">
        <input type="search" autocomplete="off" spellcheck="false" placeholder="Search across Yomu + added sources…" aria-label="Search all enabled Yomu sources" />
        <button type="submit">Search all</button>
      </form>
      <div class="xf-bar"><span class="xf-status">Loading titles from your expanded catalog…</span><button type="button" class="xf-reset" hidden>Browse popular</button></div>
      <div class="xf-grid" aria-live="polite"></div>`;
    return el;
  }

  function card(row) {
    const provider = row.providers?.[0];
    if (!provider) return null;
    const link = document.createElement('a');
    link.className = 'xf-card';
    link.href = `/series/${encodeURIComponent(provider.seriesId)}?source=${encodeURIComponent(provider.sourceId)}`;
    link.setAttribute('aria-label', `Open ${row.title} from ${provider.label}`);

    if (row.cover) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = row.cover;
      img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true });
      link.append(img);
    }

    const shade = document.createElement('span');
    shade.className = 'xf-shade';
    link.append(shade);

    const source = document.createElement('span');
    source.className = 'xf-source';
    const chip = document.createElement('span');
    chip.className = 'xf-chip' + (provider.fabric ? ' xf-fabric' : '');
    chip.textContent = provider.label;
    source.append(chip);
    link.append(source);

    if ((row.providers?.length || 0) > 1) {
      const more = document.createElement('span');
      more.className = 'xf-more';
      more.textContent = '+' + (row.providers.length - 1);
      more.title = row.providers.slice(1).map((p) => p.label).join(', ');
      link.append(more);
    }

    const info = document.createElement('span');
    info.className = 'xf-info';
    const title = document.createElement('span');
    title.className = 'xf-title';
    title.textContent = row.title;
    info.append(title);
    const meta = document.createElement('span');
    meta.className = 'xf-meta';
    meta.textContent = [row.category, row.status, row.author].filter(Boolean).slice(0, 2).join(' · ') || 'Open title';
    info.append(meta);
    link.append(info);
    return link;
  }

  function mount() {
    if (document.getElementById(PANEL_ID)) return true;
    const main = document.querySelector('.g-main');
    if (!main) return false;
    const heading = main.querySelector('.page-heading');
    const split = main.querySelector('.split-grid');
    if (!heading || !split) return false;

    const el = panel();
    split.before(el);

    const form = el.querySelector('.xf-form');
    const input = el.querySelector('input');
    const button = el.querySelector('button[type="submit"]');
    const status = el.querySelector('.xf-status');
    const reset = el.querySelector('.xf-reset');
    const grid = el.querySelector('.xf-grid');
    let runId = 0;

    const render = async (query = '') => {
      const mine = ++runId;
      button.disabled = true;
      status.innerHTML = '<span class="xf-loading"></span>' + (query ? 'Searching all enabled sources…' : 'Loading popular titles + added sources…');
      grid.innerHTML = '';
      try {
        const result = await loadExpanded(query);
        if (mine !== runId) return;
        const sourceNames = result.sources.map((source) => source.label);
        status.textContent = query
          ? `${result.rows.length} result${result.rows.length === 1 ? '' : 's'} · searched Yomu${sourceNames.length ? ' + ' + sourceNames.join(', ') : ''}`
          : `${result.rows.length} titles ready · added sources are mixed into this shelf${sourceNames.length ? ': ' + sourceNames.join(', ') : ''}`;
        reset.hidden = !query;
        if (!result.rows.length) {
          const empty = document.createElement('div');
          empty.className = 'xf-empty';
          empty.textContent = query ? 'No enabled source returned a matching title.' : 'No titles were returned yet. Add a source or try Search all.';
          grid.append(empty);
          return;
        }
        for (const row of result.rows) {
          const node = card(row);
          if (node) grid.append(node);
        }
      } catch (error) {
        if (mine !== runId) return;
        status.textContent = 'Could not load the expanded catalog: ' + String(error?.message || error);
        const empty = document.createElement('div');
        empty.className = 'xf-empty';
        empty.textContent = 'The rest of Discover still works. Try again in a moment.';
        grid.append(empty);
      } finally {
        if (mine === runId) button.disabled = false;
      }
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const query = String(input.value || '').trim();
      render(query);
    });
    reset.addEventListener('click', () => {
      input.value = '';
      render('');
    });

    render('');
    return true;
  }

  if (!mount()) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (mount() || tries > 40) clearInterval(timer);
    }, 250);
  }
})();
