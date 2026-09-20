#!/usr/bin/env node
/**
 * Capture the recovery evidence pair.
 *
 * `node tools/recovery-evidence.mjs before|after` drives the fixture app with
 * the same seeding the runtime gauntlet uses and writes screenshots plus a
 * JSON summary under docs/recovery/. The PR shows the two side by side, which
 * is the only honest way to claim a screenshot regression is fixed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startFixtureServer } from '../tests/fixtures/server.mjs';
import { collection, anilistMedia } from '../tests/fixtures/catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'recovery');
const phase = (process.argv[2] || 'after').replace(/[^a-z]/g, '') || 'after';
/* `YOMU_DIST=../yomu-baseline/dist-app node tools/recovery-evidence.mjs before`
   captures the "before" half from the tree it actually came from, so the pair
   is reproducible by anyone with the two checkouts rather than only by whoever
   happened to run it before the edit. */

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

const { server, origin } = await startFixtureServer({ port: 0 });
await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
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
await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
await page.locator('.yr-rail').first().waitFor({ timeout: 45_000 }).catch(() => {});
await page.waitForTimeout(6000);

const READ = () => {
  const rails = [...document.querySelectorAll('.yr-rail')].map((rail) => ({
    title: rail.querySelector('.yr-rail__title')?.textContent?.trim(),
    controls: [...rail.querySelectorAll('button')].map((b) => `${b.className}|${b.textContent.trim()}`),
  }));
  const counter = document.querySelector('.yl-source-count')?.textContent?.replace(/\s+/g, ' ').trim() || '';
  /* `.yl-card` inside #yomu-load is the loader's own card, not a title. */
  const legacy = [...document.querySelectorAll('.yl-card')].filter((n) => !n.closest('#yomu-load'));
  return {
    rails,
    railControlCounts: rails.map((r) => r.controls.length),
    canonicalCards: document.querySelectorAll('.yt-card:not(.yt-card--skeleton)').length,
    legacyLibraryCards: legacy.length,
    genericMore: document.querySelectorAll('.yomu-generic-more').length,
    sourceCounter: counter,
    respondingClaim: Number((counter.match(/(\d+)\s+responding/) || [])[1] ?? -1),
    sourceBackedCards: document.querySelectorAll('[data-yt-source]').length + legacy.length,
  };
};

const summary = await page.evaluate(READ);

/* The warm revisit, because that is the visit the source counter used to lie
   on: the cache serves the segment, nothing is fetched, no health event fires.
   A cold load alone would show the bug fixed that was never visible. */
await page.goto(origin + '/find', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
summary.warmRevisit = await page.evaluate(READ);
const warmShot = page.locator('#yomu-library-explorer');
if (await warmShot.count()) await warmShot.first().screenshot({ path: path.join(OUT, `${phase}-warm-library.png`) });
await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const rails = page.locator('.yr-wrap');
if (await rails.count()) await rails.first().screenshot({ path: path.join(OUT, `${phase}-rails.png`) });
const library = page.locator('#yomu-library-explorer');
if (await library.count()) await library.first().screenshot({ path: path.join(OUT, `${phase}-full-library.png`) });
await page.screenshot({ path: path.join(OUT, `${phase}-home.png`), fullPage: false });

await fs.writeFile(path.join(OUT, `${phase}-summary.json`), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(summary, null, 2));

await browser.close();
server.close();
