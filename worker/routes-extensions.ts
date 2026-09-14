/**
 * HTTP surface for the extension system and the catalog.
 *
 * Two families of route:
 *   /api/ext/...      one extension at a time, speaking the same generic
 *                     "Yomu API source" contract the app already knows, so an
 *                     extension registers in the existing Sources screen with
 *                     no frontend change at all.
 *   /api/catalog/...  every provider at once: ranked, merged, deduplicated,
 *                     with fallback.
 */
import type { Env } from './index';
import { loadRegistry } from './extensions/registry';
import type { LoadedExtension, RegistrySnapshot } from './extensions/registry';
import { descriptorAllowsImage, seriesIdForChapter } from './extensions/runtime';
import { allHealth, getHealth } from './extensions/health';
import { createMangadexProvider, mangadexProvider } from './providers/mangadex';
import { getSuwayomiSources, suwayomiConfigured, suwayomiSourceProvider } from './providers/suwayomi';
import { DEFAULT_RANK, dedupe, fromAll, normalizeTitle, rankByRelevance, relevance, withFallback } from './catalog';
import type { Provider } from './catalog';
import type { SeriesSummary } from './extensions/types';

const json = (body: unknown, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  });

/* --- registry caching -------------------------------------------------- */

let cached: { snapshot: RegistrySnapshot; at: number } | null = null;
const REGISTRY_MEMO_MS = 5 * 60 * 1000;

export async function registry(env: Env, force = false): Promise<RegistrySnapshot> {
  if (!force && cached && Date.now() - cached.at < REGISTRY_MEMO_MS) return cached.snapshot;
  const snapshot = await loadRegistry(env.EXTENSIONS_REPO, force);
  cached = { snapshot, at: Date.now() };
  return snapshot;
}

const findExtension = (snapshot: RegistrySnapshot, id: string): LoadedExtension | undefined =>
  snapshot.loaded.find((l) => l.entry.id === id);

/* --- image proxying ---------------------------------------------------- */

/**
 * Pages and covers are proxied so the browser never talks to a source host
 * directly (referer/CORS), and so an extension cannot be used as an open proxy:
 * the target must be on the declared allowlist of the extension that named it.
 */
const extImageUrl = (origin: string, extId: string, target: string) =>
  `${origin}/api/ext/image?ext=${encodeURIComponent(extId)}&u=${encodeURIComponent(target)}`;

async function proxyExtensionImage(env: Env, url: URL): Promise<Response> {
  const extId = url.searchParams.get('ext') ?? '';
  const target = url.searchParams.get('u') ?? '';
  if (!extId || !target) return json({ error: 'Missing image parameters.' }, 400);

  const snapshot = await registry(env);
  const loaded = findExtension(snapshot, extId);
  if (!loaded) return json({ error: 'Unknown extension.' }, 404);

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: 'Invalid image URL.' }, 400);
  }
  if (!descriptorAllowsImage(loaded.descriptor, parsed)) {
    return json({ error: `Refusing to fetch from ${parsed.hostname}.` }, 403);
  }

  let upstream: Response;
  try {
    upstream = await fetch(parsed.toString(), {
      headers: {
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
        Referer: `${new URL(loaded.descriptor.base).origin}/`,
        'User-Agent': 'Mozilla/5.0 (compatible; Yomu/0.3)',
      },
      signal: AbortSignal.timeout(15_000),
      cf: { cacheEverything: true, cacheTtl: 86_400 },
    } as RequestInit);
  } catch {
    return json({ error: 'Image request failed.' }, 502);
  }
  if (!upstream.ok) return json({ error: `Image unavailable (${upstream.status}).` }, 502);
  const type = upstream.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) return json({ error: 'That was not an image.' }, 502);

  return new Response(upstream.body, {
    status: 200,
    headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' },
  });
}

/** Rewrite absolute source URLs in a summary into proxied Yomu URLs. */
const proxied = (origin: string, extId: string, s: SeriesSummary): SeriesSummary =>
  s.cover ? { ...s, cover: extImageUrl(origin, extId, s.cover) } : s;

/* --- provider assembly ------------------------------------------------- */

/** Everything Yomu can read from right now, ranked. */
export async function buildProviders(
  env: Env,
  origin: string,
  includeSuwayomi = true,
  adult = false,
): Promise<Provider[]> {
  const providers: Provider[] = [];
  const snapshot = await registry(env);

  for (const loaded of snapshot.loaded) {
    // An adult source contributes nothing at all while the gate is closed.
    if (loaded.entry.nsfw && !adult) continue;
    providers.push({
      id: `ext:${loaded.entry.id}`,
      name: loaded.entry.name,
      kind: 'extension',
      rank: DEFAULT_RANK.extension,
      extension: loaded.extension,
    });
  }

  providers.push({
    id: 'mangadex',
    name: 'MangaDex',
    kind: 'native',
    rank: DEFAULT_RANK.native,
    extension: adult ? createMangadexProvider(true) : mangadexProvider,
  });

  // Suwayomi is strictly optional: unconfigured or offline simply means fewer
  // providers. Its source list is only fetched when it is configured.
  if (includeSuwayomi && suwayomiConfigured(env)) {
    try {
      const sources = await getSuwayomiSources(env);
      const image = (path: string) => `${origin}/api/suwayomi/image?path=${encodeURIComponent(path)}`;
      for (const source of sources.filter((s: any) => s?.id != null && (s.lang === 'en' || s.lang === 'all')).slice(0, 30)) {
        providers.push({
          id: `suwayomi:${source.id}`,
          name: `${source.displayName || source.name} (Suwayomi)`,
          kind: 'suwayomi',
          rank: DEFAULT_RANK.suwayomi,
          extension: suwayomiSourceProvider(env, String(source.id), String(source.displayName || source.name), image),
        });
      }
    } catch {
      // Offline. Nothing to add, nothing to report here -- /api/catalog/status says so.
    }
  }

  return providers;
}

/* --- routes ------------------------------------------------------------ */

export async function handleExtensions(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Only GET is supported.' }, 405);
  const origin = url.origin;

  if (url.pathname === '/api/ext/image') return proxyExtensionImage(env, url);

  if (url.pathname === '/api/ext/status' || url.pathname === '/api/ext/refresh') {
    const force = url.pathname === '/api/ext/refresh';
    const snapshot = await registry(env, force);
    return json(
      {
        source: snapshot.source,
        repo: snapshot.repo,
        updatedAt: snapshot.updatedAt,
        installed: snapshot.loaded.length,
        broken: snapshot.rejected.length,
        rejected: snapshot.rejected,
      },
      200,
      'no-store',
    );
  }

  if (url.pathname === '/api/ext/sources') {
    const snapshot = await registry(env);
    return json(
      {
        source: snapshot.source,
        repo: snapshot.repo,
        extensions: snapshot.loaded.map(({ entry, descriptor }) => {
          const health = getHealth(`ext:${entry.id}`);
          return {
            id: entry.id,
            name: entry.name,
            version: entry.version,
            language: entry.language,
            content: entry.content,
            capabilities: entry.capabilities,
            nsfw: !!entry.nsfw,
            hosts: descriptor.hosts,
            api: `${origin}/api/ext/source/${encodeURIComponent(entry.id)}/`,
            status: health ? (health.lastOkAt && health.lastOkAt >= (health.lastFailedAt ?? 0) ? 'ok' : 'failing') : 'unknown',
            lastOkAt: health?.lastOkAt,
            lastFailedAt: health?.lastFailedAt,
            lastError: health?.lastError,
            lastLatencyMs: health?.lastLatencyMs,
          };
        }),
        broken: snapshot.rejected,
      },
      200,
      'no-store',
    );
  }

  if (url.pathname === '/api/ext/health') {
    return json({ health: allHealth() }, 200, 'no-store');
  }

  // Per-extension routes, matching the generic Yomu API source contract.
  const match = url.pathname.match(/^\/api\/ext\/source\/([^/]+)\/(.*)$/);
  if (!match) return json({ error: 'Unknown extension route.' }, 404);

  const extId = decodeURIComponent(match[1]);
  const rest = match[2];
  const snapshot = await registry(env);
  const loaded = findExtension(snapshot, extId);
  if (!loaded) return json({ error: `Unknown extension "${extId}".` }, 404);

  const ext = loaded.extension;
  const wrap = (s: SeriesSummary) => proxied(origin, extId, s);

  try {
    if (rest === 'series') {
      const page = Number(url.searchParams.get('page') ?? '1') || 1;
      const result = await ext.popular(page);
      return json({ series: result.series.map(wrap) }, 200, 'private, max-age=300');
    }

    if (rest === 'latest') {
      const page = Number(url.searchParams.get('page') ?? '1') || 1;
      const result = await ext.latest(page);
      return json({ series: result.series.map(wrap) }, 200, 'private, max-age=120');
    }

    if (rest === 'search') {
      const q = url.searchParams.get('q')?.trim() ?? '';
      if (!q) return json({ series: [] });
      const result = await ext.search(q, Number(url.searchParams.get('page') ?? '1') || 1);
      return json({ series: result.series.map(wrap) }, 200, 'private, max-age=120');
    }

    const seriesMatch = rest.match(/^series\/(.+)$/);
    if (seriesMatch) {
      const id = decodeURIComponent(seriesMatch[1]);
      const detail = await ext.getSeries(id);
      const chapters = detail.chapters?.length ? detail.chapters : await ext.getChapters(id);
      return json({ ...wrap(detail), chapters }, 200, 'private, max-age=120');
    }

    const manifestMatch = rest.match(/^chapters\/(.+)\/manifest$/);
    if (manifestMatch) {
      const chapterId = decodeURIComponent(manifestMatch[1]);
      const pages = await ext.getPages(chapterId);
      return json({
        schema: 'yomu.chapter-manifest/1',
        chapterId,
        // Required by the reader's manifest validator: a manifest without it is
        // rejected outright and the chapter never opens.
        sourceSeriesId: seriesIdForChapter(loaded.descriptor, chapterId),
        manifestVersion: `${extId}-${chapterId}-${pages.length}`,
        pageListVersion: pages.length,
        expiresAt: Date.now() + 15 * 60 * 1000,
        pages: pages.map((p) => ({ ...p, url: extImageUrl(origin, extId, p.url) })),
        delivery: 'proxy',
      });
    }

    return json({ error: 'Unknown extension endpoint.' }, 404);
  } catch (error: any) {
    return json({ error: error?.message ?? 'Extension request failed.', extension: extId }, 502);
  }
}

/**
 * Another name for the same title, for a second search round.
 *
 * Prefers a name the reader did not type that is written in the Latin
 * alphabet, because that is the spelling the other sources will have indexed:
 * a search for "Na Honjaman Level-Up" yields "Solo Leveling", which is how
 * every scanlation site files it. Null when there is nothing new to try.
 */
function otherSpelling(entry: { title: string; altTitles?: string[] }, query: string): string | null {
  const typed = normalizeTitle(query);
  for (const name of [entry.title, ...(entry.altTitles ?? [])]) {
    if (!name) continue;
    const latin = /^[ -~]+$/.test(name) && /[A-Za-z]/.test(name);
    if (!latin) continue;
    const key = normalizeTitle(name);
    if (!key || key === typed) continue;
    return name;
  }
  return null;
}

/* --- catalog routes ---------------------------------------------------- */

export async function handleCatalog(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Only GET is supported.' }, 405);
  const origin = url.origin;

  if (url.pathname === '/api/catalog/status') {
    const snapshot = await registry(env);
    const providers = await buildProviders(env, origin);
    const suwayomi = providers.filter((p) => p.kind === 'suwayomi');
    return json(
      {
        native: [{ id: 'mangadex', name: 'MangaDex', status: 'online' }],
        extensions: snapshot.loaded.map((l) => ({ id: l.entry.id, name: l.entry.name, version: l.entry.version })),
        broken: snapshot.rejected,
        suwayomi: {
          configured: suwayomiConfigured(env),
          online: suwayomi.length > 0,
          sources: suwayomi.length,
          role: 'fallback',
        },
        priority: ['Yomu Extensions', 'MangaDex', 'Suwayomi (fallback)'],
      },
      200,
      'no-store',
    );
  }

  const listing = url.pathname.match(/^\/api\/catalog\/(popular|latest|search)$/);
  if (listing) {
    const kind = listing[1] as 'popular' | 'latest' | 'search';
    const q = url.searchParams.get('q')?.trim() ?? '';
    if (kind === 'search' && !q) return json({ series: [] });
    const adult = url.searchParams.get('adult') === '1';

    // Suwayomi is excluded from broad listings: it is a fallback, and fanning
    // out to a home server for a browse grid is slow for little gain.
    const providers = (await buildProviders(env, origin, false, adult)).filter((p) => p.kind !== 'suwayomi');

    type Batch = Array<{ provider: Provider; value: { series: SeriesSummary[] } }>;
    const run = (query: string): Promise<Batch> =>
      fromAll(providers, (p) =>
        kind === 'search'
          ? p.extension.search(query, 1)
          : kind === 'latest'
            ? p.extension.latest(1)
            : p.extension.popular(1),
      );

    const collect = (batches: Batch[]) =>
      dedupe(
        batches.flat().map(({ provider, value }) => ({
          provider,
          series: value.series.map((s) =>
            provider.kind === 'extension' ? proxied(origin, provider.id.replace(/^ext:/, ''), s) : s,
          ),
        })),
      );

    const results = await run(q);
    let merged = collect([results]);
    // Providers answer in whatever order they finish, so a search has to be
    // re-ranked against the query or one source's loose matches bury the title.
    let ordered = kind === 'search' ? rankByRelevance(merged, q) : merged;
    let alsoSearched: string | null = null;

    if (kind === 'search') {
      // Cross-language search. Only MangaDex indexes a title's other spellings,
      // so a romanised Japanese, Korean or Chinese query finds the work but
      // comes back with MangaDex as its only source -- the scanlation sites
      // carry it under its English name and never saw the query. When the best
      // match is that thinly corroborated, ask again under the name it is filed
      // under elsewhere and merge both rounds.
      const top = ordered[0];
      if (top && top.providers.length * 2 < providers.length && relevance(top, q) >= 0.75) {
        const alias = otherSpelling(top, q);
        if (alias) {
          merged = collect([results, await run(alias)]);
          // Still ranked against what was typed, not against the alias.
          ordered = rankByRelevance(merged, q);
          alsoSearched = alias;
        }
      }
    }

    // Belt and braces: MangaDex is already filtered by rating and adult
    // extensions never joined, but a source that self-reports nsfw per title
    // must not slip through a merge either.
    if (!adult) ordered = ordered.filter((e) => !e.nsfw);

    return json(
      {
        series: ordered,
        providersTried: results.length,
        providersTotal: providers.length,
        ...(alsoSearched ? { alsoSearched } : {}),
      },
      200,
      kind === 'search' ? 'private, max-age=120' : 'private, max-age=300',
    );
  }

  // A title resolved through the priority chain, so one dead source is invisible.
  const seriesMatch = url.pathname.match(/^\/api\/catalog\/series\/([^/]+)\/(.+)$/);
  if (seriesMatch) {
    const providerId = decodeURIComponent(seriesMatch[1]);
    const seriesId = decodeURIComponent(seriesMatch[2]);
    const providers = await buildProviders(env, origin);
    const chosen = providers.filter((p) => p.id === providerId);
    if (!chosen.length) return json({ error: `Unknown provider "${providerId}".` }, 404);

    const result = await withFallback(chosen, (p) => p.extension.getSeries(seriesId));
    if (!result.value) {
      return json({ error: 'No provider could load that title.', attempts: result.attempts }, 502);
    }
    const extId = providerId.startsWith('ext:') ? providerId.slice(4) : null;
    const summary = extId ? proxied(origin, extId, result.value) : result.value;
    return json({ ...summary, provider: result.provider?.id, attempts: result.attempts }, 200, 'private, max-age=120');
  }

  return json({ error: 'Unknown catalog route.' }, 404);
}
