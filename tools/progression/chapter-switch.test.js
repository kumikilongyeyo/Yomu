/**
 * A chapter that will not open is swapped for a working copy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { prune, decide, routeFor, ledgerChapterId, positionOf, carryPosition, stalled, hung, pickCopy, MEMORY_MS, STALL_MS, HANG_MS } = await import('../../dist-app/yomu-chapter-switch.js');

test('a remembered working copy is used straight away, whatever failed', () => {
  const known = { href: '/read/x?source=yomuext-flame', providerName: 'Flame' };
  assert.equal(decide({ kind: 'manifest', known, retried: false, sourceAnswers: true }), 'switch-known');
  assert.equal(decide({ kind: 'pages', known, retried: true, sourceAnswers: false }), 'switch-known');
});

test('a manifest that answers on a direct re-check is retried once, not switched', () => {
  assert.equal(decide({ kind: 'manifest', known: null, retried: false, sourceAnswers: true }), 'retry');
  assert.equal(decide({ kind: 'manifest', known: null, retried: true, sourceAnswers: true }), 'search', 'a second failure after the retry switches');
});

test('a source that still fails, or dead pages, searches for a working copy', () => {
  assert.equal(decide({ kind: 'manifest', known: null, retried: false, sourceAnswers: false }), 'search');
  assert.equal(decide({ kind: 'pages', known: null, retried: false, sourceAnswers: true }), 'search', 'retrying does not revive dead images');
});

test('extension chapters route with their series so the reader finds neighbours', () => {
  assert.equal(
    routeFor({ providerId: 'ext:flamecomics', chapterId: '1/385fe46707bd150c' }, '1'),
    '/read/1%3A1%2F385fe46707bd150c?source=yomuext-flamecomics',
  );
  assert.equal(routeFor({ providerId: 'ext:weebcentral', chapterId: 'abc' }, undefined), '/read/abc?source=yomuext-weebcentral', 'no series known: bare id still opens');
  assert.equal(routeFor({ providerId: 'mangadex', chapterId: 'md-1' }, 'series'), '/read/series%3Amd-1?source=mangadex', 'MangaDex rejects a bare chapter id');
  assert.equal(routeFor({ providerId: 'suwayomi:7', chapterId: '42' }, 's'), '/read/s%3A42?source=mihon-7');
  assert.equal(routeFor({}, 'x'), null);
});

test('the ledger chapter id comes off the reader route id', () => {
  assert.equal(ledgerChapterId('solo-leveling:solo-leveling/chapters/abc'), 'solo-leveling/chapters/abc');
  assert.equal(ledgerChapterId('c5'), 'c5');
});

test('memory expires after twelve hours and is capped', () => {
  const now = 10 * MEMORY_MS;
  const map = { fresh: { at: now - 1000 }, stale: { at: now - MEMORY_MS - 1 } };
  assert.deepEqual(Object.keys(prune(map, now)), ['fresh']);
  const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`k${i}`, { at: now - i }]));
  const kept = prune(many, now);
  assert.equal(Object.keys(kept).length, 200);
  assert.ok(kept.k0 && !kept.k249, 'the newest are kept');
});

test('a stall is a chapter whose images were asked for and none painted', () => {
  assert.equal(stalled({ waited: STALL_MS, painted: false, requested: true }), true);
  assert.equal(stalled({ waited: STALL_MS - 1, painted: false, requested: true }), false, 'not yet');
  assert.equal(stalled({ waited: STALL_MS * 5, painted: true, requested: true }), false, 'one painted page ends it');
  assert.equal(stalled({ waited: STALL_MS * 5, painted: false, requested: false }), false, 'nothing asked for yet (queued, or over the pixel limit)');
});

test('a page is hung when its neighbours load and it does not, or much later on a fast link', () => {
  assert.equal(hung({ waited: 2 * HANG_MS, loadedSince: true, slow: false }), true);
  assert.equal(hung({ waited: HANG_MS, loadedSince: true, slow: false }), false, 'a big page on a middling link is slow, not hung');
  assert.equal(hung({ waited: 2 * HANG_MS, loadedSince: false, slow: false }), false, 'no evidence the link works');
  assert.equal(hung({ waited: 4 * HANG_MS, loadedSince: false, slow: false }), true);
  assert.equal(hung({ waited: 10 * HANG_MS, loadedSince: false, slow: true }), false, 'a 2G link is allowed to be slow');
  assert.equal(hung({ waited: 2 * HANG_MS, loadedSince: true, slow: true }), true, 'unless other pages prove it is not the link');
});

test('the place is read off the reader layout', () => {
  const boxes = [{ index: 0, top: 0, height: 1000 }, { index: 1, top: 1000, height: 2000 }, { index: 2, top: 3000, height: 500 }];
  assert.deepEqual(positionOf(boxes, 0), { index: 0, offset: 0 });
  assert.deepEqual(positionOf(boxes, 2000), { index: 1, offset: 0.5 });
  assert.deepEqual(positionOf(boxes, 3250), { index: 2, offset: 0.5 });
  assert.deepEqual(positionOf([], 500), { index: 0, offset: 0 });
});

test('the place survives a switch: same page on the same slicing, same fraction otherwise', () => {
  assert.deepEqual(carryPosition({ index: 37, offset: 0.4, count: 42 }, 42), { index: 37, offset: 0.4 });
  const moved = carryPosition({ index: 7, offset: 0.5, count: 15 }, 49);
  assert.equal(moved.index, 24, '7.5/15 of the way through is page 24.5 of 49');
  assert.ok(Math.abs(moved.offset - 0.5) < 1e-9);
  assert.deepEqual(carryPosition({ index: 14, offset: 1, count: 15 }, 49), { index: 48, offset: 1 }, 'the end stays the end');
  assert.deepEqual(carryPosition(null, 10), { index: 0, offset: 0 });
  assert.deepEqual(carryPosition({ index: 99, offset: 0, count: 42 }, 42), { index: 41, offset: 0 }, 'clamped');
});

test('dead images only switch to a copy whose image decoded', () => {
  const unknown = { ready: true, release: { providerId: 'ext:a' }, probes: { first: { ok: null } } };
  const decoded = { ready: true, release: { providerId: 'ext:b' }, probes: { first: { ok: true, width: 800 } } };
  const native = { ready: true, trustedNative: true, release: { providerId: 'mangadex' } };
  const broken = { ready: false, release: { providerId: 'ext:c' } };
  assert.equal(pickCopy([unknown, decoded], { strict: true }), decoded, 'a timed-out probe is not proof');
  assert.equal(pickCopy([unknown, native], { strict: true }), null, 'trusted is not proven');
  const lastOnly = { ready: true, release: { providerId: 'ext:d' }, probes: { first: { ok: null }, last: { ok: true } } };
  assert.equal(pickCopy([lastOnly], { strict: true }), lastOnly, 'dead pages: any decoded page will do');
  assert.equal(pickCopy([lastOnly], { strict: true, first: true }), null, 'a stall needs the first page, the one not painting');
  assert.equal(pickCopy([unknown, broken], { strict: true }), null, 'nothing proven: stay put');
  assert.equal(pickCopy([unknown, decoded], { strict: false }), unknown, 'a failed manifest takes the best-ranked copy, as before');
  assert.equal(pickCopy([unknown], { strict: true, probed: false }), unknown, 'no integrity layer, no probes to ask');
});
