/**
 * Yomu progression — the one place that knows how much you have read.
 *
 * Four surfaces want these numbers: the You page's stat tiles, the mileage
 * roadmap, the badge shelf, and the pet. Before this file each of them
 * counted for itself, and `you.html` counted by walking every key in
 * localStorage on every visit. Four answers to one question is the failure
 * mode the roadmap document warns about by name, so there is exactly one
 * counter here and everything else reads it.
 *
 * The app does not tell us when a chapter is finished.
 *
 * Read chapters live in `yomu.v1.resume.local-account.<seriesId>.read`, an
 * array the Expo bundle appends to when a chapter reaches its last page. We
 * do not own that code and there is no event and no storage listener. So the
 * count is mirrored here and re-derived on the three moments where it can
 * actually have changed -- a route change, the tab coming back to the front,
 * and leaving the reader -- and the difference is emitted as an event. That
 * is a scan on three triggers instead of one per render, and it survives the
 * bundle being rebuilt, which a string anchor into minified code would not.
 *
 * Everything is derived from the store, never recomputed by a consumer:
 *
 *   yomu:progress          canonical counters changed
 *   yomu:chapter-complete  one or more chapters finished since last look
 *   yomu:reward            a milestone paid out, exactly once
 *
 * Reward truth lives in `yomu.v1.progress`. Presentation -- which pet, where
 * it sits, whether it is muted -- is not reward truth and lives elsewhere.
 */
(() => {
  'use strict';

  const KEY = 'yomu.v1.progress';
  const RESUME_PREFIX = 'yomu.v1.resume.local-account.';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const THEME_CACHE_KEY = 'yomu.v1.affinity';

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const today = () => new Date().toISOString().slice(0, 10);
  const daysBetween = (a, b) =>
    Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

  /* --- the store --------------------------------------------------------- *
   *
   * One versioned key. A migration reads the old shape and writes the new
   * one under a new version; nothing ever changes meaning under the same
   * version, because a half-upgraded device is indistinguishable from a
   * corrupt one.
   */

  const EMPTY = {
    v: 1,
    chaptersRead: 0,
    titlesCompleted: 0,
    currentStreak: 0,
    longestStreak: 0,
    librarySize: 0,
    sourcesUsed: 0,
    sourceRescues: 0,

    petUnlocked: false,
    petXp: 0,

    earnedBadgeIds: [],
    earnedStickerIds: [],
    earnedCosmeticIds: [],
    featuredBadgeIds: [],
    pinnedStickerIds: [],
    equippedBadgeId: null,

    /** familySlug -> affinity XP. Drives which badge you are earning. */
    affinity: {},
    /** Countries of origin read from -- KR, JP, CN. A union that never
     *  shrinks, because the metadata cache it is read off does. */
    origins: [],
    /** Milestone ids already paid. The guard against paying twice. */
    claimed: [],
    /** Mirror of the derived chapter count, so a delta can be spotted. */
    seenChapters: 0,
    /** ISO day of the last chapter finished, for the streak. */
    lastReadDay: null,
    /** The last thirty ISO days a chapter was finished on, newest last, so
     *  a week strip can be drawn. History, not truth: the streak is
     *  computed from lastReadDay and currentStreak, not from this list. */
    readDays: [],
  };

  function load() {
    const raw = readJSON(KEY, null);
    if (!raw || typeof raw !== 'object') return { ...EMPTY };
    if (raw.v !== 1) return { ...EMPTY, ...migrate(raw) };
    return { ...EMPTY, ...raw };
  }

  /** No older version exists yet; the hook is here so the first one is cheap. */
  function migrate(raw) {
    return { v: 1 };
  }

  let store = load();
  const get = () => ({ ...store });

  function save(patch) {
    store = { ...store, ...patch };
    writeJSON(KEY, store);
  }

  const emit = (name, detail) =>
    dispatchEvent(new CustomEvent(name, { detail }));

  /* --- milestones -------------------------------------------------------- *
   *
   * Data, not conditionals. Adding a stop to the roadmap is a row here, and
   * the evaluator never learns a new branch.
   *
   * The mockup's road draws three stops -- 10, 20, 50. The engine also knows
   * about 5, which pays a sticker and is deliberately not drawn: the first
   * one should arrive before you have been told to expect it.
   */

  const MILESTONES = [
    {
      id: 'first-steps',
      metric: 'chaptersRead',
      threshold: 5,
      title: 'First Steps',
      rewards: [{ type: 'sticker', id: 'reader-first-steps' }],
    },
    {
      id: 'page-turner',
      metric: 'chaptersRead',
      threshold: 10,
      title: 'Page Turner',
      rewards: [
        { type: 'badge', id: 'page-turner' },
        { type: 'sticker', id: 'page-turner-sticker' },
      ],
    },
    {
      id: 'little-bookworm',
      metric: 'chaptersRead',
      threshold: 20,
      title: 'Little Bookworm',
      rewards: [{ type: 'xp', amount: 40 }],
    },
    {
      id: 'book-goblin',
      metric: 'chaptersRead',
      threshold: 50,
      title: 'Book Goblin',
      rewards: [
        { type: 'badge', id: 'book-goblin' },
        { type: 'pet-unlock', id: 'mori' },
      ],
    },

    /* Past fifty. A reader at chapter 51 had nothing left to chase, and
       these are the readers who are actually here. The spacing widens the
       way reading does: the gap from 50 to 100 is a fortnight for a binge
       reader; 500 to 1000 is a year. */
    {
      id: 'century',
      metric: 'chaptersRead',
      threshold: 100,
      title: 'Century',
      rewards: [
        { type: 'badge', id: 'century' },
        { type: 'sticker', id: 'century-sticker' },
      ],
    },
    {
      id: 'shelf-bender',
      metric: 'chaptersRead',
      threshold: 250,
      title: 'Shelf Bender',
      rewards: [
        { type: 'badge', id: 'shelf-bender' },
        { type: 'xp', amount: 60 },
      ],
    },
    {
      id: 'tome-eater',
      metric: 'chaptersRead',
      threshold: 500,
      title: 'Tome Eater',
      rewards: [
        { type: 'badge', id: 'tome-eater' },
        { type: 'sticker', id: 'tome-eater-sticker' },
      ],
    },
    {
      id: 'living-library',
      metric: 'chaptersRead',
      threshold: 1000,
      title: 'Living Library',
      rewards: [
        { type: 'badge', id: 'living-library' },
        { type: 'sticker', id: 'living-library-sticker' },
      ],
    },

    /* Trails: the milestones that are not a chapter count. Drawn on the You
       page under the road rather than on it, because "5 sources" is not a
       distance along the same line as "100 chapters". */
    {
      id: 'well-sourced',
      metric: 'sourcesUsed',
      threshold: 5,
      title: 'Well Sourced',
      how: 'Five sources switched on',
      rewards: [
        { type: 'badge', id: 'well-sourced' },
        { type: 'sticker', id: 'well-sourced-sticker' },
      ],
    },
    {
      id: 'finisher',
      metric: 'titlesCompleted',
      threshold: 1,
      title: 'Finisher',
      how: 'Read a saved title to its last chapter',
      rewards: [
        { type: 'badge', id: 'finisher' },
        { type: 'sticker', id: 'finisher-sticker' },
      ],
    },
    {
      id: 'closer',
      metric: 'titlesCompleted',
      threshold: 10,
      title: 'Closer',
      how: 'Ten titles finished',
      rewards: [
        { type: 'badge', id: 'closer' },
        { type: 'xp', amount: 80 },
      ],
    },
    {
      id: 'three-shores',
      metric: 'originsRead',
      threshold: 3,
      title: 'Three Shores',
      how: 'A title each from Korea, Japan and China',
      rewards: [
        { type: 'badge', id: 'three-shores' },
        { type: 'sticker', id: 'three-shores-sticker' },
      ],
    },

    /* Stage badges. Paid by XP at the same thresholds as STAGES, so a stage
       change and its badge arrive in the same pulse. `quiet` keeps the
       generic unlock toast away: the evolution ceremony is the announcement,
       and two announcements of one moment is one too many. */
    { id: 'stage-fledgling', metric: 'petXp', threshold: 60, title: 'Fledgling', quiet: true,
      rewards: [{ type: 'badge', id: 'stage-fledgling' }] },
    { id: 'stage-companion', metric: 'petXp', threshold: 200, title: 'Companion', quiet: true,
      rewards: [{ type: 'badge', id: 'stage-companion' }] },
    { id: 'stage-familiar', metric: 'petXp', threshold: 480, title: 'Familiar', quiet: true,
      rewards: [{ type: 'badge', id: 'stage-familiar' }] },
    { id: 'stage-sage', metric: 'petXp', threshold: 1000, title: 'Sage', quiet: true,
      rewards: [{ type: 'badge', id: 'stage-sage' }] },

    /* Streaks. Never punitive: a missed day resets the count and keeps the
       best, and nothing here is taken back. The metric is the *live* streak
       (see streak()), so a seven from last month does not pay today. */
    {
      id: 'streak-week',
      metric: 'currentStreak',
      threshold: 7,
      title: 'Week of Pages',
      how: 'Seven days reading in a row',
      rewards: [{ type: 'badge', id: 'streak-week' }],
    },
    {
      id: 'streak-month',
      metric: 'currentStreak',
      threshold: 30,
      title: 'Month of Pages',
      how: 'Thirty days in a row',
      rewards: [
        { type: 'badge', id: 'streak-month' },
        { type: 'sticker', id: 'streak-month-sticker' },
      ],
    },
    {
      id: 'streak-hundred',
      metric: 'currentStreak',
      threshold: 100,
      title: 'Hundred Days',
      how: 'A hundred days in a row',
      rewards: [{ type: 'badge', id: 'streak-hundred' }],
    },
  ];

  /**
   * Pet evolution stages. Progress is measured against the span of the
   * current stage, not against the absolute threshold -- otherwise a reader
   * at 127 XP between 100 and 200 shows as 63% done with a stage they are
   * actually 27% into, and the bar crawls at the top of every stage.
   */
  const STAGES = [
    { level: 1, name: 'Hatchling', at: 0 },
    { level: 2, name: 'Fledgling', at: 60 },
    { level: 3, name: 'Companion', at: 200 },
    { level: 4, name: 'Familiar', at: 480 },
    { level: 5, name: 'Sage', at: 1000 },
  ];

  function stageOf(xp) {
    let index = 0;
    for (let i = 0; i < STAGES.length; i++) if (xp >= STAGES[i].at) index = i;
    const current = STAGES[index];
    const next = STAGES[index + 1] || null;
    const span = next ? next.at - current.at : 0;
    return {
      ...current,
      next,
      /* Clamped both ways: a stage with no successor is complete, not
         infinite, and a hand-edited XP below the floor is 0 rather than
         negative. */
      progress: next ? clamp(((xp - current.at) / span) * 100, 0, 100) : 100,
      remaining: next ? Math.max(next.at - xp, 0) : 0,
    };
  }

  /* --- badge affinity ---------------------------------------------------- *
   *
   * A badge says what you like reading, so it has to come from the titles
   * themselves. The theme tags for a series are resolved once and cached
   * forever; a series does not change genre.
   *
   * Broad genres are dropped outright. A shared "Action" tag is not a taste
   * -- worker/related.ts made the same call for the same reason, and this is
   * the same list, deliberately, so the two cannot drift into disagreeing
   * about what a genre means.
   */

  const BROAD = new Set([
    'action', 'adventure', 'drama', 'comedy', 'romance', 'fantasy',
    'slice of life', 'mystery', 'sci-fi', 'psychological',
  ]);

  /**
   * Tag vocabulary -> badge family. First match wins, so the specific
   * patterns are listed before the general ones they would otherwise be
   * swallowed by: "reincarnation" before "isekai", "xianxia" before
   * "cultivation", or every cultivation novel becomes a World Hopper.
   */
  const FAMILY_RULES = [
    ['tower-climber', /\btower|\bfloor\b|climb/],
    ['dungeon-raider', /dungeon|\bgate(s)?\b|raid|hunter/],
    ['returner', /regress|returner|rewind|time travel|do-over|second chance/],
    ['second-lifer', /reincarnat|rebirth|another life/],
    ['system-breaker', /\bsystem\b|level ?up|leveling|status window|\bs-rank|player/],
    ['murim-wanderer', /murim|martial world|\bsect war/],
    ['academy-prodigy', /academy|school life|magic school/],
    ['villainess-enjoyer', /villainess|otome/],
    ['contract-romantic', /contract marriage|arranged marriage|office romance/],
    ['power-fantasy-addict', /overpowered|\bop mc|invincible|strongest/],

    ['immortal-aspirant', /xianxia|immortal|ascension/],
    ['jianghu-wanderer', /wuxia|jianghu/],
    ['pill-master', /alchemy|pill|elixir/],
    ['spirit-tamer', /spirit beast|beast tam|monster tam|familiar/],
    ['sect-elder', /\bsect\b|\bclan\b|elder/],
    ['court-strategist', /court|palace|imperial|politic|strategy/],
    ['heaven-defier', /heaven|dao heart|defier/],
    ['martial-disciple', /martial art|kung fu|\bfist\b/],
    ['reborn-sage', /sage|enlighten/],
    ['dao-seeker', /cultivat|\bdao\b|\bqi\b|xuanhuan/],

    ['world-hopper', /isekai|another world|summoned|transmigrat/],
    ['battle-junkie', /shounen|shonen|martial tournament|battle/],
    ['yokai-watcher', /horror|supernatural|ghost|demon|yokai|zombie/],
    ['truth-seeker', /thriller|detective|crime|investigat|suspense/],
    ['final-challenger', /sports|boxing|football|basketball|racing/],
    ['ronin-reader', /samurai|historical|\bedo\b|feudal|ninja/],
    ['starbound-pilot', /sci-?fi|mecha|space|cyberpunk|robot/],
    ['heart-chaser', /shoujo|shojo|love triangle|romantic comedy/],
    ['quiet-observer', /slice of life|iyashikei|cooking|healing/],
    ['realm-wanderer', /high fantasy|magic|sword and sorcery|adventure fantasy/],
  ];

  /** The greeting corpus gates on four of these; keep the keys in step. */
  const GREETING_GATE = {
    'dao-seeker': 'c', 'immortal-aspirant': 'c', 'jianghu-wanderer': 'c',
    'martial-disciple': 'c', 'sect-elder': 'c', 'heaven-defier': 'c',
    'pill-master': 'c', 'reborn-sage': 'c',
    'system-breaker': 's', 'dungeon-raider': 's',
    'tower-climber': 't',
    'returner': 'r', 'second-lifer': 'r',
  };

  function familiesForTags(tags) {
    const found = new Set();
    for (const raw of tags || []) {
      const tag = String(raw || '').toLowerCase().trim();
      if (!tag || BROAD.has(tag)) continue;
      for (const [slug, pattern] of FAMILY_RULES) {
        if (pattern.test(tag)) { found.add(slug); break; }
      }
    }
    return [...found];
  }

  const themeCache = () => readJSON(THEME_CACHE_KEY, {}) || {};

  /**
   * The tags for one series, resolved once.
   *
   * `/api/catalog/related` already computes this for the series page and is
   * edge-cached for an hour, so asking it costs nothing most of the time. It
   * is only ever called after a chapter is finished -- never on a page load,
   * and never for the whole library -- so a reader who never finishes
   * anything never makes the request.
   */
  async function themesFor(sourceId, seriesId, title) {
    const key = sourceId + ':' + seriesId;
    const cache = themeCache();
    if (cache[key]) return cache[key];

    let tags = [];
    try {
      const params = new URLSearchParams({ id: seriesId, source: sourceId });
      if (title) params.set('title', title);
      const response = await fetch('/api/catalog/related?' + params.toString());
      if (response.ok) {
        const data = await response.json();
        tags = Array.isArray(data.similarBecause) ? data.similarBecause : [];
      }
    } catch {}

    /* An empty answer is cached too. Without that, a series the catalogue
       cannot identify is re-fetched on every chapter of a 200-chapter run. */
    const families = familiesForTags(tags);
    cache[key] = families;
    writeJSON(THEME_CACHE_KEY, cache);
    return families;
  }

  /* --- derivation -------------------------------------------------------- */

  /** Chapters finished, counted off the app's own read lists. */
  function deriveChapters() {
    let total = 0;
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(RESUME_PREFIX) || !key.endsWith('.read')) continue;
        const list = readJSON(key, []);
        if (Array.isArray(list)) total += list.length;
      }
    } catch {}
    return total;
  }

  function deriveLibrary() {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    const library = Array.isArray(collection.library) ? collection.library : [];
    const sources = Array.isArray(collection.sources) ? collection.sources : [];
    return {
      librarySize: library.filter((t) => t && !t.hidden).length,
      sourcesUsed: sources.filter((s) => s && s.enabled).length,
      titlesCompleted: deriveCompleted(library),
      origins: deriveOrigins(library),
    };
  }

  /** The finished chapters of one saved title, off the app's own list. */
  function readCount(seriesId) {
    const list = readJSON(RESUME_PREFIX + seriesId + '.read', []);
    return Array.isArray(list) ? list.length : 0;
  }

  /**
   * A saved title is finished when every chapter it has is in the read list.
   *
   * Only titles that say how many chapters they have count: a row with no
   * total cannot be finished, only read a lot, and "finished" is a claim the
   * roadmap makes in the reader's name. Conservative on purpose -- the read
   * list is ids, not numbers, so a series read across two sources can hold
   * more entries than chapters and still be genuinely finished; that direction
   * is fine. The other direction, calling something finished that is not, is
   * the one that would read as a lie.
   */
  function deriveCompleted(library) {
    let done = 0;
    for (const row of library) {
      if (!row || row.hidden || !row.id) continue;
      const total = Number(row.total);
      if (!Number.isFinite(total) || total <= 0) continue;
      if (readCount(row.id) >= total) done++;
    }
    return done;
  }

  const ANILIST_CACHE_KEY = 'yomu.v1.anilist';
  const ORIGINS = new Set(['KR', 'JP', 'CN']);

  /**
   * Which of the three origins the reader has read from, unioned with what
   * the store already knows.
   *
   * The country comes from AniList by way of yomu-anilist.js's cache, which
   * is keyed by lowercased title and holds a hundred-odd rows for a week.
   * Read directly rather than through that file's API: this store loads
   * first in the chain and a metric that waits on a later script is a
   * metric that is sometimes zero. The union is what makes the cache's
   * eviction harmless -- a shore reached stays reached.
   */
  function deriveOrigins(library) {
    const known = new Set(Array.isArray(store.origins) ? store.origins : []);
    const cache = readJSON(ANILIST_CACHE_KEY, {}) || {};
    for (const row of library) {
      if (!row || !row.id || !row.title) continue;
      if (!readCount(row.id)) continue;
      const hit = cache[String(row.title).trim().toLowerCase()];
      const country = hit && hit.answer && hit.answer.country;
      if (country && ORIGINS.has(country)) known.add(country);
    }
    return [...known].sort();
  }

  /**
   * The streak, advanced only by finishing something.
   *
   * Opening the app is not reading. A streak that counts visits rewards
   * checking in, which is the opposite of what it is for.
   */
  function bumpStreak(patch) {
    const day = today();
    if (store.lastReadDay === day) return;
    const gap = store.lastReadDay ? daysBetween(store.lastReadDay, day) : null;
    const streak = gap === 1 ? store.currentStreak + 1 : 1;
    patch.lastReadDay = day;
    patch.currentStreak = streak;
    patch.longestStreak = Math.max(store.longestStreak, streak);
    const days = Array.isArray(store.readDays) ? store.readDays.filter((d) => d !== day) : [];
    days.push(day);
    patch.readDays = days.slice(-30);
  }

  /**
   * The streak as it stands right now, not as it stood the last time a
   * chapter was finished.
   *
   * `currentStreak` in the store is only ever written on a read, so a reader
   * who stopped a fortnight ago still has "7" sitting there. Two days
   * without reading is a streak of nothing -- shown as 0, and the best is
   * kept. Yesterday still counts: the day is not over until you have missed
   * the whole of it.
   */
  function streak() {
    const last = store.lastReadDay;
    const since = last ? daysBetween(last, today()) : null;
    const alive = since !== null && since <= 1;
    return {
      current: alive ? store.currentStreak : 0,
      longest: store.longestStreak,
      lastReadDay: last,
      /** Days since the last finished chapter; null when there never was one. */
      daysSince: since,
      /* Stores written before readDays existed have a lastReadDay and no
         list; the day it names is still a day something was read. */
      readDays: [...new Set([...(Array.isArray(store.readDays) ? store.readDays : []), ...(last ? [last] : [])])].sort(),
      /** Today has a chapter in it already. */
      today: last === today(),
    };
  }

  /* --- the evaluator ----------------------------------------------------- *
   *
   * Only the milestones for the metric that moved are looked at, and a
   * milestone already in `claimed` is never looked at again. That is what
   * makes a reward arrive exactly once even though the counter it watches is
   * re-derived from scratch on every trigger.
   */

  function evaluate(metrics) {
    const claimed = new Set(store.claimed);
    const paid = [];
    const patch = {};

    for (const milestone of MILESTONES) {
      if (claimed.has(milestone.id)) continue;
      if (!(milestone.metric in metrics)) continue;
      if (metrics[milestone.metric] < milestone.threshold) continue;

      claimed.add(milestone.id);
      paid.push(milestone);

      for (const reward of milestone.rewards) {
        if (reward.type === 'xp') {
          patch.petXp = (patch.petXp ?? store.petXp) + reward.amount;
        } else if (reward.type === 'badge') {
          const earned = new Set(patch.earnedBadgeIds ?? store.earnedBadgeIds);
          earned.add(reward.id);
          patch.earnedBadgeIds = [...earned];
        } else if (reward.type === 'sticker') {
          const earned = new Set(patch.earnedStickerIds ?? store.earnedStickerIds);
          earned.add(reward.id);
          patch.earnedStickerIds = [...earned];
        } else if (reward.type === 'pet-unlock') {
          patch.petUnlocked = true;
        }
      }
    }

    if (paid.length) patch.claimed = [...claimed];
    return { patch, paid };
  }

  /**
   * Affinity tiers, evaluated the same way but generated rather than listed:
   * 30 families times 5 tiers is 150 rows nobody should hand-write, and the
   * thresholds are the same ladder for every family.
   */
  const TIER_XP = [10, 40, 120, 300, 700];

  function evaluateAffinity(patch) {
    const earned = new Set(patch.earnedBadgeIds ?? store.earnedBadgeIds);
    const before = earned.size;
    const paid = [];

    for (const [slug, xp] of Object.entries(store.affinity)) {
      for (let tier = TIER_XP.length; tier >= 1; tier--) {
        if (xp < TIER_XP[tier - 1]) continue;
        const id = slug + ':' + tier;
        if (!earned.has(id)) {
          earned.add(id);
          paid.push({
            id: 'affinity-' + id,
            title: slug,
            tier,
            rewards: [{ type: 'badge', id }],
          });
        }
        break;
      }
    }

    if (earned.size !== before) patch.earnedBadgeIds = [...earned];
    return paid;
  }

  /* --- the pulse --------------------------------------------------------- *
   *
   * One function, three triggers. It re-derives, diffs, pays, and emits.
   * Nothing else in the codebase is allowed to write the counters.
   */

  let running = false;

  async function pulse(reason) {
    if (running) return;
    running = true;
    try {
      const chapters = deriveChapters();
      const library = deriveLibrary();
      const delta = chapters - store.seenChapters;

      const patch = { seenChapters: chapters, chaptersRead: chapters, ...library };

      /* A negative delta means the app's read lists shrank -- a device wiped,
         or a series removed. The counter follows it down, but nothing is paid
         and no chapter event fires, because nothing was read. */
      if (delta > 0) {
        patch.petXp = store.petXp + delta;
        bumpStreak(patch);

        const context = readerContext();
        if (context) {
          const families = await themesFor(context.sourceId, context.seriesId, context.title);
          if (families.length) {
            const affinity = { ...store.affinity };
            /* Split across the families a series matches rather than paying
               each in full: a title tagged both tower and system should not
               earn twice as fast as one tagged only tower. */
            const share = delta / families.length;
            for (const slug of families) affinity[slug] = (affinity[slug] || 0) + share;
            patch.affinity = affinity;
          }
        }
      }

      save(patch);

      /* Evaluated until nothing more pays out, because a reward can move a
         metric: Little Bookworm pays 40 XP, and 40 XP is what carries a
         reader at chapter twenty over the Fledgling line. Taken once, the
         stage badge arrived one pulse late -- on the next route change, or
         the next morning -- as an unlock nobody had done anything to earn
         just then. Bounded: only XP rewards move a metric, and no XP
         milestone pays XP, so two rounds is the most this ever takes. */
      const paid = [];
      for (let round = 0; round < 4; round++) {
        const metrics = {
          chaptersRead: store.chaptersRead,
          titlesCompleted: store.titlesCompleted,
          currentStreak: streak().current,
          sourcesUsed: store.sourcesUsed,
          sourceRescues: store.sourceRescues,
          originsRead: (store.origins || []).length,
          petXp: store.petXp,
        };
        const result = evaluate(metrics);
        if (!result.paid.length) break;
        paid.push(...result.paid);
        save(result.patch);
      }
      const affinityPatch = {};
      const affinityPaid = evaluateAffinity(affinityPatch);
      if (Object.keys(affinityPatch).length) save(affinityPatch);

      if (delta > 0) emit('yomu:chapter-complete', { count: delta, total: chapters });
      for (const milestone of [...paid, ...affinityPaid]) {
        emit('yomu:reward', {
          milestoneId: milestone.id,
          title: milestone.title,
          rewards: milestone.rewards,
          quiet: !!milestone.quiet,
        });
      }
      emit('yomu:progress', { reason, state: get() });
    } finally {
      running = false;
    }
  }

  /** Which series the reader is in, so a finished chapter can be attributed. */
  function readerContext() {
    if (!location.pathname.startsWith('/read/')) return null;
    const raw = location.pathname.slice('/read/'.length);
    if (!raw) return null;
    let chapterId = raw;
    try { chapterId = decodeURIComponent(raw); } catch {}
    const sourceId = new URLSearchParams(location.search).get('source') || '';
    if (!sourceId) return null;
    return {
      sourceId,
      seriesId: chapterId.split(':')[0],
      /* The title is a nicety for the catalogue lookup, not a requirement,
         and this file is also loaded outside a browser by its tests. */
      title: typeof document === 'undefined'
        ? ''
        : document.querySelector('.rd-head__copy strong')?.textContent?.trim() || '',
    };
  }

  /* --- public shape ------------------------------------------------------ */

  const api = {
    get,
    stageOf: () => stageOf(store.petXp),
    streak,
    stages: () => STAGES.slice(),
    milestones: () => MILESTONES.slice(),
    tierXp: () => TIER_XP.slice(),

    /** Roadmap rows: the chapter stops from ten up, with live state on each.
     *  The five-chapter sticker stays undrawn -- the first reward should
     *  arrive before you have been told to expect it. */
    roadmap() {
      const claimed = new Set(store.claimed);
      return MILESTONES.filter((m) => m.metric === 'chaptersRead' && m.threshold >= 10).map((m) => ({
        ...m,
        collected: claimed.has(m.id),
        progress: clamp((store.chaptersRead / m.threshold) * 100, 0, 100),
        remaining: Math.max(m.threshold - store.chaptersRead, 0),
      }));
    },

    /** The trails: milestones on a metric other than chapters, and not the
     *  stage badges, which the ceremony announces on its own. */
    trails() {
      const claimed = new Set(store.claimed);
      const metrics = {
        titlesCompleted: store.titlesCompleted,
        sourcesUsed: store.sourcesUsed,
        originsRead: (store.origins || []).length,
        currentStreak: streak().current,
      };
      return MILESTONES.filter((m) => m.metric in metrics).map((m) => ({
        ...m,
        value: metrics[m.metric],
        collected: claimed.has(m.id),
        progress: clamp((metrics[m.metric] / m.threshold) * 100, 0, 100),
        remaining: Math.max(m.threshold - metrics[m.metric], 0),
      }));
    },

    /** Every badge the roadmap can pay, in the order it pays them, so a
     *  shelf can draw the locked ones too. Affinity badges are not here:
     *  thirty families times five tiers is not a shelf, it is a wall. */
    milestoneBadges() {
      const claimed = new Set(store.claimed);
      const out = [];
      for (const m of MILESTONES) {
        for (const reward of m.rewards) {
          if (reward.type !== 'badge') continue;
          out.push({
            id: reward.id,
            milestoneId: m.id,
            title: m.title,
            metric: m.metric,
            threshold: m.threshold,
            how: m.how || '',
            earned: store.earnedBadgeIds.includes(reward.id) || claimed.has(m.id),
            quiet: !!m.quiet,
          });
        }
      }
      return out;
    },

    /** Every sticker the roadmap can pay, with whether this reader has it. */
    stickers() {
      const out = [];
      for (const m of MILESTONES) {
        for (const reward of m.rewards) {
          if (reward.type !== 'sticker') continue;
          out.push({
            id: reward.id,
            milestoneId: m.id,
            title: m.title,
            metric: m.metric,
            threshold: m.threshold,
            how: m.how || '',
            earned: store.earnedStickerIds.includes(reward.id),
          });
        }
      }
      return out;
    },

    /** The family you are furthest into, which is what the name slot shows. */
    topBadge() {
      let best = null;
      for (const [slug, xp] of Object.entries(store.affinity)) {
        let tier = 0;
        for (let i = 0; i < TIER_XP.length; i++) if (xp >= TIER_XP[i]) tier = i + 1;
        if (!tier) continue;
        if (!best || xp > best.xp) best = { slug, tier, xp };
      }
      return best;
    },

    /** Which greeting gates the library has opened. */
    greetingGates() {
      const gates = new Set();
      for (const [slug, xp] of Object.entries(store.affinity)) {
        if (xp > 0 && GREETING_GATE[slug]) gates.add(GREETING_GATE[slug]);
      }
      return gates;
    },

    equipBadge(id) {
      if (id !== null && !store.earnedBadgeIds.includes(id)) return false;
      save({ equippedBadgeId: id });
      emit('yomu:progress', { reason: 'equip', state: get() });
      return true;
    },

    /**
     * Take a badge chosen on another of the reader's devices, earned or not.
     *
     * Sync's seam, and only sync's. The read lists that earned the badge over
     * there are on their way here too, so the check equipBadge makes would
     * only make the two devices disagree for the length of a sync cycle --
     * which is the exact window in which the reader looks at both. Nothing
     * is added to earnedBadgeIds: the store still says what *this* device has
     * seen, and the shelf shows an adopted badge as equipped, not as earned.
     */
    adoptBadge(id) {
      const next = typeof id === 'string' && id ? id : null;
      if (store.equippedBadgeId === next) return false;
      save({ equippedBadgeId: next });
      emit('yomu:progress', { reason: 'adopt', state: get() });
      return true;
    },

    /** Source health, which nothing else derives. Called by the source code. */
    noteRescue() {
      save({ sourceRescues: store.sourceRescues + 1 });
      pulse('rescue');
    },

    refresh: (reason) => pulse(reason || 'manual'),

    /* Test and debug seam. The pet is gated behind 50 chapters, which makes
       every downstream surface unreachable on a fresh profile; this is how
       you get to look at them. Not reachable from the UI. */
    __set(patch) { save(patch); pulse('debug'); },
    __reset() { store = { ...EMPTY }; writeJSON(KEY, store); pulse('reset'); },
  };

  if (typeof window !== 'undefined') window.YomuProgress = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { familiesForTags, stageOf, MILESTONES, STAGES, TIER_XP, BROAD, FAMILY_RULES };
  }

  /* --- boot -------------------------------------------------------------- *
   *
   * Three triggers, and no MutationObserver. The other injected files watch
   * the DOM because they are putting something into it; this one only reads
   * localStorage, and a scan per mutation on a reader that re-renders per
   * page turn would be the very cost it exists to remove.
   */

  if (typeof document !== 'undefined') {
    let lastPath = location.pathname;
    const onRoute = () => {
      if (location.pathname === lastPath) return;
      const wasReader = lastPath.startsWith('/read/');
      lastPath = location.pathname;
      pulse(wasReader ? 'reader-exit' : 'route');
    };

    for (const type of ['popstate', 'hashchange']) addEventListener(type, onRoute);

    /* pushState is how the app navigates, and it fires nothing. Wrapping it
       is the only way to see a route change from outside React. */
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        setTimeout(onRoute, 0);
        return result;
      };
    }

    addEventListener('visibilitychange', () => {
      if (!document.hidden) pulse('visible');
    });

    if (document.readyState === 'loading') {
      addEventListener('DOMContentLoaded', () => pulse('boot'));
    } else pulse('boot');
  }
})();
