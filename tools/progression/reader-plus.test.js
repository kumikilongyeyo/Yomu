/**
 * The reader, a little further ahead: which pages to warm, when to fetch the
 * next chapter, and when the chrome should follow the scroll.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { aheadCount, aheadPages, nextChapterStage, chromeStep, SHOW_AFTER, HIDE_AFTER } =
  await import('../../dist-app/yomu-reader-plus.js');

test('pages are warmed just past the reader\'s own +/-3 window, never past the end', () => {
  assert.deepEqual(aheadPages(0, 40, 3), [4, 5, 6]);
  assert.deepEqual(aheadPages(35, 40, 3), [39]);
  assert.deepEqual(aheadPages(39, 40, 3), []);
  assert.deepEqual(aheadPages(0, 40, 0), []);
});

test('a data-saver or 2G connection warms nothing extra', () => {
  assert.equal(aheadCount({ saveData: true, effectiveType: '4g' }), 0);
  assert.equal(aheadCount({ effectiveType: '2g' }), 0);
  assert.equal(aheadCount({ effectiveType: '3g' }), 1);
  assert.equal(aheadCount({ effectiveType: '4g' }), 3);
  assert.equal(aheadCount(undefined), 3, 'Safari has no connection API; assume a normal line');
});

test('the next chapter: manifest at three quarters, first pages at nine tenths', () => {
  assert.equal(nextChapterStage(10, 40), 'none');
  assert.equal(nextChapterStage(29, 40), 'manifest');
  assert.equal(nextChapterStage(35, 40), 'images');
  assert.equal(nextChapterStage(39, 40), 'images');
  assert.equal(nextChapterStage(0, 0), 'none', 'no pages yet');
});

test('a short chapter counts in pages left, not fractions', () => {
  assert.equal(nextChapterStage(0, 6), 'none');
  assert.equal(nextChapterStage(2, 6), 'manifest', 'three pages left');
  assert.equal(nextChapterStage(4, 6), 'images', 'one page left');
  assert.equal(nextChapterStage(0, 1), 'images', 'a one-page chapter is already at its end');
});

function drive(tops) {
  let state = null;
  const intents = [];
  for (const top of tops) {
    const step = chromeStep(state, top);
    state = step.state;
    if (step.intent) intents.push(step.intent);
  }
  return intents;
}

test('scrolling down hides the chrome, scrolling up brings it back', () => {
  assert.deepEqual(drive([1000, 1020, 1040, 1060]), ['hide']);
  assert.deepEqual(drive([1000, 990, 980, 970]), ['show']);
});

test('a jittery thumb does nothing', () => {
  const tops = [1000];
  /* Swings of 16px: below both thresholds, however long it goes on. */
  for (let i = 0; i < 30; i++) tops.push(1000 + (i % 2 ? 8 : -8));
  assert.deepEqual(drive(tops), []);
});

test('reaching the top of the chapter always shows the chrome', () => {
  assert.deepEqual(drive([300, 30]), ['show']);
});

test('the thresholds are asymmetric: quicker to come back than to leave', () => {
  assert.ok(SHOW_AFTER < HIDE_AFTER);
});
