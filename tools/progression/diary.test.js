/**
 * Mori's diary: what it writes, and about what.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { compose, pending, OPENERS, FLAVOUR, BY_LENGTH } = await import('../../dist-app/yomu-diary.js');

test('an entry is two lines, the first naming the title and its length', () => {
  const lines = compose({ title: 'Solo Leveling', chapters: 179, genres: ['Action', 'Fantasy'], stage: 2 }, 0);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], OPENERS[0].replace('{title}', 'Solo Leveling').replace('{n}', '179'));
  assert.equal(lines[1], FLAVOUR.Action[0], 'the first known genre flavours the second line');
  assert.deepEqual(compose({ title: 'X', chapters: 5, genres: ['Hentai'] }, 0), [OPENERS[0].replace('{title}', 'X').replace('{n}', '5'), BY_LENGTH.short[0]], 'an unknown genre falls back to length');
  assert.equal(compose({ title: 'Y', chapters: 300, genres: [] }, 0)[1], BY_LENGTH.long[0]);
  assert.equal(compose({ title: 'Z', chapters: 50, genres: ['Drama'], stage: 5 }, 0)[1].includes('blue-flame'), true, 'a hot streak outranks the genre');
  assert.equal(compose({ title: 'W' }, 0)[0].includes('all its chapters'), true, 'no count, no number');
});

test('the same facts and roll give the same entry; only unwritten titles are pending', () => {
  const a = compose({ title: 'T', chapters: 40, genres: ['Romance'] }, 0.42);
  const b = compose({ title: 'T', chapters: 40, genres: ['Romance'] }, 0.42);
  assert.deepEqual(a, b);
  const done = [{ key: 's:1', title: 'One', chapters: 3 }, { key: 's:2', title: 'Two', chapters: 9 }];
  assert.deepEqual(pending(done, [{ key: 's:1' }]).map((d) => d.key), ['s:2']);
  assert.deepEqual(pending(done, []).length, 2);
});
