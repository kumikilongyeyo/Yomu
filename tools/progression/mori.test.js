/**
 * The tap menu.
 *
 * The chat panel and its Worker endpoint are gone, along with the guards that
 * bounded their bill -- there is no paid call left in Yomu to bound. What is
 * left is the part that has to be right for the menu to be worth tapping:
 * which series "Keep reading" resumes, and what Suggest recommends from.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const RESUME = 'yomu.v1.resume.local-account.';
/* --- the client ----------------------------------------------------------- */

/** Storage must be a Proxy so `Object.keys` enumerates entries, as in a browser. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  const methods = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => [...map.keys()][i],
  };
  return new Proxy(methods, {
    get: (t, p) => (p in t ? t[p] : p === 'length' ? map.size : (typeof p === 'string' && map.has(p) ? map.get(p) : undefined)),
    has: (t, p) => p in t || map.has(p),
    ownKeys: () => [...map.keys()],
    getOwnPropertyDescriptor: (t, p) =>
      map.has(p) ? { value: map.get(p), enumerable: true, configurable: true, writable: true } : undefined,
  });
}

const SOURCE = fs.readFileSync(new URL('../../dist-app/yomu-mori.js', import.meta.url), 'utf8');

/** Load the client with a given storage and no DOM, and take its exports. */
function load(storage) {
  const context = { localStorage: storage, console, setTimeout, module: { exports: {} } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return context.module.exports;
}

const shelf = (library) => ({
  'yomu.v1.collection': JSON.stringify({ library, sources: [] }),
});

test('the most-read series is the one to recommend from', () => {
  const store = fakeStorage({
    ...shelf([{ id: 'a', title: 'Solo Leveling' }, { id: 'b', title: 'Omniscient Reader' }]),
    [RESUME + 'a.read']: JSON.stringify(Array.from({ length: 30 }, (_, i) => 'c' + i)),
    [RESUME + 'b.read']: JSON.stringify(['c1', 'c2']),
  });
  const { mostRead } = load(store);
  assert.equal(mostRead().title, 'Solo Leveling');
  assert.equal(mostRead().count, 30);
});

test('a nameable runner-up beats an anonymous leader', () => {
  /* You can read a great deal of something without ever saving it. Taking the
     highest count outright returns a bare id, and every caller needs a title
     -- which is exactly how the menu lost its "Keep reading" row. */
  const store = fakeStorage({
    ...shelf([{ id: 'saved', title: 'Omniscient Reader' }]),
    [RESUME + 'ext-a:never-saved.read']: JSON.stringify(Array.from({ length: 99 }, (_, i) => 'c' + i)),
    [RESUME + 'saved.read']: JSON.stringify(['c1', 'c2']),
  });
  const { mostRead } = load(store);
  assert.equal(mostRead().title, 'Omniscient Reader');
});

test('an unnameable leader is still returned rather than nothing', () => {
  const store = fakeStorage({
    ...shelf([]),
    [RESUME + 'ext-a:never-saved.read']: JSON.stringify(['c1', 'c2']),
  });
  const { mostRead } = load(store);
  assert.equal(mostRead().seriesId, 'ext-a:never-saved');
  assert.equal(mostRead().title, '');
});

test('nothing read means nothing to suggest from', () => {
  const { mostRead, seedTitle } = load(fakeStorage(shelf([])));
  assert.equal(mostRead(), null);
  assert.equal(seedTitle(), '');
});

test('an empty read list does not count as reading', () => {
  const store = fakeStorage({
    ...shelf([{ id: 'a', title: 'Solo Leveling' }]),
    [RESUME + 'a.read']: JSON.stringify([]),
  });
  assert.equal(load(store).mostRead(), null);
});

test('a hidden title is not on the shelf', () => {
  const store = fakeStorage(shelf([{ id: 'a', title: 'Solo Leveling', hidden: true }]));
  assert.equal(load(store).library().length, 0);
  assert.equal(load(store).seedTitle(), '');
});

test('the seed falls back to the shelf when nothing is read', () => {
  const store = fakeStorage(shelf([{ id: 'a', title: 'Solo Leveling' }]));
  assert.equal(load(store).seedTitle(), 'Solo Leveling');
});

test('corrupt storage does not throw', () => {
  const store = fakeStorage({
    'yomu.v1.collection': '{not json',
    [RESUME + 'a.read']: 'also not json',
  });
  const { mostRead, library } = load(store);
  assert.equal(mostRead(), null);
  assert.deepEqual([...library()], []);
});
