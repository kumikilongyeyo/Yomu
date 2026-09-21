#!/usr/bin/env node
/**
 * Does every enabled source actually work, end to end?
 *
 * "The source is added" is four different claims, and a source can pass one
 * and fail the next three:
 *
 *   browse    /series                        does it list titles, with covers?
 *   search    /search?q=                     can you find a title by name?
 *   details   /series/<id>                   does a title resolve to a page?
 *   chapters  /series/<id> -> .chapters      does it list chapters to open?
 *   pages     /chapters/<id>/manifest        do those chapters have images?
 *
 * The last two are not their own endpoints: worker/routes-extensions.ts returns
 * the chapter list inside the series detail, and the page list only through the
 * reader's manifest route. Auditing them as separate paths is how a first pass
 * of this file reported every source as broken when they were all fine.
 *
 * Each one is where the library, the search results, the series screen and
 * the reader get their content, so a source that browses but cannot serve
 * chapters looks perfect on Home and is useless the moment anybody taps it.
 * This walks the whole chain per source and says exactly which link broke.
 *
 *   node tools/source-audit.mjs                          # against production
 *   node tools/source-audit.mjs http://127.0.0.1:8787    # against wrangler dev
 *   node tools/source-audit.mjs --json                   # machine-readable
 *
 * Exit code is 0 when every source can at least browse and search, 1 when a
 * source is wholly dead. A source that browses but cannot serve pages is
 * reported loudly and does not fail the run, because that is usually the
 * provider having a bad day rather than a defect in this repository -- and a
 * gate that goes red for someone else's outage gets ignored.
 */
const BASE = (process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) || 'https://yomu.yomuread.workers.dev').replace(/\/+$/, '');
const AS_JSON = process.argv.includes('--json');
const TIMEOUT = 20_000;
/* NamiComi is excluded everywhere in the product, so auditing it would report
   a failure for something deliberately never called. */
const EXCLUDE = /nami\s*comi|namicomi/i;

const say = (...args) => { if (!AS_JSON) console.log(...args); };

async function json(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const ms = Date.now() - started;
    if (!response.ok) return { ok: false, ms, error: `HTTP ${response.status}` };
    const type = response.headers.get('content-type') || '';
    if (!/json/i.test(type)) return { ok: false, ms, error: `answered ${type || 'no content-type'}` };
    return { ok: true, ms, body: await response.json() };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: String(error?.message || error).slice(0, 80) };
  }
}

const rows = (body) => (Array.isArray(body?.series) ? body.series : []);

/**
 * One source, all the way down. Stops descending once a step has no input.
 *
 * A source is only audited for what it claims. Comick declares
 * `chapters: false, pages: false` -- it finds titles, it does not serve them --
 * so calling those routes reports a 502 for a promise it never made. Declared
 * gaps come back as `n/a`, not as failures.
 */
async function audit(source) {
  const api = String(source.api || '').replace(/\/?$/, '/');
  const caps = source.capabilities || {};
  const claims = (name) => caps[name] !== false;
  const out = { id: source.id, name: source.name, api, capabilities: caps, steps: {} };
  const NA = { ok: true, na: true, error: 'not claimed by this source' };

  // 1. browse
  const browse = await json(`${api}series?page=1`);
  const listed = rows(browse.body);
  out.steps.browse = {
    ok: browse.ok && listed.length > 0,
    ms: browse.ms,
    count: listed.length,
    withCover: listed.filter((r) => r?.cover).length,
    error: browse.error,
  };

  // 2. search -- for a title this source itself just listed, so a miss is the
  //    search being broken rather than the query being unlucky.
  const probe = listed.find((r) => r?.title)?.title || 'a';
  const search = await json(`${api}search?q=${encodeURIComponent(String(probe).slice(0, 40))}&page=1`);
  const found = rows(search.body);
  out.steps.search = {
    ok: search.ok && found.length > 0,
    ms: search.ms,
    count: found.length,
    probe: String(probe).slice(0, 48),
    error: search.error,
  };

  // 3. details + 4. chapters, for the first title it listed
  const first = listed[0];
  if (!first?.id) {
    out.steps.details = { ok: false, error: 'nothing to open -- browse returned no id' };
    out.steps.chapters = { ok: false, error: 'skipped' };
    out.steps.pages = { ok: false, error: 'skipped' };
    return out;
  }

  if (!claims('details') && !claims('chapters')) {
    out.steps.details = NA;
    out.steps.chapters = NA;
    out.steps.pages = NA;
    return out;
  }

  /* One call answers both: the detail route returns the series *and* its
     chapter list, so a source that opens but lists nothing is visible here. */
  const details = await json(`${api}series/${encodeURIComponent(first.id)}`);
  const list = Array.isArray(details.body?.chapters) ? details.body.chapters : [];
  out.steps.details = {
    ok: details.ok && !!details.body?.title,
    ms: details.ms,
    title: String(details.body?.title || '').slice(0, 48),
    error: details.error,
  };
  out.steps.chapters = {
    ok: details.ok && list.length > 0,
    ms: details.ms,
    count: list.length,
    error: details.ok ? (list.length ? undefined : 'the series carries no chapters') : details.error,
  };

  // 5. pages, through the same manifest route the reader itself uses -- and
  //    validated the same way, because a manifest the reader rejects is a
  //    chapter that does not open however healthy the source looks.
  if (!claims('pages')) { out.steps.pages = NA; return out; }

  const chapter = list[0];
  if (!chapter?.id) {
    out.steps.pages = { ok: false, error: 'no chapter id to open' };
    return out;
  }
  const manifest = await json(`${api}chapters/${encodeURIComponent(chapter.id)}/manifest`);
  const images = Array.isArray(manifest.body?.pages) ? manifest.body.pages : [];
  const body = manifest.body || {};
  const valid = body.schema === 'yomu.chapter-manifest/1'
    && typeof body.chapterId === 'string' && body.chapterId
    && typeof body.sourceSeriesId === 'string' && body.sourceSeriesId
    && typeof body.manifestVersion === 'string' && body.manifestVersion
    && Number.isFinite(body.pageListVersion)
    && images.length > 0
    && new Set(images.map((p) => p?.key)).size === images.length;
  out.steps.pages = {
    ok: manifest.ok && valid,
    ms: manifest.ms,
    count: images.length,
    error: manifest.ok
      ? (valid ? undefined : `manifest would be rejected by the reader (schema=${body.schema || 'none'}, pages=${images.length})`)
      : manifest.error,
  };
  return out;
}

/* --- run ----------------------------------------------------------------- */

say(`Auditing ${BASE}\n`);
const registry = await json(`${BASE}/api/ext/sources`);
if (!registry.ok) {
  console.error(`Could not read the source registry: ${registry.error}`);
  process.exit(1);
}

const sources = (registry.body?.extensions || [])
  .filter((ext) => ext?.id && ext?.api && !EXCLUDE.test(`${ext.id} ${ext.name || ''}`));

/* Sources are independent, so audit them together rather than in a queue --
   one slow provider should not decide how long the whole audit takes. */
const report = await Promise.all(sources.map((source) => audit(source)));

const STEPS = ['browse', 'search', 'details', 'chapters', 'pages'];
const mark = (step) => (step?.na ? 'n/a ' : step?.ok ? 'ok  ' : step?.error === 'skipped' ? '--  ' : 'FAIL');

if (AS_JSON) {
  console.log(JSON.stringify({ base: BASE, audited: report.length, report }, null, 2));
} else {
  say(`${'source'.padEnd(16)}${STEPS.map((s) => s.padEnd(10)).join('')}`);
  say('-'.repeat(16 + STEPS.length * 10));
  for (const row of report) {
    say(row.id.padEnd(16) + STEPS.map((s) => mark(row.steps[s]).padEnd(10)).join(''));
  }
  say('');
  for (const row of report) {
    const broken = STEPS.filter((s) => !row.steps[s]?.ok && !row.steps[s]?.na);
    if (!broken.length) {
      const deep = row.steps.chapters.na
        ? 'discovery-only by declaration — finds titles, does not serve them'
        : `chapters ${row.steps.chapters.count} · pages ${row.steps.pages.count}`;
      say(`✓ ${row.id}: browse ${row.steps.browse.count} (${row.steps.browse.withCover} with covers) · search ${row.steps.search.count} · ${deep}`);
      continue;
    }
    say(`✗ ${row.id}: ${broken.map((s) => `${s} — ${row.steps[s]?.error || 'empty'}`).join('; ')}`);
  }
}

/* A source that cannot browse AND cannot search is not a source. Anything
   deeper failing is reported but does not block: providers have bad days, and
   a release gate that goes red for someone else's outage stops being read. */
const dead = report.filter((row) => !row.steps.browse.ok && !row.steps.search.ok);
if (dead.length) {
  console.error(`\n${dead.length} source(s) are wholly unreachable: ${dead.map((r) => r.id).join(', ')}`);
  process.exit(1);
}
say(`\n${report.length} sources audited, ${report.filter((r) => STEPS.every((s) => r.steps[s]?.ok)).length} flawless end to end.`);
