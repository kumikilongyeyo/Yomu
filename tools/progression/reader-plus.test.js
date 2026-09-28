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

/* --- the reliability pass ---------------------------------------------------- */

const { handoffOffset, chapterName } = await import('../../dist-app/yomu-reader-plus.js');

test('the next chapter is asked for at 70% and warmed at 85%', () => {
  assert.equal(nextChapterStage(26, 40), 'none', '67%');
  assert.equal(nextChapterStage(27, 40), 'manifest', '70%');
  assert.equal(nextChapterStage(32, 40), 'manifest', 'page 33 of 40 is 82.5%');
  assert.equal(nextChapterStage(33, 40), 'images', 'page 34 of 40 is exactly 85%');
  assert.equal(nextChapterStage(34, 40), 'images', '87.5%');
});

test('warming starts past the real end of the mounted window when there is one', () => {
  assert.deepEqual(aheadPages(10, 40, 2, 12), [13, 14]);
  assert.deepEqual(aheadPages(10, 40, 2), [14, 15], 'without one, the bundle\'s own +/-3');
});

test('moving into the next chapter keeps the spot on screen', () => {
  assert.equal(handoffOffset(900, 1000, 2000), null, 'still above its first page');
  assert.equal(handoffOffset(1000, 1000, 2000), 0);
  assert.equal(handoffOffset(1500, 1000, 2000), 0.25);
  assert.ok(handoffOffset(9000, 1000, 2000) < 1, 'never past the page it hands over');
  assert.equal(handoffOffset(1500, 1000, 0), null, 'an image with no height yet is not a place');
});

test('chapters are named from the series the reader loaded', () => {
  const series = { chapters: [{ id: 'a:c12', number: 12, name: '12' }, { id: 'a:c13', number: 13, name: 'The Gate' }] };
  assert.deepEqual(chapterName(series, 'a:c12'), { number: 'Chapter 12', name: '' }, 'a name that is just the number is not repeated');
  assert.deepEqual(chapterName(series, 'a:c13'), { number: 'Chapter 13', name: 'The Gate' });
  assert.deepEqual(chapterName(null, 'x'), { number: '', name: '' });
});
