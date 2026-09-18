/**
 * Customize Look v2: the pure half.
 *
 * Whatever is stored has to read back as a look with every knob valid --
 * including a look stored by the build that only knew nine of them -- and the
 * preset label has to be derived from the values rather than trusted, so a
 * look that is Ember says Ember and a look that has been edited says Custom.
 * The sheet itself is DOM and is checked in the browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
const { DEFAULTS, CHOICES, NUMBERS, PRESETS, normalize, presetOf, matches } =
  await import('../../dist-app/yomu-controls.js');

test('anything stored normalizes to a valid look', () => {
  for (const raw of [null, undefined, {}, 'garbage', 42, []]) {
    const look = normalize(raw);
    for (const name of Object.keys(CHOICES)) {
      assert.ok(CHOICES[name].some(([id]) => id === look[name]), `${name} is one of its choices`);
    }
    for (const [name, [lo, hi]] of Object.entries(NUMBERS)) {
      assert.ok(look[name] >= lo && look[name] <= hi, `${name} is inside ${lo}..${hi}`);
    }
  }
});

test('out-of-range numbers are clamped and snapped to their step', () => {
  const look = normalize({ buttonBlur: 999, ctaAngle: -40, tileClamp: 9, buttonWeight: 'heavy', surfaceOpacity: 0 });
  assert.equal(look.buttonBlur, 20);
  assert.equal(look.ctaAngle, 0);
  assert.equal(look.tileClamp, 3);
  assert.equal(look.buttonWeight, DEFAULTS.buttonWeight, 'a non-number falls back');
  assert.equal(look.surfaceOpacity, 40);

  assert.equal(normalize({ buttonWeight: 673 }).buttonWeight, 700, 'snapped to the hundred it steps in');
  assert.equal(normalize({ ctaAngle: 117 }).ctaAngle, 115);
});

test('an unknown choice falls back rather than being kept or dropped', () => {
  const look = normalize({ buttonTone: 'chartreuse', ctaFinish: 'hologram', tileShape: 'round' });
  assert.equal(look.buttonTone, DEFAULTS.buttonTone);
  assert.equal(look.ctaFinish, DEFAULTS.ctaFinish);
  assert.equal(look.tileShape, 'round', 'a valid one is kept');
});

test('the shipped defaults are Yomu Core, so an untouched panel does not open saying Custom', () => {
  assert.equal(presetOf(normalize({})), 'core');
});

test('every preset round-trips to its own name', () => {
  for (const preset of PRESETS) {
    const look = normalize({ ...DEFAULTS, ...preset.patch });
    assert.equal(presetOf(look), preset.id, `${preset.id} is recognised as itself`);
    assert.equal(matches(look, preset), true);
  }
});

test('one knob off a preset is Custom, and putting it back is the preset again', () => {
  const ember = PRESETS.find((p) => p.id === 'ember');
  const look = normalize({ ...DEFAULTS, ...ember.patch });
  assert.equal(presetOf(look), 'ember');

  const edited = normalize({ ...look, ctaAngle: 40 });
  assert.equal(presetOf(edited), 'custom', 'the label follows the values');

  const undone = normalize({ ...edited, ctaAngle: ember.patch.ctaAngle });
  assert.equal(presetOf(undone), 'ember', 'and comes back when the values do');
});

test('a look stored by the build that knew nine knobs still reads back as that look', () => {
  /* The first version wrote exactly these keys and nothing else. */
  const old = {
    siteGradient: 'ember', tileShape: 'round', tileTone: 'warm',
    buttonShape: 'pill', buttonTone: 'jade', buttonFinish: 'glass',
    ctaShape: 'round', ctaTone: 'ocean', ctaFinish: 'solid',
  };
  const look = normalize(old);
  for (const [key, value] of Object.entries(old)) {
    assert.equal(look[key], value, `${key} survives the migration`);
  }
  for (const [name, [, , , , fallback]] of Object.entries(NUMBERS)) {
    assert.equal(look[name], fallback, `${name} takes its default, which is what that build rendered`);
  }
  assert.equal(presetOf(look), 'custom', 'and it is honestly not one of the five');
});

test('a preset names a token for every knob a preview shows, or a switch leaves the old look behind', () => {
  /* Applying a preset has to be atomic in the sense that matters: nothing
     visible may survive from the look before it. Any knob one preset names
     must be named by all of them, or switching Ember -> Ink would keep
     Ember's value for it forever. */
  const named = PRESETS.map((p) => new Set(Object.keys(p.patch)));
  const all = new Set(named.flatMap((s) => [...s]));
  for (const [i, set] of named.entries()) {
    const missing = [...all].filter((k) => !set.has(k));
    assert.deepEqual(missing, [], `${PRESETS[i].id} names every token the others do`);
  }
});

test('presets are five, each with a name, a hint and two swatch colours', () => {
  assert.equal(PRESETS.length, 5);
  assert.deepEqual(PRESETS.map((p) => p.id), ['core', 'ember', 'aurora', 'ink', 'paper']);
  for (const p of PRESETS) {
    assert.ok(p.name && p.hint, `${p.id} is labelled`);
    assert.equal(p.swatch.length, 2);
    for (const hex of p.swatch) assert.match(hex, /^#[0-9a-f]{6}$/i);
    assert.equal('mode' in p.patch, false, `${p.id} does not flip the reader's mode behind their back`);
    assert.equal('skin' in p.patch, false, `${p.id} does not take an earned skin off`);
  }
});
