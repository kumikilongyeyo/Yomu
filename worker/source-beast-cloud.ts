import puppeteer from '@cloudflare/puppeteer';
import type { Env } from './index';

type BeastEnv = Env & { BROWSER: Fetcher };
type JsonRow = Record<string, any>;

type BeastRun = {
  id: string;
  url: string;
  baseUrl: string;
  host: string;
  name: string;
  slug: string;
  family: 'madara';
  sessionId: string;
  handoffId?: string;
  state: 'verification-required' | 'verification-in-progress' | 'ready' | 'failed';
  createdAt: string;
  updatedAt: string;
  catalogPath?: string;
  cookies?: any[];
  userAgent?: string;
  allowedImageHosts?: string[];
};

type BeastSource = {
  id: string;
  name: string;
  slug: string;
  family: 'madara';
  baseUrl: string;
  host: string;
  catalogPath: string;
  sessionId?: string;
  cookies: any[];
  userAgent?: string;
  allowedImageHosts: string[];
  verifiedAt: string;
};

const RUN_PREFIX = 'sourcebeast:run:';
const SOURCE_PREFIX = 'sourcebeast:source:';
const RUN_TTL = 24 * 60 * 60;
const SOURCE_TTL = 30 * 24 * 60 * 60;
const KEEP_ALIVE = 600_000;
const LIVE_VIEW_TTL = 600_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
    },
  });

function publicWebsite(raw: unknown): URL {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('Missing website URL.');
  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Use a normal public http/https website URL.');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
  ) {
    throw new Error('Source Beast only accepts public website hostnames.');
  }
  parsed.hash = '';
  return parsed;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'source';
}

function encodeId(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeId(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  return atob(padded);
}

function sameOrigin(base: string, value: string): URL {
  const target = new URL(value, base);
  if (target.origin !== new URL(base).origin) throw new Error('Source route escaped its website origin.');
  return target;
}

async function readRun(env: BeastEnv, id: string): Promise<BeastRun | null> {
  return env.SYNC.get(`${RUN_PREFIX}${id}`, 'json') as Promise<BeastRun | null>;
}

async function saveRun(env: BeastEnv, run: BeastRun): Promise<void> {
  run.updatedAt = new Date().toISOString();
  await env.SYNC.put(`${RUN_PREFIX}${run.id}`, JSON.stringify(run), { expirationTtl: RUN_TTL });
}

async function readSource(env: BeastEnv, id: string): Promise<BeastSource | null> {
  return env.SYNC.get(`${SOURCE_PREFIX}${id}`, 'json') as Promise<BeastSource | null>;
}

async function saveSource(env: BeastEnv, source: BeastSource): Promise<void> {
  await env.SYNC.put(`${SOURCE_PREFIX}${source.id}`, JSON.stringify(source), { expirationTtl: SOURCE_TTL });
}

async function liveView(page: any): Promise<{ url: string; handoffId?: string }> {
  const cdp = await page.createCDPSession();
  const view: any = await (cdp as any).send('Cloudflare.getLiveView', {
    mode: 'tab',
    expiresInMs: LIVE_VIEW_TTL,
  });
  let handoffId: string | undefined;
  try {
    const handoff: any = await (cdp as any).send('Cloudflare.handoff', {
      instructions: 'Complete this website verification manually. When the site itself is open and usable, choose Done.',
      timeout: LIVE_VIEW_TTL,
    });
    handoffId = handoff?.handoffId;
  } catch {
    // Live View still works when structured handoff is temporarily unavailable.
  }
  return { url: String(view?.devtoolsFrontendUrl ?? ''), handoffId };
}

async function inspectPage(page: any, response?: any): Promise<{ challenged: boolean; status: number | null; title: string; sample: string }> {
  const title = await page.title().catch(() => '');
  const sample = await page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    return String(doc?.body?.innerText || '').slice(0, 8000);
  }).catch(() => '');
  const html = await page.content().catch(() => '');
  const status = response && typeof response.status === 'function' ? Number(response.status()) : null;
  const haystack = `${title}\n${sample}\n${String(html).slice(0, 16000)}`;
  const markers = /cf-chl|challenge-platform|turnstile|hcaptcha|g-recaptcha|verify (?:you are|that you are) human|checking your browser|attention required|security verification|captcha|access challenge/i;
  return {
    challenged: status === 403 || status === 429 || markers.test(haystack),
    status,
    title,
    sample,
  };
}

async function goto(page: any, target: string): Promise<{ challenged: boolean; status: number | null; title: string; sample: string }> {
  let response: any = null;
  try {
    response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 35_000 });
  } catch {
    // Some challenge pages keep connections open. Inspect whatever rendered.
  }
  await new Promise((resolve) => setTimeout(resolve, 900));
  return inspectPage(page, response);
}

async function cards(page: any): Promise<Array<{ title: string; href: string; cover?: string }>> {
  const raw = await page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    const selector = 'div.page-item-detail, .manga__item, .c-tabs-item__content';
    const image = (el: any) => {
      const img = el?.querySelector?.('img');
      if (!img) return '';
      const srcset = String(img.getAttribute('srcset') || '').split(',').map((x: string) => x.trim().split(/\s+/)[0]).filter(Boolean).pop();
      return img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-cfsrc') || img.getAttribute('data-manga-src') || srcset || img.src || '';
    };
    return JSON.stringify(Array.from(doc.querySelectorAll(selector)).map((el: any) => {
      const link = el.querySelector('.post-title a');
      return link ? { title: String(link.textContent || '').trim(), href: link.href, cover: image(el) } : null;
    }).filter((x: any) => x && x.title && x.href).slice(0, 40));
  });
  return JSON.parse(String(raw || '[]'));
}

async function detail(page: any): Promise<JsonRow> {
  const raw = await page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    const text = (selector: string) => String(doc.querySelector(selector)?.textContent || '').trim();
    const texts = (selector: string) => Array.from(doc.querySelectorAll(selector)).map((x: any) => String(x.textContent || '').trim()).filter(Boolean);
    const img = doc.querySelector('div.summary_image img');
    const cover = img ? (img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-cfsrc') || img.getAttribute('data-manga-src') || img.src || '') : '';
    const chapters = Array.from(doc.querySelectorAll('li.wp-manga-chapter')).map((el: any) => {
      const link = el.querySelector('a');
      if (!link?.href) return null;
      const name = String(link.textContent || '').trim();
      const date = String(el.querySelector('span.chapter-release-date')?.textContent || '').trim();
      return { name, href: link.href, date };
    }).filter(Boolean);
    return JSON.stringify({
      title: text('div.post-title h3, div.post-title h1, #manga-title > h1'),
      author: texts('div.author-content > a, div.manga-authors > a').join(', '),
      artist: texts('div.artist-content > a').join(', '),
      description: text('div.description-summary div.summary__content, div.summary_content div.post-content_item > h5 + div, div.summary_content div.manga-excerpt'),
      cover,
      genres: texts('div.genres-content a'),
      chapters,
    });
  });
  return JSON.parse(String(raw || '{}'));
}

async function readerImages(page: any): Promise<string[]> {
  const raw = await page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    const nodes = Array.from(doc.querySelectorAll('div.page-break img, li.blocks-gallery-item img, .reading-content .text-left img, .reading-content img'));
    const urls = nodes.map((img: any) => {
      const srcset = String(img.getAttribute('srcset') || '').split(',').map((x: string) => x.trim().split(/\s+/)[0]).filter(Boolean).pop();
      return img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-cfsrc') || img.getAttribute('data-manga-src') || srcset || img.src || '';
    }).filter((x: string) => /^https?:\/\//i.test(x));
    return JSON.stringify(Array.from(new Set(urls)));
  });
  return JSON.parse(String(raw || '[]'));
}

function imageHosts(urls: string[]): string[] {
  const out = new Set<string>();
  for (const value of urls) {
    try { out.add(new URL(value).hostname.toLowerCase()); } catch {}
  }
  return [...out];
}

async function gauntletMadara(page: any, run: BeastRun): Promise<JsonRow> {
  const base = new URL(run.baseUrl);
  const candidatePaths = run.slug === 'toongod'
    ? ['/webtoons/?m_orderby=views', '/webtoons/', '/manga/?m_orderby=views', '/']
    : ['/manga/?m_orderby=views', '/webtoons/?m_orderby=views', '/manga/', '/webtoons/', '/'];

  let catalog: Array<{ title: string; href: string; cover?: string }> = [];
  let catalogPath = '';
  for (const path of candidatePaths) {
    const target = new URL(path, base).toString();
    const state = await goto(page, target);
    if (state.challenged) return { verificationRequired: true, stage: 'catalog', page, message: 'The website asked for verification again while testing its catalog.' };
    catalog = await cards(page);
    if (catalog.length) { catalogPath = path.split('?')[0]; break; }
  }
  if (!catalog.length) return { ready: false, score: 20, message: 'Cloud browser opened the site, but the Madara catalog could not be read.' };

  const first = catalog[0];
  const detailState = await goto(page, sameOrigin(run.baseUrl, first.href).toString());
  if (detailState.challenged) return { verificationRequired: true, stage: 'series', page, message: 'The website asked for verification again on a title page.' };
  const info = await detail(page);
  const chapters = Array.isArray(info.chapters) ? info.chapters : [];
  if (!info.title || !chapters.length) {
    return { ready: false, score: 55, message: 'Catalog works, but Yomu could not prove a readable chapter list yet.' };
  }

  const chapterUrl = sameOrigin(run.baseUrl, String(chapters[0].href)).toString();
  let readerState = await goto(page, chapterUrl);
  if (readerState.challenged) return { verificationRequired: true, stage: 'reader', page, message: 'The website asked for verification again when opening a chapter.' };
  const hasSinglePager = await page.evaluate(() => !!(globalThis as any).document?.querySelector?.('#single-pager')).catch(() => false);
  if (hasSinglePager) {
    const listUrl = new URL(chapterUrl);
    listUrl.searchParams.set('style', 'list');
    readerState = await goto(page, listUrl.toString());
    if (readerState.challenged) return { verificationRequired: true, stage: 'reader', page, message: 'The website asked for verification again on the chapter reader.' };
  }
  const pages = await readerImages(page);
  if (pages.length < 2) return { ready: false, score: 75, message: 'Catalog and chapters work, but Yomu could not prove multiple reader images yet.' };

  const observed = [
    ...catalog.map((x) => x.cover || ''),
    String(info.cover || ''),
    ...pages,
  ].filter(Boolean);
  return {
    ready: true,
    score: 100,
    grade: 'A',
    catalogPath,
    catalogCount: catalog.length,
    chapterCount: chapters.length,
    pageCount: pages.length,
    allowedImageHosts: imageHosts(observed),
    sampleTitle: info.title,
  };
}

function adapterFor(source: BeastSource): JsonRow {
  return {
    id: source.id,
    name: source.name,
    version: 1,
    language: 'en',
    content: ['manga', 'manhwa', 'manhua', 'webtoon'],
    capabilities: ['browse', 'search', 'latest', 'chapters', 'reader'],
    hosts: [source.host, source.host.replace(/^www\./, '')].filter((x, i, a) => a.indexOf(x) === i),
    api: `/api/source-beast/runtime/${encodeURIComponent(source.id)}/`,
    runtime: 'browser-run',
    engine: 'cloud-browser-madara',
  };
}

async function captureSession(page: any, browser: any, run: BeastRun, gauntlet: JsonRow): Promise<BeastSource> {
  const cookies = await page.cookies().catch(() => []);
  const userAgent = await page.evaluate(() => String((globalThis as any).navigator?.userAgent || '')).catch(() => '');
  const allowed = new Set<string>([run.host, run.host.replace(/^www\./, ''), ...(gauntlet.allowedImageHosts || [])]);
  const source: BeastSource = {
    id: `beast-${run.slug}`,
    name: run.name,
    slug: run.slug,
    family: 'madara',
    baseUrl: run.baseUrl,
    host: run.host,
    catalogPath: gauntlet.catalogPath || '/manga/',
    sessionId: browser.sessionId(),
    cookies,
    userAgent,
    allowedImageHosts: [...allowed],
    verifiedAt: new Date().toISOString(),
  };
  return source;
}

async function connectRun(env: BeastEnv, run: BeastRun): Promise<{ browser: any; page: any } | null> {
  try {
    const browser = await puppeteer.connect(env.BROWSER, run.sessionId);
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    return { browser, page };
  } catch {
    return null;
  }
}

async function newVerificationSession(env: BeastEnv, run: BeastRun): Promise<{ browser: any; page: any; liveViewUrl: string }> {
  const browser = await puppeteer.launch(env.BROWSER, { keep_alive: KEEP_ALIVE });
  const page = await browser.newPage();
  await goto(page, run.url);
  const view = await liveView(page);
  run.sessionId = browser.sessionId();
  run.handoffId = view.handoffId;
  run.state = 'verification-required';
  await saveRun(env, run);
  return { browser, page, liveViewUrl: view.url };
}

async function handleTest(request: Request, env: BeastEnv): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Use POST with {url, resolution}.' }, 405);
  const body: any = await request.json().catch(() => ({}));
  let target: URL;
  try { target = publicWebsite(body.url); } catch (error: any) { return json({ error: error?.message || 'Invalid website URL.' }, 400); }
  const resolution = body.resolution && typeof body.resolution === 'object' ? body.resolution : {};
  const family = String(resolution?.remoteRecipe?.family || resolution?.recipe?.theme || '').toLowerCase();
  if (!resolution?.browserRequired || family !== 'madara') {
    return json({
      state: 'unsupported',
      message: 'Cloud Source Beast currently accepts browser-required sources with a maintained Madara recipe. This source needs another runtime adapter.',
    }, 422);
  }

  const name = String(resolution?.remoteRecipe?.name || resolution?.recipe?.name || target.hostname.replace(/^www\./, ''));
  const slug = slugify(String(resolution?.recipe?.slug || resolution?.remoteRecipe?.slug || target.hostname));
  const now = new Date().toISOString();
  const run: BeastRun = {
    id: crypto.randomUUID(),
    url: target.toString(),
    baseUrl: target.origin,
    host: target.hostname.toLowerCase(),
    name,
    slug,
    family: 'madara',
    sessionId: '',
    state: 'verification-required',
    createdAt: now,
    updatedAt: now,
  };

  let browser: any = null;
  try {
    browser = await puppeteer.launch(env.BROWSER, { keep_alive: KEEP_ALIVE });
    const page = await browser.newPage();
    const initial = await goto(page, run.url);
    run.sessionId = browser.sessionId();

    if (!initial.challenged) {
      const result = await gauntletMadara(page, run);
      if (result.ready) {
        const source = await captureSession(page, browser, run, result);
        await saveSource(env, source);
        run.state = 'ready';
        run.catalogPath = source.catalogPath;
        run.cookies = source.cookies;
        run.userAgent = source.userAgent;
        run.allowedImageHosts = source.allowedImageHosts;
        await saveRun(env, run);
        browser.disconnect();
        return json({ id: run.id, state: 'ready', message: 'Cloud browser proved the full reader path.', score: result.score, grade: result.grade, adapter: adapterFor(source), gauntlet: result });
      }
      if (!result.verificationRequired) {
        await saveRun(env, { ...run, state: 'failed' });
        browser.disconnect();
        return json({ id: run.id, state: 'needs-review', message: result.message, score: result.score || 0, gauntlet: result });
      }
    }

    const view = await liveView(page);
    run.handoffId = view.handoffId;
    run.state = 'verification-required';
    await saveRun(env, run);
    browser.disconnect();
    return json({
      id: run.id,
      state: 'verification-required',
      message: 'This website needs human verification. Open the cloud browser, complete the site check, choose Done, then return to Yomu.',
      liveViewUrl: view.url,
      provider: 'cloudflare-browser-run',
      localHelper: false,
    });
  } catch (error: any) {
    try { browser?.disconnect?.(); } catch {}
    return json({ state: 'failed', message: error?.message || 'Cloud Source Beast could not start a browser session.' }, 502);
  }
}

async function handleOpenVerification(env: BeastEnv, run: BeastRun): Promise<Response> {
  let connected = await connectRun(env, run);
  if (!connected) {
    try {
      const fresh = await newVerificationSession(env, run);
      fresh.browser.disconnect();
      return json({ id: run.id, state: 'verification-required', message: 'A fresh cloud verification session is ready.', liveViewUrl: fresh.liveViewUrl, localHelper: false });
    } catch (error: any) {
      return json({ id: run.id, state: 'failed', message: error?.message || 'Could not create a cloud verification session.' }, 502);
    }
  }
  const { browser, page } = connected;
  try {
    const view = await liveView(page);
    run.handoffId = view.handoffId;
    run.state = 'verification-in-progress';
    await saveRun(env, run);
    browser.disconnect();
    return json({ id: run.id, state: 'verification-in-progress', message: 'Cloud verification is open. Complete the website check and choose Done.', liveViewUrl: view.url, localHelper: false });
  } catch (error: any) {
    try { browser.disconnect(); } catch {}
    return json({ id: run.id, state: 'failed', message: error?.message || 'Could not open Live View.' }, 502);
  }
}

async function handleCheckVerification(env: BeastEnv, run: BeastRun): Promise<Response> {
  const connected = await connectRun(env, run);
  if (!connected) {
    return json({ id: run.id, state: 'verification-required', message: 'The cloud browser session expired. Open verification again to continue.', expired: true }, 409);
  }
  const { browser, page } = connected;
  try {
    const inspection = await inspectPage(page);
    if (inspection.challenged) {
      const view = await liveView(page);
      run.handoffId = view.handoffId;
      run.state = 'verification-required';
      await saveRun(env, run);
      browser.disconnect();
      return json({ id: run.id, state: 'verification-required', message: 'The website is still showing its verification step.', liveViewUrl: view.url, localHelper: false });
    }

    const result = await gauntletMadara(page, run);
    if (result.verificationRequired) {
      const view = await liveView(page);
      run.handoffId = view.handoffId;
      run.state = 'verification-required';
      await saveRun(env, run);
      browser.disconnect();
      return json({ id: run.id, state: 'verification-required', message: result.message, liveViewUrl: view.url, localHelper: false });
    }
    if (!result.ready) {
      run.state = 'failed';
      await saveRun(env, run);
      browser.disconnect();
      return json({ id: run.id, state: 'needs-review', message: result.message, score: result.score || 0, gauntlet: result });
    }

    const source = await captureSession(page, browser, run, result);
    await saveSource(env, source);
    run.state = 'ready';
    run.catalogPath = source.catalogPath;
    run.cookies = source.cookies;
    run.userAgent = source.userAgent;
    run.allowedImageHosts = source.allowedImageHosts;
    await saveRun(env, run);
    browser.disconnect();
    return json({ id: run.id, state: 'ready', message: 'Verification accepted and the full reader path passed.', score: result.score, grade: result.grade, adapter: adapterFor(source), gauntlet: result, localHelper: false });
  } catch (error: any) {
    try { browser.disconnect(); } catch {}
    return json({ id: run.id, state: 'failed', message: error?.message || 'Could not re-test the verified browser session.' }, 502);
  }
}

async function withSourcePage<T>(env: BeastEnv, source: BeastSource, fn: (page: any) => Promise<T>): Promise<T> {
  let browser: any = null;
  try {
    if (source.sessionId) {
      try { browser = await puppeteer.connect(env.BROWSER, source.sessionId); } catch {}
    }
    if (!browser) browser = await puppeteer.launch(env.BROWSER, { keep_alive: KEEP_ALIVE });
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    if (Array.isArray(source.cookies) && source.cookies.length) {
      try { await page.setCookie(...source.cookies); } catch {}
    }
    const result = await fn(page);
    source.sessionId = browser.sessionId();
    source.cookies = await page.cookies().catch(() => source.cookies || []);
    source.userAgent = await page.evaluate(() => String((globalThis as any).navigator?.userAgent || '')).catch(() => source.userAgent || '');
    await saveSource(env, source);
    browser.disconnect();
    return result;
  } catch (error) {
    try { browser?.disconnect?.(); } catch {}
    throw error;
  }
}

class VerificationNeeded extends Error {}

async function checkedNavigate(page: any, target: string): Promise<void> {
  const state = await goto(page, target);
  if (state.challenged) throw new VerificationNeeded('This source needs human verification again.');
}

function proxiedImage(origin: string, sourceId: string, target: string, ref: string): string {
  return `${origin}/api/source-beast/runtime/${encodeURIComponent(sourceId)}/image?u=${encodeURIComponent(target)}&ref=${encodeURIComponent(ref)}`;
}

function addAllowedHosts(source: BeastSource, urls: string[]): void {
  const hosts = new Set(source.allowedImageHosts || []);
  for (const host of imageHosts(urls)) hosts.add(host);
  source.allowedImageHosts = [...hosts];
}

async function runtimeCatalog(env: BeastEnv, source: BeastSource, origin: string, order = 'views'): Promise<Response> {
  try {
    const series = await withSourcePage(env, source, async (page) => {
      const target = new URL(source.catalogPath, source.baseUrl);
      if (order) target.searchParams.set('m_orderby', order);
      await checkedNavigate(page, target.toString());
      const rows = await cards(page);
      addAllowedHosts(source, rows.map((x) => x.cover || '').filter(Boolean));
      return rows.map((row) => ({
        id: encodeId(row.href),
        title: row.title,
        ...(row.cover ? { cover: proxiedImage(origin, source.id, row.cover, target.toString()) } : {}),
      }));
    });
    return json({ series });
  } catch (error: any) {
    if (error instanceof VerificationNeeded) return json({ error: error.message, verificationRequired: true, sourceId: source.id }, 428);
    return json({ error: error?.message || 'Cloud browser catalog request failed.' }, 502);
  }
}

async function runtimeSearch(env: BeastEnv, source: BeastSource, origin: string, url: URL): Promise<Response> {
  const q = url.searchParams.get('q')?.trim() || '';
  if (!q) return json({ series: [] });
  try {
    const series = await withSourcePage(env, source, async (page) => {
      const target = new URL(source.baseUrl);
      target.searchParams.set('s', q);
      target.searchParams.set('post_type', 'wp-manga');
      await checkedNavigate(page, target.toString());
      const rows = await cards(page);
      addAllowedHosts(source, rows.map((x) => x.cover || '').filter(Boolean));
      return rows.map((row) => ({
        id: encodeId(row.href),
        title: row.title,
        ...(row.cover ? { cover: proxiedImage(origin, source.id, row.cover, target.toString()) } : {}),
      }));
    });
    return json({ series });
  } catch (error: any) {
    if (error instanceof VerificationNeeded) return json({ error: error.message, verificationRequired: true, sourceId: source.id }, 428);
    return json({ error: error?.message || 'Cloud browser search failed.' }, 502);
  }
}

async function runtimeSeries(env: BeastEnv, source: BeastSource, origin: string, encoded: string): Promise<Response> {
  try {
    const href = sameOrigin(source.baseUrl, decodeId(encoded)).toString();
    const out = await withSourcePage(env, source, async (page) => {
      await checkedNavigate(page, href);
      const info = await detail(page);
      const chapters = Array.isArray(info.chapters) ? info.chapters : [];
      addAllowedHosts(source, [String(info.cover || '')].filter(Boolean));
      return {
        id: encoded,
        title: info.title || 'Untitled',
        author: info.author || info.artist || 'Unknown',
        synopsis: info.description || '',
        genres: Array.isArray(info.genres) ? info.genres : [],
        ...(info.cover ? { cover: proxiedImage(origin, source.id, String(info.cover), href) } : {}),
        chapters: chapters.map((chapter: any, index: number) => {
          const name = String(chapter.name || `Chapter ${chapters.length - index}`);
          const n = Number(name.match(/(?:chapter|ch\.?)[^0-9]*([0-9]+(?:\.[0-9]+)?)/i)?.[1] || name.match(/([0-9]+(?:\.[0-9]+)?)/)?.[1] || (chapters.length - index));
          const dateMs = chapter.date ? Date.parse(String(chapter.date)) : NaN;
          return {
            id: encodeId(String(chapter.href)),
            number: Number.isFinite(n) ? n : chapters.length - index,
            name,
            ...(Number.isFinite(dateMs) ? { publishedAt: dateMs } : {}),
          };
        }),
      };
    });
    return json(out);
  } catch (error: any) {
    if (error instanceof VerificationNeeded) return json({ error: error.message, verificationRequired: true, sourceId: source.id }, 428);
    return json({ error: error?.message || 'Cloud browser title request failed.' }, 502);
  }
}

async function runtimeManifest(env: BeastEnv, source: BeastSource, origin: string, encoded: string): Promise<Response> {
  try {
    const chapterUrl = sameOrigin(source.baseUrl, decodeId(encoded)).toString();
    const result = await withSourcePage(env, source, async (page) => {
      await checkedNavigate(page, chapterUrl);
      const single = await page.evaluate(() => !!(globalThis as any).document?.querySelector?.('#single-pager')).catch(() => false);
      let finalUrl = chapterUrl;
      if (single) {
        const list = new URL(chapterUrl);
        list.searchParams.set('style', 'list');
        finalUrl = list.toString();
        await checkedNavigate(page, finalUrl);
      }
      const images = await readerImages(page);
      if (!images.length) throw new Error('The reader did not expose any page images.');
      addAllowedHosts(source, images);
      const chapter = new URL(chapterUrl);
      const parts = chapter.pathname.split('/').filter(Boolean);
      parts.pop();
      const seriesUrl = `${chapter.origin}/${parts.join('/')}/`;
      return { images, seriesId: encodeId(seriesUrl), finalUrl };
    });
    return json({
      schema: 'yomu.chapter-manifest/1',
      chapterId: encoded,
      sourceSeriesId: result.seriesId,
      manifestVersion: `${source.id}-${encoded}-${result.images.length}`,
      pageListVersion: result.images.length,
      expiresAt: Date.now() + 15 * 60 * 1000,
      pages: result.images.map((target, index) => ({ key: `${encoded}-${index}`, index, url: proxiedImage(origin, source.id, target, result.finalUrl) })),
      delivery: 'proxy',
    });
  } catch (error: any) {
    if (error instanceof VerificationNeeded) return json({ error: error.message, verificationRequired: true, sourceId: source.id }, 428);
    return json({ error: error?.message || 'Cloud browser reader request failed.' }, 502);
  }
}

function cookieHeaderFor(source: BeastSource, target: URL): string {
  const now = Date.now() / 1000;
  return (source.cookies || []).filter((cookie: any) => {
    const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
    const host = target.hostname.toLowerCase();
    const domainOk = domain && (host === domain || host.endsWith(`.${domain}`));
    const expires = Number(cookie?.expires ?? -1);
    return domainOk && (expires <= 0 || expires > now);
  }).map((cookie: any) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function runtimeImage(source: BeastSource, url: URL): Promise<Response> {
  const raw = url.searchParams.get('u') || '';
  const ref = url.searchParams.get('ref') || source.baseUrl;
  let target: URL;
  try { target = new URL(raw); } catch { return json({ error: 'Invalid image URL.' }, 400); }
  if (!['http:', 'https:'].includes(target.protocol)) return json({ error: 'Invalid image protocol.' }, 400);
  const allowed = new Set((source.allowedImageHosts || []).map((x) => x.toLowerCase()));
  if (!allowed.has(target.hostname.toLowerCase())) return json({ error: `Image host ${target.hostname} was not observed in this verified source.` }, 403);
  const headers = new Headers({
    Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
    Referer: ref,
  });
  if (source.userAgent) headers.set('User-Agent', source.userAgent);
  const cookie = cookieHeaderFor(source, target);
  if (cookie) headers.set('Cookie', cookie);
  try {
    const upstream = await fetch(target.toString(), { headers, signal: AbortSignal.timeout(20_000) });
    if (!upstream.ok) return json({ error: `Image unavailable (${upstream.status}).` }, 502);
    const type = upstream.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return json({ error: 'Source returned something other than an image.' }, 502);
    return new Response(upstream.body, { status: 200, headers: { 'content-type': type, 'cache-control': 'private, max-age=3600' } });
  } catch {
    return json({ error: 'Image request failed.' }, 502);
  }
}

async function handleRuntime(request: Request, env: BeastEnv, url: URL, sourceId: string, rest: string): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Cloud source runtime uses GET.' }, 405);
  const source = await readSource(env, sourceId);
  if (!source) return json({ error: 'Cloud source session is not registered. Re-add the source from Sources.', verificationRequired: true }, 404);
  if (rest === 'series') return runtimeCatalog(env, source, url.origin, 'views');
  if (rest === 'latest') return runtimeCatalog(env, source, url.origin, 'latest');
  if (rest === 'search') return runtimeSearch(env, source, url.origin, url);
  if (rest === 'image') return runtimeImage(source, url);
  const series = rest.match(/^series\/(.+)$/);
  if (series) return runtimeSeries(env, source, url.origin, decodeURIComponent(series[1]));
  const manifest = rest.match(/^chapters\/(.+)\/manifest$/);
  if (manifest) return runtimeManifest(env, source, url.origin, decodeURIComponent(manifest[1]));
  return json({ error: 'Unknown cloud source runtime route.' }, 404);
}

export async function handleSourceBeastCloud(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/source-beast/')) return null;
  const beast = env as BeastEnv;

  if (url.pathname === '/api/source-beast/status') {
    return json({
      ok: true,
      mode: 'cloud',
      provider: 'cloudflare-browser-run',
      liveView: true,
      humanInTheLoop: true,
      localHelper: false,
      families: ['madara'],
    });
  }

  if (url.pathname === '/api/source-beast/test') return handleTest(request, beast);

  const verification = url.pathname.match(/^\/api\/source-beast\/runs\/([^/]+)\/verification\/(open|check)$/);
  if (verification) {
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    const run = await readRun(beast, decodeURIComponent(verification[1]));
    if (!run) return json({ error: 'That verification run expired. Test the source again.' }, 404);
    return verification[2] === 'open' ? handleOpenVerification(beast, run) : handleCheckVerification(beast, run);
  }

  const runtime = url.pathname.match(/^\/api\/source-beast\/runtime\/([^/]+)\/(.*)$/);
  if (runtime) return handleRuntime(request, beast, url, decodeURIComponent(runtime[1]), runtime[2]);

  return json({ error: 'Unknown Source Beast cloud route.' }, 404);
}
