/**
 * The binge meter.
 *
 * Manga readers binge, and the app never acknowledged it. After each
 * chapter in a sitting -- from the second one -- a quiet strip at the foot
 * of the reader says so, in Mori's voice: "Chapter 6 in a row. Mori
 * suggests water." It counts chapters finished in the current sitting and a
 * sitting ends after thirty idle minutes.
 *
 * Mori is hidden in the reader, so the strip stands alone and signs itself.
 * The line comes through yomu-greet.js so mute applies and the voice is the
 * one the masthead uses; the late-night variants pick up the shell's own
 * time bucket, which is the one that knows 02:00 is night and not morning.
 */
(() => {
  'use strict';

  const KEY = 'yomu.v1.binge';
  const STRIP_ID = 'yomu-binge';
  const SITTING_MS = 30 * 60000;
  const SHOW_MS = 4800;

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

  /**
   * Fold `delta` finished chapters into the sitting. Pure: given the stored
   * tally, the clock, and how many chapters just completed.
   */
  function tally(state, now, delta) {
    const count = Number(state?.count) || 0;
    const lastAt = Number(state?.lastAt) || 0;
    const fresh = !lastAt || now - lastAt > SITTING_MS;
    return { count: (fresh ? 0 : count) + Math.max(1, delta | 0), lastAt: now };
  }

  /** The current sitting as it stands, without adding to it. */
  function current(now) {
    const state = readJSON(KEY, null);
    if (!state || (now || Date.now()) - (Number(state.lastAt) || 0) > SITTING_MS) return 0;
    return Number(state.count) || 0;
  }

  let hideTimer = 0;

  function show(text) {
    let strip = document.getElementById(STRIP_ID);
    if (!strip) {
      strip = document.createElement('div');
      strip.id = STRIP_ID;
      strip.className = 'yomu-binge';
      strip.setAttribute('role', 'status');
      const copy = document.createElement('span');
      copy.className = 'yomu-binge__copy';
      const who = document.createElement('span');
      who.className = 'yomu-binge__who';
      who.textContent = 'Mori';
      strip.append(copy, who);
      /* The reader treats taps as page gestures; a tap on the strip only
         dismisses the strip. */
      strip.addEventListener('click', (event) => { event.stopPropagation(); hide(); });
      document.body.append(strip);
    }
    strip.querySelector('.yomu-binge__copy').textContent = text;
    /* A timer, not a frame: a strip shown to a background tab still has to be
       on when the tab is looked at, and rAF does not run while it is not. */
    setTimeout(() => strip.classList.add('is-on'), 20);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, SHOW_MS);
  }

  function hide() {
    clearTimeout(hideTimer);
    document.getElementById(STRIP_ID)?.classList.remove('is-on');
  }

  function onComplete(event) {
    const now = Date.now();
    const next = tally(readJSON(KEY, null), now, event.detail?.count || 1);
    writeJSON(KEY, next);
    if (next.count < 2) return;
    if (window.YomuPet?.surface?.() !== 'reader') return;
    const late = window.YomuShell?.timeBucket?.() === 'l';
    const line = window.YomuGreetings?.line?.(late ? 'binge_late' : 'binge', { count: next.count });
    if (line) show(line);
  }

  const api = { tally, current, hide, SITTING_MS };
  if (typeof window !== 'undefined') window.YomuBinge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { tally, SITTING_MS };

  if (browser) {
    addEventListener('yomu:chapter-complete', onComplete);
    addEventListener('yomu:pet-surface', hide);
  }
})();
