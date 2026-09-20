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

const summary = await page.evaluate(() => {
  const rails = [...document.querySelectorAll('.yr-rail')].map((rail) => ({
    title: rail.querySelector('.yr-rail__title')?.textContent?.trim(),
    controls: [...rail.querySelectorAll('button')].map((b) => `${b.className}|${b.textContent.trim()}`),
  }));
  const counter = document.querySelector('.yl-source-count')?.textContent?.trim() || '';
  return {
    rails,
    railControlCounts: rails.map((r) => r.controls.length),
    canonicalCards: document.querySelectorAll('.yt-card').length,
    legacyLibraryCards: document.querySelectorAll('.yl-card').length,
    legacyRailCards: document.querySelectorAll('.yr-card:not(.yt-card)').length,
    genericMore: document.querySelectorAll('.yomu-generic-more').length,
    sourceCounter: counter,
    respondingClaim: Number((counter.match(/(\d+)\s+responding/) || [])[1] ?? -1),
  };
});

const rails = page.locator('.yr-wrap');
if (await rails.count()) await rails.first().screenshot({ path: path.join(OUT, `${phase}-rails.png`) });
const library = page.locator('#yomu-library-explorer');
if (await library.count()) await library.first().screenshot({ path: path.join(OUT, `${phase}-full-library.png`) });
await page.screenshot({ path: path.join(OUT, `${phase}-home.png`), fullPage: false });

await fs.writeFile(path.join(OUT, `${phase}-summary.json`), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(summary, null, 2));

await browser.close();
server.close();
