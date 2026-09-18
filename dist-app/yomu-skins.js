/**
 * Skins — a look, earned.
 *
 * Aurora and Paper are the app's two modes. A skin is a third thing: a
 * palette that wins over both while it is on, chosen on Your Yomu, kept on
 * this device only (the way theme is), and unlocked by Mori's stages so a
 * new look is something reading gets you. The Gilt skin is the reward for a
 * full bingo card.
 *
 * The palettes live in yomu-skins.css as overrides of the --au-* and --pa-*
 * source tokens, so every semantic token the app reads follows without this
 * file knowing a single colour. This file decides which skin is on and
 * whether the reader has earned it.
 */
(() => {
  'use strict';

  const KEY = 'yomu.v1.skin';
  const HOST_ID = 'yomu-skins';

  const browser = typeof document !== 'undefined';

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  /* Swatches are the palette's own values, repeated here only so the picker
     can draw a locked skin it is not allowed to apply. */
  const SKINS = [
    { id: '', name: 'Yomu', how: 'Aurora by night, Paper by day', swatch: ['#f5f2ec', '#080d14', '#b8791c'] },
    { id: 'autumn', name: 'Autumn paper', how: 'Mori reaches Fledgling', unlock: { stage: 2 }, swatch: ['#f1e7d6', '#e9dcc4', '#b5501f'] },
    { id: 'midnight', name: 'Midnight ink', how: 'Mori reaches Companion', unlock: { stage: 3 }, swatch: ['#05070d', '#121a2b', '#7aa2ff'] },
    { id: 'neon', name: 'Manhwa neon', how: 'Mori reaches Familiar', unlock: { stage: 4 }, swatch: ['#0b0616', '#1d1030', '#ff4fd8'] },
    { id: 'scanlation', name: 'Old scanlation', how: 'Mori reaches Sage', unlock: { stage: 5 }, swatch: ['#e9e2d3', '#f3ede0', '#b3261e'] },
    { id: 'gilt', name: 'Gilt', how: 'Fill a bingo card', unlock: { badge: 'bingo-card' }, swatch: ['#f7f1e3', '#fffaf0', '#9a7a1a'] },
  ];

  /** Pure: is this skin available to a reader in this state? */
  function unlocked(skin, state, stageLevel) {
    if (!skin.unlock) return true;
    if (skin.unlock.stage) return (stageLevel || 0) >= skin.unlock.stage;
    if (skin.unlock.badge) return !!(state?.earnedBadgeIds || []).includes(skin.unlock.badge);
    return false;
  }

  const current = () => {
    const value = readJSON(KEY, '');
    return typeof value === 'string' && SKINS.some((s) => s.id === value) ? value : '';
  };

  function apply(id) {
    if (!browser) return;
    if (id) document.documentElement.setAttribute('data-yomu-skin', id);
    else document.documentElement.removeAttribute('data-yomu-skin');
  }

  function choose(id) {
    if (!SKINS.some((s) => s.id === id)) return false;
    writeJSON(KEY, id);
    apply(id);
    dispatchEvent(new CustomEvent('yomu:skin', { detail: { id } }));
    paint();
    return true;
  }

  /** A skin that is no longer earned -- a reset store -- falls back rather
   *  than staying on as an unexplained look. Silent until the store exists. */
  function settle() {
    const P = window.YomuProgress;
    const id = current();
    if (!id || !P) { apply(id); return; }
    const skin = SKINS.find((s) => s.id === id);
    if (unlocked(skin, P.get(), P.stageOf().level)) apply(id);
    else { writeJSON(KEY, ''); apply(''); }
  }

  /* --- the picker ----------------------------------------------------------- */

  let note = '';

  function paint() {
    const host = document.getElementById(HOST_ID);
    const P = window.YomuProgress;
    if (!host || !P) return;
    const state = P.get();
    const level = P.stageOf().level;
    const chosen = current();
    host.textContent = '';

    const row = document.createElement('div');
    row.className = 'ysk';
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', 'Skin');

    for (const skin of SKINS) {
      const open = unlocked(skin, state, level);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ysk__chip' + (open ? '' : ' is-locked') + (skin.id === chosen ? ' is-on' : '');
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(skin.id === chosen));
      button.setAttribute('aria-label', skin.name + (open ? '' : ', locked: ' + skin.how));

      const swatch = document.createElement('span');
      swatch.className = 'ysk__swatch';
      swatch.style.background = `linear-gradient(135deg, ${skin.swatch[0]} 0 50%, ${skin.swatch[1]} 50% 100%)`;
      const dot = document.createElement('i');
      dot.style.background = skin.swatch[2];
      swatch.append(dot);
      button.append(swatch);
      button.append(Object.assign(document.createElement('span'), { className: 'ysk__name', textContent: skin.name }));

      button.addEventListener('click', () => {
        if (!open) { note = skin.name + ' unlocks when ' + skin.how.charAt(0).toLowerCase() + skin.how.slice(1) + '.'; paint(); return; }
        note = skin.id ? skin.name + ' is on. It stays on this device.' : 'Back to Aurora and Paper.';
        choose(skin.id);
      });
      row.append(button);
    }
    host.append(row);

    const small = document.createElement('p');
    small.className = 'ysh-note';
    small.textContent = note || 'A skin is a look, not a mode: it wins over Aurora and Paper while it is on, and it does not sync. Your accent colour still applies.';
    host.append(small);
  }

  const api = { SKINS, unlocked, current, choose, apply };
  if (typeof window !== 'undefined') window.YomuSkins = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { SKINS, unlocked };

  if (browser) {
    /* Applied at once, before the store has loaded, so the first paint is
       already skinned; settled against the store as soon as it speaks. */
    apply(current());
    const boot = () => { settle(); paint(); };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
    else boot();
    addEventListener('yomu:progress', boot);
  }
})();
