// @ts-check
/**
 * Mori: the library concierge, section 7 of the recovery spec plus the
 * follow-up asks — fused recommendations, title facts (author, chapter count,
 * next release), a Customize control, and a tap that opens the panel without
 * zooming the page.
 */
import { expect, test } from '@playwright/test';
import { gotoHome, resetSources, seed } from './support/app.mjs';

/** AniList's media lookup, answered with staff and a chapter total. */
async function routeAnilistMedia(page) {
  await page.route(/graphql\.anilist\.co/, async (route) => {
    const query = String(route.request().postDataJSON?.()?.query || '');
    if (!/staff\(/.test(query)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { Page: { media: [] } } }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          Media: {
            id: 4242,
            title: { english: 'Fixture Saga', romaji: null, native: null },
            chapters: 120,
            volumes: 12,
            status: 'RELEASING',
            averageScore: 84,
            genres: ['Action'],
            startDate: { year: 2019 },
            coverImage: { large: '/fixtures/cover.svg?t=facts' },
            description: 'A fixture series used by the runtime gauntlet.',
            staff: {
              edges: [
                { role: 'Story', node: { name: { full: 'Ada Writer' } } },
                { role: 'Art', node: { name: { full: 'Bo Artist' } } },
              ],
            },
          },
        },
      }),
    });
  });
}

/** The pet is the tap seam (yomu-pet.js -> onTap). A tap opens the dock. */
async function openDock(page) {
  await page.locator('#yomu-pet .yp-pet').first().click();
  const dock = page.locator('#yomu-mori-menu.ym-dock');
  await dock.waitFor({ timeout: 20_000 });
  return dock;
}

/** The chat is one of the dock's four doors, not what the tap lands on. */
async function openMori(page) {
  const dock = await openDock(page);
  await dock.locator('[data-ym-action="message"]').click();
  const panel = page.locator('#yomu-mori-chat');
  await panel.waitFor({ timeout: 20_000 });
  return panel;
}

async function ask(page, text) {
  /* `#mori-thinking` is a bubble too, so it is excluded: counting it makes the
     baseline race the answer it is supposed to be waiting for. */
  const replies = page.locator('#yomu-mori-chat .mc-msg--mori:not(#mori-thinking) .mc-bubble');
  const before = await replies.count();
  await page.locator('#yomu-mori-chat .mc-input').fill(text);
  await page.locator('#yomu-mori-chat .mc-send').click();
  await expect.poll(async () => replies.count(), { timeout: 40_000 }).toBeGreaterThan(before);
  return (await replies.last().innerText()).trim();
}

test.beforeEach(async ({ request, baseURL }) => {
  await resetSources(request, baseURL);
});

test('a tap opens four icons, not a chat', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);

  const dock = await openDock(page);
  await expect(page.locator('#yomu-mori-chat'), 'the tap does not open the panel').toHaveCount(0);

  const buttons = dock.locator('.ym-dock__button');
  await expect(buttons).toHaveCount(4);
  expect(await buttons.evaluateAll((nodes) => nodes.map((n) => n.dataset.ymAction)))
    .toEqual(['message', 'customize', 'mode', 'hide']);

  const audit = await dock.evaluate((node) => {
    const items = [...node.querySelectorAll('.ym-dock__button')];
    return {
      role: node.getAttribute('role'),
      tags: items.map((b) => b.tagName),
      types: items.map((b) => b.getAttribute('type')),
      labels: items.map((b) => b.getAttribute('aria-label')),
      glyphs: items.map((b) => b.querySelectorAll('svg.ym-dock__glyph').length),
      requests: node.querySelectorAll('img').length,
      width: Math.round(node.getBoundingClientRect().width),
    };
  });
  expect(audit.role).toBe('menubar');
  expect(new Set(audit.tags)).toEqual(new Set(['BUTTON']));
  expect(new Set(audit.types)).toEqual(new Set(['button']));
  expect(audit.labels).toEqual(['Message Mori', 'Customize look', expect.stringMatching(/Aurora mode|Paper mode/), 'Hide Mori']);
  expect(audit.glyphs, 'every icon is inline SVG').toEqual([1, 1, 1, 1]);
  expect(audit.requests, 'no image request for the icons').toBe(0);
  expect(audit.width, 'a small row, not a panel').toBeLessThan(320);

  // Arrow keys walk the row, Escape closes it.
  await buttons.first().focus();
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => document.activeElement?.dataset?.ymAction)).toBe('customize');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  expect(await page.evaluate(() => document.activeElement?.dataset?.ymAction), 'and wraps').toBe('hide');
  await page.keyboard.press('Escape');
  await expect(dock).toHaveCount(0);
});

test('the dock icons do what they say', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);

  // Customize opens the look sheet.
  let dock = await openDock(page);
  await dock.locator('[data-ym-action="customize"]').click();
  await expect.poll(async () => page.evaluate(() => !!document.getElementById('yomu-look-sheet')?.classList.contains('is-on')), { timeout: 20_000 }).toBe(true);
  await page.keyboard.press('Escape');

  // The light switch flips the mode, and the icon's label follows it.
  const modeBefore = await page.evaluate(() => window.YomuLook.mode());
  dock = await openDock(page);
  const labelBefore = await dock.locator('[data-ym-action="mode"]').getAttribute('aria-label');
  await dock.locator('[data-ym-action="mode"]').click();
  await expect.poll(async () => page.evaluate(() => window.YomuLook.mode()), { timeout: 10_000 }).not.toBe(modeBefore);
  dock = await openDock(page);
  expect(await dock.locator('[data-ym-action="mode"]').getAttribute('aria-label')).not.toBe(labelBefore);

  // Hide puts Mori away.
  await dock.locator('[data-ym-action="hide"]').click();
  await expect.poll(async () => page.evaluate(() => {
    const root = document.getElementById('yomu-pet');
    return !!root?.classList.contains('is-min') || !document.querySelector('#yomu-pet .yp-pet');
  }), { timeout: 10_000 }).toBe(true);
});

test('opening Mori does not zoom the page and keeps a 16px field', async ({ page, baseURL }, testInfo) => {
  await seed(page, { baseURL });
  await gotoHome(page);

  const before = await page.evaluate(() => window.visualViewport?.scale ?? 1);
  const panel = await openMori(page);
  const after = await page.evaluate(() => window.visualViewport?.scale ?? 1);
  expect(after, 'the viewport scale is untouched').toBe(before);

  const field = await page.evaluate(() => {
    const input = document.querySelector('#yomu-mori-chat .mc-input');
    return {
      fontSize: Number.parseFloat(getComputedStyle(input).fontSize),
      touch: getComputedStyle(input).touchAction,
      puckTouch: getComputedStyle(document.querySelector('#yomu-pet .yp-puck')).touchAction,
      petTouch: getComputedStyle(document.querySelector('#yomu-pet .yp-pet')).touchAction,
    };
  });
  if (testInfo.project.name === 'phone-390') {
    // Under 16px, mobile Safari zooms the whole page the moment the field
    // takes focus, and never zooms back out. That is the reported bug.
    expect(field.fontSize).toBeGreaterThanOrEqual(16);
  }
  expect(field.touch).toBe('manipulation');
  expect(field.petTouch, 'a tap on Mori is not half a double-tap zoom').toBe('manipulation');
  /* The drag layer sets `none` inline on the minimized puck so a pointer drag
     is not stolen by the scroller. Either value rules out double-tap zoom;
     `auto` does not, and is what this guards against. */
  expect(['manipulation', 'none']).toContain(field.puckTouch);
  await expect(panel).toBeVisible();
});

test('Customize opens the look sheet', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);
  await openMori(page);

  const button = page.locator('#yomu-mori-chat .mc-chip--action');
  await expect(button).toHaveText('Customize Yomu');
  await button.click();

  await expect.poll(async () => page.evaluate(() => !!document.getElementById('yomu-look-sheet')?.classList.contains('is-on')), { timeout: 20_000 })
    .toBe(true);
});

test('Mori answers who made a title, how many chapters, and when the next is due', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await routeAnilistMedia(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#yomu-pet .yp-pet').first().waitFor({ timeout: 45_000 });
  await openMori(page);

  const author = await ask(page, 'who wrote Fixture Saga');
  expect(author).toMatch(/Ada Writer/);
  expect(author).toMatch(/Bo Artist/);

  const chapters = await ask(page, 'how many chapters in Fixture Saga');
  expect(chapters, 'what the reader can actually open').toMatch(/42 chapters/);
  expect(chapters, 'and what AniList declares').toMatch(/120 chapters/);

  const next = await ask(page, 'when is the next chapter of Fixture Saga');
  expect(next).toMatch(/every 7 days/);
  expect(next).toMatch(/Latest release/);

  // The evidence line names where each answer came from.
  const evidence = await page.locator('#yomu-mori-chat .mc-evidence').last().innerText();
  expect(evidence).toMatch(/estimated from the last \d+ releases/);
  expect(evidence).toMatch(/not a publisher schedule/);
});

test('Mori refuses to invent an answer it cannot verify', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await page.route(/graphql\.anilist\.co/, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ data: { Media: null } }),
  }));
  await page.route('**/api/catalog/chapters*', (route) => route.fulfill({
    status: 404, contentType: 'application/json', body: '{"error":"no source lists that title"}',
  }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#yomu-pet .yp-pet').first().waitFor({ timeout: 45_000 });
  await openMori(page);

  const answer = await ask(page, 'who wrote A Title That Does Not Exist');
  expect(answer).toMatch(/could not verify|does not list a credited author/i);
  expect(answer, 'no invented name').not.toMatch(/written and drawn by \w/);
});

test('the community chooser shows the evidence and the reader decides', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);
  await openMori(page);

  await page.locator('#yomu-mori-chat .mc-chip', { hasText: 'Communities' }).click();
  const rows = page.locator('#yomu-mori-chat .mc-source');
  await expect(rows).toHaveCount(4, { timeout: 20_000 });

  const listed = await rows.evaluateAll((nodes) => nodes.map((row) => ({
    id: row.querySelector('input').dataset.moriSource,
    checked: row.querySelector('input').checked,
    disabled: row.querySelector('input').disabled,
    text: row.querySelector('.mc-source__text').innerText.replace(/\s+/g, ' ').trim(),
  })));

  expect(listed.map((r) => r.id)).toEqual(['anilist', 'mangaupdates', 'myanimelist', 'reddit']);
  // Everything that answered is on by default; a reader who never opened this
  // gets the widest answer, not the narrowest.
  expect(listed.slice(0, 3).every((r) => r.checked && !r.disabled)).toBe(true);
  expect(listed[0].text, 'each one carries its own evidence').toMatch(/120 ranked/);
  // A community that did not answer says why, instead of quietly not being there.
  expect(listed[3].disabled).toBe(true);
  expect(listed[3].checked).toBe(false);
  expect(listed[3].text).toMatch(/Unavailable · no REDDIT_CLIENT_ID/);

  // Turning one off is remembered, per device.
  await rows.nth(1).locator('input').uncheck();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('yomu.v1.moriSources')))).toMatchObject({ mangaupdates: false });
});

test('community picks reach the recommendations, and only the chosen ones', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);
  await openMori(page);

  await page.locator('#yomu-mori-chat .mc-chip', { hasText: 'Recommend' }).click();
  await expect(page.locator('#yomu-mori-chat .mc-picks .mc-pick').first()).toBeVisible({ timeout: 45_000 });
  const withAll = await page.locator('#yomu-mori-chat .mc-pick strong').allInnerTexts();
  expect(withAll, 'the work three communities agree on leads').toContain('Community Consensus Saga');

  // Switch every community off; the community signal must leave with them.
  await page.evaluate(() => localStorage.setItem('yomu.v1.moriSources', JSON.stringify({
    anilist: false, mangaupdates: false, myanimelist: false, reddit: false,
  })));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openMori(page);
  await page.locator('#yomu-mori-chat .mc-chip', { hasText: 'Recommend' }).click();
  await expect(page.locator('#yomu-mori-chat .mc-picks .mc-pick').first()).toBeVisible({ timeout: 45_000 });
  const withNone = await page.locator('#yomu-mori-chat .mc-pick strong').allInnerTexts();
  expect(withNone, 'a community the reader switched off does not vote').not.toContain('Only MangaUpdates Likes This');
});

test('recommendations fuse several signals rather than falling through them', async ({ page, baseURL }) => {
  await seed(page, { baseURL });
  await gotoHome(page);
  await openMori(page);

  const calls = [];
  await page.exposeFunction('__yomuNote', (name) => calls.push(name));
  await page.evaluate(() => {
    for (const [object, method] of [[window.YomuRank, 'forYou'], [window.YomuRank, 'rails'], [window.YomuLibraryEngine, 'next']]) {
      if (!object?.[method]) continue;
      const original = object[method].bind(object);
      object[method] = (...args) => { window.__yomuNote(method); return original(...args); };
    }
  });

  await page.locator('#yomu-mori-chat .mc-chip', { hasText: 'Recommend' }).click();
  await expect(page.locator('#yomu-mori-chat .mc-picks .mc-pick').first()).toBeVisible({ timeout: 45_000 });

  // A fallback chain stops at the first signal that answers. A fused one asks
  // all of them, every time.
  expect(new Set(calls), `called: ${[...new Set(calls)].join(', ')}`).toEqual(new Set(['forYou', 'rails', 'next']));
  const picks = await page.locator('#yomu-mori-chat .mc-pick strong').allInnerTexts();
  expect(picks.length).toBeGreaterThan(0);
  expect(new Set(picks).size, 'no duplicate picks').toBe(picks.length);
});
