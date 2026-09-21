/**
 * Shared harness for the runtime gauntlet.
 *
 * Two things every spec needs and neither should re-invent: a browser that
 * already believes onboarding is done and eleven sources are enabled, and an
 * AniList that answers from a fixture so a rail's page 2 is a decision the
 * test makes rather than a live ranking.
 */
import { anilistMedia, collection } from '../fixtures/catalog.mjs';

export const RAIL_TITLES = ['Popular right now', 'Trending now', 'Hidden gems'];

/** Alias -> media, for both the aliased rail query and the plain page query. */
function anilistBody(query, { page = 1 } = {}) {
  const aliases = [...String(query).matchAll(/(\w+)\s*:\s*Page\(/g)].map((m) => m[1]);
  if (aliases.length) {
    const data = {};
    for (const alias of aliases) data[alias] = { media: anilistMedia(alias, 1, 20) };
    return { data };
  }
  const pageMatch = String(query).match(/Page\(\s*page\s*:\s*(\d+)/);
  const wanted = pageMatch ? Number(pageMatch[1]) : page;
  /* Honour perPage: the see-all screen asks for 30 where a rail asks for 14,
     and a fixture that ignores it makes the bigger screen look like the rail. */
  const sizeMatch = String(query).match(/perPage\s*:\s*(\d+)/);
  const size = sizeMatch ? Math.min(Number(sizeMatch[1]), 50) : 14;
  return { data: { Page: { media: anilistMedia('page', wanted, size) } } };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ baseURL: string, nami?: boolean, anilist?: 'ok' | 'fail' | 'empty', anilistFailPages?: number[], adult?: boolean }} opts
 */
export async function seed(page, opts) {
  const { baseURL, nami = true, anilist = 'ok', anilistFailPages = [], adult = false } = opts;
  const origin = new URL(baseURL).origin;
  const blob = collection(origin, { includeNami: nami });

  await page.addInitScript(([collectionBlob, adultOn]) => {
    try {
      localStorage.setItem('yomu.v1.collection', JSON.stringify(collectionBlob));
      localStorage.setItem('yomu.v1.setupDone', '1');
      localStorage.setItem('yomu.v1.adult', adultOn ? 'on' : 'off');
      localStorage.removeItem('yomu.v1.rails');
      localStorage.removeItem('yomu.v1.libraryEngine');
      // Deterministic runs: no half-remembered taste profile from a previous
      // spec steering which rail renders.
      localStorage.removeItem('yomu.v1.events');
      localStorage.removeItem('yomu.v1.taste');
    } catch {}
  }, [blob, adult]);

  let anilistCalls = 0;
  await page.route(/graphql\.anilist\.co/, async (route) => {
    anilistCalls += 1;
    const body = route.request().postDataJSON?.() || {};
    const query = String(body?.query || '');
    const pageMatch = query.match(/Page\(\s*page\s*:\s*(\d+)/);
    const requested = pageMatch ? Number(pageMatch[1]) : 1;

    if (anilist === 'fail' || anilistFailPages.includes(requested)) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"errors":[{"message":"fixture failure"}]}' });
    }
    if (anilist === 'empty') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { Page: { media: [] } } }) });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(anilistBody(query, { page: requested })),
    });
  });

  return { anilistCalls: () => anilistCalls };
}

/** Per-source latency / failure for the fixture API. */
export async function configureSources(request, baseURL, config) {
  await request.post(`${baseURL}/__fixture/config`, { data: config });
}

export async function resetSources(request, baseURL) {
  await request.post(`${baseURL}/__fixture/config`, { data: { latency: {}, fail: {}, baseLatency: 12 } });
}

/**
 * Console/page errors a release must not ship.
 *
 * One exception, and it is written down rather than filtered quietly: React's
 * recoverable hydration warning (#418) is raised by the Expo bundle's own
 * prerendered HTML. It reproduces with **every** Yomu helper script blocked
 * and on origin/main before this branch, so it is not something the recovery
 * pass introduced or can remove -- regenerating that markup needs the Expo
 * source, which is not in this repository (see docs/recovery/README.md).
 * React re-renders the subtree on the client and the page is correct.
 *
 * `known` is counted, not ignored: a second pageerror hiding behind the first
 * still fails the gate.
 */
const KNOWN_PAGE_ERRORS = [/Minified React error #418/];

export function watchConsole(page) {
  const problems = [];
  const known = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Decorative static-export assets are asserted by the asset gate, not here.
    if (/favicon|manifest|\.map\b/i.test(text)) return;
    problems.push(`console.error: ${text}`);
  });
  page.on('pageerror', (error) => {
    if (KNOWN_PAGE_ERRORS.some((pattern) => pattern.test(error.message))) known.push(error.message);
    else problems.push(`pageerror: ${error.message}`);
  });
  return { problems, known };
}

export const HOME = '/';
export const DISCOVER = '/find';

/** Home is ready when the full-library explorer has painted its first cards. */
export async function gotoHome(page) {
  await page.goto(HOME, { waitUntil: 'domcontentloaded' });
  await page.locator('#yomu-library-explorer').waitFor({ state: 'attached', timeout: 45_000 });
  await page.locator('#yomu-library-explorer .yt-card:not(.yt-card--skeleton)').first().waitFor({ timeout: 45_000 });
  return page;
}

export async function waitForRails(page, atLeast = 1) {
  await page.locator('.yr-rail').first().waitFor({ timeout: 45_000 });
  await page.waitForFunction(
    (count) => document.querySelectorAll('.yr-rail .yt-card:not(.yt-card--skeleton)').length >= count,
    atLeast,
    { timeout: 45_000 },
  );
}

/** Every pagination control the page exposes, whoever built it. */
export const PAGER = '[data-yomu-pager]';
