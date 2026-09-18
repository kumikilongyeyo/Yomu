/**
 * The streak engine's rules, against the shipped file with a fake clock and
 * storage. These are the acceptance lines from the handoff, one per test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const SOURCE = fs.readFileSync(new URL('../../dist-app/yomu-streak.js', import.meta.url), 'utf8');
const pure = await import('../../dist-app/yomu-streak.js');

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  const methods = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return new Proxy(methods, {
    get: (t, p) => (p in t ? t[p] : p === 'length' ? map.size : map.get(p)),
    ownKeys: () => [...map.keys()],
    getOwnPropertyDescriptor: (t, p) => (map.has(p) ? { value: map.get(p), enumerable: true, configurable: true, writable: true } : undefined),
  });
}

/** Boot the engine with a clock. Local time == UTC in the fake Date. */
function boot(clock, storage = fakeStorage()) {
  const events = [];
  const context = {
    localStorage: storage, console, setTimeout, clearTimeout, setInterval: () => 0,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent(e) { events.push(e); return true; },
    addEventListener() {},
    Date: class FakeDate extends Date {
      constructor(...a) { super(...(a.length ? a : [clock.now])); }
      static now() { return clock.now; }
      getHours() { return this.getUTCHours(); }
      setHours(h) { return this.setUTCHours(h); }
      getFullYear() { return this.getUTCFullYear(); }
      getMonth() { return this.getUTCMonth(); }
      getDate() { return this.getUTCDate(); }
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { S: context.window.YomuStreak, M: context.window.YomuMileage, events, storage };
}

const at = (y, m, d, h = 20) => Date.UTC(y, m - 1, d, h);
/** Arrays and objects cross a vm realm boundary, where deepEqual compares prototypes. */
const plain = (v) => JSON.parse(JSON.stringify(v));
const DAY = 86400000;

/* --- day boundary ----------------------------------------------------------- */

test('a day ends at 04:00: 01:30 belongs to the evening before', () => {
  const { S } = boot({ now: at(2026, 9, 10, 20) });
  assert.equal(S.dayKey(at(2026, 9, 10, 20)), '2026-09-10');
  assert.equal(S.dayKey(at(2026, 9, 11, 1, 30)), '2026-09-10');
  assert.equal(S.dayKey(at(2026, 9, 11, 4, 0)), '2026-09-11');
});

/* --- record ------------------------------------------------------------------- */

test('one chapter on a fresh install: 1, Ember, six days to Kindling; a second the same day changes nothing', () => {
  const clock = { now: at(2026, 9, 10) };
  const { S, events } = boot(clock);
  const first = S.record();
  assert.deepEqual([first.changed, first.current], [true, 1]);
  const snap = S.get();
  assert.equal(snap.stage, 0);
  assert.equal(snap.stageName, 'Ember');
  assert.equal(snap.nextLabel, 'Kindling at 3 days · 2 more days');
  assert.equal(snap.todayDone, true);
  assert.ok(events.some((e) => e.type === 'yomu:streak-stage' && e.detail.to === 0), 'lighting it is a stage');
  const again = S.record(clock.now + 3600000);
  assert.equal(again.changed, false);
  assert.equal(S.get().current, 1);
});

test('consecutive days climb; a missed day with no token breaks to zero and keeps best and days', () => {
  const clock = { now: at(2026, 9, 1) };
  const { S } = boot(clock);
  for (let i = 0; i < 5; i++) { clock.now = at(2026, 9, 1 + i); S.record(); }
  assert.equal(S.get().current, 5);
  assert.equal(S.get().stageName, 'Kindling');
  clock.now = at(2026, 9, 7);          // the 6th was missed
  S.rollover();
  const snap = S.get();
  assert.equal(snap.current, 0);
  assert.equal(snap.best, 5);
  assert.equal(snap.days.length, 5, 'history stays true');
  assert.equal(snap.stageName, 'Not lit');
  S.record();
  assert.equal(S.get().current, 1, 'starts again from one');
});

test('a rest night is earned every seven days, held to three, and covers one missed day', () => {
  const clock = { now: at(2026, 9, 1) };
  const { S } = boot(clock);
  for (let i = 0; i < 7; i++) { clock.now = at(2026, 9, 1 + i); S.record(); }
  assert.equal(S.get().restNights, 1, 'one token at seven');
  clock.now = at(2026, 9, 9);          // the 8th missed
  S.rollover();
  let snap = S.get();
  assert.equal(snap.current, 7, 'the token held it');
  assert.equal(snap.restNights, 0);
  assert.deepEqual(plain(snap.restUsed), ['2026-09-08']);
  assert.equal(snap.week.find((d) => d.date === '2026-09-08').state, 'rest', 'shown as a gap, not a read day');
  S.record();
  assert.equal(S.get().current, 8, 'a rest day adds nothing; the chain continues');

  for (let i = 10; i <= 30; i++) { clock.now = at(2026, 9, i); S.record(); }
  assert.equal(S.get().restNights, 3, 'capped at three');
});

test('two rest nights never cover consecutive days', () => {
  const clock = { now: at(2026, 9, 1) };
  const { S } = boot(clock);
  for (let i = 0; i < 14; i++) { clock.now = at(2026, 9, 1 + i); S.record(); }
  assert.equal(S.get().restNights, 2);
  clock.now = at(2026, 9, 17);         // 15th and 16th both missed
  S.rollover();
  const snap = S.get();
  assert.deepEqual(plain(snap.restUsed), ['2026-09-15'], 'the second day is not covered');
  assert.equal(snap.restNights, 1, 'one token spent, one kept');
  assert.equal(snap.current, 0, 'the streak broke on the second day');
});

test('a clock that moved backwards writes nothing', () => {
  const clock = { now: at(2026, 9, 10) };
  const { S } = boot(clock);
  S.record();
  const before = S.get().days.slice();
  clock.now = at(2026, 9, 8);
  assert.equal(S.record().changed, false);
  assert.deepEqual(S.get().days, before);
});

/* --- stages ---------------------------------------------------------------------- */

test('six equal stages: the bar position is a sixth per stage, linear within', () => {
  assert.equal(pure.stageOf(0), 0);
  assert.equal(pure.stageOf(2), 0);
  assert.equal(pure.stageOf(3), 1);
  assert.equal(pure.stageOf(7), 2);
  assert.equal(pure.stageOf(14), 3);
  assert.equal(pure.stageOf(30), 4);
  assert.equal(pure.stageOf(60), 5);
  assert.equal(pure.stageOf(400), 5);
  assert.equal(pure.pctOf(0), 0);
  assert.ok(Math.abs(pure.pctOf(2) - 100 / 6) < 0.01, 'end of Ember is one sixth');
  assert.ok(Math.abs(pure.pctOf(13) - 50) < 0.01, 'end of Steady burn is half');
  assert.ok(pure.pctOf(58) < pure.pctOf(59) && pure.pctOf(59) < pure.pctOf(60));
  assert.equal(pure.pctOf(1000), 100);
  assert.equal(pure.nextLabel(14), 'White hot at 30 days · 16 more days');
});

/* --- merge ------------------------------------------------------------------------ */

test('a merge unions days, keeps the record, takes the fewer tokens, and recomputes current', () => {
  const a = { days: ['2026-09-01', '2026-09-02'], restUsed: [], best: 2, restNights: 3, updatedAt: 5 };
  const b = { days: ['2026-09-03', '2026-09-04'], restUsed: [], best: 9, restNights: 1, updatedAt: 7 };
  const ab = pure.merge(a, b, '2026-09-05');
  const ba = pure.merge(b, a, '2026-09-05');
  assert.deepEqual(ab, ba, 'order-independent');
  assert.deepEqual(ab.days, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
  assert.equal(ab.current, 4, 'two evenings on two devices make one streak');
  assert.equal(ab.best, 9);
  assert.equal(ab.restNights, 1);
  // A device offline for a week cannot hand back a streak.
  const stale = { days: ['2026-08-20', '2026-08-21', '2026-08-22'], restUsed: [], best: 3, restNights: 0, updatedAt: 1 };
  const merged = pure.merge(stale, a, '2026-09-10');
  assert.equal(merged.current, 0, 'nothing alive today');
  assert.equal(merged.best, 3);
});

test('the Worker merges the same way, and never stores current', () => {
  let js = stripTypeScriptTypes(fs.readFileSync(new URL('../../worker/sync.ts', import.meta.url), 'utf8'));
  js = js.replace(/^export (async function|function|const|let)/gm, '$1');
  js += '\nreturn { mergeStreak };';
  const { mergeStreak } = new Function(js)();
  const merged = mergeStreak(
    { days: ['2026-09-02', 'junk', '2026-09-01'], restUsed: [], best: 2, restNights: 3, updatedAt: 5 },
    { days: ['2026-09-03'], restUsed: ['2026-08-30'], best: 1, restNights: 1, updatedAt: 9 },
  );
  assert.deepEqual(merged, { days: ['2026-09-01', '2026-09-02', '2026-09-03'], restUsed: ['2026-08-30'], best: 2, restNights: 1, updatedAt: 9 });
  assert.equal('current' in merged, false);
  assert.equal(mergeStreak(undefined, { days: ['2026-09-03'], restUsed: [], best: 1, restNights: 2, updatedAt: 1 }).restNights, 2, 'nothing stored yet: the incoming count stands');
});

/* --- mileage ---------------------------------------------------------------------- */

test('tiers at 10, 40, 100, 250, 500 and the progress between them', () => {
  assert.equal(pure.tierOf(0), 0);
  assert.equal(pure.tierOf(10), 1);
  assert.equal(pure.tierOf(99), 2);
  assert.equal(pure.tierOf(500), 5);
  assert.deepEqual(pure.progressIn(70), { count: 70, tier: 2, nextAt: 100, remaining: 30, pct: 50 });
  assert.deepEqual(pure.progressIn(600), { count: 600, tier: 5, nextAt: null, remaining: 0, pct: 100 });
});

test('a recount counts the read arrays, skips when unchanged, and finds no family without metadata', () => {
  const storage = fakeStorage({
    'yomu.v1.resume.local-account.ext-a:one.read': JSON.stringify(['c1', 'c2', 'c2', 'c3']),
    'yomu.v1.resume.local-account.ext-a:two.read': JSON.stringify(['c1']),
  });
  const { M } = boot({ now: at(2026, 9, 10) }, storage);
  const first = M.recount();
  assert.equal(first.total, 4, 'duplicates are one chapter');
  assert.deepEqual(plain(first.byFamily), {}, 'no AniList metadata, no family');
  const again = M.recount();
  assert.equal(again, first, 'same signature, no work');
  storage.setItem('yomu.v1.resume.local-account.ext-a:two.read', JSON.stringify(['c1', 'c2']));
  assert.equal(M.recount().total, 5);
  assert.deepEqual(plain(M.closeToEarning(3)), []);
});

test('the week strip names read, rest, today, missed and future', () => {
  const days = { days: ['2026-09-14', '2026-09-15'], restUsed: ['2026-09-16'], dayStartHour: 4 };
  const w = pure.week(at(2026, 9, 17, 12), days);   // Thursday
  assert.deepEqual(w.map((d) => d.state), ['missed', 'read', 'read', 'rest', 'today', 'future', 'future']);
  assert.deepEqual(w.map((d) => d.letter), ['S', 'M', 'T', 'W', 'T', 'F', 'S']);
  assert.equal(pure.mood(3), 1);
});
