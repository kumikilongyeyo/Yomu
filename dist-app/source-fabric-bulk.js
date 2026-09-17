(() => {
  'use strict';
  if (!location.pathname.startsWith('/sources')) return;

  const ROOT_ID = 'yomu-source-fabric-command';
  const PACK_ID = 'yomu-source-pack-mode';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const MAX_URLS = 25;
  const CONCURRENCY = 4;
  const REQUEST_TIMEOUT = 14_000;

  const adultAllowed = () => {
    try { return localStorage.getItem('yomu.v1.adult') === 'on'; } catch { return false; }
  };
  const isAdult = (extension) => !!extension?.nsfw
    || (extension?.content || []).some((x) => String(x).toLowerCase() === 'adult');

  function cleanUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('Empty URL.');
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error('Use a normal public http/https URL.');
    u.hash = '';
    return u.toString();
  }

  function parsePack(raw) {
    const values = String(raw || '').split(/[\n,\s]+/).map((x) => x.trim()).filter(Boolean);
    const urls = [], invalid = [], seen = new Set();
    for (const value of values) {
      if (urls.length >= MAX_URLS) break;
      try {
        const url = cleanUrl(value);
        const key = new URL(url).origin.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key); urls.push(url);
      } catch (error) { invalid.push({ value, message: error?.message || 'Invalid URL.' }); }
    }
    return { urls, invalid, truncated: values.length > urls.length + invalid.length || urls.length >= MAX_URLS };
  }

  function hostMatch(input, extensions) {
    const host = new URL(input).hostname.toLowerCase().replace(/^www\./, '');
    const allowed = (extensions || []).filter((e) => {
      if (!adultAllowed() && isAdult(e)) return false;
      return (e.hosts || []).some((h) => {
        const wildcard = h.startsWith('*.');
        const domain = h.replace(/^\*\./, '').replace(/^www\./, '').toLowerCase();
        return host === domain || (wildcard && host.endsWith('.' + domain));
      });
    });
    if (allowed.length <= 1) return allowed[0] || null;
    return allowed.find((e) => String(e.runtime || '').startsWith('fabric-')) || allowed[0];
  }

  function apiFor(extension) {
    let api = String(extension?.api || '').trim();
    if (!api) api = location.origin + '/api/ext/source/' + encodeURIComponent(extension.id) + '/';
    else if (api.startsWith('/')) api = location.origin + api;
    return api.endsWith('/') ? api : api + '/';
  }

  const retryable = (status) => status === 408 || status === 425 || status === 429 || status >= 500;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function getJson(url, tries = 2) {
    let last;
    for (let attempt = 0; attempt < tries; attempt += 1) {
      try {
        const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
        const body = await response.json().catch(() => null);
        if (response.ok) return body;
        const message = body?.error || `HTTP ${response.status}`;
        last = new Error(message);
        if (!retryable(response.status) || attempt + 1 >= tries) throw last;
      } catch (error) {
        last = error;
        if (attempt + 1 >= tries) throw error;
      }
      await sleep(220 + attempt * 380);
    }
    throw last || new Error('Request failed.');
  }

  /**
   * A source is only "Healthy" after proving the complete path a reader needs:
   * browse -> title -> chapters -> actual page manifest. A catalog-only pass was
   * letting stale recipes into the pack and they broke only after a user opened
   * a chapter.
   */
  async function verify(extension) {
    const api = apiFor(extension);
    const browse = await getJson(api + 'series');
    const series = Array.isArray(browse?.series) ? browse.series.filter((s) => s?.id) : [];
    if (!series.length) throw new Error('Catalog answered, but returned no usable titles.');

    // Try a few titles because a pinned/odd first result can legitimately have no chapters.
    const sample = [series[0], series[Math.floor(series.length / 2)], series[series.length - 1]]
      .filter(Boolean).filter((item, i, all) => all.findIndex((x) => String(x.id) === String(item.id)) === i);

    let chosen = null;
    let chapters = [];
    let detailError = null;
    for (const title of sample) {
      try {
        const detail = await getJson(api + 'series/' + encodeURIComponent(title.id));
        const list = Array.isArray(detail?.chapters) ? detail.chapters.filter((ch) => ch?.id) : [];
        if (list.length) { chosen = title; chapters = list; break; }
      } catch (error) { detailError = error; }
    }
    if (!chosen) throw new Error(detailError?.message || 'Titles load, but no sampled title returned chapters.');

    // Probe up to three releases. One bad chapter should not condemn a healthy source,
    // but a source that cannot produce any real pages must never be enabled as readable.
    const chapterSample = [chapters[0], chapters[Math.floor(chapters.length / 2)], chapters[chapters.length - 1]]
      .filter(Boolean).filter((item, i, all) => all.findIndex((x) => String(x.id) === String(item.id)) === i);
    let manifest = null;
    let manifestError = null;
    for (const chapter of chapterSample) {
      try {
        const candidate = await getJson(api + 'chapters/' + encodeURIComponent(chapter.id) + '/manifest');
        if (Array.isArray(candidate?.pages) && candidate.pages.some((page) => page?.url)) {
          manifest = candidate; break;
        }
      } catch (error) { manifestError = error; }
    }
    if (!manifest) throw new Error(manifestError?.message || 'Chapters load, but sampled reader manifests returned no pages.');

    return {
      catalogCount: series.length,
      chapterCount: chapters.length,
      pageCount: manifest.pages.length,
      sampledTitle: String(chosen.title || 'sample title'),
    };
  }

  async function resolveTarget(target) {
    const response = await fetch('/api/fabric/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: target }), cache: 'no-store', signal: AbortSignal.timeout(45_000),
    });
    const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function addReady(results) {
    let collection;
    try {
      const raw = localStorage.getItem(COLLECTION_KEY);
      collection = raw === null ? { revision: 0, sources: [], library: [], progress: {} } : JSON.parse(raw);
    } catch { throw new Error('Saved collection could not be read.'); }
    if (!collection || typeof collection !== 'object' || !Array.isArray(collection.sources)) throw new Error('Saved collection could not be read.');

    let sources = [...collection.sources];
    let changed = 0;
    const outcome = new Map(), idsSeenThisRun = new Set();
    for (const item of results) {
      const extension = item.extension;
      if (!extension?.id || !extension?.name) { outcome.set(item.target, 'failed'); continue; }
      const id = 'yomuext-' + extension.id;
      if (idsSeenThisRun.has(id)) { outcome.set(item.target, 'already'); continue; }
      idsSeenThisRun.add(id);
      const api = apiFor(extension);
      const existing = sources.find((s) => String(s.id) === id);
      if (existing && existing.enabled !== false && existing.url === api) { outcome.set(item.target, 'already'); continue; }
      const source = {
        ...existing, id, label: extension.name,
        category: extension.runtime ? 'Source Fabric' : 'Yomu Extensions',
        kind: 'api', url: api, enabled: true,
        ...(extension.runtime ? { runtime: extension.runtime } : {}),
        ...(extension.engine ? { engine: extension.engine } : {}),
      };
      sources = [...sources.filter((s) => String(s.id) !== id), source];
      changed += 1; outcome.set(item.target, 'added');
    }
    if (changed) {
      const next = { ...collection, revision: (Number.isInteger(collection.revision) ? collection.revision : 0) + 1, sources };
      const serialized = JSON.stringify(next);
      localStorage.setItem(COLLECTION_KEY, serialized);
      try { window.dispatchEvent(new StorageEvent('storage', { key: COLLECTION_KEY, newValue: serialized, oldValue: null, storageArea: localStorage, url: location.href })); } catch {}
    }
    return { changed, outcome };
  }

  function makeCss() {
    const style = document.createElement('style');
    style.textContent = `
      #${ROOT_ID} .sf-mode-switch{display:inline-grid;grid-template-columns:1fr 1fr;gap:3px;margin-top:14px;padding:3px;border:1px solid var(--line,#263747);border-radius:999px;background:color-mix(in srgb,var(--bg,#09111a) 72%,transparent)}
      #${ROOT_ID} .sf-mode-switch button{height:36px;padding:0 15px;border-radius:999px;border:0;background:transparent;color:var(--muted,#91a8bb);font-size:12px;font-weight:800;box-shadow:none}
      #${ROOT_ID} .sf-mode-switch button.is-active{background:color-mix(in srgb,var(--accent,#ffc15a) 16%,var(--surface,#111b25));color:var(--text,#f7f8fa);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent,#ffc15a) 42%,transparent)}
      #${PACK_ID}{display:none;margin-top:12px}#${PACK_ID}.is-active{display:block}
      #${PACK_ID} textarea{width:100%;min-height:128px;padding:12px 13px;border-radius:13px;border:1px solid var(--line,#263747);background:var(--bg,#09111a);color:var(--text,#f7f8fa);font:500 13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;outline:none}
      #${PACK_ID} textarea:focus{border-color:color-mix(in srgb,var(--accent,#ffc15a) 70%,var(--line,#263747));box-shadow:0 0 0 3px color-mix(in srgb,var(--accent,#ffc15a) 12%,transparent)}
      #${PACK_ID} .sp-meta{display:flex;justify-content:space-between;gap:12px;align-items:center;margin:0 0 8px;color:var(--dim,#8297aa);font-size:10.5px}#${PACK_ID} .sp-meta b{color:var(--muted,#91a8bb);font-size:11px}
      #${PACK_ID} .sp-actions{display:flex;align-items:center;gap:9px;margin-top:10px;flex-wrap:wrap}#${PACK_ID} .sp-run{height:44px;background:var(--accent,#ffc15a);color:var(--accentText,#0c131b)}#${PACK_ID} .sp-clear{height:44px;background:transparent;color:var(--muted,#91a8bb);border:1px solid var(--line,#263747)}
      #${PACK_ID} .sp-summary{font-size:11.5px;color:var(--muted,#91a8bb);margin-left:auto}#${PACK_ID} .sp-progress{height:4px;border-radius:999px;background:color-mix(in srgb,var(--line,#263747) 75%,transparent);overflow:hidden;margin-top:11px;display:none}#${PACK_ID} .sp-progress.show{display:block}#${PACK_ID} .sp-progress>i{display:block;height:100%;width:0;background:var(--accent,#ffc15a);transition:width .18s ease}
      #${PACK_ID} .sp-results{display:grid;gap:7px;margin-top:12px}#${PACK_ID} .sp-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;border:1px solid var(--hairline,var(--line,#263747));border-radius:12px;padding:9px 10px;background:color-mix(in srgb,var(--bg,#09111a) 55%,transparent)}
      #${PACK_ID} .sp-site{min-width:0}#${PACK_ID} .sp-site b{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#${PACK_ID} .sp-site small{display:block;margin-top:2px;font-size:10.5px;color:var(--dim,#8297aa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#${PACK_ID} .sp-state{font-size:10.5px;font-weight:800;border-radius:999px;padding:5px 8px;border:1px solid var(--line,#263747);white-space:nowrap;color:var(--dim,#8297aa)}
      #${PACK_ID} .sp-row[data-state="working"] .sp-state{color:var(--accent,#ffc15a)}#${PACK_ID} .sp-row[data-state="added"] .sp-state,#${PACK_ID} .sp-row[data-state="ready"] .sp-state{color:#91e4ad;border-color:rgba(120,220,160,.35)}#${PACK_ID} .sp-row[data-state="already"] .sp-state{color:#9ec7ff}#${PACK_ID} .sp-row[data-state="browser"] .sp-state{color:#ffc86e}#${PACK_ID} .sp-row[data-state="failed"] .sp-state,#${PACK_ID} .sp-row[data-state="blocked"] .sp-state{color:#ff8a81;border-color:rgba(255,120,110,.3)}
      @media(max-width:700px){#${ROOT_ID} .sf-mode-switch{display:grid;width:100%}#${PACK_ID} .sp-actions{align-items:stretch}#${PACK_ID} .sp-run{flex:1}#${PACK_ID} .sp-summary{width:100%;margin-left:0}}
    `;
    document.head.append(style);
  }

  function mount() {
    const root = document.getElementById(ROOT_ID);
    if (!root || document.getElementById(PACK_ID)) return !!root;
    makeCss();
    const headerCopy = root.querySelector('.sf-copy'), title = root.querySelector('h2'), singleForm = root.querySelector('.sf-form');
    const pipeline = root.querySelector('.sf-pipe'), singleStatus = root.querySelector('.sf-status'), singleResult = root.querySelector('.sf-result'), details = root.querySelector('details');
    if (!singleForm || !title || !headerCopy) return false;
    const singleTitle = title.textContent, singleCopy = headerCopy.textContent;

    const switcher = document.createElement('div');
    switcher.className = 'sf-mode-switch'; switcher.setAttribute('role', 'tablist');
    switcher.innerHTML = '<button type="button" class="is-active" data-mode="single" role="tab" aria-selected="true">Single source</button><button type="button" data-mode="pack" role="tab" aria-selected="false">Source pack</button>';
    singleForm.insertAdjacentElement('beforebegin', switcher);

    const pack = document.createElement('div');
    pack.id = PACK_ID;
    pack.innerHTML = `<div class="sp-meta"><b>Paste one site per line</b><span>Up to ${MAX_URLS} sites · ${CONCURRENCY} tests at once · full reader check</span></div><textarea aria-label="Reading-site URLs" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="https://site-one.example\nhttps://site-two.example"></textarea><div class="sp-actions"><button class="sp-run" type="button">Test & add source pack</button><button class="sp-clear" type="button">Clear</button><span class="sp-summary">Ready for a source pack.</span></div><div class="sp-progress"><i></i></div><div class="sp-results"></div>`;
    singleForm.insertAdjacentElement('afterend', pack);

    const textarea = pack.querySelector('textarea'), runButton = pack.querySelector('.sp-run'), clearButton = pack.querySelector('.sp-clear'), summary = pack.querySelector('.sp-summary'), progress = pack.querySelector('.sp-progress'), progressBar = progress.querySelector('i'), resultsBox = pack.querySelector('.sp-results');
    const rows = new Map();

    function setMode(mode) {
      const bulk = mode === 'pack';
      for (const button of switcher.querySelectorAll('button')) { const active = button.dataset.mode === mode; button.classList.toggle('is-active', active); button.setAttribute('aria-selected', active ? 'true' : 'false'); }
      singleForm.style.display = bulk ? 'none' : ''; if (pipeline) pipeline.style.display = bulk ? 'none' : ''; if (singleStatus) singleStatus.style.display = bulk ? 'none' : ''; if (singleResult) singleResult.style.display = bulk ? 'none' : ''; if (details) details.style.display = bulk ? 'none' : '';
      pack.classList.toggle('is-active', bulk); title.textContent = bulk ? 'Expand Yomu in one pass' : singleTitle;
      headerCopy.textContent = bulk ? 'Paste multiple reading sites. Yomu retries transient failures, repairs stale matches, and only enables a source after catalog → chapters → real reader pages all pass.' : singleCopy;
      if (bulk) setTimeout(() => textarea.focus(), 0);
    }
    switcher.addEventListener('click', (event) => { const button = event.target.closest('button[data-mode]'); if (button && !runButton.disabled) setMode(button.dataset.mode); });

    function setRow(target, state, label, detail) {
      let row = rows.get(target);
      if (!row) { row = document.createElement('div'); row.className = 'sp-row'; row.innerHTML = '<div class="sp-site"><b></b><small></small></div><span class="sp-state"></span>'; rows.set(target, row); resultsBox.append(row); }
      row.dataset.state = state; let host = target; try { host = new URL(target).hostname.replace(/^www\./, ''); } catch {}
      row.querySelector('b').textContent = host; row.querySelector('small').textContent = detail || target; row.querySelector('.sp-state').textContent = label;
    }

    clearButton.addEventListener('click', () => { if (runButton.disabled) return; textarea.value = ''; resultsBox.innerHTML = ''; rows.clear(); summary.textContent = 'Ready for a source pack.'; progress.classList.remove('show'); progressBar.style.width = '0%'; });

    runButton.addEventListener('click', async () => {
      const parsed = parsePack(textarea.value);
      if (!parsed.urls.length) { summary.textContent = parsed.invalid.length ? 'No valid public website URLs found.' : 'Paste some reading-site URLs first.'; return; }
      runButton.disabled = clearButton.disabled = textarea.disabled = true; resultsBox.innerHTML = ''; rows.clear(); progress.classList.add('show'); progressBar.style.width = '0%';
      for (const bad of parsed.invalid) setRow(bad.value, 'failed', 'Invalid', bad.message); for (const target of parsed.urls) setRow(target, 'working', 'Queued', target);

      let registry;
      try { registry = await getJson('/api/ext/sources'); }
      catch (error) { for (const target of parsed.urls) setRow(target, 'failed', 'Failed', error?.message || 'Registry unavailable.'); summary.textContent = 'Source registry could not be loaded.'; runButton.disabled = clearButton.disabled = textarea.disabled = false; return; }

      let cursor = 0, completed = 0;
      const ready = [], counters = { healthy: 0, browser: 0, skipped: parsed.invalid.length, repaired: 0 };
      const refreshSummary = () => { summary.textContent = `${completed}/${parsed.urls.length} tested · ${counters.healthy} reader-ready · ${counters.repaired} repaired · ${counters.browser} browser-required · ${counters.skipped} skipped`; progressBar.style.width = `${Math.round((completed / parsed.urls.length) * 100)}%`; };

      async function testOne(target) {
        setRow(target, 'working', 'Finding', 'Matching maintained recipes and adaptive Source Fabric…');
        try {
          let extension = hostMatch(target, registry.extensions || []), check = null, firstError = null;
          if (extension) {
            try { setRow(target, 'working', 'Gauntlet', `${extension.name} · catalog → chapters → pages`); check = await verify(extension); }
            catch (error) { firstError = error; extension = null; setRow(target, 'working', 'Repairing', `Maintained match failed (${error?.message || 'unknown'}). Trying adaptive repair…`); }
          }

          if (!extension) {
            const resolution = await resolveTarget(target);
            if (!resolution.ready || !resolution.adapter) {
              const message = String(resolution.message || firstError?.message || 'Yomu could not prove a complete reader path.');
              const browser = /browser|challenge|interactive|cloudflare|captcha/i.test(message);
              if (browser) { counters.browser += 1; setRow(target, 'browser', 'Browser', message); }
              else { counters.skipped += 1; setRow(target, 'blocked', 'Skipped', message); }
              return;
            }
            extension = resolution.adapter;
            if (!adultAllowed() && isAdult(extension)) { counters.skipped += 1; setRow(target, 'blocked', '18+ hidden', 'Hidden by your current adult-content setting.'); return; }
            setRow(target, 'working', 'Gauntlet', `${extension.name || 'Adaptive source'} · proving real reader pages…`);
            check = await verify(extension);
            if (firstError) counters.repaired += 1;
          }

          if (!adultAllowed() && isAdult(extension)) { counters.skipped += 1; setRow(target, 'blocked', '18+ hidden', 'Hidden by your current adult-content setting.'); return; }
          ready.push({ target, extension, check }); counters.healthy += 1;
          setRow(target, 'ready', 'Reader-ready', `${extension.name} · ${check.catalogCount} titles · ${check.chapterCount} chapters · ${check.pageCount} pages verified`);
        } catch (error) {
          const message = String(error?.message || 'Reader gauntlet failed.');
          if (/browser|challenge|cloudflare|captcha|interactive/i.test(message)) { counters.browser += 1; setRow(target, 'browser', 'Browser', message); }
          else { counters.skipped += 1; setRow(target, 'failed', 'Failed', message); }
        } finally { completed += 1; refreshSummary(); }
      }

      async function worker() { while (true) { const index = cursor++; if (index >= parsed.urls.length) return; await testOne(parsed.urls[index]); } }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parsed.urls.length) }, () => worker()));

      let added = { changed: 0, outcome: new Map() };
      try {
        added = addReady(ready);
        for (const item of ready) {
          const state = added.outcome.get(item.target) || 'failed';
          const detail = `${item.extension.name} · full reader path verified`;
          if (state === 'added') setRow(item.target, 'added', 'Added', detail);
          else if (state === 'already') setRow(item.target, 'already', 'Already on', detail);
          else setRow(item.target, 'failed', 'Failed', 'Could not save this source.');
        }
      } catch (error) { summary.textContent = error?.message || 'Could not save the healthy sources.'; }
      const already = ready.length - added.changed;
      summary.textContent = `${added.changed} added · ${already} already enabled · ${counters.repaired} repaired · ${counters.browser} browser-required · ${counters.skipped} skipped` + (parsed.truncated ? ` · max ${MAX_URLS} processed` : '');
      progressBar.style.width = '100%'; runButton.disabled = clearButton.disabled = textarea.disabled = false;
    });
    return true;
  }

  if (mount()) return;
  const observer = new MutationObserver(() => { if (mount()) observer.disconnect(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 12000);
})();