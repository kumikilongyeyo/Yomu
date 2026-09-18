/**
 * Which sidebar item is lit.
 *
 * The audit's U2 gate: "no dead ends; active state is unambiguous." Two things
 * were wrong. `/discover` -- the route the app's own dock navigates to -- was
 * not in the mapping at all, because the sidebar spells that destination
 * `/find.html`, so Home stayed lit on the Discover screen. And the mapping was
 * evaluated once when the sidebar was built and never again, so any
 * client-side navigation left the previous screen lit.
 *
 * `activeHref` is a pure function inside a large IIFE. It is lifted out of the
 * shipped source here rather than copied, so the test cannot pass against a
 * version of the rule that is no longer the one running.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SHELL = fs.readFileSync(new URL('../../dist-app/yomu-shell.js', import.meta.url), 'utf8');

/** The real `activeHref`, lifted out of the shell. */
const activeHref = (() => {
  const start = SHELL.indexOf('function activeHref(pathname) {');
  assert.ok(start > 0, 'activeHref must still exist in yomu-shell.js');
  const end = SHELL.indexOf('\n  }', start) + 4;
  // eslint-disable-next-line no-new-func
  return new Function(`${SHELL.slice(start, end)}; return activeHref;`)();
})();

test('every Discover destination lights Discover, whichever way it is spelled', () => {
  /* The bug: /discover is the React route, /find.html is the sidebar's href,
     and they are the same place. */
  for (const path of ['/discover', '/find', '/find.html', '/search', '/search?q=x', '/more', '/adult']) {
    assert.equal(activeHref(path), '/find.html', path);
  }
});

test('the other sections map to themselves', () => {
  for (const [path, item] of [
    ['/library', '/library'],
    ['/downloads', '/library'],
    ['/you', '/you'],
    ['/settings', '/settings'],
    ['/sources', '/settings'],
    ['/extensions', '/settings'],
    ['/suwayomi-setup', '/settings'],
  ]) {
    assert.equal(activeHref(path), item, path);
  }
});

test('the reader and a series sit under Home, because that is where you came from', () => {
  assert.equal(activeHref('/'), '/');
  assert.equal(activeHref('/read/abc'), '/');
  assert.equal(activeHref('/series/abc'), '/');
  assert.equal(activeHref('/anything-unmapped'), '/', 'an unknown route is Home, not nothing');
});

test('a Discover prefix cannot be swallowed by a shorter match', () => {
  /* Guards the ordering: /downloads starts with neither /find nor /discover,
     but a careless `startsWith('/d')` would take it. */
  assert.equal(activeHref('/downloads'), '/library');
  assert.equal(activeHref('/discover'), '/find.html');
});

test('the lit item is re-asserted after a client-side navigation', () => {
  assert.match(SHELL, /function markActive\(\)/);
  assert.match(SHELL, /const pass = \(\) => \{\s*\n\s*brandLockup\(\);\s*\n\s*markActive\(\);/,
    'markActive must run on every pass, not only when the sidebar is built');
});

test('markActive writes only when something changed', () => {
  /* It runs from pass(), which a document-wide MutationObserver schedules.
     An unconditional attribute write there is a mutation that schedules the
     next pass -- the microtask loop that took /sources down once already. */
  const start = SHELL.indexOf('function markActive() {');
  const body = SHELL.slice(start, SHELL.indexOf('\n  }', start));
  assert.match(body, /if \(link\.classList\.contains\('is-active'\) !== active\)/);
  assert.match(body, /if \(link\.getAttribute\('aria-current'\) !== 'page'\)/);
  assert.match(body, /else if \(link\.hasAttribute\('aria-current'\)\)/);
});
