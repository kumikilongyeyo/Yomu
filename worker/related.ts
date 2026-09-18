import { normalizeTitle, similarity } from './catalog';

/**
 * "More from this author", and titles that are actually related to this one.
 *
 * The series screen already had a Related row, and on Vagabond it offered
 * Solo Leveling and Mushoku Tensei -- a genre match on Action and Adventure,
 * tags that half the catalogue carries. This answers the two questions a
 * reader on that page is really asking: what else did this person make, and
 * what is this one like.
 *
 * Everything here comes from MangaDex, because it is the only provider that
 * can answer either question. It is the one source that models an author as
 * an entity rather than a string on a title, and the only one that publishes
 * its own relationships between works -- the sequel, the spin-off, the
 * colour edition. The scraped extensions know none of that. A title MangaDex
 * has never heard of simply gets no section, which is the honest outcome:
 * guessing at "related" from a title string is how the row being replaced
 * ended up recommending a dungeon isekai under a Sengoku epic.
 */

const API = 'https://api.mangadex.org';
const UPLOADS = 'https://uploads.mangadex.org';
const TIMEOUT_MS = 9000;
const PER_ROW = 12;

const RATINGS_SAFE = '&contentRating[]=safe&contentRating[]=suggestive';
const RATINGS_ADULT = RATINGS_SAFE + '&contentRating[]=erotica&contentRating[]=pornographic';

/**
 * Genres too broad to say anything. A shared "Action" tag is not a
 * resemblance; a shared "Samurai" tag is. Themes are preferred over genres
 * outright, and these are the genres that never survive the cut even when no
 * theme is available.
 */
const BROAD = new Set([
  'Action', 'Adventure', 'Drama', 'Comedy', 'Romance', 'Fantasy',
  'Slice of Life', 'Mystery', 'Sci-Fi', 'Psychological',
]);

export interface RelatedTile {
  id: string;
  title: string;
  author?: string;
  cover?: string;
  year?: number;
  status?: string;
  /** MangaDex's own word for how it relates: sequel, spin_off, colored... */
  relation?: string;
}

export interface Credit {
  /** MangaDex's id for the person, which /api/catalog/author takes for the whole bibliography. */
  id: string;
  name: string;
  series: RelatedTile[];
  /** How many titles MangaDex files under this person, the current one included. */
  total: number;
}

export interface RelatedAnswer {
  matched: { id: string; title: string } | null;
  author?: Credit;
  artist?: Credit;
  related: RelatedTile[];
  similar: RelatedTile[];
  /** The tags the similar row was built from, so the UI can say why. */
  similarBecause: string[];
  /** How many candidates cleared the resemblance floor; more than the row
   *  shows means /api/catalog/alike has something to add. */
  similarTotal: number;
}

/** Everything MangaDex files under one person, as author or as artist. */
export interface WorksAnswer {
  id: string;
  name: string;
  total: number;
  series: RelatedTile[];
}

/** Every title that clears the resemblance floor, not just the first row. */
export interface AlikeAnswer {
  matched: { id: string; title: string } | null;
  because: string[];
  similar: RelatedTile[];
}

async function md<T = any>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${API}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Yomu/0.3 (personal reader)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cf: { cacheEverything: true, cacheTtl: 60 * 60 * 6 },
    } as RequestInit & { cf?: { cacheEverything?: boolean; cacheTtl?: number } });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // Every row is optional. A provider that is slow or down costs the reader
    // a section, never the page.
    return null;
  }
}

const pickTitle = (attr: any): string => {
  const t = attr?.title ?? {};
  return t.en ?? t['ja-ro'] ?? t.ja ?? (Object.values(t)[0] as string) ?? 'Untitled';
};

function toTile(item: any, origin: string): RelatedTile {
  const attr = item.attributes ?? {};
  const rels: any[] = item.relationships ?? [];
  const file = rels.find((r) => r.type === 'cover_art')?.attributes?.fileName;
  const author = rels.find((r) => r.type === 'author')?.attributes?.name;
  const year = Number(attr.year);
  return {
    id: String(item.id),
    title: pickTitle(attr),
    ...(author ? { author } : {}),
    ...(file
      ? { cover: `${origin}/api/img?u=${encodeURIComponent(`${UPLOADS}/covers/${item.id}/${file}.512.jpg`)}` }
      : {}),
    ...(Number.isFinite(year) && year > 0 ? { year } : {}),
    ...(attr.status ? { status: String(attr.status) } : {}),
  };
}

/** The MangaDex title this page is about, or null if it has no idea. */
async function resolve(id: string, source: string, title: string, ratings: string): Promise<any | null> {
  const direct = source === 'mangadex' && /^[0-9a-f-]{36}$/i.test(id);
  if (direct) {
    const data = await md(`/manga/${encodeURIComponent(id)}?includes[]=author&includes[]=artist&includes[]=cover_art`);
    if (data?.data) return data.data;
  }
  if (!title) return null;

  const found = await md(
    `/manga?title=${encodeURIComponent(title)}&limit=10&includes[]=author&includes[]=artist&includes[]=cover_art${ratings}`,
  );
  const wanted = normalizeTitle(title);
  let best: any = null;
  let score = 0;
  for (const item of found?.data ?? []) {
    const attr = item.attributes ?? {};
    /* Alternates count. MangaDex files Solo Leveling under "Na Honjaman
       Level-Up", so matching only the primary title finds nothing for the
       name every other source uses. */
    const raw = [
      pickTitle(attr),
      ...Object.values(attr.title ?? {}),
      ...(attr.altTitles ?? []).flatMap((entry: any) => Object.values(entry ?? {})),
    ].filter((v): v is string => typeof v === 'string');
    const near = Math.max(0, ...raw.map((name) => {
      const key = normalizeTitle(name);
      return key === wanted ? 1 : similarity(key, wanted);
    }));
    /* Ties are common and they matter: normalizeTitle drops "official" and
       "colored", so "Chainsaw Man (Official Colored)" scores exactly as well
       as "Chainsaw Man" and whichever MangaDex happened to return first wins
       -- landing the page on the colour reprint, whose author row is empty
       and whose only relation is the real title. The shorter name is the
       edition without the parenthetical. */
    const shorter = best && pickTitle(item.attributes).length < pickTitle(best.attributes).length;
    if (near > score || (near === score && near > 0 && shorter)) { score = near; best = item; }
  }
  // A loose match here would attach the wrong author's whole bibliography to
  // the page, which is worse than showing nothing.
  return score >= 0.9 ? best : null;
}

/**
 * Candidates that share this title's most specific tags.
 *
 * Three ANDed first, because three is where a tag set stops being a category
 * and starts being a description. Plenty of titles have no third specific tag
 * and plenty of trios match almost nothing, so a thin answer falls back to
 * two rather than leaving the row empty.
 */
async function tagPool(
  ranked: Array<{ id: string; name: string }>,
  ratings: string,
  limit = 40,
): Promise<any | null> {
  if (!ranked.length) return null;
  const ask = (tags: Array<{ id: string }>) =>
    md(
      `/manga?${tags.map((t) => `includedTags[]=${encodeURIComponent(t.id)}`).join('&')}`
      + `&includedTagsMode=AND&order[followedCount]=desc&includes[]=cover_art&includes[]=author&limit=${limit}${ratings}`,
    );

  const narrow = await ask(ranked.slice(0, 3));
  if ((narrow?.data?.length ?? 0) >= 8 || ranked.length < 3) return narrow;
  const wider = await ask(ranked.slice(0, 2));
  return (wider?.data?.length ?? 0) > (narrow?.data?.length ?? 0) ? wider : narrow;
}

/**
 * Relations that mean "this same work again".
 *
 * A reprint, a colour edition and a pre-serialisation draft all belong in
 * Related, where the label says what they are. In a bibliography they are
 * noise -- Fujimoto's page of other works should not open with Chainsaw Man
 * (Official Colored).
 */
const SAME_WORK = new Set(['colored', 'alternate_version', 'preserialization', 'doujinshi']);

/** A tile per result, skipping what an earlier row already spent, up to a cap. */
function takeTiles(data: any, spent: Set<string>, cap: number, origin: string): RelatedTile[] {
  const out: RelatedTile[] = [];
  for (const item of data?.data ?? []) {
    const tile = toTile(item, origin);
    if (spent.has(tile.id)) continue;
    spent.add(tile.id);
    out.push(tile);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * A title's tags, themes before genres and the broadest genres last, cut to
 * the five that say the most -- and the whole set, to score against.
 */
function rankTags(manga: any): { ranked: Array<{ id: string; name: string }>; mine: Set<string> } {
  const tags: any[] = manga.attributes?.tags ?? [];
  const named = tags
    .map((t) => ({ id: String(t.id), name: String(t.attributes?.name?.en ?? ''), group: String(t.attributes?.group ?? '') }))
    .filter((t) => t.id && t.name);
  const ranked = [
    ...named.filter((t) => t.group === 'theme'),
    ...named.filter((t) => t.group === 'genre' && !BROAD.has(t.name)),
    ...named.filter((t) => t.group === 'genre' && BROAD.has(t.name)),
  ].slice(0, 5);
  return { ranked, mine: new Set(named.map((t) => t.id)) };
}

/**
 * Candidates ranked by how much of this title's tag set they actually share,
 * not by how popular they are. Jaccard rather than a raw count, so a title
 * tagged with everything does not win by breadth. Three shared tags is the
 * floor: below that the resemblance is a coincidence.
 */
function scoreByTags(pool: any, mine: Set<string>): Array<{ item: any; shared: number; score: number }> {
  return (pool?.data ?? [])
    .map((item: any) => {
      const theirs: string[] = (item.attributes?.tags ?? []).map((t: any) => String(t.id));
      const shared = theirs.filter((id) => mine.has(id));
      const union = new Set([...theirs, ...mine]).size;
      return { item, shared: shared.length, score: union ? shared.length / union : 0 };
    })
    .filter((row: { shared: number }) => row.shared >= 3)
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score);
}

export async function relatedFor(
  { id, source, title, adult, origin }:
  { id: string; source: string; title: string; adult: boolean; origin: string },
): Promise<RelatedAnswer> {
  const ratings = adult ? RATINGS_ADULT : RATINGS_SAFE;
  const empty: RelatedAnswer = { matched: null, related: [], similar: [], similarBecause: [], similarTotal: 0 };

  const manga = await resolve(id, source, title, ratings);
  if (!manga) return empty;

  const rels: any[] = manga.relationships ?? [];
  const author = rels.find((r) => r.type === 'author');
  const artist = rels.find((r) => r.type === 'artist');
  const relatedIds = rels
    .filter((r) => r.type === 'manga' && r.id)
    .slice(0, PER_ROW)
    .map((r) => ({ id: String(r.id), relation: String(r.related ?? '') }));

  /* Themes before genres, and the broadest genres last.
   *
   * The top three, ANDed, are the candidate pool -- and then the pool is
   * re-ranked by how much of the whole tag set each candidate shares. Both
   * halves are needed. ANDing two tags and sorting by followers is what the
   * row being replaced did, and it is how a Sengoku epic ends up under a
   * dungeon isekai: "Historical" and "Martial Arts" are true of both and
   * after that it is just popularity. But ORing the tags and re-ranking is
   * worse, not better -- the pool becomes "the most followed titles on
   * MangaDex" and Vagabond gets One Piece and SPY×FAMILY. Narrow first,
   * then rank. */
  const { ranked, mine: mineTags } = rankTags(manga);

  const list = (qs: string) => md(`/manga?${qs}&includes[]=cover_art&includes[]=author&limit=${PER_ROW + 4}${ratings}`);

  const [byAuthor, byArtist, byRelation, byTags] = await Promise.all([
    author?.id ? list(`authors[]=${encodeURIComponent(author.id)}&order[followedCount]=desc`) : null,
    artist?.id && artist.id !== author?.id
      ? list(`artists[]=${encodeURIComponent(artist.id)}&order[followedCount]=desc`)
      : null,
    relatedIds.length ? list(relatedIds.map((r) => `ids[]=${encodeURIComponent(r.id)}`).join('&')) : null,
    tagPool(ranked, ratings),
  ]);

  const self = String(manga.id);
  const take = (data: any, spent: Set<string>, cap = PER_ROW): RelatedTile[] => takeTiles(data, spent, cap, origin);

  /* Two scopes, not one. "What else did this person make" is its own
   * question, and spending a title in Related first left TurtleMe's row empty
   * on The Beginning After the End -- his only other MangaDex entries are its
   * own side story and book edition, which Related had already claimed. The
   * discovery rows still share a scope, because a title appearing twice as a
   * suggestion is just a shorter list. */
  const byline = new Set<string>([self]);
  for (const r of relatedIds) if (SAME_WORK.has(r.relation)) byline.add(r.id);
  const discovery = new Set<string>([self]);

  /* Order matters: what MangaDex calls related is claimed by an editor, so it
     is spent first and a title in it never repeats further down the page. */
  const relation = new Map(relatedIds.map((r) => [r.id, r.relation]));
  const related = take(byRelation, discovery)
    .map((t) => ({ ...t, ...(relation.get(t.id) ? { relation: relation.get(t.id) } : {}) }));

  /* Resemblance, scored (scoreByTags): three shared tags is the floor, and
   * below it the row is better off not existing. */
  const scored = scoreByTags(byTags, mineTags);
  const similar = take({ data: scored.map((row: any) => row.item) }, discovery);

  return {
    matched: { id: self, title: pickTitle(manga.attributes) },
    ...(author?.attributes?.name
      ? {
          author: {
            id: String(author.id),
            name: String(author.attributes.name),
            series: take(byAuthor, byline),
            total: Number(byAuthor?.total ?? 0),
          },
        }
      : {}),
    ...(artist?.attributes?.name && artist.id !== author?.id
      ? {
          artist: {
            id: String(artist.id),
            name: String(artist.attributes.name),
            series: take(byArtist, byline),
            total: Number(byArtist?.total ?? 0),
          },
        }
      : {}),
    related,
    similar,
    similarBecause: ranked.slice(0, 3).map((t) => t.name),
    similarTotal: scored.length,
  };
}

/**
 * Everything MangaDex files under one person, as author and as artist.
 *
 * Two lists, because MangaDex takes the two roles as separate filters and
 * has no way to ask for either: the authored list leads and anything only
 * drawn follows it. A hundred of each is MangaDex's ceiling per request and
 * more than any bibliography in the catalogue needs, so there is no paging.
 * This is the page behind the arrow on a series page's "More from" row.
 */
export async function worksBy(
  { id, adult, origin }: { id: string; adult: boolean; origin: string },
): Promise<WorksAnswer | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const ratings = adult ? RATINGS_ADULT : RATINGS_SAFE;
  const list = (role: string) =>
    md(`/manga?${role}[]=${encodeURIComponent(id)}&order[followedCount]=desc&includes[]=cover_art&includes[]=author&limit=100${ratings}`);
  const [person, authored, drawn] = await Promise.all([
    md(`/author/${encodeURIComponent(id)}`),
    list('authors'),
    list('artists'),
  ]);
  if (!person && !authored && !drawn) return null;
  const spent = new Set<string>();
  const series = [
    ...takeTiles(authored, spent, 100, origin),
    ...takeTiles(drawn, spent, 100, origin),
  ];
  return {
    id,
    name: String(person?.data?.attributes?.name ?? ''),
    total: series.length,
    series,
  };
}

/**
 * Everything like this title, not just the first row of it.
 *
 * The resemblance relatedFor computes -- the most specific tags ANDed, then
 * Jaccard over the whole set with a floor of three -- over a pool of a
 * hundred rather than forty, handed back whole. Only a MangaDex id will do:
 * this is the page behind an arrow on a series page that already resolved
 * the title, so there is nothing left to guess at.
 */
export async function alikeFor(
  { id, adult, origin, limit = 60 }: { id: string; adult: boolean; origin: string; limit?: number },
): Promise<AlikeAnswer> {
  const empty: AlikeAnswer = { matched: null, because: [], similar: [] };
  if (!/^[0-9a-f-]{36}$/i.test(id)) return empty;
  const ratings = adult ? RATINGS_ADULT : RATINGS_SAFE;
  const found = await md(`/manga/${encodeURIComponent(id)}`);
  const manga = found?.data;
  if (!manga) return empty;

  const { ranked, mine } = rankTags(manga);
  const pool = await tagPool(ranked, ratings, 100);
  const scored = scoreByTags(pool, mine);
  /* This title, and everything MangaDex already relates to it: the sequel,
   * the colour edition, the spin-off belong in Related on the series page,
   * where the label says what they are. "Like this" is for titles that are
   * not this. */
  const spent = new Set<string>([String(manga.id)]);
  for (const r of manga.relationships ?? []) if (r.type === 'manga' && r.id) spent.add(String(r.id));
  return {
    matched: { id: String(manga.id), title: pickTitle(manga.attributes) },
    because: ranked.slice(0, 3).map((t) => t.name),
    similar: takeTiles({ data: scored.map((row) => row.item) }, spent, Math.max(1, Math.min(100, limit)), origin),
  };
}
