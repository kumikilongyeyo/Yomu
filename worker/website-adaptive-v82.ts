import type { Env } from './index';
import { chaptersFromHtml, madaraListIsDeferred, type HygieneChapter } from './chapter-hygiene';

type Framework = 'madara' | 'mangathemesia' | 'wordpress' | 'generic-html';
type Link = { url: string; text: string };
type ImageHit = { url: string; alt: string; width: number; height: number; tag: string };
type Attempt = { stage: string; input: string; ok: boolean; count?: number; error?: string };

type SitePlan = {
  schema: 'yomu.website-adaptive-plan/1';
  baseUrl: string;
  entryUrl: string;
  name: string;
  framework: Framework;
  catalogPaths: string[];
  seriesSegments: string[];
  chapterSegments: string[];
  nsfw: boolean;
};

type SiteProbe = {
  ready: boolean;
  framework: Framework;
  catalogCount: number;
  chapterCount: number;
  pages: number;
  sampleSeries?: string;
  sampleChapter?: string;
  attempts: Attempt[];
};

const VERSION = '8.2';
const UA = `Mozilla/5.0 (compatible; Yomu-Website-Adaptive/${VERSION}; +https://yomu.yomuread.workers.dev)`;
const FETCH_TIMEOUT = 10_000;
const PROBE_BUDGET = 34_000;
const MAX_HTML = 3_500_000;

const KNOWN_SITE_HINTS: Record<string, Partial<SitePlan>> = {
  // Keiyoushi and HakuNeko both identify ToonGod as a Madara-family source.
  // The explicit rating keeps it behind Yomu's existing mature-content gate.
  'toongod.org': {
    framework: 'madara',
    catalogPaths: ['/home/', '/home/page/1/', '/'],
    seriesSegments: ['webtoon', 'webtoons'],
    chapterSegments: ['chapter', 'chapters'],
    nsfw: true,
  },
};

const json = (body: unknown, status = 200, cache = 'no-store') => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache,
    'x-yomu-website-adaptive': VERSION,
  },
});

function compactError(error: unknown): string {
  return String((error as any)?.message ?? error ?? 'Unknown error').replace(/\s+/g, ' ').slice(0, 320);
}

function cleanText(value: string): string {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeAttr(value: string): string {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .trim();
}

function attr(tag: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  if (quoted?.[2]) return decodeAttr(quoted[2]);
  const bare = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*([^\\s>]+)`, 'i'));
  return decodeAttr(bare?.[1] ?? '');
}

function obviousPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^(::1|fc|fd|fe80)/i.test(h);
}

function publicUrl(raw: string): URL {
  const input = String(raw || '').trim();
  if (!input) throw new Error('Paste a public website URL.');
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || obviousPrivateHost(url.hostname)) {
    throw new Error('Only public http/https website URLs can be adapted.');
  }
  url.hash = '';
  return url;
}

function normalizedHost(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function sameSource(candidate: string, root: string): boolean {
  const a = normalizedHost(candidate);
  const b = normalizedHost(root);
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}

function absolute(raw: string, base: string): string | null {
  try {
    const url = new URL(decodeAttr(raw), base);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
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

function detectChallenge(html: string): boolean {
  return /cf-chl-|challenge-platform|checking your browser|just a moment\.\.\.|g-recaptcha|hcaptcha|turnstile-wrapper|captcha-container/i.test(html.slice(0, 140_000));
}

async function fetchHtml(
  target: string,
  root: string,
  deadline: number,
  init: RequestInit = {},
): Promise<{ html: string; finalUrl: string }> {
  if (!sameSource(target, root)) throw new Error('Website Adaptive refused to leave the source website.');
  const headers = new Headers(init.headers || {});
  headers.set('user-agent', UA);
  headers.set('accept', 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
  headers.set('accept-language', 'en-US,en;q=0.8');
  headers.set('referer', root);

  const response = await fetch(target, {
    ...init,
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.max(500, Math.min(FETCH_TIMEOUT, deadline - Date.now()))),
  });
  const finalUrl = response.url || target;
  if (!sameSource(finalUrl, root)) throw new Error('Website Adaptive refused a cross-site redirect.');
  if (!response.ok) throw Object.assign(new Error(`Website returned HTTP ${response.status}.`), { status: response.status });
  const type = response.headers.get('content-type') || '';
  if (type && !/html|text\//i.test(type)) throw new Error(`Expected HTML but received ${type}.`);
  const html = (await response.text()).slice(0, MAX_HTML);
  if (detectChallenge(html)) {
    throw Object.assign(new Error('Website returned an interactive access challenge.'), { code: 'BROWSER_REQUIRED' });
  }
  return { html, finalUrl };
}

function linksFromHtml(html: string, base: string): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = `<a ${match[1]}>`;
    const url = absolute(attr(tag, 'href'), base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const text = cleanText(match[2] || attr(tag, 'title') || attr(tag, 'aria-label')).slice(0, 240);
    out.push({ url, text });
    if (out.length >= 2600) break;
  }
  return out;
}

function imagesFromHtml(html: string, base: string): ImageHit[] {
  const out: ImageHit[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const srcset = attr(tag, 'data-srcset') || attr(tag, 'srcset');
    let raw = attr(tag, 'data-src') || attr(tag, 'data-original') || attr(tag, 'data-lazy-src') || attr(tag, 'data-url') || attr(tag, 'data-cfsrc') || attr(tag, 'src');
    if ((!raw || raw.startsWith('data:')) && srcset) {
      raw = srcset.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).pop() || '';
    }
    const url = absolute(raw, base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      alt: cleanText(attr(tag, 'alt') || attr(tag, 'title')).slice(0, 180),
      width: Number.parseInt(attr(tag, 'width') || '0', 10) || 0,
      height: Number.parseInt(attr(tag, 'height') || '0', 10) || 0,
      tag,
    });
    if (out.length >= 1800) break;
  }
  return out;
}

function scriptImageUrls(html: string, base: string): ImageHit[] {
  const source = html
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
  const out: ImageHit[] = [];
  const seen = new Set<string>();
  const patterns = [
    /https?:\/\/[^\s"'<>\\]+?\.(?:jpe?g|png|webp|avif)(?:\?[^\s"'<>\\]*)?/gi,
    /\/\/[^\s"'<>\\]+?\.(?:jpe?g|png|webp|avif)(?:\?[^\s"'<>\\]*)?/gi,
  ];
  for (const pattern of patterns) {
    for (const hit of source.matchAll(pattern)) {
      const url = absolute(hit[0], base);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, alt: '', width: 0, height: 0, tag: 'script' });
      if (out.length >= 1200) return out;
    }
  }
  return out;
}

function titleFromHtml(html: string, fallback: string): string {
  const og = html.match(/<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*>/i)?.[0] || '';
  const ogTitle = cleanText(attr(og, 'content'));
  if (ogTitle) return ogTitle.replace(/\s*[|–—-]\s*[^|–—-]{1,70}$/, '').trim();
  const h1 = cleanText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  if (h1) return h1;
  return cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || fallback)
    .replace(/\s*[|–—-]\s*[^|–—-]{1,70}$/, '')
    .trim() || fallback;
}

function coverFromHtml(html: string, base: string): string | undefined {
  const meta = html.match(/<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i)?.[0] || '';
  const fromMeta = absolute(attr(meta, 'content'), base);
  if (fromMeta) return fromMeta;
  return imagesFromHtml(html, base).find((img) => /cover|poster|thumbnail|manga-thumb|summary_image/i.test(`${img.url} ${img.alt} ${img.tag}`))?.url;
}

function detectFramework(html: string): Framework {
  const head = html.slice(0, 700_000);
  if (/wp-manga|madara(?:-core)?|c-tabs-item__content|manga-title-badges|manga-action|page-item-detail\s+manga/i.test(head)) return 'madara';
  if (/mangathemesia|class=["'][^"']*(?:listupd|bixbox|bsx|epl-num|chapterbody)/i.test(head)) return 'mangathemesia';
  if (/wp-content|wp-includes|wordpress/i.test(head)) return 'wordpress';
  return 'generic-html';
}

function detectNsfw(host: string, html: string): boolean {
  if (KNOWN_SITE_HINTS[host]?.nsfw === true) return true;
  const sample = cleanText(html.slice(0, 220_000));
  return /\b(?:pornographic|adult\s+(?:manga|manhwa|manhua|webtoon|comic)|hentai|uncensored\s+(?:manga|manhwa|webtoon)|18\+\s+(?:manga|manhwa|webtoon))\b/i.test(sample);
}

function pathSegments(url: string): string[] {
  try { return new URL(url).pathname.split('/').filter(Boolean).map((v) => decodeURIComponent(v).toLowerCase()); } catch { return []; }
}

function pathDepth(url: string): number {
  return pathSegments(url).length;
}

function learnSeriesSegments(links: Link[], baseUrl: string): string[] {
  const blocked = /^(?:wp-admin|wp-content|wp-includes|page|pages|chapter|chapters|episode|episodes|read|reader|genre|genres|tag|tags|author|authors|search|login|register|privacy|terms|contact|feed|category|assets?|static|images?|api)$/i;
  const counts = new Map<string, number>();
  for (const link of links) {
    if (!sameSource(link.url, baseUrl)) continue;
    const parts = pathSegments(link.url);
    if (parts.length < 2) continue;
    const first = parts[0];
    if (!first || blocked.test(first) || /\.(?:css|js|png|jpe?g|webp|svg|gif)$/i.test(first)) continue;
    if (parts.some((part) => /^(?:chapter|chapters|episode|episodes|read|reader)$/i.test(part))) continue;
    counts.set(first, (counts.get(first) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([segment]) => segment);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function siteName(html: string, host: string): string {
  const og = html.match(/<meta\b[^>]*(?:property|name)=["']og:site_name["'][^>]*>/i)?.[0] || '';
  const fromMeta = cleanText(attr(og, 'content'));
  if (fromMeta) return fromMeta.slice(0, 80);
  const title = cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  if (title) return title.split(/[|–—-]/)[0].trim().slice(0, 80) || host;
  return host;
}

function defaultCatalogPaths(framework: Framework): string[] {
  if (framework === 'madara') return ['/home/', '/home/page/1/', '/manga/', '/webtoon/', '/webtoons/', '/page/1/', '/'];
  if (framework === 'mangathemesia') return ['/manga/', '/series/', '/page/1/', '/'];
  if (framework === 'wordpress') return ['/manga/', '/comics/', '/series/', '/page/1/', '/'];
  return ['/', '/manga/', '/comics/', '/series/', '/webtoon/', '/page/1/'];
}

function buildPlan(target: URL, html: string, finalUrl: string): SitePlan {
  const host = normalizedHost(finalUrl || target.toString());
  const hint = KNOWN_SITE_HINTS[host] || {};
  const detected = detectFramework(html);
  const framework = (hint.framework as Framework | undefined) || detected;
  const links = linksFromHtml(html, finalUrl || target.toString());
  const learned = learnSeriesSegments(links, target.origin);
  const conventional = ['manga', 'mangas', 'comic', 'comics', 'series', 'title', 'titles', 'webtoon', 'webtoons', 'novel', 'novels', 'story', 'stories'];
  const seriesSegments = unique([...(hint.seriesSegments || []), ...learned, ...conventional]);
  const chapterSegments = unique([...(hint.chapterSegments || []), 'chapter', 'chapters', 'episode', 'episodes', 'issue', 'issues', 'read', 'reader']);
  const entryPath = target.pathname && target.pathname !== '/' && pathDepth(target.toString()) <= 1 ? target.pathname : '';
  const catalogPaths = unique([...(hint.catalogPaths || []), ...(entryPath ? [entryPath] : []), ...defaultCatalogPaths(framework)]).slice(0, 12);
  return {
    schema: 'yomu.website-adaptive-plan/1',
    baseUrl: target.origin,
    entryUrl: target.toString(),
    name: siteName(html, host),
    framework,
    catalogPaths,
    seriesSegments,
    chapterSegments,
    nsfw: hint.nsfw === true || detectNsfw(host, html),
  };
}

function seriesScore(link: Link, plan: SitePlan): number {
  if (!sameSource(link.url, plan.baseUrl)) return -100;
  const parts = pathSegments(link.url);
  if (!parts.length) return -30;
  const first = parts[0] || '';
  const path = `/${parts.join('/')}/`;
  let score = 0;
  if (plan.seriesSegments.includes(first)) score += 12;
  if (/\/(?:webtoons?|mangas?|comics?|series|titles?|novels?|books?|stories?)\//i.test(path)) score += 9;
  if (/\/(?:chapter|chapters|episodes?|reader|read)(?:\/|[-_])/i.test(path)) score -= 12;
  if (/\/(?:genre|tag|author|category|search|login|register|privacy|terms|contact|page)\//i.test(path)) score -= 8;
  if (pathDepth(link.url) >= 2) score += 3;
  if (link.text.length >= 3 && link.text.length <= 180) score += 2;
  if (/^(?:home|next|previous|older|newer|login|register|menu|read more)$/i.test(link.text)) score -= 7;
  return score;
}

function catalogSeries(html: string, base: string, plan: SitePlan): Link[] {
  const all = linksFromHtml(html, base);
  const dynamicSegments = learnSeriesSegments(all, plan.baseUrl);
  const enriched = dynamicSegments.length ? { ...plan, seriesSegments: unique([...dynamicSegments, ...plan.seriesSegments]) } : plan;
  const rows = all
    .map((link) => ({ link, score: seriesScore(link, enriched) }))
    .filter((row) => row.score >= 7)
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return rows.map((row) => row.link).filter((row) => !seen.has(row.url) && seen.add(row.url)).slice(0, 220);
}

function chapterScore(link: Link, seriesUrl: string, plan: SitePlan): number {
  if (!sameSource(link.url, plan.baseUrl) || link.url === seriesUrl) return -100;
  const parts = pathSegments(link.url);
  const path = `/${parts.join('/')}/`;
  const text = link.text;
  let score = 0;
  if (parts.some((part) => plan.chapterSegments.includes(part))) score += 11;
  if (/\b(?:chapter|chap(?:ter)?|episode|ep|issue)\s*[#.:_-]?\s*\d+(?:\.\d+)?\b/i.test(`${text} ${path}`)) score += 10;
  if (/\/(?:chapter|chapters|episode|episodes|issue|read)[/_-]/i.test(path)) score += 7;
  try {
    const seriesPath = new URL(seriesUrl).pathname.replace(/\/$/, '');
    if (seriesPath !== '/' && new URL(link.url).pathname.startsWith(`${seriesPath}/`)) score += 5;
  } catch {}
  if (/author|genre|publisher|tag|category|login|share|facebook|twitter|next|previous/i.test(`${path} ${text}`)) score -= 8;
  if (/\b\d{1,4}(?:\.\d+)?\b/.test(text)) score += 2;
  return score;
}

function chapterLinks(html: string, base: string, seriesUrl: string, plan: SitePlan): HygieneChapter[] {
  // Scoping, naming, numbering and the list's size live in chapter-hygiene.ts;
  // what counts as a chapter link is still decided here, by chapterScore.
  return chaptersFromHtml(html, base, seriesUrl, (link) => chapterScore(link, seriesUrl, plan) >= 7);
}

function readerSlice(html: string): string {
  const markers = [
    /<[^>]+(?:id|class)=["'][^"']*(?:reading-content|chapter-content|chapterbody|reader-area|reader-content|page-break|entry-content)[^"']*["'][^>]*>/i,
    /<main\b[^>]*>/i,
  ];
  for (const marker of markers) {
    const hit = marker.exec(html);
    if (hit?.index !== undefined) return html.slice(hit.index, Math.min(html.length, hit.index + 2_000_000));
  }
  return html;
}

function pageImages(html: string, base: string): ImageHit[] {
  const source = readerSlice(html);
  const combined = [...imagesFromHtml(source, base), ...scriptImageUrls(source, base)];
  const seen = new Set<string>();
  const rows = combined.filter((row) => !seen.has(row.url) && seen.add(row.url));
  const bad = /logo|avatar|icon|banner|advert|\/ads?\/|emoji|sprite|spacer|tracking|pixel|badge|button|favicon|gravatar|social|analytics/i;
  const strong = /chapter|reader|page[-_/]?\d|uploads?|comic|manga|webtoon|wp-content|cdn|image/i;
  const filtered = rows.filter((img) => {
    const hay = `${img.url} ${img.alt} ${img.tag}`;
    if (bad.test(hay)) return false;
    if (img.width && img.height && img.width < 180 && img.height < 180) return false;
    return strong.test(hay) || img.width >= 500 || img.height >= 700 || /reading-content|chapter-content|chapterbody|page-break/i.test(img.tag);
  });
  if (filtered.length >= 2) return filtered;
  const fallback = rows.filter((img) => !bad.test(`${img.url} ${img.alt} ${img.tag}`));
  return fallback.length >= 3 ? fallback : filtered;
}

async function discoverCatalog(plan: SitePlan, deadline: number, attempts: Attempt[]) {
  let best = { url: plan.baseUrl, rows: [] as Link[] };
  for (const path of plan.catalogPaths) {
    if (Date.now() >= deadline - 700) break;
    const target = new URL(path || '/', `${plan.baseUrl}/`).toString();
    try {
      const page = await fetchHtml(target, plan.baseUrl, deadline);
      const rows = catalogSeries(page.html, page.finalUrl, plan);
      attempts.push({ stage: 'catalog', input: target, ok: rows.length > 0, count: rows.length });
      if (rows.length > best.rows.length) best = { url: page.finalUrl, rows };
      if (rows.length >= 8) break;
    } catch (error: any) {
      attempts.push({ stage: 'catalog', input: target, ok: false, error: compactError(error) });
      if (error?.code === 'BROWSER_REQUIRED') throw error;
    }
  }
  if (!best.rows.length) throw new Error('Adaptive catalog discovery did not find title links.');
  return best;
}

async function madaraAjaxChapters(plan: SitePlan, seriesUrl: string, deadline: number, attempts: Attempt[]): Promise<HygieneChapter[]> {
  const endpoint = `${seriesUrl.replace(/\/+$/, '')}/ajax/chapters/`;
  for (const method of ['POST', 'GET'] as const) {
    if (Date.now() >= deadline - 600) break;
    try {
      const page = await fetchHtml(endpoint, plan.baseUrl, deadline, {
        method,
        ...(method === 'POST' ? { headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' }, body: '' } : {}),
      });
      const rows = chapterLinks(page.html, page.finalUrl, seriesUrl, plan);
      attempts.push({ stage: `chapters-madara-${method.toLowerCase()}`, input: endpoint, ok: rows.length > 0, count: rows.length });
      if (rows.length) return rows;
    } catch (error: any) {
      attempts.push({ stage: `chapters-madara-${method.toLowerCase()}`, input: endpoint, ok: false, error: compactError(error) });
      if (error?.code === 'BROWSER_REQUIRED') throw error;
    }
  }
  return [];
}

async function discoverDetail(plan: SitePlan, seriesUrl: string, deadline: number, attempts: Attempt[]) {
  const page = await fetchHtml(seriesUrl, plan.baseUrl, deadline);
  let chapters = chapterLinks(page.html, page.finalUrl, seriesUrl, plan);
  attempts.push({ stage: 'chapters', input: seriesUrl, ok: chapters.length > 0, count: chapters.length });
  if (plan.framework === 'madara' && madaraListIsDeferred(page.html, chapters.length)) {
    const deferred = await madaraAjaxChapters(plan, page.finalUrl, deadline, attempts);
    if (deferred.length > chapters.length) chapters = deferred;
  }
  if (!chapters.length) throw new Error('Adaptive detail discovery found the title but no chapter links.');
  return { html: page.html, finalUrl: page.finalUrl, chapters };
}

async function discoverPages(plan: SitePlan, chapterUrl: string, deadline: number, attempts: Attempt[]) {
  const page = await fetchHtml(chapterUrl, plan.baseUrl, deadline);
  const images = pageImages(page.html, page.finalUrl);
  attempts.push({ stage: 'pages', input: chapterUrl, ok: images.length >= 2, count: images.length });
  if (images.length < 2) throw new Error('Adaptive reader discovery could not prove actual page images.');
  return { images, finalUrl: page.finalUrl };
}

async function gauntlet(plan: SitePlan): Promise<SiteProbe> {
  const attempts: Attempt[] = [];
  const deadline = Date.now() + PROBE_BUDGET;
  try {
    const catalog = await discoverCatalog(plan, deadline, attempts);
    for (const series of catalog.rows.slice(0, 8)) {
      if (Date.now() >= deadline - 1_400) break;
      try {
        const detail = await discoverDetail(plan, series.url, deadline, attempts);
        for (const chapter of detail.chapters.slice(0, 7)) {
          if (Date.now() >= deadline - 800) break;
          try {
            const pages = await discoverPages(plan, chapter.url, deadline, attempts);
            return {
              ready: true,
              framework: plan.framework,
              catalogCount: catalog.rows.length,
              chapterCount: detail.chapters.length,
              pages: pages.images.length,
              sampleSeries: series.url,
              sampleChapter: chapter.url,
              attempts,
            };
          } catch (error: any) {
            if (error?.code === 'BROWSER_REQUIRED') throw error;
          }
        }
      } catch (error: any) {
        if (error?.code === 'BROWSER_REQUIRED') throw error;
      }
    }
    return { ready: false, framework: plan.framework, catalogCount: catalog.rows.length, chapterCount: 0, pages: 0, attempts };
  } catch (error: any) {
    attempts.push({ stage: 'adaptive', input: plan.baseUrl, ok: false, error: compactError(error) });
    if (error?.code === 'BROWSER_REQUIRED') throw Object.assign(error, { attempts });
    return { ready: false, framework: plan.framework, catalogCount: 0, chapterCount: 0, pages: 0, attempts };
  }
}

function chapterNumber(link: Link, fallback: number): number {
  const raw = `${link.text} ${link.url}`.match(/(?:chapter|chap|ch|episode|ep|issue)[^0-9]*([0-9]+(?:\.[0-9]+)?)/i)?.[1];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function summary(link: Link, index: number, nsfw: boolean) {
  let fallback = link.url;
  try { fallback = decodeURIComponent(new URL(link.url).pathname.split('/').filter(Boolean).pop() || new URL(link.url).hostname).replace(/[-_]+/g, ' '); } catch {}
  return {
    id: encodeToken(link.url),
    title: link.text || fallback,
    category: 'comic',
    nsfw,
    updatedAt: Date.now() - index,
  };
}

function adapter(plan: SitePlan, origin: string, probe: SiteProbe) {
  const token = encodeToken(plan);
  const rootHost = normalizedHost(plan.baseUrl);
  const content = ['comic', 'manga', 'manhwa', 'manhua', 'webtoon', ...(plan.nsfw ? ['adult'] : [])];
  return {
    id: `adaptive-${rootHost.replace(/[^a-z0-9]+/g, '-')}`,
    name: plan.name,
    version: 1,
    language: 'en',
    content,
    capabilities: { search: true, popular: true, latest: true, details: true, chapters: true, pages: true },
    nsfw: plan.nsfw,
    hosts: [rootHost, `*.${rootHost}`],
    api: `${origin}/api/fabric/website-adaptive/${token}/`,
    runtime: 'fabric-website-adaptive',
    engine: `Website Adaptive · ${plan.framework}`,
    score: Math.min(100, 90 + Math.min(10, probe.pages)),
    strategy: `${plan.framework}-learned-dom`,
  };
}

export async function tryWebsiteAdaptiveResolve(raw: string, origin: string): Promise<any | null> {
  let target: URL;
  try { target = publicUrl(raw); } catch { return null; }
  const deadline = Date.now() + PROBE_BUDGET;
  let first: { html: string; finalUrl: string };
  try {
    first = await fetchHtml(target.toString(), target.origin, deadline);
  } catch (error: any) {
    if (error?.code === 'BROWSER_REQUIRED') {
      return {
        ok: true,
        ready: false,
        route: 'website-adaptive-browser-required',
        confidence: 'high',
        score: 0,
        failureKind: 'browser-required',
        message: 'Website Adaptive reached the site, but it requires an interactive browser challenge. Yomu will not bypass that protection.',
      };
    }
    return null;
  }

  const actual = publicUrl(first.finalUrl);
  const plan = buildPlan(actual, first.html, first.finalUrl);
  let probe: SiteProbe;
  try {
    probe = await gauntlet(plan);
  } catch (error: any) {
    if (error?.code === 'BROWSER_REQUIRED') {
      return {
        ok: true,
        ready: false,
        route: 'website-adaptive-browser-required',
        confidence: 'high',
        score: 0,
        failureKind: 'browser-required',
        plan,
        probe: { ready: false, framework: plan.framework, catalogCount: 0, chapterCount: 0, pages: 0, attempts: error?.attempts || [] },
        message: 'Website Adaptive discovered the site structure, but an interactive browser challenge blocked the read path. Yomu will not bypass it.',
      };
    }
    return null;
  }

  if (!probe.ready) {
    return {
      ok: true,
      ready: false,
      route: 'website-adaptive-exhausted',
      confidence: 'medium',
      score: 0,
      plan,
      probe,
      message: `Website Adaptive identified ${plan.framework}, but could not yet prove catalog → chapters → reader pages.`,
    };
  }

  return {
    ok: true,
    ready: true,
    route: 'website-adaptive',
    confidence: 'high',
    score: Math.min(100, 90 + Math.min(10, probe.pages)),
    adapter: adapter(plan, origin, probe),
    plan,
    probe,
    message: `Website Adaptive learned the ${plan.framework} structure and verified catalog → chapters → reader pages.`,
  };
}

export async function handleWebsiteAdaptiveRuntime(request: Request, _env: Env, url: URL): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/fabric\/website-adaptive\/([^/]+)\/(.*)$/);
  if (!match) return null;
  if (request.method !== 'GET') return json({ error: 'Website Adaptive sources expose read-only GET endpoints.' }, 405);

  let plan: SitePlan;
  try {
    plan = decodeToken<SitePlan>(match[1]);
    if (plan.schema !== 'yomu.website-adaptive-plan/1') throw new Error('wrong schema');
    publicUrl(plan.baseUrl);
  } catch {
    return json({ error: 'Invalid Website Adaptive token.' }, 400);
  }

  const rest = match[2];
  const deadline = Date.now() + PROBE_BUDGET;
  const attempts: Attempt[] = [];

  try {
    if (rest === 'series' || rest === 'latest') {
      const pageNo = Math.max(1, Number(url.searchParams.get('page') || '1') || 1);
      const catalog = await discoverCatalog(plan, deadline, attempts);
      const start = (pageNo - 1) * 35;
      return json({
        series: catalog.rows.slice(start, start + 35).map((row, i) => summary(row, start + i, plan.nsfw)),
        hasNextPage: catalog.rows.length > start + 35,
        adaptiveFramework: plan.framework,
      }, 200, 'private, max-age=120');
    }

    if (rest === 'search') {
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      if (!q) return json({ series: [] });
      const catalog = await discoverCatalog(plan, deadline, attempts);
      const rows = catalog.rows.filter((row) => `${row.text} ${row.url}`.toLowerCase().includes(q));
      return json({ series: rows.slice(0, 50).map((row, i) => summary(row, i, plan.nsfw)), hasNextPage: false, adaptiveFramework: plan.framework });
    }

    const seriesMatch = rest.match(/^series\/([^/]+)$/);
    if (seriesMatch) {
      const seriesUrl = decodeToken<string>(decodeURIComponent(seriesMatch[1]));
      if (!sameSource(seriesUrl, plan.baseUrl)) return json({ error: 'Series URL is outside this adapted source.' }, 400);
      const detail = await discoverDetail(plan, seriesUrl, deadline, attempts);
      const cover = coverFromHtml(detail.html, detail.finalUrl);
      return json({
        id: encodeToken(detail.finalUrl),
        title: titleFromHtml(detail.html, detail.finalUrl),
        synopsis: '',
        ...(cover ? { cover } : {}),
        category: 'comic',
        nsfw: plan.nsfw,
        chapters: detail.chapters.map((chapter, i) => ({
          id: encodeToken(chapter.url),
          number: chapter.number ?? chapterNumber(chapter, Math.max(1, detail.chapters.length - i)),
          name: chapter.text || `Chapter ${chapter.number ?? Math.max(1, detail.chapters.length - i)}`,
        })),
        adaptiveFramework: plan.framework,
      }, 200, 'private, max-age=120');
    }

    const manifest = rest.match(/^chapters\/([^/]+)\/manifest$/);
    if (manifest) {
      const chapterId = decodeURIComponent(manifest[1]);
      const chapterUrl = decodeToken<string>(chapterId);
      if (!sameSource(chapterUrl, plan.baseUrl)) return json({ error: 'Chapter URL is outside this adapted source.' }, 400);
      const pages = await discoverPages(plan, chapterUrl, deadline, attempts);
      return json({
        schema: 'yomu.chapter-manifest/1',
        chapterId,
        sourceSeriesId: '',
        manifestVersion: `adaptive-v2-${chapterId.slice(0, 12)}-${pages.images.length}`,
        pageListVersion: pages.images.length,
        expiresAt: Date.now() + 10 * 60 * 1000,
        pages: pages.images.map((image, index) => ({ key: `${chapterId.slice(0, 12)}-${index}`, index, url: image.url })),
        delivery: 'direct',
        adaptiveFramework: plan.framework,
      });
    }

    return json({ error: 'Unknown Website Adaptive endpoint.' }, 404);
  } catch (error: any) {
    return json({
      error: compactError(error),
      failureKind: error?.code === 'BROWSER_REQUIRED' ? 'browser-required' : 'website-adaptive-runtime-error',
      attempts,
    }, error?.status === 404 ? 404 : 502);
  }
}

export function websiteAdaptiveStatus() {
  return {
    version: VERSION,
    engine: 'website-adaptive',
    frameworks: ['madara', 'mangathemesia', 'wordpress', 'generic-html'],
    behavior: 'fingerprint site → learn title paths → discover chapters → verify reader images → expose normalized source',
    protections: 'public HTTP(S) only; same-site redirects; no login/paywall/CAPTCHA/anti-bot bypass',
  };
}
