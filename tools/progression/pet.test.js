/**
 * The pet's decisions, without a browser.
 *
 * The parts worth testing here are the ones a screenshot cannot show: which
 * atlas cell a state resolves to, which state wins when two arrive at once,
 * and which surfaces Mori is allowed on. The DOM behaviour -- pointer-events,
 * dragging, the reader reprieve -- is exercised against the running app
 * instead, because a jsdom that cannot lay anything out would only be
 * testing the mock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { ATLAS, CATALOG, STATES, PRIORITY, SIZES, POLICY } =
  await import('../../dist-app/yomu-pet.js');

/* --- the atlas ----------------------------------------------------------- */

test('the atlas matches the sheets that shipped', () => {
  // 8 x 192 = 1536, 9 x 208 = 1872. Verified against the real .webp files.
  assert.equal(ATLAS.columns * ATLAS.cellWidth, 1536);
  assert.equal(ATLAS.rows * ATLAS.cellHeight, 1872);
});

test('no animation claims more frames than a row holds', () => {
  for (const [name, animation] of Object.entries(ATLAS.animations)) {
    assert.ok(animation.frames <= ATLAS.columns, name + ' fits in a row');
    assert.ok(animation.row < ATLAS.rows, name + ' is on a real row');
    assert.ok(animation.ms > 0, name + ' has a duration');
  }
});

test('every product state resolves to a real animation', () => {
  for (const [state, animation] of Object.entries(STATES)) {
    assert.ok(ATLAS.animations[animation], state + ' -> ' + animation);
  }
});

test('every state has a priority and every priority has a state', () => {
  for (const state of Object.keys(STATES)) {
    assert.equal(typeof PRIORITY[state], 'number', state + ' is ranked');
  }
  for (const state of Object.keys(PRIORITY)) {
    assert.ok(STATES[state], state + ' is a real state');
  }
});

/* --- priority ------------------------------------------------------------ */

test('a reward outranks everything ambient', () => {
  for (const ambient of ['idle', 'sleeping', 'walkingLeft', 'walkingRight']) {
    assert.ok(
      PRIORITY.celebrating > PRIORITY[ambient],
      'celebrating beats ' + ambient,
    );
  }
});

test('a reward outranks a greeting and a tap', () => {
  assert.ok(PRIORITY.celebrating > PRIORITY.greeting);
  assert.ok(PRIORITY.celebrating > PRIORITY.happy);
});

test('dragging outranks a reward, because the hand is on the pet', () => {
  assert.ok(PRIORITY.dragging > PRIORITY.celebrating);
});

/* --- the catalog --------------------------------------------------------- */

test('the catalog is the five cleared skins and nothing else', () => {
  assert.deepEqual(
    CATALOG.map((p) => p.id).sort(),
    ['bolt', 'boba', 'miso', 'noir-webling', 'nukey'].sort(),
  );
});

test('no skin carries a third-party likeness', () => {
  /* batmeme, steve, lando-2, einstein and mini-sama were left out on
     purpose: ChatKit's NOTICE covers its code and says nothing about the
     provenance of the artwork, and Yomu ships publicly. */
  const excluded = ['batmeme', 'steve', 'lando-2', 'einstein', 'mini-sama'];
  for (const id of excluded) {
    assert.ok(!CATALOG.some((p) => p.id === id), id + ' is not shipped');
  }
});

test('every skin points at a prototype asset', () => {
  for (const pet of CATALOG) {
    assert.match(pet.src, /^\/pets\/prototype\/[a-z0-9-]+\.webp$/);
    assert.ok(pet.name && pet.name.length < 12, pet.id + ' has a short label');
  }
});

/* --- surfaces ------------------------------------------------------------ */

test('the reader never shows, greets, or is draggable', () => {
  assert.deepEqual(POLICY.reader, {
    visible: false, roam: false, greet: false, bubbles: false, drag: false,
  });
});

test('You hides the floating pet, because the page draws its own', () => {
  assert.equal(POLICY.you.visible, false);
});

test('an unlisted surface gets nothing', () => {
  /* Every page in dist-app loads the pet now, including the age gate and the
     redeem page. A default of visible would put a companion on all of them. */
  assert.equal(POLICY.other.visible, false);
  assert.equal(POLICY.other.greet, false);
});

test('only Home roams', () => {
  const roamers = Object.entries(POLICY).filter(([, p]) => p.roam).map(([k]) => k);
  assert.deepEqual(roamers, ['home']);
});

test('Sources is a helper, not a companion', () => {
  assert.equal(POLICY.sources.greet, false);
  assert.equal(POLICY.sources.roam, false);
  assert.equal(POLICY.sources.bubbles, true);
});

/* --- sizing -------------------------------------------------------------- */

test('sizes stay inside a phone and above the touch minimum', () => {
  for (const [name, px] of Object.entries(SIZES)) {
    assert.ok(px >= 44, name + ' is at least a touch target');
    assert.ok(px <= 160, name + ' does not dominate a 375px screen');
  }
  assert.ok(SIZES.small < SIZES.medium && SIZES.medium < SIZES.large);
});

/* --- the frame maths ----------------------------------------------------- *
 *
 * The same arithmetic the renderer runs, checked here because the browser
 * pane this was built against keeps its tab hidden, where rAF never fires
 * and the frame advance cannot be observed live. */

const offset = (row, frame, size) => ({
  x: -frame * size,
  y: -Math.round(row * ATLAS.cellHeight * (size / ATLAS.cellWidth)),
});

test('frame zero of idle is the sheet origin', () => {
  assert.deepEqual(offset(ATLAS.animations.idle.row, 0, 98), { x: -0, y: -0 });
});

test('a row offset scales with the rendered size', () => {
  // jumping is row 4; at 98px a cell is 208 * (98/192) = 106.17 tall.
  assert.equal(offset(4, 0, 98).y, -425);
  assert.equal(offset(4, 0, 196).y, -849);
});

test('frames step by exactly one cell width', () => {
  assert.equal(offset(0, 3, 98).x, -294);
  assert.equal(offset(0, 3, 98).x / 3, -98);
});

test('the last frame of every animation stays on the sheet', () => {
  for (const [name, a] of Object.entries(ATLAS.animations)) {
    const last = offset(a.row, a.frames - 1, 192);
    assert.ok(-last.x + 192 <= 1536, name + ' last frame is on the sheet');
    assert.ok(-last.y + 208 <= 1872, name + ' row is on the sheet');
  }
});
