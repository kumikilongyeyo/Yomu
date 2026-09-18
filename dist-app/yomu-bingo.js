/**
 * Yomu Bingo — structured discovery disguised as a game.
 *
 * A five-by-five card of reading prompts, generated on this device once a
 * month: "a manhua", "a title under 20 chapters", "a genre you have never
 * read", "something from the hidden gems rail". A completed line pays a
 * badge; a full card pays the badge that unlocks the Gilt skin.
 *
 * Every prompt is checkable from what is already on the device -- the
 * library, the read lists, the AniList metadata cache, the rail cache, the
 * progression store -- and every check is against a snapshot taken when the
 * card was dealt. That is what makes it a monthly card rather than a list
 * of things you did last year: "read a manhua" means a manhua whose read
 * list grew since the first of the month.
 *
 * The store's counters (bingoLines, bingoCards) are the reward truth and
 * are only ever written through YomuProgress.noteBingo. This file owns the
 * card and nothing else.
 */
(() => {
  'use strict';

  const KEY = 'yomu.v1.bingo';
  const HOST_ID = 'yomu-bingo';
  const RESUME_PREFIX = 'yomu.v1.resume.local-account.';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const ANILIST_KEY = 'yomu.v1.anilist';
  const RAILS_KEY = 'yomu.v1.rails';
  const EVENTS_KEY = 'yomu.v1.events';
  const ROULETTE_KEY = 'yomu.v1.roulette';
  const SINCE_KEY = 'yomu.v1.since';

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

  /* --- a small deterministic random --------------------------------------- */

  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function shuffle(list, random) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /* --- the prompts ---------------------------------------------------------- *
   *
   * Each has an id, the words on the square, and a check over the context:
   *
   *   ctx.grew(title)       chapters read of a library row since the deal
   *   ctx.meta(title)       cached AniList metadata, or null
   *   ctx.library           saved rows
   *   ctx.delta.<counter>   store counter minus its value at the deal
   *   ctx.readDays          ISO days read this month
   *   ctx.streak            live streak
   *   ctx.state             the store
   *   ctx.rail(name)        titles (lowercased) in a cached rail
   *   ctx.events            rank events since the deal
   *   ctx.since             the deal's clock
   */

  const GENRES = ['Romance', 'Action', 'Fantasy', 'Comedy', 'Drama', 'Horror', 'Sports',
    'Slice of Life', 'Mystery', 'Sci-Fi', 'Supernatural', 'Psychological', 'Adventure', 'Thriller'];

  const readWith = (ctx, test) => ctx.library.some((row) => row && row.title && ctx.grew(row) > 0 && test(row, ctx.meta(row.title)));

  const PROMPTS = [
    { id: 'manhua', text: 'Read a manhua', check: (c) => readWith(c, (r, m) => m?.country === 'CN') },
    { id: 'manhwa', text: 'Read a manhwa', check: (c) => readWith(c, (r, m) => m?.country === 'KR') },
    { id: 'manga', text: 'Read a manga', check: (c) => readWith(c, (r, m) => m?.country === 'JP') },
    { id: 'short', text: 'A title under 20 chapters', check: (c) => readWith(c, (r) => Number(r.total) > 0 && Number(r.total) < 20) },
    { id: 'long', text: 'A title over 100 chapters', check: (c) => readWith(c, (r) => Number(r.total) > 100) },
    { id: 'finished-status', text: 'Something already completed', check: (c) => readWith(c, (r) => /complet/i.test(String(r.status || ''))) },
    { id: 'finish', text: 'Finish a title', check: (c) => c.delta.titlesCompleted >= 1 },
    { id: 'ch25', text: '25 chapters this month', check: (c) => c.delta.chaptersRead >= 25 },
    { id: 'ch100', text: '100 chapters this month', check: (c) => c.delta.chaptersRead >= 100 },
    { id: 'save3', text: 'Save three new titles', check: (c) => c.delta.librarySize >= 3 },
    { id: 'source', text: 'Switch on a new source', check: (c) => c.delta.sourcesUsed >= 1 },
    { id: 'days10', text: 'Read on ten different days', check: (c) => c.readDays.length >= 10 },
    { id: 'weekend', text: 'Read on a weekend', check: (c) => c.readDays.some((d) => [0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay())) },
    { id: 'streak7', text: 'Seven days in a row', check: (c) => c.streak >= 7 },
    { id: 'badge', text: 'Wear a badge', check: (c) => !!c.state.equippedBadgeId },
    { id: 'roulette', text: 'Spin the genre roulette', check: (c) => (Number(readJSON(ROULETTE_KEY, {})?.lastAt) || 0) >= c.since },
    { id: 'recommendation', text: 'Open a recommendation', check: (c) => c.events.some((e) => e.t === 'RECOMMENDATION_CLICK') },
    { id: 'gem', text: 'Something from the hidden gems rail', check: (c) => readWith(c, (r) => c.rail('gems').has(String(r.title).toLowerCase())) },
    { id: 'trending', text: 'Something that is trending', check: (c) => readWith(c, (r) => c.rail('trending').has(String(r.title).toLowerCase())) },
    { id: 'two-shores', text: 'Two countries of origin', check: (c) => {
      const seen = new Set();
      for (const row of c.library) { const m = row && c.grew(row) > 0 ? c.meta(row.title) : null; if (m?.country) seen.add(m.country); }
      return seen.size >= 2;
    } },
    { id: 'long-sitting', text: 'Five chapters in one sitting', check: (c) => c.binge >= 5 },
    { id: 'cast', text: 'Look up a cast', check: (c) => c.castLooked },
    ...GENRES.map((genre) => ({
      id: 'genre:' + genre,
      text: genre,
      genre,
      check: (c) => readWith(c, (r, m) => (m?.genres || []).some((g) => String(g).toLowerCase() === genre.toLowerCase())),
    })),
  ];

  const byId = (id) => PROMPTS.find((p) => p.id === id);
  const FREE = { id: 'free', text: 'Free' };

  /**
   * Deal a card for a month. Pure given the seed and the genres this reader
   * has already read (lowercased): four genre squares, favouring untouched
   * ones so "a genre you have never read" is what the card actually asks,
   * plus twenty of the rest, shuffled, with the centre free.
   */
  function deal(month, salt, readGenres) {
    const random = rng(hash(month + '|' + (salt || '')));
    const untouched = GENRES.filter((g) => !readGenres.has(g.toLowerCase()));
    const touched = GENRES.filter((g) => readGenres.has(g.toLowerCase()));
    const genrePicks = [...shuffle(untouched, random), ...shuffle(touched, random)].slice(0, 4);
    const rest = shuffle(PROMPTS.filter((p) => !p.genre).map((p) => p.id), random).slice(0, 20);
    const squares = shuffle([...genrePicks.map((g) => 'genre:' + g), ...rest], random);
    squares.splice(12, 0, 'free');
    return { month, squares };
  }

  /** The twelve lines of a 5x5, as index lists. */
  const LINES = (() => {
    const out = [];
    for (let r = 0; r < 5; r++) out.push([0, 1, 2, 3, 4].map((c) => r * 5 + c));
    for (let c = 0; c < 5; c++) out.push([0, 1, 2, 3, 4].map((r) => r * 5 + c));
    out.push([0, 6, 12, 18, 24]);
    out.push([4, 8, 12, 16, 20]);
    return out;
  })();

  function lines(marks) {
    return LINES.filter((line) => line.every((i) => marks[i]));
  }

  /* --- context -------------------------------------------------------------- */

  const monthOf = (now) => new Date(now).toISOString().slice(0, 7);

  function readCounts() {
    const counts = {};
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(RESUME_PREFIX) || !key.endsWith('.read')) continue;
        const list = readJSON(key, []);
        if (Array.isArray(list)) counts[key.slice(RESUME_PREFIX.length, -'.read'.length)] = list.length;
      }
    } catch {}
    return counts;
  }

  function snapshot(state, now) {
    return {
      at: now,
      reads: readCounts(),
      counters: {
        chaptersRead: state.chaptersRead, titlesCompleted: state.titlesCompleted,
        librarySize: state.librarySize, sourcesUsed: state.sourcesUsed,
      },
    };
  }

  function context(card, state) {
    const library = (readJSON(COLLECTION_KEY, {}) || {}).library || [];
    const reads = readCounts();
    const cache = readJSON(ANILIST_KEY, {}) || {};
    const rails = readJSON(RAILS_KEY, {}) || {};
    const base = card.base || { at: 0, reads: {}, counters: {} };
    const month = card.month;
    const streak = window.YomuProgress?.streak?.() || { current: 0, readDays: [] };
    return {
      library: Array.isArray(library) ? library.filter((r) => r && !r.hidden) : [],
      grew: (row) => (reads[row.id] || 0) - (base.reads[row.id] || 0),
      meta: (title) => cache[String(title || '').trim().toLowerCase()]?.answer || null,
      delta: Object.fromEntries(Object.entries(base.counters).map(([k, v]) => [k, (state[k] || 0) - (v || 0)])),
      readDays: (streak.readDays || []).filter((d) => d.startsWith(month)),
      streak: streak.current,
      state,
      rail: (name) => {
        const titles = new Set();
        for (const entry of Object.values(rails)) {
          for (const item of entry?.data?.[name] || []) if (item?.title) titles.add(String(item.title).toLowerCase());
        }
        return titles;
      },
      events: (readJSON(EVENTS_KEY, []) || []).filter((e) => e && e.at >= base.at),
      since: base.at,
      binge: Number(readJSON('yomu.v1.binge', {})?.count) || 0,
      castLooked: (() => { try { return Object.keys(sessionStorage).some((k) => k.startsWith('yomu.v1.cast:')); } catch { return false; } })(),
    };
  }

  /* --- the card ------------------------------------------------------------- */

  function load(now) {
    const P = window.YomuProgress;
    const state = P ? P.get() : {};
    const month = monthOf(now);
    let card = readJSON(KEY, null);
    if (!card || card.month !== month || !Array.isArray(card.squares) || card.squares.length !== 25) {
      const read = new Set(Object.keys(window.YomuRank?.taste?.()?.genres || {}).map((g) => g.toLowerCase()));
      card = { ...deal(month, localStorage.getItem(SINCE_KEY) || '', read), base: snapshot(state, now), marks: [], claimedLines: 0, full: false };
      writeJSON(KEY, card);
    }
    return card;
  }

  /** Re-check every square and report new lines to the store. */
  function evaluate(now) {
    const P = window.YomuProgress;
    if (!P) return null;
    const card = load(now || Date.now());
    const ctx = context(card, P.get());
    const marks = card.squares.map((id) => {
      if (id === 'free') return true;
      const prompt = byId(id);
      try { return !!(prompt && prompt.check(ctx)); } catch { return false; }
    });
    /* Marks never come off within a month: a source switched off again does
       not un-earn the square, and a line paid is a line paid. */
    const kept = marks.map((m, i) => m || !!(card.marks && card.marks[i]));
    const done = lines(kept);
    const full = kept.every(Boolean);
    const next = { ...card, marks: kept, lines: done.length, full };
    if (JSON.stringify(next) !== JSON.stringify(card)) writeJSON(KEY, next);

    const prior = readJSON(KEY + '.totals', { lines: 0, cards: 0, month: '' }) || {};
    const totals = prior.month === card.month ? prior : { lines: prior.lines || 0, cards: prior.cards || 0, month: card.month, seenLines: 0, seenFull: false };
    let changed = false;
    if (done.length > (totals.seenLines || 0)) { totals.lines += done.length - (totals.seenLines || 0); totals.seenLines = done.length; changed = true; }
    if (full && !totals.seenFull) { totals.cards += 1; totals.seenFull = true; changed = true; }
    if (changed) { writeJSON(KEY + '.totals', totals); P.noteBingo(totals.lines, totals.cards); }
    return next;
  }

  /* --- the You page --------------------------------------------------------- */

  let selected = -1;

  function paint() {
    const host = document.getElementById(HOST_ID);
    if (!host || !window.YomuProgress) return;
    const card = evaluate();
    if (!card) return;
    host.textContent = '';

    const monthName = new Date(card.month + '-01T00:00:00Z').toLocaleString(undefined, { month: 'long', timeZone: 'UTC' });
    const head = document.createElement('div');
    head.className = 'ybg__head';
    const strong = document.createElement('strong');
    strong.textContent = monthName + ' bingo';
    const count = document.createElement('span');
    count.textContent = card.full ? 'Full card!' : (card.lines || 0) + (card.lines === 1 ? ' line' : ' lines') + ' · ' + card.marks.filter(Boolean).length + '/25';
    head.append(strong, count);
    host.append(head);

    const done = lines(card.marks);
    const inLine = new Set(done.flat());
    const grid = document.createElement('div');
    grid.className = 'ybg';
    grid.setAttribute('role', 'grid');
    card.squares.forEach((id, index) => {
      const prompt = id === 'free' ? FREE : byId(id) || { text: id };
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'ybg__sq' + (card.marks[index] ? ' is-done' : '') + (inLine.has(index) ? ' is-line' : '') + (index === selected ? ' is-pick' : '');
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', prompt.text + (card.marks[index] ? ', done' : ''));
      cell.textContent = prompt.text;
      cell.addEventListener('click', () => { selected = selected === index ? -1 : index; paint(); });
      grid.append(cell);
    });
    host.append(grid);

    const note = document.createElement('p');
    note.className = 'ysh-note';
    if (selected >= 0) {
      const id = card.squares[selected];
      const prompt = id === 'free' ? FREE : byId(id);
      note.textContent = (prompt?.text || id) + ' · ' + (card.marks[selected] ? 'done this month.' : 'not yet. Squares check what you read since the card was dealt.');
    } else {
      note.textContent = 'A new card every month, dealt on this device. A line pays a badge; a full card unlocks the Gilt skin.';
    }
    host.append(note);
  }

  const api = { deal, lines, evaluate, PROMPTS, GENRES, LINES, repaint: paint };
  if (typeof window !== 'undefined') window.YomuBingo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { deal, lines, PROMPTS, GENRES, LINES, hash, rng };

  if (browser) {
    const boot = () => { if (document.getElementById(HOST_ID)) paint(); else evaluate(); };
    const later = () => setTimeout(boot, 50);
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', later);
    else later();
    addEventListener('yomu:progress', later);
    addEventListener('yomu:roulette', later);
  }
})();
