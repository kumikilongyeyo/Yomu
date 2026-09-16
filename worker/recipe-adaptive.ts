import type { Env } from './index';

type RecipeFamily = 'http-source' | 'mmrcms' | 'wpcomics' | 'custom' | 'browser-required';
type Link = { url: string; text: string };
type ImageHit = { url: string; alt: string; width: number; height: number; tag: string };
type RecipePlan = {
  schema: 'yomu.recipe-plan/1';
  provider: 'keiyoushi';
  slug: string;
  name: string;
  baseUrl: string;
  language: string;
  versionCode: number;
  theme?: string;
  family: RecipeFamily;
  requiresBrowser: boolean;
  browserReason?: string;
  itemPath?: string;
  catalogPaths: string[];
  pageSuffix?: string;
  chapterSelector?: string;
  pageSelector?: string;
  quirks: string[];
  sourceFiles: string[];
};

type RecipeProbe = {
  ready: boolean;
  catalogUrl?: string;
  catalogCount: number;
  sampleSeries?: string;
  sampleChapter?: string;
  pageCount: number;
  attempts: Array<{ stage: string; input: string; ok: boolean; count?: number; error?: string }>;
};

const VERSION = '7.4';
const UA = `Mozilla/5.0 (compatible; Yomu-Recipe-Adaptive/${VERSION}; +https://yomu.yomuread.workers.dev)`;
const GITHUB_RAW = 'https://raw.githubusercontent.com/keiyoushi/extensions-source/main';
const GITHUB_API = 'https://api.github.com/repos/keiyoushi/extensions-source/contents';
const FETCH_TIMEOUT = 8_000;
const PROBE_BUDGET = 24_000;
const RECIPE_CACHE_MS = 30 * 60_000;
const recipeCache = new Map<string, { expires: number; value: RecipePlan | null }>();

const json = (body: unknown, status = 200, cache = 'no-store') => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, 'x-yomu-recipe-adaptive': VERSION },
});

function compact(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
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

function absolute(raw: string, base: string): string | null {
  try {
    const url = new URL(decodeAttr(raw), base);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

function host(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function isPrivateHost(value: string): boolean {
  const h = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  return Boolean(m && Number(m[1]) >= 16 && Number(m[1]) <= 31) || /^(::1|fc|fd|fe80)/i.test(h);
}

function publicUrl(value: string): URL {
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || isPrivateHost(url.hostname)) throw new Error('Use a public http/https source URL.');
  url.hash = '';
  return url;
}

function sameSource(candidate: string, root: string): boolean {
  const a = host(candidate);
  const b = host(root);
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}

function encodeToken(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeToken(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function encodePlan(plan: RecipePlan): string {
  const runtimePlan = {
    s: plan.slug,
    n: plan.name,
    b: plan.baseUrl,
    l: plan.language,
    v: plan.versionCode,
    f: plan.family,
    i: plan.itemPath,
    c: plan.catalogPaths,
    p: plan.pageSuffix,
    cs: plan.chapterSelector,
    ps: plan.pageSelector,
    q: plan.quirks,
  };
  return encodeToken(JSON.stringify(runtimePlan));
}

function decodePlan(token: string): RecipePlan {
  const row = JSON.parse(decodeToken(token));
  return {
    schema: 'yomu.recipe-plan/1',
    provider: 'keiyoushi',
    slug: String(row.s || 'recipe'),
    name: String(row.n || row.s || 'Recipe source'),
    baseUrl: publicUrl(String(row.b)).origin,
    language: String(row.l || 'en'),
    versionCode: Number(row.v || 1),
    family: row.f || 'custom',
    requiresBrowser: false,
    itemPath: row.i || undefined,
    catalogPaths: Array.isArray(row.c) ? row.c.map(String) : ['/'],
    pageSuffix: row.p || undefined,
    chapterSelector: row.cs || undefined,
    pageSelector: row.ps || undefined,
    quirks: Array.isArray(row.q) ? row.q.map(String) : [],
    sourceFiles: [],
  };
}

async function fetchText(url: string, timeout = FETCH_TIMEOUT, init: RequestInit = {}): Promise<string> {
  const response = await fetch(url, {
    ...init,
    headers: { 'user-agent': UA, accept: 'text/plain,text/html,application/json;q=0.9,*/*;q=0.5', ...(init.headers || {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  return response.text();
}

async function fetchSourceHtml(url: string, root: string, deadline: number): Promise<{ html: string; finalUrl: string }> {
  if (!sameSource(url, root)) throw new Error('Recipe runtime refused to leave the source website.');
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'en-US,en;q=0.8', referer: root },
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.max(500, Math.min(FETCH_TIMEOUT, deadline - Date.now()))),
  });
  const finalUrl = response.url || url;
  if (!sameSource(finalUrl, root)) throw new Error('Recipe runtime refused a cross-site redirect.');
  if (!response.ok) throw Object.assign(new Error(`Website returned HTTP ${response.status}.`), { status: response.status });
  const html = (await response.text()).slice(0, 3_000_000);
  if (/cf-chl-|challenge-platform|checking your browser|just a moment\.\.\.|g-recaptcha|hcaptcha/i.test(html.slice(0, 100_000))) {
    throw Object.assign(new Error('Website returned an interactive access challenge.'), { code: 'BROWSER_REQUIRED' });
  }
  return { html, finalUrl };
}

function candidateSlugs(target: URL): string[] {
  const h = target.hostname.toLowerCase().replace(/^www\./, '');
  const first = h.split('.')[0] || '';
  const full = compact(h);
  const withoutCommonTld = compact(h.replace(/\.(?:com|org|net|ru|biz|io|to|co|me|xyz|site|online)$/i, ''));
  return [...new Set([first, withoutCommonTld, full].map(compact).filter((x) => x.length >= 3))];
}

function parseBuild(build: string) {
  const name = build.match(/\bname\s*=\s*["']([^"']+)["']/)?.[1] || '';
  const baseUrl = build.match(/\bbaseUrl\s*=\s*["'](https?:\/\/[^"']+)["']/)?.[1] || '';
  const language = build.match(/\blang\s*=\s*["']([^"']+)["']/)?.[1] || 'en';
  const theme = build.match(/\btheme\s*=\s*["']([^"']+)["']/)?.[1] || '';
  const versionCode = Number(build.match(/\bversionCode\s*=\s*(\d+)/)?.[1] || 1);
  return { name, baseUrl, language, theme, versionCode };
}

async function findBuild(target: URL): Promise<{ slug: string; langDir: string; build: string; meta: ReturnType<typeof parseBuild> } | null> {
  for (const slug of candidateSlugs(target)) {
    for (const langDir of ['en', 'all']) {
      const url = `${GITHUB_RAW}/src/${langDir}/${slug}/build.gradle.kts`;
      try {
        const build = await fetchText(url, 6_000);
        const meta = parseBuild(build);
        if (!meta.baseUrl) continue;
        const targetHost = host(target.toString());
        const buildHost = host(meta.baseUrl);
        const closeEnough = targetHost === buildHost || compact(targetHost.split('.')[0]) === compact(buildHost.split('.')[0]) || compact(targetHost) === compact(buildHost);
        if (closeEnough) return { slug, langDir, build, meta };
      } catch {}
    }
  }
  return null;
}

async function sourceBundle(langDir: string, slug: string): Promise<{ code: string; files: string[] }> {
  const dir = `src/${langDir}/${slug}/src/eu/kanade/tachiyomi/extension/${langDir}/${slug}`;
  try {
    const listing = JSON.parse(await fetchText(`${GITHUB_API}/${dir}?ref=main`, 7_000, { headers: { accept: 'application/vnd.github+json' } }));
    if (!Array.isArray(listing)) return { code: '', files: [] };
    const files = listing.filter((row: any) => row?.type === 'file' && /\.kt$/i.test(String(row?.name || ''))).slice(0, 12);
    const settled = await Promise.allSettled(files.map((row: any) => fetchText(String(row.download_url || `${GITHUB_RAW}/${row.path}`), 7_000)));
    const chunks: string[] = [];
    const names: string[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status !== 'fulfilled') continue;
      chunks.push(result.value);
      names.push(String(files[i]?.name || 'source.kt'));
    }
    return { code: chunks.join('\n\n'), files: names };
  } catch {
    return { code: '', files: [] };
  }
}

function stringOverride(code: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`(?:override\\s+)?(?:protected\\s+)?(?:open\\s+)?val\\s+${escaped}\\s*=\\s*["']([^"']+)["']`, 'i'),
    new RegExp(`(?:override\\s+)?fun\\s+${escaped}\\s*\\([^)]*\\)\\s*(?::\\s*String\\??)?\\s*=\\s*["']([^"']+)["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const hit = code.match(pattern)?.[1];
    if (hit) return hit;
  }
  return undefined;
}

function selectHint(code: string, functionName: string): string | undefined {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const direct = code.match(new RegExp(`${escaped}[^\\n{=]*(?:=|\\{)[\\s\\S]{0,900}?\\.select(?:First)?\\(\\s*["']([^"']+)["']`, 'i'))?.[1];
  return direct || stringOverride(code, functionName);
}

function extractCatalogPaths(code: string, family: RecipeFamily): string[] {
  const rows: string[] = [];
  const popularPath = stringOverride(code, 'popularPath');
  if (popularPath) rows.push(`/${popularPath.replace(/^\/+/, '')}`);

  for (const match of code.matchAll(/["']\$baseUrl([^"']+)["']/g)) {
    let path = String(match[1] || '').trim();
    if (!path.startsWith('/')) continue;
    if (!/(popular|hot|comic-list|new-comic|latest|update|filterList|comix)/i.test(path)) continue;
    path = path
      .replace(/\$page/g, '1')
      .replace(/\$\{page\}/g, '1')
      .replace(/\$\{[^}]+\}/g, '')
      .replace(/\s+/g, '');
    if (!/[{}]/.test(path)) rows.push(path);
  }

  if (family === 'mmrcms') rows.push('/filterList?page=1&sortBy=views&asc=false', '/latest-release?page=1');
  if (family === 'wpcomics') rows.push(popularPath ? `/${popularPath}` : '/hot', '/');
  rows.push('/');
  return [...new Set(rows)].slice(0, 10);
}

function classifyFamily(theme: string, code: string): { family: RecipeFamily; requiresBrowser: boolean; reason?: string } {
  const browserMarkers = [
    ['runWebViewBlocking', 'upstream recipe launches WebView'],
    ['CookieManager', 'upstream recipe synchronizes browser cookies'],
    ['android.webkit', 'upstream recipe depends on Android WebView'],
    ['WebView', 'upstream recipe depends on an interactive browser'],
  ] as const;
  for (const [needle, reason] of browserMarkers) {
    if (code.includes(needle)) return { family: 'browser-required', requiresBrowser: true, reason };
  }
  if (/mmrcms/i.test(theme) || /:\s*MMRCMS\s*\(/.test(code)) return { family: 'mmrcms', requiresBrowser: false };
  if (/wpcomics/i.test(theme) || /:\s*WPComics\s*\(/.test(code)) return { family: 'wpcomics', requiresBrowser: false };
  if (/:\s*HttpSource\s*\(/.test(code)) return { family: 'http-source', requiresBrowser: false };
  return { family: 'custom', requiresBrowser: false };
}

function detectQuirks(code: string): string[] {
  const quirks: string[] = [];
  if (/response\.code\s*==\s*404[\s\S]{0,240}\.code\(200\)/.test(code)) quirks.push('image-404-is-success');
  if (/data-src/.test(code)) quirks.push('lazy-data-src');
  if (/data-original/.test(code)) quirks.push('lazy-data-original');
  if (/\/all["']/.test(code) && /chapter\.url/.test(code)) quirks.push('chapter-all-page');
  return [...new Set(quirks)];
}

export async function compileRecipe(target: URL): Promise<RecipePlan | null> {
  const cacheKey = target.hostname.toLowerCase();
  const cached = recipeCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  const found = await findBuild(target);
  if (!found) {
    recipeCache.set(cacheKey, { expires: Date.now() + 5 * 60_000, value: null });
    return null;
  }
  const bundle = await sourceBundle(found.langDir, found.slug);
  const familyInfo = classifyFamily(found.meta.theme, bundle.code);
  const pageSuffix = /chapter\.url[\s\S]{0,120}["']\/all["']|\$\{chapter\.url\}\/all/.test(bundle.code) ? '/all' : undefined;
  const plan: RecipePlan = {
    schema: 'yomu.recipe-plan/1',
    provider: 'keiyoushi',
    slug: found.slug,
    name: found.meta.name || found.slug,
    baseUrl: publicUrl(found.meta.baseUrl).origin,
    language: found.meta.language || found.langDir,
    versionCode: found.meta.versionCode,
    theme: found.meta.theme || undefined,
    family: familyInfo.family,
    requiresBrowser: familyInfo.requiresBrowser,
    browserReason: familyInfo.reason,
    itemPath: stringOverride(bundle.code, 'itemPath'),
    catalogPaths: extractCatalogPaths(bundle.code, familyInfo.family),
    pageSuffix,
    chapterSelector: selectHint(bundle.code, 'chapterListParse') || stringOverride(bundle.code, 'chapterListSelector'),
    pageSelector: selectHint(bundle.code, 'pageListParse') || stringOverride(bundle.code, 'pageListSelector'),
    quirks: detectQuirks(bundle.code),
    sourceFiles: bundle.files,
  };
  recipeCache.set(cacheKey, { expires: Date.now() + RECIPE_CACHE_MS, value: plan });
  return plan;
}

function linksFromHtml(html: string, base: string): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = `<a ${match[1]}>`;
    const resolved = absolute(attr(tag, 'href'), base);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push({ url: resolved, text: cleanText(match[2] || attr(tag, 'title') || attr(tag, 'aria-label')).slice(0, 220) });
    if (out.length >= 2200) break;
  }
  return out;
}

function imagesFromHtml(html: string, base: string): ImageHit[] {
  const out: ImageHit[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const srcset = attr(tag, 'data-srcset') || attr(tag, 'srcset');
    let raw = attr(tag, 'data-src') || attr(tag, 'data-original') || attr(tag, 'data-lazy-src') || attr(tag, 'data-url') || attr(tag, 'src');
    if ((!raw || raw.startsWith('data:')) && srcset) raw = srcset.split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop() || '';
    const resolved = absolute(raw, base);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push({
      url: resolved,
      alt: cleanText(attr(tag, 'alt') || attr(tag, 'title')).slice(0, 180),
      width: Number.parseInt(attr(tag, 'width') || '0', 10) || 0,
      height: Number.parseInt(attr(tag, 'height') || '0', 10) || 0,
      tag,
    });
    if (out.length >= 1400) break;
  }
  return out;
}

function pathDepth(url: string): number {
  try { return new URL(url).pathname.split('/').filter(Boolean).length; } catch { return 0; }
}

function seriesScore(link: Link, plan: RecipePlan): number {
  let score = 0;
  let path = '';
  try { path = new URL(link.url).pathname.toLowerCase(); } catch { return -100; }
  if (!sameSource(link.url, plan.baseUrl)) return -100;
  if (plan.itemPath && new RegExp(`/${plan.itemPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'i').test(path)) score += 8;
  if (/\/(comic|comics|manga|series|title|book|story)\//i.test(path)) score += 6;
  if (/chapter|reader|read-online|issue[-_/]?\d|episode/i.test(path)) score -= 7;
  if (/login|register|privacy|terms|contact|genre|author|search|tag|page\/\d/i.test(path)) score -= 6;
  if (pathDepth(link.url) >= 2) score += 2;
  if (link.text.length >= 3) score += 1;
  if (/next|previous|home|menu|login|register|privacy|contact/i.test(link.text)) score -= 5;
  return score;
}

function catalogSeries(html: string, base: string, plan: RecipePlan): Link[] {
  const scored = linksFromHtml(html, base)
    .map((link) => ({ link, score: seriesScore(link, plan) }))
    .filter((row) => row.score >= 5)
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return scored.map((row) => row.link).filter((row) => !seen.has(row.url) && seen.add(row.url)).slice(0, 180);
}

function chapterScore(link: Link, seriesUrl: string, plan: RecipePlan): number {
  if (!sameSource(link.url, plan.baseUrl) || link.url === seriesUrl) return -100;
  let score = 0;
  const path = new URL(link.url).pathname;
  const seriesPath = new URL(seriesUrl).pathname.replace(/\/$/, '');
  const hay = `${path} ${link.text}`;
  if (/chapter|chapitre|capitulo|episode|reader|read|issue[-_ /#]?\d|#\s*\d+/i.test(hay)) score += 8;
  if (path.startsWith(`${seriesPath}/`) && pathDepth(link.url) > pathDepth(seriesUrl)) score += 6;
  if (/\b(?:ch|chapter|issue|ep)\.?\s*#?\d+/i.test(link.text)) score += 4;
  if (/\b\d{1,4}\b/.test(link.text) && pathDepth(link.url) >= pathDepth(seriesUrl)) score += 2;
  if (/author|genre|publisher|tag|login|share|facebook|twitter|next|previous/i.test(`${path} ${link.text}`)) score -= 6;
  return score;
}

function chapterLinks(html: string, base: string, seriesUrl: string, plan: RecipePlan): Link[] {
  const scored = linksFromHtml(html, base)
    .map((link) => ({ link, score: chapterScore(link, seriesUrl, plan) }))
    .filter((row) => row.score >= 5)
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return scored.map((row) => row.link).filter((row) => !seen.has(row.url) && seen.add(row.url)).slice(0, 500);
}

function readerSlice(html: string, selector?: string): string {
  if (!selector) return html;
  const id = selector.match(/#([a-z0-9_-]+)\s+img/i)?.[1];
  if (id) {
    const match = html.match(new RegExp(`<[^>]+id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i'));
    if (match?.index !== undefined) return html.slice(match.index, Math.min(html.length, match.index + 1_200_000));
  }
  return html;
}

function pageImages(html: string, base: string, plan: RecipePlan): ImageHit[] {
  const source = readerSlice(html, plan.pageSelector);
  let rows = imagesFromHtml(source, base);
  const classHint = plan.pageSelector?.match(/img\.([a-z0-9_-]+)/i)?.[1];
  if (classHint) rows = rows.filter((row) => new RegExp(`\\bclass=["'][^"']*\\b${classHint}\\b`, 'i').test(row.tag));

  const bad = /logo|avatar|icon|banner|advert|ads?\b|emoji|sprite|spacer|tracking|pixel|badge|button|favicon/i;
  const strong = /chapter|reader|page|pages|uploads?|comic|manga|wp-content|cdn|image/i;
  const filtered = rows.filter((img) => {
    const hay = `${img.url} ${img.alt}`;
    if (bad.test(hay)) return false;
    if (img.width && img.height && img.width < 160 && img.height < 160) return false;
    return Boolean(classHint) || strong.test(hay) || img.width >= 480 || img.height >= 650;
  });
  return filtered.length >= 2 ? filtered : rows.filter((img) => !bad.test(`${img.url} ${img.alt}`));
}

function titleFromHtml(html: string, fallback: string): string {
  return cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || fallback)
    .replace(/\s*[|–—-]\s*[^|–—-]{1,60}$/, '')
    .trim() || fallback;
}

function coverFromHtml(html: string, base: string): string | undefined {
  const meta = html.match(/<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i)?.[0] || '';
  const value = absolute(attr(meta, 'content'), base);
  if (value) return value;
  return imagesFromHtml(html, base).find((img) => /cover|poster|thumbnail/i.test(`${img.url} ${img.alt}`))?.url;
}

function chapterNumber(link: Link, fallback: number): number {
  const value = Number(`${link.text} ${link.url}`.match(/(?:chapter|ch|issue|episode|ep)[^0-9]*([0-9]+(?:\.[0-9]+)?)/i)?.[1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function discoverCatalog(plan: RecipePlan, deadline: number, attempts: RecipeProbe['attempts']): Promise<{ url: string; rows: Link[] }> {
  let best = { url: plan.baseUrl, rows: [] as Link[] };
  for (const path of plan.catalogPaths) {
    if (Date.now() >= deadline - 500) break;
    const url = new URL(path || '/', `${plan.baseUrl}/`).toString();
    try {
      const page = await fetchSourceHtml(url, plan.baseUrl, deadline);
      const rows = catalogSeries(page.html, page.finalUrl, plan);
      attempts.push({ stage: 'catalog', input: url, ok: rows.length > 0, count: rows.length });
      if (rows.length > best.rows.length) best = { url: page.finalUrl, rows };
      if (rows.length >= 8) break;
    } catch (error: any) {
      attempts.push({ stage: 'catalog', input: url, ok: false, error: String(error?.message || error).slice(0, 220) });
      if (error?.code === 'BROWSER_REQUIRED') throw error;
    }
  }
  if (!best.rows.length) throw new Error('Recipe paths did not produce a readable catalog.');
  return best;
}

async function discoverDetail(plan: RecipePlan, seriesUrl: string, deadline: number, attempts: RecipeProbe['attempts']) {
  const page = await fetchSourceHtml(seriesUrl, plan.baseUrl, deadline);
  const chapters = chapterLinks(page.html, page.finalUrl, seriesUrl, plan);
  attempts.push({ stage: 'chapters', input: seriesUrl, ok: chapters.length > 0, count: chapters.length });
  if (!chapters.length) throw new Error('Recipe runtime found the series but no issue/chapter links.');
  return { html: page.html, finalUrl: page.finalUrl, chapters };
}

async function discoverPages(plan: RecipePlan, chapterUrl: string, deadline: number, attempts: RecipeProbe['attempts']) {
  const candidates = [chapterUrl];
  if (plan.pageSuffix && !chapterUrl.replace(/\/$/, '').endsWith(plan.pageSuffix)) candidates.unshift(chapterUrl.replace(/\/$/, '') + plan.pageSuffix);
  let best: ImageHit[] = [];
  let bestUrl = chapterUrl;
  for (const url of [...new Set(candidates)]) {
    if (Date.now() >= deadline - 400) break;
    try {
      const page = await fetchSourceHtml(url, plan.baseUrl, deadline);
      const images = pageImages(page.html, page.finalUrl, plan);
      attempts.push({ stage: 'pages', input: url, ok: images.length >= 2, count: images.length });
      if (images.length > best.length) { best = images; bestUrl = page.finalUrl; }
      if (images.length >= 2) break;
    } catch (error: any) {
      attempts.push({ stage: 'pages', input: url, ok: false, error: String(error?.message || error).slice(0, 220) });
      if (error?.code === 'BROWSER_REQUIRED') throw error;
    }
  }
  if (best.length < 2) throw new Error('Recipe runtime could not prove actual reader page images.');
  return { images: best, finalUrl: bestUrl };
}

async function gauntlet(plan: RecipePlan): Promise<RecipeProbe> {
  const attempts: RecipeProbe['attempts'] = [];
  if (plan.requiresBrowser) return { ready: false, catalogCount: 0, pageCount: 0, attempts };
  const deadline = Date.now() + PROBE_BUDGET;
  try {
    const catalog = await discoverCatalog(plan, deadline, attempts);
    for (const series of catalog.rows.slice(0, 6)) {
      if (Date.now() >= deadline - 1_000) break;
      try {
        const detail = await discoverDetail(plan, series.url, deadline, attempts);
        for (const chapter of detail.chapters.slice(0, 5)) {
          if (Date.now() >= deadline - 700) break;
          try {
            const pages = await discoverPages(plan, chapter.url, deadline, attempts);
            return {
              ready: true,
              catalogUrl: catalog.url,
              catalogCount: catalog.rows.length,
              sampleSeries: series.url,
              sampleChapter: chapter.url,
              pageCount: pages.images.length,
              attempts,
            };
          } catch {}
        }
      } catch {}
    }
    return { ready: false, catalogUrl: catalog.url, catalogCount: catalog.rows.length, pageCount: 0, attempts };
  } catch (error: any) {
    attempts.push({ stage: 'recipe', input: plan.baseUrl, ok: false, error: String(error?.message || error).slice(0, 220) });
    return { ready: false, catalogCount: 0, pageCount: 0, attempts };
  }
}

function adapter(plan: RecipePlan, origin: string, probe: RecipeProbe) {
  const token = encodePlan(plan);
  const rootHost = host(plan.baseUrl);
  return {
    id: `recipe-${plan.slug}`,
    name: plan.name,
    version: plan.versionCode,
    language: plan.language,
    content: ['comic', 'manga', 'manhwa', 'manhua', 'webtoon'],
    capabilities: { search: true, popular: true, latest: true, details: true, chapters: true, pages: true },
    nsfw: false,
    hosts: [rootHost, `*.${rootHost}`],
    api: `${origin}/api/fabric/recipe/${token}/`,
    runtime: 'fabric-recipe',
    engine: `Recipe Adaptive · ${plan.family}`,
    score: Math.min(99, 88 + Math.min(10, probe.pageCount)),
    strategy: `keiyoushi-${plan.family}`,
  };
}

export async function tryRecipeResolve(target: URL, origin: string): Promise<any | null> {
  const plan = await compileRecipe(target).catch(() => null);
  if (!plan) return null;
  if (plan.requiresBrowser) {
    return {
      ok: true,
      ready: false,
      route: 'recipe-browser-required',
      confidence: 'high',
      score: 0,
      recipe: plan,
      runtime: 'browser',
      message: `${plan.name} has a maintained ${plan.provider} recipe, but that upstream recipe itself requires browser/WebView state (${plan.browserReason || 'interactive browser dependency'}).`,
    };
  }
  const probe = await gauntlet(plan);
  if (!probe.ready) {
    return {
      ok: true,
      ready: false,
      route: 'recipe-adaptive-exhausted',
      confidence: 'medium',
      score: 0,
      recipe: plan,
      probe,
      message: `${plan.name} was compiled as ${plan.family}, but the recipe-aware Worker gauntlet could not yet prove catalog → issues → reader pages.`,
    };
  }
  return {
    ok: true,
    ready: true,
    route: 'recipe-adaptive',
    confidence: 'high',
    score: Math.min(99, 88 + Math.min(10, probe.pageCount)),
    adapter: adapter(plan, origin, probe),
    recipe: plan,
    probe,
    message: `Recipe Adaptive compiled ${plan.name} from its maintained ${plan.provider} ${plan.family} recipe and verified catalog → issues → reader pages.`,
  };
}

function summary(link: Link, index: number) {
  let fallback = link.url;
  try { fallback = decodeURIComponent(new URL(link.url).pathname.split('/').filter(Boolean).pop() || new URL(link.url).hostname).replace(/[-_]+/g, ' '); } catch {}
  return { id: encodeToken(link.url), title: link.text || fallback, category: 'comic', updatedAt: Date.now() - index };
}

export async function handleRecipeRuntime(request: Request, _env: Env, url: URL): Promise<Response> {
  const match = url.pathname.match(/^\/api\/fabric\/recipe\/([^/]+)\/(.*)$/);
  if (!match) return json({ error: 'Unknown Recipe Adaptive route.' }, 404);
  if (request.method !== 'GET') return json({ error: 'Recipe Adaptive sources expose read-only GET endpoints.' }, 405);

  let plan: RecipePlan;
  try { plan = decodePlan(match[1]); } catch { return json({ error: 'Invalid recipe token.' }, 400); }
  const rest = match[2];
  const deadline = Date.now() + PROBE_BUDGET;
  const attempts: RecipeProbe['attempts'] = [];

  try {
    if (rest === 'series' || rest === 'latest') {
      const pageNo = Math.max(1, Number(url.searchParams.get('page') || '1') || 1);
      const catalog = await discoverCatalog(plan, deadline, attempts);
      const start = (pageNo - 1) * 35;
      return json({ series: catalog.rows.slice(start, start + 35).map(summary), hasNextPage: catalog.rows.length > start + 35, recipeFamily: plan.family }, 200, 'private, max-age=120');
    }
    if (rest === 'search') {
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      if (!q) return json({ series: [] });
      const catalog = await discoverCatalog(plan, deadline, attempts);
      const rows = catalog.rows.filter((row) => `${row.text} ${row.url}`.toLowerCase().includes(q));
      return json({ series: rows.slice(0, 50).map(summary), hasNextPage: false, recipeFamily: plan.family });
    }
    const seriesMatch = rest.match(/^series\/([^/]+)$/);
    if (seriesMatch) {
      const seriesUrl = decodeToken(decodeURIComponent(seriesMatch[1]));
      if (!sameSource(seriesUrl, plan.baseUrl)) return json({ error: 'Series URL is outside this recipe source.' }, 400);
      const detail = await discoverDetail(plan, seriesUrl, deadline, attempts);
      const title = titleFromHtml(detail.html, seriesUrl);
      return json({
        id: encodeToken(detail.finalUrl),
        title,
        synopsis: '',
        ...(coverFromHtml(detail.html, detail.finalUrl) ? { cover: coverFromHtml(detail.html, detail.finalUrl) } : {}),
        category: 'comic',
        chapters: detail.chapters.map((chapter, i) => ({ id: encodeToken(chapter.url), number: chapterNumber(chapter, Math.max(1, detail.chapters.length - i)), name: chapter.text || `Issue ${Math.max(1, detail.chapters.length - i)}` })),
        recipeFamily: plan.family,
      }, 200, 'private, max-age=120');
    }
    const manifest = rest.match(/^chapters\/([^/]+)\/manifest$/);
    if (manifest) {
      const chapterId = decodeURIComponent(manifest[1]);
      const chapterUrl = decodeToken(chapterId);
      if (!sameSource(chapterUrl, plan.baseUrl)) return json({ error: 'Chapter URL is outside this recipe source.' }, 400);
      const pages = await discoverPages(plan, chapterUrl, deadline, attempts);
      return json({
        schema: 'yomu.chapter-manifest/1',
        chapterId,
        sourceSeriesId: '',
        manifestVersion: `recipe-v1-${chapterId.slice(0, 12)}-${pages.images.length}`,
        pageListVersion: pages.images.length,
        expiresAt: Date.now() + 10 * 60 * 1000,
        pages: pages.images.map((image, index) => ({ key: `${chapterId.slice(0, 12)}-${index}`, index, url: image.url })),
        delivery: 'direct',
        recipeFamily: plan.family,
      });
    }
    return json({ error: 'Unknown Recipe Adaptive endpoint.' }, 404);
  } catch (error: any) {
    return json({ error: String(error?.message || error).slice(0, 420), failureKind: error?.code === 'BROWSER_REQUIRED' ? 'browser-required' : 'recipe-runtime-error', attempts }, error?.status === 404 ? 404 : 502);
  }
}

export async function handleRecipeAwareResolve(bodyText: string, env: Env, url: URL, fallbackPromise: Promise<Response>): Promise<Response> {
  let body: any = {};
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch {}
  let target: URL;
  try { target = publicUrl(String(body?.url || '')); } catch { return fallbackPromise; }

  const [fallback, recipe] = await Promise.all([
    fallbackPromise,
    tryRecipeResolve(target, url.origin).catch(() => null),
  ]);
  const fallbackPayload: any = await fallback.clone().json().catch(() => null);
  if (fallbackPayload?.ready && fallbackPayload?.adapter) return fallback;
  if (!recipe) return fallback;

  const evidence = Array.isArray(fallbackPayload?.evidence) ? fallbackPayload.evidence : [];
  const recipeEvidence = {
    ecosystem: 'keiyoushi-source',
    store: 'Keiyoushi source recipes',
    name: recipe.recipe?.name,
    baseUrl: recipe.recipe?.baseUrl,
    family: recipe.recipe?.family,
    versionCode: recipe.recipe?.versionCode,
    sourceFiles: recipe.recipe?.sourceFiles,
  };

  return json({
    ...(fallbackPayload && typeof fallbackPayload === 'object' ? fallbackPayload : {}),
    ...recipe,
    evidence: [...evidence, recipeEvidence],
    fabric: {
      ...(fallbackPayload?.fabric || {}),
      version: VERSION,
      generation: 'Recipe Adaptive',
      recipeAdaptive: true,
    },
  });
}

export function recipeStatus() {
  return {
    version: VERSION,
    engine: 'recipe-adaptive',
    provider: 'keiyoushi',
    families: ['http-source', 'mmrcms', 'wpcomics', 'custom', 'browser-required'],
    behavior: 'compile maintained source recipe → worker gauntlet → adapter; browser only when upstream recipe requires it',
  };
}
