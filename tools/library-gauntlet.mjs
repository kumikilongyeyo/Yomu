#!/usr/bin/env node
/**
 * Full-source Library release gate.
 *
 * Exactly ten gates. A release with 9/10 is a failed release. The checks are
 * intentionally architectural: they prevent the easy regression where Search
 * is federated while Browse quietly falls back to one provider and 14 cards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE = (process.argv.slice(2).find((x) => /^https?:\/\//.test(x)) || '').replace(/\/+$/, '');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const engine = read('dist-app/yomu-library-engine.js');
const explorer = read('dist-app/yomu-library-explorer.js');
const css = read('dist-app/yomu-library.css');
const optimizer = read('scripts/optimize-export.py');

const results = [];
function gate(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
}

async function live(pathname) {
  if (!BASE) return null;
  try {
    const response = await fetch(BASE + pathname, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, text: '', error: String(error?.message || error) };
  }
}

const home = await live('/');
const find = await live('/find');
const liveEngine = await live('/yomu-library-engine.js');
const liveExplorer = await live('/yomu-library-explorer.js');

// L1 — the release actually contains and injects the federated engine.
gate('L1 federated library assets are release-wired',
  /yomu-library-engine\.js/.test(optimizer) && /yomu-library-explorer\.js/.test(optimizer) && /yomu-library\.css/.test(optimizer)
  && (!BASE || (liveEngine?.ok && liveExplorer?.ok && /Yomu Library Engine/.test(liveEngine.text))),
  BASE ? `engine HTTP ${liveEngine?.status}; explorer HTTP ${liveExplorer?.status}` : 'offline');

// L2 — every enabled API source participates. Bounded concurrency is allowed;
// slicing the source list is not.
gate('L2 no enabled-source count cap',
  /collection\.sources/.test(engine)
  && /raw\.enabled === false/.test(engine)
  && /raw\.kind !== 'api'/.test(engine)
  && !/collectionSources\(\)[\s\S]{0,500}\.slice\s*\(\s*0\s*,\s*\d+/.test(engine),
  'source pressure must be controlled by concurrency, never list truncation');

// L3 — NamiComi is a hard exclusion, by identity/name/url rather than one id.
gate('L3 NamiComi is excluded from browse',
  /BLOCKED_SOURCE/.test(engine) && /nami/.test(engine) && /namicomi/i.test(engine) && /blocked\(raw\)/.test(engine),
  'the exclusion must survive source renames / URL forms');

// L4 — fan-out is bounded in two dimensions: how many sources are in flight,
// and how long the reader waits for them. Forty added sources must not produce
// forty simultaneous fetches, and one slow source must not own the segment.
gate('L4 multi-source fan-out is concurrency bounded and time bounded',
  /const CONCURRENCY = [2-8];/.test(engine)
  && /const FIRST_WAVE_CONCURRENCY = [2-9];/.test(engine)
  && /WAVE_BUDGET_MS/.test(engine)
  && /Promise\.race\(/.test(engine),
  'expected a bounded wave width and a bounded wave wait');

// L5 — each source owns a real page cursor and advances it. Page 1 forever is
// not an infinite library.
gate('L5 sources paginate independently',
  /state = \{ page: 1/.test(engine)
  && /url\.searchParams\.set\('page', String\(page\)\)/.test(engine)
  && /state\.page \+= 1/.test(engine)
  && /fingerprint/.test(engine),
  'fingerprint also catches sources that ignore page=N and repeat page 1');

// L6 — duplicates across sources become one title with multiple providers.
gate('L6 canonical titles merge providers',
  /const canonical = new Map\(\)/.test(engine)
  && /normalize\(item\.title\)/.test(engine)
  && /row\.providers = \[\.\.\.providers, provider\]/.test(engine)
  && /__sourceIds/.test(engine),
  'same work from multiple sources must not burn multiple tiles');

// L7 — no provider monopoly when alternatives exist.
gate('L7 visible segments enforce provider diversity',
  /function fairMix/.test(engine)
  && /uniqueSources\.size >= 2/.test(engine)
  && /Math\.ceil\(count \* 0\.4\)/.test(engine)
  && /one provider from swallowing a segment/i.test(engine),
  'single-source share is capped at 40% while alternatives can fill');

// L8 — the shelf is unbounded in depth but bounded in paint work: ten at a
// time, skeletons, explicit load button, and viewport prefetch.
gate('L8 progressive library keeps loading beyond the first shelf',
  /const SEGMENT = 10;/.test(explorer)
  && /YomuTitleCard\.skeleton/.test(explorer)
  && /Load 10 more/.test(explorer)
  && /IntersectionObserver/.test(explorer)
  && /rootMargin: '700px/.test(explorer)
  && !/MAX_RESULTS\s*=\s*\d+/.test(explorer),
  'segment size may be small; total library may not be capped');

// L9 — the categories the product promises exist on the full library itself,
// not only on MangaDex's old grid.
gate('L9 full-library type and genre exploration exists',
  ['manga', 'manhwa', 'manhua', 'completed'].every((x) => explorer.includes(`['${x}'`))
  && /GENRES = \[/.test(explorer)
  && /setGenre\(/.test(explorer)
  && /matches\(row, type, genre\)/.test(engine),
  'Manga / Manhwa / Manhua / Completed plus genre exploration');

// L10 — the reader can see that federation is real, and one dead source does
// not kill the rest of the library.
gate('L10 source provenance and failure isolation are visible',
  /\{ source: true \}/.test(explorer)
  && /yt-card__source/.test(read('dist-app/yomu-titlecard.js'))
  && /enabled source/.test(explorer)
  && /responding/.test(explorer)
  && /respondingIds/.test(engine)
  && /state\.failures \+= 1/.test(engine)
  && /return \[\];/.test(engine)
  && (!BASE || (/yomu-library-engine\.js/.test(home?.text || '') && /yomu-library-engine\.js/.test(find?.text || ''))),
  BASE ? `home injection=${/yomu-library-engine\.js/.test(home?.text || '')}; find injection=${/yomu-library-engine\.js/.test(find?.text || '')}` : 'offline');

const passed = results.filter((r) => r.ok).length;
for (const [i, row] of results.entries()) {
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${String(i + 1).padStart(2, '0')}/10  ${row.name}${row.ok || !row.detail ? '' : `\n             ${row.detail}`}`);
}
console.log(`\nLibrary Gauntlet: ${passed}/10 ${passed === 10 ? 'PASS' : 'FAIL — RELEASE BLOCKED'}`);
if (passed !== 10) process.exit(1);
