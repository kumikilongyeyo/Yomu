// @ts-check
/**
 * Card, rating, tag and skeleton parity.
 *
 * Section 4 of the recovery spec asks for one canonical TitleCard owning
 * geometry, title treatment, rating placement, status tags, the provenance
 * slot and the loading skeleton. These tests measure the rendered result on
 * every required viewport rather than grepping for a class name.
 */
import { expect, test } from '@playwright/test';
import { DISCOVER, gotoHome, resetSources, seed, waitForRails } from './support/app.mjs';

test.beforeEach(async ({ request, baseURL }) => {
  await resetSources(request, baseURL);
});

/** Geometry a card's shape depends on, read off the live element. */
const READ_GEOMETRY = (selector) => {
  const node = document.querySelector(selector);
  if (!node) return null;
  const art = node.querySelector('.yt-card__art');
  const title = node.querySelector('.yt-card__title');
  const artStyle = getComputedStyle(art);
  const titleStyle = getComputedStyle(title);
  const artBox = art.getBoundingClientRect();
  const bodyBox = node.querySelector('.yt-card__body').getBoundingClientRect();
  return {
    radius: artStyle.borderTopLeftRadius,
    ratio: Math.round((artBox.width / artBox.height) * 1000) / 1000,
    titleSize: titleStyle.fontSize,
    titleWeight: titleStyle.fontWeight,
    clamp: titleStyle.webkitLineClamp,
    bodyHeight: Math.round(bodyBox.height),
    tag: node.tagName,
  };
};

test('Home rails and Home full library are the same card', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);
  await waitForRails(page, 4);

  const rail = await page.evaluate(READ_GEOMETRY, '.yr-rail .yt-card:not(.yt-card--skeleton)');
  const library = await page.evaluate(READ_GEOMETRY, '#yomu-library-explorer .yt-card:not(.yt-card--skeleton)');
  expect(library.radius).toBe(rail.radius);
  expect(library.titleSize).toBe(rail.titleSize);
  expect(library.titleWeight).toBe(rail.titleWeight);
  expect(library.clamp).toBe(rail.clamp);
  expect(library.bodyHeight).toBe(rail.bodyHeight);
  expect(Math.abs(library.ratio - 2 / 3)).toBeLessThan(0.02);
  expect(Math.abs(rail.ratio - 2 / 3)).toBeLessThan(0.02);
});

test('Discover search results are the same card as Home', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);
  await waitForRails(page, 4);
  const home = await page.evaluate(READ_GEOMETRY, '.yr-rail .yt-card:not(.yt-card--skeleton)');

  await page.goto(`${DISCOVER}?q=dungeon`, { waitUntil: 'domcontentloaded' });
  await page.locator('#results .yt-card:not(.yt-card--skeleton)').first().waitFor({ timeout: 45_000 });
  const search = await page.evaluate(READ_GEOMETRY, '#results .yt-card:not(.yt-card--skeleton)');

  expect(search.radius).toBe(home.radius);
  expect(search.titleSize).toBe(home.titleSize);
  expect(search.clamp).toBe(home.clamp);
  expect(search.bodyHeight).toBe(home.bodyHeight);
  expect(Math.abs(search.ratio - 2 / 3)).toBeLessThan(0.02);
  // No surface may still be drawing the old cover-filled tile.
  await expect(page.locator('#results .tile')).toHaveCount(0);
});

test('the same score renders the same chip in the same corner on every surface', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);
  await waitForRails(page, 4);

  const corners = await page.evaluate(() => {
    const row = { title: 'Parity probe', cover: '', score: 88, providers: [{ name: 'Alpha Comics', id: 'yomuext-alpha' }] };
    const hosts = {
      rail: document.querySelector('.yr-strip'),
      library: document.querySelector('#yomu-library-explorer .yt-grid'),
    };
    const out = {};
    for (const [name, host] of Object.entries(hosts)) {
      const card = window.YomuTitleCard.create(row);
      host.append(card);
      const art = card.querySelector('.yt-card__art').getBoundingClientRect();
      const chip = card.querySelector('.yt-card__rating');
      const box = chip.getBoundingClientRect();
      out[name] = {
        text: chip.textContent.replace(/\s+/g, ''),
        right: Math.round(art.right - box.right),
        bottom: Math.round(art.bottom - box.bottom),
        classes: [...chip.classList].filter((c) => c.startsWith('yt-') || c.startsWith('ytg')).sort().join(' '),
      };
      card.remove();
    }
    // A row with no score must not invent one.
    const bare = window.YomuTitleCard.create({ title: 'No score', providers: [] });
    hosts.rail.append(bare);
    out.missing = {
      chips: bare.querySelectorAll('.yt-card__rating').length,
      height: Math.round(bare.querySelector('.yt-card__body').getBoundingClientRect().height),
    };
    bare.remove();
    return out;
  });

  expect(corners.rail.text).toContain('8.8');
  expect(corners.library.text).toBe(corners.rail.text);
  expect(corners.library.right).toBe(corners.rail.right);
  expect(corners.library.bottom).toBe(corners.rail.bottom);
  expect(corners.library.classes).toBe(corners.rail.classes);
  expect(corners.missing.chips, 'a missing score omits the chip').toBe(0);
});

test('status tags use one badge component in one position', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);
  await waitForRails(page, 4);

  const badges = await page.evaluate(() => {
    const host = document.querySelector('.yr-strip');
    const out = {};
    for (const label of ['Trending', 'Gem', 'New', 'Completed']) {
      const card = window.YomuTitleCard.create({ title: label + ' probe' }, { badge: label });
      host.append(card);
      const art = card.querySelector('.yt-card__art').getBoundingClientRect();
      const badge = card.querySelector('.yt-card__badge');
      const box = badge.getBoundingClientRect();
      out[label] = {
        text: badge.textContent.replace(/\s+/g, ''),
        left: Math.round(box.left - art.left),
        top: Math.round(box.top - art.top),
        height: Math.round(box.height),
        component: badge.classList.contains('ytg'),
      };
      card.remove();
    }
    return out;
  });

  const shapes = Object.values(badges);
  for (const shape of shapes) {
    expect(shape.component, 'one chip component').toBe(true);
    expect(shape.left).toBe(shapes[0].left);
    expect(shape.top).toBe(shapes[0].top);
    expect(Math.abs(shape.height - shapes[0].height)).toBeLessThanOrEqual(1);
  }
  expect(badges.Trending.text).toContain('Trending');
  expect(badges.Completed.text).toContain('Completed');
});

test('a skeleton is the same box as a finished card', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);

  const boxes = await page.evaluate(() => {
    const grid = document.querySelector('#yomu-library-explorer .yt-grid');
    const real = window.YomuTitleCard.create({ title: 'A rather long title that wraps onto two lines', cover: '/fixtures/cover.svg' });
    const ghost = window.YomuTitleCard.skeleton();
    grid.append(real, ghost);
    const read = (node) => {
      const box = node.getBoundingClientRect();
      const art = node.querySelector('.yt-card__art');
      return {
        w: box.width,
        h: box.height,
        radius: getComputedStyle(art).borderTopLeftRadius,
        artH: art.getBoundingClientRect().height,
      };
    };
    const out = { real: read(real), ghost: read(ghost) };
    real.remove();
    ghost.remove();
    return out;
  });

  expect(Math.abs(boxes.real.w - boxes.ghost.w), 'width within 1px').toBeLessThanOrEqual(1);
  expect(Math.abs(boxes.real.h - boxes.ghost.h), 'height within 1px').toBeLessThanOrEqual(1);
  expect(Math.abs(boxes.real.artH - boxes.ghost.artH), 'cover height within 1px').toBeLessThanOrEqual(1);
  expect(boxes.ghost.radius).toBe(boxes.real.radius);
});

test('cards are keyboard reachable with a visible focus ring and real targets', async ({ page, baseURL }, testInfo) => {
  await seed(page, { baseURL });
  await gotoHome(page);
  await waitForRails(page, 4);

  const audit = await page.evaluate(() => {
    const card = document.querySelector('.yr-rail .yt-card:not(.yt-card--skeleton)');
    card.focus();
    const art = card.querySelector('.yt-card__art');
    const focused = document.activeElement === card;
    const outline = getComputedStyle(art, null).outlineStyle;
    const pager = document.querySelector('[data-yomu-pager]');
    return {
      focused,
      outline,
      cardTag: card.tagName,
      pagerTag: pager.tagName,
      pagerType: pager.getAttribute('type'),
      pagerLabel: pager.getAttribute('aria-label'),
      pagerHeight: Math.round(pager.getBoundingClientRect().height),
      cardLabel: card.getAttribute('aria-label'),
    };
  });

  expect(audit.focused).toBe(true);
  expect(audit.outline, 'focus-visible ring on the cover').not.toBe('none');
  expect(audit.cardTag, 'a card that navigates is a link').toBe('A');
  expect(audit.pagerTag, 'a control that appends is a button').toBe('BUTTON');
  expect(audit.pagerType).toBe('button');
  expect(audit.pagerLabel).toBeTruthy();
  expect(audit.cardLabel).toBeTruthy();
  if (testInfo.project.name === 'phone-390') {
    expect(audit.pagerHeight, '44px touch target on a phone').toBeGreaterThanOrEqual(44);
  }
});
