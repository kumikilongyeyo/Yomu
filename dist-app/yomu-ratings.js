/**
 * Ratings on the tiles.
 *
 * AniList's community score, the same number the Discover rails already
 * show, drawn on the cover of every title the grid knows. Free, open, and
 * asked from the browser because AniList blocks the Worker.
 *
 * Nothing is fetched in a hurry: titles the cache already knows draw at
 * once; the rest are looked up one every few seconds while the tab is
 * visible, a dozen per page at most, and the answer lands in the same
 * cache yomu-rank.js and the mileage engine read, so a lookup here also
 * teaches the rest of the app what the title is. A title AniList does not
 * know gets no chip and no second request.
 */
(() => {
  'use strict';

  const CLASS = 'yomu-tile__rating';
  const SERIES_ID = 'yomu-series-rating';
  const EVERY_MS = 2600;
  const PER_PAGE = 12;
  const MISS_KEY = 'yomu.v1.ratingMiss';

  const browser = typeof document !== 'undefined';

  /** 0-100 -> "8.7". Null when there is nothing honest to show. */
  function formatScore(score) {
    const n = Number(score);
    if (!Number.isFinite(n) || n <= 0) return null;
    return (Math.round(n) / 10).toFixed(1);
  }

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  /* Titles AniList did not know, remembered for a week so a grid of them does
     not ask again on every visit. */
  const misses = () => {
    const all = readJSON(MISS_KEY, {}) || {};
    const cutoff = Date.now() - 7 * 86400000;
    for (const k of Object.keys(all)) if (all[k] < cutoff) delete all[k];
    return all;
  };
  const missed = (key) => !!misses()[key];
  const noteMiss = (key) => { const all = misses(); all[key] = Date.now(); writeJSON(MISS_KEY, all); };

  const keyOf = (title) => String(title || '').trim().toLowerCase();

  /* --- lookups, gently ------------------------------------------------------- */

  const queue = [];
  const queued = new Set();
  let asked = 0;
  let timer = 0;

  function enqueue(title) {
    const key = keyOf(title);
    if (!key || queued.has(key) || missed(key) || asked >= PER_PAGE) return;
    queued.add(key);
    queue.push(title);
    if (!timer) timer = setTimeout(drain, 600);
  }

  async function drain() {
    timer = 0;
    if (document.hidden || !queue.length || !window.YomuAniList?.similar) { if (queue.length) timer = setTimeout(drain, EVERY_MS); return; }
    const title = queue.shift();
    asked++;
    try {
      const hit = window.YomuAniList.cached(title);
      const answer = hit && !('score' in hit) ? await window.YomuAniList.similar(title, { refresh: true }) : await window.YomuAniList.similar(title);
      if (!answer || answer.source !== 'anilist') noteMiss(keyOf(title));
    } catch { noteMiss(keyOf(title)); }
    paint();
    if (queue.length) timer = setTimeout(drain, EVERY_MS);
  }

  /* --- painting ---------------------------------------------------------------- */

  function scoreFor(title) {
    const hit = window.YomuAniList?.cached?.(title);
    if (!hit) return { text: null, known: false };
    if (!('score' in hit)) return { text: null, known: false, stale: true };
    return { text: formatScore(hit.score), known: true };
  }

  function chip(text) {
    const node = document.createElement('span');
    node.className = CLASS;
    node.textContent = '★ ' + text;
    node.title = text + ' / 10 on AniList';
    node.setAttribute('aria-label', 'Rated ' + text + ' out of 10 on AniList');
    return node;
  }

  function paint() {
    for (const tile of document.querySelectorAll('.tile-card')) {
      const title = tile.querySelector('.tile-card__title')?.textContent?.trim();
      const footer = tile.querySelector('.tile-card__footer');
      if (!title || !footer) continue;
      const { text, known } = scoreFor(title);
      let mark = footer.querySelector('.' + CLASS);
      if (!known) { enqueue(title); mark?.remove(); continue; }
      if (!text) { mark?.remove(); continue; }
      if (mark && mark.dataset.score === text) continue;
      mark?.remove();
      mark = chip(text);
      mark.dataset.score = text;
      footer.append(mark);
    }

    /* The series page: after the facts line, once. */
    const hero = document.querySelector('.series-hero-copy h1');
    const facts = document.querySelector('.series-facts');
    const existing = document.getElementById(SERIES_ID);
    if (!hero || !facts) { existing?.remove(); return; }
    const { text, known } = scoreFor(hero.textContent.trim());
    if (!known) { enqueue(hero.textContent.trim()); existing?.remove(); return; }
    if (!text) { existing?.remove(); return; }
    if (existing && existing.dataset.score === text) { if (!existing.isConnected) facts.after(existing); return; }
    existing?.remove();
    const line = chip(text);
    line.id = SERIES_ID;
    line.className = 'yomu-series-rating';
    line.dataset.score = text;
    line.textContent = '★ ' + text + ' on AniList';
    facts.after(line);
  }

  const api = { formatScore, repaint: paint };
  if (typeof window !== 'undefined') window.YomuRatings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { formatScore };

  if (browser) {
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', paint);
    else paint();
    new MutationObserver(paint).observe(document.documentElement, { childList: true, subtree: true });
    addEventListener('visibilitychange', () => { if (!document.hidden && queue.length && !timer) timer = setTimeout(drain, 800); });
    /* A new page is a new dozen. */
    for (const type of ['popstate', 'hashchange']) addEventListener(type, () => { asked = 0; });
  }
})();
