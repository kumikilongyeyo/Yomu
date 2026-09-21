// @ts-check
/**
 * Production smoke, run against the deployed origin rather than the fixture.
 *
 * `YOMU_BASE_URL=https://yomu.yomuread.workers.dev npx playwright test tests/live-smoke.spec.js`
 *
 * The fixture suite proves the behaviour; this proves the behaviour reached
 * the live Worker. It seeds the reader state a first-time visitor would not
 * have (onboarding done, the published extension list enabled) and then looks
 * at exactly the three things the recovery spec's screenshots showed.
 *
 * Skipped entirely without YOMU_BASE_URL, so the default run stays offline and
 * deterministic.
 */
import { expect, test } from '@playwright/test';

const LIVE = process.env.YOMU_BASE_URL || '';
const CARD = '.yt-card:not(.yt-card--skeleton)';

test.skip(!LIVE, 'set YOMU_BASE_URL to smoke the deployed origin');
test.describe.configure({ mode: 'serial' });

async function seedLive(page, baseURL) {
  const response = await page.request.get(`${baseURL}/api/ext/sources`);
  expect(response.ok(), 'the live extension registry answers').toBe(true);
  const body = await response.json();
  const sources = (body.extensions || []).map((ext) => ({
    id: `yomuext-${ext.id}`,
    label: ext.name,
    name: ext.name,
    url: ext.api,
    kind: 'api',
    enabled: true,
    nsfw: !!ext.nsfw,
    capabilities: ext.capabilities || {},
  }));
  expect(sources.length, 'the live registry lists sources').toBeGreaterThan(0);

  await page.addInitScript((blob) => {
    try {
      localStorage.setItem('yomu.v1.collection', JSON.stringify({ sources: blob, library: [] }));
      localStorage.setItem('yomu.v1.setupDone', '1');
      localStorage.setItem('yomu.v1.adult', 'off');
    } catch {}
  }, sources);
  return sources.length;
}

test('the deployed Home has one More per rail and one card system', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const enabled = await seedLive(page, baseURL);

  const errors = [];
  page.on('pageerror', (error) => { if (!/Minified React error #418/.test(error.message)) errors.push(error.message); });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#yomu-library-explorer').waitFor({ state: 'attached', timeout: 60_000 });
  await page.locator(`#yomu-library-explorer ${CARD}`).first().waitFor({ timeout: 60_000 });
  await page.locator('.yr-rail').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);

  const rails = page.locator('.yr-rail');
  const count = await rails.count();
  expect(count, 'ranked rails are live').toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const label = (await rails.nth(i).locator('.yr-rail__title').innerText()).trim();
    await expect(rails.nth(i).locator('[data-yomu-pager]'), `${label}: one pager`).toHaveCount(1);
  }
  await expect(page.locator('.yomu-generic-more'), 'the legacy second control is gone from production').toHaveCount(0);
  await expect(page.locator('.yl-card'), 'the legacy library card is gone from production').toHaveCount(0);

  // Regression C: the counter cannot claim zero while source cards are up.
  const counter = (await page.locator('.yl-source-count').innerText()).replace(/\s+/g, ' ').trim();
  const responding = Number((counter.match(/(\d+)\s+responding/) || [])[1] || 0);
  const sourceCards = await page.locator(`#yomu-library-explorer ${CARD}[data-yt-source]`).count();
  expect(counter, counter).toMatch(/\d+ enabled sources? · \d+ responding/);
  if (sourceCards > 0) expect(responding, `${sourceCards} source cards on screen`).toBeGreaterThan(0);
  expect(enabled).toBeGreaterThan(0);

  // No card anywhere may be wearing the brand graphic as artwork: that is what
  // turned a result with no cover into a poster-sized logo.
  await expect(page.locator('.yt-card__img[src*="yomu-loader-ink"]')).toHaveCount(0);

  // A work several sources carry is one card that says so, not three cards.
  const shelf = await page.evaluate(() => [...document.querySelectorAll('#yomu-library-explorer .yt-card:not(.yt-card--skeleton)')]
    .map((card) => ({
      title: card.querySelector('.yt-card__title')?.textContent?.trim() || '',
      plus: card.querySelector('.yt-card__source span')?.textContent?.trim() || '',
    })));
  const titles = shelf.map((row) => row.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
  expect(new Set(titles).size, 'no two cards for the same title').toBe(titles.length);

  // The rail's control navigates to the shelf's own screen.
  const rail = rails.first();
  const control = rail.locator('[data-yomu-pager]');
  await expect(control).toHaveJSProperty('tagName', 'A');
  await expect(control).toHaveText('See all');
  await expect(control).toHaveAttribute('href', /\/more\?kind=rail&id=\w+/);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the deployed See all screen shows the shelf as a grid, with a way back', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await seedLive(page, baseURL);

  const errors = [];
  page.on('pageerror', (error) => { if (!/Minified React error #418/.test(error.message)) errors.push(error.message); });

  await page.goto('/more?kind=rail&id=trending&type=all', { waitUntil: 'domcontentloaded' });
  await page.locator(`#results ${CARD}`).first().waitFor({ timeout: 60_000 });

  const onScreen = await page.locator(`#results ${CARD}`).count();
  expect(onScreen, 'a screenful, not a strip').toBeGreaterThan(14);

  const layout = await page.evaluate(() => {
    const grid = document.querySelector('#results');
    const cards = [...grid.querySelectorAll('.yt-card:not(.yt-card--skeleton)')];
    const rows = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top / 20)));
    return { columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, rows: rows.size };
  });
  expect(layout.columns, 'a grid').toBeGreaterThan(1);
  expect(layout.rows, 'that grows downwards').toBeGreaterThan(1);

  // Its own append control, and a back button.
  const pager = page.locator('[data-yomu-pager]');
  await expect(pager).toHaveCount(1);
  await expect(pager).toHaveJSProperty('tagName', 'BUTTON');
  const before = onScreen;
  await pager.click();
  await expect(pager).toHaveText(/Load more|End|Retry/, { timeout: 40_000 });
  if ((await pager.innerText()).trim() !== 'Retry') {
    await expect.poll(async () => page.locator(`#results ${CARD}`).count(), { timeout: 40_000 }).toBeGreaterThan(before);
  }
  await expect(page.locator('#back')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the deployed Mori opens four icons and the communities it names', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await seedLive(page, baseURL);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#yomu-pet .yp-pet').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);

  await page.locator('#yomu-pet .yp-pet').first().click();
  const dock = page.locator('#yomu-mori-menu.ym-dock');
  await dock.waitFor({ timeout: 30_000 });
  await expect(page.locator('#yomu-mori-chat'), 'the tap does not open the panel').toHaveCount(0);
  expect(await dock.locator('.ym-dock__button').evaluateAll((nodes) => nodes.map((n) => n.dataset.ymAction)))
    .toEqual(['message', 'customize', 'mode', 'hide']);

  await dock.locator('[data-ym-action="message"]').click();
  await page.locator('#yomu-mori-chat').waitFor({ timeout: 30_000 });

  // The community file is served, and the chooser lists it honestly.
  const picks = await page.request.get(baseURL + '/community-picks.json');
  expect(picks.ok(), '/community-picks.json is deployed').toBe(true);
  const body = await picks.json();
  expect(body.schema).toBe('yomu.community-picks/1');
  expect(body.picks.length, 'the file has picks in it').toBeGreaterThan(20);
  const answered = Object.values(body.sources).filter((s) => s.ok);
  expect(answered.length, 'at least one community answered').toBeGreaterThan(0);

  await page.locator('#yomu-mori-chat .mc-chip', { hasText: 'Communities' }).click();
  const rows = page.locator('#yomu-mori-chat .mc-source');
  await expect(rows).toHaveCount(Object.keys(body.sources).length, { timeout: 30_000 });
  const listed = await rows.evaluateAll((nodes) => nodes.map((row) => ({
    id: row.querySelector('input').dataset.moriSource,
    checked: row.querySelector('input').checked,
    disabled: row.querySelector('input').disabled,
  })));
  for (const row of listed) {
    // Whatever answered is on and switchable; whatever did not is off and says why.
    expect(row.checked, `${row.id}`).toBe(body.sources[row.id].ok);
    expect(row.disabled, `${row.id}`).toBe(!body.sources[row.id].ok);
  }
});

test('the deployed assets are the canonical ones', async ({ page, baseURL }) => {
  for (const [path, needle] of [
    ['/yomu-titlecard.js', 'Yomu canonical TitleCard'],
    ['/yomu-titlecard.css', 'yt-card__art'],
    ['/yomu-pager.js', 'Yomu pagination ownership'],
    ['/yomu-explore-more.js', 'Yomu progressive exploration controls'],
  ]) {
    const response = await page.request.get(baseURL + path);
    expect(response.ok(), `${path} is served`).toBe(true);
    expect(response.headers()['content-type'] || '', `${path} is not the SPA shell`).toMatch(/javascript|css/);
    expect(await response.text(), `${path} content`).toContain(needle);
  }
  const more = await (await page.request.get(baseURL + '/yomu-explore-more.js')).text();
  expect(more, 'no duplicate-control path on the live origin').not.toContain('yomu-generic-more');
});
