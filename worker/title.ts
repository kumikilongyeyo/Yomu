/**
 * `/title/...` — a book's address, independent of who is serving it.
 *
 * Every surface that draws a title needs somewhere to point *before* any
 * JavaScript runs. Until now the discovery rails pointed at `/search?q=`, and
 * a click handler quietly replaced that with the series screen. A plain left
 * click was fine and everything else was not: cmd-click, middle-click, "copy
 * link address", a shared URL, a bookmark and a restored session all followed
 * the href and landed the reader in Search, looking at a list containing the
 * one title they had already chosen.
 *
 * A href cannot be made valid by intercepting it. So the href is valid:
 *
 *   /title/solo-leveling?al=105398
 *
 * The Worker resolves that to whichever provider can actually serve it and
 * answers 302 to `/series/<seriesId>?source=<sourceId>`. The client-side
 * resolver in yomu-open-title.js still short-circuits a plain click, because
 * it knows things this route cannot -- which sources this device has enabled
 * -- but it is now an optimisation rather than the thing that makes the link
 * work.
 *
 * The slug is decoration. Identity is the AniList id when the surface knows
 * one, and the name otherwise; the slug is there so a pasted link says what
 * it is. That is the shape a real CanonicalTitle id will slot into later
 * (audit Phase 5) without changing any caller: the path stays `/title/<id>`.
 *
 * Capability safety matches the client: a provider known to be metadata-only
 * is never the redirect target, because a link that reliably opens a 502 is
 * not better than one that opens Search.
 */
import type { Env } from './index';
import { buildProviders } from './routes-extensions';
import { dedupe, rankByRelevance, type CatalogEntry } from './catalog';

/** Providers that answer metadata but cannot serve pages. Mirrors BAKED_BLIND. */
const BLIND = new Set(['comick']);

/** How long a browser may reuse a resolution. A binding can change. */
const CACHE = 'private, max-age=300';

export const slugify = (name: string): string =>
  String(name || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/** The app's id for a provider. Mirrors appSourceId() in yomu-open-title.js. */
export function appSourceId(providerId: string): string {
  const id = String(providerId || '');
  if (id.startsWith('ext:')) return 'yomuext-' + id.slice(4);
  if (id.startsWith('suwayomi:')) return 'mihon-' + id.slice(9);
  return id;
}

const isBlind = (providerId: string): boolean =>
  BLIND.has(String(providerId).replace(/^ext:/, ''));

/**
 * Which entry is the title being asked for.
 *
 * An AniList id on both sides is conclusive. Otherwise an exact name match,
 * and otherwise the catalog has already ranked by relevance against the query
 * so the first entry is the answer.
 */
export function matchEntry(entries: CatalogEntry[], name: string, anilistId: number | null): CatalogEntry | null {
  if (!entries.length) return null;
  if (anilistId) {
    const exact = entries.find((e) => Number((e as { anilistId?: number }).anilistId) === anilistId);
    if (exact) return exact;
  }
  const wanted = name.trim().toLowerCase();
  return entries.find((e) => String(e.title || '').trim().toLowerCase() === wanted) ?? entries[0];
}

/** The provider to open, or null when nothing readable carries it. */
export function chooseBinding(entry: CatalogEntry | null): { seriesId: string; sourceId: string } | null {
  const providers = entry?.providers ?? [];
  const readable = providers.filter((p) => !isBlind(p.id));
  // Natives first: this route has no device knowledge, and MangaDex is the one
  // source every install has.
  const best = readable.find((p) => p.kind === 'native') ?? readable[0];
  if (!best) return null;
  return { seriesId: best.seriesId, sourceId: appSourceId(best.id) };
}

const redirect = (to: string, cache: string): Response =>
  new Response(null, { status: 302, headers: { location: to, 'cache-control': cache } });

export async function handleTitle(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Only GET.', { status: 405 });
  }

  const slug = decodeURIComponent(url.pathname.slice('/title/'.length)).replace(/\/+$/, '');
  // `?q=` is the exact name when the surface has it; the slug is a fallback
  // with the punctuation already lost, which searches worse.
  const name = (url.searchParams.get('q') || slug.replace(/-/g, ' ')).trim();
  const anilistId = Number(url.searchParams.get('al')) || null;
  const search = '/search?q=' + encodeURIComponent(name);

  if (!name) return redirect('/', 'no-store');

  try {
    const adult = url.searchParams.get('adult') === '1';
    const providers = (await buildProviders(env, url.origin, adult, false))
      .filter((p) => p.kind !== 'suwayomi');

    const batches = await Promise.all(
      providers.map(async (provider) => {
        try {
          const result = await provider.extension.search(name, 1);
          return { provider, series: result.series };
        } catch {
          return { provider, series: [] };
        }
      }),
    );

    const entries = rankByRelevance(dedupe(batches), name);
    const binding = chooseBinding(matchEntry(entries, name, anilistId));
    if (!binding) return redirect(search, 'no-store');

    return redirect(
      '/series/' + encodeURIComponent(binding.seriesId) + '?source=' + encodeURIComponent(binding.sourceId),
      CACHE,
    );
  } catch {
    // The catalog is down, or the title is not in it. Search is where a reader
    // turns a name into a source they can add, so it remains the floor --
    // reached honestly, rather than because the href was wrong all along.
    return redirect(search, 'no-store');
  }
}
