/**
 * Yomu streak and mileage — the engines.
 *
 * Two engines and one observer, no DOM. yomu-streak-ui.js draws them.
 *
 * DERIVE, DO NOT INSTRUMENT. The reader lives in the compiled Expo bundle,
 * and it already writes every finished chapter to localStorage, one array
 * per series. Those arrays are the truth. Mileage is a cache computed from
 * them and can always be rebuilt; the streak is a record of the *days* on
 * which they grew, which the arrays cannot tell you afterwards -- so the
 * streak is the only genuinely new state here, and the only thing that syncs.
 *
 * The streak's rules, each the answer to a way a streak goes wrong:
 *   - A day ends at 04:00 local, not midnight. A chapter at 01:30 is still
 *     Tuesday night. Local time throughout; a time-zone change gives a long
 *     day or a short one, which errs forgiving.
 *   - One rest night is earned per seven consecutive days, three held at
 *     most, spent automatically against a missed day on rollover -- and
 *     never two in a row. A token covers a gap; it does not replace the
 *     habit. A streak that can be bought is not a streak.
 *   - `days` is append-only history. Breaking the streak sets current to 0
 *     and leaves the days true.
 *   - On a merge across devices, `current` is never taken from either side:
 *     it is recomputed from the merged days, so a phone that was offline
 *     for a week cannot hand back a streak that did not happen.
 */
(() => {
  'use strict';

  const STREAK_KEY = 'yomu.v1.streak';
  const MILEAGE_KEY = 'yomu.v1.mileage';
  const REMOTE_KEY = 'yomu.v1.streak.remote';
  const RESUME_PREFIX = 'yomu.v1.resume.local-account.';
  const READING_KEY = 'yomu.v1.reading';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const MAX_DAYS = 400;
  const MAX_REST = 3;
  const REST_EVERY = 7;

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
  /* Events go out wherever there is a dispatcher -- the tests supply one
     without a document. */
  const emit = (name, detail) => {
    if (typeof dispatchEvent === 'function' && typeof CustomEvent === 'function') dispatchEvent(new CustomEvent(name, { detail }));
  };

  /* --- day keys --------------------------------------------------------------- *
   * 'YYYY-MM-DD' in local time with the day starting at dayStartHour. Key
   * arithmetic is done in UTC on the key itself, so a DST change cannot make
   * two keys 23 or 25 hours apart. */

  const pad = (n) => String(n).padStart(2, '0');

  function dayKey(ts, startHour) {
    const d = new Date(ts === undefined ? Date.now() : ts);
    d.setHours(d.getHours() - (startHour === undefined ? 4 : startHour));
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  const keyToMs = (key) => Date.parse(key + 'T00:00:00Z');
  const shiftKey = (key, n) => new Date(keyToMs(key) + n * 86400000).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((keyToMs(b) - keyToMs(a)) / 86400000);
  const isKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k);

  /* --- stages ------------------------------------------------------------------ *
   * Six, travelling the way fire does: ember, orange, gold, pale, white, blue.
   * Brand gold is stage three, the middle. Each takes an equal sixth of the
   * bar so the next one is always the same distance away. */

  const STAGES = [
    { name: 'Ember', from: 1, to: 2, aurora: '#8c2f12', paper: '#7a280f' },
    { name: 'Kindling', from: 3, to: 6, aurora: '#c24a14', paper: '#a4400f' },
    { name: 'Steady burn', from: 7, to: 13, aurora: '#e0761e', paper: '#c0640f' },
    { name: 'Bright', from: 14, to: 29, aurora: '#e9b45c', paper: '#d08a16' },
    { name: 'White hot', from: 30, to: 59, aurora: '#f7d680', paper: '#e0a72c' },
    { name: 'Blue flame', from: 60, to: null, aurora: '#a9d4ff', paper: '#4f86cc' },
  ];

  function stageOf(days) {
    if (days < 1) return 0;
    for (let i = STAGES.length - 1; i >= 0; i--) if (days >= STAGES[i].from) return i;
    return 0;
  }

  function pctOf(days) {
    if (days < 1) return 0;
    const i = stageOf(days);
    const { from, to } = STAGES[i];
    const span = to ? to - from + 1 : 40;
    const within = Math.min(1, (days - from + 1) / span);
    return ((i + within) / 6) * 100;
  }

  function nextLabel(days) {
    if (days < 1) return 'Read a chapter to light it';
    const i = stageOf(days);
    const next = STAGES[i + 1];
    if (!next) return 'As hot as it gets. Keep it there.';
    const left = next.from - days;
    return next.name + ' at ' + next.from + ' days · ' + left + (left === 1 ? ' more day' : ' more days');
  }

  /* --- the streak state --------------------------------------------------------- */

  const EMPTY = {
    v: 1, days: [], current: 0, best: 0, restNights: 0, restUsed: [],
    lastRoll: null, dayStartHour: 4, updatedAt: 0,
  };

  function load() {
    const raw = readJSON(STREAK_KEY, null);
    if (!raw || typeof raw !== 'object') return { ...EMPTY };
    return {
      ...EMPTY, ...raw,
      days: Array.isArray(raw.days) ? raw.days.filter(isKey) : [],
      restUsed: Array.isArray(raw.restUsed) ? raw.restUsed.filter(isKey) : [],
    };
  }

  let state = load();
  const listeners = new Set();

  function save(next) {
    state = { ...next, updatedAt: Date.now() };
    writeJSON(STREAK_KEY, state);
    for (const fn of listeners) { try { fn(get()); } catch {} }
  }

  /**
   * Consecutive read days ending at the latest read day, counting only days
   * actually read. A rest day keeps the chain unbroken and adds nothing.
   * Pure: given days (asc, unique), rest days, it walks backwards.
   */
  function computeCurrent(days, restUsed) {
    if (!days.length) return 0;
    const read = new Set(days);
    const rest = new Set(restUsed);
    let count = 0;
    let cursor = days[days.length - 1];
    while (true) {
      if (read.has(cursor)) count++;
      else if (!rest.has(cursor)) break;
      cursor = shiftKey(cursor, -1);
    }
    return count;
  }

  /** Whether the chain ending at the latest read day is still alive today. */
  function alive(days, restUsed, today) {
    if (!days.length) return false;
    const rest = new Set(restUsed);
    const last = days[days.length - 1];
    /* Every day between the last read day and today must be covered by a
       rest night, except today itself, which is still open. */
    for (let d = shiftKey(last, 1); d < today; d = shiftKey(d, 1)) if (!rest.has(d)) return false;
    return true;
  }

  function todayKey(now) { return dayKey(now, state.dayStartHour); }

  /**
   * Advance to now: end days, spend a rest night where one may cover a gap,
   * break the streak otherwise. Idempotent within a day.
   */
  function rollover(now) {
    const today = todayKey(now);
    if (state.lastRoll === today) return get();
    let { restNights } = state;
    const restUsed = state.restUsed.slice();
    const read = new Set(state.days);
    const last = state.days[state.days.length - 1];

    if (last) {
      for (let d = shiftKey(last, 1); d < today; d = shiftKey(d, 1)) {
        if (read.has(d) || restUsed.includes(d)) continue;
        const before = shiftKey(d, -1);
        /* A token covers one missed day, and only after a day that was read
           -- never after another token. */
        if (restNights > 0 && read.has(before)) {
          restNights--;
          restUsed.push(d);
        } else break;
      }
    }
    restUsed.sort();
    const current = alive(state.days, restUsed, today) ? computeCurrent(state.days, restUsed) : 0;
    save({ ...state, restNights, restUsed: restUsed.slice(-60), current, lastRoll: today });
    return get();
  }

  /**
   * Mark the day containing ts as read. Idempotent within a day. Days are
   * append-only: a clock that moved backwards writes nothing.
   */
  function record(ts) {
    rollover(ts);
    const key = todayKey(ts);
    const last = state.days[state.days.length - 1];
    if (last === key) return { changed: false, current: state.current, crossed: null };
    if (last && key < last) return { changed: false, current: state.current, crossed: null };

    const days = [...state.days, key].slice(-MAX_DAYS);
    const wasStage = stageOf(state.current);
    const current = computeCurrent(days, state.restUsed);
    let restNights = state.restNights;
    if (current > 0 && current % REST_EVERY === 0) restNights = Math.min(MAX_REST, restNights + 1);
    const best = Math.max(state.best, current);
    save({ ...state, days, current, best, restNights, lastRoll: key });

    const stage = stageOf(current);
    const crossed = current > 1 && stage > wasStage ? stage : (current === 1 && !last ? 0 : null);
    if (crossed !== null) emit('yomu:streak-stage', { from: wasStage, to: stage, name: STAGES[stage].name, days: current });
    return { changed: true, current, crossed };
  }

  function spendRest(key) {
    if (state.restNights <= 0 || !isKey(key)) return false;
    if (state.days.includes(key) || state.restUsed.includes(key)) return false;
    const before = shiftKey(key, -1);
    if (!state.days.includes(before)) return false;
    const restUsed = [...state.restUsed, key].sort();
    const today = todayKey();
    save({ ...state, restNights: state.restNights - 1, restUsed, current: alive(state.days, restUsed, today) ? computeCurrent(state.days, restUsed) : 0 });
    return true;
  }

  /** Seven entries, Sunday first, for the week containing ref. */
  function week(ref, snapshot) {
    const s = snapshot || state;
    const today = dayKey(ref === undefined ? Date.now() : ref, s.dayStartHour);
    const dow = new Date(keyToMs(today)).getUTCDay();
    const sunday = shiftKey(today, -dow);
    const read = new Set(s.days);
    const rest = new Set(s.restUsed);
    const letters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    return letters.map((letter, i) => {
      const date = shiftKey(sunday, i);
      let st;
      if (read.has(date)) st = 'read';
      else if (rest.has(date)) st = 'rest';
      else if (date === today) st = 'today';
      else if (date > today) st = 'future';
      else st = 'missed';
      return { letter, date, state: st, today: date === today };
    });
  }

  const mode = () => {
    if (!browser) return 'paper';
    const set = document.documentElement.getAttribute('data-mode');
    if (set === 'dark') return 'aurora';
    if (set === 'system') return matchMedia('(prefers-color-scheme: dark)').matches ? 'aurora' : 'paper';
    return 'paper';
  };

  function get() {
    const today = todayKey();
    const stage = stageOf(state.current);
    const row = STAGES[stage];
    const m = mode();
    const ink = state.current ? row[m] : (m === 'aurora' ? '#6a809a' : '#9b9184');
    const last = state.days[state.days.length - 1] || null;
    return {
      current: state.current,
      best: state.best,
      stage,
      stageName: state.current ? row.name : 'Not lit',
      pct: pctOf(state.current),
      nextLabel: nextLabel(state.current),
      todayDone: last === today,
      restNights: state.restNights,
      restUsed: state.restUsed.slice(),
      days: state.days.slice(),
      lastDay: last,
      daysSince: last ? daysBetween(last, today) : null,
      week: week(undefined, state),
      ink,
      chip: ink + '29',
      pocket: ink + '29',
      mode: m,
      dayStartHour: state.dayStartHour,
    };
  }

  /* --- sync ----------------------------------------------------------------------- */

  /** Pure merge of two streak records. Order-independent: current is recomputed. */
  function merge(a, b, today) {
    const days = [...new Set([...(a?.days || []), ...(b?.days || [])].filter(isKey))].sort().slice(-MAX_DAYS);
    const restUsed = [...new Set([...(a?.restUsed || []), ...(b?.restUsed || [])].filter(isKey))].sort().slice(-60);
    const restNights = Math.max(0, Math.min(MAX_REST, Math.min(Number(a?.restNights ?? MAX_REST) || 0, Number(b?.restNights ?? MAX_REST) || 0)));
    const best0 = Math.max(Number(a?.best) || 0, Number(b?.best) || 0);
    const current = today && !alive(days, restUsed, today) ? 0 : computeCurrent(days, restUsed);
    return { days, restUsed, restNights, best: Math.max(best0, current), current, updatedAt: Math.max(Number(a?.updatedAt) || 0, Number(b?.updatedAt) || 0) };
  }

  /** What travels: history and tokens, never `current` (recomputed on arrival). */
  function forSync() {
    return { days: state.days.slice(), restUsed: state.restUsed.slice(), best: state.best, restNights: state.restNights, updatedAt: state.updatedAt };
  }

  function adopt(remote) {
    if (!remote || typeof remote !== 'object') return false;
    const merged = merge(forSync(), remote, todayKey());
    const changed = JSON.stringify(merged.days) !== JSON.stringify(state.days)
      || merged.best !== state.best || merged.restNights !== state.restNights
      || JSON.stringify(merged.restUsed) !== JSON.stringify(state.restUsed);
    if (!changed) return false;
    save({ ...state, ...merged, lastRoll: todayKey() });
    emit('yomu:streak-merged', get());
    return true;
  }

  /* A pull that lands before this file has loaded is parked under REMOTE_KEY
     by yomu-sync.js and picked up here. */
  function takeRemote() {
    const parked = readJSON(REMOTE_KEY, null);
    if (!parked) return;
    try { localStorage.removeItem(REMOTE_KEY); } catch {}
    adopt(parked);
  }

  /* --- mileage -------------------------------------------------------------------- *
   * Chapters per badge family, counted from the read arrays. A cache with a
   * cheap signature so ten page turns cost one recount at most. */

  const TIERS = [10, 40, 100, 250, 500];
  const CATEGORY_OF_COUNTRY = { JP: 'manga', KR: 'manhwa', CN: 'manhua' };
  const DEFAULT_FAMILY = { manga: 'realm-wanderer', manhwa: 'system-breaker', manhua: 'dao-seeker' };

  function tierOf(n) {
    let tier = 0;
    for (let i = 0; i < TIERS.length; i++) if (n >= TIERS[i]) tier = i + 1;
    return tier;
  }

  function progressIn(count) {
    const tier = tierOf(count);
    const nextAt = TIERS[tier] ?? null;
    const from = tier ? TIERS[tier - 1] : 0;
    return {
      count, tier, nextAt,
      remaining: nextAt ? Math.max(0, nextAt - count) : 0,
      pct: nextAt ? Math.min(100, Math.round(((count - from) / (nextAt - from)) * 100)) : 100,
    };
  }

  function readArrays() {
    const out = {};
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(RESUME_PREFIX) || !key.endsWith('.read')) continue;
        const list = readJSON(key, []);
        if (Array.isArray(list)) out[key.slice(RESUME_PREFIX.length, -'.read'.length)] = new Set(list.map(String)).size;
      }
    } catch {}
    return out;
  }

  function infoOf(seriesId) {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    for (const row of Array.isArray(collection.library) ? collection.library : []) {
      if (row && row.id === seriesId) return { title: row.title || '', category: String(row.category || '').toLowerCase() };
    }
    for (const record of Object.values(readJSON(READING_KEY, {}) || {})) {
      if (record && record.seriesId === seriesId) return { title: record.title || '', category: '' };
    }
    return { title: '', category: '' };
  }

  /**
   * One family per series: the category narrows the field, the first tag
   * rule that matches wins, and no match falls to the category's broadest
   * family. A series nobody can describe counts toward the total only.
   */
  function familyOf(seriesId, lookup) {
    const info = (lookup || infoOf)(seriesId);
    const meta = info.title ? (typeof window !== 'undefined' && window.YomuAniList?.cached?.(info.title)) || null : null;
    let category = CATEGORY_OF_COUNTRY[meta?.country] || (DEFAULT_FAMILY[info.category] ? info.category : '');
    const tags = [...(meta?.tags || []).map((t) => (t && t.name) || t), ...(meta?.genres || [])].filter(Boolean);
    const families = typeof window !== 'undefined' && window.YomuProgress?.familiesForTags ? window.YomuProgress.familiesForTags(tags) : [];
    const catOf = (slug) => (typeof window !== 'undefined' && window.YomuBadges?.families?.[slug]?.cat) || '';
    if (category) {
      const own = families.find((f) => catOf(f) === category);
      if (own) return own;
      if (families.length && !families.some((f) => catOf(f))) return families[0];
      return DEFAULT_FAMILY[category];
    }
    return families[0] || null;
  }

  let mileage = readJSON(MILEAGE_KEY, null) || { v: 1, sig: '', total: 0, byCategory: {}, byFamily: {}, tiers: {}, families: {}, countedAt: 0 };
  const mileageListeners = new Set();

  function recount(opts) {
    const counts = readArrays();
    const ids = Object.keys(counts).sort();
    const sig = ids.map((id) => counts[id]).join(':') + '#' + ids.length;
    if (!(opts && opts.force) && sig === mileage.sig) return mileage;

    const byFamily = {};
    const byCategory = { manga: 0, manhwa: 0, manhua: 0 };
    const families = { ...(mileage.families || {}) };
    let total = 0;
    for (const id of ids) {
      total += counts[id];
      if (!families[id] || opts?.force) {
        const slug = familyOf(id);
        if (slug) families[id] = slug; else delete families[id];
      }
      const slug = families[id];
      if (!slug) continue;
      byFamily[slug] = (byFamily[slug] || 0) + counts[id];
      const cat = typeof window !== 'undefined' && window.YomuBadges?.families?.[slug]?.cat;
      if (cat && cat in byCategory) byCategory[cat] += counts[id];
    }
    const tiers = {};
    for (const [slug, n] of Object.entries(byFamily)) tiers[slug] = tierOf(n);

    const before = mileage.tiers || {};
    mileage = { v: 1, sig, total, byCategory, byFamily, tiers, families, countedAt: Date.now() };
    writeJSON(MILEAGE_KEY, mileage);

    /* The store's affinity is this, now: one truth for badge tiers, rebuilt
       from the arrays rather than accrued. */
    if (typeof window !== 'undefined' && window.YomuProgress?.setAffinity) window.YomuProgress.setAffinity(byFamily);

    for (const [slug, tier] of Object.entries(tiers)) {
      if (tier > (before[slug] || 0)) emit('yomu:badge-tier', { family: slug, from: before[slug] || 0, to: tier, count: byFamily[slug] });
    }
    for (const fn of mileageListeners) { try { fn(mileageGet()); } catch {} }
    return mileage;
  }

  function mileageGet() {
    const leading = {};
    for (const [slug, n] of Object.entries(mileage.byFamily || {})) {
      const cat = typeof window !== 'undefined' && window.YomuBadges?.families?.[slug]?.cat;
      if (!cat) continue;
      if (!leading[cat] || n > leading[cat].count) leading[cat] = { family: slug, count: n, tier: tierOf(n) };
    }
    return { ...mileage, leading };
  }

  /** Families within `limit` of their next tier, nearest first. */
  function closeToEarning(limit) {
    const rows = [];
    for (const [slug, n] of Object.entries(mileage.byFamily || {})) {
      const p = progressIn(n);
      if (!p.nextAt) continue;
      rows.push({ family: slug, ...p });
    }
    rows.sort((a, b) => a.remaining - b.remaining || b.count - a.count);
    return rows.slice(0, limit || 3);
  }

  /* --- the observer ------------------------------------------------------------------ *
   * Writes in this tab (a setItem patch), writes in other tabs (the storage
   * event) and a slow poll for anything missed. Mileage first, then the
   * streak, so toasts can be ordered deliberately. */

  let queued = 0;
  let lastTotal = null;

  function tick(reason) {
    const before = lastTotal;
    const m = recount();
    if (before !== null && m.total > before) record();
    else if (before === null && m.total > 0 && !state.days.length) {
      /* First ever run on a device with history: today counts, the past
         cannot be recovered. */
      record();
    }
    lastTotal = m.total;
    rollover();
  }

  function queue() {
    clearTimeout(queued);
    queued = setTimeout(() => { queued = 0; tick('write'); }, 400);
  }

  /* --- public shape ------------------------------------------------------------------- */

  const streakApi = {
    get, record, rollover, dayKey: (ts) => dayKey(ts, state.dayStartHour), week: (ref) => week(ref, state),
    stageOf, pctOf, nextLabel, spendRest, merge, forSync, adopt,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    STAGES,
    reset() { state = { ...EMPTY }; writeJSON(STREAK_KEY, state); },
    __set(patch) { save({ ...state, ...patch }); },
  };
  const mileageApi = {
    get: mileageGet, recount, familyOf, tierOf, progressIn, closeToEarning, TIERS,
    subscribe(fn) { mileageListeners.add(fn); return () => mileageListeners.delete(fn); },
  };

  /** Kept for yomu-streak-ui.js and the tests: how sleepy Mori is for a gap. */
  function mood(daysSince) {
    if (daysSince === null || daysSince === undefined) return 0;
    if (daysSince >= 4) return 2;
    if (daysSince >= 2) return 1;
    return 0;
  }

  if (typeof window !== 'undefined') {
    window.YomuStreak = streakApi;
    window.YomuMileage = mileageApi;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      dayKey, shiftKey, stageOf, pctOf, nextLabel, computeCurrent, alive, merge, week, mood,
      STAGES, TIERS, tierOf, progressIn, MAX_REST, REST_EVERY,
    };
  }

  /* --- boot --------------------------------------------------------------------------- */

  if (browser) {
    try {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        setItem.call(this, key, value);
        try {
          if (key === READING_KEY || (String(key).startsWith(RESUME_PREFIX) && String(key).endsWith('.read'))) queue();
        } catch {}
      };
    } catch {}
    addEventListener('storage', (event) => {
      if (!event.key || event.key === READING_KEY || (event.key.startsWith(RESUME_PREFIX) && event.key.endsWith('.read'))) queue();
      if (event.key === REMOTE_KEY) takeRemote();
    });
    addEventListener('yomu:chapter-complete', queue);
    addEventListener('yomu:streak-remote', takeRemote);
    addEventListener('visibilitychange', () => { if (!document.hidden) { rollover(); queue(); } });
    setInterval(() => tick('poll'), 30000);

    /* A timer for the next day boundary, so a page left open rolls over. */
    const armBoundary = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(state.dayStartHour, 0, 5, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      setTimeout(() => { rollover(); armBoundary(); }, Math.min(next - now, 2147000000));
    };
    armBoundary();

    const boot = () => { takeRemote(); tick('boot'); };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
