/**
 * The reader's settings, its paged view and its page window: the decisions,
 * without a browser. What is on screen is covered by
 * tests/reader-reliability.spec.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  readPrefs, pageBytes, windowRange, spreadGroups, groupOf, tapAction, swipeAction, keyAction,
  inferMode, originOf, shortcutAction, nextMode, paceOf, DEFAULTS,
} = await import('../../dist-app/yomu-reader-settings.js');

const MB = 1024 * 1024;
const FAST = { constrained: false, speed: 'fast', budget: 220 * MB };
const PHONE = { constrained: false, speed: 'unknown', budget: 110 * MB };
const SAVER = { constrained: true, speed: 'fast', budget: 220 * MB };

test('stored preferences are cleaned, so a hand-edited value cannot break the layout', () => {
  assert.deepEqual(readPrefs(null), { ...DEFAULTS });
  assert.equal(readPrefs({ width: 99999 }).width, 1600);
  assert.equal(readPrefs({ width: 'wide' }).width, 900);
  assert.equal(readPrefs({ gap: -4 }).gap, 0);
  assert.equal(readPrefs({ quality: 'tiny' }).quality, 'original');
  assert.equal(readPrefs({ rtl: 'yes' }).rtl, false, 'only a real true turns right-to-left on');
  assert.equal(readPrefs({}).continuous, true, 'continuous chapters is on unless turned off');
  assert.equal(readPrefs({ continuous: false }).continuous, false);
});

test('a page costs its decoded size: what the reader measured, else what the manifest declares', () => {
  const page = { key: 'p1', width: 800, height: 1200 };
  assert.equal(pageBytes(page, new Map()), 800 * 1200 * 4);
  assert.equal(pageBytes(page, new Map([['p1', { width: 720, height: 10000 }]])), 720 * 10000 * 4);
  assert.equal(pageBytes({ key: 'x' }, new Map()), null, 'no size known is no guess here');
});

test('normal pages get the full window: four ahead on a fast line, two behind', () => {
  const pages = Array.from({ length: 40 }, (_, i) => ({ key: `p${i}`, width: 800, height: 1200 }));
  assert.deepEqual(windowRange(10, 40, pages, new Map(), FAST), { start: 8, end: 14 });
});

test('huge strips shrink the window to what the byte budget holds -- never below one each side', () => {
  const pages = Array.from({ length: 60 }, (_, i) => ({ key: `p${i}`, width: 720, height: 10000 }));
  /* 720x10000 is 27.5MB decoded: a phone's 110MB holds four of them --
     one behind, this one, two ahead -- where the old window mounted seven. */
  const range = windowRange(20, 60, pages, new Map(), PHONE);
  assert.deepEqual(range, { start: 19, end: 22 });
  const tighter = windowRange(20, 60, pages, new Map(), { ...PHONE, budget: 64 * MB });
  assert.deepEqual(tighter, { start: 19, end: 21 }, 'a 2GB phone: one either side, never fewer');
  const desktop = windowRange(20, 60, pages, new Map(), FAST);
  assert.ok(desktop.end - desktop.start > range.end - range.start, 'a desktop holds more of them');
});

test('Data saver keeps one page either side', () => {
  const pages = Array.from({ length: 20 }, (_, i) => ({ key: `p${i}` }));
  assert.deepEqual(windowRange(5, 20, pages, new Map(), SAVER), { start: 4, end: 6 });
});

test('the window stops at the ends of the chapter', () => {
  assert.deepEqual(windowRange(0, 3, [], new Map(), FAST), { start: 0, end: 2 });
  assert.deepEqual(windowRange(0, 1, [], new Map(), FAST), { start: 0, end: 0 });
  assert.deepEqual(windowRange(0, 0, [], new Map(), FAST), { start: 0, end: -1 });
});

test('pace is only an opinion after a few pages', () => {
  assert.equal(paceOf(300, 1), 'unknown');
  assert.equal(paceOf(300, 5), 'fast');
  assert.equal(paceOf(1500, 5), 'normal');
  assert.equal(paceOf(5000, 5), 'slow');
});

test('single page mode is every page alone', () => {
  assert.deepEqual(spreadGroups(3, () => null, { spread: false }), [[0], [1], [2]]);
});

test('spreads start after the first page, and pair the rest', () => {
  assert.deepEqual(spreadGroups(6, () => 0.7, { spread: true, cover: true }), [[0], [1, 2], [3, 4], [5]]);
  assert.deepEqual(spreadGroups(6, () => 0.7, { spread: true, cover: false }), [[0, 1], [2, 3], [4, 5]]);
});

test('a page already wider than tall is a double page, and stands alone', () => {
  const aspect = (i) => (i === 3 ? 1.4 : 0.7);
  assert.deepEqual(spreadGroups(7, aspect, { spread: true, cover: true }), [[0], [1, 2], [3], [4, 5], [6]]);
});

test('the group that shows a page', () => {
  const groups = [[0], [1, 2], [3], [4, 5]];
  assert.equal(groupOf(groups, 0), 0);
  assert.equal(groupOf(groups, 2), 1);
  assert.equal(groupOf(groups, 5), 3);
  assert.equal(groupOf(groups, 99), 3, 'past the end is the last group, not the first');
});

test('tap zones: the edges turn, the middle is the menu -- mirrored right to left', () => {
  assert.equal(tapAction(0.1, false), 'back');
  assert.equal(tapAction(0.9, false), 'next');
  assert.equal(tapAction(0.5, false), 'menu');
  assert.equal(tapAction(0.1, true), 'next', 'manga: the left edge is forward');
  assert.equal(tapAction(0.9, true), 'back');
});

test('a swipe turns the page the way the finger pulls it', () => {
  assert.equal(swipeAction(-120, 10, false), 'next', 'pulling left brings the next page in');
  assert.equal(swipeAction(120, 10, false), 'back');
  assert.equal(swipeAction(120, 10, true), 'next', 'right to left, the other way');
  assert.equal(swipeAction(-30, 0, false), null, 'too short');
  assert.equal(swipeAction(-80, 200, false), null, 'mostly vertical is not a turn');
});

test('the arrows follow the direction on screen; Page Down is always forward', () => {
  assert.equal(keyAction('ArrowRight', false, false), 'next');
  assert.equal(keyAction('ArrowRight', false, true), 'back');
  assert.equal(keyAction('ArrowLeft', false, true), 'next');
  assert.equal(keyAction('PageDown', false, true), 'next');
  assert.equal(keyAction(' ', true, false), 'back', 'Shift+Space goes back');
  assert.equal(keyAction('x', false, false), null);
});

const ratios = (value, n = 12) => Array.from({ length: n }, () => value);

test('tall strips are read as a strip wherever they come from', () => {
  assert.equal(inferMode(ratios(6.5), null), 'scroll');
  assert.equal(inferMode(ratios(6.5), 'manga'), 'scroll');
});

test('page-shaped images are only manga when the title is Japanese', () => {
  assert.equal(inferMode(ratios(1.45), 'manga'), 'page');
  assert.equal(inferMode(ratios(1.45), 'strip'), null, 'a webtoon sliced into page-sized pieces stays a strip');
  assert.equal(inferMode(ratios(1.45), null), null, 'unknown origin, no offer');
  assert.equal(inferMode(ratios(1.45, 4), 'manga'), null, 'too few pages seen to say');
  assert.equal(inferMode(ratios(1.45, 5), 'manga'), 'page', 'the five pages mounted at the top of a chapter are enough');
});

test('origin comes from the series category first', () => {
  assert.equal(originOf({ category: 'manga' }), 'manga');
  assert.equal(originOf({ category: 'Manhwa' }), 'strip');
  assert.equal(originOf({}), null);
});

test('shortcuts ignore modified keys, so the browser keeps its own', () => {
  assert.equal(shortcutAction({ key: ']' }), 'next-chapter');
  assert.equal(shortcutAction({ key: '[' }), 'previous-chapter');
  assert.equal(shortcutAction({ key: 'm' }), 'mode');
  assert.equal(shortcutAction({ key: 'f', metaKey: true }), null);
  assert.equal(shortcutAction({ key: 'c', ctrlKey: true }), null);
});

test('M cycles the modes, skipping Spread on a narrow screen', () => {
  assert.equal(nextMode('scroll', true), 'page');
  assert.equal(nextMode('page', true), 'spread');
  assert.equal(nextMode('spread', true), 'scroll');
  assert.equal(nextMode('page', false), 'scroll');
});
