/**
 * The cover wall's two decisions: which covers hang, and whether it may
 * come up at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { pickCovers, shouldStart, IDLE_MS, MIN_COVERS } = await import('../../dist-app/yomu-wall.js');

test('covers come from recent reading first, then the shelf, one per series, pictures only', () => {
  const library = [
    { id: 'a', sourceId: 's', title: 'A', cover: 'https://c/a.jpg' },
    { id: 'b', sourceId: 's', title: 'B' },
    { id: 'c', sourceId: 's', title: 'C', cover: 'https://c/c.jpg', hidden: true },
    { id: 'd', sourceId: 's', title: 'D', cover: 'https://c/d.jpg', category: 'adult' },
    { id: 'e', sourceId: 's', title: 'E', cover: 'https://c/e.jpg' },
  ];
  const reading = {
    's:a': { seriesId: 'a', sourceId: 's', chapterId: 'a:c9', title: 'A', cover: 'https://c/a2.jpg', at: 5 },
    's:z': { seriesId: 'z', sourceId: 's', chapterId: 'z:c1', title: 'Z', cover: 'https://c/z.jpg', at: 9 },
  };
  const picked = pickCovers(library, reading);
  assert.deepEqual(picked.map((c) => c.seriesId), ['z', 'a', 'e']);
  assert.equal(picked[0].href, '/read/z%3Ac1?source=s', 'reading resumes the chapter');
  assert.equal(picked[2].href, '/series/e?source=s', 'a saved title opens its page');
  assert.equal(pickCovers(Array.from({ length: 40 }, (_, i) => ({ id: 'x' + i, sourceId: 's', cover: 'https://c/x.jpg' })), {}).length, 18, 'capped');
});

test('the wall waits for a minute idle and stays away from everything else', () => {
  const base = { enabled: true, onHome: true, hidden: false, reduced: false, dialogOpen: false, lowBattery: false, idleMs: IDLE_MS, covers: MIN_COVERS };
  assert.equal(shouldStart(base), true);
  assert.equal(shouldStart({ ...base, idleMs: IDLE_MS - 1 }), false);
  assert.equal(shouldStart({ ...base, covers: MIN_COVERS - 1 }), false);
  for (const flag of ['hidden', 'reduced', 'dialogOpen', 'lowBattery']) assert.equal(shouldStart({ ...base, [flag]: true }), false, flag);
  assert.equal(shouldStart({ ...base, onHome: false }), false);
  assert.equal(shouldStart({ ...base, enabled: false }), false);
});
