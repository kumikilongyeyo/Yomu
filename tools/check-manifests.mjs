/**
 * Verifies extension chapter manifests against the reader's own validator.
 *
 * parseChapterManifest below is transcribed from the shipped app bundle
 * (dist-app/_expo/static/js/web/entry-*.js, module 796) rather than
 * reimplemented, so a manifest that passes here is one the reader will accept.
 *
 *   node tools/check-manifests.mjs [baseUrl]
 */
const BASE = (process.argv[2] ?? 'http://127.0.0.1:8799').replace(/\/+$/, '');
const MANIFEST_SCHEMA = 'yomu.chapter-manifest/1';

function parseChapterManifest(raw) {
  const fail = (msg) => { throw new Error(msg); };
  if (typeof raw !== 'object' || raw === null) fail('manifest is not an object');
  if (raw.schema !== MANIFEST_SCHEMA) fail(`unsupported manifest schema: ${String(raw.schema)}`);
  for (const k of ['chapterId', 'sourceSeriesId', 'manifestVersion']) {
    if (typeof raw[k] !== 'string' || !raw[k]) fail(`missing ${k}`);
  }
  if (typeof raw.pageListVersion !== 'number' || !Number.isFinite(raw.pageListVersion)) fail('missing pageListVersion');
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) fail('manifest has no pages');
  const keys = new Set();
  raw.pages.forEach((p, i) => {
    if (typeof p !== 'object' || p === null) fail(`page ${i} is not an object`);
    if (typeof p.key !== 'string' || !p.key) fail(`page ${i} has no key`);
    if (keys.has(p.key)) fail(`duplicate page key ${p.key}`);
    keys.add(p.key);
    if (typeof p.url !== 'string' || !p.url) fail(`page ${p.key} has no url`);
  });
  return raw;
}

// One real chapter per page-capable source, with the series id it belongs to.
const CASES = [
  { ext: 'weebcentral', chapter: '01M27CS4DQ1JVQDGARQJVK76EQ',                             expectSeries: null },
  { ext: 'flamecomics', chapter: '165/261554bf72fc5a86',                                    expectSeries: '165' },
  { ext: 'asura',       chapter: 'the-genius-professor-wants-to-take-it-easy/chapters/chapter-20',
                                                                                            expectSeries: 'the-genius-professor-wants-to-take-it-easy' },
  { ext: 'webtoons',    chapter: '/en/romance/situationship/ep-1-mostly-air/viewer?title_no=10009&episode_no=1',
                                                                                            expectSeries: '10009' },
  { ext: 'namicomi',    chapter: 'pbQj8CvM',                                                expectSeries: null },
];

let failures = 0;
for (const { ext, chapter, expectSeries } of CASES) {
  const url = `${BASE}/api/ext/source/${ext}/chapters/${encodeURIComponent(chapter)}/manifest`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const body = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error ?? ''}`);
    const m = parseChapterManifest(body);
    // expectSeries null = no derivation rule, so the chapter id stands in.
    const want = expectSeries ?? chapter;
    const ok = m.sourceSeriesId === want;
    if (!ok) failures++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${ext.padEnd(12)} pages=${String(m.pages.length).padEnd(4)} ` +
      `sourceSeriesId=${JSON.stringify(m.sourceSeriesId)}${ok ? '' : `  expected ${JSON.stringify(want)}`}`,
    );
  } catch (e) {
    failures++;
    console.log(`FAIL  ${ext.padEnd(12)} ${e.message}`);
  }
}
console.log(failures ? `\n${failures} failing` : '\nall manifests accepted by the reader validator');
process.exit(failures ? 1 : 0);
