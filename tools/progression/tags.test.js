import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { WEAR } = await import('../../dist-app/yomu-tags.js');

test('every tag in the spec has a chip to wear, and the vendored CSS is prefixed', () => {
  for (const kind of ['fresh', 'updated', 'completed', 'progress', 'circle', 'rating', 'hot', 'trending', 'gem', 'new']) {
    assert.ok(WEAR[kind]?.palette && WEAR[kind]?.icon, kind);
  }
  const css = fs.readFileSync(new URL('../../dist-app/yomu-tags.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\.yb\b/.test(css), 'no bare .yb left to collide with the badge renderer');
  assert.ok(!/--yb-/.test(css), 'tokens are renamed too');
  for (const p of ['aurora', 'sunset', 'ocean', 'ember', 'matcha', 'sakura', 'ink']) assert.ok(css.includes('[data-ytg=' + p + ']'), p);
  const js = fs.readFileSync(new URL('../../dist-app/yomu-tags.js', import.meta.url), 'utf8');
  for (const i of ['spark', 'bolt', 'check', 'book', 'users', 'fire', 'star']) assert.ok(js.includes('id="ytg-i-' + i + '"'), i + ' icon in sprite');
});
