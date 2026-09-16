/* Yomu Library Hub v2
 * Real branch-only UI shell. Catalog/Fabric/Hunter/sync/provider behavior stays
 * owned by the existing app; this file only composes and controls presentation.
 */
(() => {
  'use strict';
  if (globalThis.__yomuLibraryHubV2) return;
  globalThis.__yomuLibraryHubV2 = true;
  document.documentElement.classList.add('yhub-ui');

  const CIRCLE_KEY = 'yomu.v1.circle';
  const AVATAR_KEY = 'yomu.v1.avatar';
  const APPEARANCE_KEY = 'yomu.appearance';
  const TONE_KEY = 'yomu.ui.hub.greetingTone';
  const DENSITY_KEY = 'yomu.ui.hub.density';
  const READER_KEY = 'yomu.ui.hub.reader';
  const AVATARS = [
    ['01_sleep_deprived_reader','Sleep deprived'],
    ['02_sexy_romance_reader','Hopeless romantic'],
    ['03_chill_dinosaur_reader','Chill dinosaur'],
    ['04_undead_knight_reader','Undead knight'],
    ['05_shocked_cliffhanger_reader','Cliffhanger victim'],
  ];
  const DEFAULT_READER = { mode:'manhwa', fit:'width', gap:0, background:'black', prefetch:6, crop:false, rememberSeries:true };

  const $ = (q, root=document) => root.querySelector(q);
  const $$ = (q, root=document) => [...root.querySelectorAll(q)];
  const readJSON = (key, fallback) => { try { const v=JSON.parse(localStorage.getItem(key)||'null'); return v ?? fallback; } catch { return fallback; } };
  const writeJSON = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const readText = (key, fallback='') => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`;

  function profileName() {
    const row = readJSON(CIRCLE_KEY, {});
    return typeof row?.name === 'string' && row.name.trim() ? row.name.trim().slice(0,24) : 'Reader';
  }
  function avatarId() {
    const row = readJSON(AVATAR_KEY, null);
    const id = row?.kind === 'preset' ? String(row.id || '') : '';
    return AVATARS.some(([x]) => x === id) ? id : AVATARS[3][0];
  }
  const avatarURL = (id=avatarId()) => `/brand/avatars/${id}.webp`;

  function makeLockup(cls='') {
    const el=document.createElement('span');
    el.className=`yomu-lockup ${cls}`.trim();
    el.setAttribute('role','img'); el.setAttribute('aria-label','Yomu');
    el.innerHTML=`<svg class="ymark" viewBox="0 0 195 168" aria-hidden="true"><polygon points="8.00,12.75 79.00,47.02 79.00,155.25 8.00,120.98" fill="currentColor" stroke="currentColor" stroke-width="16" stroke-linejoin="round"></polygon><polygon points="116.00,47.02 187.00,12.75 187.00,120.98 116.00,155.25" fill="currentColor" stroke="currentColor" stroke-width="16" stroke-linejoin="round"></polygon></svg><span class="yword" aria-hidden="true"><span style="--i:0">Y</span><span style="--i:1">o</span><span style="--i:2">m</span><span style="--i:3">u</span></span>`;
    return el;
  }

  function routeKind() {
    const p=location.pathname;
    if (p.startsWith('/find') || p.startsWith('/search') || p.startsWith('/discover')) return 'discover';
    if (p.startsWith('/library') || p.startsWith('/downloads')) return 'library';
    if (p.startsWith('/you')) return 'you';
    if (p.startsWith('/settings') || p.startsWith('/sources') || p.startsWith('/extensions') || p.startsWith('/suwayomi')) return 'more';
    return 'home';
  }

  /* -------------------------------------------------------------- */
  /* Loading                                                        */
  /* -------------------------------------------------------------- */
  function mountSplash() {
    if (location.pathname.startsWith('/read/')) return;
    try { if (sessionStorage.getItem('yomu.ui.hub.v2.splash')) return; sessionStorage.setItem('yomu.ui.hub.v2.splash','1'); } catch {}
    if (!document.body) return;
    const splash=document.createElement('div'); splash.className='yhub-splash'; splash.setAttribute('role','status');
    const inner=document.createElement('div'); inner.className='yhub-splash__inner';
    inner.append(makeLockup());
    const line=document.createElement('div'); line.className='yhub-splash__line'; line.textContent='Opening your reading room';
    const loader=document.createElement('span'); loader.className='yomu-loader'; loader.setAttribute('aria-hidden','true');
    inner.append(line,loader); splash.append(inner); document.body.append(splash);
    let done=false; const out=()=>{ if(done)return; done=true; setTimeout(()=>{splash.classList.add('is-out'); setTimeout(()=>splash.remove(),330);},420); };
    if(document.readyState==='complete') out(); else addEventListener('load',out,{once:true});
    setTimeout(out,1500);
  }

  /* -------------------------------------------------------------- */
  /* New shell navigation                                            */
  /* -------------------------------------------------------------- */
  let deck, deckBackdrop, profileSheet, profileBackdrop;

  function navItem(href,label,key) {
    const active=routeKind()===key ? ' is-active' : '';
    return `<a href="${href}" class="${active.trim()}"${active ? ' aria-current="page"' : ''}>${label}</a>`;
  }
  function mobileItem(href,label,key,path) {
    const active=routeKind()===key ? ' is-active' : '';
    return `<a href="${href}" class="${active.trim()}">${icon(path)}<span>${label}</span></a>`;
  }

  function mountShell() {
    if (location.pathname.startsWith('/start')) return;
    if (location.pathname.startsWith('/read/')) { document.body?.classList.add('yhub-reader-page'); return; }
    if ($('#yhub-appbar')) return;

    const bar=document.createElement('header'); bar.id='yhub-appbar'; bar.className='yhub-appbar';
    const brand=document.createElement('a'); brand.href='/'; brand.className='yhub-brand'; brand.append(makeLockup());
    bar.append(brand);

    const search=document.createElement('a'); search.href='/find.html'; search.className='yhub-search';
    search.innerHTML=`${icon('M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35')}<span>Search across your sources</span><kbd>⌘K</kbd>`;
    bar.append(search);

    const nav=document.createElement('nav'); nav.className='yhub-nav'; nav.setAttribute('aria-label','Main navigation');
    nav.innerHTML=[
      navItem('/','Home','home'), navItem('/find.html','Discover','discover'), navItem('/library','Library','library'), navItem('/sources','Sources','more'),
      `<button type="button" data-yhub-deck>Deck</button>`,
      `<button type="button" class="yhub-avatar-button" data-yhub-profile aria-label="Customize Yomu"><img src="${avatarURL()}" alt=""></button>`
    ].join('');
    bar.append(nav); document.body.append(bar);

    const mobile=document.createElement('nav'); mobile.id='yhub-mobile-nav'; mobile.className='yhub-mobile-nav'; mobile.setAttribute('aria-label','Mobile navigation');
    mobile.innerHTML=[
      mobileItem('/','Home','home','M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5'),
      mobileItem('/find.html','Discover','discover','M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35'),
      mobileItem('/library','Library','library','M4 4h6v16H4zM14 4h6v16h-6z'),
      mobileItem('/you','You','you','M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0'),
      `<button type="button" data-yhub-deck class="${routeKind()==='more'?'is-active':''}">${icon('M5 7h14M5 12h14M5 17h14')}<span>More</span></button>`
    ].join('');
    document.body.append(mobile);

    $$('[data-yhub-deck]').forEach(b=>b.addEventListener('click',openDeck));
    $$('[data-yhub-profile]').forEach(b=>b.addEventListener('click',openProfile));
    addEventListener('keydown',e=>{ if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();location.href='/find.html';} });
  }

  function buildDeck() {
    deckBackdrop=document.createElement('div'); deckBackdrop.className='yhub-deck-backdrop'; deckBackdrop.addEventListener('click',closeDeck);
    deck=document.createElement('aside'); deck.className='yhub-deck'; deck.setAttribute('aria-label','Reader Deck and tools');
    deck.innerHTML=`<div class="yhub-deck__head"><div><h2>Reader Deck</h2><p>Everything Yomu can do, grouped instead of scattered.</p></div><button class="yhub-close" type="button" aria-label="Close">×</button></div>
      <div class="yhub-deck-grid">
        <a class="yhub-tool" href="/downloads.html"><b>Downloads</b><span>Offline chapters, queue and storage.</span></a>
        <a class="yhub-tool" href="/you.html"><b>Your Yomu</b><span>Profile, tracking, history and reading identity.</span></a>
        <a class="yhub-tool" href="/sources"><b>Sources</b><span>Packs, repositories, Source Fabric and diagnostics.</span></a>
        <a class="yhub-tool" href="/settings"><b>Reader & app</b><span>Appearance, reading behavior and advanced controls.</span></a>
        <a class="yhub-tool" href="/extensions.html"><b>Extensions</b><span>Community source ecosystem and adapters.</span></a>
        <a class="yhub-tool" href="/suwayomi-setup.html"><b>Mihon bridge</b><span>Connect compatible source runtimes.</span></a>
        <a class="yhub-tool" href="/history.html"><b>History</b><span>Pick up titles you opened before.</span></a>
        <button class="yhub-tool" type="button" data-profile><b>Customize</b><span>Avatar, greeting, theme and density.</span></button>
      </div>`;
    $('.yhub-close',deck).onclick=closeDeck;
    $('[data-profile]',deck).onclick=()=>{closeDeck();openProfile();};
    document.body.append(deckBackdrop,deck);
  }
  function openDeck(){ if(!deck)buildDeck(); requestAnimationFrame(()=>{deckBackdrop.classList.add('is-open');deck.classList.add('is-open');}); }
  function closeDeck(){ deckBackdrop?.classList.remove('is-open');deck?.classList.remove('is-open'); }

  /* -------------------------------------------------------------- */
  /* Home                                                            */
  /* -------------------------------------------------------------- */
  function plainGreeting(){ const h=new Date().getHours(),n=profileName(); if(h<5)return`Still awake, ${n}?`; if(h<12)return`Morning, ${n}.`; if(h<17)return`Afternoon, ${n}.`; if(h<22)return`Evening, ${n}.`; return`Night owl hours, ${n}.`; }
  function greetingLine(){
    const rows=globalThis.YOMU_GREETINGS?.lines; if(!Array.isArray(rows)||!rows.length)return'Your next chapter is waiting.';
    const h=new Date().getHours(), bucket=h<12?'m':h<17?'a':h<22?'e':'l'; const pool=rows.filter(r=>Array.isArray(r)&&r[2]===bucket); const list=pool.length?pool:rows;
    const tone=readText(TONE_KEY,'mixed'),day=Math.floor(Date.now()/86400000),salt=[...(profileName()+tone)].reduce((s,c)=>s+c.charCodeAt(0),0);
    return String(list[(day+salt)%list.length]?.[0]||'One more chapter. Surely.');
  }
  function ensureGreetings(){ if(globalThis.YOMU_GREETINGS||$('script[data-yhub-greetings]'))return; const s=document.createElement('script');s.src='/yomu-greetings.js';s.defer=true;s.dataset.yhubGreetings='1';s.onload=()=>mountHome(true);document.head.append(s); }
  function collectionStats(){ const c=readJSON('yomu.v1.collection',{}),lib=Array.isArray(c?.library)?c.library:[],sources=Array.isArray(c?.sources)?c.sources:[];return{titles:lib.length,sources:sources.filter(x=>x&&x.enabled!==false).length}; }
  function resumeControl(){ return $('#yomu-continue a[href],#yomu-continue button'); }

  function mountHome(force=false){
    if(location.pathname!=='/'&&location.pathname!=='/index.html')return;
    const main=$('.g-main'); if(!main)return;
    if($('#yhub-home')&&!force)return; $('#yhub-home')?.remove();
    const stats=collectionStats(),resume=resumeControl();
    const sec=document.createElement('section'); sec.id='yhub-home'; sec.className='yhub-home';
    sec.innerHTML=`<div class="yhub-home__top">
      <article class="yhub-welcome"><div class="yhub-welcome__identity"><img src="${avatarURL()}" alt=""><div><span class="yhub-kicker">Your Yomu</span><div style="font-size:11px;color:var(--muted);margin-top:3px">${esc(greetingLine())}</div></div></div><div><h1>${esc(plainGreeting())}</h1><p>One library across every healthy source. The machinery stays available, but it does not get to run the room.</p><div class="yhub-welcome__actions"><button class="yhub-btn primary" type="button" data-resume>${resume?'Continue reading':'Open library'}</button><a class="yhub-btn ghost" href="/find.html">Discover</a><button class="yhub-btn ghost" type="button" data-deck>Open Deck</button></div></div></article>
      <div class="yhub-side"><article class="yhub-status-card"><div class="yhub-status-row"><span class="yhub-kicker">Library</span><i class="yhub-dot"></i></div><div><b>${stats.titles||'Your'} ${stats.titles===1?'title':'titles'}</b><small>Canonical shelf first. Sources stay underneath instead of becoming the product.</small></div></article><article class="yhub-status-card"><div class="yhub-status-row"><span class="yhub-kicker">Smart Source</span><i class="yhub-dot"></i></div><div><b>${stats.sources?stats.sources+' enabled':'Ready'}</b><small>Hunter, Fabric and failover remain accessible from Deck and Sources.</small></div></article></div>
    </div><div class="yhub-home__strip"><a class="yhub-mini" href="/downloads.html"><em>OFFLINE</em><strong>Downloads</strong><span>Queue & storage</span></a><a class="yhub-mini" href="/sources"><em>FABRIC</em><strong>Sources</strong><span>Health & repos</span></a><a class="yhub-mini" href="/you.html"><em>PROFILE</em><strong>Your Yomu</strong><span>Tracking & history</span></a><button class="yhub-mini" type="button" data-reader><em>READER</em><strong>Reading mode</strong><span>Manga · Manhwa · Comic</span></button></div>`;
    main.prepend(sec);
    $('[data-resume]',sec).onclick=()=>{const live=resumeControl(); if(live)live.click(); else location.href='/library';};
    $('[data-deck]',sec).onclick=openDeck;
    $('[data-reader]',sec).onclick=()=>openProfile('reader');
  }

  /* -------------------------------------------------------------- */
  /* Profile                                                         */
  /* -------------------------------------------------------------- */
  function buildProfile(){
    profileBackdrop=document.createElement('div');profileBackdrop.className='yhub-backdrop';profileBackdrop.onclick=closeProfile;
    profileSheet=document.createElement('aside');profileSheet.className='yhub-sheet';profileSheet.setAttribute('aria-label','Customize Yomu');
    document.body.append(profileBackdrop,profileSheet);
  }
  function closeProfile(){profileBackdrop?.classList.remove('is-open');profileSheet?.classList.remove('is-open');}
  function openProfile(focus='profile'){
    if(!profileSheet)buildProfile();
    const current=avatarId(),appearance=readText(APPEARANCE_KEY,'system'),tone=readText(TONE_KEY,'mixed'),density=readText(DENSITY_KEY,'balanced');
    profileSheet.innerHTML=`<div class="yhub-sheet__head"><img src="${avatarURL(current)}" alt=""><div><h2>${focus==='reader'?'Reader defaults':'Make Yomu yours'}</h2><p>Identity and presentation, not feature removal.</p></div><button class="yhub-close" type="button">×</button></div>
      <div class="yhub-group"><label class="yhub-label" for="yhub-name">Display name</label><input id="yhub-name" class="yhub-input" maxlength="18" value="${esc(profileName()==='Reader'?'':profileName())}" placeholder="Reader"></div>
      <div class="yhub-group"><span class="yhub-label">Reader avatar</span><div class="yhub-avatars">${AVATARS.map(([id,label])=>`<button class="yhub-avatar" type="button" data-avatar="${id}" aria-pressed="${id===current}" title="${esc(label)}"><img src="${avatarURL(id)}" alt="${esc(label)}"></button>`).join('')}</div></div>
      <div class="yhub-group"><span class="yhub-label">Appearance</span><div class="yhub-options">${['system','light','dark'].map(v=>`<button class="yhub-option" type="button" data-appearance="${v}" aria-pressed="${appearance===v}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}</div></div>
      <div class="yhub-group"><span class="yhub-label">Greeting mood</span><div class="yhub-options">${['mixed','dark','wholesome','neutral','friendly'].map(v=>`<button class="yhub-option" type="button" data-tone="${v}" aria-pressed="${tone===v}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}</div></div>
      <div class="yhub-group"><span class="yhub-label">Home density</span><div class="yhub-options">${['calm','balanced','dense'].map(v=>`<button class="yhub-option" type="button" data-density="${v}" aria-pressed="${density===v}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}</div><p class="yhub-note">Density changes how much is visible at once. Downloads, Sources, Hunter/Fabric and diagnostics remain available.</p></div>
      <div class="yhub-group"><span class="yhub-label">First run</span><a class="yhub-btn ghost" href="/start#redo">Replay onboarding</a></div><button class="yhub-btn primary" style="width:100%" type="button" data-save>Save changes</button>`;
    $('.yhub-close',profileSheet).onclick=closeProfile;
    let av=current,ap=appearance,tn=tone,dn=density;
    $$('[data-avatar]',profileSheet).forEach(b=>b.onclick=()=>{av=b.dataset.avatar;$$('[data-avatar]',profileSheet).forEach(x=>x.setAttribute('aria-pressed',String(x===b)));});
    $$('[data-appearance]',profileSheet).forEach(b=>b.onclick=()=>{ap=b.dataset.appearance;$$('[data-appearance]',profileSheet).forEach(x=>x.setAttribute('aria-pressed',String(x===b)));});
    $$('[data-tone]',profileSheet).forEach(b=>b.onclick=()=>{tn=b.dataset.tone;$$('[data-tone]',profileSheet).forEach(x=>x.setAttribute('aria-pressed',String(x===b)));});
    $$('[data-density]',profileSheet).forEach(b=>b.onclick=()=>{dn=b.dataset.density;$$('[data-density]',profileSheet).forEach(x=>x.setAttribute('aria-pressed',String(x===b)));});
    $('[data-save]',profileSheet).onclick=()=>{
      const name=$('#yhub-name',profileSheet).value.trim().slice(0,18); const circle=readJSON(CIRCLE_KEY,{}); writeJSON(CIRCLE_KEY,{...circle,name}); writeJSON(AVATAR_KEY,{kind:'preset',id:av});
      try{localStorage.setItem(APPEARANCE_KEY,ap);localStorage.setItem(TONE_KEY,tn);localStorage.setItem(DENSITY_KEY,dn);}catch{}
      document.documentElement.dataset.mode=ap; document.documentElement.dataset.yhubDensity=dn;
      $('.yhub-avatar-button img')?.setAttribute('src',avatarURL(av)); closeProfile(); mountHome(true);
    };
    requestAnimationFrame(()=>{profileBackdrop.classList.add('is-open');profileSheet.classList.add('is-open');});
  }

  /* -------------------------------------------------------------- */
  /* Reader deck                                                     */
  /* -------------------------------------------------------------- */
  let readerPanel,readerTop;
  function readerState(){return{...DEFAULT_READER,...readJSON(READER_KEY,{})};}
  function saveReader(v){writeJSON(READER_KEY,v);document.documentElement.dataset.yhubReader=v.mode;document.documentElement.dataset.yhubReaderBg=v.background;document.documentElement.style.setProperty('--yhub-reader-gap',`${v.gap}px`);dispatchEvent(new CustomEvent('yomu:reader-preferences',{detail:v}));}
  function readerTitle(){return $('.reader-title,h1,.rd-title')?.textContent?.trim()||'Reading';}
  function mountReader(){
    if(!location.pathname.startsWith('/read/'))return; document.body?.classList.add('yhub-reader-page'); if(readerTop)return;
    readerTop=document.createElement('div');readerTop.className='yhub-reader-top';
    readerTop.innerHTML=`<a href="javascript:history.back()" aria-label="Back">‹</a><div class="yhub-reader-title"><b>${esc(readerTitle())}</b><small>Yomu reader · adaptive controls</small></div><button type="button" data-reader-open>${icon('M4 7h16M7 12h10M9 17h6')}<span style="margin-left:6px">Reader</span></button>`;
    document.body.append(readerTop); $('[data-reader-open]',readerTop).onclick=openReader;
    const observer=new MutationObserver(()=>{const b=$('.yhub-reader-title b',readerTop);if(b)b.textContent=readerTitle();});observer.observe(document.body,{subtree:true,childList:true});
  }
  function buildReader(){
    readerPanel=document.createElement('aside');readerPanel.className='yhub-reader-panel';readerPanel.setAttribute('aria-label','Reader controls');document.body.append(readerPanel);
  }
  function openReader(){
    if(!readerPanel)buildReader(); const s=readerState();
    readerPanel.innerHTML=`<div class="yhub-reader-head"><div><b>Reading mode</b><small>Simple preset first. Fine controls underneath.</small></div><button class="yhub-close" type="button">×</button></div>
      <div class="yhub-reader-presets">${[['manga','Manga','Paged · RTL'],['manhwa','Manhwa','Continuous'],['comic','Comic','Paged · LTR']].map(([id,n,note])=>`<button type="button" class="yhub-reader-preset" data-mode="${id}" aria-pressed="${s.mode===id}"><b>${n}</b><span>${note}</span></button>`).join('')}</div>
      <div class="yhub-reader-grid"><button class="yhub-reader-control" data-fit><b>↔</b>Fit<br><span>${esc(s.fit)}</span></button><button class="yhub-reader-control" data-bg><b>◐</b>Background<br><span>${esc(s.background)}</span></button><button class="yhub-reader-control" data-gap><b>↕</b>Gap<br><span>${s.gap}px</span></button><button class="yhub-reader-control" data-crop><b>⌗</b>Crop<br><span>${s.crop?'On':'Off'}</span></button><button class="yhub-reader-control" data-advanced><b>•••</b>More<br><span>Advanced</span></button></div>
      <div class="yhub-reader-advanced"><div class="yhub-reader-row"><span>Prefetch pages</span><input class="yhub-range" type="range" min="1" max="10" value="${s.prefetch}" data-prefetch></div><div class="yhub-reader-row"><span>Remember per series</span><button class="yhub-toggle" type="button" data-remember aria-pressed="${s.rememberSeries}"></button></div><div class="yhub-reader-row"><span>Fullscreen</span><button class="yhub-btn ghost" type="button" data-fullscreen>Toggle</button></div></div>`;
    $('.yhub-close',readerPanel).onclick=()=>readerPanel.classList.remove('is-open');
    $$('[data-mode]',readerPanel).forEach(b=>b.onclick=()=>{s.mode=b.dataset.mode;saveReader(s);openReader();});
    $('[data-fit]',readerPanel).onclick=()=>{const seq=['width','smart','original'];s.fit=seq[(seq.indexOf(s.fit)+1)%seq.length];saveReader(s);openReader();};
    $('[data-bg]',readerPanel).onclick=()=>{const seq=['black','gray','paper'];s.background=seq[(seq.indexOf(s.background)+1)%seq.length];saveReader(s);openReader();};
    $('[data-gap]',readerPanel).onclick=()=>{s.gap=s.gap>=16?0:s.gap+4;saveReader(s);openReader();};
    $('[data-crop]',readerPanel).onclick=()=>{s.crop=!s.crop;saveReader(s);openReader();};
    $('[data-advanced]',readerPanel).onclick=()=>readerPanel.classList.toggle('is-advanced');
    $('[data-prefetch]',readerPanel).oninput=e=>{s.prefetch=Number(e.target.value);saveReader(s);};
    $('[data-remember]',readerPanel).onclick=e=>{s.rememberSeries=!s.rememberSeries;e.currentTarget.setAttribute('aria-pressed',String(s.rememberSeries));saveReader(s);};
    $('[data-fullscreen]',readerPanel).onclick=()=>{if(!document.fullscreenElement)document.documentElement.requestFullscreen?.();else document.exitFullscreen?.();};
    saveReader(s); requestAnimationFrame(()=>readerPanel.classList.add('is-open'));
  }

  /* -------------------------------------------------------------- */
  /* Onboarding                                                       */
  /* -------------------------------------------------------------- */
  function polishStart(){
    if(!location.pathname.startsWith('/start'))return; document.body?.classList.add('yhub-start');
    const hero=$('.ob-hero'); if(hero&&!$('.yhub-onboard-lockup',hero)){const lock=makeLockup('yhub-onboard-lockup');hero.append(lock);}
  }

  function boot(){
    document.documentElement.dataset.yhubDensity=readText(DENSITY_KEY,'balanced');
    mountSplash(); polishStart(); mountShell(); mountReader(); ensureGreetings(); mountHome();
    const mo=new MutationObserver(()=>{polishStart();mountShell();mountReader();mountHome();});
    mo.observe(document.documentElement,{subtree:true,childList:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true}); else boot();
})();
