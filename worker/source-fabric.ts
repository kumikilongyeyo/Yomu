import type { Env } from './index';

/**
 * Yomu Source Fabric v5
 *
 * The important boundary is that a reader device never needs localhost.
 * A pasted URL is resolved on the Worker. Known native sources use a purpose-
 * built adapter; ordinary HTML manga sites use the guarded generic runtime.
 * Desktop Source Forge remains a last-resort development tool, not a runtime
 * dependency of an installed source.
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
  anchors: Anchor[];
  images: ImageHit[];
};

const KAGANE_BASE = 'https://kagane.to';
const KAGANE_API = `${KAGANE_BASE}/api/v2`;
const UA = 'Mozilla/5.0 (compatible; Yomu-Source-Fabric/5.0; +https://yomu.yomuread.workers.dev)';
const MAX_HTML = 3_000_000;

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

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return m?.[2]?.trim() ?? '';
}

function absolute(input: string, base: string): string | null {
  try {
    const u = new URL(input, base);
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

function sameSite(candidate: string, rootHost: string): boolean {
  const h = hostname(candidate);
  return !!h && (h === rootHost || h.endsWith(`.${rootHost}`));
}

async function fetchHtml(input: string, rootHost?: string): Promise<Scan> {
  const target = publicUrl(input);
  if (rootHost && !sameSite(target.toString(), rootHost)) throw new Error('Source Fabric refused to leave the source website.');
  const response = await fetch(target.toString(), {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      'accept-language': 'en-US,en;q=0.8',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw Object.assign(new Error(`Website returned HTTP ${response.status}.`), { status: response.status });
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html') && !type.includes('application/xhtml')) throw new Error('Website did not return an HTML page.');
  const html = (await response.text()).slice(0, MAX_HTML);
  const finalUrl = response.url || target.toString();

  const title = cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || hostname(finalUrl);
  const description = attr(html.match(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*>/i)?.[0] ?? '', 'content');

  const anchors: Anchor[] = [];
  const seenA = new Set<string>();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = `<a ${m[1]}>`;
    const raw = attr(tag, 'href');
    if (!raw || raw.startsWith('#') || /^(javascript:|mailto:|tel:)/i.test(raw)) continue;
    const resolved = absolute(raw, finalUrl);
    if (!resolved || seenA.has(resolved)) continue;
    seenA.add(resolved);
    const text = cleanText(m[2] ?? '') || attr(tag, 'title') || attr(tag, 'aria-label');
    anchors.push({ url: resolved, text: text.slice(0, 180) });
    if (anchors.length >= 1400) break;
  }

  const images: ImageHit[] = [];
  const seenI = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    let raw = attr(tag, 'src') || attr(tag, 'data-src') || attr(tag, 'data-lazy-src') || attr(tag, 'data-original') || attr(tag, 'data-cfsrc');
    const srcset = attr(tag, 'srcset') || attr(tag, 'data-srcset');
    if ((!raw || raw.startsWith('data:')) && srcset) raw = srcset.split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop() ?? '';
    if (!raw || raw.startsWith('data:')) continue;
    const resolved = absolute(raw, finalUrl);
    if (!resolved || seenI.has(resolved)) continue;
    seenI.add(resolved);
    images.push({
      url: resolved,
      alt: (attr(tag, 'alt') || attr(tag, 'title')).slice(0, 180),
      width: Number.parseInt(attr(tag, 'width') || '0', 10) || 0,
      height: Number.parseInt(attr(tag, 'height') || '0', 10) || 0,
    });
    if (images.length >= 800) break;
  }
  return { requestedUrl: target.toString(), finalUrl, status: response.status, title, description: cleanText(description), anchors, images };
}

const SERIES_RE = /\/(manga|manhwa|manhua|series|webtoon|comic|comics|title|titles|book|books|novel|novels)\//i;
const CHAPTER_RE = /\/(chapter|chapters?|ch[-_/]?\d|reader|read)\b|\bchapter[-_/]?\d/i;
const JUNK_RE = /\/(tag|tags|genre|genres|author|artist|login|register|privacy|terms|contact|about|search|wp-admin|feed)(\/|$)/i;

function seriesCandidates(scan: Scan, rootHost: string): Anchor[] {
  const out = new Map<string, Anchor>();
  for (const a of scan.anchors) {
    if (!sameSite(a.url, rootHost) || JUNK_RE.test(new URL(a.url).pathname) || CHAPTER_RE.test(a.url)) continue;
    if (!SERIES_RE.test(a.url)) continue;
    const p = new URL(a.url).pathname.replace(/\/$/, '');
    if (p.split('/').filter(Boolean).length < 2) continue;
    if (!out.has(a.url)) out.set(a.url, a);
  }
  return [...out.values()];
}

function chapterCandidates(scan: Scan, rootHost: string): Anchor[] {
  const out = new Map<string, Anchor>();
  for (const a of scan.anchors) {
    if (!sameSite(a.url, rootHost)) continue;
    const path = new URL(a.url).pathname;
    if (!CHAPTER_RE.test(`${path} ${a.text}`)) continue;
    if (!out.has(a.url)) out.set(a.url, a);
  }
  return [...out.values()];
}

function pageImages(scan: Scan): ImageHit[] {
  const bad = /logo|avatar|icon|banner|advert|ads?\b|emoji|sprite|spacer|tracking|pixel|badge|button/i;
  const strong = /chapter|reader|page|pages|uploads?|manga|manhwa|webtoon|comic|wp-content|cdn|image/i;
  return scan.images.filter((img) => {
    const hay = `${img.url} ${img.alt}`;
    if (bad.test(hay)) return false;
    if (img.width && img.height && img.width < 180 && img.height < 180) return false;
    return strong.test(hay) || img.width >= 500 || img.height >= 700;
  });
}

function candidateCatalogUrls(input: URL): string[] {
  const origin = input.origin;
  const rows = [
    origin + '/', origin + '/manga/', origin + '/manga', origin + '/series/', origin + '/series',
    origin + '/webtoon/', origin + '/comics/', origin + '/browse/', origin + '/latest/', origin + '/updates/',
  ];
  const seg = input.pathname.split('/').filter(Boolean);
  if (seg.length >= 2) rows.unshift(`${origin}/${seg[0]}/`);
  return [...new Set(rows)];
}

async function discoverCatalog(input: URL): Promise<{ scan: Scan; series: Anchor[] }> {
  const rootHost = input.hostname.replace(/^www\./, '').toLowerCase();
  let best: { scan: Scan; series: Anchor[] } | null = null;
  for (const candidate of candidateCatalogUrls(input).slice(0, 7)) {
    try {
      const scan = await fetchHtml(candidate, rootHost);
      const series = seriesCandidates(scan, rootHost);
      if (!best || series.length > best.series.length) best = { scan, series };
      if (series.length >= 18) break;
    } catch {}
  }
  if (!best) throw new Error('Source Fabric could not find a readable catalog on this website.');
  return best;
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
  const u = new URL(a.url);
  const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '').replace(/[-_]+/g, ' ');
  const title = (a.text || last || u.hostname).replace(/\s+/g, ' ').trim();
  return {
    id: encodeToken(a.url),
    title,
    ...(guessKind(`${title} ${a.url}`) ? { category: guessKind(`${title} ${a.url}`) } : {}),
    updatedAt: Date.now() - index,
  };
}

async function dynamicSeriesDetail(root: URL, seriesUrl: string) {
  const rootHost = root.hostname.replace(/^www\./, '').toLowerCase();
  if (!sameSite(seriesUrl, rootHost)) throw new Error('Series URL is outside this source.');
  const scan = await fetchHtml(seriesUrl, rootHost);
  const chapters = chapterCandidates(scan, rootHost);
  const ogImageTag = scan.images.find((i) => /cover|poster|thumbnail/i.test(`${i.url} ${i.alt}`)) ?? scan.images[0];
  return {
    id: encodeToken(scan.finalUrl),
    title: scan.title.replace(/\s*[|–—-]\s*[^|–—-]{1,50}$/, '').trim() || scan.title,
    synopsis: scan.description,
    ...(ogImageTag ? { cover: ogImageTag.url } : {}),
    ...(guessKind(`${scan.title} ${scan.finalUrl}`) ? { category: guessKind(`${scan.title} ${scan.finalUrl}`) } : {}),
    chapters: chapters.map((c, i) => ({
      id: encodeToken(c.url),
      number: Number((c.text.match(/(?:chapter|ch\.?)[^0-9]*([0-9]+(?:\.[0-9]+)?)/i)?.[1])) || Math.max(0, chapters.length - i),
      name: c.text || `Chapter ${Math.max(1, chapters.length - i)}`,
    })),
  };
}

async function dynamicPages(root: URL, chapterUrl: string) {
  const rootHost = root.hostname.replace(/^www\./, '').toLowerCase();
  if (!sameSite(chapterUrl, rootHost)) throw new Error('Chapter URL is outside this source.');
  const scan = await fetchHtml(chapterUrl, rootHost);
  const images = pageImages(scan);
  if (images.length < 2) throw new Error('Reader pages were not discoverable from the remote HTML runtime. This source may need the optional browser engine.');
  return images.map((img, index) => ({ key: `${encodeToken(chapterUrl).slice(0, 12)}-${index}`, index, url: img.url }));
}

async function probeGeneric(input: URL) {
  const rootHost = input.hostname.replace(/^www\./, '').toLowerCase();
  const catalog = await discoverCatalog(input);
  let seriesUrl = SERIES_RE.test(input.pathname) && !CHAPTER_RE.test(input.pathname) ? input.toString() : catalog.series[0]?.url;
  let chapterCount = 0;
  let pages = 0;
  let sampleTitle = catalog.series[0]?.text || catalog.scan.title;
  if (seriesUrl) {
    try {
      const detail = await dynamicSeriesDetail(input, seriesUrl);
      chapterCount = detail.chapters.length;
      sampleTitle = detail.title || sampleTitle;
      const first = detail.chapters[0];
      if (first) pages = (await dynamicPages(input, decodeToken(first.id))).length;
    } catch {}
  }
  const catalogCount = catalog.series.length;
  let score = 0;
  if (catalogCount >= 3) score += 35;
  else if (catalogCount) score += 15;
  if (seriesUrl) score += 15;
  if (chapterCount >= 2) score += 25;
  else if (chapterCount) score += 10;
  if (pages >= 2) score += 25;
  const ready = catalogCount >= 3 && chapterCount >= 1 && pages >= 2;
  return { ready, score, catalogUrl: catalog.scan.finalUrl, catalogCount, chapterCount, pages, sampleTitle };
}

/* ------------------------------------------------------------------ *
 * Kagane native provider
 * ------------------------------------------------------------------ */

async function kaganeJson(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${KAGANE_API}${path}`, {
    ...init,
    headers: {
      'user-agent': UA,
      accept: 'application/json',
      'content-type': 'application/json',
      'accept-language': 'en-US,en;q=0.8',
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Kagane API returned HTTP ${response.status}.`);
  return response.json();
}

const kaganeBody = (query = '') => ({
  ...(query ? { title: query } : {}),
  source_type: ['Official', 'Unofficial', 'Mixed'],
  content_lang: ['en'],
});

function kaganeSummary(book: AnyObject) {
  return {
    id: String(book.series_id ?? book.id),
    title: String(book.title ?? 'Untitled').trim(),
    ...(book.cover_image_id ? { cover: `${KAGANE_API}/image/${book.cover_image_id}` } : {}),
    ...(book.start_year ? { year: Number(book.start_year) } : {}),
  };
}

async function kaganeList(kind: 'popular' | 'latest' | 'search', q = '', page = 1) {
  const sort = kind === 'latest' ? 'updated_at,desc' : kind === 'popular' ? 'total_views,desc' : '';
  const params = new URLSearchParams({ page: String(Math.max(0, page - 1)), size: '35' });
  if (sort) params.set('sort', sort);
  const dto = await kaganeJson(`/search/series?${params}`, { method: 'POST', body: JSON.stringify(kaganeBody(q)) });
  return { series: (dto.content ?? []).map(kaganeSummary), hasNextPage: dto.last === false };
}

function chapterNumber(ch: AnyObject, fallback: number): number {
  const raw = ch.chapter_no ?? ch.sort_no;
  const n = Number.parseFloat(String(raw ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

async function kaganeDetail(id: string) {
  const dto = await kaganeJson(`/series/${encodeURIComponent(id)}`);
  const genres = [dto.format, ...(dto.genres ?? []).map((g: AnyObject) => g.genre_name)].filter(Boolean);
  const authors = (dto.series_staff ?? []).filter((s: AnyObject) => /author|story/i.test(String(s.role ?? ''))).map((s: AnyObject) => s.name).filter(Boolean);
  const chapters = (dto.series_books ?? []).map((ch: AnyObject, i: number) => ({
    id: String(ch.book_id ?? ch.id),
    number: chapterNumber(ch, (dto.series_books?.length ?? 0) - i),
    name: String(ch.title ?? '').trim() || (ch.chapter_no ? `Ch.${ch.chapter_no}` : `Chapter ${(dto.series_books?.length ?? 0) - i}`),
    pageCount: Number(ch.page_count ?? 0) || undefined,
    ...(ch.created_at ? { publishedAt: Date.parse(ch.created_at) || undefined } : {}),
    ...((ch.groups ?? []).length ? { scanlator: ch.groups.map((g: AnyObject) => g.title).filter(Boolean).join(', ') } : {}),
  })).reverse();
  const coverId = dto.series_covers?.[0]?.image_id;
  return {
    id,
    title: String(dto.title ?? 'Untitled').trim(),
    author: authors.join(', ') || undefined,
    synopsis: cleanText(String(dto.description ?? '')),
    genres,
    ...(guessKind(`${dto.format ?? ''} ${genres.join(' ')}`) ? { category: guessKind(`${dto.format ?? ''} ${genres.join(' ')}`) } : {}),
    status: String(dto.upload_status ?? '').toLowerCase() || undefined,
    ...(coverId ? { cover: `${KAGANE_API}/image/${coverId}` } : {}),
    chapters,
  };
}

let integrityCache: { token: string; exp: number; cookie: string } | null = null;

function responseCookie(response: Response): string {
  const headers: any = response.headers as any;
  const rows: string[] = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  if (!rows.length) {
    const one = response.headers.get('set-cookie');
    if (one) rows.push(one);
  }
  return rows.map((row) => row.split(';')[0]).filter(Boolean).join('; ');
}

async function kaganeIntegrity(force = false) {
  if (!force && integrityCache && integrityCache.exp > Date.now() + 10_000) return integrityCache;
  const home = await fetch(`${KAGANE_BASE}/`, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(12_000) });
  if (!home.ok) throw new Error(`Kagane access check returned HTTP ${home.status}.`);
  const cookie = responseCookie(home);
  const response = await fetch(`${KAGANE_BASE}/api/integrity`, {
    method: 'POST',
    headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: '',
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Kagane integrity endpoint returned HTTP ${response.status}.`);
  const dto: AnyObject = await response.json();
  integrityCache = { token: String(dto.token ?? ''), exp: Number(dto.exp ?? 0) * 1000 || Date.now() + 60_000, cookie };
  if (!integrityCache.token) throw new Error('Kagane did not issue an integrity token.');
  return integrityCache;
}

async function kaganeChallenge(chapterId: string, force = false): Promise<AnyObject> {
  const integrity = await kaganeIntegrity(force);
  const response = await fetch(`${KAGANE_API}/books/${encodeURIComponent(chapterId)}?is_datasaver=false`, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      accept: 'application/json',
      'content-type': 'application/json',
      'x-integrity-token': integrity.token,
      ...(integrity.cookie ? { cookie: integrity.cookie } : {}),
    },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  if ((response.status === 401 || response.status === 403 || response.status === 507) && !force) return kaganeChallenge(chapterId, true);
  if (!response.ok) throw new Error(`Kagane reader returned HTTP ${response.status}.`);
  return response.json();
}

async function kaganePages(chapterId: string) {
  const dto = await kaganeChallenge(chapterId);
  const token = String(dto.access_token ?? '');
  const cacheUrl = String(dto.cache_url ?? '').replace(/\/$/, '');
  if (!token || !cacheUrl) throw new Error('Kagane reader did not return a usable page token.');
  return (dto.manifest?.pages ?? []).map((p: AnyObject, index: number) => {
    const pageId = String(p.page_id ?? '');
    const ext = String(p.ext ?? 'jxl');
    return {
      key: `${chapterId}-${index}`,
      index,
      url: `${cacheUrl}/api/v2/books/page/${encodeURIComponent(chapterId)}/${encodeURIComponent(pageId)}.${encodeURIComponent(ext)}?token=${encodeURIComponent(token)}`,
    };
  });
}

export function fabricSourceCards(origin: string) {
  return [
    {
      id: 'fabric-kagane',
      name: 'Kagane',
      version: 1,
      language: 'en',
      content: ['manga', 'manhwa', 'manhua', 'webtoon', 'comic'],
      capabilities: { search: true, popular: true, latest: true, details: true, chapters: true, pages: true },
      nsfw: false,
      hosts: ['kagane.to', '*.kagane.to'],
      api: `${origin}/api/fabric/source/kagane/`,
      runtime: 'fabric-native',
      engine: 'Yomu Source Fabric',
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Public Source Fabric routes
 * ------------------------------------------------------------------ */

async function ecosystemEvidence(input: URL) {
  const host = input.hostname.replace(/^www\./, '').toLowerCase();
  const same = (raw: unknown) => {
    try {
      const h = new URL(String(raw)).hostname.toLowerCase().replace(/^www\./, '');
      return h === host || h.endsWith(`.${host}`) || host.endsWith(`.${h}`);
    } catch { return false; }
  };
  const out: any[] = [];
  try {
    const r = await fetch('https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json', { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(8_000) });
    if (r.ok) {
      const index: any = await r.json();
      for (const ext of Array.isArray(index) ? index : []) {
        const rows = Array.isArray(ext.sources) ? ext.sources : [ext];
        for (const src of rows) {
          const base = src.baseUrl ?? src.base_url ?? ext.baseUrl;
          if (base && same(base)) out.push({ ecosystem: 'mihon', name: src.name ?? ext.name ?? host, package: ext.pkg ?? ext.packageName, baseUrl: base });
        }
      }
    }
  } catch {}
  try {
    const r = await fetch('https://aidoku-community.github.io/sources/index.min.json', { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(8_000) });
    if (r.ok) {
      const index: any = await r.json();
      const rows = Array.isArray(index) ? index : (index.sources ?? []);
      for (const src of rows) {
        const base = src.baseURL ?? src.baseUrl ?? src.url ?? src.website;
        if (base && same(base)) out.push({ ecosystem: 'aidoku', name: src.name ?? src.id ?? host, id: src.id, baseUrl: base });
      }
    }
  } catch {}
  return out.slice(0, 12);
}

function dynamicAdapter(url: URL, probe: any, origin: string) {
  const root = `${url.protocol}//${url.host}/`;
  const token = encodeToken(root);
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const slug = host.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'source';
  return {
    id: `fabric-${slug}`,
    name: probe.sampleTitle && probe.sampleTitle !== host ? `${host}` : host,
    version: 1,
    language: 'en',
    content: ['manga', 'manhwa', 'manhua', 'webtoon', 'comic'],
    capabilities: { search: true, popular: true, latest: true, details: true, chapters: true, pages: true },
    nsfw: false,
    hosts: [host, `*.${host}`],
    api: `${origin}/api/fabric/dynamic/${token}/`,
    runtime: 'fabric-generic',
    engine: 'Remote Source Fabric',
    score: probe.score,
  };
}

async function resolveSource(env: Env, request: Request, url: URL): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Use POST with {url}.' }, 405);
  const body: AnyObject = await request.json().catch(() => ({}));
  let input: URL;
  try { input = publicUrl(String(body.url ?? '')); } catch (error: any) { return json({ error: error.message }, 400); }

  const fixed = fabricSourceCards(url.origin).find((s) => s.hosts.some((h) => {
    const wildcard = h.startsWith('*.');
    const d = h.replace(/^\*\./, '');
    const host = input.hostname.replace(/^www\./, '').toLowerCase();
    return host === d || (wildcard && host.endsWith(`.${d}`));
  }));
  const evidencePromise = ecosystemEvidence(input);
  if (fixed) {
    const evidence = await evidencePromise;
    return json({ ok: true, ready: true, route: 'native', confidence: 'very-high', score: 100, adapter: fixed, evidence, message: `${fixed.name} has a native Yomu Source Fabric runtime.` });
  }

  try {
    const probe = await probeGeneric(input);
    const evidence = await evidencePromise;
    if (probe.ready) {
      const adapter = dynamicAdapter(input, probe, url.origin);
      return json({ ok: true, ready: true, route: 'remote-generic', confidence: probe.score >= 85 ? 'high' : 'usable', score: probe.score, adapter, evidence, probe, message: 'Remote Source Fabric verified catalog → chapters → reader pages. No desktop engine is required.' });
    }
    return json({ ok: true, ready: false, route: evidence.length ? 'reference-assisted' : 'needs-specialist', confidence: evidence.length ? 'medium' : 'low', score: probe.score, evidence, probe, message: evidence.length ? 'A maintained implementation exists, but Yomu does not yet have an executable remote runtime for it.' : 'The remote generic runtime could not prove a complete reader path for this site.' });
  } catch (error: any) {
    const evidence = await evidencePromise;
    return json({ ok: true, ready: false, route: evidence.length ? 'reference-assisted' : 'blocked', confidence: evidence.length ? 'medium' : 'low', score: 0, evidence, error: error.message, message: evidence.length ? 'A maintained implementation was found, but the remote runtime could not safely verify the site yet.' : error.message });
  }
}

async function handleDynamic(request: Request, url: URL, token: string, rest: string): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Dynamic sources currently expose read-only GET endpoints.' }, 405);
  let root: URL;
  try { root = publicUrl(decodeToken(token)); } catch { return json({ error: 'Invalid Source Fabric token.' }, 400); }
  const rootHost = root.hostname.replace(/^www\./, '').toLowerCase();
  try {
    if (rest === 'series' || rest === 'latest') {
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
      const catalog = await discoverCatalog(root);
      const start = (page - 1) * 35;
      const rows = catalog.series.slice(start, start + 35).map(summaryFromAnchor);
      return json({ series: rows, hasNextPage: catalog.series.length > start + 35 }, 200, 'private, max-age=120');
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
        try {
          const scan = await fetchHtml(candidate.toString(), rootHost);
          const rows = seriesCandidates(scan, rootHost);
          if (rows.length > best.length) best = rows;
          if (best.length >= 6) break;
        } catch {}
      }
      if (!best.length) {
        const catalog = await discoverCatalog(root);
        const needle = q.toLowerCase();
        best = catalog.series.filter((a) => `${a.text} ${a.url}`.toLowerCase().includes(needle));
      }
      return json({ series: best.slice(0, 50).map(summaryFromAnchor), hasNextPage: false });
    }
    const series = rest.match(/^series\/([^/]+)$/);
    if (series) return json(await dynamicSeriesDetail(root, decodeToken(decodeURIComponent(series[1]))), 200, 'private, max-age=120');

    const manifest = rest.match(/^chapters\/([^/]+)\/manifest$/);
    if (manifest) {
      const chapterId = decodeURIComponent(manifest[1]);
      const chapterUrl = decodeToken(chapterId);
      const pages = await dynamicPages(root, chapterUrl);
      return json({
        schema: 'yomu.chapter-manifest/1',
        chapterId,
        sourceSeriesId: '',
        manifestVersion: `fabric-${chapterId.slice(0, 12)}-${pages.length}`,
        pageListVersion: pages.length,
        expiresAt: Date.now() + 10 * 60 * 1000,
        pages,
        delivery: 'direct',
      });
    }
    return json({ error: 'Unknown dynamic Source Fabric endpoint.' }, 404);
  } catch (error: any) {
    return json({ error: error.message ?? 'Source Fabric request failed.' }, error.status === 404 ? 404 : 502);
  }
}

async function handleKagane(request: Request, url: URL, rest: string): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Kagane source endpoints are read-only.' }, 405);
  try {
    if (rest === 'series') return json(await kaganeList('popular', '', Number(url.searchParams.get('page') ?? '1') || 1), 200, 'private, max-age=180');
    if (rest === 'latest') return json(await kaganeList('latest', '', Number(url.searchParams.get('page') ?? '1') || 1), 200, 'private, max-age=120');
    if (rest === 'search') return json(await kaganeList('search', url.searchParams.get('q') ?? '', Number(url.searchParams.get('page') ?? '1') || 1), 200, 'private, max-age=60');
    const series = rest.match(/^series\/([^/]+)$/);
    if (series) return json(await kaganeDetail(decodeURIComponent(series[1])), 200, 'private, max-age=120');
    const manifest = rest.match(/^chapters\/([^/]+)\/manifest$/);
    if (manifest) {
      const chapterId = decodeURIComponent(manifest[1]);
      const pages = await kaganePages(chapterId);
      return json({ schema: 'yomu.chapter-manifest/1', chapterId, sourceSeriesId: '', manifestVersion: `kagane-${chapterId}-${pages.length}`, pageListVersion: pages.length, expiresAt: Date.now() + 8 * 60 * 1000, pages, delivery: 'direct' });
    }
    return json({ error: 'Unknown Kagane Source Fabric endpoint.' }, 404);
  } catch (error: any) {
    return json({ error: error.message ?? 'Kagane request failed.' }, 502);
  }
}

export async function handleFabric(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/api/fabric/status') {
    return json({ ok: true, version: '5.0', desktopRequired: false, engines: ['fabric-native', 'remote-generic'], nativeSources: fabricSourceCards(url.origin).map((s) => s.name) });
  }
  if (url.pathname === '/api/fabric/resolve') return resolveSource(env, request, url);

  const fixed = url.pathname.match(/^\/api\/fabric\/source\/kagane\/(.*)$/);
  if (fixed) return handleKagane(request, url, fixed[1]);

  const dynamic = url.pathname.match(/^\/api\/fabric\/dynamic\/([^/]+)\/(.*)$/);
  if (dynamic) return handleDynamic(request, url, dynamic[1], dynamic[2]);

  return json({ error: 'Unknown Source Fabric route.' }, 404);
}
