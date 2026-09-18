/**
 * Genre roulette — the one deliberately unsafe button on Discover.
 *
 * Every rail is built to be safe: what is popular, what you already like,
 * what people like you read. A discovery screen made only of safe bets never
 * shows you the thing you did not know you wanted. "Surprise me" spins
 * visibly through covers and lands on a trending title in a genre this
 * reader has never touched, and says why in plain words.
 *
 * Everything it needs is already here: the rail cache from yomu-rank.js
 * (trending and most-read, with genres and reader counts) and the taste
 * profile, which knows which genres have any reading behind them. Nothing
 * is fetched that the Discover rails were not fetching anyway.
 */
(() => {
  'use strict';

  const ROOT_ID = 'yomu-roulette';
  const KEY = 'yomu.v1.roulette';
  const SPIN_MS = 1700;

  const browser = typeof document !== 'undefined';
  const reduced = () => browser && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  /* Genres AniList files under that are not a taste so much as a rating. */
  const SKIP = new Set(['Hentai', 'Ecchi']);

  /**
   * Choose the surprise. Pure, so it is testable:
   *
   *   items    ranked titles with `genres` and `popularity`
   *   read     genres with any reading weight behind them (lowercased)
   *   random   0..1
   *
   * Prefers a genre the reader has never touched -- the one with the most
   * candidates, so a tiny genre with a single odd title does not always win
   * -- and within it the title moving fastest, with the random number picking
   * among the top few so two spins do not land on the same cover.
   */
  function pick(items, read, random) {
    const roll = typeof random === 'number' ? random : Math.random();
    const usable = (items || []).filter((i) => i && i.title && Array.isArray(i.genres));
    if (!usable.length) return null;

    const byGenre = new Map();
    for (const item of usable) {
      for (const genre of item.genres) {
        if (SKIP.has(genre) || read.has(String(genre).toLowerCase())) continue;
        if (!byGenre.has(genre)) byGenre.set(genre, []);
        byGenre.get(genre).push(item);
      }
    }

    if (byGenre.size) {
      const genres = [...byGenre.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
      /* Among the untouched genres, lean to the fullest but let the roll
         reach the others: a reader who spins twice should not see the same
         genre twice. */
      const [genre, candidates] = genres[Math.floor(roll * Math.min(genres.length, 3))];
      const ranked = candidates.slice().sort((a, b) => (b.trending || 0) - (a.trending || 0) || (b.popularity || 0) - (a.popularity || 0));
      const item = ranked[Math.floor(((roll * 7919) % 1) * Math.min(ranked.length, 4))];
      return { item, genre, why: 'never' };
    }

    /* Read a bit of everything: the fastest mover, and honesty about it. */
    const ranked = usable.slice().sort((a, b) => (b.trending || 0) - (a.trending || 0));
    return { item: ranked[Math.floor(roll * Math.min(ranked.length, 5))], genre: null, why: 'everything' };
  }

  function readGenres() {
    const profile = window.YomuRank?.taste?.();
    const out = new Set();
    for (const [genre, weight] of Object.entries(profile?.genres || {})) {
      if (weight > 0) out.add(String(genre).toLowerCase());
    }
    return out;
  }

  function sentence(result) {
    const people = Number(result.item.popularity) || 0;
    const count = people ? people.toLocaleString() + ' people are reading this one right now.' : 'It is moving fast this week.';
    if (result.why === 'never') return `You have never read ${result.genre}. ${count}`;
    return `You have read a bit of everything, so here is what is moving fastest. ${count}`;
  }

  /* --- the block ------------------------------------------------------------- */

  let spinning = false;

  function build() {
    const root = el('section', 'yrl');
    root.id = ROOT_ID;

    const head = el('div', 'yrl__head');
    const copy = el('div', 'yrl__copy');
    copy.append(el('h2', 'yrl__title', 'Genre roulette'));
    copy.append(el('p', 'yrl__why', 'Everything above is a safe bet. This is not.'));
    const button = el('button', 'yrl__spin', 'Surprise me');
    button.type = 'button';
    head.append(copy, button);
    root.append(head);

    const stage = el('div', 'yrl__stage');
    stage.hidden = true;
    root.append(stage);

    button.addEventListener('click', () => spin(root, stage, button));
    return root;
  }

  async function spin(root, stage, button) {
    if (spinning) return;
    spinning = true;
    button.disabled = true;
    stage.hidden = false;
    stage.textContent = '';
    const wheel = el('div', 'yrl__wheel');
    const art = el('div', 'yrl__art');
    wheel.append(art);
    stage.append(wheel, el('p', 'yrl__line', 'Spinning…'));

    const data = await window.YomuRank.rails(['trending', 'popular'], 'all', 30);
    const items = [...(data?.trending || []), ...(data?.popular || [])];
    const result = pick(items, readGenres());

    if (!result) {
      stage.textContent = '';
      stage.append(el('p', 'yrl__line', 'Rankings are unavailable right now, so no spin. Search still works.'));
      spinning = false;
      button.disabled = false;
      return;
    }

    /* The visible spin: covers flick past and slow down. Cosmetic -- the
       answer was chosen before the first frame -- and skipped entirely for
       reduced motion, where the card simply appears. */
    if (!reduced() && items.length > 3) {
      const covers = items.filter((i) => i.cover).map((i) => i.cover);
      let step = 0;
      const start = Date.now();
      await new Promise((done) => {
        const tick = () => {
          const elapsed = Date.now() - start;
          if (elapsed >= SPIN_MS) return done();
          art.style.backgroundImage = `url("${covers[step++ % covers.length]}")`;
          /* Ease out: 60ms flicks stretching to 260ms. */
          setTimeout(tick, 60 + 200 * (elapsed / SPIN_MS) ** 2);
        };
        tick();
      });
    }

    stage.textContent = '';
    const landed = el('div', 'yrl__landed');
    const card = window.YomuRails?.card?.(result.item, 'Surprise') || el('a', 'yr-card', result.item.title);
    landed.append(card);
    const words = el('div', 'yrl__words');
    words.append(el('p', 'yrl__line', sentence(result)));
    if (result.item.genres?.length) {
      words.append(el('p', 'yrl__genres', result.item.genres.slice(0, 4).join(' · ')));
    }
    const again = el('button', 'yrl__again', 'Spin again');
    again.type = 'button';
    again.addEventListener('click', () => spin(root, stage, button));
    words.append(again);
    landed.append(words);
    stage.append(landed);

    const state = readJSON(KEY, {}) || {};
    writeJSON(KEY, { spins: (Number(state.spins) || 0) + 1, lastAt: Date.now(), last: result.item.title });
    dispatchEvent(new CustomEvent('yomu:roulette', { detail: { title: result.item.title, genre: result.genre } }));

    spinning = false;
    button.disabled = false;
  }

  /* Under the rails, above the genre tiles: after the safe bets, before
     browsing. The host is find.html's own section, so nothing React owns is
     touched and placement settles once. */
  function mount() {
    const host = document.getElementById('yomu-rails-here');
    if (!host || !window.YomuRank) return;
    let root = document.getElementById(ROOT_ID);
    if (root && root.isConnected) return;
    if (!root) root = build();
    host.after(root);
  }

  const api = { pick, sentence, SKIP };
  if (typeof window !== 'undefined') window.YomuRoulette = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { pick, sentence };

  if (browser) {
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mount);
    else mount();
    new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
