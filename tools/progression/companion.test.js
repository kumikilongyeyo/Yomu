/**
 * The companion update's decisions, without a browser: what the streak
 * strip draws, how sleepy Mori gets, where it walks, when a sitting ends,
 * and what a character card is allowed to say.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { week, mood } = await import('../../dist-app/yomu-streak.js');
const { chooseTarget } = await import('../../dist-app/yomu-roam.js');
const { tally, SITTING_MS } = await import('../../dist-app/yomu-binge.js');
const { trimDescription, roleLabel, shape } = await import('../../dist-app/yomu-cast.js');
const { POOLS } = await import('../../dist-app/yomu-greet.js');

/* --- streak ---------------------------------------------------------------- */

test('the week strip is seven days ending today, marked off the read list', () => {
  const days = week(['2026-09-12', '2026-09-14', '2026-01-01'], '2026-09-14');
  assert.equal(days.length, 7);
  assert.equal(days[0].iso, '2026-09-08');
  assert.equal(days[6].iso, '2026-09-14');
  assert.equal(days[6].today, true);
  assert.deepEqual(days.map((d) => d.read), [false, false, false, false, true, false, true]);
  assert.equal(days[6].letter, 'M', '14 September 2026 is a Monday');
});

test('Mori is awake for a day, dozes after two, is out cold after four', () => {
  assert.equal(mood(null), 0);
  assert.equal(mood(0), 0);
  assert.equal(mood(1), 0);
  assert.equal(mood(2), 1);
  assert.equal(mood(3), 1);
  assert.equal(mood(4), 2);
  assert.equal(mood(30), 2);
});

/* --- roaming --------------------------------------------------------------- */

const tile = (seriesId, fresh = false) => ({ seriesId, fresh, box: {}, title: seriesId });

test('a fresh saved title wins over everything, once', () => {
  const tiles = [tile('a'), tile('b', true), tile('c', true)];
  const saved = new Set(['b']);
  const target = chooseTarget(tiles, { seriesId: 'a' }, saved, new Set(), 0.1);
  assert.equal(target.kind, 'fresh');
  assert.equal(target.tile.seriesId, 'b', 'c is fresh but not saved');
  const again = chooseTarget(tiles, { seriesId: 'a' }, saved, new Set(['b']), 0.1);
  assert.equal(again.kind, 'nap', 'remarked on already; back to the nap');
});

test('otherwise it naps on the last-read cover more often than not, and sometimes goes home', () => {
  const tiles = [tile('a'), tile('b')];
  assert.equal(chooseTarget(tiles, { seriesId: 'b' }, new Set(), new Set(), 0.3).kind, 'nap');
  assert.equal(chooseTarget(tiles, { seriesId: 'b' }, new Set(), new Set(), 0.7).kind, 'wander');
  assert.equal(chooseTarget(tiles, { seriesId: 'b' }, new Set(), new Set(), 0.95).kind, 'home');
  assert.equal(chooseTarget(tiles, null, new Set(), new Set(), 0.3).kind, 'wander', 'nothing read: no nap');
  assert.equal(chooseTarget([], { seriesId: 'b' }, new Set(), new Set(), 0.3), null);
});

/* --- binge ----------------------------------------------------------------- */

test('a sitting counts chapters and ends after thirty idle minutes', () => {
  const t0 = 1_000_000;
  let s = tally(null, t0, 1);
  assert.equal(s.count, 1);
  s = tally(s, t0 + 5 * 60000, 1);
  assert.equal(s.count, 2);
  s = tally(s, t0 + 10 * 60000, 3);
  assert.equal(s.count, 5, 'a jump of three is three chapters');
  s = tally(s, s.lastAt + SITTING_MS + 1, 1);
  assert.equal(s.count, 1, 'a new sitting');
  assert.equal(tally({ count: 'x', lastAt: 'y' }, t0, 0).count, 1, 'garbage in, one chapter out');
});

test('the binge lines exist in both registers and carry the count', () => {
  for (const pool of ['binge', 'binge_late', 'missed', 'fresh']) {
    assert.ok(POOLS[pool]?.length >= 3, pool + ' has lines');
  }
  assert.ok(POOLS.binge.every((l) => l.includes('{count}')));
  assert.ok(POOLS.binge_late.every((l) => l.includes('{count}')));
  assert.ok(POOLS.missed.every((l) => l.includes('{days}')));
  assert.ok(POOLS.fresh.every((l) => l.includes('{title}')));
});

/* --- cast ------------------------------------------------------------------ */

test('a description is cut to one safe sentence, spoilers first', () => {
  assert.equal(trimDescription('A hunter. ~!He dies in chapter 40.!~ He likes cats.'), 'A hunter.');
  assert.equal(trimDescription('~!Secretly the villain.!~ A quiet student.'), 'A quiet student.');
  assert.equal(trimDescription('Age: 17\nHeight: 180cm\n__Sung Jinwoo__ is the weakest hunter of all mankind. Then he isn\'t.'),
    'Sung Jinwoo is the weakest hunter of all mankind.');
  assert.equal(trimDescription('An unfinished spoiler ~!that never closes'), 'An unfinished spoiler');
  assert.equal(trimDescription('Class: Mage\nGuild: Hunters Guild\nThe weakest hunter, at first.'), 'The weakest hunter, at first.');
  assert.equal(trimDescription('Class: Mage'), '', 'stat lines alone are nothing to say');
  assert.equal(trimDescription('Note: this is a sentence about a note, long enough not to be a label, and it goes on.'), 'Note: this is a sentence about a note, long enough not to be a label, and it goes on.');
  assert.equal(trimDescription(''), '');
  const long = trimDescription('x'.repeat(200) + '. Next.', 40);
  assert.ok(long.length <= 40 && long.endsWith('…'));
});

test('roles are labelled and a cast is shaped from the AniList edge list', () => {
  assert.equal(roleLabel('MAIN'), 'Main');
  assert.equal(roleLabel('supporting'), 'Supporting');
  assert.equal(roleLabel(undefined), 'Cast');
  const cast = shape({ characters: { edges: [
    { role: 'MAIN', node: { name: { full: 'Sung Jinwoo', native: '성진우' }, image: { medium: 'i.png' }, description: 'Weakest hunter. ~!Shadow monarch.!~' } },
    { role: 'SUPPORTING', node: { name: {} } },
  ] } });
  assert.equal(cast.length, 1);
  assert.deepEqual(cast[0], { name: 'Sung Jinwoo', native: '성진우', role: 'Main', image: 'i.png', line: 'Weakest hunter.' });
});
