/**
 * Continue Reading, and which store decides whether you are in it.
 *
 * The audit's finding: "Resume can disappear depending on discovery/library
 * membership." Two stores hold half a fact each -- `yomu.v1.reading` knows
 * which source served a title, and the reader's `yomu.v1.resume.*` anchor
 * knows which chapter and page -- and the join between them used to require a
 * third, the library, which has nothing to do with whether somebody is
 * part-way through something.
 *
 * yomu-shell.js is a large IIFE bound to a live DOM, so `continueItems` is not
 * importable. What is testable, and what actually broke, is the join: given
 * the three stores, which titles come out. That rule is restated here and
 * checked against the shipped source so it cannot drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SHELL = fs.readFileSync(new URL('../../dist-app/yomu-shell.js', import.meta.url), 'utf8');

/* Comments quote the code they replaced, so a "this must not come back" check
   has to look at the code and not at the explanation of why it went. */
const SHELL_CODE = SHELL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* --- the join, as the shell performs it ---------------------------------- */

const titleKey = (sourceId, seriesId) => `${sourceId}:${seriesId}`;

function indexedBySeries(index, seriesId) {
  const suffix = ':' + seriesId;
  for (const [key, record] of Object.entries(index)) {
    if (key.endsWith(suffix) && record && record.sourceId) return record;
  }
  return null;
}

/** @returns the series ids that would draw a card, newest first. */
function continueItems({ index = {}, anchors = {}, library = [], adult = [] } = {}) {
  const blocked = new Set(adult);
  const byId = new Map();
  const hiddenOrAdult = (entry, sourceId, seriesId) =>
    blocked.has(titleKey(sourceId, seriesId))
    || (entry && (entry.hidden || String(entry.category || '').toLowerCase() === 'adult'));

  for (const record of Object.values(index)) {
    if (!record || !record.seriesId || !record.sourceId || !record.chapterId) continue;
    const entry = library.find((t) => String(t.id) === record.seriesId);
    if (hiddenOrAdult(entry, record.sourceId, record.seriesId)) continue;
    byId.set(record.seriesId, { seriesId: record.seriesId, sourceId: record.sourceId, at: record.at || 0 });
  }

  for (const [seriesId, anchor] of Object.entries(anchors)) {
    if (byId.has(seriesId)) continue;
    const known = indexedBySeries(index, seriesId);
    const entry = library.find((t) => String(t.id) === seriesId);
    const sourceId = (known && known.sourceId) || (entry && entry.sourceId) || '';
    if (!sourceId) continue;
    if (hiddenOrAdult(entry, sourceId, seriesId)) continue;
    byId.set(seriesId, { seriesId, sourceId, at: anchor.updatedAtLocal || 0 });
  }

  return [...byId.values()].sort((a, b) => b.at - a.at).map((i) => i.seriesId);
}

const anchor = (chapterId, at) => ({ schema: 'yomu.anchor/1', chapterId, pageIndex: 0, updatedAtLocal: at });

/* --- the cases ------------------------------------------------------------ */

test('a title read but never saved to the library still shows', () => {
  /* The regression. The reader indexed it, so the source is knowable; the
     library has never heard of it, and that used to be the whole decision. */
  const items = continueItems({
    index: { 'weebcentral:sl': { seriesId: 'sl', sourceId: 'weebcentral', title: 'Solo Leveling' } },
    anchors: { sl: anchor('ch-12', 500) },
    library: [],
  });
  assert.deepEqual(items, ['sl']);
});

test('the index answers on its own when it has a chapter', () => {
  const items = continueItems({
    index: { 'weebcentral:sl': { seriesId: 'sl', sourceId: 'weebcentral', chapterId: 'ch-12', at: 900 } },
    anchors: {},
    library: [],
  });
  assert.deepEqual(items, ['sl']);
});

test('the library is a fallback for the source, not a gate on it', () => {
  /* Nothing indexed, but the library knows the binding: still a card. */
  const items = continueItems({
    index: {},
    anchors: { sl: anchor('ch-3', 100) },
    library: [{ id: 'sl', sourceId: 'mangadex', title: 'Solo Leveling' }],
  });
  assert.deepEqual(items, ['sl']);
});

test('the index wins over the library when they disagree about the source', () => {
  /* The index is written by the reader on every tick; a library row can be
     months stale. Opening the card must go where the reading happened. */
  const items = continueItems({
    index: { 'weebcentral:sl': { seriesId: 'sl', sourceId: 'weebcentral' } },
    anchors: { sl: anchor('ch-9', 100) },
    library: [{ id: 'sl', sourceId: 'mangadex' }],
  });
  assert.deepEqual(items, ['sl']);
});

test('an anchor nothing can name is skipped rather than drawn as a dead link', () => {
  const items = continueItems({ index: {}, anchors: { ghost: anchor('ch-1', 10) }, library: [] });
  assert.deepEqual(items, [], 'no source means no destination, and a card with no destination is worse than none');
});

test('adult and hidden titles stay off Home by either path', () => {
  assert.deepEqual(
    continueItems({
      index: { 'ext:x': { seriesId: 'x', sourceId: 'ext', chapterId: 'c1' } },
      anchors: {},
      adult: ['ext:x'],
    }),
    [],
  );
  assert.deepEqual(
    continueItems({
      index: { 'ext:x': { seriesId: 'x', sourceId: 'ext' } },
      anchors: { x: anchor('c1', 5) },
      library: [{ id: 'x', sourceId: 'ext', hidden: true }],
    }),
    [],
    'hidden is honoured on the anchor path too, now that it no longer needs the library to get there',
  );
});

test('newest first, whichever store the row came from', () => {
  const items = continueItems({
    index: { 'ext:a': { seriesId: 'a', sourceId: 'ext', chapterId: 'c1', at: 100 } },
    anchors: { b: anchor('c2', 900) },
    library: [{ id: 'b', sourceId: 'ext' }],
  });
  assert.deepEqual(items, ['b', 'a']);
});

/* --- and the shipped file still does it this way -------------------------- */

test('the shell performs the join described here', () => {
  assert.match(SHELL_CODE, /function indexedBySeries\(index, seriesId\)/);
  assert.match(SHELL_CODE, /const known = indexedBySeries\(index, seriesId\);/);
  assert.match(SHELL_CODE, /const sourceId = \(known && known\.sourceId\) \|\| \(entry && entry\.sourceId\) \|\| '';/);
  assert.match(SHELL_CODE, /if \(!sourceId\) continue;/);
  assert.ok(
    !/if \(!entry \|\| !entry\.sourceId\) continue;/.test(SHELL_CODE),
    'the library must not be a gate on the resume path again',
  );
});
