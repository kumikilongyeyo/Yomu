// @ts-check
/**
 * Full-source library behaviour: section 5 of the recovery spec.
 *
 * Every healthy enabled source contributes, each keeps its own page cursor,
 * NamiComi is excluded before fetch rather than filtered out of the render,
 * and one dead provider cannot hold the visible batch.
 */
import { expect, test } from '@playwright/test';
import { configureSources, gotoHome, resetSources, seed } from './support/app.mjs';
import { SOURCE_IDS } from './fixtures/catalog.mjs';

test.beforeEach(async ({ request, baseURL }) => {
  await resetSources(request, baseURL);
});

test('five segments walk deeper pages across providers without one monopolising', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'provider fan-out is viewport independent');
  test.setTimeout(150_000);
  await seed(page, { baseURL });
  await gotoHome(page);

  const pager = page.locator('#yomu-library-explorer [data-yomu-pager]');
  await expect(pager).toHaveCount(1);

  for (let segment = 0; segment < 5; segment += 1) {
    const before = await page.locator('#yomu-library-explorer .yt-card:not(.yt-card--skeleton)').count();
    await pager.click();
    await expect.poll(async () => page.locator('#yomu-library-explorer .yt-card:not(.yt-card--skeleton)').count(), { timeout: 40_000 })
      .toBeGreaterThan(before);
  }

  const report = await page.evaluate(() => {
    const stats = window.YomuLibraryEngine.stats();
    const cards = [...document.querySelectorAll('#yomu-library-explorer .yt-card:not(.yt-card--skeleton)')];
    const perSource = {};
    for (const card of cards) {
      const id = card.dataset.ytSource || 'unknown';
      perSource[id] = (perSource[id] || 0) + 1;
    }
    return {
      cards: cards.length,
      titles: cards.map((c) => c.querySelector('.yt-card__title').textContent.trim()),
      perSource,
      pages: stats.health.map((row) => ({ key: row.key, page: row.page })),
      sources: stats.sources,
    };
  });

  expect(report.cards, 'at least six segments of ten').toBeGreaterThanOrEqual(55);
  expect(new Set(report.titles).size, 'no duplicate titles').toBe(report.titles.length);

  const advanced = report.pages.filter((row) => row.page > 1);
  expect(advanced.length, 'several sources advanced past page 1').toBeGreaterThanOrEqual(4);
  const deepest = Math.max(...report.pages.map((row) => row.page));
  expect(deepest, 'per-source page state increments').toBeGreaterThan(1);

  const contributions = Object.values(report.perSource);
  const biggest = Math.max(...contributions);
  expect(Object.keys(report.perSource).length, 'more than one provider on screen').toBeGreaterThan(1);
  expect(biggest / report.cards, 'no provider owns the library').toBeLessThan(0.6);
});

test('NamiComi never appears in browse, search or the engine, even when enabled', async ({ page, baseURL }) => {
  await seed(page, { baseURL, nami: true });
  await gotoHome(page);

  const seen = await page.evaluate(async () => {
    const sources = await window.YomuLibraryEngine.sources(true);
    const cards = [...document.querySelectorAll('.yt-card:not(.yt-card--skeleton)')];
    return {
      enabledInCollection: (JSON.parse(localStorage.getItem('yomu.v1.collection')).sources || [])
        .some((row) => /nami/i.test(row.id)),
      engineSources: sources.map((s) => s.id),
      cardText: cards.map((c) => `${c.dataset.ytSource || ''} ${c.textContent}`).join(' | '),
      blocked: window.YomuLibraryEngine.BLOCKED_SOURCE.source,
    };
  });

  expect(seen.enabledInCollection, 'the fixture really does enable it').toBe(true);
  expect(seen.engineSources.some((id) => /nami/i.test(id)), 'engine drops it before fetch').toBe(false);
  expect(/namicomi/i.test(seen.cardText), 'no card is served by it').toBe(false);

  const requests = [];
  page.on('request', (request) => { if (/namicomi/i.test(request.url())) requests.push(request.url()); });
  await page.locator('#yomu-library-explorer [data-yomu-pager]').click();
  await page.waitForTimeout(2500);
  expect(requests, 'it is excluded before fetch, not after').toEqual([]);
});

test('one dead provider does not hold the first usable batch', async ({ page, baseURL, request }) => {
  // Two sources hang well past the segment budget, one fails outright.
  await configureSources(request, baseURL, {
    latency: { alpha: 9000, bravo: 9000 },
    fail: { charlie: true },
    baseLatency: 12,
  });
  await seed(page, { baseURL });

  const started = Date.now();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#yomu-library-explorer .yt-card:not(.yt-card--skeleton)').first().waitFor({ timeout: 45_000 });
  const firstPaint = Date.now() - started;

  await expect.poll(async () => page.locator('#yomu-library-explorer .yt-card:not(.yt-card--skeleton)').count(), { timeout: 45_000 })
    .toBeGreaterThanOrEqual(5);
  expect(firstPaint, 'healthy sources paint without waiting for the slow ones').toBeLessThan(9000);

  const sources = await page.evaluate(() => [...document.querySelectorAll('#yomu-library-explorer .yt-card:not(.yt-card--skeleton)')]
    .map((card) => card.dataset.ytSource).filter(Boolean));
  expect(new Set(sources).size).toBeGreaterThan(0);
  expect(sources.some((id) => /charlie/.test(id)), 'the failed provider contributes nothing').toBe(false);
});

test('the enabled-source count is the reader\'s list, not a capped subset', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);

  const counter = await page.locator('.yl-source-count').innerText();
  const enabled = Number((counter.match(/(\d+)\s+enabled/) || [])[1]);
  // Every fixture source except NamiComi, plus the built-in MangaDex fallback.
  expect(enabled).toBe(SOURCE_IDS.length - 1 + 1);
});
