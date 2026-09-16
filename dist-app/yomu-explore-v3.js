/* Yomu UI/UX Exploration v3
 * Additive branch-only behavior. No source/Hunter/Fabric code is touched here.
 */
(() => {
  'use strict';

  const PROFILE_KEY = 'yomu.explore.v3.profile';
  const READER_KEY = 'yomu.explore.v3.reader.default';
  const SERIES_READER_KEY = 'yomu.explore.v3.reader.series';
  const AVATARS = [
    ['/brand/avatars/01_sleep_deprived_reader.webp', 'Night owl'],
    ['/brand/avatars/02_sexy_romance_reader.webp', 'Romance reader'],
    ['/brand/avatars/03_chill_dinosaur_reader.webp', 'Chill dino'],
    ['/brand/avatars/04_undead_knight_reader.webp', 'Undead knight'],
    ['/brand/avatars/05_shocked_cliffhanger_reader.webp', 'Cliffhanger victim'],
  ];
  const DEFAULT_PROFILE = { name: 'Reader', avatar: 3, tone: 'mixed', theme: 'system', density: 'calm' };
  const DEFAULT_READER = { mode: 'manhwa', fit: 'width', gap: 0, background: 'black', prefetch: 6, crop: false, rememberSeries: true };

  const safeJSON = (key, fallback) => {
    try { return { ...fallback, ...(JSON.parse(localStorage.getItem(key) || '{}') || {}) }; }
    catch { return { ...fallback }; }
  };
  const saveJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);

  let profile = safeJSON(PROFILE_KEY, DEFAULT_PROFILE);
  let reader = safeJSON(READER_KEY, DEFAULT_READER);

  function resolvedTheme() {
    if (profile.theme === 'light' || profile.theme === 'dark') return profile.theme;
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme() {
    const theme = resolvedTheme();
    document.documentElement.dataset.yxTheme = theme;
    document.documentElement.style.setProperty('--yx-accent', '#ef695f');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && !location.pathname.startsWith('/read/')) meta.content = theme === 'light' ? '#f5f2ec' : '#070708';
    document.dispatchEvent(new CustomEvent('yomu:explore-theme', { detail: { theme, preference: profile.theme } }));
  }

  function mountSplash() {
    if (document.querySelector('.yx-splash')) return;
    const theme = resolvedTheme();
    const el = document.createElement('div');
    el.className = 'yx-splash';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', 'Opening Yomu');
    el.innerHTML = `<div class="yx-splash__inner">
      <img class="yx-splash__mark" src="/brand/${theme === 'light' ? 'yomu-loader-ink.webp' : 'yomu-loader-paper.webp'}" alt="">
      <img class="yx-splash__word" src="/brand/${theme === 'light' ? 'yomu-wordmark-ink.svg' : 'yomu-wordmark-ivory.svg'}" alt="Yomu">
      <div class="yx-splash__line">Opening your reading room</div>
      <div class="yx-splash__track" aria-hidden="true"></div>
    </div>`;
    document.body.append(el);
    const hide = () => {
      setTimeout(() => {
        el.classList.add('is-out');
        setTimeout(() => el.remove(), 320);
      }, 360);
    };
    if (document.readyState === 'complete') hide();
    else window.addEventListener('load', hide, { once:true });
    setTimeout(hide, 1500);
  }

  function enhanceLoadingStates(root = document) {
    root.querySelectorAll?.('.status-box').forEach((box) => {
      if (box.dataset.yxLoader) return;
      const spin = box.querySelector('.spin');
      if (!spin) return;
      spin.style.display = 'none';
      const mark = document.createElement('span');
      mark.className = 'yx-mini-loader';
      mark.setAttribute('aria-hidden', 'true');
      spin.after(mark);
      box.dataset.yxLoader = '1';
    });
  }

  function timeBucket() {
    const h = new Date().getHours();
    return h < 12 ? 'm' : h < 17 ? 'a' : h < 22 ? 'e' : 'l';
  }

  function greetingLine() {
    const rows = window.YOMU_GREETINGS?.lines;
    if (!Array.isArray(rows) || !rows.length) return 'Your next chapter is waiting.';
    const time = timeBucket();
    const toneMap = { dark:'d', wholesome:'w', neutral:'n', friendly:'f' };
    let pool = rows.filter((r) => Array.isArray(r) && r[2] === time);
    if (profile.tone !== 'mixed' && toneMap[profile.tone]) {
      const toned = pool.filter((r) => r[1] === toneMap[profile.tone]);
      if (toned.length) pool = toned;
    }
    if (!pool.length) pool = rows;
    const day = Math.floor(Date.now() / 86400000);
    const salt = String(profile.name || 'Reader').split('').reduce((a,c) => a + c.charCodeAt(0), 0);
    return String(pool[(day + salt) % pool.length]?.[0] || 'One more chapter. Surely.');
  }

  function helloText() {
    const h = new Date().getHours();
    const daypart = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 22 ? 'Evening' : 'Still awake';
    const name = (profile.name || 'Reader').trim().slice(0, 28);
    return `${daypart}, ${name}.`;
  }

  function mountGreeting() {
    const home = location.pathname === '/' || location.pathname === '/index.html';
    if (!home) return;
    const main = document.querySelector('.g-main');
    if (!main) return;
    let card = main.querySelector('.yx-greeting');
    if (!card) {
      card = document.createElement('section');
      card.className = 'yx-greeting';
      main.prepend(card);
    }
    card.innerHTML = `<img class="yx-greeting__avatar" src="${AVATARS[Number(profile.avatar)]?.[0] || AVATARS[0][0]}" alt="">
      <div class="yx-greeting__copy"><h1 class="yx-greeting__hello">${escapeHTML(helloText())}</h1><div class="yx-greeting__line">${escapeHTML(greetingLine())}</div></div>
      <div class="yx-greeting__badge">Your reading room</div>`;
  }

  function sheetBackdrop() {
    let backdrop = document.querySelector('.yx-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'yx-backdrop';
      backdrop.addEventListener('click', closeSheets);
      document.body.append(backdrop);
    }
    return backdrop;
  }

  function closeSheets() {
    document.querySelectorAll('.yx-sheet.is-open').forEach((x) => x.classList.remove('is-open'));
    document.querySelector('.yx-backdrop')?.classList.remove('is-open');
  }

  function openProfile() {
    let sheet = document.querySelector('#yx-profile-sheet');
    if (!sheet) {
      sheet = document.createElement('aside');
      sheet.id = 'yx-profile-sheet';
      sheet.className = 'yx-sheet';
      sheet.setAttribute('aria-label', 'Customize Yomu profile');
      document.body.append(sheet);
    }
    renderProfileSheet(sheet);
    requestAnimationFrame(() => {
      sheetBackdrop().classList.add('is-open');
      sheet.classList.add('is-open');
      sheet.querySelector('input')?.focus({ preventScroll:true });
    });
  }

  function renderProfileSheet(sheet) {
    const avatar = AVATARS[Number(profile.avatar)] || AVATARS[0];
    sheet.innerHTML = `<div class="yx-sheet__head">
      <img src="${avatar[0]}" alt=""><div><h2>Make Yomu yours</h2><p>Profile, greeting, appearance. Stored on this device.</p></div>
      <button class="yx-close" type="button" aria-label="Close">×</button>
    </div>
    <div class="yx-group"><label class="yx-label" for="yx-name">Display name</label><input class="yx-input" id="yx-name" maxlength="28" value="${escapeHTML(profile.name)}" placeholder="Reader"></div>
    <div class="yx-group"><span class="yx-label">Reader avatar</span><div class="yx-avatars">${AVATARS.map((a,i) => `<button class="yx-avatar" type="button" data-yx-avatar="${i}" aria-pressed="${Number(profile.avatar)===i}" title="${escapeHTML(a[1])}"><img src="${a[0]}" alt="${escapeHTML(a[1])}"></button>`).join('')}</div></div>
    <div class="yx-group"><span class="yx-label">Greeting mood</span><div class="yx-options">${[['mixed','Mixed'],['dark','Dark'],['wholesome','Wholesome'],['neutral','Neutral'],['friendly','Friendly']].map(([v,l]) => `<button class="yx-option" type="button" data-yx-tone="${v}" aria-pressed="${profile.tone===v}">${l}</button>`).join('')}</div></div>
    <div class="yx-group"><span class="yx-label">Appearance</span><div class="yx-options">${[['system','System'],['light','Light'],['dark','Dark']].map(([v,l]) => `<button class="yx-option" type="button" data-yx-theme-choice="${v}" aria-pressed="${profile.theme===v}">${l}</button>`).join('')}</div></div>
    <div class="yx-group"><span class="yx-label">Home density</span><div class="yx-options">${[['calm','Calm'],['balanced','Balanced'],['dense','Dense']].map(([v,l]) => `<button class="yx-option" type="button" data-yx-density="${v}" aria-pressed="${profile.density===v}">${l}</button>`).join('')}</div><div class="yx-note">Density changes presentation only. Downloads, trackers, repositories, source controls, history and advanced tools stay available.</div></div>
    <button class="yx-save" type="button" id="yx-save-profile">Save profile</button>`;

    sheet.querySelector('.yx-close').onclick = closeSheets;
    sheet.querySelectorAll('[data-yx-avatar]').forEach((b) => b.onclick = () => {
      profile.avatar = Number(b.dataset.yxAvatar); renderProfileSheet(sheet);
    });
    sheet.querySelectorAll('[data-yx-tone]').forEach((b) => b.onclick = () => {
      profile.tone = b.dataset.yxTone; renderProfileSheet(sheet);
    });
    sheet.querySelectorAll('[data-yx-theme-choice]').forEach((b) => b.onclick = () => {
      profile.theme = b.dataset.yxThemeChoice; applyTheme(); renderProfileSheet(sheet);
    });
    sheet.querySelectorAll('[data-yx-density]').forEach((b) => b.onclick = () => {
      profile.density = b.dataset.yxDensity; document.documentElement.dataset.yxDensity = profile.density; renderProfileSheet(sheet);
    });
    sheet.querySelector('#yx-save-profile').onclick = () => {
      profile.name = (sheet.querySelector('#yx-name').value || 'Reader').trim().slice(0, 28) || 'Reader';
      saveJSON(PROFILE_KEY, profile);
      applyTheme();
      document.documentElement.dataset.yxDensity = profile.density;
      mountGreeting();
      mountProfileButton(true);
      closeSheets();
    };
  }

  function mountProfileButton(refresh = false) {
    const tools = document.querySelector('.header-tools');
    if (!tools) return;
    let button = tools.querySelector('.yx-profile-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'yx-profile-button';
      button.addEventListener('click', openProfile);
      tools.prepend(button);
    }
    if (refresh || !button.dataset.ready) {
      const avatar = AVATARS[Number(profile.avatar)] || AVATARS[0];
      button.innerHTML = `<img src="${avatar[0]}" alt=""><span>${escapeHTML(profile.name || 'Reader')}</span>`;
      button.setAttribute('aria-label', `Customize ${profile.name || 'Reader'} profile`);
      button.dataset.ready = '1';
    }
  }

  function currentSeriesKey() {
    const params = new URLSearchParams(location.search);
    const fromQuery = params.get('series') || params.get('manga') || params.get('title');
    if (fromQuery) return fromQuery;
    const chapter = decodeURIComponent(location.pathname.split('/read/')[1] || '');
    return chapter.split(/[:/]/)[0] || 'default';
  }

  function loadReaderPrefs() {
    const base = safeJSON(READER_KEY, DEFAULT_READER);
    if (!base.rememberSeries) return base;
    try {
      const all = JSON.parse(localStorage.getItem(SERIES_READER_KEY) || '{}');
      return { ...base, ...(all[currentSeriesKey()] || {}) };
    } catch { return base; }
  }

  function saveReaderPrefs() {
    saveJSON(READER_KEY, reader);
    if (reader.rememberSeries) {
      try {
        const all = JSON.parse(localStorage.getItem(SERIES_READER_KEY) || '{}');
        all[currentSeriesKey()] = reader;
        localStorage.setItem(SERIES_READER_KEY, JSON.stringify(all));
      } catch {}
    }
    applyReaderPrefs();
  }

  function applyReaderPrefs() {
    const root = document.documentElement;
    root.dataset.yxReader = reader.mode;
    root.dataset.yxFit = reader.fit;
    root.dataset.yxReaderBg = reader.background;
    root.style.setProperty('--yx-reader-gap', `${Number(reader.gap) || 0}px`);
    document.body?.classList.toggle('yx-reader-crop', !!reader.crop);
    document.dispatchEvent(new CustomEvent('yomu:reader-prefs', { detail: { ...reader, orientation: root.dataset.yxOrientation } }));
  }

  function orientationName() {
    return matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait';
  }

  function applyOrientation() {
    const o = orientationName();
    document.documentElement.dataset.yxOrientation = o;
    if (document.body) {
      document.body.classList.toggle('yx-orientation-landscape', o === 'landscape');
      document.body.classList.toggle('yx-orientation-portrait', o === 'portrait');
    }
    const hint = document.querySelector('.yx-reader-launch .yx-orient');
    if (hint) hint.textContent = o === 'landscape' ? 'side controls' : 'bottom controls';
    document.dispatchEvent(new CustomEvent('yomu:orientation', { detail: { orientation:o, width:innerWidth, height:innerHeight } }));
  }

  function modeDescription(mode) {
    if (mode === 'manga') return 'Paged · RTL · smart fit';
    if (mode === 'comic') return 'Paged · LTR · smart fit';
    return 'Continuous · width fit';
  }

  function mountReaderDeck() {
    if (!location.pathname.startsWith('/read/')) return;
    reader = loadReaderPrefs();
    applyReaderPrefs();
    if (document.querySelector('.yx-reader-launch')) return;

    const launch = document.createElement('button');
    launch.type = 'button';
    launch.className = 'yx-reader-launch';
    launch.innerHTML = `<img src="/brand/yomu-mark-paper.svg" alt=""><span>Reader</span><span class="yx-orient"></span>`;
    launch.setAttribute('aria-label', 'Open reader controls');

    const panel = document.createElement('aside');
    panel.className = 'yx-reader-sheet';
    panel.setAttribute('aria-label', 'Reader controls');
    document.body.append(launch, panel);

    const render = () => {
      panel.innerHTML = `<div class="yx-reader-head"><img src="/brand/yomu-mark-paper.svg" alt=""><div><strong>Reading mode</strong><small>${escapeHTML(modeDescription(reader.mode))}</small></div><button type="button" aria-label="Close">×</button></div>
      <div class="yx-reader-grid">${[['manga','Manga','RTL pages'],['manhwa','Manhwa','Long strip'],['comic','Comic','LTR pages']].map(([v,l,s]) => `<button class="yx-reader-mode" data-yx-mode="${v}" aria-pressed="${reader.mode===v}"><b>${l}</b><span>${s}</span></button>`).join('')}</div>
      <div style="height:10px"></div>
      <label class="yx-reader-row"><span>Fit</span><select data-yx-reader-input="fit"><option value="smart" ${reader.fit==='smart'?'selected':''}>Smart fit</option><option value="width" ${reader.fit==='width'?'selected':''}>Width</option><option value="height" ${reader.fit==='height'?'selected':''}>Height</option><option value="original" ${reader.fit==='original'?'selected':''}>Original</option></select></label>
      <label class="yx-reader-row"><span>Page gap</span><input data-yx-reader-input="gap" type="range" min="0" max="24" step="2" value="${Number(reader.gap)||0}"></label>
      <label class="yx-reader-row"><span>Background</span><select data-yx-reader-input="background"><option value="black" ${reader.background==='black'?'selected':''}>Black</option><option value="gray" ${reader.background==='gray'?'selected':''}>Gray</option><option value="paper" ${reader.background==='paper'?'selected':''}>Paper</option></select></label>
      <label class="yx-reader-row"><span>Prefetch pages</span><input data-yx-reader-input="prefetch" type="range" min="1" max="8" value="${Number(reader.prefetch)||6}"></label>
      <label class="yx-reader-row"><span>Crop borders</span><input data-yx-reader-input="crop" type="checkbox" ${reader.crop?'checked':''}></label>
      <label class="yx-reader-row"><span>Remember for this series</span><input data-yx-reader-input="rememberSeries" type="checkbox" ${reader.rememberSeries?'checked':''}></label>
      <button class="yx-save" type="button" id="yx-fullscreen" style="margin-top:10px">Toggle fullscreen</button>
      <div class="yx-reader-hint"><b>Adaptive controls:</b> portrait keeps this near your thumb; landscape moves it into a compact side rail. Manga/Comic can use the extra width for paged layouts, while Manhwa stays continuous.</div>`;
      panel.querySelector('.yx-reader-head button').onclick = () => panel.classList.remove('is-open');
      panel.querySelectorAll('[data-yx-mode]').forEach((b) => b.onclick = () => {
        reader.mode = b.dataset.yxMode;
        if (reader.mode === 'manhwa') { reader.fit = 'width'; reader.gap = 0; }
        else { reader.fit = 'smart'; if (reader.gap === 0) reader.gap = 8; }
        saveReaderPrefs(); render();
      });
      panel.querySelectorAll('[data-yx-reader-input]').forEach((input) => {
        input.onchange = () => {
          const key = input.dataset.yxReaderInput;
          if (input.type === 'checkbox') reader[key] = input.checked;
          else if (input.type === 'range') reader[key] = Number(input.value);
          else reader[key] = input.value;
          saveReaderPrefs();
        };
        if (input.type === 'range') input.oninput = input.onchange;
      });
      panel.querySelector('#yx-fullscreen').onclick = async () => {
        try {
          if (document.fullscreenElement) await document.exitFullscreen();
          else await document.documentElement.requestFullscreen();
        } catch {}
      };
    };
    render();
    launch.onclick = () => panel.classList.toggle('is-open');
    applyOrientation();
  }

  function keyboard() {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeSheets();
        document.querySelector('.yx-reader-sheet')?.classList.remove('is-open');
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault(); openProfile();
      }
    });
  }

  function tick() {
    mountGreeting();
    mountProfileButton();
    mountReaderDeck();
    enhanceLoadingStates();
  }

  function start() {
    applyTheme();
    document.documentElement.dataset.yxDensity = profile.density;
    applyOrientation();
    mountSplash();
    tick();
    keyboard();

    const observer = new MutationObserver((records) => {
      let useful = false;
      for (const record of records) if (record.addedNodes.length) { useful = true; break; }
      if (useful) tick();
    });
    observer.observe(document.body, { childList:true, subtree:true });

    let resizeRAF = 0;
    const orient = () => {
      cancelAnimationFrame(resizeRAF);
      resizeRAF = requestAnimationFrame(() => { applyOrientation(); applyReaderPrefs(); });
    };
    addEventListener('resize', orient, { passive:true });
    addEventListener('orientationchange', orient, { passive:true });
    matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (profile.theme === 'system') applyTheme(); });

    // Existing light/dark button can keep doing its own app-level theme work.
    // We mirror the intent into the exploration profile so its overlays stay coherent.
    document.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('button[aria-label*="mode" i]') : null;
      if (!button || !/light|dark/i.test(button.getAttribute('aria-label') || '')) return;
      setTimeout(() => {
        const label = button.getAttribute('aria-label') || '';
        profile.theme = /dark mode/i.test(label) ? 'light' : /light mode/i.test(label) ? 'dark' : profile.theme;
        saveJSON(PROFILE_KEY, profile); applyTheme();
      }, 0);
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
  else start();
})();
