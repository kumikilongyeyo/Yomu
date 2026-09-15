(() => {
  'use strict';
  if (!location.pathname.startsWith('/sources')) return;

  const PANEL_ID = 'yomu-source-fabric-command';
  const COLLECTION_KEY = 'yomu.v1.collection';

  const css = document.createElement('style');
  css.textContent = `
    #${PANEL_ID}{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;position:relative;z-index:4;margin:0 0 22px;padding:18px;border:1px solid var(--line,#263747);border-radius:20px;background:linear-gradient(180deg,color-mix(in srgb,var(--surface,#111b25) 94%,var(--accent,#ffc15a) 6%),var(--surface,#111b25));box-shadow:0 18px 55px rgba(0,0,0,.14);color:var(--text,#f7f8fa)}
    #${PANEL_ID} *{box-sizing:border-box}
    #${PANEL_ID} .sf-kicker{font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim,#8297aa);margin-bottom:5px}
    #${PANEL_ID} .sf-head{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}
    #${PANEL_ID} h2{font-size:22px;line-height:1.08;letter-spacing:-.025em;margin:0}
    #${PANEL_ID} .sf-copy{font-size:12.5px;line-height:1.45;color:var(--muted,#91a8bb);margin:5px 0 0;max-width:650px}
    #${PANEL_ID} .sf-remote{flex:none;border:1px solid color-mix(in srgb,#7fe3a7 40%,var(--line,#263747));border-radius:999px;padding:6px 9px;font-size:10.5px;color:#91e4ad;background:rgba(80,190,120,.06);white-space:nowrap}
    #${PANEL_ID} .sf-form{display:flex;gap:9px;margin-top:14px}
    #${PANEL_ID} input{flex:1;min-width:0;height:48px;padding:0 14px;border-radius:13px;border:1px solid var(--line,#263747);background:var(--bg,#09111a);color:var(--text,#f7f8fa);font:inherit;font-size:15px;outline:none}
    #${PANEL_ID} input:focus{border-color:color-mix(in srgb,var(--accent,#ffc15a) 70%,var(--line,#263747));box-shadow:0 0 0 3px color-mix(in srgb,var(--accent,#ffc15a) 12%,transparent)}
    #${PANEL_ID} button,#${PANEL_ID} a.sf-button{height:48px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:999px;padding:0 19px;background:var(--accent,#ffc15a);color:var(--accentText,#0c131b);font:inherit;font-weight:800;text-decoration:none;cursor:pointer;white-space:nowrap}
    #${PANEL_ID} button:disabled{opacity:.55;cursor:wait}
    #${PANEL_ID} .sf-pipe{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:12px}
    #${PANEL_ID} .sf-step{min-height:48px;border:1px solid var(--hairline,var(--line,#263747));border-radius:12px;padding:8px 10px;color:var(--dim,#8297aa);font-size:10.5px;line-height:1.3}
    #${PANEL_ID} .sf-step b{display:block;font-size:11.5px;color:var(--text,#f7f8fa);margin-bottom:1px}
    #${PANEL_ID} .sf-step.active{border-color:color-mix(in srgb,var(--accent,#ffc15a) 55%,var(--line,#263747));background:color-mix(in srgb,var(--accent,#ffc15a) 7%,transparent)}
    #${PANEL_ID} .sf-step.done b{color:#91e4ad}#${PANEL_ID} .sf-step.bad b{color:#ff8a81}
    #${PANEL_ID} .sf-status{min-height:19px;margin-top:10px;font-size:12px;color:var(--muted,#91a8bb)}
    #${PANEL_ID} .sf-spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.18);border-top-color:var(--accent,#ffc15a);border-radius:50%;animation:sfspin .7s linear infinite;margin-right:7px;vertical-align:-2px}@keyframes sfspin{to{transform:rotate(360deg)}}
    #${PANEL_ID} .sf-result{display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--hairline,var(--line,#263747))}#${PANEL_ID} .sf-result.show{display:block}
    #${PANEL_ID} .sf-result-row{display:flex;align-items:center;justify-content:space-between;gap:12px}#${PANEL_ID} .sf-result strong{font-size:16px}#${PANEL_ID} .sf-result p{margin:3px 0 0;color:var(--muted,#91a8bb);font-size:12px;line-height:1.4}
    #${PANEL_ID} .sf-chip{display:inline-flex;border:1px solid var(--line,#263747);border-radius:999px;padding:4px 8px;font-size:10px;color:var(--dim,#8297aa);margin:6px 5px 0 0}
    #${PANEL_ID} .sf-ok{color:#91e4ad}#${PANEL_ID} .sf-bad{color:#ff8a81}
    #${PANEL_ID} details{margin-top:10px;font-size:11px;color:var(--dim,#8297aa)}#${PANEL_ID} summary{cursor:pointer;color:var(--muted,#91a8bb);font-weight:650}
    @media(max-width:700px){#${PANEL_ID}{margin:0 0 16px;padding:15px;border-radius:17px}#${PANEL_ID} .sf-head{display:block}#${PANEL_ID} .sf-remote{display:inline-flex;margin-top:8px}#${PANEL_ID} .sf-form{flex-direction:column}#${PANEL_ID} button{width:100%}#${PANEL_ID} .sf-pipe{grid-template-columns:1fr 1fr 1fr}#${PANEL_ID} .sf-step{padding:7px;min-height:44px}#${PANEL_ID} .sf-step span{display:none}}
  `;
  document.head.append(css);

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const adultAllowed = () => { try { return localStorage.getItem('yomu.v1.adult') === 'on'; } catch { return false; } };

  function cleanUrl(value) {
    const raw = value.trim();
    if (!raw) throw new Error('Paste a website link first.');
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error('Use a normal public http/https website link.');
    return u.toString();
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
    const response = await fetch(api + 'series', { cache:'no-store', signal:AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Reader check returned HTTP ${response.status}.`);
    const body = await response.json().catch(() => ({}));
    if (!Array.isArray(body.series)) throw new Error('The source did not return a valid title list.');
    return body.series.length;
  }

  function panel() {
    const el = document.createElement('section');
    el.id = PANEL_ID;
    el.innerHTML = `
      <div class="sf-head"><div><div class="sf-kicker">Source Fabric · v5</div><h2>Add any reading source</h2><p class="sf-copy">Paste a manga, manhwa, manhua or webtoon site. Yomu finds the engine, tests it, then adds it as a normal source.</p></div><span class="sf-remote">● Remote · desktop optional</span></div>
      <form class="sf-form"><input aria-label="Website or series URL" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false" placeholder="https://kagane.to" /><button type="submit">Add source</button></form>
      <div class="sf-pipe"><div class="sf-step" data-step="find"><b>1 · Find</b><span>Pick engine</span></div><div class="sf-step" data-step="test"><b>2 · Test</b><span>Check reader</span></div><div class="sf-step" data-step="add"><b>3 · Add</b><span>Enable in Yomu</span></div></div>
      <div class="sf-status">Ready. Paste a site above.</div>
      <div class="sf-result"><div class="sf-result-row"><div><strong></strong><p></p><div class="sf-tags"></div></div></div></div>
      <details><summary>Advanced fallback</summary><div style="padding-top:7px">If a site blocks the remote runtime or needs a normal interactive browser, desktop Forge remains available as a fallback. It is no longer the normal path.</div></details>`;
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
      const text = (el.textContent || '').slice(0,400);
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
    const step = (name,state='') => { const x=p.querySelector(`[data-step="${name}"]`); x.className='sf-step'+(state?' '+state:''); };
    const reset = () => ['find','test','add'].forEach((x)=>step(x));
    const spinning = (text) => { status.innerHTML='<span class="sf-spin"></span>'+escapeHtml(text); };

    const preset = new URLSearchParams(location.search).get('url');
    if (preset) input.value = preset;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      let target;
      try { target = cleanUrl(input.value); } catch (error) { status.innerHTML='<span class="sf-bad">'+escapeHtml(error.message)+'</span>'; return; }
      button.disabled = true; result.classList.remove('show'); reset(); step('find','active'); spinning('Finding the strongest engine…');
      let resolution = null;
      try {
        const registryResponse = await fetch('/api/ext/sources', {cache:'no-store',signal:AbortSignal.timeout(20000)});
        if (!registryResponse.ok) throw new Error('Could not load Yomu sources.');
        const registry = await registryResponse.json();
        let extension = hostMatch(target, registry.extensions || []);

        if (!extension) {
          const response = await fetch('/api/fabric/resolve', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:target}),cache:'no-store',signal:AbortSignal.timeout(45000)});
          resolution = await response.json().catch(()=>({error:`HTTP ${response.status}`}));
          if (!response.ok) throw new Error(resolution.error || `HTTP ${response.status}`);
          if (!resolution.ready || !resolution.adapter) {
            step('find','done'); step('test','bad');
            status.innerHTML='<span class="sf-bad">'+escapeHtml(resolution.message || 'This site needs a specialist adapter.')+'</span>';
            strong.textContent='Not added'; note.textContent=resolution.message || 'Yomu could not prove a complete catalog → chapter → page path.';
            tags.innerHTML=(resolution.evidence||[]).map((e)=>`<span class="sf-chip">${escapeHtml(e.ecosystem)} · ${escapeHtml(e.name||e.id||'implementation')}</span>`).join('');
            result.classList.add('show'); return;
          }
          extension = resolution.adapter;
        }

        step('find','done'); step('test','active'); spinning('Testing browse and reader endpoint…');
        const count = await verify(extension);
        step('test','done'); step('add','active'); spinning('Adding source to Yomu…');
        const changed = collectionAdd(extension);
        step('add','done');
        status.innerHTML='<span class="sf-ok">✓ Ready.</span> '+escapeHtml(extension.name)+' is now a Yomu source.';
        strong.textContent=extension.name; note.textContent=changed?'Added successfully. Reloading the source list…':'Already enabled. Refreshing the source list…';
        const tagRows=[extension.runtime||'Yomu adapter',extension.engine||'',Number.isFinite(resolution?.score)?resolution.score+'/100':'',count+' titles sampled'].filter(Boolean);
        tags.innerHTML=tagRows.map((x)=>`<span class="sf-chip">${escapeHtml(x)}</span>`).join('');
        result.classList.add('show');
        setTimeout(()=>location.reload(),1100);
      } catch (error) {
        const active=[...p.querySelectorAll('.sf-step')].find((x)=>x.classList.contains('active'));
        if(active){active.classList.remove('active');active.classList.add('bad')}
        status.innerHTML='<span class="sf-bad">'+escapeHtml(error.message || error)+'</span>';
        strong.textContent='Could not add source'; note.textContent=error.message || String(error); tags.innerHTML=''; result.classList.add('show');
      } finally { button.disabled=false; }
    });
  }

  mount();
  let timer = null;
  new MutationObserver(() => { if (timer) clearTimeout(timer); timer=setTimeout(mount,80); }).observe(document.documentElement,{childList:true,subtree:true});
})();
