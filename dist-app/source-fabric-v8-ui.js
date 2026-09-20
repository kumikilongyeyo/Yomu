(() => {
  'use strict';

  /** Asked on every mount: Yomu routes client-side. See source-fabric-panel.js. */
  const onSourcesRoute = () => /^\/sources(?:\.html)?\/?$/.test(location.pathname);

  // Browser Run Free allows only one new browser acquisition every ~20 seconds.
  // Treat that short launch throttle as retryable, while keeping the separate
  // daily browser-time quota error explicit for the user.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const requestUrl = typeof input === 'string' ? input : String(input?.url || '');
    const response = await nativeFetch(input, init);
    if (!requestUrl.includes('/api/source-beast/test') || response.ok) return response;

    let payload = null;
    try { payload = await response.clone().json(); } catch {}
    const message = String(payload?.message || payload?.error || '');

    if (/browser time limit exceeded for today/i.test(message)) {
      const headers = new Headers(response.headers);
      headers.set('content-type', 'application/json; charset=utf-8');
      return new Response(JSON.stringify({
        ...(payload || {}),
        message: 'Cloudflare Browser Run’s free daily browser allowance is used up. It resets at 00:00 UTC. This is the daily quota, not a ToonGod/source failure.',
      }), { status: response.status, headers });
    }

    if (!/rate limit exceeded/i.test(message)) return response;

    window.dispatchEvent(new CustomEvent('yomu:source-beast-rate-wait', { detail:{ seconds:21 } }));
    await new Promise((resolve) => setTimeout(resolve, 21_000));
    return nativeFetch(input, init);
  };

  window.addEventListener('yomu:source-beast-rate-wait', () => {
    const status = document.querySelector('#yomu-source-fabric-command .sf-status');
    if (status) status.innerHTML = '<span class="sf-spin"></span>Cloudflare is throttling new browser launches. Waiting ~21 seconds, then Yomu will retry automatically…';
  });

  const KEYS = { repositories:'yomu.v8.repositories', updates:'yomu.v8.repository-updates' };
  const state = { repositories:read(KEYS.repositories, []), updates:read(KEYS.updates, []), status:null, active:null };

  function read(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value ?? fallback; } catch { return fallback; } }
  function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
  function el(tag, className='', text) { const node=document.createElement(tag); if(className) node.className=className; if(text!==undefined) node.textContent=text; return node; }
  function button(text, className='') { const node=el('button',`y8c-btn ${className}`.trim(),text); node.type='button'; return node; }
  function relativeTime(value) { if(!value) return 'unknown'; const t=new Date(value).getTime(); if(!Number.isFinite(t)) return 'unknown'; const d=Math.abs(Date.now()-t); if(d<60_000)return 'just now'; if(d<3_600_000)return `${Math.round(d/60_000)}m ago`; if(d<86_400_000)return `${Math.round(d/3_600_000)}h ago`; if(d<2_592_000_000)return `${Math.round(d/86_400_000)}d ago`; return new Date(value).toLocaleDateString(); }
  function repoState(repo){ if(repo.lastError)return 'needs action'; if(!repo.verifiedFormat||repo.compatibility==='review')return 'review'; return 'healthy'; }
  function saveRepositories(){ write(KEYS.repositories,state.repositories); }
  function recordUpdate(repo,type,message){ state.updates.unshift({id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,repositoryId:repo.id,repositoryName:repo.name,type,message,at:new Date().toISOString()}); state.updates=state.updates.slice(0,80); write(KEYS.updates,state.updates); }

  const css=document.createElement('style');
  css.textContent=`
    #yomu-v8-fabric-compact{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;margin:-7px 0 18px;color:var(--text,#f7f8fa)}
    #yomu-v8-fabric-compact *{box-sizing:border-box}.y8c-bar{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.y8c-label{font-size:11px;color:var(--dim,#8297aa);margin-right:2px}
    .y8c-btn{border:1px solid var(--line,#263747);background:color-mix(in srgb,var(--surface,#111b25) 90%,transparent);color:var(--muted,#91a8bb);border-radius:999px;height:34px;padding:0 12px;font:inherit;font-size:11px;font-weight:750;cursor:pointer}.y8c-btn:hover,.y8c-btn.active{color:var(--text,#f7f8fa);border-color:color-mix(in srgb,var(--accent,#ffc15a) 45%,var(--line,#263747));background:color-mix(in srgb,var(--accent,#ffc15a) 7%,var(--surface,#111b25))}.y8c-btn.danger{color:#ff9b94}.y8c-btn:disabled{opacity:.55;cursor:wait}
    .y8c-pane{margin-top:9px;padding:12px;border:1px solid var(--line,#263747);border-radius:14px;background:color-mix(in srgb,var(--surface,#111b25) 94%,transparent)}.y8c-pane[hidden]{display:none}.y8c-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.y8c-head strong{font-size:12px}.y8c-muted{color:var(--dim,#8297aa);font-size:11px;line-height:1.45}.y8c-list{display:grid;gap:7px}.y8c-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 10px;border:1px solid var(--hairline,var(--line,#263747));border-radius:11px}.y8c-row strong{display:block;font-size:12px}.y8c-meta{margin-top:2px;color:var(--dim,#8297aa);font-size:10.5px}.y8c-actions{display:flex;gap:6px;flex-wrap:wrap}.y8c-empty{font-size:11.5px;color:var(--muted,#91a8bb);line-height:1.45}.y8c-error{color:#ff9b94;font-size:10.5px;margin-top:3px}.y8c-json{max-height:260px;overflow:auto;margin:0;padding:10px;border-radius:10px;background:var(--bg,#09111a);font:10.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted,#91a8bb);white-space:pre-wrap}
    @media(max-width:700px){.y8c-row{align-items:flex-start;flex-direction:column}.y8c-actions{width:100%}}
  `;
  document.head.append(css);

  async function api(path,options={}){ const response=await fetch(path,{cache:'no-store',...options,headers:{'content-type':'application/json',...(options.headers||{})}}); const payload=await response.json().catch(()=>({})); if(!response.ok||payload.ok===false)throw new Error(payload.error||`Request failed (${response.status})`); return payload; }
  async function detectRepository(input){ const payload=await api('/api/fabric/repositories/detect',{method:'POST',body:JSON.stringify({input}),signal:AbortSignal.timeout(30_000)}); return payload.repository; }

  async function checkRepository(id,control){
    const repo=state.repositories.find((row)=>row.id===id); if(!repo||repo.paused)return;
    const original=control?.textContent; if(control){control.disabled=true;control.textContent='Checking…';}
    try{
      const candidate=await detectRepository(repo.repositoryUrl); const changed=candidate.fingerprint!==repo.fingerprint; repo.lastChecked=new Date().toISOString(); repo.lastError='';
      if(!changed){repo.updateState='current';recordUpdate(repo,'current','Repository checked · already up to date.');}
      else if(!candidate.verifiedFormat||candidate.compatibility==='review'){repo.updateState='rolled-back';repo.lastRejectedCandidate=candidate;recordUpdate(repo,'rolled-back','New metadata failed compatibility checks. Previous known-good metadata was kept.');}
      else{repo.lastKnownGood={...repo};Object.assign(repo,candidate,{paused:repo.paused,autoUpdate:repo.autoUpdate!==false,lastChecked:new Date().toISOString(),updateState:'current',lastError:''});recordUpdate(repo,'updated','Repository metadata updated after compatibility checks.');}
      saveRepositories();
    }catch(error){repo.lastChecked=new Date().toISOString();repo.lastError=error.message||String(error);repo.updateState='failed';recordUpdate(repo,'failed',`Update check failed: ${repo.lastError}`);saveRepositories();}
    finally{if(control){control.disabled=false;control.textContent=original||'Check';}render();}
  }

  async function checkAll(control){ const list=state.repositories.filter((repo)=>!repo.paused); if(!list.length)return; const original=control.textContent; control.disabled=true; for(let i=0;i<list.length;i+=1){control.textContent=`Checking ${i+1}/${list.length}…`;await checkRepository(list[i].id,null);} control.disabled=false; control.textContent=original; render(); }

  function mount(){
    if(!onSourcesRoute()){document.getElementById('yomu-v8-fabric-compact')?.remove();return;}
    if(document.getElementById('yomu-v8-fabric-compact'))return;
    const anchor=document.getElementById('yomu-source-fabric-command'); if(!anchor?.parentNode)return;
    const shell=el('section'); shell.id='yomu-v8-fabric-compact';
    const bar=el('div','y8c-bar'); bar.append(el('span','y8c-label','Manage'));
    for(const [id,label] of [['repositories','Repositories'],['updates','Updates'],['advanced','Advanced']]){const b=button(label);b.dataset.tab=id;b.addEventListener('click',()=>{state.active=state.active===id?null:id;render();});bar.append(b);}
    const pane=el('div','y8c-pane');pane.hidden=true;shell.append(bar,pane);anchor.after(shell);render();
  }

  function render(){
    state.repositories=read(KEYS.repositories,[]); state.updates=read(KEYS.updates,[]);
    const shell=document.getElementById('yomu-v8-fabric-compact'); if(!shell)return;
    shell.querySelectorAll('[data-tab]').forEach((b)=>b.classList.toggle('active',b.dataset.tab===state.active));
    const pane=shell.querySelector('.y8c-pane'); pane.replaceChildren(); pane.hidden=!state.active; if(!state.active)return;
    if(state.active==='repositories')return renderRepositories(pane); if(state.active==='updates')return renderUpdates(pane); return renderAdvanced(pane);
  }

  function renderRepositories(pane){
    const head=el('div','y8c-head'); const title=el('div'); title.append(el('strong','',`Repositories · ${state.repositories.length}`),el('div','y8c-muted','Add new repositories from the single box above.'));
    const check=button('Check updates');check.disabled=!state.repositories.length;check.addEventListener('click',()=>checkAll(check));head.append(title,check);pane.append(head);
    if(!state.repositories.length){pane.append(el('div','y8c-empty','No repositories yet. Paste a GitHub repository in the Add source box above — no second form needed.'));return;}
    const list=el('div','y8c-list');
    for(const repo of state.repositories){const row=el('div','y8c-row');const copy=el('div');copy.append(el('strong','',repo.name||repo.repositoryUrl),el('div','y8c-meta',`${String(repo.ecosystem||'repository').toUpperCase()} · ${repoState(repo)} · checked ${relativeTime(repo.lastChecked)}`));if(repo.lastError)copy.append(el('div','y8c-error',repo.lastError));const actions=el('div','y8c-actions');const one=button('Check');one.addEventListener('click',()=>checkRepository(repo.id,one));const pause=button(repo.paused?'Resume':'Pause');pause.addEventListener('click',()=>{repo.paused=!repo.paused;repo.autoUpdate=!repo.paused;saveRepositories();recordUpdate(repo,repo.paused?'paused':'resumed',repo.paused?'Automatic checks paused.':'Automatic checks resumed.');render();});const remove=button('Remove','danger');remove.addEventListener('click',()=>{if(!confirm(`Remove ${repo.name||'this repository'} from Yomu?`))return;state.repositories=state.repositories.filter((r)=>r.id!==repo.id);saveRepositories();recordUpdate(repo,'removed','Repository removed from the manager.');render();});actions.append(one,pause,remove);row.append(copy,actions);list.append(row);}pane.append(list);
  }

  function renderUpdates(pane){const head=el('div','y8c-head');head.append(el('strong','',`Update history · ${state.updates.length}`));const clear=button('Clear');clear.addEventListener('click',()=>{state.updates=[];write(KEYS.updates,[]);render();});head.append(clear);pane.append(head);if(!state.updates.length){pane.append(el('div','y8c-empty','No repository update events yet.'));return;}const list=el('div','y8c-list');for(const item of state.updates.slice(0,25)){const row=el('div','y8c-row');const copy=el('div');copy.append(el('strong','',item.repositoryName||'Repository'),el('div','y8c-meta',`${item.message||item.type} · ${relativeTime(item.at)}`));row.append(copy);list.append(row);}pane.append(list);}

  async function loadStatus(){try{state.status=await api('/api/fabric/status',{signal:AbortSignal.timeout(15_000)});}catch(error){state.status={ok:false,error:error.message||String(error)};}if(state.active==='advanced')render();}
  function renderAdvanced(pane){const head=el('div','y8c-head');head.append(el('strong','','Developer diagnostics'));pane.append(head);const pre=el('pre','y8c-json');pre.textContent=state.status?JSON.stringify(state.status,null,2):'Loading diagnostics…';pane.append(pre);if(!state.status)loadStatus();}

  document.addEventListener('yomu:repositories-changed',()=>{state.repositories=read(KEYS.repositories,[]);if(state.active==='repositories')render();});
  mount();
  let timer=null;
  const schedule=()=>{if(timer)clearTimeout(timer);timer=setTimeout(mount,80);};
  new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
  window.addEventListener('yomu:route', schedule);
})();