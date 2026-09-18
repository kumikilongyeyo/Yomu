/**
 * Per-series page metadata, written into the shell on the way out.
 *
 * Every `/series/<id>` served `<title>Yomu</title>` with no description, no
 * cover and no canonical link, because the shell is one exported file shared
 * by every title. So a link to a specific book unfurled in a chat as the word
 * "Yomu", search engines saw one page repeated a few thousand times, and the
 * browser tab said nothing until React hydrated.
 *
 * The Worker already runs before Static Assets (`run_worker_first`), so the
 * shell can be rewritten on the way through. The difficulty is that asking a
 * provider for a title costs a second or more -- it is a fetch and a parse
 * against someone else's website -- and the series page is the one screen
 * that must never get slower. So the cost is spent only where it buys
 * something:
 *
 *   **A reader never waits.** On a cache miss a human gets the shell
 *   immediately, exactly as before. They are already looking at the title;
 *   they do not need a `<meta>` tag to tell them what it is.
 *
 *   **A crawler always waits.** An unfurler or a search bot has no UI to
 *   render and no patience to lose, and it is the entire audience for these
 *   tags. It gets a real lookup with a generous deadline.
 *
 *   **Both fill the same cache.** Whoever pays for a title's lookup, the next
 *   request for it -- human or robot -- is rewritten for free, for six hours.
 *
 *   **Nothing is invented.** A field the provider does not give is left out
 *   rather than filled with the generic copy this exists to replace.
 *
 * The canonical link points at `/title/<slug>`, not at this URL: the book is
 * the identity and the provider binding is one way to reach it (worker/
 * title.ts). Two people sharing the same book from different sources should
 * be sharing the same link.
 */
import type { Env } from './index';
import { buildProviders } from './routes-extensions';
import { slugify } from './title';

/** What a crawler will wait. It has nothing to render in the meantime. */
const CRAWLER_DEADLINE_MS = 4000;

/** What a reader will wait for metadata they are not going to read: nothing. */
const READER_DEADLINE_MS = 0;

/** Long enough that the edge absorbs the cost; short enough to stay current. */
const CACHE = 'public, max-age=1800';

/** How long a resolved title is reused for. */
const META_TTL_S = 6 * 60 * 60;

const MAX_DESCRIPTION = 200;

/**
 * Is this a machine fetching the page for its link preview?
 *
 * A real navigation carries `Sec-Fetch-Mode: navigate`, which every current
 * browser sends and no unfurler does. The user-agent list is a second net for
 * the crawlers that predate Fetch Metadata. Being wrong is cheap in both
 * directions: a misread crawler gets the plain shell, and a misread reader
 * waits a moment on one page.
 */
export function looksAutomated(request: Request): boolean {
  const mode = request.headers.get('sec-fetch-mode');
  if (mode === 'navigate') return false;
  const agent = (request.headers.get('user-agent') || '').toLowerCase();
  if (!agent) return true;
  return /bot|crawler|spider|slurp|facebookexternalhit|embedly|quora link preview|pinterest|discordbot|twitterbot|whatsapp|telegrambot|slackbot|linkedinbot|redditbot|applebot|bingpreview|vkshare|skypeuripreview|google-inspectiontool|curl|wget|headless/.test(agent);
}

/** The app addresses sources its way; the catalog names providers its own. */
export function providerIdOf(appSourceId: string): string {
  const id = String(appSourceId || '');
  if (id.startsWith('yomuext-')) return 'ext:' + id.slice('yomuext-'.length);
  if (id.startsWith('mihon-')) return 'suwayomi:' + id.slice('mihon-'.length);
  return id;
}

const escapeAttr = (value: string): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** One line of prose, cut on a word, with the markup and spoilers taken out. */
export function summarize(description: string | undefined, limit = MAX_DESCRIPTION): string {
  const flat = String(description || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[\/?[a-z]+[^\]]*\]/gi, ' ')
    .replace(/~!.*?!~/gs, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s]+$/, '') + '…';
}

export interface SeriesMeta {
  title: string;
  description: string;
  cover: string;
  canonical: string;
}

/** The tags to inject. Exported so the shape can be tested without a network. */
export function metaTags(meta: SeriesMeta, origin: string): string {
  const pageTitle = `${meta.title} · Yomu`;
  const absolute = (u: string) => (u && /^https?:/i.test(u) ? u : u ? origin + u : '');
  const rows: Array<[string, string]> = [
    ['description', meta.description],
  ];
  const props: Array<[string, string]> = [
    ['og:type', 'book'],
    ['og:site_name', 'Yomu'],
    ['og:title', pageTitle],
    ['og:description', meta.description],
    ['og:url', origin + meta.canonical],
    ['og:image', absolute(meta.cover)],
  ];
  const names: Array<[string, string]> = [
    ['twitter:card', meta.cover ? 'summary_large_image' : 'summary'],
    ['twitter:title', pageTitle],
    ['twitter:description', meta.description],
    ['twitter:image', absolute(meta.cover)],
  ];
  const out: string[] = [];
  for (const [name, content] of [...rows, ...names]) {
    if (content) out.push(`<meta name="${name}" content="${escapeAttr(content)}">`);
  }
  for (const [property, content] of props) {
    if (content) out.push(`<meta property="${property}" content="${escapeAttr(content)}">`);
  }
  out.push(`<link rel="canonical" href="${escapeAttr(origin + meta.canonical)}">`);
  return out.join('');
}

/** Ask the bound provider for the title. Null on anything at all going wrong. */
async function lookup(env: Env, origin: string, seriesId: string, source: string): Promise<SeriesMeta | null> {
  const providerId = providerIdOf(source);
  if (!providerId) return null;
  const providers = await buildProviders(env, origin);
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return null;

  const detail = await provider.extension.getSeries(seriesId);
  const title = String(detail?.title || '').trim();
  if (!title) return null;
  return {
    title,
    /* `synopsis` is what SeriesSummary calls it. */
    description: summarize(detail?.synopsis),
    cover: String(detail?.cover || ''),
    canonical: '/title/' + (slugify(title) || 'title') + '?q=' + encodeURIComponent(title),
  };
}

/* `caches.default` is a Workers extension; the DOM lib's CacheStorage does
   not declare it. Narrowed here rather than widened globally. */
const edgeCache = (caches as unknown as { default: Cache }).default;

/** Where a resolved title is kept between requests. Per colo, free, evictable. */
const metaKey = (origin: string, source: string, seriesId: string) =>
  new Request(`${origin}/__series-meta/${encodeURIComponent(source)}/${encodeURIComponent(seriesId)}`);

async function cachedMeta(key: Request): Promise<SeriesMeta | null> {
  try {
    const hit = await edgeCache.match(key);
    return hit ? ((await hit.json()) as SeriesMeta) : null;
  } catch { return null; }
}

async function rememberMeta(key: Request, meta: SeriesMeta): Promise<void> {
  try {
    await edgeCache.put(key, new Response(JSON.stringify(meta), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${META_TTL_S}` },
    }));
  } catch { /* A cache that will not take it is not a reason to fail a page. */ }
}

/**
 * Serve `/series/<id>`, with its own metadata when that can be had cheaply.
 *
 * `shell` is the untouched asset response and is what every failure path
 * returns, so the worst case here is exactly the behaviour before this file.
 */
export async function withSeriesMeta(shell: Response, request: Request, env: Env, url: URL): Promise<Response> {
  const seriesId = decodeURIComponent(url.pathname.slice('/series/'.length).replace(/\/+$/, ''));
  const source = url.searchParams.get('source') || '';
  if (!seriesId || !source) return shell;
  if (!(shell.headers.get('content-type') || '').includes('text/html')) return shell;

  const key = metaKey(url.origin, source, seriesId);
  let meta = await cachedMeta(key);

  if (!meta) {
    const deadline = looksAutomated(request) ? CRAWLER_DEADLINE_MS : READER_DEADLINE_MS;
    if (deadline > 0) {
      try {
        meta = await Promise.race([
          lookup(env, url.origin, seriesId, source),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline)),
        ]);
      } catch {
        meta = null;
      }
      if (meta) await rememberMeta(key, meta);
    }
  }
  if (!meta) return shell;

  const tags = metaTags(meta, url.origin);
  const pageTitle = `${meta.title} · Yomu`;

  const rewritten = new HTMLRewriter()
    /* The Helmet-managed title is the one the browser honours; React sets it
       again on hydration, to the same string, so nothing flickers. */
    .on('title', {
      element(element) {
        element.setInnerContent(pageTitle);
      },
    })
    .on('head', {
      element(element) {
        element.append(tags, { html: true });
      },
    })
    .transform(shell);

  const headers = new Headers(rewritten.headers);
  headers.set('cache-control', CACHE);
  return new Response(rewritten.body, { status: rewritten.status, headers });
}
