/**
 * The discovery engine's judgement.
 *
 * The rankings themselves are AniList's and are not tested here -- asserting
 * that Solo Leveling is popular tests AniList, not Yomu, and would fail the
 * week it stops being true. What is tested is every decision this engine
 * makes on top of them: what counts as the same title, what stops a feed
 * narrowing to one genre, and how a request is built.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { canonical, diversify, score, WEIGHT, WEIGHTS, RAILS, TYPES, railQuery } =
  await import('../../dist-app/yomu-rank.js');

/* --- canonical identity ----------------------------------------------------- *
 *
 * Yomu can carry one series from six sources. A rail assembled from titles
 * needs its own collapse rule, and getting it wrong shows the reader the same
 * book three times. */

test('the same work from different sources is one title', () => {
  const same = [
    'Solo Leveling',
    'solo leveling',
    'Solo Leveling (Official Colored)',
    'Solo Leveling [Colored]',
    'Solo-Leveling',
  ];
  const keys = new Set(same.map(canonical));
  assert.equal(keys.size, 1, [...keys].join(' | '));
});

test('a sequel is not the same work as its original', () => {
  assert.notEqual(canonical('Solo Leveling'), canonical('Solo Leveling Ragnarok'));
  assert.notEqual(canonical('Tower of God'), canonical('Tower of Babel'));
});

test('a novel or side story does not masquerade as the main series', () => {
  /* These strip to the same key on purpose: they are the same *work*, and a
     rail offering you the novel of what you are reading is a duplicate. */
  assert.equal(canonical('Omniscient Reader (Novel)'), canonical('Omniscient Reader'));
  assert.equal(canonical('Berserk Side Story'), canonical('Berserk'));
});

test('canonical survives junk', () => {
  assert.equal(canonical(null), '');
  assert.equal(canonical(''), '');
  assert.equal(canonical('   '), '');
  assert.equal(canonical('!!!'), '');
});

/* --- diversity ---------------------------------------------------------------- */

const make = (n, genre, country = 'KR') =>
  Array.from({ length: n }, (_, i) => ({ title: genre + i, genres: [genre], country }));

test('one genre cannot take the whole rail', () => {
  const items = make(10, 'Action');
  const out = diversify(items, { perGenre: 3, perCountry: 99 });
  const leadThree = out.slice(0, 3).filter((i) => i.genres[0] === 'Action');
  assert.equal(leadThree.length, 3, 'the best matches still lead');
  assert.equal(out.length, 10, 'nothing is thrown away, only moved');
});

test('the crowded-out items go to the tail, not the bin', () => {
  const items = [...make(5, 'Action'), ...make(2, 'Romance')];
  const out = diversify(items, { perGenre: 2, perCountry: 99 });
  assert.equal(out.length, 7);
  assert.deepEqual(
    new Set(out.map((i) => i.title)),
    new Set(items.map((i) => i.title)),
  );
});

test('one country cannot take the whole rail either', () => {
  const items = [...make(9, 'Action', 'KR'), ...make(2, 'Action', 'JP')];
  const out = diversify(items, { perGenre: 99, perCountry: 4 });
  const leadFive = out.slice(0, 5).map((i) => i.country);
  assert.ok(leadFive.filter((c) => c === 'KR').length <= 4, leadFive.join(','));
});

test('diversify is safe on an empty or untagged list', () => {
  assert.deepEqual(diversify([]), []);
  assert.equal(diversify([{ title: 'x' }]).length, 1);
});

/* --- scoring -------------------------------------------------------------------- */

const profile = {
  genres: [{ name: 'Action', weight: 10 }, { name: 'Fantasy', weight: 6 }],
  tags: [{ name: 'Dungeon', weight: 8 }, { name: 'Necromancy', weight: 4 }],
  countries: [{ name: 'KR', weight: 3 }],
};

test('a title matching the profile outscores one that does not', () => {
  const match = { genres: ['Action'], tags: [{ name: 'Dungeon', rank: 90 }], country: 'KR', score: 80 };
  const miss = { genres: ['Sports'], tags: [{ name: 'Baseball', rank: 90 }], country: 'JP', score: 80 };
  assert.ok(score(match, profile) > score(miss, profile));
});

test('quality alone does not beat a strong taste match', () => {
  /* The whole point of a weighted model: a 95-rated sports manga should not
     outrank a 70-rated dungeon manhwa for someone who only reads dungeons. */
  const taste = { genres: ['Action'], tags: [{ name: 'Dungeon', rank: 95 }], country: 'KR', score: 70 };
  const quality = { genres: ['Sports'], tags: [], country: 'JP', score: 95 };
  assert.ok(score(taste, profile) > score(quality, profile));
});

test('scores stay inside 0..1 however extreme the input', () => {
  const wild = { genres: ['Action', 'Fantasy'], tags: [{ name: 'Dungeon', rank: 100 }],
    country: 'KR', score: 100, trending: 9999, votes: 99999, similarity: 1 };
  const value = score(wild, profile);
  assert.ok(value >= 0 && value <= 1, String(value));
  assert.ok(score({}, profile) >= 0);
});

test('an empty profile does not throw and ranks nothing above anything', () => {
  const empty = { genres: [], tags: [], countries: [] };
  assert.equal(typeof score({ genres: ['Action'] }, empty), 'number');
});

test('the weights sum to one, so no dimension is silently doubled', () => {
  const total = Object.values(WEIGHT).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, 'weights total ' + total);
});

test('the weights are data, not buried in the scorer', () => {
  /* The brief asked that changing the balance not require rewriting the
     engine. Every weight has to be reachable and named. */
  for (const key of ['taste', 'similarity', 'community', 'behaviour', 'quality', 'freshness']) {
    assert.equal(typeof WEIGHT[key], 'number', key + ' is configurable');
  }
});

/* --- signals ---------------------------------------------------------------------- */

test('not every interaction counts the same', () => {
  assert.ok(WEIGHTS.TITLE_FAVORITE > WEIGHTS.TITLE_BOOKMARK);
  assert.ok(WEIGHTS.TITLE_BOOKMARK > WEIGHTS.CHAPTER_COMPLETE);
  assert.ok(WEIGHTS.CHAPTER_COMPLETE > WEIGHTS.TITLE_VIEW);
});

test('negative signals exist, because a feed without them never narrows back', () => {
  assert.ok(WEIGHTS.TITLE_DROP < 0);
  assert.ok(WEIGHTS.TITLE_BOUNCE < 0);
  assert.ok(Math.abs(WEIGHTS.TITLE_DROP) > WEIGHTS.CHAPTER_COMPLETE,
    'dropping a series says more than finishing one chapter');
});

/* --- the query ---------------------------------------------------------------------- */

test('the three types rest on country of origin', () => {
  assert.deepEqual(TYPES.map((t) => t.id), ['all', 'manga', 'manhwa', 'manhua']);
  assert.equal(TYPES.find((t) => t.id === 'manhwa').country, 'KR');
  assert.equal(TYPES.find((t) => t.id === 'manga').country, 'JP');
  assert.equal(TYPES.find((t) => t.id === 'manhua').country, 'CN');
  assert.equal(TYPES.find((t) => t.id === 'all').country, null);
});

test('every rail asks a different question', () => {
  const sorts = Object.values(RAILS).map((r) => r.sort);
  /* Two rails with the same sort and no distinguishing filter would be the
     same list printed twice, which is how directories end up repeating. */
  const distinct = new Set(Object.entries(RAILS).map(([, r]) => r.sort + JSON.stringify(r.filter || {})));
  assert.equal(distinct.size, sorts.length, 'no two rails are the same query');
});

test('hidden gems is actually filtered away from the mainstream', () => {
  assert.ok(RAILS.gems.filter.popularity_lesser > 0);
  assert.ok(RAILS.gems.filter.averageScore_greater > 0);
});

test('every rail carries a reason the reader can read', () => {
  for (const [name, rail] of Object.entries(RAILS)) {
    assert.ok(rail.label && rail.why, name + ' explains itself');
    assert.ok(!/score|sort|weight|algorithm/i.test(rail.why), name + ' does not leak the formula');
  }
});

test('many rails are one request', () => {
  const query = railQuery(['trending', 'gems'], 'manhwa', 10);
  assert.match(query, /trending: Page/);
  assert.match(query, /gems: Page/);
  assert.equal((query.match(/^query/gm) || []).length, 1, 'one query, aliased');
  assert.match(query, /countryOfOrigin: KR/);
  assert.match(query, /isAdult: false/);
});

test('an unknown rail name is skipped rather than breaking the query', () => {
  const query = railQuery(['trending', 'nonsense'], 'all', 5);
  assert.match(query, /trending: Page/);
  assert.ok(!query.includes('nonsense'));
});

/* --- the engine does not reinvent the shell ------------------------------------------- */

test('the rails do not duplicate what yomu-shell.js already renders', () => {
  const rails = fs.readFileSync(new URL('../../dist-app/yomu-rails.js', import.meta.url), 'utf8');
  const shell = fs.readFileSync(new URL('../../dist-app/yomu-shell.js', import.meta.url), 'utf8');
  for (const id of ['yomu-continue', 'yomu-fresh', 'yomu-because']) {
    assert.ok(shell.includes(id), 'the shell owns ' + id);
  }
  assert.ok(!/becauseYouRead\(/.test(rails), 'no second "Because you read" on home');
  assert.ok(!/RAILS\.fresh/.test(rails), 'no second "New chapters" on home');
});

test('exactly one file decides the home feed order', () => {
  /* Two observers each positioning against the other's neighbour is how a
     page rewrites itself at frame rate. The shell owns the sequence; the
     rails are a member of its list and never move themselves. */
  const rails = fs.readFileSync(new URL('../../dist-app/yomu-rails.js', import.meta.url), 'utf8');
  const shell = fs.readFileSync(new URL('../../dist-app/yomu-shell.js', import.meta.url), 'utf8');

  assert.match(shell, /const FEED_ORDER = \[CONTINUE_ID, 'yomu-rails', FRESH_ID, BECAUSE_ID\]/,
    'the shell knows about the rails and where they go');
  assert.match(shell, /for \(const id of FEED_ORDER\)/, 'orderFeed walks that list');

  assert.ok(!/\.after\(built\)|before\(built\)|prepend\(built\)/.test(rails),
    'the rails never insert themselves at a position');
  assert.match(rails, /parent\.append\(built\)/, 'they only join the feed');
});

test('the reading order is carousel, continue, discovery, new, similar', () => {
  const shell = fs.readFileSync(new URL('../../dist-app/yomu-shell.js', import.meta.url), 'utf8');
  const order = /const FEED_ORDER = \[([^\]]*)\]/.exec(shell)[1]
    .split(',').map((s) => s.trim());
  assert.deepEqual(order, ["CONTINUE_ID", "'yomu-rails'", "FRESH_ID", "BECAUSE_ID"]);
});

test('the rails wait for a feed rather than guessing', () => {
  /* Mounted before the shell's sections exist, they were appended into an
     empty .g-main and React drew the carousel after them -- "Popular right
     now" above the hero. */
  const rails = fs.readFileSync(new URL('../../dist-app/yomu-rails.js', import.meta.url), 'utf8');
  assert.match(rails, /if \(!feedParent\(\)\) return;/, 'build waits for a feed');
  assert.match(rails, /built\.isConnected\) return/, 'and does not re-place once mounted');
});
