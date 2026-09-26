/**
 * Chapter integrity: which copy of a chapter the reader is sent to.
 *
 * The recovery paths used to accept any copy whose manifest listed one page.
 * These tests pin the cases that rule got wrong -- a short copy, a copy whose
 * images are all dead behind a working manifest, a big source that fails a
 * third of its pages -- and the cases a stricter rule must not get wrong
 * either: sources that slice the same chapter differently, a slow network,
 * the only copy left.
 *
 * The page counts marked "live" were measured on the production Worker on
 * 2026-09-26 (Solo Leveling, chapters 198-200, all three copies complete).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  assess, rank, rankSources, verifyAll, healthOf, record, median, learnLayout, learnedRatio,
  HALF_LIFE_MS, TINY_WIDTH,
} = await import('../../dist-app/yomu-integrity.js');

const LIVE = [
  { n: 198, asura: 17, flame: 18, weeb: 59 },
  { n: 199, asura: 16, flame: 23, weeb: 48 },
  { n: 200, asura: 15, flame: 18, weeb: 49 },
];

const pages = (n, { from = 0, repeat = 0, tag = '' } = {}) => Array.from({ length: n }, (_, i) => ({
  index: from + i,
  url: `https://yomu.test/api/img?u=p${i < n - repeat ? i : 0}${tag}`,
}));
const good = { ok: true, width: 800, height: 12000 };
const copy = (providerId, n, extra = {}) => ({
  release: { providerId, chapterId: providerId + '-c', ...(extra.release || {}) },
  ready: n > 0,
  pageCount: n,
  pages: pages(n),
  probes: { first: good, last: good },
  ...extra,
});
const sib = (providerId, count) => ({ providerId, count });

/** A layout that has seen the three live chapters. */
function learnedFromLive() {
  const layout = {};
  for (const ch of LIVE) {
    learnLayout(layout, 'ext:asura', ch.asura, 'ext:flamecomics', ch.flame);
    learnLayout(layout, 'ext:asura', ch.asura, 'ext:weebcentral', ch.weeb);
    learnLayout(layout, 'ext:flamecomics', ch.flame, 'ext:weebcentral', ch.weeb);
  }
  return layout;
}

test('a copy with every page and both ends decoding is complete', () => {
  const out = assess(copy('ext:a', 46), [sib('ext:b', 46)]);
  assert.equal(out.grade, 'complete');
  assert.equal(out.ready, true);
  assert.equal(out.score, 100);
  assert.match(out.summary, /46 pages/);
});

test('live: 15, 18 and 49 pages of the same chapter are all complete', () => {
  /* The false positive a raw page-count comparison produces. Asura cuts
     chapter 200 into 15 pages and Weeb Central into 49; both are whole. */
  const ch = LIVE[2];
  const all = [sib('ext:asura', ch.asura), sib('ext:flamecomics', ch.flame), sib('ext:weebcentral', ch.weeb)];
  for (const [id, n] of [['ext:asura', ch.asura], ['ext:flamecomics', ch.flame], ['ext:weebcentral', ch.weeb]]) {
    const out = assess(copy(id, n), all.filter((s) => s.providerId !== id), {});
    assert.equal(out.grade, 'complete', `${id} with ${n} pages`);
  }
  /* ...and still complete once the pair ratios are learned. */
  const layout = learnedFromLive();
  const out = assess(copy('ext:asura', 15), [sib('ext:flamecomics', 18), sib('ext:weebcentral', 49)], layout);
  assert.equal(out.grade, 'complete');
});

test('live: once the ratios are learned, a truncated copy stands out', () => {
  const layout = learnedFromLive();
  const r = learnedRatio(layout, 'ext:asura', 'ext:weebcentral');
  assert.ok(r < -0.9 && r > -1.4, `asura runs at ~0.3x weebcentral (log ratio ${r})`);
  assert.ok(Math.abs(learnedRatio(layout, 'ext:weebcentral', 'ext:asura') + r) < 1e-12, 'the ratio reads both ways');

  const weebShort = assess(copy('ext:weebcentral', 20), [sib('ext:asura', 16), sib('ext:flamecomics', 19)], layout);
  assert.equal(weebShort.grade, 'suspect');
  assert.match(weebShort.summary, /20 pages; this source usually has ~5\d here/);

  const asuraShort = assess(copy('ext:asura', 6), [sib('ext:flamecomics', 19), sib('ext:weebcentral', 52)], layout);
  assert.equal(asuraShort.grade, 'suspect');
});

test('a pair seen together only once is not trusted yet', () => {
  const layout = {};
  learnLayout(layout, 'ext:a', 10, 'ext:b', 40);
  assert.equal(learnedRatio(layout, 'ext:a', 'ext:b'), null);
  const out = assess(copy('ext:a', 3), [sib('ext:b', 40)], layout);
  assert.equal(out.grade, 'complete', 'one sample is an anecdote');
});

test('a copy that delivers what its own source declares is not second-guessed', () => {
  const layout = learnedFromLive();
  const out = assess(copy('ext:asura', 6, { release: { pageCount: 6 } }), [sib('ext:weebcentral', 52)], layout);
  assert.equal(out.grade, 'complete');
});

test('fewer pages than the chapter declares is suspect even with no siblings', () => {
  const item = copy('suwayomi:1', 31, { release: { pageCount: 46 } });
  const out = assess(item, []);
  assert.equal(out.grade, 'suspect');
  assert.match(out.reasons.join(), /31 of 46 pages/);
});

test('a working manifest with dead images is broken, not ready', () => {
  /* The case the old rule could not see at all: pages.length > 0, so "ready". */
  const out = assess(copy('ext:dead', 40, { probes: { first: { ok: false }, last: { ok: false } } }), []);
  assert.equal(out.ready, false);
  assert.equal(out.grade, 'broken');
});

test('a lost last page makes a copy suspect', () => {
  const out = assess(copy('ext:trunc', 40, { probes: { first: good, last: { ok: false } } }), []);
  assert.equal(out.grade, 'suspect');
  assert.match(out.summary, /last page/);
});

test('a probe that timed out is unknown, not a failure', () => {
  /* A slow network must not make every copy look broken and strand the reader. */
  const out = assess(copy('ext:slow', 40, { probes: { first: { ok: null }, last: { ok: null } } }), []);
  assert.equal(out.grade, 'complete');
});

test('repeated and missing pages cost score', () => {
  const repeated = copy('ext:rep', 20);
  repeated.pages = pages(20, { repeat: 4 });
  const r = assess(repeated, []);
  assert.equal(r.grade, 'suspect');
  assert.match(r.reasons.join(), /4 repeated pages/);

  const gappy = copy('ext:gap', 20);
  gappy.pages = pages(20).filter((p) => p.index !== 7).concat({ index: 25, url: 'https://yomu.test/x' });
  assert.match(assess(gappy, []).reasons.join(), /gaps in page order/);

  const oneBased = copy('ext:one', 20);
  oneBased.pages = pages(20, { from: 1 });
  assert.equal(assess(oneBased, []).grade, 'complete', 'numbering from 1 is not a gap');
});

test('thumbnail-sized pages are marked low resolution', () => {
  const tiny = { ok: true, width: TINY_WIDTH - 50, height: 500 };
  const out = assess(copy('ext:thumb', 30, { probes: { first: tiny, last: tiny } }), []);
  assert.match(out.reasons.join(), /low resolution/);
  assert.ok(out.score < 100);
});

test('a copy that is not ready scores zero', () => {
  const out = assess({ release: { providerId: 'x' }, ready: false }, []);
  assert.equal(out.ready, false);
  assert.equal(out.score, 0);
  assert.equal(out.grade, 'broken');
});

test('complete beats suspect whatever the reliability', () => {
  const store = {};
  for (let i = 0; i < 20; i++) record(store, 'ext:flaky', 'page', false);
  for (let i = 0; i < 20; i++) record(store, 'ext:solid', 'page', true);
  const complete = { ...copy('ext:flaky', 46), ...assess(copy('ext:flaky', 46), []) };
  const shortItem = copy('ext:solid', 12, { release: { pageCount: 46 } });
  const suspect = { ...shortItem, ...assess(shortItem, []) };
  assert.equal(suspect.grade, 'suspect');
  const ordered = rank([suspect, complete], store);
  assert.equal(ordered[0].release.providerId, 'ext:flaky');
});

test('between two complete copies the more reliable source wins', () => {
  const store = {};
  for (let i = 0; i < 30; i++) record(store, 'ext:flaky', 'page', i % 3 !== 0);
  for (let i = 0; i < 30; i++) record(store, 'ext:solid', 'page', true);
  const a = { ...copy('ext:flaky', 46), ...assess(copy('ext:flaky', 46), []) };
  const b = { ...copy('ext:solid', 46), ...assess(copy('ext:solid', 46), []) };
  assert.equal(rank([a, b], store)[0].release.providerId, 'ext:solid');
});

test('the series jump weighs chapters by reliability, not chapters alone', () => {
  const store = {};
  for (let i = 0; i < 40; i++) record(store, 'ext:big', 'page', i % 3 !== 0);
  for (let i = 0; i < 40; i++) record(store, 'ext:good', 'page', true);
  const ordered = rankSources([
    { providerId: 'ext:big', chapterCount: 400, kind: 'extension' },
    { providerId: 'ext:good', chapterCount: 390, kind: 'extension' },
    { providerId: 'ext:tiny', chapterCount: 50, kind: 'extension' },
  ], store);
  assert.deepEqual(ordered.map((s) => s.providerId), ['ext:good', 'ext:big', 'ext:tiny']);
});

test('with no history the series jump is the old chapter-count order', () => {
  const ordered = rankSources([
    { providerId: 'a', chapterCount: 10, kind: 'suwayomi' },
    { providerId: 'b', chapterCount: 200, kind: 'extension' },
    { providerId: 'c', chapterCount: 200, kind: 'native' },
  ], {});
  assert.deepEqual(ordered.map((s) => s.providerId), ['b', 'c', 'a']);
});

test('an unknown source sits below a proven one and above a failing one', () => {
  const store = {};
  for (let i = 0; i < 30; i++) record(store, 'good', 'page', true);
  for (let i = 0; i < 30; i++) record(store, 'bad', 'page', false);
  const unknown = healthOf(store, 'never-seen');
  assert.ok(healthOf(store, 'good') > unknown, 'proven beats unknown');
  assert.ok(unknown > healthOf(store, 'bad'), 'unknown beats failing');
});

test('old failures fade: a source that was down a month ago is not down now', () => {
  const store = {};
  const then = 1_000_000_000_000;
  for (let i = 0; i < 30; i++) record(store, 'x', 'page', false, then);
  const atTheTime = healthOf(store, 'x', then);
  const later = healthOf(store, 'x', then + 4 * HALF_LIFE_MS);
  assert.ok(later > atTheTime + 0.15, `${later} should have recovered well past ${atTheTime}`);
});

test('median ignores zeros and handles even counts', () => {
  assert.equal(median([0, 46, 44]), 45);
  assert.equal(median([]), 0);
});

/* --- the whole pass, as the two recovery files call it --------------------- */

const serve = (counts) => async (release) => ({
  release,
  ready: counts[release.providerId] > 0,
  pageCount: counts[release.providerId],
  pages: pages(counts[release.providerId], { tag: `#${release.providerId}` }),
});
const releasesFor = (counts) => Object.keys(counts).map((providerId) => ({ providerId, chapterId: providerId }));

test('verifyAll learns the slicing from normal chapters, then catches the short one', async () => {
  const store = {};
  const layout = {};
  const probe = async (url) => (url.endsWith('#ext:dead') ? { ok: false } : good);
  for (const ch of LIVE.slice(0, 2)) {
    const counts = { 'ext:asura': ch.asura, 'ext:flamecomics': ch.flame, 'ext:weebcentral': ch.weeb };
    const out = await verifyAll(releasesFor(counts), serve(counts), { store, layout, probe });
    assert.ok(out.every((item) => item.grade === 'complete'), `chapter ${ch.n} is complete everywhere`);
  }

  /* Chapter 200, except Weeb Central's copy lost its back half and a fourth
     source's images are dead. */
  const counts = { 'ext:asura': 15, 'ext:flamecomics': 18, 'ext:weebcentral': 22, 'ext:dead': 30 };
  const weebRatio = learnedRatio(layout, 'ext:flamecomics', 'ext:weebcentral');
  const out = await verifyAll(releasesFor(counts), serve(counts), { store, layout, probe });
  assert.deepEqual(out.slice(0, 2).map((i) => i.grade), ['complete', 'complete']);
  assert.equal(out[2].release.providerId, 'ext:weebcentral', 'short but readable ranks after the complete copies');
  assert.equal(out[2].grade, 'suspect');
  assert.equal(out[3].release.providerId, 'ext:dead', 'dead images rank last');
  assert.equal(out[3].ready, false);
  /* Both callers take `.find(item => item.ready)`. */
  assert.notEqual(out.find((item) => item.ready).release.providerId, 'ext:weebcentral');

  assert.ok(out.every((item) => !('pages' in item)), 'page lists are not kept around');
  assert.ok(store['ext:asura'].manifest[0] > 0, 'manifest answers were recorded');
  assert.ok(store['ext:weebcentral'].complete[1] > 0, 'an incomplete copy counts against its source');
  assert.equal(learnedRatio(layout, 'ext:flamecomics', 'ext:weebcentral'), weebRatio,
    'the short copy did not teach the layout its own ratio');
  assert.equal(layout[['ext:asura', 'ext:flamecomics'].join('|')][1], 3, 'the two complete copies did');
});

test('verifyAll: MangaDex is trusted unfetched, and its declared count is a yardstick', async () => {
  const layout = {};
  learnLayout(layout, 'ext:x', 46, 'mangadex', 46);
  learnLayout(layout, 'ext:x', 40, 'mangadex', 40);
  const releases = [
    { providerId: 'mangadex', chapterId: 'md', pageCount: 46 },
    { providerId: 'ext:x', chapterId: 's' },
  ];
  const out = await verifyAll(releases, async (release) => (release.providerId === 'mangadex'
    ? { release, ready: true, pageCount: 46, trustedNative: true }
    : { release, ready: true, pageCount: 20, pages: pages(20) }), { store: {}, layout, probe: async () => good });
  assert.equal(out[0].release.providerId, 'mangadex');
  assert.equal(out[1].grade, 'suspect');
});

test('verifyAll: a verifier that throws is a failed copy, not a crash', async () => {
  const out = await verifyAll([{ providerId: 'ext:boom', chapterId: 'b' }], async () => { throw new Error('boom'); }, { store: {}, layout: {} });
  assert.equal(out.length, 1);
  assert.equal(out[0].ready, false);
});

test('verifyAll: the only copy left still opens even if it is short', async () => {
  const out = await verifyAll([{ providerId: 'ext:only', chapterId: 'o', pageCount: 46 }], async (release) => ({
    release, ready: true, pageCount: 20, pages: pages(20),
  }), { store: {}, layout: {}, probe: async () => good });
  assert.equal(out[0].ready, true);
  assert.equal(out[0].grade, 'suspect');
});
