import { test, expect } from '@playwright/test';
import { seed } from './support/app.mjs';
test.use({ serviceWorkers: 'block' });

async function open(page, baseURL, settings = {}) {
  await seed(page, { baseURL });
  await page.addInitScript(settings => {
    if (!localStorage.getItem('yomu.v2.reader.settings')) localStorage.setItem('yomu.v2.reader.settings', JSON.stringify(settings));
  }, settings);
  await page.route('**/fixtures/fx-night-archive/c2/manifest.json', route => route.fulfill({ json: {
    schema: 'yomu.chapter-manifest/1', chapterId: 'fx-night-archive:c2', sourceSeriesId: 'fx-night-archive', manifestVersion: 'test160', pageListVersion: 1, expiresAt: null,
    pages: Array.from({length: 160}, (_, index) => ({ key: `p${index}`, index, url: `fixtures/page.svg?n=${index}`, width: 800, height: 1200 }))
  } }));
  await page.route('**/fixtures/page.svg?*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="800" height="1200" fill="#314959"/><text x="80" y="300" fill="white" font-size="50">Reader test</text></svg>' }));
  await page.goto('/read/fx-night-archive%3Ac2?source=local-fixtures');
  await expect(page.locator('[data-testid="reader-scroll"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => globalThis.__yomuReader?.count)).toBe(160);
}

test('160 pages stay bounded and resume the same panel after resize and reload', async ({page, baseURL}) => {
  await open(page, baseURL);
  await page.locator('[data-testid="reader-scroll"]').evaluate(el => { const box = el.querySelector('[data-page-index="80"]'); el.scrollTop = box.offsetTop + box.offsetHeight * .4; });
  await expect.poll(() => page.evaluate(() => globalThis.__yomuReader.page)).toBe(80);
  await expect.poll(() => page.locator('[data-page-index] img').count()).toBeLessThanOrEqual(7);
  await page.evaluate(() => globalThis.__yomuReader.flush());
  await page.setViewportSize({width: 430, height: 800});
  await page.reload();
  await expect.poll(() => page.evaluate(() => globalThis.__yomuReader?.page)).toBe(80);
  const pos = await page.evaluate(() => globalThis.YomuChapterSwitch.position());
  expect(pos.offset).toBeCloseTo(.4, 1);
});

test('paged mode, RTL, spread and settings remain operable', async ({page, baseURL}) => {
  await open(page, baseURL);
  await page.evaluate(() => globalThis.__yomuReader.show());
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await page.getByRole('button', {name: 'Page', exact: true}).click();
  await page.getByLabel('Read right to left', {exact: true}).check();
  await page.getByRole('button', {name: 'Close', exact: true}).click();
  await expect(page.getByTestId('reader-paged')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => page.evaluate(() => globalThis.__yomuReader.page)).toBe(1);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => globalThis.__yomuReader.page)).toBe(0);
  await page.setViewportSize({width: 1200, height: 800});
  await page.evaluate(() => globalThis.__yomuReader.show());
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await page.getByRole('button', {name: 'Spread', exact: true}).click();
  await page.getByRole('button', {name: 'Close', exact: true}).click();
  await expect(page.locator('.yomu-paged-page')).toHaveCount(2);
});

test('continuous chapters prefetch and cross the chapter divider', async ({page, baseURL}) => {
  await open(page, baseURL, {continuous: true});
  await page.locator('[data-testid="reader-scroll"]').evaluate(el => { el.scrollTop = el.querySelector('[data-page-index="150"]').offsetTop; });
  await expect(page.locator('[data-next-chapter-preview]')).toBeAttached();
  await page.locator('[data-testid="reader-scroll"]').evaluate(el => { el.scrollTop = el.querySelector('[data-next-chapter-preview]').offsetTop + 10; });
  await expect(page).toHaveURL(/c3/);
  await expect.poll(() => page.evaluate(() => globalThis.__yomuReader?.count)).toBe(18);
});

 test('a failed page retries through the image proxy and recovers', async ({page, baseURL}) => {
  await open(page, baseURL);
  let attempts = 0;
  await page.route('**/api/img?**', route => {
    attempts++;
    return new URL(route.request().url()).searchParams.has('yomuRetry')
      ? route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="800" height="1200" fill="green"/></svg>'})
      : route.fulfill({status:503, body:'temporarily unavailable'});
  });
  await page.locator('[data-page-index="0"] img').evaluate(img => { img.src = '/api/img?u=https%3A%2F%2Fexample.com%2Freader-test.png'; });
  await expect.poll(() => page.locator('[data-page-index="0"] img').evaluate(img => img.complete && img.naturalWidth > 0 && img.src.includes('yomuRetry'))).toBe(true);
  expect(attempts).toBe(2);
});
