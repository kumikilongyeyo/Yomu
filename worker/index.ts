/**
 * Yomu Cloudflare Worker
 *
 * - serves the exported Yomu web app
 * - relays MangaDex + Internet Archive
 * - bridges a Suwayomi server into Yomu's generic source contract
 *
 * Configure the bridge with Cloudflare secrets:
 *   npx wrangler secret put SUWAYOMI_URL
 *   npx wrangler secret put SUWAYOMI_AUTH_HEADER   # optional, exact Authorization header value
 */
import {
  fetchChapterPages,
  fetchMangaAndChapters,
  fetchSourceManga,
  getSuwayomiSources,
  activeSuwayomiBase,
  suwayomiBases,
} from './providers/suwayomi';
import { handleCatalog, handleExtensions } from './routes-extensions';
import { handleSimilar } from './similar';
import { handleSync } from './routes-sync';
import { handleCircle } from './routes-circle';
import { handleShelf } from './routes-shelf';
import { handleTitle } from './title';
import { withSeriesMeta } from './series-meta';
import { handleSeo } from './seo';

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Base URL of the Yomu extension repository (raw GitHub). Optional: the
   *  Worker falls back to the adapters bundled under `extensions/`. */
  EXTENSIONS_REPO?: string;
  SUWAYOMI_URL?: string;
  SUWAYOMI_AUTH_HEADER?: string;
  /** Yomu Sync's store. Optional: without the binding /api/sync/* answers 503
   *  and every other route, and the whole app, is unaffected. */
  SYNC: KVNamespace;
}

type AnyObject = Record<string, any>;

const UPSTREAMS: Record<string, string> = {
  md: 'https://api.mangadex.org',
  ia: 'https://archive.org',
};

/* The MangaDex relay answers no-store for everything, which means Home's
 * twenty-odd catalog reads -- a detail and a chapter feed per title on screen
 * -- go all the way to MangaDex again for every visitor, every load, for data
 * that is identical for all of them.
 *
 * An allow-list rather than a deny-list, because the dangerous one is easy to
 * miss: /at-home/server/<id> hands back a signed, short-lived image host, and
 * a cached copy of that is a reader that stops loading pages a quarter of an
 * hour later. Anything not named here keeps no-store, so a MangaDex endpoint
 * nobody has thought about yet is uncached by default rather than by luck.
 *
 * Ten minutes at the edge is a deliberate ceiling on how late a new chapter
 * can appear. Browsers hold it for five.
 */
const CACHEABLE_MD_READS = new Set(['manga', 'chapter', 'cover', 'author', 'statistics', 'group']);
const MD_BROWSER_TTL = 300;
const MD_EDGE_TTL = 600;

const ALLOWED_IMAGE_HOSTS = new Set(['uploads.mangadex.org', 'iiif.archive.org', 'archive.org']);
const ALLOWED_IMAGE_SUFFIXES = ['.mangadex.network', '.mangadex.org'];

const imageHostAllowed = (host: string): boolean =>
  ALLOWED_IMAGE_HOSTS.has(host) || ALLOWED_IMAGE_SUFFIXES.some((s) => host.endsWith(s));

const json = (body: unknown, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
    },
  });

const userAgent = (url: URL) => `Yomu/0.2 (personal reader; +${url.origin})`;

function yomuImageUrl(requestUrl: URL, path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  return `${requestUrl.origin}/api/suwayomi/image?path=${encodeURIComponent(path)}`;
}

/**
 * A Mihon source's browse list carries nothing but a title and a cover -- genres
 * only arrive once a title is opened. But these sources are themselves
 * format-specific far more reliably than any single title is tagged, so when a
 * title says nothing about its own format, fall back to what its source
 * publishes. Matching is on the source's own name, so this scales to any number
 * of installed sources; one that says nothing simply stays uncategorised, which
 * is exactly what it did before.
 */
const SOURCE_CATEGORY_PATTERNS: Array<[RegExp, string]> = [
  [/manhwa/i, 'manhwa'],
  [/manhua/i, 'manhua'],
  [/webtoons?|\btoons?\b/i, 'webtoon'],
];

let sourceCategoryCache: Map<string, string | undefined> | null = null;

async function sourceCategoryHint(env: Env, sourceId: string): Promise<string | undefined> {
  if (!sourceCategoryCache) {
    try {
      const map = new Map<string, string | undefined>();
      for (const source of await getSuwayomiSources(env)) {
        const label = `${source.displayName ?? ''} ${source.name ?? ''}`;
        map.set(String(source.id), SOURCE_CATEGORY_PATTERNS.find(([re]) => re.test(label))?.[1]);
      }
      sourceCategoryCache = map;
    } catch {
      return undefined; // a lookup failure must never fail the browse itself
    }
  }
  return sourceCategoryCache.get(sourceId);
}

function categoryFromManga(manga: AnyObject): string | undefined {
  const text = [manga.title, ...(manga.genre ?? [])].join(' ').toLowerCase();
  if (/webtoon/.test(text)) return 'webtoon';
  if (/manhwa|korean/.test(text)) return 'manhwa';
  if (/manhua|chinese|cultivation|wuxia|xianxia/.test(text)) return 'manhua';
  if (/manga|japanese/.test(text)) return 'manga';
  return undefined;
}

function toSummary(url: URL, manga: AnyObject, fallbackCategory?: string) {
  const category = categoryFromManga(manga) ?? fallbackCategory;
  const author = manga.author || manga.artist || 'Unknown';
  const status = String(manga.status ?? '').toLowerCase();
  const updatedSec = Number(manga.chaptersLastFetchedAt ?? manga.lastFetchedAt ?? 0);
  return {
    id: String(manga.id),
    title: manga.title || 'Untitled',
    author,
    synopsis: manga.description || '',
    genres: Array.isArray(manga.genre) ? manga.genre : [],
    ...(category ? { category } : {}),
    ...(status ? { status } : {}),
    ...(manga.thumbnailUrl ? { cover: yomuImageUrl(url, manga.thumbnailUrl) } : {}),
    ...(updatedSec > 0 ? { updatedAt: updatedSec * 1000 } : {}),
  };
}

function toChapter(ch: AnyObject) {
  const uploadSec = Number(ch.uploadDate ?? 0);
  return {
    id: String(ch.id),
    number: Number.isFinite(Number(ch.chapterNumber)) ? Number(ch.chapterNumber) : 0,
    name: ch.name || `Chapter ${ch.chapterNumber ?? ''}`.trim(),
    pageCount: Number(ch.pageCount ?? 0),
    ...(uploadSec > 0 ? { publishedAt: uploadSec * 1000 } : {}),
  };
}

async function proxySuwayomiImage(request: Request, env: Env, url: URL): Promise<Response> {
  const bases = suwayomiBases(env);
  if (!bases.length) return json({ error: 'Suwayomi is not configured.' }, 503);
  const raw = url.searchParams.get('path');
  if (!raw) return json({ error: 'Missing Suwayomi image path.' }, 400);

  // Resolved against whichever server is answering, but accepted only if it
  // lands on one of the configured origins -- several servers may be set, and
  // none of them makes this an open proxy.
  const base = activeSuwayomiBase(env) ?? bases[0];
  let target: URL;
  try {
    const allowed = new Set(bases.map((b) => new URL(b).origin));
    target = new URL(raw, `${base}/`);
    if (!allowed.has(target.origin)) {
      return json({ error: 'Refusing an image outside the configured Suwayomi servers.' }, 403);
    }
  } catch {
    return json({ error: 'Invalid Suwayomi image URL.' }, 400);
  }

  const headers: Record<string, string> = { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' };
  if (env.SUWAYOMI_AUTH_HEADER?.trim()) headers.Authorization = env.SUWAYOMI_AUTH_HEADER.trim();

  const upstream = await fetch(target.toString(), {
    headers,
    cf: { cacheEverything: true, cacheTtl: 60 * 60 * 24 },
  } as RequestInit & { cf?: { cacheEverything?: boolean; cacheTtl?: number } });
  if (!upstream.ok) return json({ error: `Suwayomi image unavailable (${upstream.status}).` }, 502);

  const type = upstream.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) return json({ error: 'Suwayomi returned something other than an image.' }, 502);
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=86400',
    },
  });
}

async function handleSuwayomi(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Only GET is supported on the Yomu source bridge.' }, 405);

  if (url.pathname === '/api/suwayomi/status') {
    const bases = suwayomiBases(env);
    if (!bases.length) return json({ configured: false, sources: 0 });
    try {
      // Ask first: whichever server answers becomes the active one, so the
      // host reported below is the one actually serving, not just the first
      // configured.
      const sources = await getSuwayomiSources(env);
      const base = activeSuwayomiBase(env) ?? bases[0];
      return json({
        configured: true,
        reachable: true,
        sources: sources.length,
        server: new URL(base).host,
        ...(bases.length > 1 ? { servers: bases.map((b) => new URL(b).host) } : {}),
      }, 200, 'no-store');
    } catch (error: any) {
      return json({
        configured: true,
        reachable: false,
        sources: 0,
        servers: bases.map((b) => new URL(b).host),
        error: error?.message ?? 'Could not reach Suwayomi.',
        /* 200, not 502. The Worker did its job: it asked the bridge and is
           reporting the answer, and `reachable: false` with the upstream's own
           message is that answer. A 5xx here says *this Worker* failed, which
           is untrue, and Cloudflare counts it -- a configured-but-offline
           bridge (an expired trycloudflare tunnel, say) then reports as a
           wall of Workers errors on the dashboard and buries real ones. The
           only reader, loadBridge() in yomu-shell.js, parses the body and
           never looked at the status. */
      }, 200, 'no-store');
    }
  }

  if (url.pathname === '/api/suwayomi/sources') {
    try {
      const sources = (await getSuwayomiSources(env))
        .filter((s) => s && s.id != null)
        .map((s) => ({
          id: String(s.id),
          name: s.name,
          displayName: s.displayName || s.name,
          lang: s.lang,
          contentWarning: s.contentWarning,
          supportsLatest: !!s.supportsLatest,
          iconUrl: s.iconUrl ? yomuImageUrl(url, s.iconUrl) : undefined,
          homeUrl: s.homeUrl || undefined,
        }));
      return json({ sources }, 200, 'private, max-age=60');
    } catch (error: any) {
      return json({ error: error?.message ?? 'Could not list Suwayomi sources.' }, 502);
    }
  }

  if (url.pathname === '/api/suwayomi/image') {
    return proxySuwayomiImage(request, env, url);
  }

  const match = url.pathname.match(/^\/api\/suwayomi\/source\/([^/]+)\/(.*)$/);
  if (!match) return json({ error: 'Unknown Suwayomi bridge route.' }, 404);

  const sourceId = decodeURIComponent(match[1]);
  const rest = match[2];

  try {
    const sourceCategory = await sourceCategoryHint(env, sourceId);
    if (rest === 'series') {
      const result = await fetchSourceManga(env, sourceId, 'POPULAR', '', 1);
      return json({ series: result.mangas.map((m) => toSummary(url, m, sourceCategory)) }, 200, 'private, max-age=300');
    }

    if (rest === 'search') {
      const q = url.searchParams.get('q')?.trim() ?? '';
      if (!q) return json({ series: [] });
      const result = await fetchSourceManga(env, sourceId, 'SEARCH', q, 1);
      return json({ series: result.mangas.map((m) => toSummary(url, m, sourceCategory)) }, 200, 'private, max-age=120');
    }

    if (rest === 'latest') {
      let result;
      try {
        result = await fetchSourceManga(env, sourceId, 'LATEST', '', 1);
      } catch {
        result = await fetchSourceManga(env, sourceId, 'POPULAR', '', 1);
      }
      const now = Date.now();
      return json(
        {
          series: result.mangas.map((m: AnyObject, index: number) => ({
            ...toSummary(url, m, sourceCategory),
            updatedAt: Number(m.chaptersLastFetchedAt ?? m.lastFetchedAt ?? 0) * 1000 || now - index,
          })),
        },
        200,
        'private, max-age=120',
      );
    }

    const seriesMatch = rest.match(/^series\/([^/]+)$/);
    if (seriesMatch) {
      const mangaId = Number(decodeURIComponent(seriesMatch[1]));
      if (!Number.isFinite(mangaId)) return json({ error: 'Invalid manga id.' }, 400);
      const detail = await fetchMangaAndChapters(env, mangaId);
      return json({ ...toSummary(url, detail.manga, sourceCategory), chapters: detail.chapters.map(toChapter) }, 200, 'private, max-age=120');
    }

    const manifestMatch = rest.match(/^chapters\/([^/]+)\/manifest$/);
    if (manifestMatch) {
      const chapterId = Number(decodeURIComponent(manifestMatch[1]));
      if (!Number.isFinite(chapterId)) return json({ error: 'Invalid chapter id.' }, 400);
      const result = await fetchChapterPages(env, chapterId);
      const pages = result.pages.map((path: string, index: number) => ({
        key: `${chapterId}-${index}`,
        index,
        url: yomuImageUrl(url, path),
      }));
      return json({
        schema: 'yomu.chapter-manifest/1',
        chapterId: String(chapterId),
        sourceSeriesId: String(result.chapter?.mangaId ?? ''),
        manifestVersion: `suwayomi-${chapterId}-${pages.length}`,
        pageListVersion: pages.length,
        expiresAt: Date.now() + 15 * 60 * 1000,
        pages,
        delivery: 'proxy',
      });
    }

    return json({ error: 'Unknown Yomu source endpoint.' }, 404);
  } catch (error: any) {
    return json({ error: error?.message ?? 'Suwayomi request failed.' }, 502);
  }
}

async function handleLegacyProxy(request: Request, url: URL): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Only GET is supported.' }, 405);

  if (url.pathname === '/api/img') {
    const target = url.searchParams.get('u');
    if (!target) return json({ error: 'Missing image URL.' }, 400);

    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return json({ error: 'That is not a valid URL.' }, 400);
    }
    if (parsed.protocol !== 'https:' || !imageHostAllowed(parsed.hostname)) {
      return json({ error: `Refusing to fetch from ${parsed.hostname}.` }, 403);
    }

    const upstream = await fetch(parsed.toString(), {
      headers: { 'User-Agent': userAgent(url), Referer: `${parsed.origin}/` },
      cf: { cacheEverything: true, cacheTtl: 60 * 60 * 24 * 30 },
    } as RequestInit & { cf?: { cacheEverything?: boolean; cacheTtl?: number } });
    if (!upstream.ok) return json({ error: `Image unavailable (${upstream.status}).` }, 502);

    const type = upstream.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return json({ error: 'That was not an image.' }, 502);

    return new Response(upstream.body, {
      headers: {
        'content-type': type,
        'cache-control': 'public, max-age=2592000, immutable',
      },
    });
  }

  const [, , name, ...rest] = url.pathname.split('/');
  const base = UPSTREAMS[name];
  if (!base) return json({ error: `Unknown source "${name}".` }, 404);

  const target = `${base}/${rest.join('/')}${url.search}`;
  const holdable = name === 'md' && CACHEABLE_MD_READS.has(rest[0] ?? '');
  const upstream = await fetch(target, {
    headers: { 'User-Agent': userAgent(url), Accept: 'application/json' },
    ...(holdable ? { cf: { cacheEverything: true, cacheTtl: MD_EDGE_TTL } } : {}),
  } as RequestInit & { cf?: { cacheEverything?: boolean; cacheTtl?: number } });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      /* Only a successful read is worth holding: caching an upstream error
         would keep a bad minute for ten of them. */
      'cache-control': holdable && upstream.ok
        ? `public, max-age=${MD_BROWSER_TTL}, s-maxage=${MD_EDGE_TTL}`
        : 'no-store',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    /* A shared shelf link is /shelf/<code>: no file by that name, so the
       asset server hands it here, and here it becomes the shelf page, which
       reads the code back out of the address. */
    if (/^\/shelf\/[A-Za-z0-9-]{6,20}\/?$/.test(url.pathname) && request.method === 'GET') {
      // Extensionless on purpose: the asset server answers /shelf.html with a
      // 307 to /shelf, and a rewrite that redirects is not a rewrite.
      return env.ASSETS.fetch(new Request(new URL('/shelf', url.origin).href, request));
    }
    /* A book's own address, resolved to whoever can serve it. This is what
       every title card points at, so it has to answer before any script runs
       -- see worker/title.ts. Above the asset handoff because there is no
       file by that name and the SPA fallback would otherwise swallow it. */
    /* robots.txt and sitemap.xml. Above the asset handoff because there are
       no such files, and the SPA fallback would answer both with HTML and a
       200 -- which a crawler reads as "this is your robots.txt" and cannot
       parse. */
    const seo = handleSeo(url);
    if (seo) return seo;

    if (url.pathname.startsWith('/title/')) return handleTitle(request, env, url);

    /* A series page gets its own title, description, cover and canonical link
       written into the shell (worker/series-meta.ts). Bounded by a deadline
       and cached at the edge; every failure path returns the shell untouched,
       so the worst case is exactly what was served before. */
    if (url.pathname.startsWith('/series/') && request.method === 'GET') {
      return withSeriesMeta(await env.ASSETS.fetch(request), request, env, url);
    }

    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname.startsWith('/api/ext/')) return handleExtensions(request, env, url);
    if (url.pathname === '/api/catalog/similar') return handleSimilar(request, env, url);
    if (url.pathname.startsWith('/api/catalog/')) return handleCatalog(request, env, url);
    if (url.pathname.startsWith('/api/suwayomi/')) return handleSuwayomi(request, env, url);
    if (url.pathname.startsWith('/api/sync/')) return handleSync(request, env, url);
    if (url.pathname.startsWith('/api/circle/')) return handleCircle(request, env, url);
    if (url.pathname.startsWith('/api/shelf/')) return handleShelf(request, env, url);
    return handleLegacyProxy(request, url);
  },
};
