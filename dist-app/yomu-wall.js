/**
 * The cover wall — Yomu as a bookshop window.
 *
 * After a minute idle on Home, the library's covers drift slowly across the
 * whole screen under the Yomu wordmark. Tap any cover to pick that series
 * up where you left it; tap anywhere else, or touch a key, and Home is
 * back. Pure gimmick, and the one that makes a tablet on a desk look like
 * something.
 *
 * The rules that keep it a gimmick and not a nuisance:
 *   - Home only, and only when nothing else is open: a sheet, a dialog, the
 *     ceremony. Never over the reader.
 *   - Off under reduced motion. A wall that does not move is a wall.
 *   - Off on a low battery, where the browser will say. Slow animation for
 *     an hour is exactly what a dying phone does not need.
 *   - Off with one switch on Your Yomu, kept on this device.
 *   - Needs at least four covers, or it is not a wall.
 */
(() => {
  'use strict';

  const KEY = 'yomu.v1.wall';
  const ROOT_ID = 'yomu-wall';
  const HOST_ID = 'yomu-wall-setting';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const READING_KEY = 'yomu.v1.reading';
  const IDLE_MS = 60000;
  const MIN_COVERS = 4;
  const MAX_COVERS = 18;

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

  const prefs = () => ({ enabled: true, ...(readJSON(KEY, {}) || {}) });
  const reduced = () => browser && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- pure ---------------------------------------------------------------- */

  /**
   * Covers to hang, newest reading first, then the saved shelf. One per
   * series, only titles with a picture, capped. Each carries where a tap
   * should go: the chapter you were on when there is one, the series page
   * otherwise.
   */
  function pickCovers(library, reading, max = MAX_COVERS) {
    const seen = new Set();
    const out = [];
    const records = Object.values(reading || {}).filter((r) => r && r.seriesId && r.cover).sort((a, b) => (b.at || 0) - (a.at || 0));
    for (const r of records) {
      if (seen.has(r.seriesId)) continue;
      seen.add(r.seriesId);
      out.push({
        seriesId: r.seriesId, title: r.title || '', cover: r.cover,
        href: r.chapterId && r.sourceId
          ? '/read/' + encodeURIComponent(r.chapterId) + '?source=' + encodeURIComponent(r.sourceId)
          : r.sourceId ? '/series/' + encodeURIComponent(r.seriesId) + '?source=' + encodeURIComponent(r.sourceId) : '',
      });
      if (out.length >= max) return out;
    }
    for (const row of Array.isArray(library) ? library : []) {
      if (!row || !row.id || !row.cover || row.hidden || seen.has(row.id)) continue;
      if (String(row.category || '').toLowerCase() === 'adult') continue;
      seen.add(row.id);
      out.push({
        seriesId: row.id, title: row.title || '', cover: row.cover,
        href: row.sourceId ? '/series/' + encodeURIComponent(row.id) + '?source=' + encodeURIComponent(row.sourceId) : '',
      });
      if (out.length >= max) break;
    }
    return out;
  }

  /** Whether the wall may come up. Every reason it must not is a field. */
  function shouldStart(c) {
    if (!c.enabled || !c.onHome || c.hidden || c.reduced || c.dialogOpen || c.lowBattery) return false;
    return c.idleMs >= IDLE_MS && c.covers >= MIN_COVERS;
  }

  /* --- the wall ------------------------------------------------------------- */

  let lastActivity = Date.now();
  let timer = 0;
  let lowBattery = false;

  const onHome = () => location.pathname === '/' || location.pathname === '/index.html';
  const dialogOpen = () => !!document.querySelector('#yomu-ceremony, .yomu-cast, .stk-sheet, .pickr:not([hidden]), [role="dialog"]:not(#' + ROOT_ID + ')');

  function covers() {
    return pickCovers((readJSON(COLLECTION_KEY, {}) || {}).library, readJSON(READING_KEY, {}));
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function show() {
    if (document.getElementById(ROOT_ID)) return;
    const list = covers();
    if (list.length < MIN_COVERS) return;

    const root = el('div', 'ywall');
    root.id = ROOT_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Cover wall. Tap a cover to keep reading, or anywhere to close.');

    const field = el('div', 'ywall__field');
    list.forEach((c, i) => {
      const tile = el(c.href ? 'a' : 'div', 'ywall__cover');
      if (c.href) tile.href = c.href;
      tile.setAttribute('aria-label', c.title ? 'Keep reading ' + c.title : 'Open');
      /* Each cover gets its own slow path: a duration, a delay and a
         direction, so the field never marches in step. */
      tile.style.setProperty('--d', (26 + (i % 5) * 6) + 's');
      tile.style.setProperty('--delay', (-(i * 3.7) % 30) + 's');
      tile.style.setProperty('--dir', i % 2 ? '1' : '-1');
      const img = el('img');
      img.src = c.cover;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      tile.append(img);
      if (c.title) tile.append(el('span', 'ywall__title', c.title));
      tile.addEventListener('click', (event) => { event.stopPropagation(); });
      field.append(tile);
    });
    root.append(field);

    const mark = el('div', 'ywall__mark');
    const word = el('img');
    word.src = '/brand/yomu-wordmark-ivory-640.png';
    word.alt = 'Yomu';
    mark.append(word, el('span', null, 'Tap a cover to keep reading'));
    root.append(mark);

    root.addEventListener('click', hide);
    document.body.append(root);
    setTimeout(() => root.classList.add('is-on'), 20);
    dispatchEvent(new CustomEvent('yomu:wall', { detail: { on: true } }));
  }

  function hide() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.classList.remove('is-on');
    setTimeout(() => root.remove(), reduced() ? 0 : 400);
    dispatchEvent(new CustomEvent('yomu:wall', { detail: { on: false } }));
  }

  function check() {
    const ok = shouldStart({
      enabled: prefs().enabled,
      onHome: onHome(),
      hidden: document.hidden,
      reduced: reduced(),
      dialogOpen: dialogOpen(),
      lowBattery,
      idleMs: Date.now() - lastActivity,
      covers: covers().length,
    });
    if (ok) show();
  }

  function activity() {
    lastActivity = Date.now();
    if (document.getElementById(ROOT_ID)) hide();
  }

  /* --- the switch on Your Yomu ------------------------------------------------ */

  function paint() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    host.textContent = '';
    const on = prefs().enabled;
    const row = el('div', 'ywall-set');
    const button = el('button', 'ysh-off', on ? 'On' : 'Off');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(on));
    button.addEventListener('click', () => { writeJSON(KEY, { ...prefs(), enabled: !on }); paint(); });
    row.append(el('span', null, on ? 'Covers drift across Home after a minute idle.' : 'Home stays put.'), button);
    host.append(row);
    const n = covers().length;
    host.append(el('p', 'ysh-note', reduced()
      ? 'Off while your system asks for reduced motion.'
      : n < MIN_COVERS ? `Needs ${MIN_COVERS} saved covers to be a wall; you have ${n}.` : 'Tap a cover to pick that series up. Off on a low battery.'));
  }

  const api = { pickCovers, shouldStart, show, hide, IDLE_MS, MIN_COVERS };
  if (typeof window !== 'undefined') window.YomuWall = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { pickCovers, shouldStart, IDLE_MS, MIN_COVERS };

  if (browser) {
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll']) {
      addEventListener(type, activity, { passive: true, capture: true });
    }
    addEventListener('visibilitychange', () => { lastActivity = Date.now(); if (document.hidden) hide(); });
    addEventListener('yomu:pet-surface', () => { lastActivity = Date.now(); hide(); });
    if (navigator.getBattery) {
      navigator.getBattery().then((b) => {
        const read = () => { lowBattery = !b.charging && b.level < 0.25; };
        read();
        b.addEventListener('levelchange', read);
        b.addEventListener('chargingchange', read);
      }).catch(() => {});
    }
    timer = setInterval(check, 5000);
    const boot = () => paint();
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
