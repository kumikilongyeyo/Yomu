(() => {
  'use strict';
  if (!/^\/sources(?:\.html)?\/?$/.test(location.pathname)) return;

  const PANEL_ID = 'yomu-source-fabric-command';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const REPOSITORIES_KEY = 'yomu.v8.repositories';
  const UPDATES_KEY = 'yomu.v8.repository-updates';

  const css = document.createElement('style');
  css.textContent = `
    #${PANEL_ID}{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;position:relative;z-index:4;margin:0 0 18px;padding:18px;border:1px solid var(--line,#263747);border-radius:20px;background:linear-gradient(180deg,color-mix(in srgb,var(--surface,#111b25) 96%,var(--accent,#ffc15a) 4%),var(--surface,#111b25));box-shadow:0 18px 55px rgba(0,0,0,.12);color:var(--text,#f7f8fa)}
    #${PANEL_ID} *{box-sizing:border-box}
    #${PANEL_ID} .sf-kicker{font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim,#8297aa);margin-bottom:5px}
    #${PANEL_ID} h2{font-size:22px;line-height:1.08;letter-spacing:-.025em;margin:0}
    #${PANEL_ID} .sf-copy{font-size:12.5px;line-height:1.45;color:var(--muted,#91a8bb);margin:5px 0 0;max-width:720px}
    #${PANEL_ID} .sf-form{display:flex;gap:9px;margin-top:14px;align-items:flex-end}
    #${PANEL_ID} .sf-field{display:flex;flex:1;min-width:0;flex-direction:column;gap:6px}
    #${PANEL_ID} label{font-size:11px;font-weight:750;color:var(--muted,#91a8bb)}
    #${PANEL_ID} input{width:100%;min-width:0;height:48px;padding:0 14px;border-radius:13px;border:1px solid var(--line,#263747);background:var(--bg,#09111a);color:var(--text,#f7f8fa);font:inherit;font-size:15px;outline:none}
    #${PANEL_ID} input:focus{border-color:color-mix(in srgb,var(--accent,#ffc15a) 70%,var(--line,#263747));box-shadow:0 0 0 3px color-mix(in srgb,var(--accent,#ffc15a) 12%,transparent)}
    #${PANEL_ID} button,#${PANEL_ID} .sf-action{height:48px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:999px;padding:0 22px;background:var(--accent,#ffc15a);color:var(--accentText,#0c131b);font:inherit;font-weight:800;cursor:pointer;white-space:nowrap;text-decoration:none}
    #${PANEL_ID} button:disabled{opacity:.55;cursor:wait}
    #${PANEL_ID} .sf-action.secondary{background:var(--surface2,var(--surface,#111b25));color:var(--text,#f7f8fa);border:1px solid var(--line,#263747)}
    #${PANEL_ID} .sf-status{min-height:20px;margin-top:10px;font-size:12px;line-height:1.45;color:var(--muted,#91a8bb)}
    #${PANEL_ID} .sf-spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.18);border-top-color:var(--accent,#ffc15a);border-radius:50%;animation:sfspin .7s linear infinite;margin-right:7px;vertical-align:-2px}@keyframes sfspin{to{transform:rotate(360deg)}}
    #${PANEL_ID} .sf-ok{color:#91e4ad}#${PANEL_ID} .sf-bad{color:#ff8a81}#${PANEL_ID} .sf-warn{color:#f4c66d}
    #${PANEL_ID} .sf-result{display:none;margin-top:11px;padding:11px 12px;border:1px solid var(--hairline,var(--line,#263747));border-radius:13px;background:color-mix(in srgb,var(--bg,#09111a) 62%,transparent)}#${PANEL_ID} .sf-result.show{display:block}
    #${PANEL_ID} .sf-result strong{font-size:14px}#${PANEL_ID} .sf-result p{margin:3px 0 0;color:var(--muted,#91a8bb);font-size:12px;line-height:1.4}
    #${PANEL_ID} .sf-chip{display:inline-flex;border:1px solid var(--line,#263747);border-radius:999px;padding:4px 8px;font-size:10px;color:var(--dim,#8297aa);margin:7px 5px 0 0}
    #${PANEL_ID} .sf-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
    #${PANEL_ID} .sf-actions button,#${PANEL_ID} .sf-actions .sf-action{height:40px;padding:0 15px;font-size:12px}
    #${PANEL_ID} details{margin-top:10px;font-size:11px;color:var(--dim,#8297aa)}#${PANEL_ID} summary{cursor:pointer;color:var(--muted,#91a8bb);font-weight:700}
    #${PANEL_ID} .sf-advanced{padding-top:7px;line-height:1.5;white-space:pre-wrap}
    @media(max-width:700px){#${PANEL_ID}{padding:15px;border-radius:17px}#${PANEL_ID} .sf-form{flex-direction:column;align-items:stretch}#${PANEL_ID} button{width:100%}#${PANEL_ID} .sf-actions{flex-direction:column}#${PANEL_ID} .sf-actions button,#${PANEL_ID} .sf-actions .sf-action{width:100%}}
  `;
  document.head.append(css);

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));
  const readJson = (key, fallback) => { try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value ?? fallback; } catch { return fallback; } };
  const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const adultAllowed = () => { try { return localStorage.getItem('yomu.v1.adult') === 'on'; } catch { return false; } };

  function normalizeInput(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('Paste a website URL or GitHub repository.');
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Use a normal public http/https URL.');
    url.hash = '';
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean);
    if (host === 'github.com') {
      if (parts.length < 2) throw new Error('Paste a GitHub repository URL, for example github.com/owner/repository.');
      return { kind: 'repository', value: url.toString() };
    }
    return { kind: 'website', value: url.toString() };
  }

  async function jsonRequest(path, options = {}, timeout = 60000) {
    const response = await fetch(path, { cache:'no-store', ...options, signal:AbortSignal.timeout(timeout) });
    const body = await response.json().catch(() => ({ error:`HTTP ${response.status}` }));
    if (!response.ok && !body?.state) throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
    return body;
  }

  function collectionAdd(extension) {
    const raw = localStorage.getItem(COLLECTION_KEY);
    const col = raw === null ? { revision:0, sources:[], library:[], progress:{} } : JSON.parse(raw);
    if (!col || typeof col !== 'object' || !Array.isArray(col.sources)) throw new Error('Saved collection could not be read.');
    const id = 'yomuext-' + extension.id;
    const existing = col.sources.find((s) => s.id === id);
    let api = String(extension.api || '').trim();
    if (!api) api = location.origin + '/api/ext/source/' + encodeURIComponent(extension.id) + '/';
    else if (api.startsWith('/')) api = location.origin + api;
    if (!api.endsWith('/')) api += '/';
    if (existing && existing.enabled !== false && existing.url === api) return false;
    const source = { ...existing, id, label:extension.name, category:extension.runtime ? 'Source Fabric' : 'Yomu Extensions', kind:'api', url:api, enabled:true, ...(extension.runtime ? {runtime:extension.runtime}:{}), ...(extension.engine ? {engine:extension.engine}:{}) };
    localStorage.setItem(COLLECTION_KEY, JSON.stringify({ ...col, revision:(Number.isInteger(col.revision)?col.revision:0)+1, sources:[...col.sources.filter((s)=>s.id!==id),source] }));
    return true;
  }

  function hostMatch(input, extensions) {
    const host = new URL(input).hostname.toLowerCase().replace(/^www\./,'');
    const allowed = extensions.filter((e) => (adultAllowed() || (!e.nsfw && !(e.content||[]).includes('adult'))) && (e.hosts||[]).some((h) => {
      const wildcard = h.startsWith('*.');
      const d = h.replace(/^\*\./,'').replace(/^www\./,'').toLowerCase();
      return host === d || (wildcard && host.endsWith('.'+d));
    }));
    if (allowed.length <= 1) return allowed[0] || null;
    return allowed.find((e) => String(e.runtime||'').startsWith('fabric-')) || allowed[0];
  }

  async function verify(extension) {
    let api = String(extension.api || '').trim();
    if (!api) api = location.origin + '/api/ext/source/' + encodeURIComponent(extension.id) + '/';
    else if (api.startsWith('/')) api = location.origin + api;
    if (!api.endsWith('/')) api += '/';
    const response = await fetch(api + 'series', { cache:'no-store', signal:AbortSignal.timeout(45000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `Reader check returned HTTP ${response.status}.`);
      error.verificationRequired = !!body.verificationRequired;
      throw error;
    }
    if (!Array.isArray(body.series)) throw new Error('The source did not return a valid title list.');
    return body.series.length;
  }

  function recordRepository(repository) {
    const repositories = readJson(REPOSITORIES_KEY, []);
    const index = repositories.findIndex((row) => row.repositoryUrl === repository.repositoryUrl || row.id === repository.id);
    const now = new Date().toISOString();
    let record;
    if (index >= 0) {
      record = { ...repositories[index], ...repository, lastChecked:now, lastError:'' };
      repositories[index] = record;
    } else {
      record = { ...repository, autoUpdate:repository.trust !== 'custom-unverified', paused:false, updateState:'current', lastChecked:now, lastKnownGood:null, lastError:'' };
      repositories.push(record);
    }
    writeJson(REPOSITORIES_KEY, repositories);
    const updates = readJson(UPDATES_KEY, []);
    updates.unshift({ id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`, repositoryId:record.id, repositoryName:record.name, type:index >= 0 ? 'refreshed' : 'added', message:index >= 0 ? 'Repository registration refreshed.' : 'Repository registered. Sources are discoverable and can be enabled from Yomu.', at:now });
    writeJson(UPDATES_KEY, updates.slice(0,80));
    document.dispatchEvent(new CustomEvent('yomu:repositories-changed', { detail:{ repository:record } }));
    return { record, existed:index >= 0 };
  }

  async function addRepository(url, setProgress) {
    setProgress('Detecting repository format and source manifest…');
    const response = await fetch('/api/fabric/repositories/detect', {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({input:url}), cache:'no-store', signal:AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(()=>({}));
    if (!response.ok || payload.ok === false || !payload.repository) throw new Error(payload.error || `Repository check returned HTTP ${response.status}.`);
    setProgress('Repository verified. Adding it to Yomu…');
    const saved = recordRepository(payload.repository);
    return { saved, repository:payload.repository };
  }

  function isCloudBeastCandidate(resolution) {
    const family = String(resolution?.remoteRecipe?.family || resolution?.recipe?.theme || '').toLowerCase();
    return resolution?.browserRequired === true && family === 'madara';
  }

  async function startCloudVerification(url, resolution, setProgress) {
    setProgress('Starting a cloud browser session for human verification…');
    return jsonRequest('/api/source-beast/test', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({url, resolution}),
    }, 120000);
  }

  async function addWebsite(url, setProgress) {
    setProgress('Finding the best web-source engine…');
    const registryResponse = await fetch('/api/ext/sources', {cache:'no-store',signal:AbortSignal.timeout(20000)});
    if (!registryResponse.ok) throw new Error('Could not load Yomu sources.');
    const registry = await registryResponse.json();
    let extension = hostMatch(url, registry.extensions || []);
    let resolution = null;

    if (!extension) {
      setProgress('Testing this website with Source Fabric…');
      const response = await fetch('/api/fabric/resolve', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url}),cache:'no-store',signal:AbortSignal.timeout(45000)});
      resolution = await response.json().catch(()=>({error:`HTTP ${response.status}`}));
      if (!response.ok) throw new Error(resolution.error || `HTTP ${response.status}`);

      if (!resolution.ready || !resolution.adapter) {
        if (isCloudBeastCandidate(resolution)) {
          const beast = await startCloudVerification(url, resolution, setProgress);
          if (beast.state === 'ready' && beast.adapter) {
            extension = beast.adapter;
          } else if (beast.state === 'verification-required' || beast.state === 'verification-in-progress') {
            return { verification:beast, resolution, url };
          } else {
            const error = new Error(beast.message || 'Cloud Source Beast could not prove this source yet.');
            error.evidence = resolution.evidence || [];
            throw error;
          }
        } else {
          const error = new Error(resolution.message || 'Yomu could not prove a complete reader path yet.');
          error.evidence = resolution.evidence || [];
          throw error;
        }
      } else {
        extension = resolution.adapter;
      }
    }

    setProgress('Checking catalog, chapters, and reader pages…');
    const count = await verify(extension);
    setProgress('Reader path verified. Adding web source…');
    const changed = collectionAdd(extension);
    return { extension, resolution, count, changed };
  }

  function panel() {
    const el = document.createElement('section');
    el.id = PANEL_ID;
    el.dataset.addSource = 'true';
    el.innerHTML = `
      <div class="sf-kicker">Source system ready</div>
      <h2>Add source</h2>
      <p class="sf-copy">Paste a reading website or a GitHub source repository. Yomu tests the full reading path. If a supported website asks for human verification, Yomu opens a Cloudflare Browser Run session — no localhost helper.</p>
      <form class="sf-form">
        <div class="sf-field"><label for="yomu-universal-source">Website URL or GitHub repository</label><input id="yomu-universal-source" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false" placeholder="https://example.com or https://github.com/owner/repo" /></div>
        <button type="submit">Add</button>
      </form>
      <div class="sf-status">Web sources stay web sources. Browser-required sites use cloud human verification when supported.</div>
      <div class="sf-result"><strong></strong><p></p><div class="sf-tags"></div><div class="sf-actions"></div></div>
      <details><summary>Advanced details</summary><div class="sf-advanced">Website URLs use Yomu's extension/Source Fabric path. Browser-required Madara sources can hand off to Cloudflare Browser Run Live View for manual verification, then Yomu re-tests catalog → chapters → reader pages. No localhost process is used and this flow does not promote the website to a native provider. GitHub URLs use the repository detector.</div></details>`;
    return el;
  }

  function findScrollSurface() {
    const candidates = [...document.querySelectorAll('#root *')];
    let best = null;
    let score = -1;
    for (const el of candidates) {
      const style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 280 || rect.height < 250) continue;
      const text = (el.textContent || '').slice(0,500);
      const s = (/Sources/i.test(text)?4:0) + (rect.width>600?2:0) + (el.scrollHeight>el.clientHeight?1:0);
      if (s > score) { score = s; best = el; }
    }
    return best;
  }

  function mount() {
    if (document.getElementById(PANEL_ID)) return;
    const surface = findScrollSurface();
    if (!surface) return;
    const p = panel();
    const inner = [...surface.children].find((x) => x.getBoundingClientRect().width > 260) || surface;
    inner.prepend(p);

    const form = p.querySelector('.sf-form');
    const input = p.querySelector('input');
    const button = p.querySelector('button');
    const status = p.querySelector('.sf-status');
    const result = p.querySelector('.sf-result');
    const strong = result.querySelector('strong');
    const note = result.querySelector('p');
    const tags = result.querySelector('.sf-tags');
    const actions = result.querySelector('.sf-actions');
    const details = p.querySelector('.sf-advanced');
    const spinning = (text) => { status.innerHTML='<span class="sf-spin"></span>'+escapeHtml(text); };
    const setResult = (title, copy, rows=[]) => {
      strong.textContent = title;
      note.textContent = copy;
      tags.innerHTML = rows.filter(Boolean).map((x)=>`<span class="sf-chip">${escapeHtml(x)}</span>`).join('');
      actions.replaceChildren();
      result.classList.add('show');
    };
    const action = (label, handler, secondary=false) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = label;
      if (secondary) el.classList.add('secondary');
      el.addEventListener('click', handler);
      actions.appendChild(el);
      return el;
    };

    let activeVerification = null;
    let activeTarget = '';

    async function openVerification() {
      if (!activeVerification?.id) return;
      const tab = window.open(activeVerification.liveViewUrl || 'about:blank', '_blank', 'noopener,noreferrer');
      if (activeVerification.liveViewUrl) return;
      try {
        spinning('Creating a fresh cloud verification view…');
        const next = await jsonRequest(`/api/source-beast/runs/${encodeURIComponent(activeVerification.id)}/verification/open`, {method:'POST'}, 60000);
        activeVerification = {...activeVerification, ...next};
        if (next.liveViewUrl) {
          if (tab) tab.location.href = next.liveViewUrl;
          else window.open(next.liveViewUrl, '_blank', 'noopener,noreferrer');
        }
        status.innerHTML='<span class="sf-warn">Cloud verification is open.</span> Complete the website check, choose Done, then come back here.';
      } catch (error) {
        if (tab) tab.close();
        status.innerHTML='<span class="sf-bad">'+escapeHtml(error.message || error)+'</span>';
      }
    }

    async function finishVerification() {
      if (!activeVerification?.id) return;
      const controls = [...actions.querySelectorAll('button')];
      controls.forEach((x)=>x.disabled=true);
      spinning('Reconnecting to the verified cloud browser and running the full reader gauntlet…');
      try {
        const checked = await jsonRequest(`/api/source-beast/runs/${encodeURIComponent(activeVerification.id)}/verification/check`, {method:'POST'}, 150000);
        activeVerification = {...activeVerification, ...checked};
        if (checked.state === 'ready' && checked.adapter) {
          spinning('Verification passed. Enabling the web source in Yomu…');
          const count = await verify(checked.adapter);
          const changed = collectionAdd(checked.adapter);
          status.innerHTML='<span class="sf-ok">✓ Cloud verification passed. Source added.</span>';
          setResult(checked.adapter.name || 'Source added', changed ? 'The verified web source is enabled in Yomu.' : 'This verified web source was already enabled.', ['Cloudflare Browser Run','web source','no local helper',`${count} titles sampled`,Number.isFinite(checked.score)?`${checked.score}/100`:'']);
          details.textContent = `Input: ${activeTarget}\nRuntime: Cloudflare Browser Run\nEngine: ${checked.adapter.engine || 'cloud-browser'}\nSource mode: web extension (no native promotion)\nGauntlet: ${checked.score || 0}/100`;
          setTimeout(()=>location.reload(),1200);
          return;
        }
        if (checked.state === 'verification-required' || checked.state === 'verification-in-progress') {
          setResult('Verification still required', checked.message || 'Finish the website verification in the cloud browser.', ['Cloudflare Browser Run','human verification','no localhost']);
          action('Open cloud verification', openVerification);
          action('I finished — verify & add', finishVerification, true);
          status.innerHTML='<span class="sf-warn">The website still needs your verification.</span>';
          return;
        }
        throw new Error(checked.message || 'The verified session did not pass the reader gauntlet.');
      } catch (error) {
        status.innerHTML='<span class="sf-bad">'+escapeHtml(error.message || error)+'</span>';
        setResult('Could not finish verification', error.message || String(error), ['cloud browser','web source']);
        action('Open verification again', async () => {
          activeVerification.liveViewUrl = '';
          await openVerification();
        });
        action('Retry verification check', finishVerification, true);
      } finally {
        controls.forEach((x)=>x.disabled=false);
      }
    }

    function showVerification(run, target, resolution) {
      activeVerification = run;
      activeTarget = target;
      status.innerHTML='<span class="sf-warn">Human verification required.</span> No local helper is needed.';
      setResult('Cloud verification required', run.message || 'Complete the website check in Cloudflare Browser Run, then return to Yomu.', ['Cloudflare Browser Run','human-in-the-loop','web source','no localhost']);
      action('Open cloud verification', openVerification);
      action('I finished — verify & add', finishVerification, true);
      const evidence = Array.isArray(resolution?.evidence) ? resolution.evidence.map((e)=>`${e.ecosystem || 'implementation'} · ${e.name || e.id || 'found'}`).join('\n') : '';
      details.textContent = `Input: ${target}\nRoute: ${resolution?.route || 'browser-required'}\nRuntime: Cloudflare Browser Run Live View\nSource mode: web extension (no native promotion)\nLocal helper: none${evidence ? `\nEvidence:\n${evidence}` : ''}`;
    }

    const preset = new URLSearchParams(location.search).get('url');
    if (preset) input.value = preset;
    if (location.hash === '#add-source' || preset) setTimeout(() => input.focus(), 80);
    document.addEventListener('yomu:focus-add-source', () => { p.scrollIntoView({behavior:'smooth',block:'center'}); input.focus(); });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      result.classList.remove('show');
      activeVerification = null;
      let target;
      try { target = normalizeInput(input.value); }
      catch (error) { status.innerHTML='<span class="sf-bad">'+escapeHtml(error.message)+'</span>'; return; }

      button.disabled = true;
      button.textContent = 'Testing…';
      try {
        if (target.kind === 'repository') {
          button.textContent = 'Adding…';
          const { saved, repository } = await addRepository(target.value, spinning);
          status.innerHTML='<span class="sf-ok">✓ Repository added.</span>';
          setResult(repository.name || 'Repository added', saved.existed ? 'Already registered — Yomu refreshed its repository data.' : 'Repository registered. Its sources are now discoverable in Yomu.', [repository.ecosystem, Number.isFinite(Number(repository.sourceCount)) ? `${Number(repository.sourceCount).toLocaleString()} sources` : '', repository.trust]);
          details.textContent = `Repository: ${repository.repositoryUrl || target.value}\nRuntime: ${repository.runtimeClass || 'automatic'}\nCompatibility: ${repository.compatibility || 'detected automatically'}`;
        } else {
          const added = await addWebsite(target.value, spinning);
          if (added.verification) {
            showVerification(added.verification, target.value, added.resolution);
            return;
          }
          status.innerHTML='<span class="sf-ok">✓ Source added.</span> '+escapeHtml(added.extension.name)+' is ready in Yomu.';
          setResult(added.extension.name, added.changed ? 'Added successfully. Refreshing your source list…' : 'Already enabled. Refreshing your source list…', [added.extension.runtime || 'Yomu web adapter', added.extension.engine || '', `${added.count} titles sampled`]);
          details.textContent = `Input: ${target.value}\nRuntime: ${added.extension.runtime || 'web adapter'}\nEngine: ${added.extension.engine || 'automatic'}${Number.isFinite(added.resolution?.score) ? `\nResolve score: ${added.resolution.score}/100` : ''}\nSource mode: web source`;
          setTimeout(()=>location.reload(),900);
        }
      } catch (error) {
        status.innerHTML='<span class="sf-bad">'+escapeHtml(error.message || error)+'</span>';
        const evidence = Array.isArray(error.evidence) ? error.evidence.map((e)=>`${e.ecosystem || 'implementation'} · ${e.name || e.id || 'found'}`) : [];
        setResult('Could not add yet', error.message || String(error), evidence);
        details.textContent = `Input: ${target.value}\nType: ${target.kind}\nError: ${error.message || String(error)}`;
      } finally {
        button.disabled = false;
        button.textContent = 'Add';
      }
    });
  }

  mount();
  let timer = null;
  new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(mount, 80);
  }).observe(document.documentElement,{childList:true,subtree:true});
})();
