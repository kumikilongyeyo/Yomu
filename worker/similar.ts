/**
 * "What else would I like?" — answered with other people's opinions.
 *
 * Yomu already had `/api/catalog/related`, which compares MangaDex tags. Tag
 * overlap is a decent proxy and it is not what anyone means by a
 * recommendation: it will happily offer a title that shares four tags and
 * nothing else, and it needs the catalogue's exact title, so a shelf entry
 * saved as "Omniscient Reader" matched nothing at all.
 *
 * AniList has something better, and it is not an algorithm. Its users vote on
 * "if you liked X, read Y", so a recommendation carries a count: Solo
 * Leveling -> Omniscient Reader is 1,387 people rather than four shared tags.
 * That is a body of human judgement nobody here has to build, which is the
 * whole reason to reach for it instead of writing a recommender.
 *
 * It also returns tags ranked by how strongly voters think they apply
 * (Dungeon 95%, Necromancy 87%), which is a far better affinity signal than a
 * flat genre list and is what the badge system reads.
 *
 * Two things this has to get right:
 *
 *   **Caching is not optional.** AniList allows 30 requests a minute per IP,
 *   and a Worker egresses from one shared address for every reader at once.
 *   Answers are cached for a day in the Cache API rather than KV -- what a
 *   title is like does not change overnight, and KV's write budget is already
 *   spoken for by Sync.
 *
 *   **It must degrade, not fail.** AniList is a third party with no contract
 *   to us. A miss or an outage falls through to the MangaDex path that was
 *   here before, so the worst case is the quality Yomu had yesterday.
 */
import type { Env } from './index';
import { relatedFor } from './related';

const ANILIST = 'https://graphql.anilist.co';
const CACHE_SECONDS = 86400;

/** One request for everything: the match, its tags, and what readers suggest. */
const QUERY = `
query ($search: String) {
  Media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
    id
    title { romaji english native }
    genres
    averageScore
    tags { name rank isMediaSpoiler }
    recommendations(sort: RATING_DESC, perPage: 12) {
      nodes {
        rating
        mediaRecommendation {
          id
          title { romaji english }
          genres
          averageScore
          format
        }
      }
    }
  }
}`;

export interface SimilarPick {
  title: string;
  /** How many readers voted for this pairing. The whole point. */
  votes: number;
  score?: number;
  genres?: string[];
}

export interface SimilarAnswer {
  source: 'anilist' | 'mangadex' | 'none';
  matched: string | null;
  /** Tags ranked by how strongly voters think they apply, best first. */
  tags: { name: string; rank: number }[];
  genres: string[];
  picks: SimilarPick[];
  /** The plain tag names, for callers that only want the reason. */
  because: string[];
}

const json = (body: unknown, status = 200, cache = 'public, max-age=3600') =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  });

const EMPTY: SimilarAnswer = {
  source: 'none', matched: null, tags: [], genres: [], picks: [], because: [],
};

/* --- AniList -------------------------------------------------------------- */

async function fromAniList(search: string): Promise<SimilarAnswer | null> {
  const response = await fetch(ANILIST, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { search } }),
  });

  /* 429 is the shared-IP limit, and it is the one failure worth naming in the
     log: it means the cache is not doing its job. */
  if (response.status === 429) {
    console.warn('[similar] anilist rate limited');
    return null;
  }
  /* Distinguish the three ways this comes back empty. They have completely
     different fixes -- an HTTP status is us being blocked, a GraphQL error is
     a bad query, and a null Media is simply a title AniList does not index --
     and a single "had nothing" log cannot tell them apart. */
  if (!response.ok) {
    console.warn('[similar] anilist http', response.status, (await response.text()).slice(0, 200));
    return null;
  }

  const data: any = await response.json().catch(() => null);
  if (data?.errors?.length) {
    console.warn('[similar] anilist graphql', JSON.stringify(data.errors).slice(0, 200));
    return null;
  }
  const media = data?.data?.Media;
  if (!media) return null;

  const name = (t: any) => t?.english || t?.romaji || t?.native || '';

  /* Spoiler tags are dropped outright. They are the good ones -- the twist is
     what makes a title distinctive -- and printing "Necromancy" beside a
     recommendation is exactly the spoiler the reader did not ask for. */
  const tags: { name: string; rank: number }[] = (media.tags ?? [])
    .filter((t: any) => t && !t.isMediaSpoiler && typeof t.rank === 'number')
    .sort((a: any, b: any) => b.rank - a.rank)
    .slice(0, 8)
    .map((t: any) => ({ name: String(t.name), rank: Number(t.rank) }));

  const picks: SimilarPick[] = (media.recommendations?.nodes ?? [])
    .map((node: any) => {
      const row = node?.mediaRecommendation;
      if (!row) return null;
      const title = name(row.title);
      if (!title) return null;
      return {
        title,
        votes: Number(node.rating) || 0,
        score: typeof row.averageScore === 'number' ? row.averageScore : undefined,
        genres: Array.isArray(row.genres) ? row.genres.slice(0, 4) : [],
      };
    })
    .filter(Boolean)
    /* A single downvoted pairing is noise, not a recommendation. */
    .filter((p: SimilarPick) => p.votes > 0)
    .slice(0, 10);

  if (!picks.length && !tags.length) return null;

  return {
    source: 'anilist',
    matched: name(media.title),
    tags,
    genres: Array.isArray(media.genres) ? media.genres : [],
    picks,
    because: tags.slice(0, 4).map((t) => t.name),
  };
}

/* --- the MangaDex floor --------------------------------------------------- */

async function fromMangaDex(search: string, origin: string): Promise<SimilarAnswer | null> {
  try {
    const answer = await relatedFor({ id: '', source: '', title: search, adult: false, origin });
    const rows = [...(answer.related ?? []), ...(answer.similar ?? [])].slice(0, 10);
    if (!rows.length) return null;
    return {
      source: 'mangadex',
      matched: answer.matched?.title ?? null,
      /* No ranks on this path -- tag overlap has no strength, which is most
         of why AniList is asked first. */
      tags: (answer.similarBecause ?? []).map((name: string) => ({ name, rank: 0 })),
      genres: [],
      picks: rows.map((r) => ({ title: r.title, votes: 0 })),
      because: answer.similarBecause ?? [],
    };
  } catch {
    return null;
  }
}

/* --- the route ------------------------------------------------------------ */

export async function handleSimilar(request: Request, env: Env, url: URL): Promise<Response> {
  const title = (url.searchParams.get('title') ?? '').trim();
  if (!title) return json({ error: 'Need a title.' }, 400, 'no-store');
  if (title.length > 200) return json({ error: 'Title too long.' }, 400, 'no-store');

  /* Keyed on the normalised title, not the raw query string: "Solo Leveling"
     and "solo leveling" are one answer and should be one upstream call. */
  const key = new Request(
    `${url.origin}/api/catalog/similar?title=${encodeURIComponent(title.toLowerCase())}`,
    { method: 'GET' },
  );
  const cache = (caches as any).default;

  const hit = await cache.match(key);
  if (hit) return hit;

  /* The fallback is silent to the reader and must not be silent in the log.
     Degrading to MangaDex looks identical from outside -- an answer arrives,
     it is just a worse one -- so an AniList outage would otherwise show up as
     "the recommendations got bad" weeks later and nowhere else. */
  let answer: SimilarAnswer | null = null;
  try {
    answer = await fromAniList(title);
    if (!answer) console.warn('[similar] anilist had nothing for', JSON.stringify(title));
  } catch (error: any) {
    console.error('[similar] anilist failed:', error?.message ?? error);
  }
  if (!answer) answer = await fromMangaDex(title, url.origin);

  const body = answer ?? EMPTY;
  const response = json(body, 200, `public, max-age=${CACHE_SECONDS}`);

  /* Only a real answer is cached for a day. Caching "nothing found" for that
     long would mean a title AniList indexes tomorrow stays unanswerable. */
  if (body.source !== 'none') {
    await cache.put(key, response.clone());
  }
  return response;
}
