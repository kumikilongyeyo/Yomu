/**
 * The discovery update's decisions: how a bingo card is dealt and scored,
 * what the roulette lands on, what a skin needs, and the capsule's arithmetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { deal, lines, PROMPTS, GENRES, LINES } = await import('../../dist-app/yomu-bingo.js');
const { pick, sentence } = await import('../../dist-app/yomu-roulette.js');
const { SKINS, unlocked } = await import('../../dist-app/yomu-skins.js');
const { newlySaved, ago, due } = await import('../../dist-app/yomu-capsule.js');
const { MILESTONES } = await import('../../dist-app/yomu-progress.js');
const { MILESTONE_FAMILIES } = await import('../../dist-app/yomu-shelf.js');

/* --- bingo ----------------------------------------------------------------- */

test('a card is 25 unique squares with the centre free, the same for the same month', () => {
  const a = deal('2026-09', 'salt', new Set());
  const b = deal('2026-09', 'salt', new Set());
  assert.deepEqual(a, b, 'deterministic');
  assert.equal(a.squares.length, 25);
  assert.equal(a.squares[12], 'free');
  assert.equal(new Set(a.squares).size, 25, 'no repeats');
  for (const id of a.squares) assert.ok(id === 'free' || PROMPTS.some((p) => p.id === id), id + ' is a real prompt');
  const c = deal('2026-10', 'salt', new Set());
  assert.notDeepEqual(a.squares, c.squares, 'a new month is a new card');
});

test('the four genre squares favour genres never read', () => {
  const read = new Set(GENRES.slice(4).map((g) => g.toLowerCase()));   // read everything but the first four
  const card = deal('2026-09', 'x', read);
  const genres = card.squares.filter((id) => id.startsWith('genre:')).map((id) => id.slice(6));
  assert.equal(genres.length, 4);
  assert.deepEqual(genres.slice().sort(), GENRES.slice(0, 4).sort(), 'the untouched four');
});

test('twelve lines, and a full card completes all of them', () => {
  assert.equal(LINES.length, 12);
  const none = Array(25).fill(false);
  assert.equal(lines(none).length, 0);
  const row = none.slice(); for (let i = 5; i < 10; i++) row[i] = true;
  assert.equal(lines(row).length, 1);
  const diag = none.slice(); for (const i of [0, 6, 12, 18, 24]) diag[i] = true;
  assert.equal(lines(diag).length, 1);
  assert.equal(lines(Array(25).fill(true)).length, 12);
});

test('every prompt checks something and the store pays the bingo badges with art', () => {
  for (const p of PROMPTS) assert.equal(typeof p.check, 'function', p.id);
  for (const id of ['bingo-line', 'bingo-card']) {
    assert.ok(MILESTONES.some((m) => m.rewards.some((r) => r.type === 'badge' && r.id === id)), id + ' is paid');
    assert.ok(MILESTONE_FAMILIES[id], id + ' has art');
  }
});

/* --- roulette -------------------------------------------------------------- */

const item = (title, genres, trending = 0, popularity = 0) => ({ title, genres, trending, popularity });

test('the roulette lands in a genre the reader has never read, fullest first', () => {
  const items = [
    item('A', ['Romance'], 90, 1000),
    item('B', ['Sports'], 50, 2400),
    item('C', ['Sports', 'Drama'], 80, 300),
    item('D', ['Horror'], 99, 5000),
  ];
  const read = new Set(['romance', 'drama']);
  const result = pick(items, read, 0);
  assert.equal(result.why, 'never');
  assert.equal(result.genre, 'Sports', 'two candidates beats one');
  assert.equal(result.item.title, 'C', 'the one trending hardest within it');
  assert.match(sentence(result), /^You have never read Sports\. 300 people are reading this one right now\.$/);
});

test('a reader who has read everything gets the fastest mover and an honest sentence', () => {
  const items = [item('A', ['Romance'], 10, 5), item('B', ['Sports'], 70, 9)];
  const result = pick(items, new Set(['romance', 'sports']), 0);
  assert.equal(result.why, 'everything');
  assert.equal(result.item.title, 'B');
  assert.match(sentence(result), /a bit of everything/);
  assert.equal(pick([], new Set(), 0), null);
  assert.equal(pick([item('X', ['Hentai'], 1, 1)], new Set(), 0).why, 'everything', 'ratings are not genres');
});

/* --- skins ----------------------------------------------------------------- */

test('skins unlock by stage or by badge, and the default is always open', () => {
  const byId = Object.fromEntries(SKINS.map((s) => [s.id, s]));
  assert.equal(unlocked(byId[''], {}, 1), true);
  assert.equal(unlocked(byId.autumn, {}, 1), false);
  assert.equal(unlocked(byId.autumn, {}, 2), true);
  assert.equal(unlocked(byId.scanlation, {}, 4), false);
  assert.equal(unlocked(byId.scanlation, {}, 5), true);
  assert.equal(unlocked(byId.gilt, { earnedBadgeIds: [] }, 5), false);
  assert.equal(unlocked(byId.gilt, { earnedBadgeIds: ['bingo-card'] }, 1), true);
  assert.equal(new Set(SKINS.map((s) => s.id)).size, SKINS.length);
});

/* --- capsule --------------------------------------------------------------- */

test('a save is the difference between two library snapshots', () => {
  assert.deepEqual(newlySaved(new Set(['a:1']), new Set(['a:1', 'b:2'])), ['b:2']);
  assert.deepEqual(newlySaved(new Set(['a:1', 'b:2']), new Set(['a:1'])), [], 'a removal is not a save');
});

test('"ago" reads like a person wrote it', () => {
  const DAY = 86400000;
  const now = Date.UTC(2026, 8, 18);
  assert.equal(ago(now, now), 'today');
  assert.equal(ago(now - DAY, now), 'yesterday');
  assert.equal(ago(now - 12 * DAY, now), '12 days ago');
  assert.equal(ago(now - 35 * DAY, now), 'a month ago');
  assert.equal(ago(now - 100 * DAY, now), '3 months ago');
  assert.equal(ago(now - 400 * DAY, now), 'a year ago');
});

test('only unshown notes on finished titles are due', () => {
  const notes = {
    'a:1': { note: 'the art', at: 1 },
    'b:2': { note: 'friends said', at: 1, shownAt: 5 },
    'c:3': { skipped: true, at: 1 },
    'd:4': { note: 'unfinished', at: 1 },
  };
  assert.deepEqual(due(notes, ['a:1', 'b:2', 'c:3']), ['a:1']);
});
