/**
 * A chapter that will not open is swapped for a working copy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { prune, decide, routeFor, ledgerChapterId, MEMORY_MS } = await import('../../dist-app/yomu-chapter-switch.js');

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
  assert.equal(routeFor({ providerId: 'mangadex', chapterId: 'md-1' }, 'series'), '/read/md-1?source=mangadex');
  assert.equal(routeFor({ providerId: 'suwayomi:7', chapterId: '42' }, 's'), '/read/42?source=mihon-7');
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
