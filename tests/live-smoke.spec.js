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

  // More, on the same page load. The rails read AniList from the browser and
  // AniList rate-limits per IP, so a second load just to press a button is a
  // second chance to be throttled for no extra coverage.
  const rail = rails.first();
  const pager = rail.locator('[data-yomu-pager]');
  const before = await rail.locator(CARD).count();
  const url = page.url();

  await pager.click();
  await expect(pager).toHaveText(/More|End|Retry/, { timeout: 40_000 });
  const label = (await pager.innerText()).trim();
  if (label !== 'Retry') {
    await expect.poll(async () => rail.locator(CARD).count(), { timeout: 40_000 }).toBeGreaterThan(before);
  } else {
    // AniList throttled the page-2 request. The contract that matters is that
    // the failure stayed on one control and took nothing off the screen.
    expect(await rail.locator(CARD).count()).toBe(before);
  }
  expect(page.url(), 'More must not navigate on production either').toBe(url);
  await expect(rail.locator('[data-yomu-pager]'), 'still one control after a press').toHaveCount(1);

  expect(errors, errors.join('\n')).toEqual([]);
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
