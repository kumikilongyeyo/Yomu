/**
 * The social update's arithmetic: what a tick says, what the strip is made
 * of, what a shelf accepts, and what goes on one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const { countsOf, tickText, summary } = await import('../../dist-app/yomu-race.js');
const { heatFrom } = await import('../../dist-app/yomu-heat.js');
const { itemsFrom } = await import('../../dist-app/yomu-shelfshare.js');

const shelf = (() => {
  let js = stripTypeScriptTypes(fs.readFileSync(new URL('../../worker/shelf.ts', import.meta.url), 'utf8'));
  js = js.replace(/^export (async function|function|const|let)/gm, '$1');
  js += '\nreturn { sanitiseItems, sanitiseName, publicShelf, MAX_ITEMS };';
  return new Function(js)();
})();

/* --- race ------------------------------------------------------------------ */

test('ticks say how many, and "you" where you stand', () => {
  assert.equal(tickText(1, false), '1 here');
  assert.equal(tickText(3, false), '3 here');
  assert.equal(tickText(1, true), 'you');
  assert.equal(tickText(3, true), 'you +2');
  const counts = countsOf({ marks: [{ chapter: 12, count: 2 }, { chapter: 40, count: 1 }] });
  assert.equal(counts.get(12), 2);
  assert.equal(counts.get(13), undefined);
  assert.equal(countsOf(null).size, 0);
});

test('the summary reads like a sentence and names the leader only when allowed', () => {
  assert.equal(summary({ mine: 12, ahead: 1, alongside: 1, behind: 0, on: false }), '1 ahead · 1 with you');
  assert.equal(summary({ mine: 12, ahead: 0, alongside: 0, behind: 2, on: true, leader: { isYou: true } }), '2 behind · Leader this week: you');
  assert.equal(summary({ mine: 12, ahead: 1, alongside: 0, behind: 0, on: true, leader: { name: null, isYou: false } }), '1 ahead · Leader this week: someone ahead');
  assert.equal(summary({ mine: 0, ahead: 0, alongside: 0, behind: 0, on: false }), '');
  assert.equal(summary({ mine: 3, ahead: 0, alongside: 0, behind: 0, on: false }), 'Only you so far');
});

/* --- heat ------------------------------------------------------------------ */

test('heat is comments plus half a point per sticker, per chapter', () => {
  const heat = heatFrom([
    { chapter: 5, reactions: [{ count: 2 }] },
    { chapter: 5, reactions: [] },
    { chapter: 9, reactions: [{ count: 1 }, { count: 1 }] },
    { chapter: 'x' },
  ]);
  assert.deepEqual(heat.get(5), { comments: 2, stickers: 2, heat: 3 });
  assert.deepEqual(heat.get(9), { comments: 1, stickers: 2, heat: 2 });
  assert.equal(heat.size, 2);
});

/* --- shelves ---------------------------------------------------------------- */

test('a shelf keeps titles, http covers, short notes and plain categories, and nothing else', () => {
  const items = shelf.sanitiseItems([
    { title: '  Solo  Leveling ', cover: 'https://x/y.jpg', note: 'friends said', category: 'Manhwa', progress: 40, sourceId: 'secret' },
    { title: 'Berserk', cover: 'data:image/png;base64,AAAA', category: 'not a slug!' },
    { title: 'solo leveling' },
    { title: '' },
    'junk',
  ]);
  assert.deepEqual(items, [
    { title: 'Solo Leveling', cover: 'https://x/y.jpg', note: 'friends said', category: 'manhwa' },
    { title: 'Berserk' },
  ]);
  assert.ok(!JSON.stringify(items).includes('secret'));
  assert.equal(shelf.sanitiseName(''), 'A Yomu shelf');
  assert.equal(shelf.sanitiseName(' Kly' + String.fromCharCode(7) + 'de’s  shelf '), 'Klyde’s shelf');
  const many = shelf.sanitiseItems(Array.from({ length: 400 }, (_, i) => ({ title: 't' + i })));
  assert.equal(many.length, shelf.MAX_ITEMS);
});

test('the public shelf never carries the token', () => {
  const pub = shelf.publicShelf({ schema: 'yomu.shelf/1', revision: 2, name: 'N', items: [{ title: 'A' }], at: 5, token: 'tok' }, 'CODE');
  assert.deepEqual(pub, { code: 'CODE', name: 'N', items: [{ title: 'A' }], count: 1, at: 5, revision: 2 });
});

test('what goes on the shelf: visible library rows with their notes, and no progress', () => {
  const items = itemsFrom(
    { library: [
      { id: 's1', sourceId: 'src', title: 'One', cover: 'https://c/1.jpg', category: 'manga', total: 40 },
      { id: 's2', sourceId: 'src', title: 'Two', hidden: true },
      { id: 's3', sourceId: 'src', title: 'Three' },
    ] },
    { 'src:s1': { note: 'the art' }, 'src:s3': { skipped: true } },
  );
  assert.deepEqual(items, [
    { title: 'One', cover: 'https://c/1.jpg', category: 'manga', note: 'the art' },
    { title: 'Three' },
  ]);
});
