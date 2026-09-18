/**
 * The chapter-end moment: when it is worth interrupting for.
 *
 * The whole value of this feature is the restraint -- a card after every
 * chapter is furniture. So what is tested here is mostly what it declines to
 * do. The composition itself is DOM and is checked in the browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
const { choose, isNear, pct, NEAR_CHAPTERS, NEAR_FRACTION } = await import('../../dist-app/yomu-chapter-end.js');

/** A roadmap row as YomuProgress.roadmap() hands it over. */
const stop = (id, threshold, read, collected = false) => ({
  id,
  title: id,
  metric: 'chaptersRead',
  threshold,
  rewards: [{ type: 'badge', id }],
  collected,
  progress: (read / threshold) * 100,
  remaining: Math.max(threshold - read, 0),
});

test('close is three chapters, or a tenth of the way out when three is nothing', () => {
  assert.equal(NEAR_CHAPTERS, 3);
  assert.equal(NEAR_FRACTION, 0.1);

  assert.equal(isNear(3, 100), true, 'three away from anything is close');
  assert.equal(isNear(4, 100), true, 'four is a tenth of a hundred, so still close');
  assert.equal(isNear(11, 100), false, 'eleven of a hundred is not');
  assert.equal(isNear(4, 20), false, 'four of twenty is a fifth, and three is the rule there');
  assert.equal(isNear(3, 20), true);

  assert.equal(isNear(0, 100), false, 'already there is not "close"');
  assert.equal(isNear(-1, 100), false);
  assert.equal(isNear(100, 1000), true, 'the big stops widen with the threshold');
  assert.equal(isNear(101, 1000), false);
});

test('a reader in the middle of nowhere is left alone', () => {
  const roadmap = [stop('century', 100, 41), stop('shelf-bender', 250, 41)];
  assert.equal(choose(roadmap, [], 1), null);
  assert.equal(choose([], [], 1), null, 'no roadmap at all is not an error');
  assert.equal(choose(null, null, 1), null);
});

test('the nearest uncollected stop wins, and a collected one is not offered again', () => {
  const roadmap = [stop('century', 100, 98), stop('shelf-bender', 250, 98)];
  const pick = choose(roadmap, [], 1);
  assert.equal(pick.kind, 'milestone');
  assert.equal(pick.id, 'century');
  assert.equal(pick.badgeId, 'century', 'the badge the stop actually pays');
  assert.equal(pick.count, 98);
  assert.equal(pick.goal, 100);
  assert.equal(pick.remaining, 2);

  const done = [stop('century', 100, 98, true)];
  assert.equal(choose(done, [], 1), null, 'a stop already collected is not a thing to chase');
});

test('the bar starts where the count was, so the travel is the chapter just read', () => {
  const roadmap = [stop('century', 100, 98)];
  assert.equal(choose(roadmap, [], 1).from, 97);
  assert.equal(choose(roadmap, [], 3).from, 95, 'three chapters in one pulse travel three');
  assert.equal(choose(roadmap, [], 0).from, 97, 'a missing count is one chapter, not zero');
  assert.equal(choose(roadmap, [], 999).from, 0, 'and it never starts below zero');
});

test('a family tier is offered only when the chapter road has nothing to say', () => {
  const near = [stop('century', 100, 98)];
  const family = [{ family: 'tower-climber', count: 38, tier: 1, nextAt: 40, remaining: 2, pct: 93 }];

  assert.equal(choose(near, family, 1).kind, 'milestone', 'the chapter count is what a reader is counting');
  const tier = choose([stop('century', 100, 41)], family, 1);
  assert.equal(tier.kind, 'tier');
  assert.equal(tier.goal, 40);
  assert.equal(tier.remaining, 2);
  assert.equal(tier.badgeId, 'tower-climber:2', 'the tier being earned, not the one held');

  const far = [{ family: 'tower-climber', count: 12, tier: 1, nextAt: 40, remaining: 28, pct: 6 }];
  assert.equal(choose([], far, 1), null, 'twenty-eight chapters off is not a moment');
});

test('a tier bar measures the tier, not all of time', () => {
  /* Without a floor, one chapter into the 100..250 tier reads as 40% full. */
  assert.equal(pct(101, 100, 250), (1 / 150) * 100);
  assert.equal(pct(0, 0, 100), 0);
  assert.equal(pct(50, 0, 100), 50);
  assert.equal(pct(120, 0, 100), 100, 'past the goal is full, never more');
  assert.equal(pct(-5, 0, 100), 0);
  assert.equal(pct(5, 10, 10), 100, 'a zero span is done rather than a division by zero');
});
