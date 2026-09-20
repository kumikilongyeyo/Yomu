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
      await expect(rail.locator('.yr-rail__head button'), `${label}: one head button`).toHaveCount(1);
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

    await pager.click();
    await expect(pager).toHaveText(/More|End/, { timeout: 20_000 });
    await expect(rail.locator('[data-yomu-pager]')).toHaveCount(1);
  });

  test('More appends in place and never routes to Discover or Search', async ({ page, baseURL }) => {
    await seed(page, { baseURL });
    await gotoHome(page);
    await waitForRails(page, 4);

    const rail = page.locator('.yr-rail').first();
    const strip = rail.locator('.yr-strip');
    const before = await strip.locator('.yt-card:not(.yt-card--skeleton)').count();
    const url = page.url();

    const pager = rail.locator('[data-yomu-pager]');
    await expect(pager).toHaveJSProperty('tagName', 'BUTTON');
    await pager.click();

    await expect.poll(async () => strip.locator('.yt-card:not(.yt-card--skeleton)').count(), { timeout: 25_000 })
      .toBeGreaterThan(before);
    expect(page.url(), 'More must not navigate').toBe(url);
    await expect(page.locator('#yomu-library-explorer')).toHaveCount(1);
  });

  test('rapid clicking requests one page and appends no duplicates', async ({ page, baseURL }) => {
    await seed(page, { baseURL });
    await gotoHome(page);
    await waitForRails(page, 4);

    /* Only the rail's own page request counts. The ratings engine also talks
       to AniList on a timer for covers that arrived without a score, and
       counting those would measure the wrong thing. */
    const requests = [];
    page.on('request', (request) => {
      if (!/graphql\.anilist\.co/.test(request.url())) return;
      if (/Page\(page:/.test(String(request.postData() || ''))) requests.push(request.url());
    });

    const rail = page.locator('.yr-rail').first();
    const pager = rail.locator('[data-yomu-pager]');
    const before = await rail.locator('.yt-card:not(.yt-card--skeleton)').count();

    const start = requests.length;
    /* A real triple click: three events in one task, without Playwright's
       actionability wait turning them into three sequential presses. The
       second and third land while the first is in flight, which is exactly
       the case the in-flight guard exists for. Both paths are covered --
       .click() (suppressed on a disabled control) and a dispatched event
       (delivered to the listener anyway). */
    await page.evaluate(() => {
      const button = document.querySelector('.yr-rail [data-yomu-pager]');
      button.click();
      button.click();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await expect(pager).toHaveText(/More|End/, { timeout: 25_000 });
    await page.waitForTimeout(800);

    expect(requests.length - start, 'one in-flight page per click burst').toBeLessThanOrEqual(1);

    const titles = await rail.locator('.yt-card__title').allInnerTexts();
    const unique = new Set(titles.map((t) => t.trim().toLowerCase()));
    expect(unique.size, 'no duplicate titles appended').toBe(titles.length);
    expect(titles.length).toBeGreaterThan(before);
  });
});

test.describe('Regression B — no leaked Retry, no second action', () => {
  test('a failed page keeps the cards, shows Retry on the same control, and recovers', async ({ page, baseURL }) => {
    await seed(page, { baseURL, anilistFailPages: [2] });
    await gotoHome(page);
    await waitForRails(page, 4);

    const rail = page.locator('.yr-rail').first();
    const pager = rail.locator('[data-yomu-pager]');
    const before = await rail.locator('.yt-card:not(.yt-card--skeleton)').count();

    await pager.click();
    await expect(pager).toHaveText('Retry', { timeout: 25_000 });
    await expect(rail.locator('[data-yomu-pager]'), 'still exactly one control').toHaveCount(1);
    await expect(rail.locator('.yt-card:not(.yt-card--skeleton)')).toHaveCount(before);

    // Page 2 is allowed through on the retry: the control must return to More.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await seed(page, { baseURL });
    await pager.click();
    await expect(pager).toHaveText(/More|End/, { timeout: 25_000 });
    await expect(rail.locator('[data-yomu-pager]')).toHaveCount(1);
  });

  test('the control label is deterministic', async ({ page, baseURL }) => {
    await seed(page, { baseURL });
    await gotoHome(page);
    await waitForRails(page, 4);

    const pager = page.locator('.yr-rail').first().locator('[data-yomu-pager]');
    await expect(pager).toHaveText('More');
    const seen = new Set();
    const stop = Date.now() + 12_000;
    await pager.click();
    while (Date.now() < stop) {
      seen.add((await pager.innerText()).trim());
      if (/^(More|End)$/.test((await pager.innerText()).trim()) && seen.has('Loading…')) break;
      await page.waitForTimeout(60);
    }
    for (const label of seen) {
      expect(['More', 'Loading…', 'End', 'Retry'], `unexpected label ${label}`).toContain(label);
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
