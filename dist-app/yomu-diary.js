/**
 * Mori's diary — a line or two when you finish a title.
 *
 * The ideas doc imagined this as a model call. The chat that would have
 * paid for it was removed on purpose: a companion whose best moments stop
 * working when a key expires is worse than one that never had them. So the
 * diary is written here, on the device, from Mori's own pools, shaped by
 * what is actually known about the title -- how long it was, what genre
 * AniList files it under, how hot the streak was when it ended. Two lines,
 * in its voice, dated. Nothing leaves the device and nothing costs anything.
 *
 * Titles only, ever: the diary knows what you finished and when, never
 * what happened in it.
 */
(() => {
  'use strict';

  const KEY = 'yomu.v1.diary';
  const HOST_ID = 'yomu-diary';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const RESUME_PREFIX = 'yomu.v1.resume.local-account.';
  const MAX_ENTRIES = 60;

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

  const diary = () => {
    const value = readJSON(KEY, null);
    return value && Array.isArray(value.entries) ? value : { entries: [] };
  };

  /* --- the pools --------------------------------------------------------------- *
   * {title} and {n} are filled in. The first line is about the finishing; the
   * second is flavour, picked by what is known, falling back to length. */

  const OPENERS = [
    '{title}. Done. {n} chapters, and I read every one over your shoulder.',
    'Closed the last page of {title} today. {n} chapters. I was there for all of them.',
    'That is {title} finished. {n} chapters ago you had no idea.',
    '{title}, complete. I am going to sit with that for a minute.',
    'We finished {title}. I say we. You turned the pages.',
  ];

  const FLAVOUR = {
    Romance: ['I pretended not to care about the ending. I cared.', 'You lingered on the last chapter. I noticed. I am not judging.'],
    Action: ['My ears are still ringing. Worth it.', 'Somebody should check on the buildings in that city.'],
    Fantasy: ['I would like a map of that place. And a return ticket.', 'New world, same you, reading past midnight.'],
    Comedy: ['You laughed out loud twice. I counted.', 'The shelf is quieter without it. Suspiciously quiet.'],
    Drama: ['That one left a mark. Take the evening.', 'I am not crying. It is dusty on this shelf.'],
    Horror: ['I am sleeping on the shelf tonight. Near the light.', 'You read that one in the dark, on purpose. Bold.'],
    Mystery: ['I had it figured out by chapter three. I did not. I lied.', 'Every clue was there. We both missed most of them.'],
    Sports: ['I feel fitter for having watched you read that.', 'The final match ran long. So did we.'],
    'Slice of Life': ['Nothing happened, beautifully, for a long time. I liked it.', 'That was a warm one. The shelf feels warmer.'],
    Supernatural: ['I am checking the corners of the room now. Thanks for that.', 'Something followed us out of that one. Probably fine.'],
    Psychological: ['I need a minute. Maybe two.', 'You kept reading when you should have stopped. Same.'],
    Adventure: ['We went a long way for that ending. Good road.', 'Pack light. The next one starts soon.'],
    'Sci-Fi': ['The future was loud. I enjoyed it from the shelf.', 'I checked. We are still in the right century.'],
    Thriller: ['You turned those last pages fast. I heard them.', 'My heart rate is a sprite. It was still elevated.'],
  };

  const BY_LENGTH = {
    short: ['Short, and it knew it. The good ones do.', 'Over before the tea went cold. Sometimes that is the trick.'],
    long: ['That was a long road. Your thumb deserves a rest.', 'A hundred-plus chapters. The shelf will feel lighter tomorrow.'],
    mid: ['Just the right length. I have opinions about that, and it met them.', 'Middle of the shelf, top of the pile.'],
  };

  const BY_STAGE = {
    4: ['You finished it white-hot. I felt the shelf warm up.'],
    5: ['A blue-flame finish. I did not know the shelf could get that hot.'],
  };

  /**
   * Compose an entry. Pure: given the facts and a 0..1 random, the same
   * two lines come out, so a test can hold it still.
   */
  function compose(facts, random) {
    const roll = typeof random === 'number' ? random : Math.random();
    const pick = (list) => list[Math.floor(roll * list.length) % list.length];
    const title = facts.title || 'that one';
    const n = Number(facts.chapters) || 0;
    const first = pick(OPENERS).replaceAll('{title}', title).replaceAll('{n}', n ? String(n) : 'all its');
    let second = null;
    if (facts.stage >= 4 && BY_STAGE[facts.stage]) second = pick(BY_STAGE[facts.stage]);
    if (!second) {
      const genre = (facts.genres || []).find((g) => FLAVOUR[g]);
      if (genre) second = pick(FLAVOUR[genre]);
    }
    if (!second) second = pick(BY_LENGTH[n && n < 20 ? 'short' : n > 100 ? 'long' : 'mid']);
    return [first, second];
  }

  /** Library keys whose read list has reached the title's chapter count. */
  function finished() {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    const out = [];
    for (const row of Array.isArray(collection.library) ? collection.library : []) {
      if (!row || !row.id || !row.sourceId) continue;
      const total = Number(row.total);
      if (!Number.isFinite(total) || total <= 0) continue;
      const list = readJSON(RESUME_PREFIX + row.id + '.read', []);
      if (Array.isArray(list) && list.length >= total) out.push({ key: row.sourceId + ':' + row.id, title: row.title || '', chapters: total });
    }
    return out;
  }

  /** Finished titles with no entry yet. Pure over the two lists. */
  function pending(done, entries) {
    const have = new Set(entries.map((e) => e.key));
    return done.filter((d) => !have.has(d.key));
  }

  let firstRun = !readJSON(KEY, null);

  function write() {
    const book = diary();
    const fresh = pending(finished(), book.entries);
    if (!fresh.length) {
      /* Nothing to record, but the diary now exists: from here on a finish
         is a finish, not history. */
      if (firstRun) { writeJSON(KEY, book); firstRun = false; }
      return [];
    }
    /* The first time this runs on a device with history, every finished
       title would get an entry at once, dated today, about things finished
       months ago. They are recorded silently and undated instead. */
    const stage = window.YomuStreak?.get?.().stage ?? 0;
    const made = [];
    for (const item of fresh) {
      const genres = window.YomuAniList?.cached?.(item.title)?.genres || [];
      const entry = {
        key: item.key, title: item.title, chapters: item.chapters,
        at: firstRun ? 0 : Date.now(),
        lines: firstRun ? null : compose({ ...item, genres, stage }),
      };
      book.entries.push(entry);
      made.push(entry);
    }
    book.entries = book.entries.slice(-MAX_ENTRIES);
    writeJSON(KEY, book);
    firstRun = false;
    const spoken = made.filter((e) => e.lines);
    if (spoken.length) {
      dispatchEvent(new CustomEvent('yomu:diary', { detail: { entries: spoken } }));
      const pet = window.YomuPet;
      if (pet && pet.surface?.() !== 'reader' && pet.policy?.().bubbles) pet.say(spoken[spoken.length - 1].lines[0], 5200);
    }
    return spoken;
  }

  /* --- the You page ------------------------------------------------------------- */

  let showAll = false;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  function paint() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    const entries = diary().entries.filter((e) => e.lines).slice().reverse();
    host.textContent = '';
    if (!entries.length) {
      host.append(el('p', 'ysh-note', 'Mori writes a line or two when you finish a title. Nothing yet: the diary starts with the next one.'));
      return;
    }
    const list = el('div', 'ydy');
    for (const e of showAll ? entries : entries.slice(0, 4)) {
      const item = el('article', 'ydy__entry');
      const head = el('div', 'ydy__head');
      head.append(el('span', 'ydy__kicker', 'Mori · ' + new Date(e.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })));
      head.append(el('b', null, e.title || 'A title'));
      item.append(head);
      for (const line of e.lines) item.append(el('p', 'ydy__line', line));
      list.append(item);
    }
    host.append(list);
    if (entries.length > 4) {
      const more = el('button', 'ysh-off', showAll ? 'Show fewer' : 'Show all ' + entries.length);
      more.type = 'button';
      more.addEventListener('click', () => { showAll = !showAll; paint(); });
      host.append(more);
    }
  }

  const api = { compose, pending, write, repaint: paint, OPENERS, FLAVOUR };
  if (typeof window !== 'undefined') window.YomuDiary = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { compose, pending, OPENERS, FLAVOUR, BY_LENGTH };

  if (browser) {
    const boot = () => { write(); paint(); };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
    else setTimeout(boot, 300);
    addEventListener('yomu:progress', () => { write(); paint(); });
  }
})();
