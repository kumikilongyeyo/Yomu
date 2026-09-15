(() => {
  'use strict';
  if (!location.pathname.startsWith('/sources')) return;

  const ID = 'yomu-source-fabric-bulk';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const MAX_URLS = 25;
  const CONCURRENCY = 3;

  const css = document.createElement('style');
  css.textContent = `
    #${ID}{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;margin:0 0 22px;padding:18px;border:1px solid var(--line,#263747);border-radius:20px;background:var(--surface,#111b25);color:var(--text,#f7f8fa)}
    #${ID} *{box-sizing:border-box}
    #${ID} .sp-head{display:flex;gap:14px;align-items:flex-start;justify-content:space-between}
    #${ID} .sp-kicker{font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim,#8297aa);margin-bottom:5px}
    #${ID} h3{font-size:20px;line-height:1.08;letter-spacing:-.02em;margin:0}
    #${ID} .sp-copy{font-size:12.5px;line-height:1.45;color:var(--muted,#91a8bb);margin:5px 0 0;max-width:700px}
    #${ID} .sp-badge{flex:none;border:1px solid var(--line,#263747);border-radius:999px;padding:6px 9px;font-size:10.5px;color:var(--dim,#8297aa);white-space:nowrap}
    #${ID} textarea{width:100%;min-height:118px;margin-top:13px;padding:12px 13px;border-radius:13px;border:1px solid var(--line,#263747);background:var(--bg,#09111a);color:var(--text,#f7f8fa);font:500 13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;outline:none}
    #${ID} textarea:focus{border-color:color-mix(in srgb,var(--accent,#ffc15a) 70%,var(--line,#263747));box-shadow:0 0 0 3px color-mix(in srgb,var(--accent,#ffc15a) 12%,transparent)}
    #${ID} .sp-actions{display:flex;align-items:center;gap:9px;margin-top:10px;flex-wrap:wrap}
    #${ID} button{height:42px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;padding:0 16px;font:inherit;font-size:12px;font-weight:800;cursor:pointer}
    #${ID} .sp-run{border:0;background:var(--accent,#ffc15a);color:var(--accentText,#0c131b)}
    #${ID} .sp-clear{border:1px solid var(--line,#263747);background:transparent;color:var(--muted,#91a8bb)}
    #${ID} button:disabled{opacity:.52;cursor:wait}
    #${ID} .sp-summary{font-size:11.5px;color:var(--muted,#91a8bb);margin-left:auto}
    #${ID} .sp-progress{height:4px;border-radius:999px;background:color-mix(in srgb,var(--line,#263747) 75%,transparent);overflow:hidden;margin-top:11px;display:none}
    #${ID} .sp-progress.show{display:block}#${ID} .sp-progress>i{display:block;height:100%;width:0;background:var(--accent,#ffc15a);transition:width .18s ease}
    #${ID} .sp-results{display:grid;gap:7px;margin-top:12px}
    #${ID} .sp-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;border:1px solid var(--hairline,var(--line,#263747));border-radius:12px;padding:9px 10px;background:color-mix(in srgb,var(--bg,#09111a) 55%,transparent)}
    #${ID} .sp-site{min-width:0}#${ID} .sp-site b{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#${ID} .sp-site small{display:block;margin-top:2px;font-size:10.5px;color:var(--dim,#8297aa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #${ID} .sp-state{font-size:10.5px;font-weight:800;border-radius:999px;padding:5px 8px;border:1px solid var(--line,#263747);white-space:nowrap;color:var(--dim,#8297aa)}
    #${ID} .sp-row[data-state="working"] .sp-state{color:var(--accent,#ffc15a)}
    #${ID} .sp-row[data-state="added"] .sp-state,#${ID} .sp-row[data-state="ready"] .sp-state{color:#91e4ad;border-color:rgba(120,220,160,.35)}
    #${ID} .sp-row[data-state="already"] .sp-state{color:#9ec7ff}
    #${ID} .sp-row[data-state="browser"] .sp-state{color:#ffc86e}
    #${ID} .sp-row[data-state="failed"] .sp-state,#${ID} .sp-row[data-state="blocked"] .sp-state{color:#ff8a81;border-color:rgba(255,120,110,.3)}
    @media(max-width:700px){#${ID}{padding:15px;border-radius:17px}#${ID} .sp-head{display:block}#${ID} .sp-badge{display:inline-flex;margin-top:8px}#${ID} .sp-actions{align-items:stretch}#${ID} .sp-run{flex:1}#${ID} .sp-summary{width:100%;margin-left:0}}
  `;
  document.head.append(css);

  const adultAllowed = () => {
    try { return localStorage.getItem('yomu.v1.adult') === 'on'; } catch { return false; }
  };

  function isAdult(extension) {
    return !!extension?.nsfw || (extension?.content || []).some((x) => String(x).toLowerCase() === 'adult');
  }

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
    const out = [];
    const seen = new Set();
    const invalid = [];
    for (const value of values) {
      try {
        const url = cleanUrl(value);
        const key = new URL(url).origin.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(url);
      } catch (error) {
        invalid.push({ value, message: error?.message || 'Invalid URL.' });
      }
      if (out.length >= MAX_URLS) break;
    }
    return { urls: out, invalid, truncated: values.length > out.length + invalid.length || out.length >= MAX_URLS };
  }

  function hostMatch(input, extensions) {
    const host = new URL(input).hostname.toLowerCase().replace(/^www\./, '');
    const allowed = (extensions || []).filter((e) => (adultAllowed() || !isAdult(e)) && (e.hosts || []).some((h) => {
      const wildcard = h.startsWith('*.');
      const d = h.replace(/^\*\./, '').replace(/^www\./, '').toLowerCase();
      return host === d || (wildcard && host.endsWith('.' + d));
    }));
    if (allowed.length <= 1) return allowed[0] || null;
    return allowed.find((e) => String(e.runtime || '').startsWith('fabric-')) || allowed[0];
  }

  function apiFor(extension) {
    let api = String(extension?.api || '').trim();
    if (!api) api = location.origin + '/api/ext/source/' + encodeURIComponent(extension.id) + '/';
    else if (api.startsWith('/')) api = location.origin + api;
    if (!api.endsWith('/')) api += '/';
    return api;
  }

  async function verify(extension) {
    const response = await fetch(apiFor(extension) + 'series', {
      cache: 'no-store',
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error(`Reader check returned HTTP ${response.status}.`);
    const body = await response.json().catch(() => null);
    if (!body || !Array.isArray(body.series)) throw new Error('Source did not return a valid title list.');
    return body.series.length;
  }

  function batchAdd(results) {
    let col;
    try {
      const raw = localStorage.getItem(COLLECTION_KEY);
      col = raw === null ? { revision: 0, sources: [], library: [], progress: {} } : JSON.parse(raw);
    } catch {
      throw new Error('Saved collection could not be read.');
    }
    if (!col || typeof col !== 'object' || !Array.isArray(col.sources)) throw new Error('Saved collection could not be read.');

    let sources = [...col.sources];
    let changed = 0;
    const outcome = new Map();
    const seenIds = new Set();

    for (const result of results) {
      const extension = result.extension;
      if (!extension?.id || !extension?.name) {
        outcome.set(result.target, 'failed');
        continue;
      }
      const id = 'yomuext-' + extension.id;
      if (seenIds.has(id)) {
        outcome.set(result.target, 'already');
        continue;
      }
      seenIds.add(id);

      const api = apiFor(extension);
      const existing = sources.find((s) => s.id === id);
      if (existing && existing.enabled !== false && existing.url === api) {
        outcome.set(result.target, 'already');
        continue;
      }

      const source = {
        ...existing,
        id,
        label: extension.name,
        category: extension.runtime ? 'Source Fabric' : 'Yomu Extensions',
        kind: 'api',
        url: api,
        enabled: true,
        ...(extension.runtime ? { runtime: extension.runtime } : {}),
        ...(extension.engine ? { engine: extension.engine } : {}),
      };
      sources = [...sources.filter((s) => s.id !== id), source];
      changed += 1;
      outcome.set(result.target, 'added');
    }

    if (changed) {
      localStorage.setItem(COLLECTION_KEY, JSON.stringify({
        ...col,
        revision: (Number.isInteger(col.revision) ? col.revision : 0) + 1,
        sources,
      }));
    }
    return { changed, outcome };
  }

  function createPanel() {
    const section = document.createElement('section');
    section.id = ID;
    section.innerHTML = `
      <div class="sp-head">
        <div><div class="sp-kicker">Source Pack</div><h3>Expand Yomu in one pass</h3><p class="sp-copy">Paste one reading-site URL per line. Yomu finds the maintained implementation, runs the reader test, keeps only healthy sources, skips duplicates, and respects your 18+ setting.</p></div>
        <span class="sp-badge">Up to ${MAX_URLS} sites · ${CONCURRENCY} tests at once</span>
      </div>
      <textarea aria-label="Reading-site URLs" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="https://site-one.example\nhttps://site-two.example\nhttps://site-three.example"></textarea>
      <div class="sp-actions"><button class="sp-run" type="button">Test & add source pack</button><button class="sp-clear" type="button">Clear</button><span class="sp-summary">Ready for a source pack.</span></div>
      <div class="sp-progress"><i></i></div>
      <div class="sp-results"></div>`;
    return section;
  }

  function mount() {
    if (document.getElementById(ID)) return true;
    const anchor = document.getElementById('yomu-source-fabric-command');
    if (!anchor?.parentElement) return false;

    const panel = createPanel();
    anchor.insertAdjacentElement('afterend', panel);
    const textarea = panel.querySelector('textarea');
    const runButton = panel.querySelector('.sp-run');
    const clearButton = panel.querySelector('.sp-clear');
    const summary = panel.querySelector('.sp-summary');
    const progress = panel.querySelector('.sp-progress');
    const progressBar = progress.querySelector('i');
    const resultsBox = panel.querySelector('.sp-results');

    const rows = new Map();
    const rowFor = (target) => rows.get(target);
    const setRow = (target, state, label, detail) => {
      let row = rowFor(target);
      if (!row) {
        row = document.createElement('div');
        row.className = 'sp-row';
        row.innerHTML = '<div class="sp-site"><b></b><small></small></div><span class="sp-state"></span>';
        rows.set(target, row);
        resultsBox.append(row);
      }
      row.dataset.state = state;
      let host = target;
      try { host = new URL(target).hostname.replace(/^www\./, ''); } catch {}
      row.querySelector('b').textContent = host;
      row.querySelector('small').textContent = detail || target;
      row.querySelector('.sp-state').textContent = label;
    };

    clearButton.addEventListener('click', () => {
      if (runButton.disabled) return;
      textarea.value = '';
      resultsBox.innerHTML = '';
      rows.clear();
      summary.textContent = 'Ready for a source pack.';
      progress.classList.remove('show');
      progressBar.style.width = '0%';
    });

    runButton.addEventListener('click', async () => {
      const parsed = parsePack(textarea.value);
      if (!parsed.urls.length) {
        summary.textContent = parsed.invalid.length ? 'No valid public website URLs found.' : 'Paste some reading-site URLs first.';
        return;
      }

      runButton.disabled = true;
      clearButton.disabled = true;
      textarea.disabled = true;
      resultsBox.innerHTML = '';
      rows.clear();
      progress.classList.add('show');
      progressBar.style.width = '0%';

      for (const bad of parsed.invalid) setRow(bad.value, 'failed', 'Invalid', bad.message);
      for (const target of parsed.urls) setRow(target, 'working', 'Queued', target);

      let registry;
      try {
        const response = await fetch('/api/ext/sources', { cache: 'no-store', signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error('Could not load Yomu source registry.');
        registry = await response.json();
      } catch (error) {
        for (const target of parsed.urls) setRow(target, 'failed', 'Failed', error?.message || 'Registry unavailable.');
        summary.textContent = 'Source registry could not be loaded.';
        runButton.disabled = false; clearButton.disabled = false; textarea.disabled = false;
        return;
      }

      let cursor = 0;
      let completed = 0;
      const ready = [];
      const counters = { ready: 0, failed: parsed.invalid.length, browser: 0, blocked: 0 };

      const updateSummary = () => {
        summary.textContent = `${completed}/${parsed.urls.length} tested · ${counters.ready} healthy · ${counters.browser} browser-required · ${counters.failed + counters.blocked} skipped`;
        progressBar.style.width = `${Math.round((completed / parsed.urls.length) * 100)}%`;
      };

      async function testOne(target) {
        setRow(target, 'working', 'Finding', 'Looking for a maintained implementation…');
        try {
          let extension = hostMatch(target, registry.extensions || []);
          let resolution = null;

          if (!extension) {
            const response = await fetch('/api/fabric/resolve', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ url: target }),
              cache: 'no-store',
              signal: AbortSignal.timeout(45000),
            });
            resolution = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
            if (!response.ok) throw new Error(resolution.error || `Resolver returned HTTP ${response.status}.`);
            if (!resolution.ready || !resolution.adapter) {
              const message = resolution.message || 'Yomu could not prove a complete reader path.';
              const browser = /browser|interactive|challenge|verification/i.test(message);
              counters[browser ? 'browser' : 'failed'] += 1;
              setRow(target, browser ? 'browser' : 'failed', browser ? 'Browser' : 'Skipped', message);
              return;
            }
            extension = resolution.adapter;
          }

          if (!adultAllowed() && isAdult(extension)) {
            counters.blocked += 1;
            setRow(target, 'blocked', '18+ blocked', 'Enable 18+ in Yomu first if you want this source.');
            return;
          }

          setRow(target, 'working', 'Testing', `${extension.name} · checking browse endpoint…`);
          const count = await verify(extension);
          counters.ready += 1;
          ready.push({ target, extension, count });
          setRow(target, 'ready', 'Healthy', `${extension.name} · ${count} sample titles returned`);
        } catch (error) {
          counters.failed += 1;
          setRow(target, 'failed', 'Failed', error?.message || 'Source test failed.');
        } finally {
          completed += 1;
          updateSummary();
        }
      }

      async function worker() {
        while (cursor < parsed.urls.length) {
          const index = cursor++;
          await testOne(parsed.urls[index]);
        }
      }

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parsed.urls.length) }, () => worker()));

      try {
        const added = batchAdd(ready);
        let already = 0;
        for (const result of ready) {
          const state = added.outcome.get(result.target) || 'failed';
          if (state === 'added') {
            setRow(result.target, 'added', 'Added', `${result.extension.name} · enabled in Yomu`);
          } else if (state === 'already') {
            already += 1;
            setRow(result.target, 'already', 'Already on', `${result.extension.name} · already enabled`);
          } else {
            setRow(result.target, 'failed', 'Failed', 'Could not save this source.');
          }
        }
        const suffix = parsed.truncated ? ` · first ${MAX_URLS} unique sites only` : '';
        summary.textContent = `${added.changed} added · ${already} already enabled · ${counters.browser} browser-required · ${counters.failed + counters.blocked} skipped${suffix}`;
      } catch (error) {
        summary.textContent = error?.message || 'Healthy sources were found but could not be saved.';
      } finally {
        progressBar.style.width = '100%';
        runButton.disabled = false;
        clearButton.disabled = false;
        textarea.disabled = false;
      }
    });

    return true;
  }

  if (!mount()) {
    const observer = new MutationObserver(() => {
      if (mount()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }
})();
