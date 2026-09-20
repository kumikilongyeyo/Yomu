#!/usr/bin/env node
/**
 * Deterministic loading benchmark.
 *
 * Section 10 of the recovery spec says the "2x faster" claim has to be
 * measured against the current production behaviour under the same fixtures
 * and the same network profile, not asserted from a code reading. So this
 * drives two exports -- `--baseline <dist>` and `--candidate <dist>` -- with
 * one harness, one fixture server implementation and one seeding, and writes
 * the numbers out as JSON and CSV for the PR to carry.
 *
 * The network profile is part of the fixture, not an accident of the day: a
 * spread of per-source latencies including two providers slow enough to be
 * the thing a wave would otherwise wait for, and one that fails outright.
 * That is the shape of a real enabled-source list and it is the shape the
 * loading path has to survive.
 *
 *   node tools/bench-library.mjs \
 *     --baseline ../yomu-baseline/dist-app \
 *     --candidate ./dist-app --runs 7
 *
 * Metrics, all in milliseconds from navigation start:
 *   ttf1             first usable title card
 *   ttf10            ten usable title cards
 *   segmentComplete  the requested segment stops changing
 *   warmRevisit      ttf10 on a second visit with the cache warm
 *   longTasks        total main-thread time in tasks over 50ms
 *   layoutShift      cumulative layout shift while the segment fills
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anilistMedia, collection } from '../tests/fixtures/catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'recovery');

/** Both card systems, so one harness can measure both trees. */
const CARD = '.yt-card:not(.yt-card--skeleton), .yl-card';

/* The fixed network profile. Two providers well past any sane wave budget,
   one dead, the rest healthy but not instant. */
const PROFILE = {
  baseLatency: 40,
  latency: { alpha: 2600, bravo: 2200, delta: 180, echo: 120, foxtrot: 240, golf: 90, hotel: 300, india: 150, juliet: 200, mangadex: 260 },
  fail: { charlie: true },
};

function args() {
  const out = { runs: 7, baseline: '', candidate: path.join(ROOT, 'dist-app') };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--runs') out.runs = Number(argv[++i]) || out.runs;
    else if (argv[i] === '--baseline') out.baseline = path.resolve(argv[++i]);
    else if (argv[i] === '--candidate') out.candidate = path.resolve(argv[++i]);
  }
  return out;
}

const median = (rows) => {
  const sorted = [...rows].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};
const percentile = (rows, p) => {
  const sorted = [...rows].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

function anilistBody(query) {
  const aliases = [...String(query).matchAll(/(\w+)\s*:\s*Page\(/g)].map((m) => m[1]);
  if (aliases.length) {
    const data = {};
    for (const alias of aliases) data[alias] = { media: anilistMedia(alias, 1, 20) };
    return { data };
  }
  const page = Number(String(query).match(/Page\(\s*page\s*:\s*(\d+)/)?.[1] || 1);
  return { data: { Page: { media: anilistMedia('page', page, 14) } } };
}

/** One cold visit plus one warm revisit, in a fresh browser context. */
async function runOnce(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((blob) => {
    localStorage.setItem('yomu.v1.collection', JSON.stringify(blob));
    localStorage.setItem('yomu.v1.setupDone', '1');
    localStorage.setItem('yomu.v1.adult', 'off');
  }, collection(origin));
  await context.route(/graphql\.anilist\.co/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(anilistBody(route.request().postDataJSON?.()?.query || '')),
  }));

  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__yomuBench = { start: performance.now(), longTasks: 0, shift: 0 };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__yomuBench.longTasks += entry.duration;
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__yomuBench.shift += entry.value;
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
  });

  const measure = async (selector, count) => page.evaluate(async ([sel, want]) => {
    const seen = () => document.querySelectorAll(sel).length;
    if (seen() >= want) return performance.now() - window.__yomuBench.start;
    return new Promise((resolve) => {
      const deadline = setTimeout(() => { observer.disconnect(); resolve(null); }, 30000);
      const observer = new MutationObserver(() => {
        if (seen() < want) return;
        clearTimeout(deadline);
        observer.disconnect();
        resolve(performance.now() - window.__yomuBench.start);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }, [selector, count]);

  await page.goto(origin + '/', { waitUntil: 'commit' });
  const ttf1 = await measure(CARD, 1);
  const ttf10 = await measure(CARD, 10);

  const segmentComplete = await page.evaluate(async (sel) => {
    let last = document.querySelectorAll(sel).length;
    let stable = 0;
    while (stable < 5) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const now = document.querySelectorAll(sel).length;
      stable = now === last ? stable + 1 : 0;
      last = now;
      if (performance.now() - window.__yomuBench.start > 30000) break;
    }
    return performance.now() - window.__yomuBench.start - 500;
  }, CARD);

  const vitals = await page.evaluate(() => ({ longTasks: Math.round(window.__yomuBench.longTasks), shift: Number(window.__yomuBench.shift.toFixed(4)) }));
  const cards = await page.evaluate((sel) => document.querySelectorAll(sel).length, CARD);

  // Search: first usable result, then the first cross-source addition on top
  // of it. Both are "how long until this is useful", not "until it is done".
  await page.goto(origin + '/find?q=dungeon', { waitUntil: 'commit' });
  const searchFirst = await measure(`#results ${CARD}`, 1);
  const searchFill = await measure(`#results ${CARD}`, 6);

  // Warm revisit: same context, so localStorage and the engine cache survive.
  await page.goto(origin + '/', { waitUntil: 'commit' });
  const warmRevisit = await measure(CARD, 10);

  await context.close();
  return { ttf1, ttf10, segmentComplete: Math.round(segmentComplete), searchFirst, searchFill, warmRevisit, cards, ...vitals };
}

async function benchmark(label, dist, runs) {
  process.env.YOMU_DIST = dist;
  // The module caches DIST at import time, so each tree gets its own process
  // via a fresh dynamic import of a cache-busted URL.
  const { startFixtureServer: start } = await import(`../tests/fixtures/server.mjs?dist=${encodeURIComponent(dist)}`);
  const { server, origin } = await start({ port: 0 });
  await fetch(`${origin}/__fixture/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(PROFILE),
  });

  const browser = await chromium.launch();
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const sample = await runOnce(browser, origin);
    samples.push(sample);
    process.stdout.write(`  ${label} run ${i + 1}/${runs}: ttf1=${sample.ttf1 ?? 'n/a'} ttf10=${sample.ttf10 ?? 'n/a'}\n`);
  }
  await browser.close();
  server.close();

  const round = (value, places = 0) => (value === null ? null : Number(value.toFixed(places)));
  const metric = (key, places = 0) => ({
    median: round(median(samples.map((s) => s[key])), places),
    p95: round(percentile(samples.map((s) => s[key]), 95), places),
    samples: samples.map((s) => (Number.isFinite(s[key]) ? round(s[key], places) : null)),
  });

  return {
    label,
    dist,
    runs,
    profile: PROFILE,
    metrics: {
      ttf1: metric('ttf1'),
      ttf10: metric('ttf10'),
      segmentComplete: metric('segmentComplete'),
      searchFirst: metric('searchFirst'),
      searchFill: metric('searchFill'),
      warmRevisit: metric('warmRevisit'),
      longTasks: metric('longTasks'),
      layoutShift: metric('shift', 4),
      cards: metric('cards'),
    },
  };
}

const options = args();
await fs.mkdir(OUT, { recursive: true });

const results = {};
if (options.baseline) {
  console.log(`Baseline: ${options.baseline}`);
  results.baseline = await benchmark('baseline', options.baseline, options.runs);
}
console.log(`Candidate: ${options.candidate}`);
results.candidate = await benchmark('candidate', options.candidate, options.runs);

if (results.baseline) {
  const ratio = (key) => {
    const before = results.baseline.metrics[key].median;
    const after = results.candidate.metrics[key].median;
    if (!before || !after) return null;
    return Number((after / before).toFixed(3));
  };
  const warm = results.candidate.metrics.warmRevisit.median;
  const shift = results.candidate.metrics.layoutShift.median;
  results.comparison = {
    ttf1Ratio: ratio('ttf1'),
    ttf10Ratio: ratio('ttf10'),
    segmentCompleteRatio: ratio('segmentComplete'),
    searchFirstRatio: ratio('searchFirst'),
    searchFillRatio: ratio('searchFill'),
    warmRevisitRatio: ratio('warmRevisit'),
    warmRevisitMs: warm,
    layoutShift: shift,
    /* The spec's pass conditions, all three of them, evaluated rather than
       asserted: deterministic TTF10 at or under half the baseline median, a
       warm revisit under 250ms, and no visible shift from skeleton to card. */
    ttf10PassesTwoX: ratio('ttf10') !== null && ratio('ttf10') <= 0.5,
    warmRevisitUnder250ms: warm !== null && warm < 250,
    noVisibleLayoutShift: shift !== null && shift <= 0.05,
  };
  results.comparison.pass = results.comparison.ttf10PassesTwoX
    && results.comparison.warmRevisitUnder250ms
    && results.comparison.noVisibleLayoutShift;
}

await fs.writeFile(path.join(OUT, 'benchmark.json'), JSON.stringify(results, null, 2) + '\n', 'utf8');

const rows = [['tree', 'metric', 'median_ms', 'p95_ms']];
for (const tree of ['baseline', 'candidate']) {
  if (!results[tree]) continue;
  for (const [name, value] of Object.entries(results[tree].metrics)) {
    rows.push([tree, name, value.median ?? '', value.p95 ?? '']);
  }
}
await fs.writeFile(path.join(OUT, 'benchmark.csv'), rows.map((r) => r.join(',')).join('\n') + '\n', 'utf8');

/**
 * Without a baseline there is nothing to be twice as fast as, so the run
 * becomes a budget check instead of a comparison. The numbers are the ones the
 * comparison run established on this fixture profile, with headroom for a
 * slower CI box -- they exist so a later change cannot quietly give the 6x
 * back, not as a second definition of the 2x claim.
 */
const BUDGETS = { ttf10: 1400, warmRevisit: 250, layoutShift: 0.05 };
if (!results.comparison) {
  const metrics = results.candidate.metrics;
  results.budgets = {
    ttf10Ms: metrics.ttf10.median,
    warmRevisitMs: metrics.warmRevisit.median,
    layoutShift: metrics.layoutShift.median,
    limits: BUDGETS,
    pass: metrics.ttf10.median !== null
      && metrics.ttf10.median <= BUDGETS.ttf10
      && metrics.warmRevisit.median !== null
      && metrics.warmRevisit.median < BUDGETS.warmRevisit
      && metrics.layoutShift.median !== null
      && metrics.layoutShift.median <= BUDGETS.layoutShift,
  };
  await fs.writeFile(path.join(OUT, 'benchmark.json'), JSON.stringify(results, null, 2) + '\n', 'utf8');
}

console.log(JSON.stringify(results.comparison || results.budgets || results.candidate.metrics, null, 2));
if (results.budgets && !results.budgets.pass) {
  console.error(`FAIL: loading budgets exceeded (ttf10<=${BUDGETS.ttf10}ms, warm<${BUDGETS.warmRevisit}ms, CLS<=${BUDGETS.layoutShift}).`);
  process.exitCode = 1;
}
if (results.comparison && !results.comparison.pass) {
  if (!results.comparison.ttf10PassesTwoX) console.error('FAIL: deterministic TTF10 is not at or under 50% of baseline.');
  if (!results.comparison.warmRevisitUnder250ms) console.error('FAIL: warm revisit is over the 250ms target.');
  if (!results.comparison.noVisibleLayoutShift) console.error('FAIL: skeleton-to-card layout shift is visible.');
  process.exitCode = 1;
}
