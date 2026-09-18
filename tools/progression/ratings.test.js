import test from 'node:test';
import assert from 'node:assert/strict';
const { formatScore } = await import('../../dist-app/yomu-ratings.js');
const { shape } = await import('../../dist-app/yomu-anilist.js');

test('a score is AniList\'s 0-100 shown out of ten, or nothing', () => {
  assert.equal(formatScore(87), '8.7');
  assert.equal(formatScore(100), '10.0');
  assert.equal(formatScore(0), null);
  assert.equal(formatScore(null), null);
  assert.equal(formatScore('x'), null);
});

test('the AniList answer carries the score, null when there is none', () => {
  // shape() returns null for a title with no tags and no picks, so give it one tag.
  const media = { title: { english: 'T' }, genres: [], tags: [{ name: 'Tower', rank: 80, isMediaSpoiler: false }], averageScore: 84, recommendations: { nodes: [] } };
  assert.equal(shape(media).score, 84);
  assert.equal(shape({ ...media, averageScore: null }).score, null);
});
