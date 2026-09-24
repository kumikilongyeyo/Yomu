/**
 * The fast lane's time budgets (dist-app/yomu-performance.js).
 *
 * 4.2s is right for one source's list and wrong for the chapter ledger, which
 * asks every provider at once: on 2026-09-24 a cold Solo Leveling ledger took
 * 4,202ms in the browser, was cut off at the budget, and the series page lost
 * its chips, gaps and "these sources have it" offer. This loads the real file
 * into a fake window whose network answers after a chosen delay.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../../dist-app/yomu-performance.js', import.meta.url), 'utf8');

function boot(delayMs) {
  const store = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  };
  const slowFetch = (input, init = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response('{"rows":[]}', { status: 200, headers: { 'content-type': 'application/json' } })), delayMs);
    init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
  });
  const window = {
    fetch: slowFetch,
    location: new URL('https://yomu.test/series/x?source=mangadex'),
    localStorage: store(),
    sessionStorage: store(),
    navigator: {},
    // Parked in "loading" so the prefetch half never starts: only the fetch
    // wrapper is under test.
    document: { readyState: 'loading' },
    addEventListener() {},
    setTimeout, clearTimeout, AbortController, DOMException, Response, Request, URL, Promise, JSON, Date, Map, Set, Number, String, Object, Array, Math,
  };
  window.window = window;
  vm.createContext(window);
  vm.runInContext(SOURCE, window);
  return window;
}

test('the chapter ledger may take longer than one source list', async () => {
  const win = boot(5_000);
  const response = await win.fetch('/api/catalog/chapters?title=Solo+Leveling&prefer=mangadex');
  assert.equal(response.status, 200, 'a 5s ledger answer arrives instead of being aborted at 4.2s');
});

test('a single source list is still cut off at the budget', async () => {
  const win = boot(5_000);
  await assert.rejects(
    () => win.fetch('/api/ext/source/weebcentral/latest?page=1'),
    (error) => /budget exceeded/i.test(String(error?.message ?? error)),
  );
});
