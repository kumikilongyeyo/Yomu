/**
 * The wrap's arithmetic: what an hour is, which genres lead, which covers
 * are chosen. The drawing is checked in the browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { hours, rankGenres, pickCovers, monthLabel, MINUTES_PER_CHAPTER } = await import('../../dist-app/yomu-wrap.js');

test('hours are an estimate at seven minutes a chapter, said as minutes under an hour', () => {
  assert.equal(MINUTES_PER_CHAPTER, 7);
  assert.equal(hours(0), '0 min');
  assert.equal(hours(5), '35 min');
  assert.equal(hours(9), '~1 h');
  assert.equal(hours(120), '~14 h');
});

test('genres are weighted by chapters read of each title, top three', () => {
  const series = [{ seriesId: 'a', chapters: 10 }, { seriesId: 'b', chapters: 3 }, { seriesId: 'c', chapters: 1 }];
  const genres = { a: ['Action', 'Fantasy'], b: ['Romance', 'Fantasy'], c: ['Sports'] };
  assert.deepEqual(rankGenres(series, (s) => genres[s.seriesId]), ['Fantasy', 'Action', 'Romance']);
  assert.deepEqual(rankGenres(series, () => null), []);
  assert.deepEqual(rankGenres(series, () => ['Hentai', 'Ecchi', 'Drama']), ['Drama'], 'ratings are not genres');
});

test('covers are the most-read titles that can be named, three at most', () => {
  const series = [{ seriesId: 'a', chapters: 10 }, { seriesId: 'x', chapters: 9 }, { seriesId: 'b', chapters: 3 }, { seriesId: 'c', chapters: 2 }, { seriesId: 'd', chapters: 1 }];
  const info = { a: { title: 'A' }, b: { title: 'B', cover: 'https://c/b.jpg' }, c: { title: 'C' }, d: { title: 'D' } };
  const picked = pickCovers(series, (id) => info[id] || null);
  assert.deepEqual(picked.map((c) => c.title), ['A', 'B', 'C'], 'x has no title and is skipped');
  assert.equal(picked[1].chapters, 3);
  assert.equal(monthLabel('2026-09'), 'September');
  assert.equal(monthLabel('2026-12'), 'December');
});
