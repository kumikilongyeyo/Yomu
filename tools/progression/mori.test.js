/**
 * The tap menu and the chat endpoint's guards.
 *
 * The model call itself is not tested here: it costs money, needs a key this
 * repository does not have, and a test that silently skips when the key is
 * absent is worse than no test. What is tested is everything that decides
 * *whether* to make that call, which is the part that can go wrong quietly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const RESUME = 'yomu.v1.resume.local-account.';
const MORI_TS = fs.readFileSync(new URL('../../worker/mori.ts', import.meta.url), 'utf8');

/* --- the worker's guards -------------------------------------------------- *
 *
 * mori.ts is a Cloudflare Worker module with an SDK import, so it is read as
 * source rather than executed. These assert the constants that bound the
 * bill -- the kind of value that gets "temporarily" raised and left. */

test('the endpoint is off without a key', () => {
  assert.match(MORI_TS, /if \(!env\.ANTHROPIC_API_KEY\)/, 'chat checks for the key');
  assert.match(MORI_TS, /configured: !!env\.ANTHROPIC_API_KEY/, 'status reports it');
  assert.ok(!/ANTHROPIC_API_KEY\s*=\s*['"]sk-/.test(MORI_TS), 'no key is hardcoded');
});

test('the key never reaches the client', () => {
  /* The catch block returns fixed strings. An `error.message` passed through
     to the caller is how an upstream 401 becomes a public stack trace. */
  const catchBlock = MORI_TS.slice(MORI_TS.indexOf('} catch (error: any) {'));
  assert.ok(!/json\(\{[^}]*error:\s*(?:String\()?error/.test(catchBlock),
    'the upstream error object is not returned to the caller');
  assert.match(catchBlock, /console\.error/, 'it is logged server-side instead');
});

test('the model is pinned in code, not taken from the request', () => {
  assert.match(MORI_TS, /const MODEL = 'claude-opus-5'/);
  /* A public endpoint that lets the caller name a model lets them name an
     expensive one. */
  assert.ok(!/body\??\.\s*model/.test(MORI_TS), 'the request body cannot pick the model');
});

test('the spend ceilings are present and sane', () => {
  const perDay = Number(/REPLIES_PER_DAY = (\d+)/.exec(MORI_TS)?.[1]);
  const perHour = Number(/REPLIES_PER_IP_PER_HOUR = (\d+)/.exec(MORI_TS)?.[1]);
  const maxTokens = Number(/MAX_TOKENS = (\d+)/.exec(MORI_TS)?.[1]);
  const maxChars = Number(/MAX_MESSAGE_CHARS = (\d+)/.exec(MORI_TS)?.[1]);

  assert.ok(perDay > 0 && perDay <= 2000, 'a global daily cap exists: ' + perDay);
  assert.ok(perHour > 0 && perHour < perDay, 'per-IP is tighter than the day');
  assert.ok(maxTokens <= 4096, 'replies are bounded: ' + maxTokens);
  assert.ok(maxChars <= 2000, 'requests are bounded: ' + maxChars);

  /* KV's free tier is 1,000 writes a day and Sync shares it. Two writes per
     reply is the cost of the two counters. */
  assert.ok(perDay * 2 < 1000, 'the daily cap fits inside the KV write budget');
});

test('history and context from the client are rebuilt, not trusted', () => {
  assert.match(MORI_TS, /MAX_HISTORY_TURNS/, 'history is truncated');
  assert.match(MORI_TS, /t\.role === 'user' \|\| t\.role === 'assistant'/, 'roles are filtered');
  assert.match(MORI_TS, /typeof t\.content === 'string'/, 'content is type-checked');
});

test('the tool is strict and answers from the catalogue', () => {
  assert.match(MORI_TS, /strict: true/, 'tool arguments are schema-validated');
  /* Through the recommendation engine, which is cached and vote-weighted --
     not the model's memory, and not the old tag-overlap route. */
  assert.match(MORI_TS, /handleSimilar\(/, 'find_similar reads Yomu\'s own catalogue');
  assert.match(MORI_TS, /additionalProperties: false/);
});

test('the system prompt forbids inventing titles and leaking spoilers', () => {
  const system = /const SYSTEM = `([\s\S]*?)`;/.exec(MORI_TS)?.[1] ?? '';
  assert.ok(system.length > 200, 'there is a system prompt');
  assert.match(system, /Do not recommend a title from memory/i);
  assert.match(system, /spoiler/i);
  assert.match(system, /not a general assistant/i);
});

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
