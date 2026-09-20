// @ts-check
/**
 * Search depth, category depth, navigation and the loading rule.
 *
 * Sections 3, 5 and 6 of the recovery spec: More results must walk source
 * page 2+ rather than re-asking page 1, a filter must survive several loads,
 * back-navigation must come back warm and with one control per surface, and
 * the global loader is allowed only on a genuinely blank screen.
 */
import { expect, test } from '@playwright/test';
import { DISCOVER, gotoHome, resetSources, seed, waitForRails, watchConsole } from './support/app.mjs';

const LIVE_CARD = '.yt-card:not(.yt-card--skeleton)';

test.beforeEach(async ({ request, baseURL }) => {
  await resetSources(request, baseURL);
});

test('More results walks deeper source pages and appends unique titles in place', async ({ page, baseURL }) => {
  await seed(page, { baseURL });

  const pages = [];
  page.on('request', (request) => {
    const url = new URL(request.url(), baseURL);
    if (!/\/api\/ext\/source\/.+\/search$/.test(url.pathname)) return;
    pages.push(Number(url.searchParams.get('page') || '1'));
  });

  await page.goto(`${DISCOVER}?q=dungeon`, { waitUntil: 'domcontentloaded' });
  await page.locator(`#results ${LIVE_CARD}`).first().waitFor({ timeout: 45_000 });

  const pager = page.locator('.yomu-search-more-wrap [data-yomu-pager]');
  await expect(pager, 'one More results control').toHaveCount(1);
  await expect(pager).toHaveText('More results');

  const before = await page.locator(`#results ${LIVE_CARD}`).count();
  const url = page.url();
  await pager.click();
  await expect(pager).toHaveText(/More results|End/, { timeout: 40_000 });

  const after = await page.locator(`#results ${LIVE_CARD}`).count();
  expect(after, 'results were appended').toBeGreaterThan(before);
  expect(page.url(), 'appended in place').toBe(url);
  expect(Math.max(...pages), 'asked for page 2 or deeper').toBeGreaterThanOrEqual(2);
  expect(pages.filter((p) => p >= 2).length, 'several sources went deeper').toBeGreaterThan(1);

  const titles = await page.locator(`#results ${LIVE_CARD} .yt-card__title`).allInnerTexts();
  const unique = new Set(titles.map((t) => t.trim().toLowerCase()));
  expect(unique.size, 'no duplicate results').toBe(titles.length);

  // A second press goes deeper again rather than repeating page 2.
  const deepest = Math.max(...pages);
  await pager.click();
  await expect(pager).toHaveText(/More results|End/, { timeout: 40_000 });
  expect(Math.max(...pages), 'per-source page state advanced').toBeGreaterThan(deepest);
  await expect(page.locator('.yomu-search-more-wrap [data-yomu-pager]')).toHaveCount(1);
});

test('a category filter survives several loads', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await page.goto(DISCOVER, { waitUntil: 'domcontentloaded' });
  await page.locator(`#yomu-library-explorer ${LIVE_CARD}`).first().waitFor({ timeout: 45_000 });

  const manhwa = page.locator('#yomu-library-explorer [data-yl-type="manhwa"]');
  await manhwa.click();
  await expect(manhwa).toHaveAttribute('aria-pressed', 'true');
  await page.locator(`#yomu-library-explorer ${LIVE_CARD}`).first().waitFor({ timeout: 45_000 });

  const pager = page.locator('#yomu-library-explorer [data-yomu-pager]');
  for (let i = 0; i < 2; i += 1) {
    const before = await page.locator(`#yomu-library-explorer ${LIVE_CARD}`).count();
    await pager.click();
    await expect.poll(async () => page.locator(`#yomu-library-explorer ${LIVE_CARD}`).count(), { timeout: 40_000 })
      .toBeGreaterThan(before);
    await expect(manhwa, 'the filter is still active after a load').toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#yomu-library-explorer [data-yomu-pager]')).toHaveCount(1);
  }

  const notes = await page.locator(`#yomu-library-explorer ${LIVE_CARD} .yt-card__note`).allInnerTexts();
  expect(notes.length).toBeGreaterThan(0);
  expect(notes.every((note) => /manhwa/i.test(note)), 'every loaded title matches the filter').toBe(true);
});

test('More genres discloses in place without destroying results', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await page.goto(DISCOVER, { waitUntil: 'domcontentloaded' });
  await page.locator(`#yomu-library-explorer ${LIVE_CARD}`).first().waitFor({ timeout: 45_000 });

  const manhwa = page.locator('#yomu-library-explorer [data-yl-type="manhwa"]');
  await manhwa.click();
  await expect(manhwa).toHaveAttribute('aria-pressed', 'true');
  await page.locator(`#yomu-library-explorer ${LIVE_CARD}`).first().waitFor({ timeout: 45_000 });

  const chips = page.locator('#yomu-library-explorer [data-yl-genre]');
  const before = { chips: await chips.count(), cards: await page.locator(`#yomu-library-explorer ${LIVE_CARD}`).count() };

  const disclose = page.locator('#yomu-library-explorer [data-yl-genres-more]');
  await expect(disclose, 'exactly one disclosure').toHaveCount(1);
  await expect(disclose).toHaveAttribute('aria-expanded', 'false');
  await disclose.click();

  await expect(disclose).toHaveAttribute('aria-expanded', 'true');
  expect(await chips.count(), 'more genres are exposed').toBeGreaterThan(before.chips);
  await page.waitForTimeout(700);
  expect(await page.locator(`#yomu-library-explorer ${LIVE_CARD}`).count(), 'results are untouched').toBe(before.cards);
  await expect(manhwa, 'the active type survives the disclosure').toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#yomu-library-explorer [data-yomu-pager]')).toHaveCount(1);

  // And it collapses again without touching results.
  await disclose.click();
  await expect(disclose).toHaveAttribute('aria-expanded', 'false');
  expect(await chips.count()).toBe(before.chips);
  expect(await page.locator(`#yomu-library-explorer ${LIVE_CARD}`).count()).toBe(before.cards);
});

test('back navigation returns warm, with one control per surface', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);
  await waitForRails(page, 4);

  await page.goto(DISCOVER, { waitUntil: 'domcontentloaded' });
  await page.locator(`#yomu-library-explorer ${LIVE_CARD}`).first().waitFor({ timeout: 45_000 });

  const started = Date.now();
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.locator(`#yomu-library-explorer ${LIVE_CARD}`).first().waitFor({ timeout: 45_000 });
  const warm = Date.now() - started;

  expect(warm, 'a warm revisit paints quickly').toBeLessThan(6000);
  await expect(page.locator('#yomu-library-explorer [data-yomu-pager]')).toHaveCount(1);
  const rails = page.locator('.yr-rail');
  for (let i = 0; i < await rails.count(); i += 1) {
    await expect(rails.nth(i).locator('[data-yomu-pager]')).toHaveCount(1);
  }

  // And the counter is still honest on the way back.
  const counter = await page.locator('.yl-source-count').innerText();
  const responding = Number((counter.match(/(\d+)\s+responding/) || [])[1] || 0);
  const cards = await page.locator(`#yomu-library-explorer ${LIVE_CARD}`).count();
  if (cards > 0) expect(responding).toBeGreaterThan(0);

  await page.goForward({ waitUntil: 'domcontentloaded' });
  await page.locator(`#yomu-library-explorer ${LIVE_CARD}`).first().waitFor({ timeout: 45_000 });
  await expect(page.locator('#yomu-library-explorer [data-yomu-pager]')).toHaveCount(1);
});

test('the global loader is allowed only on a blank screen', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);
  await waitForRails(page, 4);

  // Background work turns the loader on while content is already painted.
  const withContent = await page.evaluate(async () => {
    const loader = document.getElementById('yomu-load');
    if (!loader) return { present: false };
    loader.classList.add('on');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const style = getComputedStyle(loader);
    return {
      present: true,
      blankAttr: document.documentElement.getAttribute('data-yomu-blank-loading'),
      display: style.display,
      visible: loader.getBoundingClientRect().height > 8 && style.display !== 'none',
    };
  });

  if (withContent.present) {
    expect(withContent.blankAttr, 'usable content on screen means no global loader').toBeNull();
    expect(withContent.visible, 'no persistent loading badge over content').toBe(false);
  }

  // The same request on a genuinely blank surface is allowed to show.
  const whenBlank = await page.evaluate(async () => {
    const loader = document.getElementById('yomu-load');
    if (!loader) return { present: false };
    for (const node of document.querySelectorAll('.g-main, main, [role="main"]')) node.remove();
    loader.classList.add('on');
    await new Promise((resolve) => setTimeout(resolve, 260));
    return { present: true, blankAttr: document.documentElement.getAttribute('data-yomu-blank-loading') };
  });
  if (whenBlank.present) expect(whenBlank.blankAttr).toBe('1');
});

test('Discover paints without console errors', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  const watch = watchConsole(page);
  await page.goto(`${DISCOVER}?q=dungeon`, { waitUntil: 'domcontentloaded' });
  await page.locator(`#results ${LIVE_CARD}`).first().waitFor({ timeout: 45_000 });
  await page.waitForTimeout(1500);
  expect(watch.problems, watch.problems.join('\n')).toEqual([]);
  expect(watch.known.length, watch.known.join('\n')).toBeLessThanOrEqual(1);
});
