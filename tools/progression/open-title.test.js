/**
 * Where a title click goes.
 *
 * One rule decides it everywhere now, and these are the parts of it that can
 * be decided without a network: the two id vocabularies, which provider of a
 * title to open, and which of a search's answers is the title that was
 * clicked. The fetch itself is exercised in the browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
const { appSourceId, pick, match, href, BAKED_BLIND, NATIVE_READABLE } =
  await import('../../dist-app/yomu-open-title.js');

const provider = (id, seriesId, name) => ({ id, seriesId, name: name || id, kind: 'extension' });
/** The capability snapshot shape the router hands to pick(). */
const caps = (blind, readable) => ({ blind: new Set(blind || []), readable: new Set(readable || []) });

test('the catalog names a provider one way and the app addresses it another', () => {
  assert.equal(appSourceId('mangadex'), 'mangadex', 'a native source is spelled the same');
  assert.equal(appSourceId('ext:weebcentral'), 'yomuext-weebcentral');
  assert.equal(appSourceId('suwayomi:14'), 'mihon-14');
  assert.equal(appSourceId(''), '');
  assert.equal(appSourceId(undefined), '');
});

test('the destination is always the Yomu series screen', () => {
  assert.equal(href('abc', 'mangadex'), '/series/abc?source=mangadex');
  assert.equal(href('a b/c', 'ext one'), '/series/a%20b%2Fc?source=ext%20one', 'both halves are encoded');
});

test('a source that cannot serve pages is never where a click lands', () => {
  const entry = { providers: [provider('ext:comick', 'c1'), provider('mangadex', 'm1')] };
  const known = caps(['yomuext-comick'], ['mangadex']);
  const found = pick(entry, new Set(['mangadex', 'yomuext-comick']), known);
  assert.equal(found.sourceId, 'mangadex', 'the readable one wins even though Comick ranked first');
  assert.equal(found.seriesId, 'm1');

  const only = { providers: [provider('ext:comick', 'c1')] };
  assert.equal(pick(only, new Set(['yomuext-comick']), known), null,
    'a title nothing readable carries resolves to nothing, rather than to a 502');
});

test('a source this device has enabled beats one it has not, within its tier', () => {
  const entry = { providers: [provider('ext:asura', 'a1'), provider('mangadex', 'm1')] };
  const unknown = caps([], []);
  assert.equal(pick(entry, new Set(['mangadex']), unknown).sourceId, 'mangadex');
  assert.equal(pick(entry, new Set(['mangadex', 'yomuext-asura']), unknown).sourceId, 'yomuext-asura',
    'with both enabled and neither vouched for, the catalog order stands');
});

test('known readable outranks unknown, and enablement cannot promote across that line', () => {
  /* The reader can add a source. They cannot make a metadata mirror serve
     pages, so an enabled-but-unvouched-for source must not beat a
     known-readable one they have not enabled. */
  const entry = { providers: [provider('ext:mystery', 'x1'), provider('ext:asura', 'a1')] };
  const known = caps([], ['yomuext-asura']);
  const found = pick(entry, new Set(['yomuext-mystery']), known);
  assert.equal(found.sourceId, 'yomuext-asura');
});

test('an unknown source is still openable when nothing better carries the title', () => {
  /* Failing closed must not mean failing useless: with no capability data at
     all, the catalog's own best answer is still offered. */
  const entry = { providers: [provider('ext:mystery', 'x1')] };
  const found = pick(entry, new Set(), caps([], []));
  assert.equal(found.sourceId, 'yomuext-mystery');
});

test('the baked table stands in when nothing else is known', () => {
  /* This is the offline case the fail-closed change exists for: no live call,
     no cache, and Comick must still not be a destination. */
  assert.ok(BAKED_BLIND.includes('yomuext-comick'));
  assert.ok(NATIVE_READABLE.includes('mangadex'));
  const entry = { providers: [provider('ext:comick', 'c1')] };
  const baked = caps(BAKED_BLIND, NATIVE_READABLE);
  assert.equal(pick(entry, new Set(['yomuext-comick']), baked), null);

  const withNative = { providers: [provider('ext:comick', 'c1'), provider('mangadex', 'm1')] };
  assert.equal(pick(withNative, new Set(), baked).sourceId, 'mangadex');
});

test('nothing to open is null, not a guess', () => {
  assert.equal(pick(null, new Set(), caps()), null);
  assert.equal(pick({}, new Set(), caps()), null);
  assert.equal(pick({ providers: [] }, new Set(), caps()), null);
  assert.equal(pick({ providers: [provider('ext:a', 'a1')] }, new Set(), null).sourceId, 'yomuext-a',
    'a missing capability snapshot is treated as unknown, not as blind');
});

test('an AniList id on both sides settles which result is the clicked title', () => {
  const rows = [
    { title: 'Solo Leveling: Ragnarok', anilistId: 177895 },
    { title: 'Solo Leveling', anilistId: 105398 },
  ];
  assert.equal(match(rows, { title: 'Solo Leveling', anilistId: 105398 }).anilistId, 105398,
    'the id beats the catalog order');
  assert.equal(match(rows, { title: 'Solo Leveling' }).title, 'Solo Leveling',
    'without an id, an exact name still beats the order');
  assert.equal(match(rows, { title: 'something else' }).title, 'Solo Leveling: Ragnarok',
    'and with neither, the catalog has already ranked by relevance');
  assert.equal(match([], { title: 'x' }), null);
  assert.equal(match(null, { title: 'x' }), null);
});
