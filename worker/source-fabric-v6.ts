import type { Env } from './index';
import {
  fabricSourceCards as legacyFabricSourceCards,
  handleFabric as handleFabricV5,
} from './source-fabric';

/**
 * Yomu Source Fabric v6 — adaptive remote runtime.
 *
 * Hunter's useful trait is not any one scraper. It is the refusal to treat the
 * first miss as the final answer. v6 applies the same idea inside the Worker:
 * exact pasted URLs, normal HTML discovery, embedded Next/JSON data, Madara
 * chapter fallbacks, WordPress REST, sitemaps, and known registry base URLs are
 * tried as a bounded strategy ladder. Every request stays inside the public
 * source site for HTML/API discovery; there is no CAPTCHA, paywall, DRM, or
 * access-control bypass here.
 */

type AnyObject = Record<string, any>;
type Anchor = { url: string; text: string };
type ImageHit = { url: string; alt: string; width: number; height: number };
type Scan = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  title: string;
  description: string;
  cover?: string;
  anchors: Anchor[];
  images: ImageHit[];
  html: string;
};
type Attempt = {
  strategy: string;
  stage: 'seed' | 'catalog' | 'chapters' | 'pages';
  input?: string;
  ok: boolean;
  count?: number;
  failureKind?: string;
  error?: string;
};
type CatalogResult = { scan: Scan; series: Anchor[]; strategy: string };
type DetailResult = { detail: AnyObject; strategy: string };
type PagesResult = { pages: Array<{ key: string; index: number; url: string }>; strategy: string };
type DynamicConfig = { root: string; seedSeries?: string; strategy?: string };

const VERSION = '6.0';
const UA = `Mozilla/5.0 (compatible; Yomu-Source-Fabric/${VERSION}; +https://yomu.yomuread.workers.dev)`;
const MAX_HTML = 3_000_000;
const MAX_AUX_TEXT = 2_000_000;
const PROBE_BUDGET_MS = 32_000;
const FETCH_MAX_MS = 7_000;
const CACHE_MS = 3 * 60_000;
const catalogCache = new Map<string, { expires: number; value: CatalogResult }>();

const SERIES_RE = /\/(manga|manhwa|manhua|series|webtoon|webtoons|comic|comics|title|titles|book|books|novel|novels|toon|toons|story|stories|project|projects|works?)\//i;
const CHAPTER_RE = /\/(chapter|chapters?|chapitre|capitulo|capítulo|episode|episodes?|ep[-_/]?\d|ch[-_/]?\d|reader|read)\b|\b(chapter|chapitre|capitulo|capítulo|episode|ep|ch)[-_ /]?[0-9]+/i;
const JUNK_RE = /\/(tag|tags|genre|genres|author|artist|login|register|privacy|terms|contact|about|search|wp-admin|feed|account|user)(\/|$)/i;
const IMAGE_RE = /\.(?:avif|webp|jpe?g|png|gif|jxl)(?:[?#].*)?$/i;

export const fabricSourceCards = legacyFabricSourceCards;

const json = (body: unknown, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  });

const cleanText = (value: string) =>
  value
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

function decodeAttr(value: string): string {
  return value
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

function absolute(input: string, base: string): string | null {
  try {
    const normalized = decodeAttr(String(input || '')).replace(/^\\\//, '//');
    const u = new URL(normalized, base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function hostname(input: string): string {
  try { return new URL(input).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function obviousPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^(::1|fc|fd|fe80)/i.test(h)) return true;
  return false;
}

function publicUrl(input: string): URL {
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('Paste a public website URL.');
  if (obviousPrivateHost(u.hostname)) throw new Error('Local/private network addresses cannot be added as Yomu sources.');
  u.hash = '';
  return u;
}

function sameSite(candidate: string, rootHost: string): boolean {
  const h = hostname(candidate);
  return !!h && (h === rootHost || h.endsWith(`.${rootHost}`) || rootHost.endsWith(`.${h}`));
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
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeDynamicConfig(config: DynamicConfig): string {
  return encodeToken(JSON.stringify({ v: 2, ...config }));
}

function decodeDynamicConfig(token: string): DynamicConfig {
  const raw = decodeToken(token);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.root === 'string') return { root: parsed.root, seedSeries: parsed.seedSeries, strategy: parsed.strategy };
  } catch {}
  return { root: raw };
}

function compactError(error: any): string {
  return String(error?.message ?? error ?? 'Unknown error').replace(/\s+/g, ' ').slice(0, 420);
}

function failureKind(error: any): string {
  const code = String(error?.code ?? '');
  const status = Number(error?.status ?? 0);
  const message = compactError(error).toLowerCase();
  if (code === 'ACCESS_CHALLENGE' || status === 401 || status === 403 || /captcha|access check|cloudflare challenge|just a moment/.test(message)) return 'access-blocked';
  if (status === 429 || /rate.?limit|too many requests/.test(message)) return 'rate-limited';
  if (code === 'NO_CATALOG') return 'discovery-miss';
  if (code === 'NO_CHAPTERS') return 'chapter-miss';
  if (code === 'NO_PAGES') return 'reader-miss';
  if (code === 'PROBE_BUDGET') return 'budget-exhausted';
  if (/timeout|timed out/.test(message)) return 'timeout';
  if (/javascript|client-rendered|browser engine/.test(message)) return 'js-rendered';
  return 'probe-error';
}

function codedError(code: string, message: string, extra: AnyObject = {}): Error {
  return Object.assign(new Error(message), { code, ...extra });
}

function timeLeft(deadline: number, max = FETCH_MAX_MS): number {
  const left = deadline - Date.now();
  if (left <= 350) throw codedError('PROBE_BUDGET', 'Adaptive Source Fabric exhausted its safe probe budget.');
  return Math.max(350, Math.min(max, left));
}

function challengeHtml(html: string, title: string): boolean {
  const head = `${title}\n${html.slice(0, 80_000)}`.toLowerCase();
  return /cf-chl-|challenge-platform|cloudflare ray id|checking your browser|just a moment\.\.\.|attention required!|g-recaptcha|hcaptcha-container/.test(head);
}

function makeHeaders(init?: HeadersInit, accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'): Headers {
  const headers = new Headers(init);
  if (!headers.has('user-agent')) headers.set('user-agent', UA);
  if (!headers.has('accept')) headers.set('accept', accept);
  if (!headers.has('accept-language')) headers.set('accept-language', 'en-US,en;q=0.8');
  return headers;
}

async function fetchText(
  input: string,
  rootHost: string | undefined,
  deadline: number,
  init: RequestInit = {},
  maxBytes = MAX_AUX_TEXT,
  accept = 'text/plain,text/xml,application/xml,text/html;q=0.8,*/*;q=0.3',
): Promise<{ text: string; finalUrl: string; status: number; type: string }> {
  const target = publicUrl(input);
  if (rootHost && !sameSite(target.toString(), rootHost)) throw new Error('Source Fabric refused to leave the source website.');
  const response = await fetch(target.toString(), {
    ...init,
    redirect: 'follow',
    headers: makeHeaders(init.headers, accept),
    signal: AbortSignal.timeout(timeLeft(deadline)),
  });
  const finalUrl = response.url || target.toString();
  if (rootHost && !sameSite(finalUrl, rootHost)) throw new Error('Source Fabric refused a cross-site redirect.');
  if (!response.ok) throw Object.assign(new Error(`Website returned HTTP ${response.status}.`), { status: response.status });
  const text = (await response.text()).slice(0, maxBytes);
  return { text, finalUrl, status: response.status, type: response.headers.get('content-type') ?? '' };
}

function parseScan(input: { text: string; finalUrl: string; status: number }, requestedUrl: string): Scan {
  const html = input.text;
  const title = cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || hostname(input.finalUrl);
  if (challengeHtml(html, title)) throw codedError('ACCESS_CHALLENGE', 'Website returned an access challenge instead of readable source HTML.');
  const descriptionTag = html.match(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*>/i)?.[0] ?? '';
  const description = cleanText(attr(descriptionTag, 'content'));
  const coverTag = html.match(/<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i)?.[0] ?? '';
  const cover = absolute(attr(coverTag, 'content'), input.finalUrl) ?? undefined;

  const anchors: Anchor[] = [];
  const seenA = new Set<string>();
  const addAnchor = (raw: string, text: string) => {
    if (!raw || raw.startsWith('#') || /^(javascript:|mailto:|tel:)/i.test(raw)) return;
    const resolved = absolute(raw, input.finalUrl);
    if (!resolved || seenA.has(resolved)) return;
    seenA.add(resolved);
    anchors.push({ url: resolved, text: cleanText(text).slice(0, 180) });
  };
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    addAnchor(attr(`<a ${m[1]}>`, 'href'), m[2] ?? '');
    if (anchors.length >= 1600) break;
  }
  for (const m of html.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
    const tag = `<option ${m[1]}>`;
    addAnchor(attr(tag, 'value'), m[2] ?? '');
    if (anchors.length >= 1800) break;
  }

  const images: ImageHit[] = [];
  const seenI = new Set<string>();
  const addImage = (raw: string, tag: string, alt = '') => {
    if (!raw || raw.startsWith('data:')) return;
    const resolved = absolute(raw, input.finalUrl);
    if (!resolved || seenI.has(resolved)) return;
    seenI.add(resolved);
    images.push({
      url: resolved,
      alt: cleanText(alt).slice(0, 180),
      width: Number.parseInt(attr(tag, 'width') || '0', 10) || 0,
      height: Number.parseInt(attr(tag, 'height') || '0', 10) || 0,
    });
  };
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    let raw = attr(tag, 'data-src') || attr(tag, 'data-lazy-src') || attr(tag, 'data-original') || attr(tag, 'data-url') || attr(tag, 'data-image') || attr(tag, 'data-cfsrc') || attr(tag, 'src');
    const srcset = attr(tag, 'data-srcset') || attr(tag, 'srcset');
    if ((!raw || raw.startsWith('data:')) && srcset) raw = srcset.split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop() ?? '';
    addImage(raw, tag, attr(tag, 'alt') || attr(tag, 'title'));
    if (images.length >= 1000) break;
  }
  for (const m of html.matchAll(/<source\b[^>]*>/gi)) {
    const tag = m[0];
    const srcset = attr(tag, 'data-srcset') || attr(tag, 'srcset');
    const raw = srcset.split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop() ?? '';
    addImage(raw, tag);
    if (images.length >= 1100) break;
  }

  return {
    requestedUrl,
    finalUrl: input.finalUrl,
    status: input.status,
    title,
    description,
    cover,
    anchors,
    images,
    html,
  };
}

async function fetchHtml(input: string, rootHost: string | undefined, deadline: number, init: RequestInit = {}): Promise<Scan> {
  const row = await fetchText(input, rootHost, deadline, init, MAX_HTML, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.4');
  const type = row.type.toLowerCase();
  if (type && !type.includes('text/html') && !type.includes('application/xhtml')) throw new Error('Website did not return an HTML page.');
  return parseScan(row, input);
}

async function fetchJson(input: string, rootHost: string, deadline: number): Promise<any> {
  const target = publicUrl(input);
  if (!sameSite(target.toString(), rootHost)) throw new Error('Source Fabric refused to leave the source website.');
  const response = await fetch(target.toString(), {
    redirect: 'follow',
    headers: makeHeaders(undefined, 'application/json,text/plain;q=0.8,*/*;q=0.3'),
    signal: AbortSignal.timeout(timeLeft(deadline)),
  });
  const finalUrl = response.url || target.toString();
  if (!sameSite(finalUrl, rootHost)) throw new Error('Source Fabric refused a cross-site redirect.');
  if (!response.ok) throw Object.assign(new Error(`Website returned HTTP ${response.status}.`), { status: response.status });
  return response.json();
}

function uniqueAnchors(rows: Anchor[]): Anchor[] {
  const out: Anchor[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row?.url || seen.has(row.url)) continue;
    seen.add(row.url);
    out.push(row);
  }
  return out;
}

function seriesCandidates(scan: Scan, rootHost: string): Anchor[] {
  const out: Anchor[] = [];
  for (const a of scan.anchors) {
    if (!sameSite(a.url, rootHost)) continue;
    const path = new URL(a.url).pathname;
    if (JUNK_RE.test(path) || CHAPTER_RE.test(`${path} ${a.text}`)) continue;
    if (!SERIES_RE.test(path)) continue;
    const depth = path.replace(/\/$/, '').split('/').filter(Boolean).length;
    if (depth < 2) continue;
    out.push(a);
  }
  return uniqueAnchors(out);
}

function chapterCandidates(scan: Scan, rootHost: string): Anchor[] {
  const out: Anchor[] = [];
  for (const a of scan.anchors) {
    if (!sameSite(a.url, rootHost)) continue;
    const path = new URL(a.url).pathname;
    if (!CHAPTER_RE.test(`${path} ${a.text}`)) continue;
    out.push(a);
  }
  return uniqueAnchors(out);
}

function parseJsonScripts(html: string): any[] {
  const rows: any[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (rows.length >= 18) break;
    const tag = `<script ${m[1]}>`;
    const id = attr(tag, 'id').toLowerCase();
    const type = attr(tag, 'type').toLowerCase();
    if (id !== '__next_data__' && !/application\/(?:ld\+json|json)/.test(type)) continue;
    const raw = (m[2] ?? '').trim();
    if (!raw || raw.length > 800_000) continue;
    try { rows.push(JSON.parse(raw)); } catch {}
  }
  return rows;
}

function walkJson(value: any, visit: (node: AnyObject, path: string) => void, path = '', state = { count: 0 }): void {
  if (state.count++ > 10_000 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && i < 1000; i++) walkJson(value[i], visit, `${path}[${i}]`, state);
    return;
  }
  if (typeof value !== 'object') return;
  visit(value as AnyObject, path);
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'object' && child !== null) walkJson(child, visit, path ? `${path}.${key}` : key, state);
  }
}

function embeddedAnchors(scan: Scan, rootHost: string, kind: 'series' | 'chapter'): Anchor[] {
  const rows: Anchor[] = [];
  const wanted = kind === 'series' ? SERIES_RE : CHAPTER_RE;
  for (const payload of parseJsonScripts(scan.html)) {
    walkJson(payload, (node) => {
      const text = cleanText(String(node.title ?? node.name ?? node.label ?? node.chapterName ?? node.chapter_name ?? node.episodeName ?? ''));
      const rawValues = [node.url, node.link, node.href, node.permalink, node.path].filter((x) => typeof x === 'string') as string[];
      if (kind === 'chapter' && typeof node.slug === 'string' && /(?:chapter|chap|ch|episode|ep)[-_ ]?\d/i.test(node.slug)) rawValues.push(node.slug);
      for (const raw of rawValues) {
        const base = kind === 'chapter' && !/^https?:\/\//i.test(raw) && !raw.startsWith('/')
          ? (scan.finalUrl.endsWith('/') ? scan.finalUrl : `${scan.finalUrl}/`)
          : scan.finalUrl;
        const resolved = absolute(raw, base);
        if (!resolved || !sameSite(resolved, rootHost)) continue;
        if (!wanted.test(`${new URL(resolved).pathname} ${text}`)) continue;
        rows.push({ url: resolved, text });
      }
    });
  }
  return uniqueAnchors(rows);
}

function pageImages(scan: Scan): ImageHit[] {
  const bad = /logo|avatar|icon|banner|advert|ads?\b|emoji|sprite|spacer|tracking|pixel|badge|button|favicon|social/i;
  const strong = /chapter|reader|page|pages|uploads?|manga|manhwa|webtoon|comic|wp-content|cdn|image|media/i;
  return scan.images.filter((img) => {
    const hay = `${img.url} ${img.alt}`;
    if (bad.test(hay)) return false;
    if (img.width && img.height && img.width < 180 && img.height < 180) return false;
    return strong.test(hay) || img.width >= 500 || img.height >= 700 || IMAGE_RE.test(img.url);
  });
}

function extractQuotedImages(raw: string, base: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of raw.matchAll(/["']([^"']+)["']/g)) {
    const value = decodeAttr(m[1]);
    if (!IMAGE_RE.test(value) && !/(?:\/uploads?\/|\/images?\/|\/pages?\/)/i.test(value)) continue;
    const resolved = absolute(value, base);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function extractTsReaderImages(html: string, base: string): string[] {
  const sources: string[] = [html];
  for (const m of html.matchAll(/data:text\/javascript;base64,([A-Za-z0-9+/=]{20,700000})/gi)) {
    try {
      const decoded = atob(m[1]);
      if (/ts_reader\.run/i.test(decoded)) sources.push(decoded);
    } catch {}
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const m of source.matchAll(/ts_reader\.run\(\s*(\{[\s\S]{1,350000}?\})\s*\)\s*;?/gi)) {
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(m[1]);
        const candidates = parsed?.sources?.flatMap?.((x: any) => x?.images ?? []) ?? [];
        urls = candidates.map((x: any) => typeof x === 'string' ? x : x?.url ?? x?.src ?? '').filter(Boolean);
      } catch {
        const array = m[1].match(/["']images["']\s*:\s*(\[[\s\S]*?\])/i)?.[1] ?? '';
        urls = extractQuotedImages(array, base);
      }
      for (const raw of urls) {
        const resolved = absolute(String(raw), base);
        if (!resolved || seen.has(resolved)) continue;
        seen.add(resolved);
        out.push(resolved);
      }
    }
  }
  return out;
}

function extractEmbeddedImages(scan: Scan): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const payload of parseJsonScripts(scan.html)) {
    walkJson(payload, (node, path) => {
      const context = path.toLowerCase();
      const strongContext = /page|reader|chapter|image|media|source/.test(context);
      if (!strongContext) return;
      for (const [key, value] of Object.entries(node)) {
        if (!/url|src|image|page|file|path/i.test(key)) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
          const raw = typeof item === 'string' ? item : (item && typeof item === 'object' ? String((item as any).url ?? (item as any).src ?? (item as any).image ?? '') : '');
          if (!raw || (!IMAGE_RE.test(raw) && !/(?:\/uploads?\/|\/images?\/|\/pages?\/|cdn)/i.test(raw))) continue;
          const resolved = absolute(raw, scan.finalUrl);
          if (!resolved || seen.has(resolved)) continue;
          seen.add(resolved);
          out.push(resolved);
        }
      }
    });
  }
  return out;
}

function candidateCatalogUrls(input: URL): string[] {
  const origin = input.origin;
  const rows = [
    origin + '/',
    origin + '/manga/', origin + '/manga',
    origin + '/series/', origin + '/series',
    origin + '/comics/', origin + '/comics',
    origin + '/webtoon/', origin + '/webtoons/',
    origin + '/browse/', origin + '/latest/', origin + '/updates/',
    origin + '/manga-list/', origin + '/all-manga/', origin + '/library/', origin + '/directory/',
    origin + '/projects/', origin + '/komik/', origin + '/daftar-manga/',
  ];
  const seg = input.pathname.split('/').filter(Boolean);
  if (seg.length >= 1 && !/^(chapter|read|reader)$/i.test(seg[0])) rows.unshift(`${origin}/${seg[0]}/`);
  return [...new Set(rows)];
}

function slugTitle(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  } catch { return url; }
}

function sitemapSeries(text: string, rootHost: string): { series: Anchor[]; sitemapChildren: string[] } {
  const series: Anchor[] = [];
  const children: string[] = [];
  for (const m of text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    const raw = decodeAttr(m[1]);
    let u: URL;
    try { u = publicUrl(raw); } catch { continue; }
    if (!sameSite(u.toString(), rootHost)) continue;
    if (/\.xml(?:$|\?)/i.test(u.pathname + u.search)) {
      children.push(u.toString());
      continue;
    }
    if (!SERIES_RE.test(u.pathname) || CHAPTER_RE.test(u.pathname) || JUNK_RE.test(u.pathname)) continue;
    const depth = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).length;
    if (depth < 2) continue;
    series.push({ url: u.toString(), text: slugTitle(u.toString()) });
  }
  return { series: uniqueAnchors(series), sitemapChildren: [...new Set(children)] };
}

async function discoverSitemap(root: URL, deadline: number, attempts: Attempt[]): Promise<Anchor[]> {
  const rootHost = hostname(root.toString());
  const urls = [
    new URL('/wp-sitemap.xml', root).toString(),
    new URL('/sitemap.xml', root).toString(),
    new URL('/sitemap_index.xml', root).toString(),
    new URL('/wp-sitemap-posts-wp-manga-1.xml', root).toString(),
    new URL('/manga-sitemap.xml', root).toString(),
  ];
  const settled = await Promise.allSettled(urls.map((u) => fetchText(u, rootHost, deadline, {}, MAX_AUX_TEXT)));
  const found: Anchor[] = [];
  const childUrls: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status !== 'fulfilled') continue;
    const parsed = sitemapSeries(result.value.text, rootHost);
    found.push(...parsed.series);
    childUrls.push(...parsed.sitemapChildren.filter((x) => /manga|comic|series|title|post|wp-manga/i.test(x)));
  }
  if (found.length < 3 && childUrls.length && deadline - Date.now() > 1200) {
    const childSettled = await Promise.allSettled([...new Set(childUrls)].slice(0, 4).map((u) => fetchText(u, rootHost, deadline, {}, MAX_AUX_TEXT)));
    for (const result of childSettled) if (result.status === 'fulfilled') found.push(...sitemapSeries(result.value.text, rootHost).series);
  }
  const rows = uniqueAnchors(found);
  attempts.push({ strategy: 'sitemap-catalog', stage: 'catalog', input: root.origin, ok: rows.length > 0, count: rows.length });
  return rows;
}

function wpRows(payload: any, rootHost: string): Anchor[] {
  const rows = Array.isArray(payload) ? payload : [];
  const out: Anchor[] = [];
  for (const item of rows) {
    const raw = item?.link ?? item?.url ?? item?.permalink;
    if (typeof raw !== 'string') continue;
    const resolved = absolute(raw, `https://${rootHost}/`);
    if (!resolved || !sameSite(resolved, rootHost)) continue;
    const rendered = typeof item?.title === 'object' ? item.title.rendered : item?.title;
    out.push({ url: resolved, text: cleanText(String(rendered ?? item?.name ?? slugTitle(resolved))) });
  }
  return uniqueAnchors(out);
}

async function discoverWordPress(root: URL, deadline: number, attempts: Attempt[]): Promise<Anchor[]> {
  const rootHost = hostname(root.toString());
  const urls = [
    new URL('/wp-json/wp/v2/wp-manga?per_page=40&_fields=link,title', root).toString(),
    new URL('/wp-json/wp/v2/manga?per_page=40&_fields=link,title', root).toString(),
  ];
  const settled = await Promise.allSettled(urls.map((u) => fetchJson(u, rootHost, deadline)));
  const rows: Anchor[] = [];
  for (const result of settled) if (result.status === 'fulfilled') rows.push(...wpRows(result.value, rootHost));
  const out = uniqueAnchors(rows);
  attempts.push({ strategy: 'wordpress-rest-catalog', stage: 'catalog', input: root.origin, ok: out.length > 0, count: out.length });
  return out;
}

async function discoverCatalogAdaptive(root: URL, seedSeries: string | undefined, deadline: number, attempts: Attempt[]): Promise<CatalogResult> {
  const cacheKey = root.origin;
  const cached = catalogCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;
  const rootHost = hostname(root.toString());
  let best: CatalogResult | null = null;
  const urls = candidateCatalogUrls(seedSeries ? publicUrl(seedSeries) : root).slice(0, 10);
  const settled = await Promise.allSettled(urls.map((u) => fetchHtml(u, rootHost, deadline)));
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status !== 'fulfilled') continue;
    const regular = seriesCandidates(result.value, rootHost);
    const embedded = embeddedAnchors(result.value, rootHost, 'series');
    const rows = uniqueAnchors([...regular, ...embedded]);
    const strategy = embedded.length > regular.length ? 'embedded-json-catalog' : 'html-catalog';
    if (!best || rows.length > best.series.length) best = { scan: result.value, series: rows, strategy };
  }
  attempts.push({ strategy: best?.strategy ?? 'html-catalog', stage: 'catalog', input: root.origin, ok: Boolean(best?.series.length), count: best?.series.length ?? 0 });

  if ((!best || best.series.length < 3) && deadline - Date.now() > 1500) {
    try {
      const rows = await discoverSitemap(root, deadline, attempts);
      if (rows.length && (!best || rows.length > best.series.length)) {
        const scan = best?.scan ?? await fetchHtml(root.toString(), rootHost, deadline);
        best = { scan, series: rows, strategy: 'sitemap-catalog' };
      }
    } catch (error) {
      attempts.push({ strategy: 'sitemap-catalog', stage: 'catalog', input: root.origin, ok: false, failureKind: failureKind(error), error: compactError(error) });
    }
  }

  if ((!best || best.series.length < 3) && deadline - Date.now() > 1500) {
    try {
      const rows = await discoverWordPress(root, deadline, attempts);
      if (rows.length && (!best || rows.length > best.series.length)) {
        const scan = best?.scan ?? await fetchHtml(root.toString(), rootHost, deadline);
        best = { scan, series: rows, strategy: 'wordpress-rest-catalog' };
      }
    } catch (error) {
      attempts.push({ strategy: 'wordpress-rest-catalog', stage: 'catalog', input: root.origin, ok: false, failureKind: failureKind(error), error: compactError(error) });
    }
  }

  if (seedSeries && sameSite(seedSeries, rootHost)) {
    const seed: Anchor = { url: seedSeries, text: slugTitle(seedSeries) };
    if (best) best = { ...best, series: uniqueAnchors([seed, ...best.series]) };
    else {
      const scan = await fetchHtml(seedSeries, rootHost, deadline);
      best = { scan, series: [seed], strategy: 'seed-series' };
    }
  }

  if (!best || !best.series.length) throw codedError('NO_CATALOG', 'Source Fabric exhausted HTML, embedded JSON, sitemap and WordPress catalog discovery without finding a series.');
  if (best.series.length >= 3) catalogCache.set(cacheKey, { expires: Date.now() + CACHE_MS, value: best });
  return best;
}

function looksMadara(html: string): boolean {
  return /wp-manga|manga-chapters-holder|manga_get_chapters|listing-chapters_wrap|madara/i.test(html);
}

async function madaraChapterFallback(root: URL, seriesUrl: string, seriesScan: Scan, deadline: number, attempts: Attempt[]): Promise<Anchor[]> {
  if (!looksMadara(seriesScan.html)) return [];
  const rootHost = hostname(root.toString());
  const out: Anchor[] = [];
  const ajaxUrl = `${seriesUrl.replace(/\/+$/, '')}/ajax/chapters/`;
  try {
    const scan = await fetchHtml(ajaxUrl, rootHost, deadline, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', referer: seriesUrl },
      body: '',
    });
    out.push(...chapterCandidates(scan, rootHost), ...embeddedAnchors(scan, rootHost, 'chapter'));
    attempts.push({ strategy: 'madara-ajax-chapters', stage: 'chapters', input: ajaxUrl, ok: out.length > 0, count: out.length });
  } catch (error) {
    attempts.push({ strategy: 'madara-ajax-chapters', stage: 'chapters', input: ajaxUrl, ok: false, failureKind: failureKind(error), error: compactError(error) });
  }
  if (out.length || deadline - Date.now() < 1000) return uniqueAnchors(out);

  const mangaId = seriesScan.html.match(/(?:data-id|["'](?:post_id|manga_id)["'])\s*[=:]\s*["']?(\d+)/i)?.[1];
  if (!mangaId) return [];
  const adminUrl = new URL('/wp-admin/admin-ajax.php', root).toString();
  try {
    const scan = await fetchHtml(adminUrl, rootHost, deadline, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', referer: seriesUrl },
      body: `action=manga_get_chapters&manga=${encodeURIComponent(mangaId)}`,
    });
    out.push(...chapterCandidates(scan, rootHost), ...embeddedAnchors(scan, rootHost, 'chapter'));
    attempts.push({ strategy: 'madara-admin-ajax', stage: 'chapters', input: adminUrl, ok: out.length > 0, count: out.length });
  } catch (error) {
    attempts.push({ strategy: 'madara-admin-ajax', stage: 'chapters', input: adminUrl, ok: false, failureKind: failureKind(error), error: compactError(error) });
  }
  return uniqueAnchors(out);
}

function guessKind(text: string): string | undefined {
  const s = text.toLowerCase();
  if (/manhwa|korean/.test(s)) return 'manhwa';
  if (/manhua|chinese|wuxia|xianxia|cultivation/.test(s)) return 'manhua';
  if (/webtoon/.test(s)) return 'webtoon';
  if (/comic/.test(s)) return 'comic';
  if (/manga|japanese/.test(s)) return 'manga';
  return undefined;
}

function summaryFromAnchor(a: Anchor, index: number) {
  const title = (a.text || slugTitle(a.url)).replace(/\s+/g, ' ').trim();
  return {
    id: encodeToken(a.url),
    title,
    ...(guessKind(`${title} ${a.url}`) ? { category: guessKind(`${title} ${a.url}`) } : {}),
    updatedAt: Date.now() - index,
  };
}

function chapterNumber(a: Anchor, fallback: number): number {
  const raw = `${a.text} ${a.url}`;
  const n = Number(raw.match(/(?:chapter|chapitre|capitulo|capítulo|episode|ep|ch)[^0-9]*([0-9]+(?:\.[0-9]+)?)/i)?.[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function dynamicSeriesDetailAdaptive(root: URL, seriesUrl: string, deadline: number, attempts: Attempt[]): Promise<DetailResult> {
  const rootHost = hostname(root.toString());
  if (!sameSite(seriesUrl, rootHost)) throw new Error('Series URL is outside this source.');
  const scan = await fetchHtml(seriesUrl, rootHost, deadline);
  const htmlRows = chapterCandidates(scan, rootHost);
  const embeddedRows = embeddedAnchors(scan, rootHost, 'chapter');
  let chapters = uniqueAnchors([...htmlRows, ...embeddedRows]);
  let strategy = embeddedRows.length > htmlRows.length ? 'embedded-json-chapters' : 'html-chapters';
  attempts.push({ strategy, stage: 'chapters', input: seriesUrl, ok: chapters.length > 0, count: chapters.length });
  if (chapters.length < 1 && deadline - Date.now() > 900) {
    const madara = await madaraChapterFallback(root, seriesUrl, scan, deadline, attempts);
    if (madara.length) {
      chapters = madara;
      strategy = attempts.some((x) => x.strategy === 'madara-ajax-chapters' && x.ok) ? 'madara-ajax-chapters' : 'madara-admin-ajax';
    }
  }
  if (!chapters.length) throw codedError('NO_CHAPTERS', 'Source Fabric found the series but exhausted HTML, embedded JSON and Madara chapter discovery.');
  const cover = scan.cover ?? scan.images.find((i) => /cover|poster|thumbnail/i.test(`${i.url} ${i.alt}`))?.url ?? scan.images[0]?.url;
  return {
    strategy,
    detail: {
      id: encodeToken(scan.finalUrl),
      title: scan.title.replace(/\s*[|–—-]\s*[^|–—-]{1,50}$/, '').trim() || scan.title,
      synopsis: scan.description,
      ...(cover ? { cover } : {}),
      ...(guessKind(`${scan.title} ${scan.finalUrl}`) ? { category: guessKind(`${scan.title} ${scan.finalUrl}`) } : {}),
      chapters: chapters.map((c, i) => ({
        id: encodeToken(c.url),
        number: chapterNumber(c, Math.max(1, chapters.length - i)),
        name: c.text || `Chapter ${Math.max(1, chapters.length - i)}`,
      })),
    },
  };
}

async function dynamicPagesAdaptive(root: URL, chapterUrl: string, deadline: number, attempts: Attempt[]): Promise<PagesResult> {
  const rootHost = hostname(root.toString());
  if (!sameSite(chapterUrl, rootHost)) throw new Error('Chapter URL is outside this source.');
  const scan = await fetchHtml(chapterUrl, rootHost, deadline);
  const strategies: Array<[string, string[]]> = [
    ['ts-reader-pages', extractTsReaderImages(scan.html, scan.finalUrl)],
    ['embedded-json-pages', extractEmbeddedImages(scan)],
    ['html-image-pages', pageImages(scan).map((x) => x.url)],
  ];
  for (const [strategy, raw] of strategies) {
    const seen = new Set<string>();
    const urls = raw.filter((x) => x && !seen.has(x) && seen.add(x));
    attempts.push({ strategy, stage: 'pages', input: chapterUrl, ok: urls.length >= 2, count: urls.length });
    if (urls.length >= 2) {
      return {
        strategy,
        pages: urls.map((url, index) => ({ key: `${encodeToken(chapterUrl).slice(0, 12)}-${index}`, index, url })),
      };
    }
  }
  throw codedError('NO_PAGES', 'Reader pages were not discoverable after TSReader, embedded JSON and HTML image strategies. This source may require a normal interactive browser.');
}

function looksSeriesUrl(url: URL): boolean {
  return SERIES_RE.test(url.pathname) && !CHAPTER_RE.test(url.pathname);
}

function evidenceSeedUrls(input: URL, evidence: any[]): URL[] {
  const rows: URL[] = [input];
  for (const item of evidence) {
    const raw = item?.baseUrl ?? item?.baseURL ?? item?.url ?? item?.website;
    if (typeof raw !== 'string') continue;
    try {
      const u = publicUrl(raw);
      const a = hostname(input.toString());
      const b = hostname(u.toString());
      if (!(a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`))) continue;
      if (!rows.some((x) => x.origin === u.origin)) rows.push(u);
    } catch {}
  }
  return rows.slice(0, 5);
}

async function probeSeed(seed: URL, pasted: URL, deadline: number, attempts: Attempt[]) {
  const seedSeries = looksSeriesUrl(pasted) && sameSite(pasted.toString(), hostname(seed.toString())) ? pasted.toString() : undefined;
  const catalog = await discoverCatalogAdaptive(seed, seedSeries, deadline, attempts);
  const seriesUrl = seedSeries ?? catalog.series[0]?.url;
  if (!seriesUrl) throw codedError('NO_CATALOG', 'No series URL survived adaptive catalog discovery.');
  const detailResult = await dynamicSeriesDetailAdaptive(seed, seriesUrl, deadline, attempts);
  const chapters = Array.isArray(detailResult.detail.chapters) ? detailResult.detail.chapters : [];
  let pageResult: PagesResult | null = null;
  let lastError: any = null;
  for (const chapter of chapters.slice(0, 3)) {
    if (deadline - Date.now() < 700) break;
    try {
      pageResult = await dynamicPagesAdaptive(seed, decodeToken(String(chapter.id)), deadline, attempts);
      if (pageResult.pages.length >= 2) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!pageResult && lastError) throw lastError;

  const catalogCount = catalog.series.length;
  const chapterCount = chapters.length;
  const pages = pageResult?.pages.length ?? 0;
  let score = 0;
  if (catalogCount >= 3) score += 35;
  else if (catalogCount) score += 18;
  if (seriesUrl) score += 15;
  if (chapterCount >= 2) score += 25;
  else if (chapterCount) score += 12;
  if (pages >= 2) score += 25;
  const ready = catalogCount >= 1 && chapterCount >= 1 && pages >= 2;
  const strategy = [catalog.strategy, detailResult.strategy, pageResult?.strategy].filter(Boolean).join(' + ');
  return {
    ready,
    score,
    strategy,
    rootUrl: seed.origin + '/',
    seedSeries,
    catalogUrl: catalog.scan.finalUrl,
    catalogCount,
    chapterCount,
    pages,
    sampleTitle: detailResult.detail.title ?? catalog.series[0]?.text ?? catalog.scan.title,
  };
}

async function probeAdaptive(input: URL, evidence: any[]) {
  const deadline = Date.now() + PROBE_BUDGET_MS;
  const attempts: Attempt[] = [];
  let best: any = null;
  let lastError: any = null;
  for (const seed of evidenceSeedUrls(input, evidence)) {
    if (deadline - Date.now() < 700) break;
    attempts.push({ strategy: 'seed', stage: 'seed', input: seed.toString(), ok: true });
    try {
      const result = await probeSeed(seed, input, deadline, attempts);
      if (!best || result.score > best.score) best = result;
      if (result.ready) return { ...result, attempts };
    } catch (error) {
      lastError = error;
      attempts.push({ strategy: 'seed-exhausted', stage: 'seed', input: seed.toString(), ok: false, failureKind: failureKind(error), error: compactError(error) });
    }
  }
  if (best) return { ...best, attempts };
  const error = lastError ?? codedError('NO_CATALOG', 'No adaptive Source Fabric strategy succeeded.');
  (error as any).attempts = attempts;
  throw error;
}

async function ecosystemEvidence(input: URL) {
  const host = hostname(input.toString());
  const same = (raw: unknown) => {
    try {
      const h = hostname(String(raw));
      return !!h && (h === host || h.endsWith(`.${host}`) || host.endsWith(`.${h}`));
    } catch { return false; }
  };
  const out: any[] = [];
  const tasks = [
    (async () => {
      const r = await fetch('https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json', { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) return;
      const index: any = await r.json();
      for (const ext of Array.isArray(index) ? index : []) {
        const rows = Array.isArray(ext.sources) ? ext.sources : [ext];
        for (const src of rows) {
          const base = src.baseUrl ?? src.base_url ?? ext.baseUrl;
          if (base && same(base)) out.push({ ecosystem: 'mihon', name: src.name ?? ext.name ?? host, package: ext.pkg ?? ext.packageName, baseUrl: base });
        }
      }
    })(),
    (async () => {
      const r = await fetch('https://aidoku-community.github.io/sources/index.min.json', { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) return;
      const index: any = await r.json();
      const rows = Array.isArray(index) ? index : (index.sources ?? []);
      for (const src of rows) {
        const base = src.baseURL ?? src.baseUrl ?? src.url ?? src.website;
        if (base && same(base)) out.push({ ecosystem: 'aidoku', name: src.name ?? src.id ?? host, id: src.id, baseUrl: base });
      }
    })(),
    (async () => {
      const r = await fetch('https://raw.githubusercontent.com/YofaGh/MangaScraper/master/modules.yaml', { headers: { accept: 'text/plain', 'user-agent': UA }, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) return;
      const text = (await r.text()).slice(0, 1_000_000);
      const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`^${escaped}:\\s*$`, 'mi').test(text)) out.push({ ecosystem: 'mangascraper', name: host, baseUrl: `https://${host}/` });
    })(),
  ];
  await Promise.allSettled(tasks);
  const seen = new Set<string>();
  return out.filter((row) => {
    const key = `${row.ecosystem}|${row.baseUrl}|${row.id ?? row.package ?? row.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 16);
}

function dynamicAdapter(input: URL, probe: any, origin: string) {
  const root = String(probe.rootUrl || `${input.protocol}//${input.host}/`);
  const token = encodeDynamicConfig({ root, seedSeries: probe.seedSeries, strategy: probe.strategy });
  const inputHost = hostname(input.toString());
  const rootHost = hostname(root);
  const slug = inputHost.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'source';
  return {
    id: `fabric-${slug}`,
    name: inputHost,
    version: 2,
    language: 'en',
    content: ['manga', 'manhwa', 'manhua', 'webtoon', 'comic'],
    capabilities: { search: probe.catalogCount >= 3, popular: true, latest: true, details: true, chapters: true, pages: true },
    nsfw: false,
    hosts: [...new Set([inputHost, rootHost, `*.${inputHost}`, `*.${rootHost}`])],
    api: `${origin}/api/fabric/dynamic/${token}/`,
    runtime: 'fabric-adaptive',
    engine: 'Adaptive Source Fabric',
    score: probe.score,
    strategy: probe.strategy,
  };
}

function fixedSource(input: URL, origin: string) {
  return legacyFabricSourceCards(origin).find((s: any) => (s.hosts ?? []).some((h: string) => {
    const wildcard = h.startsWith('*.');
    const d = h.replace(/^\*\./, '');
    const host = hostname(input.toString());
    return host === d || (wildcard && host.endsWith(`.${d}`));
  }));
}

async function resolveSource(request: Request, url: URL): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Use POST with {url}.' }, 405);
  const body: AnyObject = await request.json().catch(() => ({}));
  let input: URL;
  try { input = publicUrl(String(body.url ?? '')); } catch (error: any) { return json({ error: error.message }, 400); }

  const evidencePromise = ecosystemEvidence(input);
  const fixed = fixedSource(input, url.origin);
  if (fixed) {
    const evidence = await evidencePromise;
    return json({ ok: true, ready: true, route: 'native', confidence: 'very-high', score: 100, adapter: fixed, evidence, fabric: { version: VERSION, adaptive: true }, message: `${fixed.name} has a native Yomu Source Fabric runtime.` });
  }

  const evidence = await evidencePromise;
  try {
    const probe = await probeAdaptive(input, evidence);
    if (probe.ready) {
      const adapter = dynamicAdapter(input, probe, url.origin);
      return json({
        ok: true,
        ready: true,
        route: probe.seedSeries && probe.catalogCount === 1 ? 'remote-seed-adaptive' : 'remote-adaptive',
        confidence: probe.score >= 85 ? 'high' : 'usable',
        score: probe.score,
        adapter,
        evidence,
        probe,
        fabric: { version: VERSION, adaptive: true, strategyAttempts: probe.attempts.length },
        message: `Adaptive Source Fabric verified catalog → chapters → reader pages using ${probe.strategy}.`,
      });
    }
    return json({
      ok: true,
      ready: false,
      route: evidence.length ? 'reference-assisted' : 'adaptive-exhausted',
      confidence: evidence.length ? 'medium' : 'low',
      score: probe.score,
      evidence,
      probe,
      failureKind: 'adaptive-exhausted',
      fabric: { version: VERSION, adaptive: true, strategyAttempts: probe.attempts.length },
      message: evidence.length
        ? 'Yomu found maintained source intelligence, but the safe remote strategies could not yet prove a complete reader path.'
        : 'Adaptive Source Fabric tried its available remote strategies but could not prove a complete reader path.',
    });
  } catch (error: any) {
    const attempts = Array.isArray(error?.attempts) ? error.attempts : [];
    return json({
      ok: true,
      ready: false,
      route: evidence.length ? 'reference-assisted' : 'adaptive-exhausted',
      confidence: evidence.length ? 'medium' : 'low',
      score: 0,
      evidence,
      error: compactError(error),
      failureKind: failureKind(error),
      probe: { ready: false, strategy: 'exhausted', attempts },
      fabric: { version: VERSION, adaptive: true, strategyAttempts: attempts.length },
      message: evidence.length
        ? 'A maintained implementation was found, but the safe Worker strategies were exhausted. A specialist or interactive browser runtime may be required.'
        : 'Adaptive Source Fabric exhausted its safe strategies. A specialist or interactive browser runtime may be required.',
    });
  }
}

async function handleDynamic(request: Request, url: URL, token: string, rest: string): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Dynamic sources currently expose read-only GET endpoints.' }, 405);
  let config: DynamicConfig;
  let root: URL;
  try {
    config = decodeDynamicConfig(token);
    root = publicUrl(config.root);
  } catch {
    return json({ error: 'Invalid Source Fabric token.' }, 400);
  }
  const deadline = Date.now() + PROBE_BUDGET_MS;
  const attempts: Attempt[] = [];
  const rootHost = hostname(root.toString());
  try {
    if (rest === 'series' || rest === 'latest') {
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
      const catalog = await discoverCatalogAdaptive(root, config.seedSeries, deadline, attempts);
      const start = (page - 1) * 35;
      const rows = catalog.series.slice(start, start + 35).map(summaryFromAnchor);
      return json({ series: rows, hasNextPage: catalog.series.length > start + 35, fabricStrategy: catalog.strategy }, 200, 'private, max-age=120');
    }
    if (rest === 'search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q) return json({ series: [] });
      const candidates = [
        new URL(`/?s=${encodeURIComponent(q)}`, root),
        new URL(`/search?q=${encodeURIComponent(q)}`, root),
        new URL(`/search/?q=${encodeURIComponent(q)}`, root),
      ];
      let best: Anchor[] = [];
      for (const candidate of candidates) {
        if (deadline - Date.now() < 700) break;
        try {
          const scan = await fetchHtml(candidate.toString(), rootHost, deadline);
          const rows = uniqueAnchors([...seriesCandidates(scan, rootHost), ...embeddedAnchors(scan, rootHost, 'series')]);
          if (rows.length > best.length) best = rows;
          if (best.length >= 6) break;
        } catch {}
      }
      if (!best.length) {
        const catalog = await discoverCatalogAdaptive(root, config.seedSeries, deadline, attempts);
        const needle = q.toLowerCase();
        best = catalog.series.filter((a) => `${a.text} ${a.url}`.toLowerCase().includes(needle));
      }
      return json({ series: best.slice(0, 50).map(summaryFromAnchor), hasNextPage: false });
    }
    const series = rest.match(/^series\/([^/]+)$/);
    if (series) {
      const seriesUrl = decodeToken(decodeURIComponent(series[1]));
      const result = await dynamicSeriesDetailAdaptive(root, seriesUrl, deadline, attempts);
      return json({ ...result.detail, fabricStrategy: result.strategy }, 200, 'private, max-age=120');
    }

    const manifest = rest.match(/^chapters\/([^/]+)\/manifest$/);
    if (manifest) {
      const chapterId = decodeURIComponent(manifest[1]);
      const chapterUrl = decodeToken(chapterId);
      const result = await dynamicPagesAdaptive(root, chapterUrl, deadline, attempts);
      return json({
        schema: 'yomu.chapter-manifest/1',
        chapterId,
        sourceSeriesId: '',
        manifestVersion: `fabric-v6-${chapterId.slice(0, 12)}-${result.pages.length}`,
        pageListVersion: result.pages.length,
        expiresAt: Date.now() + 10 * 60 * 1000,
        pages: result.pages,
        delivery: 'direct',
        fabricStrategy: result.strategy,
      });
    }
    return json({ error: 'Unknown dynamic Source Fabric endpoint.' }, 404);
  } catch (error: any) {
    return json({
      error: compactError(error),
      failureKind: failureKind(error),
      strategyAttempts: attempts,
    }, error?.status === 404 ? 404 : 502);
  }
}

export async function handleFabric(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/api/fabric/status') {
    return json({
      ok: true,
      version: VERSION,
      desktopRequired: false,
      adaptive: true,
      engines: ['fabric-native', 'fabric-adaptive'],
      strategies: [
        'exact-series-seed',
        'html-catalog',
        'embedded-json-catalog',
        'sitemap-catalog',
        'wordpress-rest-catalog',
        'html-chapters',
        'embedded-json-chapters',
        'madara-ajax-chapters',
        'madara-admin-ajax',
        'ts-reader-pages',
        'embedded-json-pages',
        'html-image-pages',
        'registry-base-url-seeds',
      ],
      nativeSources: legacyFabricSourceCards(url.origin).map((s: any) => s.name),
    });
  }
  if (url.pathname === '/api/fabric/resolve') return resolveSource(request, url);

  const dynamic = url.pathname.match(/^\/api\/fabric\/dynamic\/([^/]+)\/(.*)$/);
  if (dynamic) return handleDynamic(request, url, dynamic[1], dynamic[2]);

  // Keep native/specialist v5 routes as the compatibility floor. index-v5 also
  // routes Kagane through its newer v5.3 provider before this module sees it.
  return handleFabricV5(request, env, url);
}
