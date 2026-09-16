/**
 * Yomu compiled-screen gate + UI exploration bootstrap.
 *
 * The adult-content behavior below is the same responsibility this file had on
 * main. The final block is branch-only: it loads the isolated v3 UI layer so
 * the experiment never needs to modify Hunter/Fabric or the Expo bundle.
 */
(() => {
  'use strict';

  const ADULT_KEY = 'yomu.v1.adult';
  const TITLES_KEY = 'yomu.v1.adultTitles';
  const BLUR_KEY = 'yomu.v1.adultBlur';
  const VEIL = 'data-yomu-veil';
  const BADGE = 'data-yomu-veil-badge';
  const SETTINGS_ROW_ID = 'yomu-adult-setting';

  const read = (key, fallback) => {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  };
  const adultAllowed = () => read(ADULT_KEY, 'off') === 'on';
  const blurAdult = () => read(BLUR_KEY, 'on') !== 'off';

  function adultTitles() {
    try {
      const raw = JSON.parse(localStorage.getItem(TITLES_KEY) || '[]');
      return new Set(Array.isArray(raw) ? raw.map(String) : []);
    } catch { return new Set(); }
  }

  function buildSettingsRow() {
    const label = document.createElement('div');
    label.className = 'group-label';
    label.id = SETTINGS_ROW_ID + '-label';
    label.textContent = 'Content';

    const group = document.createElement('section');
    group.className = 'settings-group glass';
    group.id = SETTINGS_ROW_ID;

    const row = document.createElement('a');
    row.className = 'setting-link';
    row.href = '/adult.html';
    row.style.textDecoration = 'none';

    const copy = document.createElement('div');
    copy.className = 'row-copy';
    const h3 = document.createElement('h3');
    h3.textContent = '18+ content';
    const small = document.createElement('small');
    small.textContent = adultAllowed()
      ? 'On. Adult titles appear only on the 18+ page.'
      : 'Off. Adult titles are hidden everywhere.';
    copy.append(h3, small);

    const chevron = document.createElement('span');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    chevron.style.cssText = 'color:var(--dim);font-size:20px;flex:none';
    row.append(copy, chevron);
    group.append(row);
    return { label, group };
  }

  function mountSettingsRow() {
    if (!location.pathname.startsWith('/settings')) return;
    if (document.getElementById(SETTINGS_ROW_ID)) return;
    const labels = [...document.querySelectorAll('.group-label')];
    const storage = labels.find((l) => /storage/i.test(l.textContent || ''));
    const anchor = storage ?? labels[labels.length - 1];
    if (!anchor?.parentNode) return;
    const { label, group } = buildSettingsRow();
    anchor.parentNode.insertBefore(label, anchor);
    anchor.parentNode.insertBefore(group, anchor);
  }

  function currentTitleKey() {
    const source = new URLSearchParams(location.search).get('source');
    if (!source) return null;
    const series = location.pathname.match(/^\/series\/([^/?#]+)/);
    if (series) return `${source}:${decodeURIComponent(series[1])}`;
    const reading = location.pathname.match(/^\/read\/([^/?#]+)/);
    if (reading) {
      const chapterId = decodeURIComponent(reading[1]);
      const head = chapterId.split(/[:/]/)[0];
      return head ? `${source}:${head}` : null;
    }
    return null;
  }

  let veilThisScreen = false;
  let revealed = false;

  function wrapsTightly(parent, el) {
    if (!parent) return false;
    const p = parent.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    if (!e.width || !e.height) return false;
    return p.width * p.height < e.width * e.height * 2;
  }

  function applyVeil() {
    const key = currentTitleKey();
    veilThisScreen = !!key && adultTitles().has(key) && blurAdult();
    const on = veilThisScreen && !revealed;
    const media = new Set([...document.images, ...document.querySelectorAll('.cover')]);

    for (const el of document.querySelectorAll(`[${VEIL}]`)) {
      if (!media.has(el)) el.removeAttribute(VEIL);
    }
    for (const el of document.querySelectorAll(`[${BADGE}]`)) el.removeAttribute(BADGE);

    for (const el of media) {
      if (!on) { el.removeAttribute(VEIL); continue; }
      el.setAttribute(VEIL, 'on');
      if (wrapsTightly(el.parentElement, el)) el.parentElement.setAttribute(BADGE, '');
    }
  }

  document.addEventListener('click', (event) => {
    if (!veilThisScreen || revealed) return;
    const holder = event.target instanceof Element
      ? event.target.closest(`[${BADGE}]`) ?? event.target.closest(`[${VEIL}="on"]`)
      : null;
    if (!holder) return;
    event.stopPropagation();
    event.preventDefault();
    revealed = true;
    applyVeil();
  }, true);

  let lastUrl = location.href;
  function tick() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      revealed = false;
    }
    mountSettingsRow();
    applyVeil();
  }

  const start = () => {
    tick();
    new MutationObserver(tick).observe(document.body, { childList:true, subtree:true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* Branch-only UI/UX exploration bootstrap. Remove this block to drop v3. */
(() => {
  if (!document.querySelector('link[data-yomu-explore-v3]')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/yomu-explore-v3.css';
    css.dataset.yomuExploreV3 = '1';
    document.head.append(css);
  }
  if (!document.querySelector('script[data-yomu-explore-v3]')) {
    const js = document.createElement('script');
    js.src = '/yomu-explore-v3.js';
    js.defer = true;
    js.dataset.yomuExploreV3 = '1';
    document.head.append(js);
  }
})();
