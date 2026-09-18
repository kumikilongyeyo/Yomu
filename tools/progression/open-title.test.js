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
const { appSourceId, pick, match, href } = await import('../../dist-app/yomu-open-title.js');

const provider = (id, seriesId, name) => ({ id, seriesId, name: name || id, kind: 'extension' });

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
  const blind = new Set(['yomuext-comick']);
  const found = pick(entry, new Set(['mangadex', 'yomuext-comick']), blind);
  assert.equal(found.sourceId, 'mangadex', 'the readable one wins even though Comick ranked first');
  assert.equal(found.seriesId, 'm1');

  const only = { providers: [provider('ext:comick', 'c1')] };
  assert.equal(pick(only, new Set(['yomuext-comick']), blind), null,
    'a title nothing readable carries resolves to nothing, rather than to a 502');
});

test('a source this device has enabled beats one it has not', () => {
  const entry = { providers: [provider('ext:asura', 'a1'), provider('mangadex', 'm1')] };
  assert.equal(pick(entry, new Set(['mangadex']), new Set()).sourceId, 'mangadex');
  assert.equal(pick(entry, new Set(['mangadex', 'yomuext-asura']), new Set()).sourceId, 'yomuext-asura',
    'with both enabled the catalog order stands');
});

test('nothing to open is null, not a guess', () => {
  assert.equal(pick(null, new Set(), new Set()), null);
  assert.equal(pick({}, new Set(), new Set()), null);
  assert.equal(pick({ providers: [] }, new Set(), new Set()), null);
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
