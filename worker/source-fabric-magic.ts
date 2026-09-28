import puppeteer from '@cloudflare/puppeteer';
import type { Env } from './index';

type MagicEnv = Env & { BROWSER: Fetcher };
type Link = { url: string; text: string };
type MagicPlan = {
  schema: 'yomu.source-fabric-magic/1';
  baseUrl: string;
  entryUrl: string;
  host: string;
  name: string;
  catalogPaths: string[];
};

type Catalog = { rows: Link[]; url: string };
type Detail = { title: string; synopsis: string; cover?: string; chapters: Link[]; url: string };

const VERSION = '1.0';
const KEEP_ALIVE = 90_000;
const NAV_TIMEOUT = 24_000;
const MAX_ROWS = 260;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    'x-yomu-source-magic': VERSION,
  },
});

function compactError(error: unknown): string {
  return String((error as any)?.message ?? error ?? 'Unknown error').replace(/\s+/g, ' ').slice(0, 360);
}

function publicUrl(raw: string): URL {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Missing website URL.');
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a public http/https URL.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Private hosts are not supported.');
  if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(host)) throw new Error('Private hosts are not supported.');
  const m = host.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) throw new Error('Private hosts are not supported.');
  url.hash = '';
  return url;
}

function normalizedHost(raw: string): string {
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function sameSource(candidate: string, root: string): boolean {
  const a = normalizedHost(candidate);
  const b = normalizedHost(root);
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}

function encodeToken(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeToken<T>(value: string): T {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const text = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  return JSON.parse(text) as T;
}

function titleFallback(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname).replace(/[-_]+/g, ' ').trim();
  } catch { return url; }
}

function seriesScore(link: Link, baseUrl: string): number {
  if (!sameSource(link.url, baseUrl)) return -100;
  let path = '';
  try { path = new URL(link.url).pathname.toLowerCase(); } catch { return -100; }
  const text = link.text.trim();
  let score = 0;
  if (/\/(?:manga|manhwa|manhua|webtoon|webtoons|comic|comics|series|title|titles|novel|novels|story|stories)\//i.test(path)) score += 12;
  if (/\/(?:chapter|chapters|episode|episodes|reader|read)(?:\/|[-_])/i.test(path)) score -= 15;
  if (/\/(?:genre|genres|tag|tags|author|artist|category|search|login|register|privacy|terms|contact|feed|wp-admin)(?:\/|$)/i.test(path)) score -= 10;
  if (path.split('/').filter(Boolean).length >= 2) score += 3;
  if (text.length >= 3 && text.length <= 180) score += 3;
  if (/^(?:home|menu|next|previous|older|newer|login|register|read more)$/i.test(text)) score -= 9;
  return score;
}

function chapterScore(link: Link, baseUrl: string, seriesUrl: string): number {
  if (!sameSource(link.url, baseUrl) || link.url === seriesUrl) return -100;
  let path = '';
  try { path = new URL(link.url).pathname.toLowerCase(); } catch { return -100; }
  const text = link.text;
  let score = 0;
  if (/\/(?:chapter|chapters|episode|episodes|issue|issues|read|reader)(?:\/|[-_])/i.test(path)) score += 12;
  if (/\b(?:chapter|chap(?:ter)?|ch|episode|ep|issue)\s*[#.:_-]?\s*\d+(?:\.\d+)?\b/i.test(`${text} ${path}`)) score += 12;
  try {
    const seriesPath = new URL(seriesUrl).pathname.replace(/\/$/, '');
    if (seriesPath !== '/' && new URL(link.url).pathname.startsWith(`${seriesPath}/`)) score += 5;
  } catch {}
  if (/author|genre|publisher|tag|category|login|share|facebook|twitter/i.test(`${path} ${text}`)) score -= 9;
  return score;
}

async function openBrowser(env: MagicEnv) {
  const browser = await puppeteer.launch(env.BROWSER, { keep_alive: KEEP_ALIVE });
  const page = await browser.newPage();
  try { await page.setViewport({ width: 1280, height: 900 }); } catch {}
  return { browser, page };
}

async function goto(page: any, target: string): Promise<void> {
  let response: any = null;
  try { response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 700));
  const state = await page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    return {
      title: String(doc?.title || ''),
      text: String(doc?.body?.innerText || '').slice(0, 14000),
      html: String(doc?.documentElement?.innerHTML || '').slice(0, 22000),
    };
  }).catch(() => ({ title: '', text: '', html: '' }));
  const status = response && typeof response.status === 'function' ? Number(response.status()) : 0;
  const hay = `${state.title}\n${state.text}\n${state.html}`;
  if (status === 401 || status === 403 || status === 429 || /cf-chl|challenge-platform|turnstile|hcaptcha|g-recaptcha|captcha|checking your browser|verify (?:you are|that you are) human|access denied|sign in to continue|log in to continue|subscribe to continue|purchase to continue/i.test(hay)) {
    throw Object.assign(new Error('The website requires interactive or restricted access for this path.'), { code: 'ACCESS_RESTRICTED', status });
  }
}

async function extractLinks(page: any): Promise<Link[]> {
  const raw = await page.evaluate((limit: number) => {
    const doc: any = (globalThis as any).document;
    const rows = Array.from(doc?.querySelectorAll?.('a[href]') || []).map((a: any) => ({
      url: String(a.href || ''),
      text: String(a.textContent || a.getAttribute?.('aria-label') || a.getAttribute?.('title') || '').replace(/\s+/g, ' ').trim().slice(0, 220),
    })).filter((row: any) => /^https?:\/\//i.test(row.url));
    return JSON.stringify(rows.slice(0, limit));
  }, 3200).catch(() => '[]');
  const rows: Link[] = JSON.parse(String(raw || '[]'));
  const seen = new Set<string>();
  return rows.filter((row) => row.url && !seen.has(row.url) && seen.add(row.url));
}

async function extractMeta(page: any): Promise<{ title: string; synopsis: string; cover?: string }> {
  const raw = await page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    const attr = (selector: string, name: string) => String(doc?.querySelector?.(selector)?.getAttribute?.(name) || '');
    const text = (selector: string) => String(doc?.querySelector?.(selector)?.textContent || '').replace(/\s+/g, ' ').trim();
    const img = doc?.querySelector?.('meta[property="og:image"],meta[name="twitter:image"]');
    const cover = String(img?.getAttribute?.('content') || doc?.querySelector?.('img[class*="cover"],img[class*="poster"],.summary_image img')?.currentSrc || doc?.querySelector?.('img[class*="cover"],img[class*="poster"],.summary_image img')?.src || '');
    const title = attr('meta[property="og:title"]', 'content') || text('h1') || String(doc?.title || '');
    const synopsis = attr('meta[property="og:description"]', 'content') || attr('meta[name="description"]', 'content') || text('.description-summary,.summary__content,.description,.synopsis,.manga-excerpt');
    return JSON.stringify({ title, synopsis, cover });
  }).catch(() => '{}');
  const out = JSON.parse(String(raw || '{}'));
  return { title: String(out.title || '').trim(), synopsis: String(out.synopsis || '').trim(), ...(out.cover ? { cover: String(out.cover) } : {}) };
}

async function autoScroll(page: any): Promise<void> {
  await page.evaluate(async () => {
    const g: any = globalThis as any;
    const doc: any = g.document;
    const sleep = (ms: number) => new Promise((resolve) => g.setTimeout(resolve, ms));
    const total = Math.min(Number(doc?.body?.scrollHeight || 0), 120000);
    const step = Math.max(700, Math.floor(Number(g.innerHeight || 900) * 0.8));
    for (let y = 0; y < total; y += step) {
      g.scrollTo(0, y);
      await sleep(90);
    }
    g.scrollTo(0, 0);
  }).catch(() => {});
}

async function extractImages(page: any): Promise<string[]> {
  await autoScroll(page);
  const raw = await page.evaluate(() => {
    const doc: any = (globalThis as any).document;
    const urls: string[] = [];
    const add = (value: any) => {
      const raw = String(value || '').trim();
      if (!raw) return;
      if (/^https?:\/\//i.test(raw)) urls.push(raw);
      else if (/^\/\//.test(raw)) urls.push(`${String((globalThis as any).location?.protocol || 'https:')}${raw}`);
      else {
        try { urls.push(new URL(raw, String((globalThis as any).location?.href || '')).toString()); } catch {}
      }
    };
    for (const img of Array.from(doc?.querySelectorAll?.('img') || []) as any[]) {
      const attrs = ['data-large_image','data-full-url','data-original','data-src','data-lazy-src','data-url','data-cfsrc','src'];
      for (const name of attrs) { const v = img.getAttribute?.(name); if (v) { add(v); break; } }
      const srcset = String(img.getAttribute?.('data-srcset') || img.getAttribute?.('srcset') || '');
      if (srcset) add(srcset.split(',').map((part: string) => part.trim().split(/\s+/)[0]).filter(Boolean).pop());
      add(img.currentSrc);
    }
    for (const source of Array.from(doc?.querySelectorAll?.('picture source,source[srcset]') || []) as any[]) {
      const srcset = String(source.getAttribute?.('srcset') || source.getAttribute?.('data-srcset') || '');
      if (srcset) add(srcset.split(',').map((part: string) => part.trim().split(/\s+/)[0]).filter(Boolean).pop());
    }
    return JSON.stringify(Array.from(new Set(urls)).slice(0, 2500));
  }).catch(() => '[]');
  const rows: string[] = JSON.parse(String(raw || '[]'));
  const bad = /logo|avatar|icon|banner|advert|\/ads?\/|emoji|sprite|spacer|tracking|pixel|badge|button|favicon|gravatar|social|analytics/i;
  const good = /chapter|reader|page[-_/]?\d|uploads?|comic|manga|manhwa|webtoon|wp-content|cdn|image|media/i;
  const filtered = rows.filter((url) => !bad.test(url) && good.test(url));
  return (filtered.length >= 2 ? filtered : rows.filter((url) => !bad.test(url))).slice(0, 1800);
}

function catalogPaths(entry: URL): string[] {
  const paths = [entry.pathname, '/', '/manga/', '/manga', '/series/', '/series', '/webtoon/', '/webtoons/', '/comics/', '/latest/', '/updates/', '/browse/', '/page/1/'];
  return [...new Set(paths.filter(Boolean))].slice(0, 13);
}

async function discoverCatalog(page: any, plan: MagicPlan): Promise<Catalog> {
  let best: Catalog = { rows: [], url: plan.entryUrl };
  for (const path of plan.catalogPaths) {
    const target = new URL(path, `${plan.baseUrl}/`).toString();
    try {
      await goto(page, target);
      const links = await extractLinks(page);
      const rows = links.map((link) => ({ link, score: seriesScore(link, plan.baseUrl) }))
        .filter((row) => row.score >= 7).sort((a, b) => b.score - a.score).map((row) => row.link);
      const seen = new Set<string>();
      const unique = rows.filter((row) => !seen.has(row.url) && seen.add(row.url)).slice(0, MAX_ROWS);
      if (unique.length > best.rows.length) best = { rows: unique, url: target };
      if (unique.length >= 12) break;
    } catch (error: any) {
      if (error?.code === 'ACCESS_RESTRICTED') throw error;
    }
  }
  if (!best.rows.length) throw new Error('Rendered catalog did not expose title links.');
  return best;
}

async function discoverDetail(page: any, plan: MagicPlan, seriesUrl: string): Promise<Detail> {
  if (!sameSource(seriesUrl, plan.baseUrl)) throw new Error('Series URL left the source site.');
  await goto(page, seriesUrl);
  const links = await extractLinks(page);
  const chapters = links.map((link) => ({ link, score: chapterScore(link, plan.baseUrl, seriesUrl) }))
    .filter((row) => row.score >= 7).sort((a, b) => b.score - a.score).map((row) => row.link);
  const seen = new Set<string>();
  const unique = chapters.filter((row) => !seen.has(row.url) && seen.add(row.url)).slice(0, 2200);
  if (!unique.length) throw new Error('Rendered title page did not expose chapters.');
  const meta = await extractMeta(page);
  return { title: meta.title || titleFallback(seriesUrl), synopsis: meta.synopsis, ...(meta.cover ? { cover: meta.cover } : {}), chapters: unique, url: seriesUrl };
}

async function discoverPages(page: any, plan: MagicPlan, chapterUrl: string): Promise<string[]> {
  if (!sameSource(chapterUrl, plan.baseUrl)) throw new Error('Chapter URL left the source site.');
  await goto(page, chapterUrl);
  const pages = await extractImages(page);
  if (pages.length < 2) throw new Error('Rendered chapter did not expose multiple page images.');
  return pages;
}

async function browserSearch(page: any, plan: MagicPlan, query: string, catalog?: Catalog): Promise<Link[]> {
  const q = query.trim();
  if (!q) return [];
  const candidates = [
    `/?s=${encodeURIComponent(q)}`,
    `/?post_type=wp-manga&s=${encodeURIComponent(q)}`,
    `/search?q=${encodeURIComponent(q)}`,
    `/search/?q=${encodeURIComponent(q)}`,
    `/search/${encodeURIComponent(q)}/`,
  ];
  let best: Link[] = [];
  for (const path of candidates) {
    try {
      await goto(page, new URL(path, `${plan.baseUrl}/`).toString());
      const rows = (await extractLinks(page)).map((link) => ({ link, score: seriesScore(link, plan.baseUrl) }))
        .filter((row) => row.score >= 7).sort((a, b) => b.score - a.score).map((row) => row.link);
      if (rows.length > best.length) best = rows;
      if (best.length >= 4) break;
    } catch (error: any) {
      if (error?.code === 'ACCESS_RESTRICTED') throw error;
    }
  }
  if (!best.length) {
    const source = catalog ?? await discoverCatalog(page, plan);
    const needle = q.toLowerCase();
    best = source.rows.filter((row) => `${row.text} ${row.url}`.toLowerCase().includes(needle));
  }
  const seen = new Set<string>();
  return best.filter((row) => !seen.has(row.url) && seen.add(row.url)).slice(0, 80);
}

function chapterNumber(link: Link, fallback: number): number {
  const raw = `${link.text} ${link.url}`.match(/(?:chapter|chap|ch|episode|ep|issue)[^0-9]*([0-9]+(?:\.[0-9]+)?)/i)?.[1];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function summary(link: Link, index: number) {
  return { id: encodeToken(link.url), title: link.text || titleFallback(link.url), category: 'comic', updatedAt: Date.now() - index };
}

function adapter(plan: MagicPlan, origin: string, probe: { catalogCount: number; chapterCount: number; pages: number; searchCount: number }) {
  const token = encodeToken(plan);
  return {
    id: `magic-${plan.host.replace(/[^a-z0-9]+/g, '-')}`,
    name: plan.name || plan.host,
    version: 1,
    language: 'en',
    content: ['manga', 'manhwa', 'manhua', 'webtoon', 'comic'],
    capabilities: { search: true, popular: true, latest: true, details: true, chapters: true, pages: true },
    nsfw: false,
    hosts: [plan.host, `*.${plan.host}`],
    api: `${origin}/api/fabric/magic/${token}/`,
    runtime: 'fabric-browser-public',
    engine: 'Source Fabric · Browser Render Fallback',
    score: 100,
    probe,
  };
}

export async function tryMagicResolve(raw: string, env: MagicEnv, origin: string): Promise<any | null> {
  let entry: URL;
  try { entry = publicUrl(raw); } catch { return null; }
  if (!(env as any).BROWSER) return null;
  const plan: MagicPlan = {
    schema: 'yomu.source-fabric-magic/1',
    baseUrl: entry.origin,
    entryUrl: entry.toString(),
    host: normalizedHost(entry.toString()),
    name: normalizedHost(entry.toString()),
    catalogPaths: catalogPaths(entry),
  };
  let browser: any = null;
  try {
    const opened = await openBrowser(env);
    browser = opened.browser;
    const page = opened.page;
    await goto(page, plan.entryUrl);
    const meta = await extractMeta(page);
    if (meta.title) plan.name = meta.title.split(/[|–—-]/)[0].trim().slice(0, 80) || plan.host;
    const catalog = await discoverCatalog(page, plan);
    let winningDetail: Detail | null = null;
    let pages: string[] = [];
    for (const series of catalog.rows.slice(0, 7)) {
      try {
        const detail = await discoverDetail(page, plan, series.url);
        for (const chapter of detail.chapters.slice(0, 6)) {
          try {
            const found = await discoverPages(page, plan, chapter.url);
            if (found.length >= 2) { winningDetail = detail; pages = found; break; }
          } catch (error: any) {
            if (error?.code === 'ACCESS_RESTRICTED') throw error;
          }
        }
        if (winningDetail) break;
      } catch (error: any) {
        if (error?.code === 'ACCESS_RESTRICTED') throw error;
      }
    }
    if (!winningDetail || pages.length < 2) return { ok: true, ready: false, route: 'browser-render-exhausted', score: 0, message: 'Browser rendering opened the public site but could not prove a complete title → chapter → page path.' };
    const searchSeed = winningDetail.title.split(/\s+/).find((part) => part.length >= 4) || winningDetail.title;
    const search = await browserSearch(page, plan, searchSeed, catalog);
    if (!search.length) return { ok: true, ready: false, route: 'browser-render-search-missing', score: 0, message: 'Reader path works, but searchable title discovery was not proven.' };
    const probe = { catalogCount: catalog.rows.length, chapterCount: winningDetail.chapters.length, pages: pages.length, searchCount: search.length };
    return { ok: true, ready: true, route: 'browser-render-fallback', confidence: 'high', score: 100, adapter: adapter(plan, origin, probe), probe, message: 'Source Fabric browser rendering verified browse → search → title → chapters → reader pages.' };
  } catch (error: any) {
    return { ok: true, ready: false, route: error?.code === 'ACCESS_RESTRICTED' ? 'access-restricted' : 'browser-render-failed', score: 0, failureKind: error?.code === 'ACCESS_RESTRICTED' ? 'access-restricted' : 'browser-render-error', message: compactError(error) };
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
}

export async function handleMagicRuntime(request: Request, env: MagicEnv, url: URL): Promise<Response | null> {
  if (url.pathname === '/api/fabric/magic/status') return json({ ok: true, version: VERSION, browserFallback: !!(env as any).BROWSER });
  const match = url.pathname.match(/^\/api\/fabric\/magic\/([^/]+)\/(.*)$/);
  if (!match) return null;
  if (request.method !== 'GET') return json({ error: 'Magic source endpoints are read-only.' }, 405);
  let plan: MagicPlan;
  try {
    plan = decodeToken<MagicPlan>(match[1]);
    if (plan.schema !== 'yomu.source-fabric-magic/1') throw new Error('wrong schema');
    publicUrl(plan.baseUrl);
  } catch { return json({ error: 'Invalid Source Fabric Magic token.' }, 400); }

  let browser: any = null;
  try {
    const opened = await openBrowser(env);
    browser = opened.browser;
    const page = opened.page;
    const rest = match[2];
    if (rest === 'series' || rest === 'latest') {
      const pageNo = Math.max(1, Number(url.searchParams.get('page') || '1') || 1);
      const catalog = await discoverCatalog(page, plan);
      const start = (pageNo - 1) * 35;
      return json({ series: catalog.rows.slice(start, start + 35).map((row, i) => summary(row, start + i)), hasNextPage: catalog.rows.length > start + 35 }, 200);
    }
    if (rest === 'search') {
      const q = String(url.searchParams.get('q') || '').trim();
      if (!q) return json({ series: [] });
      const rows = await browserSearch(page, plan, q);
      return json({ series: rows.map(summary), hasNextPage: false });
    }
    const seriesMatch = rest.match(/^series\/([^/]+)$/);
    if (seriesMatch) {
      const seriesUrl = decodeToken<string>(decodeURIComponent(seriesMatch[1]));
      const detail = await discoverDetail(page, plan, seriesUrl);
      return json({
        id: encodeToken(detail.url),
        title: detail.title,
        synopsis: detail.synopsis,
        ...(detail.cover ? { cover: detail.cover } : {}),
        category: 'comic',
        chapters: detail.chapters.map((chapter, i) => ({ id: encodeToken(chapter.url), number: chapterNumber(chapter, Math.max(1, detail.chapters.length - i)), name: chapter.text || `Chapter ${Math.max(1, detail.chapters.length - i)}` })),
      });
    }
    const manifest = rest.match(/^chapters\/([^/]+)\/manifest$/);
    if (manifest) {
      const chapterId = decodeURIComponent(manifest[1]);
      const chapterUrl = decodeToken<string>(chapterId);
      const pages = await discoverPages(page, plan, chapterUrl);
      return json({
        schema: 'yomu.chapter-manifest/1',
        chapterId,
        sourceSeriesId: chapterId,
        manifestVersion: `magic-${chapterId.slice(0, 12)}-${pages.length}`,
        pageListVersion: pages.length,
        expiresAt: Date.now() + 8 * 60 * 1000,
        pages: pages.map((pageUrl, index) => ({ key: `${chapterId.slice(0, 12)}-${index}`, index, url: pageUrl })),
        delivery: 'direct',
      });
    }
    return json({ error: 'Unknown Source Fabric Magic endpoint.' }, 404);
  } catch (error: any) {
    return json({ error: compactError(error), failureKind: error?.code === 'ACCESS_RESTRICTED' ? 'access-restricted' : 'browser-render-error' }, 502);
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
}
