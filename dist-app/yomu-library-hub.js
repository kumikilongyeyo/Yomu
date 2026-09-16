/* Yomu Library Hub v1
 * Additive UI experiment. No catalog, Source Fabric, Hunter, sync, or provider
 * behavior is replaced here. Everything this file owns is prefixed yhub-.
 */
(() => {
  'use strict';

  if (globalThis.__yomuLibraryHubV1) return;
  globalThis.__yomuLibraryHubV1 = true;
  document.documentElement.classList.add('yhub-ui');

  const CIRCLE_KEY = 'yomu.v1.circle';
  const AVATAR_KEY = 'yomu.v1.avatar';
  const APPEARANCE_KEY = 'yomu.appearance';
  const TONE_KEY = 'yomu.ui.hub.greetingTone';
  const DENSITY_KEY = 'yomu.ui.hub.density';
  const READER_KEY = 'yomu.ui.hub.reader';
  const READER_SERIES_KEY = 'yomu.ui.hub.readerSeries';

  const AVATARS = [
    ['01_sleep_deprived_reader', 'Sleep deprived'],
    ['02_sexy_romance_reader', 'Hopeless romantic'],
    ['03_chill_dinosaur_reader', 'Chill dinosaur'],
    ['04_undead_knight_reader', 'Undead knight'],
    ['05_shocked_cliffhanger_reader', 'Cliffhanger victim'],
  ];

  const DEFAULT_READER = {
    mode: 'manhwa', fit: 'width', gap: 0, background: 'black',
    prefetch: 6, crop: false, rememberSeries: true,
  };

  const json = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value == null ? fallback : value;
    } catch { return fallback; }
  };
  const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const text = (key, fallback = '') => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);

  function profileName() {
    const circle = json(CIRCLE_KEY, {});
    return typeof circle?.name === 'string' && circle.name.trim() ? circle.name.trim().slice(0, 24) : 'Reader';
  }

  function avatarId() {
    const row = json(AVATAR_KEY, null);
    const id = row && row.kind === 'preset' ? String(row.id || '') : '';
    return AVATARS.some(([candidate]) => candidate === id) ? id : AVATARS[3][0];
  }

  const avatarURL = (id = avatarId()) => `/brand/avatars/${id}.webp`;

  function makeLockup(className = '') {
    const lock = document.createElement('span');
    lock.className = `yomu-lockup ${className}`.trim();
    lock.setAttribute('role', 'img');
    lock.setAttribute('aria-label', 'Yomu');
    lock.innerHTML = `<svg class="ymark" viewBox="0 0 195 168" aria-hidden="true">
      <polygon points="8.00,12.75 79.00,47.02 79.00,155.25 8.00,120.98" fill="currentColor" stroke="currentColor" stroke-width="16" stroke-linejoin="round"></polygon>
      <polygon points="116.00,47.02 187.00,12.75 187.00,120.98 116.00,155.25" fill="currentColor" stroke="currentColor" stroke-width="16" stroke-linejoin="round"></polygon>
    </svg><span class="yword" aria-hidden="true"><span style="--i:0">Y</span><span style="--i:1">o</span><span style="--i:2">m</span><span style="--i:3">u</span></span>`;
    return lock;
  }

  /* ------------------------------------------------------------------ */
  /* Opening                                                            */
  /* ------------------------------------------------------------------ */
  function mountSplash() {
    if (location.pathname.startsWith('/read/')) return;
    try {
      if (sessionStorage.getItem('yomu.ui.hub.splash')) return;
      sessionStorage.setItem('yomu.ui.hub.splash', '1');
    } catch {}
    if (!document.body || document.querySelector('.yhub-splash')) return;

    const splash = document.createElement('div');
    splash.className = 'yhub-splash';
    splash.setAttribute('role', 'status');
    splash.setAttribute('aria-label', 'Opening Yomu');
    const inner = document.createElement('div');
    inner.className = 'yhub-splash__inner';
    inner.append(makeLockup());
    const line = document.createElement('div');
    line.className = 'yhub-splash__line';
    line.textContent = 'Opening your reading room';
    const loader = document.createElement('span');
    loader.className = 'yomu-loader';
    loader.setAttribute('aria-hidden', 'true');
    inner.append(line, loader);
    splash.append(inner);
    document.body.append(splash);

    const out = () => {
      setTimeout(() => {
        splash.classList.add('is-out');
        setTimeout(() => splash.remove(), 340);
      }, 430);
    };
    if (document.readyState === 'complete') out();
    else addEventListener('load', out, { once: true });
    setTimeout(out, 1700);
  }

  /* ------------------------------------------------------------------ */
  /* Greeting                                                           */
  /* ------------------------------------------------------------------ */
  function greetingBucket() {
    const h = new Date().getHours();
    return h < 12 ? 'm' : h < 17 ? 'a' : h < 22 ? 'e' : 'l';
  }

  function plainGreeting() {
    const h = new Date().getHours();
    const name = profileName();
    if (h < 5) return `Still awake, ${name}?`;
    if (h < 12) return `Morning, ${name}.`;
    if (h < 17) return `Afternoon, ${name}.`;
    if (h < 22) return `Evening, ${name}.`;
    return `Night owl hours, ${name}.`;
  }

  function greetingLine() {
    const rows = globalThis.YOMU_GREETINGS?.lines;
    if (!Array.isArray(rows) || !rows.length) return 'Your next chapter is waiting.';
    const bucket = greetingBucket();
    const pool = rows.filter((row) => Array.isArray(row) && row[2] === bucket);
    const list = pool.length ? pool : rows;
    const tone = text(TONE_KEY, 'mixed');
    // The greeting pack predates the profile control and not every line has a
    // semantic tone tag. Tone therefore changes the deterministic salt rather
    // than pretending metadata exists where it does not.
    const day = Math.floor(Date.now() / 86400000);
    const salt = [...(profileName() + tone)].reduce((sum, c) => sum + c.charCodeAt(0), 0);
    return String(list[(day + salt) % list.length]?.[0] || 'One more chapter. Surely.');
  }

  function ensureGreetings() {
    if (globalThis.YOMU_GREETINGS || document.querySelector('script[data-yhub-greetings]')) return;
    const script = document.createElement('script');
    script.src = '/yomu-greetings.js';
    script.defer = true;
    script.dataset.yhubGreetings = '1';
    script.onload = () => mountHome(true);
    document.head.append(script);
  }

  function collectionStats() {
    const c = json('yomu.v1.collection', {});
    const library = Array.isArray(c?.library) ? c.library : [];
    const sources = Array.isArray(c?.sources) ? c.sources : [];
    const enabled = sources.filter((s) => s && s.enabled !== false).length;
    return { titles: library.length, sources: enabled };
  }

  function existingResumeControl() {
    const box = document.querySelector('#yomu-continue');
    if (!box) return null;
    return box.querySelector('a[href],button');
  }

  function mountHome(force = false) {
    if (location.pathname !== '/' && location.pathname !== '/index.html') return;
    const main = document.querySelector('.g-main');
    if (!main) return;
    const existing = document.getElementById('yhub-home');
    if (existing && !force) return;
    existing?.remove();

    const stats = collectionStats();
    const resume = existingResumeControl();
    const home = document.createElement('section');
    home.id = 'yhub-home';
    home.className = 'yhub-home';
    home.innerHTML = `<div class="yhub-welcome">
      <div class="yhub-kicker">Your reading room</div>
      <h1>${escapeHTML(plainGreeting())}</h1>
      <p>${escapeHTML(greetingLine())}</p>
      <div class="yhub-welcome__actions">
        <button class="yhub-btn primary" type="button" data-yhub-resume>${resume ? 'Continue reading' : 'Open library'}</button>
        <a class="yhub-btn ghost" href="/find.html" style="display:inline-flex;align-items:center;text-decoration:none">Discover</a>
        <button class="yhub-btn ghost" type="button" data-yhub-reader-settings>Reader Deck</button>
      </div>
    </div>
    <div class="yhub-side">
      <div class="yhub-status-card"><div class="yhub-status-row"><span class="yhub-kicker">Library</span><i class="yhub-dot"></i></div><b>${stats.titles || 'Your'} ${stats.titles === 1 ? 'title' : 'titles'}</b><small>One shelf even when a source changes underneath it.</small></div>
      <div class="yhub-status-card"><div class="yhub-status-row"><span class="yhub-kicker">Smart Source</span><i class="yhub-dot"></i></div><b>${stats.sources ? stats.sources + ' enabled' : 'Ready'}</b><small>Source controls stay available; routing does not need to dominate Home.</small></div>
    </div>`;
    main.prepend(home);

    home.querySelector('[data-yhub-resume]')?.addEventListener('click', () => {
      const live = existingResumeControl();
      if (live) live.click(); else location.href = '/library';
    });
    home.querySelector('[data-yhub-reader-settings]')?.addEventListener('click', () => openProfile('reader'));
    mountPowerDeck();
  }

  function mountPowerDeck() {
    if (location.pathname !== '/' && location.pathname !== '/index.html') return;
    const main = document.querySelector('.g-main');
    if (!main || document.getElementById('yhub-power')) return;
    const section = document.createElement('section');
    section.id = 'yhub-power';
    section.className = 'yhub-power';
    section.innerHTML = `<div class="yhub-power__head"><h2>Everything is still here</h2><p>Power when you need it, quiet when you do not.</p></div>
      <div class="yhub-power__grid">
        <a class="yhub-tool" href="/downloads.html"><b>Downloads</b><span>Offline chapters, queue and storage</span></a>
        <a class="yhub-tool" href="/you.html"><b>Your Yomu</b><span>Profile, tracking, history and personal settings</span></a>
        <a class="yhub-tool" href="/sources"><b>Sources</b><span>Packs, repositories, Fabric and diagnostics</span></a>
        <a class="yhub-tool" href="/settings"><b>Reader & app</b><span>Appearance, reading behavior and advanced controls</span></a>
      </div>`;
    main.append(section);
  }

  /* ------------------------------------------------------------------ */
  /* Profile sheet                                                       */
  /* ------------------------------------------------------------------ */
  let backdrop = null;
  let profileSheet = null;

  function closeProfile() {
    profileSheet?.classList.remove('is-open');
    backdrop?.classList.remove('is-open');
  }

  function openProfile(focus = 'profile') {
    if (!profileSheet) buildProfileSheet();
    renderProfileSheet(focus);
    requestAnimationFrame(() => {
      backdrop.classList.add('is-open');
      profileSheet.classList.add('is-open');
    });
  }

  function buildProfileSheet() {
    backdrop = document.createElement('div');
    backdrop.className = 'yhub-backdrop';
    backdrop.addEventListener('click', closeProfile);
    profileSheet = document.createElement('aside');
    profileSheet.className = 'yhub-sheet';
    profileSheet.setAttribute('aria-label', 'Customize Yomu');
    document.body.append(backdrop, profileSheet);
  }

  function renderProfileSheet(focus = 'profile') {
    const currentAvatar = avatarId();
    const appearance = text(APPEARANCE_KEY, 'system');
    const tone = text(TONE_KEY, 'mixed');
    const density = text(DENSITY_KEY, 'balanced');
    profileSheet.innerHTML = `<div class="yhub-sheet__head">
      <img src="${avatarURL(currentAvatar)}" alt=""><div><h2>${focus === 'reader' ? 'Reader Deck' : 'Make Yomu yours'}</h2><p>Preferences stay on this device unless Yomu already syncs them.</p></div>
      <button class="yhub-close" type="button" aria-label="Close">×</button>
    </div>
    <div class="yhub-group"><label class="yhub-label" for="yhub-name">Display name</label><input class="yhub-input" id="yhub-name" maxlength="18" value="${escapeHTML(profileName() === 'Reader' ? '' : profileName())}" placeholder="Reader"></div>
    <div class="yhub-group"><span class="yhub-label">Reader avatar</span><div class="yhub-avatars">${AVATARS.map(([id,label]) => `<button class="yhub-avatar" type="button" data-avatar="${id}" aria-pressed="${id === currentAvatar}" title="${escapeHTML(label)}"><img src="${avatarURL(id)}" alt="${escapeHTML(label)}"></button>`).join('')}</div></div>
    <div class="yhub-group"><span class="yhub-label">Appearance</span><div class="yhub-options">${['system','light','dark'].map((v) => `<button class="yhub-option" type="button" data-appearance="${v}" aria-pressed="${appearance === v}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}</div></div>
    <div class="yhub-group"><span class="yhub-label">Greeting mood</span><div class="yhub-options">${['mixed','dark','wholesome','neutral','friendly'].map((v) => `<button class="yhub-option" type="button" data-tone="${v}" aria-pressed="${tone === v}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}</div></div>
    <div class="yhub-group"><span class="yhub-label">Home density</span><div class="yhub-options">${['calm','balanced','dense'].map((v) => `<button class="yhub-option" type="button" data-density="${v}" aria-pressed="${density === v}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}</div><div class="yhub-note">Density changes presentation, not capability. Sources, downloads, trackers and diagnostics remain available.</div></div>
    <div class="yhub-group"><span class="yhub-label">First run</span><div class="yhub-options"><a class="yhub-btn ghost" href="/start#redo" style="display:inline-flex;align-items:center;text-decoration:none">Replay onboarding</a></div></div>
    <button class="yhub-btn primary" type="button" data-save style="width:100%">Save</button>`;

    profileSheet.querySelector('.yhub-close').onclick = closeProfile;
    let pendingAvatar = currentAvatar;
    let pendingAppearance = appearance;
    let pendingTone = tone;
    let pendingDensity = density;

    profileSheet.querySelectorAll('[data-avatar]').forEach((button) => button.onclick = () => {
      pendingAvatar = button.dataset.avatar;
      profileSheet.querySelectorAll('[data-avatar]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      profileSheet.querySelector('.yhub-sheet__head img').src = avatarURL(pendingAvatar);
    });
    profileSheet.querySelectorAll('[data-appearance]').forEach((button) => button.onclick = () => {
      pendingAppearance = button.dataset.appearance;
      profileSheet.querySelectorAll('[data-appearance]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      document.documentElement.dataset.mode = pendingAppearance;
    });
    profileSheet.querySelectorAll('[data-tone]').forEach((button) => button.onclick = () => {
      pendingTone = button.dataset.tone;
      profileSheet.querySelectorAll('[data-tone]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    });
    profileSheet.querySelectorAll('[data-density]').forEach((button) => button.onclick = () => {
      pendingDensity = button.dataset.density;
      profileSheet.querySelectorAll('[data-density]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    });
    profileSheet.querySelector('[data-save]').onclick = () => {
      const wantedName = profileSheet.querySelector('#yhub-name').value.trim().slice(0, 18);
      const circle = json(CIRCLE_KEY, {}) || {};
      if (wantedName) store(CIRCLE_KEY, { ...circle, name: wantedName });
      else if (circle.name) { const next = { ...circle }; delete next.name; store(CIRCLE_KEY, next); }
      store(AVATAR_KEY, { kind: 'preset', id: pendingAvatar });
      try {
        localStorage.setItem(APPEARANCE_KEY, pendingAppearance);
        localStorage.setItem(TONE_KEY, pendingTone);
        localStorage.setItem(DENSITY_KEY, pendingDensity);
      } catch {}
      document.documentElement.dataset.mode = pendingAppearance;
      document.documentElement.dataset.yhubDensity = pendingDensity;
      mountProfileTrigger(true);
      mountHome(true);
      closeProfile();
    };
  }

  function mountProfileTrigger(force = false) {
    if (location.pathname.startsWith('/read/')) return;
    let button = document.querySelector('.yhub-profile-trigger');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'yhub-profile-trigger';
      button.addEventListener('click', () => openProfile('profile'));
      document.body.append(button);
    }
    if (force || !button.firstChild) {
      button.innerHTML = `<img src="${avatarURL()}" alt="">`;
      button.setAttribute('aria-label', `Customize ${profileName()}'s Yomu`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Reader Deck                                                         */
  /* ------------------------------------------------------------------ */
  let readerPanel = null;
  let readerPrefs = { ...DEFAULT_READER };

  function seriesKey() {
    const query = new URLSearchParams(location.search);
    const explicit = query.get('series') || query.get('manga') || query.get('title');
    if (explicit) return explicit;
    const chapter = decodeURIComponent(location.pathname.split('/read/')[1] || '');
    return chapter.split(/[:/]/)[0] || 'default';
  }

  function loadReader() {
    const base = { ...DEFAULT_READER, ...(json(READER_KEY, {}) || {}) };
    if (!base.rememberSeries) return base;
    const all = json(READER_SERIES_KEY, {}) || {};
    return { ...base, ...(all[seriesKey()] || {}) };
  }

  function saveReader() {
    store(READER_KEY, readerPrefs);
    if (readerPrefs.rememberSeries) {
      const all = json(READER_SERIES_KEY, {}) || {};
      all[seriesKey()] = readerPrefs;
      store(READER_SERIES_KEY, all);
    }
    applyReader();
  }

  function applyReader() {
    const root = document.documentElement;
    root.dataset.yhubReader = readerPrefs.mode;
    root.dataset.yhubFit = readerPrefs.fit;
    root.dataset.yhubReaderBg = readerPrefs.background;
    root.style.setProperty('--yhub-reader-gap', `${Number(readerPrefs.gap) || 0}px`);
    root.toggleAttribute('data-yhub-crop', !!readerPrefs.crop);
    document.dispatchEvent(new CustomEvent('yomu:reader-ui-pref', {
      detail: { ...readerPrefs, orientation: matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait' }
    }));
  }

  function presetDescription(mode) {
    if (mode === 'manga') return 'Paged · RTL · smart fit';
    if (mode === 'comic') return 'Paged · LTR · smart fit';
    return 'Continuous · width fit';
  }

  function tryExistingReaderMode(mode) {
    const labels = mode === 'manga' ? ['rtl','right to left','paged']
      : mode === 'comic' ? ['ltr','left to right','paged']
      : ['scroll','vertical','long strip','continuous'];
    const buttons = [...document.querySelectorAll('button')].filter((b) => !b.closest('.yhub-reader-panel'));
    const found = buttons.find((b) => labels.some((label) => (b.textContent || '').toLowerCase().includes(label)));
    if (found) found.click();
  }

  function renderReaderPanel() {
    if (!readerPanel) return;
    readerPanel.innerHTML = `<div class="yhub-reader-head"><div><b>Reader Deck</b><small>${matchMedia('(orientation: landscape)').matches ? 'Side controls · landscape' : 'Bottom controls · portrait'}</small></div><button class="yhub-close" type="button" data-rclose aria-label="Close">×</button></div>
      <div class="yhub-reader-presets">${['manga','manhwa','comic'].map((mode) => `<button class="yhub-reader-preset" type="button" data-mode="${mode}" aria-pressed="${readerPrefs.mode === mode}"><b>${mode[0].toUpperCase()+mode.slice(1)}</b><span>${presetDescription(mode)}</span></button>`).join('')}</div>
      <div class="yhub-reader-grid">
        <button class="yhub-reader-control" type="button" data-fit><b>↔</b>Fit<br>${escapeHTML(readerPrefs.fit)}</button>
        <button class="yhub-reader-control" type="button" data-gap><b>⇵</b>Gap<br>${readerPrefs.gap}px</button>
        <button class="yhub-reader-control" type="button" data-bg><b>◐</b>Background<br>${escapeHTML(readerPrefs.background)}</button>
        <button class="yhub-reader-control" type="button" data-crop><b>⌗</b>Crop<br>${readerPrefs.crop ? 'on' : 'off'}</button>
        <button class="yhub-reader-control" type="button" data-fullscreen><b>⛶</b>Fullscreen<br>toggle</button>
      </div>
      <div class="yhub-reader-row"><span>Remember for this series</span><button class="yhub-toggle" type="button" data-remember aria-pressed="${readerPrefs.rememberSeries}"></button></div>
      <div class="yhub-reader-row"><button class="yhub-btn ghost" type="button" data-advanced style="color:#f5f6f8">Advanced settings</button><span>${readerPrefs.prefetch} pages ahead</span></div>
      <div class="yhub-reader-advanced"><label class="yhub-label" style="color:#ffffff85">Page gap · ${readerPrefs.gap}px</label><input class="yhub-range" type="range" min="0" max="24" step="2" value="${readerPrefs.gap}" data-gap-range><label class="yhub-label" style="color:#ffffff85;margin-top:14px">Prefetch · ${readerPrefs.prefetch} pages</label><input class="yhub-range" type="range" min="1" max="10" value="${readerPrefs.prefetch}" data-prefetch></div>`;

    readerPanel.querySelector('[data-rclose]').onclick = () => readerPanel.classList.remove('is-open');
    readerPanel.querySelectorAll('[data-mode]').forEach((button) => button.onclick = () => {
      readerPrefs.mode = button.dataset.mode;
      // Preset defaults. The reader's own controls still win when they expose
      // a matching switch; this only supplies a sane first choice.
      if (readerPrefs.mode === 'manhwa') { readerPrefs.fit = 'width'; readerPrefs.gap = 0; }
      else readerPrefs.fit = 'smart';
      tryExistingReaderMode(readerPrefs.mode);
      saveReader();
      renderReaderPanel();
    });
    readerPanel.querySelector('[data-fit]').onclick = () => {
      const values = ['width','smart','height','original'];
      readerPrefs.fit = values[(values.indexOf(readerPrefs.fit) + 1) % values.length]; saveReader(); renderReaderPanel();
    };
    readerPanel.querySelector('[data-gap]').onclick = () => {
      readerPrefs.gap = readerPrefs.gap >= 12 ? 0 : readerPrefs.gap + 4; saveReader(); renderReaderPanel();
    };
    readerPanel.querySelector('[data-bg]').onclick = () => {
      const values = ['black','gray','paper'];
      readerPrefs.background = values[(values.indexOf(readerPrefs.background) + 1) % values.length]; saveReader(); renderReaderPanel();
    };
    readerPanel.querySelector('[data-crop]').onclick = () => { readerPrefs.crop = !readerPrefs.crop; saveReader(); renderReaderPanel(); };
    readerPanel.querySelector('[data-remember]').onclick = () => { readerPrefs.rememberSeries = !readerPrefs.rememberSeries; saveReader(); renderReaderPanel(); };
    readerPanel.querySelector('[data-fullscreen]').onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {}
    };
    readerPanel.querySelector('[data-advanced]').onclick = () => readerPanel.classList.toggle('is-advanced');
    readerPanel.querySelector('[data-gap-range]').oninput = (event) => { readerPrefs.gap = Number(event.target.value); saveReader(); renderReaderPanel(); readerPanel.classList.add('is-advanced'); };
    readerPanel.querySelector('[data-prefetch]').oninput = (event) => { readerPrefs.prefetch = Number(event.target.value); saveReader(); renderReaderPanel(); readerPanel.classList.add('is-advanced'); };
  }

  function mountReader() {
    if (!location.pathname.startsWith('/read/')) return;
    if (document.querySelector('.yhub-reader-trigger')) return;
    readerPrefs = loadReader();
    applyReader();

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'yhub-reader-trigger';
    trigger.setAttribute('aria-label', 'Open Reader Deck');
    trigger.innerHTML = `<svg viewBox="0 0 195 168" aria-hidden="true"><polygon points="8,12.75 79,47.02 79,155.25 8,120.98" fill="currentColor"></polygon><polygon points="116,47.02 187,12.75 187,120.98 116,155.25" fill="currentColor"></polygon></svg><span>Reader</span>`;
    readerPanel = document.createElement('aside');
    readerPanel.className = 'yhub-reader-panel';
    readerPanel.setAttribute('aria-label', 'Reader Deck');
    document.body.append(trigger, readerPanel);
    renderReaderPanel();
    trigger.onclick = () => { renderReaderPanel(); readerPanel.classList.toggle('is-open'); };

    const orientation = matchMedia('(orientation: landscape)');
    const onOrientation = () => { if (readerPanel?.isConnected) renderReaderPanel(); applyReader(); };
    orientation.addEventListener?.('change', onOrientation);
  }

  /* ------------------------------------------------------------------ */
  /* Start / route-safe mounting                                         */
  /* ------------------------------------------------------------------ */
  function mountStart() {
    if (!location.pathname.startsWith('/start')) return;
    document.body?.classList.add('yhub-start');
  }

  let lastURL = location.href;
  let scheduled = false;
  function pass() {
    scheduled = false;
    if (location.href !== lastURL) {
      lastURL = location.href;
      document.querySelector('#yhub-home')?.remove();
      document.querySelector('#yhub-power')?.remove();
      document.querySelector('.yhub-reader-trigger')?.remove();
      document.querySelector('.yhub-reader-panel')?.remove();
      readerPanel = null;
    }
    mountStart();
    mountProfileTrigger();
    mountHome();
    mountReader();
  }
  function schedulePass() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(pass);
  }

  function start() {
    const savedDensity = text(DENSITY_KEY, 'balanced');
    document.documentElement.dataset.yhubDensity = savedDensity;
    ensureGreetings();
    mountSplash();
    pass();
    new MutationObserver(schedulePass).observe(document.body, { childList: true, subtree: true });
    addEventListener('popstate', schedulePass);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
  else start();
})();
