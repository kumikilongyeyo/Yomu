/**
 * "Can I finish this?" -- the completeness line above the chapter list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { completeness, describeRanges } = await import('../../dist-app/yomu-ledger.js');
const rows = (...numbers) => numbers.map((number) => ({ number }));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('every chapter from 1 to the highest is there: complete', () => {
  const c = completeness(rows(...range(1, 202)));
  assert.equal(c.available, 202);
  assert.equal(c.total, 202);
  assert.deepEqual(c.missing, []);
});

test('holes are counted and named as ranges', () => {
  const have = range(1, 105).filter((n) => ![61, 89, 102, 103].includes(n));
  const c = completeness(rows(...have));
  assert.equal(c.available, 101);
  assert.equal(c.total, 105);
  assert.deepEqual(c.ranges, [[61, 61], [89, 89], [102, 103]]);
  assert.equal(describeRanges(c.ranges), '61, 89, 102–103');
});

test('a series only carried from chapter 40 is missing 1-39, and says so', () => {
  const c = completeness(rows(...range(40, 105)));
  assert.deepEqual(c.ranges, [[1, 39]]);
  assert.equal(c.available, 66);
});

test('decimals and chapter 0 are extras, never holes', () => {
  const c = completeness(rows(0, 1, 2, 2.5, 3));
  assert.equal(c.total, 3);
  assert.equal(c.available, 3);
});

test('numbering that cannot be trusted draws nothing rather than "12 / 2024"', () => {
  assert.equal(completeness(rows(...range(1, 12), 2024)), null);
  assert.equal(completeness(rows(5)), null, 'one chapter is not a list');
  assert.equal(completeness([]), null);
});

test('a long tail of holes is summarised, not listed', () => {
  assert.equal(describeRanges([[1, 1], [3, 3], [5, 5], [7, 7], [9, 9], [11, 11]]), '1, 3, 5, 7 +2 more');
});
