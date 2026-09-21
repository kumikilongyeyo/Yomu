// @ts-check
/**
 * The three screenshots in Yomu_Recovery_Spec, as executable acceptance tests.
 *
 * Figure 1 — two More controls on one rail.
 * Figure 2 — a second action plus a leaked Retry pill on a working rail.
 * Figure 3 — Full Library drawing a different card system, reporting
 *            "0 responding" while source-backed titles are on screen.
 *
 * Runs on every viewport project, because a duplicate control that only
 * appears at 390px is still a duplicate control.
 */
import { expect, test } from '@playwright/test';
import { gotoHome, resetSources, seed, waitForRails, watchConsole } from './support/app.mjs';

const LIVE_CARD = '.yt-card:not(.yt-card--skeleton)';

test.beforeEach(async ({ request, baseURL }) => {
  await resetSources(request, baseURL);
});

test.describe('Regression A — one pagination owner per rail', () => {
  test('every rail header carries exactly one More control', async ({ page, baseURL }) => {
    await seed(page, { baseURL });
    await gotoHome(page);
    await waitForRails(page, 4);

    const rails = page.locator('.yr-rail');
    const count = await rails.count();
    expect(count, 'home renders ranked rails').toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const rail = rails.nth(i);
      const label = (await rail.locator('.yr-rail__title').innerText()).trim();
      await expect(rail.locator('[data-yomu-pager]'), `${label}: one pager`).toHaveCount(1);
      /* Of any kind: the rail's is an anchor because it navigates, and the
         point is that there is one of them, not what tag it wears. */
      await expect(rail.locator('.yr-rail__head > a, .yr-rail__head > button'), `${label}: one head control`).toHaveCount(1);
    }

    // Nothing anywhere on the page may still be building the legacy second
    // control, whatever it decides to call itself.
    await expect(page.locator('.yomu-generic-more')).toHaveCount(0);
  });

  test('the count stays one through re-render, resize and content growth', async ({ page, baseURL }) => {
    await seed(page, { baseURL });
    await gotoHome(page);
    await waitForRails(page, 4);

    const rail = page.locator('.yr-rail').first();
    const pager = rail.locator('[data-yomu-pager]');
    await expect(pager).toHaveCount(1);

    // A React pass that re-appends the feed, the shape that produced Figure 1.
    await page.evaluate(() => {
      const main = document.querySelector('.g-main') || document.body;
      for (const node of [...main.children]) main.append(node);
    });
    await page.waitForTimeout(400);
    await expect(pager).toHaveCount(1);

    const size = page.viewportSize();
    await page.setViewportSize({ width: Math.max(390, size.width - 180), height: size.height });
    await page.waitForTimeout(400);
    await expect(pager).toHaveCount(1);
    await page.setViewportSize(size);

    /* And it still points at this shelf rather than at a stale one. */
    await expect(pager).toHaveAttribute('href', /\/more\?kind=rail&id=\w+/);
    await expect(rail.locator('.yr-rail__head > a, .yr-rail__head > button')).toHaveCount(1);
  });

  test('See all opens the whole shelf on its own screen, with a way back', async ({ page, baseURL }) => {
    await seed(page, { baseURL });
    await gotoHome(page);
    await waitForRails(page, 4);

    const rail = page.locator('.yr-rail').first();
    const control = rail.locator('[data-yomu-pager]');
    /* A control that navigates is a link, and is named for navigating. The
       recovery spec asks for exactly that distinction: "a separately named
       action such as View all". */
    await expect(control).toHaveJSProperty('tagName', 'A');
    await expect(control).toHaveText('See all');
    await expect(control).toHaveAttribute('href', /\/more\?kind=rail&id=\w+/);

    const railCards = await rail.locator(LIVE_CARD).count();
    await control.click();

    await page.waitForURL(/\/more\?kind=rail/, { timeout: 30_000 });
    await page.locator('#results ' + LIVE_CARD).first().waitFor({ timeout: 45_000 });
    const onScreen = await page.locator('#results ' + LIVE_CARD).count();
    expect(onScreen, 'the shelf screen shows more than the rail did').toBeGreaterThan(railCards);

    // It is a grid that grows downwards, which is the whole point.
    const layout = await page.evaluate(() => {
      const grid = document.querySelector('#results');
      const cards = [...grid.querySelectorAll('.yt-card:not(.yt-card--skeleton)')];
      const rows = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top / 20)));
      return { columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, rows: rows.size };
    });
    expect(layout.columns, 'a grid, not a strip').toBeGreaterThan(1);
    expect(layout.rows, 'more than one row of it').toBeGreaterThan(1);

    // And a back button that goes back.
    const back = page.locator('#back');
    await expect(back).toBeVisible();
    await back.click();
    await page.waitForURL((url) => !/\/more/.test(url.pathname + url.search), { timeout: 30_000 });
    await waitForRails(page, 4);
    await expect(page.locator('.yr-rail').first().locator('[data-yomu-pager]')).toHaveCount(1);
  });

  test('the shelf screen appends in place, once per burst, without duplicates', async ({ page, baseURL }) => {
    await seed(page, { baseURL });
    await page.goto('/more?kind=rail&id=trending&type=all', { waitUntil: 'domcontentloaded' });
    await page.locator('#results ' + LIVE_CARD).first().waitFor({ timeout: 45_000 });

    const requests = [];
    page.on('request', (request) => {
      if (!/graphql\.anilist\.co/.test(request.url())) return;
      if (/Page\(page: \d/.test(String(request.postData() || ''))) requests.push(request.url());
    });

    const pager = page.locator('[data-yomu-pager]');
    await expect(pager, 'one control on the shelf screen').toHaveCount(1);
    await expect(pager).toHaveJSProperty('tagName', 'BUTTON');
    const before = await page.locator('#results ' + LIVE_CARD).count();
    const url = page.url();

    /* Three events in one task: the second and third land while the first is
       in flight, which is the case the in-flight guard exists for. */
    await page.evaluate(() => {
      const button = document.querySelector('[data-yomu-pager]');
      button.click();
      button.click();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await expect(pager).toHaveText(/Load more|End/, { timeout: 30_000 });
    await page.waitForTimeout(600);

    expect(requests.length, 'one in-flight page per burst').toBeLessThanOrEqual(1);
    expect(page.url(), 'appended in place').toBe(url);
    await expect(page.locator('[data-yomu-pager]')).toHaveCount(1);

    const titles = await page.locator('#results .yt-card__title').allInnerTexts();
    expect(titles.length).toBeGreaterThan(before);
    expect(new Set(titles.map((t) => t.trim().toLowerCase())).size, 'no duplicates').toBe(titles.length);
  });
});

test.describe('Regression B — no leaked Retry, no second action', () => {
  test('a failed page keeps the cards, shows Retry on the same control, and recovers', async ({ page, baseURL }) => {
    await seed(page, { baseURL, anilistFailPages: [2] });
    await page.goto('/more?kind=rail&id=trending&type=all', { waitUntil: 'domcontentloaded' });
    await page.locator('#results ' + LIVE_CARD).first().waitFor({ timeout: 45_000 });

    const pager = page.locator('[data-yomu-pager]');
    const before = await page.locator('#results ' + LIVE_CARD).count();

    await pager.click();
    await expect(pager).toHaveText('Retry', { timeout: 30_000 });
    await expect(page.locator('[data-yomu-pager]'), 'still exactly one control').toHaveCount(1);
    await expect(page.locator('#results ' + LIVE_CARD), 'nothing was taken off the screen').toHaveCount(before);

    // Page 2 is allowed through on the retry: the control returns to Load more.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await seed(page, { baseURL });
    await pager.click();
    await expect(pager).toHaveText(/Load more|End/, { timeout: 30_000 });
    await expect(page.locator('[data-yomu-pager]')).toHaveCount(1);
    expect(await page.locator('#results ' + LIVE_CARD).count()).toBeGreaterThan(before);
  });

  test('the control label is deterministic', async ({ page, baseURL }) => {
    await seed(page, { baseURL });
    await page.goto('/more?kind=rail&id=trending&type=all', { waitUntil: 'domcontentloaded' });
    await page.locator('#results ' + LIVE_CARD).first().waitFor({ timeout: 45_000 });

    const pager = page.locator('[data-yomu-pager]');
    await expect(pager).toHaveText('Load more');
    const seen = new Set();
    const stop = Date.now() + 12_000;
    await pager.click();
    while (Date.now() < stop) {
      const label = (await pager.innerText()).trim();
      seen.add(label);
      if (/^(Load more|End)$/.test(label) && seen.has('Loading…')) break;
      await page.waitForTimeout(60);
    }
    for (const label of seen) {
      expect(['Load more', 'Loading…', 'End', 'Retry'], `unexpected label ${label}`).toContain(label);
    }
  });
});

test.describe('Regression C — one card system, truthful source telemetry', () => {
  test('Full Library and the rails draw the same canonical card', async ({ page, baseURL }) => {
    await seed(page, { baseURL });
    await gotoHome(page);
    await waitForRails(page, 4);

    await expect(page.locator('#yomu-library-explorer .yt-card:not(.yt-card--skeleton)').first()).toBeVisible();
    // The legacy renderers are gone, not hidden.
    await expect(page.locator('.yl-card')).toHaveCount(0);

    const geometry = await page.evaluate(() => {
      const read = (node) => {
        const art = node.querySelector('.yt-card__art');
        const style = getComputedStyle(art);
        const box = art.getBoundingClientRect();
        return {
          radius: style.borderTopLeftRadius,
          ratio: Math.round((box.width / box.height) * 100) / 100,
          titleSize: getComputedStyle(node.querySelector('.yt-card__title')).fontSize,
          clamp: getComputedStyle(node.querySelector('.yt-card__title')).webkitLineClamp,
        };
      };
      return {
        rail: read(document.querySelector('.yr-rail .yt-card:not(.yt-card--skeleton)')),
        library: read(document.querySelector('#yomu-library-explorer .yt-card:not(.yt-card--skeleton)')),
      };
    });
    expect(geometry.library.radius).toBe(geometry.rail.radius);
    expect(geometry.library.titleSize).toBe(geometry.rail.titleSize);
    expect(geometry.library.clamp).toBe(geometry.rail.clamp);
    expect(Math.abs(geometry.library.ratio - 0.667)).toBeLessThan(0.02);
    expect(Math.abs(geometry.rail.ratio - 0.667)).toBeLessThan(0.02);
  });

  test('a card with no cover is the same shape as one with a cover', async ({ page, baseURL }) => {
    await seed(page, { baseURL });
    await gotoHome(page);

    const boxes = await page.evaluate(() => {
      const grid = document.querySelector('#yomu-library-explorer .yt-grid');
      const probe = document.createElement('div');
      probe.innerHTML = '';
      const card = window.YomuTitleCard.create({ title: 'No cover at all', providers: [{ name: 'Alpha Comics' }] });
      grid.append(card);
      const withCover = grid.querySelector('.yt-card:not(:last-child)').getBoundingClientRect();
      const without = card.getBoundingClientRect();
      card.remove();
      probe.remove();
      return { withCover: { w: withCover.width, h: withCover.height }, without: { w: without.width, h: without.height } };
    });
    expect(Math.abs(boxes.withCover.w - boxes.without.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(boxes.withCover.h - boxes.without.h)).toBeLessThanOrEqual(1);
  });

  test('"0 responding" is impossible while source-backed cards are on screen', async ({ page, baseURL }) => {
    await seed(page, { baseURL });
    await gotoHome(page);

    const counter = page.locator('.yl-source-count');
    await expect(counter).toBeVisible();
    await expect.poll(async () => {
      const text = await counter.innerText();
      const responding = Number((text.match(/(\d+)\s+responding/) || [])[1] || 0);
      const cards = await page.locator('#yomu-library-explorer .yt-card:not(.yt-card--skeleton)[data-yt-source]').count();
      return cards > 0 && responding === 0 ? 'lying' : 'honest';
    }, { timeout: 30_000 }).toBe('honest');

    const text = (await counter.innerText()).replace(/\s+/g, ' ').trim();
    expect(text).toMatch(/\d+ enabled sources? · \d+ responding/);
    expect(Number((text.match(/(\d+)\s+responding/) || [])[1])).toBeGreaterThan(0);
  });

  test('the counter survives a re-render that remounts the explorer', async ({ page, baseURL }) => {
    await seed(page, { baseURL });
    await gotoHome(page);
    await expect.poll(async () => Number(((await page.locator('.yl-source-count').innerText()).match(/(\d+)\s+responding/) || [])[1] || 0),
      { timeout: 30_000 }).toBeGreaterThan(0);

    await page.evaluate(() => {
      const main = document.querySelector('.g-main') || document.body;
      for (const node of [...main.children]) main.append(node);
    });
    await page.waitForTimeout(800);
    const responding = Number(((await page.locator('.yl-source-count').innerText()).match(/(\d+)\s+responding/) || [])[1] || 0);
    const cards = await page.locator('#yomu-library-explorer .yt-card:not(.yt-card--skeleton)').count();
    expect(cards).toBeGreaterThan(0);
    expect(responding).toBeGreaterThan(0);
  });
});

test('home paints without console errors or unhandled rejections', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  const watch = watchConsole(page);
  await gotoHome(page);
  await waitForRails(page, 4);
  await page.waitForTimeout(1500);
  expect(watch.problems, watch.problems.join('\n')).toEqual([]);
  /* The one documented exception cannot become a hiding place: exactly one
     recoverable hydration warning from the Expo bundle, and nothing else. */
  expect(watch.known.length, watch.known.join('\n')).toBeLessThanOrEqual(1);
});
