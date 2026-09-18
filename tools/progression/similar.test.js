/**
 * The recommendation engine's contract.
 *
 * `similar.ts` is a Worker module whose interesting behaviour is a network
 * call, so these assert the decisions around that call rather than mocking
 * GraphQL: what gets cached, what gets filtered, and that a third party going
 * down cannot take the feature with it. The live shape is verified against
 * the deployed endpoint by hand, because a test that hits AniList on every
 * run is a test that fails when someone else is rate limited.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../../worker/similar.ts', import.meta.url), 'utf8');

test('AniList is asked first and MangaDex is the floor', () => {
  const body = SRC.slice(SRC.indexOf('export async function handleSimilar'));
  assert.ok(body.indexOf('fromAniList') < body.indexOf('fromMangaDex'), 'AniList first');
  assert.match(body, /if \(!answer\) answer = await fromMangaDex/, 'MangaDex catches the miss');
});

test('a third party failing degrades instead of throwing', () => {
  assert.match(SRC, /catch \(error: any\) \{\s*console\.error\('\[similar\] anilist failed/);
  /* The fallback is invisible to the reader, so it must not be invisible in
     the log too -- otherwise an outage reads as "recommendations got worse". */
  assert.match(SRC, /console\.warn\('\[similar\] anilist had nothing/);
  assert.match(SRC, /console\.warn\('\[similar\] anilist rate limited'\)/);
});

test('answers are cached, because the rate limit is per shared IP', () => {
  assert.match(SRC, /caches as any\)\.default/, 'uses the Cache API');
  assert.match(SRC, /await cache\.match\(key\)/, 'reads the cache');
  assert.match(SRC, /await cache\.put\(key/, 'writes the cache');
  const ttl = Number(/CACHE_SECONDS = (\d+)/.exec(SRC)?.[1]);
  assert.ok(ttl >= 3600, 'cached for at least an hour, got ' + ttl);
  /* KV's write budget belongs to Sync; this must not touch it. */
  assert.ok(!/env\.SYNC/.test(SRC), 'no KV writes on this path');
});

test('the cache key ignores case, so one title is one upstream call', () => {
  assert.match(SRC, /title\.toLowerCase\(\)/);
});

test('an empty answer is not cached for a day', () => {
  assert.match(SRC, /if \(body\.source !== 'none'\)/,
    'a title AniList indexes tomorrow must not stay unanswerable');
});

test('spoiler tags never reach the reader', () => {
  /* AniList marks them, and they are the interesting ones -- which is exactly
     why printing them beside a recommendation is a spoiler. */
  assert.match(SRC, /!t\.isMediaSpoiler/);
});

test('an unvoted pairing is not a recommendation', () => {
  assert.match(SRC, /\.filter\(\(p: SimilarPick\) => p\.votes > 0\)/);
});

test('tags come back strongest first', () => {
  assert.match(SRC, /\.sort\(\(a: any, b: any\) => b\.rank - a\.rank\)/);
});

test('the query asks for manga, not anime', () => {
  assert.match(SRC, /type: MANGA/);
  assert.match(SRC, /recommendations\(sort: RATING_DESC/);
});

test('input is bounded', () => {
  assert.match(SRC, /if \(!title\) return json\(\{ error: 'Need a title\.' \}/);
  assert.match(SRC, /title\.length > 200/);
});

/* --- the callers agree on the shape -------------------------------------- */

const MORI_TS = fs.readFileSync(new URL('../../worker/mori.ts', import.meta.url), 'utf8');
const MORI_JS = fs.readFileSync(new URL('../../dist-app/yomu-mori.js', import.meta.url), 'utf8');

test('the chat tool and the tap menu use the same engine', () => {
  assert.match(MORI_TS, /handleSimilar/, 'the tool goes through the cached route');
  assert.match(MORI_JS, /\/api\/catalog\/similar/, 'the menu does too');
  /* Two paths to one answer means a model call and a tap cannot disagree,
     and the second of them is free. */
  assert.ok(!/api\/catalog\/related/.test(MORI_TS), 'the tool no longer uses the old route');
});

test('the series page keeps the old endpoint', () => {
  /* yomu-shell.js renders the series "related" row from it, and this work is
     not allowed to change that screen. */
  const shell = fs.readFileSync(new URL('../../dist-app/yomu-shell.js', import.meta.url), 'utf8');
  assert.ok(shell.includes('api/catalog/related'), 'the old route is still in use');
  const worker = fs.readFileSync(new URL('../../worker/index.ts', import.meta.url), 'utf8');
  assert.match(worker, /'\/api\/catalog\/similar'/);
  assert.match(worker, /startsWith\('\/api\/catalog\/'\)/);
  assert.ok(
    worker.indexOf("'/api/catalog/similar'") < worker.indexOf("startsWith('/api/catalog/')"),
    'the exact route is matched before the prefix that would swallow it',
  );
});

test('the vote count is shown to the reader, not just the model', () => {
  assert.match(MORI_JS, /readers?'/, 'the panel prints the vote weight');
  assert.match(MORI_TS, /vote count/, 'the model is told what the number means');
});
