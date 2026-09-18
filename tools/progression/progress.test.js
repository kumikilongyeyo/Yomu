/**
 * The progression engine, exercised without a browser.
 *
 * yomu-progress.js is a browser IIFE, so the test builds the globals it
 * expects -- a localStorage, a window, an event target -- and loads the real
 * file rather than a copy of its logic. A test against a reimplementation
 * would pass while the shipped file was broken.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../../dist-app/yomu-progress.js', import.meta.url), 'utf8');
const { MILESTONES } = await import('../../dist-app/yomu-progress.js');
const RESUME = 'yomu.v1.resume.local-account.';

/**
 * A localStorage good enough for the three things the engine does to it.
 *
 * It has to be a Proxy, not an object with methods. `Object.keys(localStorage)`
 * enumerates the stored keys in a browser, because Storage is an exotic object
 * whose named properties are its entries -- and that idiom is how both this
 * engine and you.html walk the read lists. A plain object would answer with
 * its own method names instead, so every counting test would fail against
 * code that is correct in the browser.
 */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  const methods = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => [...map.keys()][i],
  };
  return new Proxy(methods, {
    get: (target, prop) => {
      if (prop in target) return target[prop];
      if (prop === 'length') return map.size;
      if (typeof prop === 'string' && map.has(prop)) return map.get(prop);
      return undefined;
    },
    has: (target, prop) => prop in target || map.has(prop),
    ownKeys: () => [...map.keys()],
    getOwnPropertyDescriptor: (target, prop) =>
      map.has(prop)
        ? { value: map.get(prop), enumerable: true, configurable: true, writable: true }
        : undefined,
  });
}

/**
 * Boot the engine over a given localStorage and collect what it emits.
 * `fetch` is stubbed to fail, so affinity stays empty unless a test says
 * otherwise -- no test should depend on the network.
 */
function boot({ storage = fakeStorage(), path = '/', search = '', fetchImpl, clock } = {}) {
  const events = [];
  const listeners = new Map();
  const context = {
    localStorage: storage,
    console,
    setTimeout,
    fetch: fetchImpl || (() => Promise.reject(new Error('offline'))),
    URLSearchParams,
    location: { pathname: path, search },
    history: { pushState() {}, replaceState() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent(event) {
      events.push(event);
      for (const fn of listeners.get(event.type) || []) fn(event);
      return true;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
  };
  /* A settable clock, for the streak: the engine stamps days with `new
     Date()` and diffs them with Date.parse, so both are served by a Date
     whose no-argument form and now() read `clock.now`. */
  if (clock) {
    context.Date = class FakeDate extends Date {
      constructor(...args) { super(...(args.length ? args : [clock.now])); }
      static now() { return clock.now; }
    };
  }
  context.window = context;
  /* No `document` key at all: the engine's boot block is guarded on it, so
     leaving it undefined is how a test gets the API without the listeners. */
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { api: context.window.YomuProgress, events, storage };
}

/** A storage holding `n` finished chapters spread over `series` titles. */
function withChapters(n, series = 'ext-a:solo-leveling') {
  const list = Array.from({ length: n }, (_, i) => 'ch-' + (i + 1));
  return fakeStorage({ [RESUME + series + '.read']: JSON.stringify(list) });
}

const rewards = (events) => events.filter((e) => e.type === 'yomu:reward');
/** Arrays cross a vm realm boundary, where deepStrictEqual compares prototypes. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const ids = (events) => rewards(events).map((e) => e.detail.milestoneId);

/* --- counting ----------------------------------------------------------- */

test('counts chapters off the app read lists', async () => {
  const { api } = boot({ storage: withChapters(12) });
  await api.refresh();
  assert.equal(api.get().chaptersRead, 12);
});

test('counts across several series', async () => {
  const storage = withChapters(4, 'ext-a:one');
  storage.setItem(RESUME + 'ext-b:two.read', JSON.stringify(['a', 'b', 'c']));
  const { api } = boot({ storage });
  await api.refresh();
  assert.equal(api.get().chaptersRead, 7);
});

test('a shrinking read list lowers the count but pays nothing', async () => {
  const storage = withChapters(12);
  const { api } = boot({ storage });
  await api.refresh();

  storage.setItem(RESUME + 'ext-a:solo-leveling.read', JSON.stringify(['ch-1']));
  const before = api.get().petXp;
  await api.refresh();

  assert.equal(api.get().chaptersRead, 1);
  assert.equal(api.get().petXp, before, 'XP is not clawed back');
});

/* --- milestones --------------------------------------------------------- */

test('9 -> 10 chapters unlocks Page Turner exactly once', async () => {
  const storage = withChapters(9);
  const { api, events } = boot({ storage });
  await api.refresh();
  assert.ok(!ids(events).includes('page-turner'), 'not paid at 9');

  storage.setItem(RESUME + 'ext-a:solo-leveling.read',
    JSON.stringify(Array.from({ length: 10 }, (_, i) => 'ch-' + i)));
  await api.refresh();
  assert.equal(ids(events).filter((id) => id === 'page-turner').length, 1);

  await api.refresh();
  await api.refresh();
  assert.equal(ids(events).filter((id) => id === 'page-turner').length, 1, 'still once');
  assert.ok(api.get().earnedBadgeIds.includes('page-turner'));
});

test('19 -> 20 pays 40 XP once', async () => {
  const storage = withChapters(19);
  const { api, events } = boot({ storage });
  await api.refresh();
  const before = api.get().petXp;

  storage.setItem(RESUME + 'ext-a:solo-leveling.read',
    JSON.stringify(Array.from({ length: 20 }, (_, i) => 'ch-' + i)));
  await api.refresh();

  // One chapter read is +1, and the milestone adds 40 on top of it.
  assert.equal(api.get().petXp, before + 1 + 40);
  assert.equal(ids(events).filter((id) => id === 'little-bookworm').length, 1);

  await api.refresh();
  assert.equal(api.get().petXp, before + 41, 'not paid twice');
});

test('49 -> 50 unlocks the pet once', async () => {
  const storage = withChapters(49);
  const { api, events } = boot({ storage });
  await api.refresh();
  assert.equal(api.get().petUnlocked, false);

  storage.setItem(RESUME + 'ext-a:solo-leveling.read',
    JSON.stringify(Array.from({ length: 50 }, (_, i) => 'ch-' + i)));
  await api.refresh();

  assert.equal(api.get().petUnlocked, true);
  assert.equal(ids(events).filter((id) => id === 'book-goblin').length, 1);
});

test('a jump past several stops pays each of them once', async () => {
  const { api, events } = boot({ storage: withChapters(60) });
  await api.refresh();
  const paid = ids(events);
  for (const id of ['first-steps', 'page-turner', 'little-bookworm', 'book-goblin']) {
    assert.equal(paid.filter((x) => x === id).length, 1, id + ' paid once');
  }
});

test('rewards survive a reload', async () => {
  const storage = withChapters(50);
  const first = boot({ storage });
  await first.api.refresh();
  assert.ok(first.api.get().petUnlocked);

  // Same storage, brand new engine: the claim list is what carries over.
  const second = boot({ storage });
  await second.api.refresh();
  assert.equal(second.api.get().petUnlocked, true);
  assert.equal(rewards(second.events).length, 0, 'nothing re-paid on reload');
});

/* --- events ------------------------------------------------------------- */

test('a finished chapter emits exactly one chapter-complete', async () => {
  const storage = withChapters(3);
  const { api, events } = boot({ storage });
  await api.refresh();
  const before = events.filter((e) => e.type === 'yomu:chapter-complete').length;

  storage.setItem(RESUME + 'ext-a:solo-leveling.read', JSON.stringify(['a', 'b', 'c', 'd']));
  await api.refresh();

  const after = events.filter((e) => e.type === 'yomu:chapter-complete');
  assert.equal(after.length, before + 1);
  assert.equal(after[after.length - 1].detail.count, 1);
});

test('no chapter event when nothing changed', async () => {
  const { api, events } = boot({ storage: withChapters(5) });
  await api.refresh();
  const before = events.filter((e) => e.type === 'yomu:chapter-complete').length;
  await api.refresh();
  assert.equal(events.filter((e) => e.type === 'yomu:chapter-complete').length, before);
});

/* --- stages ------------------------------------------------------------- */

test('stage progress is measured across the stage, not from zero', async () => {
  const { api } = boot();
  api.__set({ petXp: 130 });
  const stage = api.stageOf();
  // 130 sits between Fledgling (60) and Companion (200): 70 of a 140 span.
  assert.equal(stage.level, 2);
  assert.equal(Math.round(stage.progress), 50);
  assert.equal(stage.remaining, 70);
});

test('the last stage is complete rather than infinite', async () => {
  const { api } = boot();
  api.__set({ petXp: 99999 });
  const stage = api.stageOf();
  assert.equal(stage.level, 5);
  assert.equal(stage.progress, 100);
  assert.equal(stage.remaining, 0);
});

test('stage progress clamps at both ends', async () => {
  const { api } = boot();
  api.__set({ petXp: -50 });
  assert.ok(api.stageOf().progress >= 0);
});

/* --- affinity ----------------------------------------------------------- */

/* The tag matcher is pure, so it is imported directly rather than driven
   through a booted engine. Node's interop picks up the module.exports the
   IIFE writes; an import that stops working must fail the test, not skip it. */
const { familiesForTags } = await import('../../dist-app/yomu-progress.js');

test('broad genres earn nothing', () => {
  assert.deepEqual(plain(familiesForTags(['Action', 'Drama', 'Comedy'])), []);
});

test('specific tags map to their family, specific before general', () => {
  assert.deepEqual(plain(familiesForTags(['Tower'])), ['tower-climber']);
  assert.deepEqual(plain(familiesForTags(['Reincarnation'])), ['second-lifer']);
  // Xianxia must not be swallowed by the cultivation rule below it.
  assert.deepEqual(plain(familiesForTags(['Xianxia'])), ['immortal-aspirant']);
  assert.deepEqual(plain(familiesForTags(['Cultivation'])), ['dao-seeker']);
  // An unknown tag is not forced into the nearest family.
  assert.deepEqual(plain(familiesForTags(['Gourmet Wrestling'])), []);
});

test('affinity splits across the families a series matches', async () => {
  const storage = withChapters(0);
  const fetchImpl = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ similarBecause: ['Tower', 'System'] }),
  });
  const { api } = boot({
    storage,
    path: '/read/ext-a:solo-leveling:ch-1',
    search: '?source=ext-a',
    fetchImpl,
  });
  await api.refresh();

  storage.setItem(RESUME + 'ext-a:solo-leveling.read', JSON.stringify(['a', 'b']));
  await api.refresh();

  const affinity = api.get().affinity;
  assert.equal(affinity['tower-climber'], 1);
  assert.equal(affinity['system-breaker'], 1);
});

test('an affinity tier is earned once and opens its greeting gate', async () => {
  const { api, events } = boot();
  api.__set({ affinity: { 'tower-climber': 45 } });
  await api.refresh();

  const earned = api.get().earnedBadgeIds;
  assert.ok(earned.includes('tower-climber:2'), 'tier II at 40 XP');
  assert.ok(!earned.includes('tower-climber:3'), 'not tier III yet');
  assert.ok(api.greetingGates().has('t'));

  const before = rewards(events).length;
  await api.refresh();
  assert.equal(rewards(events).length, before, 'tier not re-paid');
});

test('topBadge is the family with the most affinity', async () => {
  const { api } = boot();
  api.__set({ affinity: { 'tower-climber': 45, 'dao-seeker': 320 } });
  await api.refresh();
  const top = api.topBadge();
  assert.equal(top.slug, 'dao-seeker');
  assert.equal(top.tier, 4);
});

/* --- equipping ---------------------------------------------------------- */

test('only an earned badge can be equipped', async () => {
  const { api } = boot();
  api.__set({ earnedBadgeIds: ['tower-climber:2'] });
  assert.equal(api.equipBadge('dao-seeker:5'), false);
  assert.equal(api.get().equippedBadgeId, null);
  assert.equal(api.equipBadge('tower-climber:2'), true);
  assert.equal(api.get().equippedBadgeId, 'tower-climber:2');
});

test('no badge is a first-class choice', async () => {
  const { api } = boot();
  api.__set({ earnedBadgeIds: ['tower-climber:2'] });
  api.equipBadge('tower-climber:2');
  assert.equal(api.equipBadge(null), true);
  assert.equal(api.get().equippedBadgeId, null);
});

/* --- the roadmap -------------------------------------------------------- */

test('the roadmap draws the chapter stops from ten to a thousand, and nothing else', async () => {
  const { api } = boot({ storage: withChapters(38) });
  await api.refresh();
  const road = api.roadmap();
  assert.deepEqual(plain(road.map((r) => r.threshold)), [10, 20, 50, 100, 250, 500, 1000]);
  assert.ok(road.every((r) => r.metric === 'chaptersRead'), 'trails are not on the road');
  assert.equal(road[0].collected, true);
  assert.equal(road[2].collected, false);
  assert.equal(road[2].remaining, 12);
  assert.equal(Math.round(road[2].progress), 76);
});

/* --- streak ------------------------------------------------------------- */

test('the streak starts at one on the first chapter and holds that day', async () => {
  const storage = withChapters(0);
  const { api } = boot({ storage });
  await api.refresh();
  assert.equal(api.get().currentStreak, 0, 'no chapters, no streak');

  storage.setItem(RESUME + 'ext-a:solo-leveling.read', JSON.stringify(['a']));
  await api.refresh();
  assert.equal(api.get().currentStreak, 1);

  storage.setItem(RESUME + 'ext-a:solo-leveling.read', JSON.stringify(['a', 'b']));
  await api.refresh();
  assert.equal(api.get().currentStreak, 1, 'same day does not advance it');
  assert.equal(api.get().longestStreak, 1);
});

/* --- persistence -------------------------------------------------------- */

test('state survives serialization', async () => {
  const storage = withChapters(22);
  const first = boot({ storage });
  await first.api.refresh();
  first.api.equipBadge('page-turner');

  const raw = storage.getItem('yomu.v1.progress');
  assert.ok(raw, 'written under the versioned key');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.v, 1);

  const second = boot({ storage });
  await second.api.refresh();
  assert.deepEqual(plain(second.api.get().claimed).sort(), plain(first.api.get().claimed).sort());
  assert.equal(second.api.get().equippedBadgeId, 'page-turner');
});

test('a corrupt store falls back to empty rather than throwing', async () => {
  const storage = withChapters(3);
  storage.setItem('yomu.v1.progress', '{not json');
  const { api } = boot({ storage });
  await api.refresh();
  assert.equal(api.get().chaptersRead, 3);
});

/* --- past fifty ---------------------------------------------------------- */

test('99 -> 100 pays Century once, a badge and a sticker', async () => {
  const storage = withChapters(99);
  const { api, events } = boot({ storage });
  await api.refresh();
  assert.ok(!ids(events).includes('century'), 'not paid at 99');

  storage.setItem(RESUME + 'ext-a:solo-leveling.read',
    JSON.stringify(Array.from({ length: 100 }, (_, i) => 'ch-' + i)));
  await api.refresh();
  await api.refresh();
  assert.equal(ids(events).filter((id) => id === 'century').length, 1);
  assert.ok(api.get().earnedBadgeIds.includes('century'));
  assert.ok(api.get().earnedStickerIds.includes('century-sticker'));
});

test('the chapter ladder pays every stop on the way to a thousand, each once', async () => {
  const { api, events } = boot({ storage: withChapters(1000) });
  await api.refresh();
  const paid = ids(events);
  for (const id of ['century', 'shelf-bender', 'tome-eater', 'living-library']) {
    assert.equal(paid.filter((x) => x === id).length, 1, id + ' paid once');
  }
  assert.ok(api.get().earnedStickerIds.includes('living-library-sticker'));
});

test('stage badges arrive quietly, alongside the stage they mark', async () => {
  const { api, events } = boot({ storage: withChapters(60) });
  await api.refresh();
  assert.equal(api.stageOf().level, 2, 'sixty XP is the Fledgling stage');
  const stage = rewards(events).find((e) => e.detail.milestoneId === 'stage-fledgling');
  assert.ok(stage, 'the Fledgling badge is paid');
  assert.equal(stage.detail.quiet, true, 'and marked quiet for the toast');
  const loud = rewards(events).find((e) => e.detail.milestoneId === 'book-goblin');
  assert.equal(loud.detail.quiet, false, 'ordinary milestones are not');
});

/* --- the trails ---------------------------------------------------------- */

test('five enabled sources pays Well Sourced', async () => {
  const storage = withChapters(1);
  const sources = Array.from({ length: 5 }, (_, i) => ({ id: 's' + i, enabled: true }));
  storage.setItem('yomu.v1.collection', JSON.stringify({ sources: [...sources, { id: 'off', enabled: false }], library: [] }));
  const { api, events } = boot({ storage });
  await api.refresh();
  assert.equal(api.get().sourcesUsed, 5);
  assert.equal(ids(events).filter((id) => id === 'well-sourced').length, 1);
  const trail = api.trails().find((t) => t.id === 'well-sourced');
  assert.equal(trail.collected, true);
});

test('a saved title read to its total is finished; one with no total never is', async () => {
  const storage = fakeStorage({
    [RESUME + 'ext-a:short.read']: JSON.stringify(['1', '2', '3']),
    [RESUME + 'ext-a:endless.read']: JSON.stringify(Array.from({ length: 40 }, (_, i) => String(i))),
    'yomu.v1.collection': JSON.stringify({
      sources: [],
      library: [
        { id: 'ext-a:short', sourceId: 'ext-a', title: 'Short', total: 3 },
        { id: 'ext-a:endless', sourceId: 'ext-a', title: 'Endless' },
        { id: 'ext-a:hidden', sourceId: 'ext-a', title: 'Hidden', total: 1, hidden: true },
      ],
    }),
  });
  const { api, events } = boot({ storage });
  await api.refresh();
  assert.equal(api.get().titlesCompleted, 1);
  assert.equal(ids(events).filter((id) => id === 'finisher').length, 1);
  assert.ok(api.get().earnedStickerIds.includes('finisher-sticker'));
  assert.ok(!ids(events).includes('closer'));
});

test('origins are read off the AniList cache, unioned, and never shrink', async () => {
  const cache = {
    'solo leveling': { at: Date.now(), answer: { country: 'KR' } },
    'berserk': { at: Date.now(), answer: { country: 'JP' } },
    'unread manhua': { at: Date.now(), answer: { country: 'CN' } },
  };
  const storage = fakeStorage({
    [RESUME + 'ext-a:sl.read']: JSON.stringify(['1']),
    [RESUME + 'ext-a:bk.read']: JSON.stringify(['1']),
    'yomu.v1.anilist': JSON.stringify(cache),
    'yomu.v1.collection': JSON.stringify({
      sources: [],
      library: [
        { id: 'ext-a:sl', sourceId: 'ext-a', title: 'Solo Leveling' },
        { id: 'ext-a:bk', sourceId: 'ext-a', title: 'Berserk' },
        // Saved, cached, and never opened: not a shore reached.
        { id: 'ext-a:um', sourceId: 'ext-a', title: 'Unread Manhua' },
      ],
    }),
  });
  const { api, events } = boot({ storage });
  await api.refresh();
  assert.deepEqual(plain(api.get().origins), ['JP', 'KR']);
  assert.ok(!ids(events).includes('three-shores'));

  // The cache evicts; the shores stay reached.
  storage.setItem('yomu.v1.anilist', JSON.stringify({}));
  await api.refresh();
  assert.deepEqual(plain(api.get().origins), ['JP', 'KR']);

  // The third shore.
  storage.setItem(RESUME + 'ext-a:um.read', JSON.stringify(['1']));
  storage.setItem('yomu.v1.anilist', JSON.stringify({ 'unread manhua': cache['unread manhua'] }));
  await api.refresh();
  assert.deepEqual(plain(api.get().origins), ['CN', 'JP', 'KR']);
  assert.equal(ids(events).filter((id) => id === 'three-shores').length, 1);
});

/* --- the shelf's seams ---------------------------------------------------- */

test('adoptBadge equips a badge this device has not earned, without claiming it has', async () => {
  const { api, events } = boot({ storage: withChapters(1) });
  await api.refresh();
  assert.equal(api.equipBadge('tower-climber:3'), false, 'equip still refuses');
  assert.equal(api.adoptBadge('tower-climber:3'), true);
  assert.equal(api.get().equippedBadgeId, 'tower-climber:3');
  assert.ok(!api.get().earnedBadgeIds.includes('tower-climber:3'), 'not marked earned');
  assert.equal(api.adoptBadge('tower-climber:3'), false, 'same again is a no-op');
  assert.equal(api.adoptBadge(''), true, 'empty clears');
  assert.equal(api.get().equippedBadgeId, null);
  assert.ok(events.some((e) => e.type === 'yomu:progress' && e.detail.reason === 'adopt'));
});

test('every badge and sticker the roadmap pays has a listed id, and every trail says how', () => {
  for (const m of MILESTONES) {
    for (const r of m.rewards) {
      if (r.type === 'badge' || r.type === 'sticker') assert.match(r.id, /^[a-z0-9][a-z0-9:_-]*$/, m.id);
    }
    if (m.metric !== 'chaptersRead' && m.metric !== 'petXp') assert.ok(m.how, m.id + ' has a how');
  }
});

/* --- streaks, live ------------------------------------------------------- */

const DAY = 86400000;

/** Read one more chapter, with the clock at `now`. */
async function readOn(api, storage, now, clock, series = 'ext-a:solo-leveling') {
  clock.now = now;
  const list = JSON.parse(storage.getItem(RESUME + series + '.read') || '[]');
  list.push('ch-' + list.length);
  storage.setItem(RESUME + series + '.read', JSON.stringify(list));
  await api.refresh();
}

test('a streak is live: yesterday holds it, two days away shows zero and keeps the best', async () => {
  const clock = { now: Date.UTC(2026, 8, 10, 12) };
  const storage = fakeStorage();
  const { api } = boot({ storage, clock });
  for (let day = 0; day < 3; day++) await readOn(api, storage, clock.now + (day ? DAY : 0), clock);
  assert.equal(api.streak().current, 3);
  assert.equal(api.streak().today, true);
  assert.deepEqual(plain(api.streak().readDays), ['2026-09-10', '2026-09-11', '2026-09-12']);

  clock.now += DAY;                         // the next day, nothing read yet
  assert.equal(api.streak().current, 3, 'yesterday still counts');
  assert.equal(api.streak().daysSince, 1);

  clock.now += DAY;                         // a whole day missed
  assert.equal(api.streak().current, 0, 'two days away is no streak');
  assert.equal(api.streak().longest, 3, 'the best is kept');
  assert.equal(api.get().currentStreak, 3, 'the store is untouched until the next read');

  await readOn(api, storage, clock.now, clock);
  assert.equal(api.streak().current, 1, 'starts again, not from three');
  assert.equal(api.streak().longest, 3);
});

test('seven days running pays Week of Pages once, and a stale seven does not', async () => {
  const clock = { now: Date.UTC(2026, 8, 1, 9) };
  const storage = fakeStorage();
  const { api, events } = boot({ storage, clock });
  for (let day = 0; day < 6; day++) await readOn(api, storage, clock.now + (day ? DAY : 0), clock);
  assert.ok(!ids(events).includes('streak-week'), 'not at six');
  await readOn(api, storage, clock.now + DAY, clock);
  assert.equal(ids(events).filter((id) => id === 'streak-week').length, 1);
  assert.ok(api.get().earnedBadgeIds.includes('streak-week'));
  const trail = api.trails().find((t) => t.id === 'streak-week');
  assert.equal(trail.collected, true);

  // A fortnight later, with a stale 7 in the store, the month badge must not
  // be reachable by a single read.
  clock.now += 14 * DAY;
  assert.equal(api.trails().find((t) => t.id === 'streak-month').value, 0);
});

/* --- months, for the wrap ------------------------------------------------- */

test('chapters are attributed to the month they turned up in, per series', async () => {
  const clock = { now: Date.UTC(2026, 8, 20, 12) };
  const storage = fakeStorage();
  const { api } = boot({ storage, clock });
  for (let i = 0; i < 5; i++) await readOn(api, storage, clock.now + i * 3600000, clock, 'ext-a:one');
  await readOn(api, storage, clock.now, clock, 'ext-a:two');
  let sept = api.monthly('2026-09');
  assert.equal(sept.chapters, 6);
  assert.deepEqual(plain(sept.series), [{ seriesId: 'ext-a:one', chapters: 5 }, { seriesId: 'ext-a:two', chapters: 1 }]);
  assert.equal(sept.days, 1);

  // October: three more of `two`. September stays as it was.
  clock.now = Date.UTC(2026, 9, 3, 12);
  for (let i = 0; i < 3; i++) await readOn(api, storage, clock.now + i * 3600000, clock, 'ext-a:two');
  const oct = api.monthly('2026-10');
  assert.equal(oct.chapters, 3);
  assert.deepEqual(plain(oct.series), [{ seriesId: 'ext-a:two', chapters: 3 }]);
  sept = api.monthly('2026-09');
  assert.equal(sept.chapters, 6, 'closed month is frozen');
  assert.deepEqual(plain(sept.series), [{ seriesId: 'ext-a:one', chapters: 5 }, { seriesId: 'ext-a:two', chapters: 1 }]);

  const year = api.year('2026');
  assert.equal(year.chapters, 9);
  assert.equal(year.months.length, 12);
  assert.equal(year.months[8].chapters, 6);
  assert.equal(year.months[9].chapters, 3);
  assert.deepEqual(plain(year.series[0]), { seriesId: 'ext-a:one', chapters: 5 });
  assert.equal(api.monthly('2025-01').chapters, 0, 'an unknown month is empty, not an error');
});

test('a badge paid in a month belongs to that month\'s wrap', async () => {
  const clock = { now: Date.UTC(2026, 8, 2, 12) };
  const storage = withChapters(9);
  const { api } = boot({ storage, clock });
  await api.refresh();
  clock.now = Date.UTC(2026, 9, 2, 12);
  await readOn(api, storage, clock.now, clock);          // 10th chapter: Page Turner
  assert.ok(api.get().claimedAt['page-turner'] >= clock.now);
  const oct = api.monthly('2026-10');
  assert.deepEqual(plain(oct.badges.map((b) => b.id)), ['page-turner']);
  assert.equal(api.monthly('2026-09').badges.length, 0);
});
