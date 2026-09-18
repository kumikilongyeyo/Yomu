/**
 * When the ceremony fires. The DOM half is exercised in the browser; the
 * decision is the part that can go wrong quietly -- replaying a stage change
 * from last month, or celebrating an egg that has not opened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { decide } = await import('../../dist-app/yomu-ceremony.js');

const stage = (level, name) => ({ level, name });

test('with no record, the current stage is written down and nothing is celebrated', () => {
  assert.deepEqual(decide({ petUnlocked: true }, stage(3, 'Companion'), null),
    { seed: { level: 3, unlocked: true } });
  assert.deepEqual(decide({ petUnlocked: false }, stage(1, 'Hatchling'), null),
    { seed: { level: 0, unlocked: false } });
});

test('an egg that has not opened is not an occasion', () => {
  assert.equal(decide({ petUnlocked: false }, stage(1, 'Hatchling'), { level: 0, unlocked: false }), null);
});

test('the unlock is the hatch', () => {
  const verdict = decide({ petUnlocked: true }, stage(1, 'Hatchling'), { level: 0, unlocked: false });
  assert.equal(verdict.kind, 'hatch');
});

test('a higher stage than last celebrated is an evolution, the same stage is nothing', () => {
  const up = decide({ petUnlocked: true }, stage(2, 'Fledgling'), { level: 1, unlocked: true });
  assert.equal(up.kind, 'evolve');
  assert.equal(up.from, 1);
  assert.equal(decide({ petUnlocked: true }, stage(2, 'Fledgling'), { level: 2, unlocked: true }), null);
  // A hand-edited XP going down is not a devolution ceremony.
  assert.equal(decide({ petUnlocked: true }, stage(1, 'Hatchling'), { level: 2, unlocked: true }), null);
});
