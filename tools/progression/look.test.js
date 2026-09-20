/**
 * Customize look: the pure half.
 *
 * What is stored has to come back as a look with every knob valid, whatever
 * was in it; a chip's preset has to follow the per-tag override, then the
 * global one, then its own; and grapick's stops have to become the three
 * colours the chip recipe takes. The sheet itself is DOM and is checked in
 * the browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { DEFAULTS, PRESETS, normalize, paletteFor, stopsToColours, isDefault } = await import('../../dist-app/yomu-look.js');

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('anything stored normalizes to a valid look, and nothing stored is the default', () => {
  assert.equal(isDefault(normalize(null)), true);
  assert.equal(isDefault(normalize({})), true);
  assert.equal(isDefault(normalize('garbage')), true);
  assert.equal(isDefault(DEFAULTS), true);

  const look = normalize({
    palette: 'sunset', kinds: { hot: 'ocean', bogus: 'ember', rating: 'nope', gem: '' },
    custom: ['#FFB02E', '#ff2d9a', '#8b2bf2', '#17b6ff'],
    angle: 999, fill: -5, frost: 'x', blur: 40, lift: 'yes', shade: 0,
  });
  assert.equal(look.palette, 'sunset');
  assert.deepEqual(look.kinds, { hot: 'ocean' }, 'unknown tags and unknown presets are dropped, empty is not an override');
  assert.deepEqual(look.custom, ['#ffb02e', '#ff2d9a', '#8b2bf2', '#17b6ff'], 'hex is kept, lower-cased');
  assert.equal(look.angle, 360);
  assert.equal(look.fill, 0);
  assert.equal(look.frost, DEFAULTS.frost, 'a non-number falls back');
  assert.equal(look.blur, 16);
  assert.equal(look.lift, DEFAULTS.lift, 'a non-boolean falls back');
  assert.equal(look.shade, 30);
  assert.equal(isDefault(look), false);

  assert.deepEqual(normalize({ custom: ['red', '#000000', '#000000', '#000000'] }).custom, [...DEFAULTS.custom], 'a bad stop resets the set');
  assert.equal(normalize({ palette: 'rainbow' }).palette, '');
});

test('a chip wears its per-tag preset, else the global one, else its own', () => {
  const own = normalize({});
  assert.equal(paletteFor('hot', own), '', 'nothing set means the chip keeps its own');
  const global = normalize({ palette: 'ocean' });
  assert.equal(paletteFor('hot', global), 'ocean');
  const both = normalize({ palette: 'ocean', kinds: { hot: 'sunset' } });
  assert.equal(paletteFor('hot', both), 'sunset');
  assert.equal(paletteFor('rating', both), 'ocean');
  const custom = normalize({ kinds: { gem: 'custom' } });
  assert.equal(paletteFor('gem', custom), 'custom');
  assert.equal(paletteFor('hot', custom), '');
});

test('grapick stops become start, the stop nearest the middle, and end', () => {
  assert.equal(stopsToColours([]), null);
  assert.equal(stopsToColours([{ color: '#ff0000', position: 0 }]), null, 'one stop is not a gradient');
  assert.deepEqual(
    stopsToColours([{ color: '#0000ff', position: 100 }, { color: '#ff0000', position: 0 }]),
    ['#ff0000', '#ff0000', '#0000ff'],
    'two stops: sorted, and the start stands in for the middle',
  );
  assert.deepEqual(
    stopsToColours([
      { color: '#ff0000', position: 0 }, { color: '#00ff00', position: 20 },
      { color: '#ffff00', position: 55 }, { color: '#0000ff', position: 100 },
    ]),
    ['#ff0000', '#ffff00', '#0000ff'],
    'the inner stop nearest 50 is the middle',
  );
  assert.deepEqual(
    stopsToColours([{ color: 'rgb(1,2,3)', position: 0 }, { color: '#ABCDEF', position: 50 }, { color: '#000000', position: 100 }]),
    ['#abcdef', '#abcdef', '#000000'],
    'a stop that is not six-digit hex is dropped, not guessed',
  );
});

test('the stylesheet carries a hook for every knob the sheet drives', () => {
  const css = read('../../dist-app/yomu-tags.css');
  for (const hook of ['data-yl-fill', 'data-yl-frost', 'data-yl-blur', 'data-yl-lift', 'data-yl-shade', 'data-ytg=custom']) {
    assert.ok(css.includes(hook), hook);
  }
  for (const p of PRESETS) assert.ok(css.includes('[data-ytg=' + p + ']'), p + ' is a preset the sheet offers');
  /* The footer's bottom row: Hot at the left, the rating at the right. */
  assert.ok(/grid-template-areas:[^;]*'hot rating'/.test(css), 'the grid tile footer ends in a hot/rating row');
  assert.ok(/\.yr-card__art\s*>\s*\.yr-card__rating/.test(css), 'the rail card rating sits over the art');
});

test('the canonical card puts its rating into the art, and the shell fills search from the URL', () => {
  /* The rail no longer builds its own card -- yomu-titlecard.js draws every
     title Yomu renders outside the bundle -- so this is asserted where the
     rating is actually appended. The rail card still carries the `.yr-card*`
     aliases the customizer and the chip layer address. */
  const card = read('../../dist-app/yomu-titlecard.js');
  assert.ok(card.includes('art.append(rating)'), 'rating into the card art');
  assert.ok(card.includes("'yr-card__rating'"), 'and keeps the rail alias the theme layers target');
  const rails = read('../../dist-app/yomu-rails.js');
  assert.ok(/YomuTitleCard\.create/.test(rails), 'the rail uses the canonical renderer');
  const shell = read('../../dist-app/yomu-shell.js');
  assert.ok(shell.includes('function prefillSearch()'), 'prefill exists');
  assert.ok(/prefillSearch\(\);/.test(shell), 'and runs in the pass');
  assert.ok(shell.includes("'/more?kind=author&id='"), 'the author arrow goes to /more');
  assert.ok(shell.includes("'/more?kind=alike&id='"), 'the similar arrow goes to /more');
  const mori = read('../../dist-app/yomu-mori.js');
  assert.ok(mori.includes('Customize look'), "Mori's menu opens the sheet");
  assert.ok(mori.includes('toggleMode'), "Mori's menu flips the mode");
});
