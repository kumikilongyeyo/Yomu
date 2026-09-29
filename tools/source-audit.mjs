#!/usr/bin/env node
/** Strict live-source acceptance for Yomu. */

const BASE = (process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) || 'https://yomu.yomuread.workers.dev').replace(/\/+$/, '');
const AS_JSON = process.argv.includes('--json');
const TIMEOUT = 20_000;
const IMAGE_TIMEOUT = 15_000;
const SAMPLE_TITLES = 5;
const SAMPLE_CHAPTERS = 4;
const REQUIRED_CAPS = ['search', 'details', 'chapters', 'pages'];
const STEPS = ['contract', 'browse', 'search', 'details', 'chapters', 'pages', 'image'];
const REGISTRY_CONVERGENCE_ATTEMPTS = 15;
const REGISTRY_CONVERGENCE_DELAY = 2_000;

const say = (...args) => { if (!AS_JSON) console.log(...args); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { accept: 'application/json', 'x-yomu-audit': '1' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const ms = Date.now() - started;
    const type = response.headers.get('content-type') || '';
    const sourceTruth = response.headers.get('x-yomu-source-truth') || '';
    const entrypoint = response.headers.get('x-yomu-entrypoint') || '';
    const body = /json/i.test(type) ? await response.json().catch(() => null) : null;
    if (!response.ok) return { ok: false, ms, body, sourceTruth, entrypoint, error: `HTTP ${response.status}${body?.error ? `: ${String(body.error).slice(0, 140)}` : ''}` };
    if (!/json/i.test(type)) return { ok: false, ms, sourceTruth, entrypoint, error: `answered ${type || 'no content-type'}` };
    return { ok: true, ms, body, sourceTruth, entrypoint };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: String(error?.message || error).slice(0, 140) };
  }
}

async function image(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { accept: 'image/avif,image/webp,image/*,*/*;q=0.8', 'x-yomu-audit': '1' },
      signal: AbortSignal.timeout(IMAGE_TIMEOUT),
    });
    const ms = Date.now() - started;
    const type = response.headers.get('content-type') || '';
    const ok = response.ok && /^image\//i.test(type);
    try { await response.body?.cancel(); } catch {}
    return { ok, ms, type, status: response.status, error: ok ? undefined : `HTTP ${response.status}; content-type=${type || 'none'}` };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: String(error?.message || error).slice(0, 140) };
  }
}

const seriesRows = (body) => (Array.isArray(body?.series) ? body.series : []);

function validManifest(body) {
  const pages = Array.isArray(body?.pages) ? body.pages : [];
  return body?.schema === 'yomu.chapter-manifest/1'
    && typeof body.chapterId === 'string' && !!body.chapterId
    && typeof body.sourceSeriesId === 'string' && !!body.sourceSeriesId
    && typeof body.manifestVersion === 'string' && !!body.manifestVersion
    && Number.isFinite(body.pageListVersion)
    && pages.length > 0
    && new Set(pages.map((p) => p?.key)).size === pages.length
    && pages.every((p) => typeof p?.url === 'string' && /^https?:\/\//.test(p.url));
}

async function audit(source) {
  const api = String(source.api || '').replace(/\/?$/, '/');
  const caps = source.capabilities || {};
  const missing = REQUIRED_CAPS.filter((name) => caps[name] !== true);
  const out = { id: source.id, name: source.name, api, capabilities: caps, status: source.status || 'unknown', steps: {} };

  out.steps.contract = { ok: missing.length === 0, error: missing.length ? `missing reader capabilities: ${missing.join(', ')}` : undefined };
  if (missing.length) return out;

  const browse = await json(`${api}series?page=1`);
  const listed = seriesRows(browse.body).filter((r) => r?.id && r?.title);
  out.steps.browse = { ok: browse.ok && listed.length > 0, ms: browse.ms, count: listed.length, withCover: listed.filter((r) => r?.cover).length, error: browse.ok && !listed.length ? 'returned no usable titles' : browse.error };
  if (!out.steps.browse.ok) return out;

  let searchOk = false, searchResult = null, searchProbe = '';
  for (const candidate of listed.slice(0, 3)) {
    searchProbe = String(candidate.title).slice(0, 60);
    const attempt = await json(`${api}search?q=${encodeURIComponent(searchProbe)}&page=1`);
    const found = seriesRows(attempt.body).filter((r) => r?.id && r?.title);
    searchResult = { ...attempt, count: found.length };
    if (attempt.ok && found.length) { searchOk = true; break; }
  }
  out.steps.search = { ok: searchOk, ms: searchResult?.ms, count: searchResult?.count || 0, probe: searchProbe, error: searchOk ? undefined : (searchResult?.error || 'search returned no titles it had just advertised') };
  if (!searchOk) return out;

  let picked = null, lastDetailError = '', anyDetail = false;
  for (const candidate of listed.slice(0, SAMPLE_TITLES)) {
    const detail = await json(`${api}series/${encodeURIComponent(candidate.id)}`);
    if (detail.ok && detail.body?.title) anyDetail = true;
    const chapters = Array.isArray(detail.body?.chapters) ? detail.body.chapters.filter((c) => c?.id) : [];
    if (detail.ok && detail.body?.title && chapters.length) { picked = { candidate, detail, chapters }; break; }
    lastDetailError = detail.error || (detail.ok ? 'title had no chapters' : 'detail failed');
  }

  out.steps.details = { ok: anyDetail, title: String(picked?.detail?.body?.title || '').slice(0, 60), ms: picked?.detail?.ms, error: anyDetail ? undefined : (lastDetailError || 'no sampled title opened') };
  out.steps.chapters = { ok: !!picked, count: picked?.chapters?.length || 0, ms: picked?.detail?.ms, error: picked ? undefined : (lastDetailError || `none of ${Math.min(SAMPLE_TITLES, listed.length)} sampled titles had chapters`) };
  if (!picked) return out;

  let pageAttempt = null, imageAttempt = null, openedChapter = null, lastPageError = '';
  for (const chapter of picked.chapters.slice(0, SAMPLE_CHAPTERS)) {
    const manifest = await json(`${api}chapters/${encodeURIComponent(chapter.id)}/manifest`);
    const pages = Array.isArray(manifest.body?.pages) ? manifest.body.pages : [];
    const valid = manifest.ok && validManifest(manifest.body);
    pageAttempt = { ...manifest, pages, valid };
    if (!valid) { lastPageError = manifest.error || `reader rejected manifest (schema=${manifest.body?.schema || 'none'}, pages=${pages.length})`; continue; }
    const probe = await image(pages[0].url);
    imageAttempt = probe;
    if (probe.ok) { openedChapter = chapter; break; }
    lastPageError = `manifest worked but image failed: ${probe.error || 'unknown image error'}`;
  }

  out.steps.pages = { ok: !!openedChapter, ms: pageAttempt?.ms, count: pageAttempt?.pages?.length || 0, chapterId: openedChapter?.id, error: openedChapter ? undefined : (lastPageError || 'no sampled chapter produced a reader-valid manifest') };
  out.steps.image = { ok: !!openedChapter && imageAttempt?.ok === true, ms: imageAttempt?.ms, type: imageAttempt?.type, status: imageAttempt?.status, error: openedChapter && imageAttempt?.ok ? undefined : (imageAttempt?.error || lastPageError || 'no image could be decoded') };
  return out;
}

say(`Strict source audit: ${BASE}\n`);

// Critical: refresh the live registry before reading it. A release audit must
// never certify a memoized/stale source snapshot from a previous Worker isolate.
const refreshed = await json(`${BASE}/api/ext/refresh?audit=${Date.now()}`);
if (!refreshed.ok) {
  console.error(`Could not refresh the source registry: ${refreshed.error}`);
  process.exit(1);
}
const refreshedCount = Number(refreshed.body?.installed || 0);
say(`Registry refreshed: ${refreshedCount} active, ${Number(refreshed.body?.broken || 0)} broken.`);

// A Worker deploy can reach one Cloudflare edge a few seconds before another.
// The registry endpoint has a v10-only response marker, so wait for that exact
// release contract before judging the source pool. This does NOT relax the
// gate: after convergence, any synthetic Fabric card or count mismatch still
// fails the release.
let registry = null;
let sources = [];
let syntheticIds = [];
for (let attempt = 1; attempt <= REGISTRY_CONVERGENCE_ATTEMPTS; attempt += 1) {
  registry = await json(`${BASE}/api/ext/sources?audit=${Date.now()}-${attempt}`);
  if (registry.ok) {
    sources = (registry.body?.extensions || []).filter((ext) => ext?.id && ext?.api);
    syntheticIds = sources.map((source) => String(source.id)).filter((id) => id.startsWith('fabric-'));
    const countMatches = !Number.isFinite(refreshedCount) || refreshedCount === sources.length;
    const releaseMarker = registry.sourceTruth === 'registry-only';
    if (releaseMarker && countMatches && syntheticIds.length === 0) break;
    say(`Registry convergence ${attempt}/${REGISTRY_CONVERGENCE_ATTEMPTS}: marker=${registry.sourceTruth || 'old-worker'} count=${sources.length}/${refreshedCount} synthetic=${syntheticIds.join(',') || 'none'}`);
  } else {
    say(`Registry convergence ${attempt}/${REGISTRY_CONVERGENCE_ATTEMPTS}: ${registry.error}`);
  }
  if (attempt < REGISTRY_CONVERGENCE_ATTEMPTS) await sleep(REGISTRY_CONVERGENCE_DELAY);
}

if (!registry?.ok) {
  console.error(`Could not read the source registry: ${registry?.error || 'unknown registry error'}`);
  process.exit(1);
}
if (registry.sourceTruth !== 'registry-only') {
  console.error(`REGISTRY RELEASE MARKER FAILED: /api/ext/sources never converged to the v10 registry-only Worker contract (last entrypoint=${registry.entrypoint || 'unknown'}).`);
  process.exit(1);
}
if (syntheticIds.length) {
  console.error(`REGISTRY TRUTH FAILED: synthetic compatibility source(s) leaked into the active registry: ${syntheticIds.join(', ')}`);
  process.exit(1);
}
if (!sources.length) {
  console.error('No active extension sources were returned. MangaDex alone is not an acceptable federated source pool.');
  process.exit(1);
}

// A refresh that says N active sources followed by a different active list is
// itself a release failure: that is exactly the stale/ghost-source bug.
if (Number.isFinite(refreshedCount) && refreshedCount !== sources.length) {
  console.error(`REGISTRY CONSISTENCY FAILED: refresh reported ${refreshedCount} active source(s), but /api/ext/sources returned ${sources.length}.`);
  console.error(`Returned ids: ${sources.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

const report = await Promise.all(sources.map((source) => audit(source)));
const mark = (step) => (step?.ok ? 'ok  ' : step ? 'FAIL' : '--  ');

if (AS_JSON) {
  console.log(JSON.stringify({ base: BASE, audited: report.length, report }, null, 2));
} else {
  say(`${'source'.padEnd(18)}${STEPS.map((s) => s.padEnd(10)).join('')}`);
  say('-'.repeat(18 + STEPS.length * 10));
  for (const row of report) say(row.id.padEnd(18) + STEPS.map((s) => mark(row.steps[s]).padEnd(10)).join(''));
  say('');
  for (const row of report) {
    const broken = STEPS.filter((s) => !row.steps[s]?.ok);
    if (!broken.length) say(`✓ ${row.id}: browse ${row.steps.browse.count} · search ${row.steps.search.count} · chapters ${row.steps.chapters.count} · pages ${row.steps.pages.count} · image ${row.steps.image.type}`);
    else say(`✗ ${row.id}: ${broken.map((s) => `${s} — ${row.steps[s]?.error || 'not reached'}`).join('; ')}`);
  }
}

const broken = report.filter((row) => STEPS.some((s) => !row.steps[s]?.ok));
if (broken.length) {
  console.error(`\nSTRICT SOURCE GATE FAILED: ${broken.length}/${report.length} active extension source(s) are not reader-ready: ${broken.map((r) => r.id).join(', ')}`);
  console.error('Repair or disable every failing source. Active means usable all the way to image bytes.');
  process.exit(1);
}

say(`\nSTRICT SOURCE GATE PASSED: ${report.length}/${report.length} active extension sources read end to end.`);
