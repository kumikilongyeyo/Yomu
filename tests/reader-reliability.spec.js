/**
 * Reader reliability: the reading loop, end to end, in a real browser.
 *
 * Open a chapter, read it, lose a page, lose a source, reach the end, come
 * back later -- and never think about loading. Each test below is one of those
 * moments. The rescue and switching tests wait out real retry ladders, so they
 * run at one desktop and one phone viewport rather than all six: what they
 * exercise does not depend on the width.
 */
import { test, expect } from '@playwright/test';
import { seed } from './support/app.mjs';

test.use({ serviceWorkers: 'block' });

const SVG = (fill = '#314959', w = 800, h = 1200) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/><text x="80" y="300" fill="white" font-size="50">Reader test</text></svg>`;

const SERIES = 'fx-night-archive';
const RESUME = `yomu.v1.resume.local-account.${SERIES}`;

function manifest(chapterId, count, url = (i) => `fixtures/page.svg?n=${i}`, dims = true) {
  return {
    schema: 'yomu.chapter-manifest/1', chapterId, sourceSeriesId: SERIES, manifestVersion: `test-${chapterId}-${count}`,
    pageListVersion: 1, expiresAt: null,
    pages: Array.from({ length: count }, (_, index) => ({ key: `${chapterId}-p${index}`, index, url: url(index), ...(dims ? { width: 800, height: 1200 } : {}) })),
  };
}

/**
 * The reader on chapter 2 of the fixture series, with its manifest replaced.
 * `settings` seeds the reader preferences once; `before` runs before the
 * navigation, for extra routes and storage.
 */
async function open(page, baseURL, { settings = {}, pages = 160, url, before } = {}) {
  await seed(page, { baseURL });
  await page.addInitScript((value) => {
    if (!localStorage.getItem('yomu.v2.reader.settings')) localStorage.setItem('yomu.v2.reader.settings', JSON.stringify(value));
    /* The first-use tip over the paged view is a one-time overlay. */
    localStorage.setItem('yomu.v2.reader.pagedTip', '1');
  }, settings);
  await page.route('**/fixtures/fx-night-archive/c2/manifest.json', (route) => route.fulfill({ json: manifest(`${SERIES}:c2`, pages, url) }));
  await page.route('**/fixtures/page.svg?*', (route) => route.fulfill({ contentType: 'image/svg+xml', body: SVG() }));
  if (before) await before();
  await page.goto(`/read/${SERIES}%3Ac2?source=local-fixtures`);
  await expect(page.locator('[data-testid="reader-scroll"], [data-testid="reader-paged"]').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => globalThis.__yomuReader?.count)).toBe(pages);
}

const strip = (page) => page.locator('[data-testid="reader-scroll"]');
const readerPage = (page) => page.evaluate(() => globalThis.__yomuReader?.page);

async function scrollToPage(page, index, fraction = 0) {
  await strip(page).evaluate((el, [i, f]) => {
    const box = el.querySelector(`[data-page-index="${i}"]`);
    el.scrollTop = box.offsetTop + box.offsetHeight * f;
  }, [index, fraction]);
}

async function openSettings(page) {
  await page.evaluate(() => globalThis.__yomuReader.show());
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('[data-reader-comfort]')).toBeVisible();
}

const heavy = (testInfo) => !['desktop-1440', 'phone-390', 'iphone-webkit'].includes(testInfo.project.name);

/* --- position ------------------------------------------------------------ */

test('160 pages stay bounded and keep the same panel through a rotation and a reload', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await scrollToPage(page, 80, 0.4);
  await expect.poll(() => readerPage(page)).toBe(80);
  await expect.poll(() => page.locator('[data-page-index] img').count()).toBeLessThanOrEqual(7);

  /* Narrower column, shorter pages: the browser clamps the scroll before the
     reader relayouts. The place must survive that, not just a reload. */
  await page.setViewportSize({ width: 430, height: 800 });
  await expect.poll(() => readerPage(page)).toBe(80);
  await expect.poll(() => page.evaluate(() => globalThis.YomuChapterSwitch.position()?.offset)).toBeGreaterThan(0.3);

  await page.evaluate(() => globalThis.__yomuReader.flush());
  await page.reload();
  await expect.poll(() => readerPage(page)).toBe(80);
  const pos = await page.evaluate(() => globalThis.YomuChapterSwitch.position());
  expect(pos.offset).toBeCloseTo(0.4, 1);
});

/* --- page mode ------------------------------------------------------------ */

test('page mode: right to left, keys, swipe, tap zones, spreads, and an end that goes on', async ({ page, baseURL }) => {
  await open(page, baseURL);
  /* Production answers /read/ with the app shell, which marks chapters read;
     the export's bare reader template has no shell, so it is added here. */
  await page.addScriptTag({ url: '/yomu-shell.js' });
  await openSettings(page);
  await page.getByRole('button', { name: 'Page', exact: true }).click();
  const rtl = page.getByRole('switch', { name: 'Right to left' });
  await rtl.click();
  await expect(rtl).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const paged = page.getByTestId('reader-paged');
  await expect(paged).toBeVisible();

  /* Right to left: the left arrow is forward. */
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => readerPage(page)).toBe(1);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => readerPage(page)).toBe(0);

  /* A finger pulling the page to the right turns forward in right to left. */
  await paged.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = (type, x) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', isPrimary: true, clientX: x, clientY: r.top + r.height / 2 }));
    at('pointerdown', r.left + r.width * 0.3);
    at('pointerup', r.left + r.width * 0.3 + 140);
  });
  await expect.poll(() => readerPage(page)).toBe(1);

  /* The left edge is forward too; the middle is the menu. Reading, the
     chrome -- the desktop rail with it -- is away. */
  await page.evaluate(() => globalThis.__yomuReader.hide());
  await expect(page.locator('.rd-head')).toHaveClass(/is-away/);
  const box = await paged.boundingBox();
  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height / 2);
  await expect.poll(() => readerPage(page)).toBe(2);

  /* Spread on a wide screen: the first page alone, then pairs. */
  await page.setViewportSize({ width: 1200, height: 800 });
  await openSettings(page);
  await page.getByRole('button', { name: 'Spread', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.yomu-paged-page')).toHaveCount(2);
  await page.evaluate(() => dispatchEvent(new CustomEvent('yomu:seek-page', { detail: 0 })));
  await expect(page.locator('.yomu-paged-page')).toHaveCount(1);

  /* The last page, then one more: the end of the chapter, and a way on. */
  await page.evaluate(() => dispatchEvent(new CustomEvent('yomu:seek-page', { detail: 159 })));
  await page.keyboard.press('ArrowLeft');
  const end = page.locator('.yomu-paged-end');
  await expect(end).toBeVisible();
  await expect(end).toContainText('End of Chapter 2');
  await expect(paged).toHaveAttribute('data-at-end', '1');
  /* Page mode has no strip to reach the bottom of; the end is the end. */
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]'), `${RESUME}.read`)).toContain(`${SERIES}:c2`);
  await end.getByRole('button', { name: /Next/ }).click();
  await expect(page).toHaveURL(/c3/);
});

/* --- the end of a chapter ------------------------------------------------- */

test('continuous chapters: the next chapter starts at exactly the spot on screen', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await scrollToPage(page, 150);
  const preview = page.locator('[data-yomu-next="preview"]');
  await expect(preview).toBeAttached();
  await expect(preview).toContainText('Chapter 3');
  await expect(preview).toHaveAttribute('data-ready', '1');

  /* Read into the next chapter's first page, 30% of the way down it. */
  await strip(page).evaluate((el) => {
    const tail = el.querySelector('[data-yomu-next="preview"]');
    const holder = tail.querySelector('.yomu-next__page');
    el.scrollTop = tail.offsetTop + holder.offsetTop + holder.offsetHeight * 0.3;
  });
  await expect(page).toHaveURL(/c3/);
  await expect.poll(() => page.evaluate(() => globalThis.__yomuReader?.count)).toBe(18);
  expect(await readerPage(page)).toBe(0);
  await expect.poll(() => page.evaluate(() => globalThis.YomuChapterSwitch.position()?.offset), { timeout: 8000 }).toBeGreaterThan(0.22);
  const pos = await page.evaluate(() => globalThis.YomuChapterSwitch.position());
  expect(pos.offset).toBeLessThan(0.38);
  await expect(page.locator('[data-yomu-next]')).toHaveCount(0);
});

test('with continuous chapters off, the end of a chapter is a card with the next one on it', async ({ page, baseURL }) => {
  await open(page, baseURL, { settings: { continuous: false } });
  await scrollToPage(page, 150);
  await strip(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const card = page.locator('[data-yomu-next="card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('End of Chapter 2');
  await card.getByRole('button', { name: /Chapter 3/ }).click();
  await expect(page).toHaveURL(/c3/);
});

/* --- a page that will not load -------------------------------------------- */

test('a failed page is retried quietly: no dead frame while the rescue works', async ({ page, baseURL }, testInfo) => {
  test.skip(heavy(testInfo), 'viewport-independent; runs at one desktop and one phone width');
  await open(page, baseURL);
  let asked = 0;
  await page.route('**/api/img?**', (route) => {
    asked++;
    /* The same door, fresh, refused too; the late try gets through. */
    return asked < 3
      ? route.fulfill({ status: 503, body: 'temporarily unavailable' })
      : route.fulfill({ contentType: 'image/svg+xml', body: SVG('green') });
  });
  const holder = page.locator('[data-page-index="0"]');
  await holder.locator('img').evaluate((img) => { img.src = '/api/img?u=https%3A%2F%2Fexample.com%2Freader-test.png'; });
  const deadline = Date.now() + 9000;
  let sawDead = false;
  while (Date.now() < deadline) {
    if (await holder.getByText(/unavailable/).count()) sawDead = true;
    if (await holder.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0 && /yomuRetry/.test(img.src))) break;
    await page.waitForTimeout(150);
  }
  expect(sawDead, 'the rescue is invisible while it works').toBe(false);
  await expect.poll(() => holder.locator('img').evaluate((img) => img.naturalWidth > 0)).toBe(true);
  expect(asked).toBe(3);
});

test('a page nothing can load says so -- after the rescue, not before', async ({ page, baseURL }, testInfo) => {
  test.skip(heavy(testInfo), 'viewport-independent; runs at one desktop and one phone width');
  await open(page, baseURL);
  await page.route('**/api/img?**', (route) => route.fulfill({ status: 503, body: 'down' }));
  const holder = page.locator('[data-page-index="0"]');
  await holder.locator('img').evaluate((img) => { img.src = '/api/img?u=https%3A%2F%2Fexample.com%2Fgone.png'; });
  await page.waitForTimeout(1500);
  await expect(holder.getByText(/unavailable/)).toHaveCount(0);
  await expect(holder.getByText(/Page 1 unavailable/)).toBeVisible({ timeout: 12000 });
  await expect(holder.getByRole('button', { name: 'Retry' })).toBeVisible();
});

/* --- a source that fails, and a copy that is short ------------------------- */

const ALT_PAGES = 160;
async function alternateSource(page, { count = ALT_PAGES } = {}) {
  await page.route('**/api/catalog/chapters?**', (route) => route.fulfill({ json: {
    rows: [{ number: 2, label: '2', releases: [
      { providerId: 'local-fixtures', providerName: 'Local fixtures', chapterId: `${SERIES}:c2` },
      { providerId: 'ext:alpha', providerName: 'Alpha Comics', chapterId: 'alt-c2' },
    ] }],
    sources: [{ providerId: 'ext:alpha', providerName: 'Alpha Comics', kind: 'extension', seriesId: 'alt-series', chapterCount: 3, ok: true }],
    gaps: [], partial: false,
  } }));
  const alt = manifest('alt-series:alt-c2', count, (i) => `/api/img?u=${encodeURIComponent(`https://img.test/alt/${i}.png`)}`);
  await page.route('**/api/ext/source/alpha/chapters/alt-c2/manifest*', (route) => route.fulfill({ json: { ...alt, chapterId: 'alt-c2' } }));
  await page.route('**/api/ext/source/alpha/series/alt-series*', (route) => route.fulfill({ json: {
    id: 'alt-series', title: 'Night Archive', author: '', synopsis: '', chapters: [{ id: 'alt-c2', number: 2, name: 'Chapter 2' }],
  } }));
}

test('a dead page switches to another source when you reach it, at the same place', async ({ page, baseURL }, testInfo) => {
  test.skip(heavy(testInfo), 'viewport-independent; runs at one desktop and one phone width');
  await open(page, baseURL, {
    /* Relative, as the fixture adapter expects its page URLs: it prefixes the
       slash itself, and a leading one here would make a protocol-relative
       URL for another host. */
    url: (i) => `api/img?u=${encodeURIComponent(`https://img.test/c2/${i}.png`)}`,
    before: async () => {
      await alternateSource(page);
      await page.route('**/api/img?**', (route) => {
        const u = new URL(route.request().url()).searchParams.get('u') || '';
        return /\/c2\/40\.png$/.test(u)
          ? route.fulfill({ status: 503, body: 'gone' })
          : route.fulfill({ contentType: 'image/svg+xml', body: SVG(/\/alt\//.test(u) ? '#2f5e3a' : '#314959') });
      });
    },
  });
  await scrollToPage(page, 40, 0.5);
  await expect.poll(() => readerPage(page)).toBe(40);
  await expect(page).toHaveURL(/source=yomuext-alpha/, { timeout: 20000 });
  await expect(page.locator('#yomu-chapter-switch')).toContainText('Switched source');
  await expect(page.locator('#yomu-chapter-switch')).toContainText('Alpha Comics');
  /* The same slicing (160 and 160): the same page. */
  await expect.poll(() => readerPage(page), { timeout: 10000 }).toBe(40);
});

test('a copy far shorter than its own source\'s other chapters offers the whole one', async ({ page, baseURL }, testInfo) => {
  test.skip(heavy(testInfo), 'viewport-independent; runs at one desktop and one phone width');
  await open(page, baseURL, {
    pages: 4,
    before: async () => {
      await alternateSource(page, { count: 47 });
      await page.route('**/api/img?**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: SVG('#2f5e3a') }));
      await page.addInitScript((series) => {
        localStorage.setItem('yomu.v1.chapterCounts', JSON.stringify({
          [`local-fixtures|${series}`]: { c: { [`${series}:c1`]: 45, [`${series}:c3`]: 47 }, at: Date.now() },
        }));
        /* What the loading pill said while the other copy was checked. */
        window.__pillTexts = [];
        setInterval(() => {
          const pill = document.getElementById('yomu-reader-progress');
          if (pill?.textContent) window.__pillTexts.push(pill.textContent);
        }, 40);
      }, SERIES);
    },
  });
  const offer = page.locator('#yomu-short-offer');
  await expect(offer).toBeVisible({ timeout: 15000 });
  await expect(offer).toContainText('only 4 pages');
  await expect(offer).toContainText('Alpha Comics');
  /* Checking another source's copy happens behind the page: the reader is
     never told it is loading that copy's 47 pages. (The pill that did say
     so is painted 80ms after the check's fetch, so give it the chance.) */
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__pillTexts.filter((text) => /\/\s*47\b/.test(text)))).toEqual([]);
  await offer.getByRole('button', { name: 'Open it' }).click();
  await expect(page).toHaveURL(/source=yomuext-alpha/);
});

/* --- comfort -------------------------------------------------------------- */

test('reading settings live in the reader\'s sheet and take effect at once', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await openSettings(page);
  const group = page.locator('[data-reader-comfort]');
  const continuous = group.getByRole('switch', { name: 'Continuous chapters' });
  await expect(continuous).toHaveAttribute('aria-checked', 'true');
  await continuous.click();
  await expect(continuous).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('yomu.v2.reader.settings')).continuous)).toBe(false);

  const before = await strip(page).evaluate((el) => el.querySelector('[data-page-index="1"]').offsetTop);
  await group.getByRole('slider', { name: 'Page gap' }).evaluate((input) => {
    input.value = '16';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(group.locator('output[data-out="gap"]')).toHaveText('16px');
  await expect.poll(() => strip(page).evaluate((el) => el.querySelector('[data-page-index="1"]').offsetTop)).toBe(before + 16);

  await group.getByRole('button', { name: 'Data saver' }).click();
  await expect(group.getByRole('button', { name: 'Data saver' })).toHaveAttribute('aria-pressed', 'true');
});

test('the keyboard: ] moves on a chapter and M changes the mode', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await strip(page).click({ position: { x: 20, y: 200 } });
  await page.keyboard.press('m');
  await expect(page.getByTestId('reader-paged')).toBeVisible();
  await page.keyboard.press(']');
  await expect(page).toHaveURL(/c3/);
});
