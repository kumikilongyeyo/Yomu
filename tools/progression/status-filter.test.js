/**
 * Discovery's status axis: "completed manhwa" as one question.
 *
 * Completed used to be a fifth *type*, so it could not be combined with
 * Manhwa, and there was no Ongoing at all. The engine now takes the pair as
 * one type ("manhwa:completed"); the bare "completed" still works.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadEngine() {
  const store = new Map();
  const window = {
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    location: { pathname: '/', origin: 'https://yomu.test', href: 'https://yomu.test/' },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    setTimeout, clearTimeout, console, URL, URLSearchParams, AbortController,
  };
  window.window = window;
  window.document = { addEventListener() {}, readyState: 'complete', visibilityState: 'visible' };
  const context = vm.createContext(window);
  vm.runInContext(fs.readFileSync(new URL('../../dist-app/yomu-library-engine.js', import.meta.url), 'utf8'), context);
  return window.YomuLibraryEngine;
}

const { matches } = loadEngine();
const row = (category, status) => ({ title: 'x', category, status, genres: [] });

test('a category alone ignores status', () => {
  assert.equal(matches(row('manhwa', 'Ongoing'), 'manhwa', ''), true);
  assert.equal(matches(row('manga', 'Ongoing'), 'manhwa', ''), false);
});

test('completed manhwa is one question', () => {
  assert.equal(matches(row('manhwa', 'Completed'), 'manhwa:completed', ''), true);
  assert.equal(matches(row('manhwa', 'Ongoing'), 'manhwa:completed', ''), false);
  assert.equal(matches(row('manga', 'Completed'), 'manhwa:completed', ''), false);
});

test('ongoing is its own filter, and accepts the words sources use', () => {
  for (const s of ['Ongoing', 'RELEASING', 'Publishing', 'serialization']) {
    assert.equal(matches(row('manhwa', s), 'all:ongoing', ''), true, s);
  }
  assert.equal(matches(row('manhwa', 'Completed'), 'all:ongoing', ''), false);
  assert.equal(matches(row('manhwa', 'Hiatus'), 'all:ongoing', ''), false, 'on hiatus is not ongoing');
  assert.equal(matches(row('manhwa', ''), 'all:ongoing', ''), false, 'unknown status is not claimed either way');
});

test('the bare "completed" from before the status axis still works', () => {
  assert.equal(matches(row('manga', 'Finished'), 'completed', ''), true);
  assert.equal(matches(row('manga', 'Ongoing'), 'completed', ''), false);
});
