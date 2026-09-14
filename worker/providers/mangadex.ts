/**
 * MangaDex as a native Yomu provider.
 *
 * This is additive: the existing `/api/md/*` relay the app already uses is
 * untouched. What this adds is a server-side MangaDex that speaks the same
 * YomuExtension contract as everything else, so the catalog can rank it, fall
 * back to it, and merge its titles with extension results. MangaDex stays
 * native rather than becoming a descriptor because it needs real logic --
 * relationship flattening, per-chapter at-home server lookups -- that a
 * declarative adapter should not have to express.
 */
import { ExtensionError } from '../extensions/types';
import type { Chapter, Page, SearchResult, Series, SeriesSummary, YomuExtension } from '../extensions/types';

const API = 'https://api.mangadex.org';
const UPLOADS = 'https://uploads.mangadex.org';
const TIMEOUT_MS = 12_000;

const LANG_TO_CATEGORY: Record<string, SeriesSummary['category']> = {
  ko: 'manhwa',
  zh: 'manhua',
  'zh-hk': 'manhua',
  ja: 'manga',
};

async function md<T = any>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Yomu/0.3 (personal reader)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error: any) {
    const timedOut = error?.name === 'TimeoutError';
    throw new ExtensionError(timedOut ? 'MangaDex timed out.' : 'MangaDex is unreachable.', 'mangadex', timedOut ? 'timeout' : 'network');
  }
  if (!response.ok) throw new ExtensionError(`MangaDex returned HTTP ${response.status}.`, 'mangadex', 'http');
  return (await response.json()) as T;
}

const pickTitle = (attr: any): string => {
  const t = attr?.title ?? {};
  return t.en ?? t['ja-ro'] ?? t.ja ?? (Object.values(t)[0] as string) ?? 'Untitled';
};

const altTitles = (attr: any): string[] =>
  (attr?.altTitles ?? [])
    .flatMap((entry: any) => Object.values(entry ?? {}))
    .filter((v: any): v is string => typeof v === 'string')
    .slice(0, 12);

function toSummary(item: any): SeriesSummary {
  const attr = item.attributes ?? {};
  const rels: any[] = item.relationships ?? [];
  const cover = rels.find((r) => r.type === 'cover_art')?.attributes?.fileName;
  const author = rels.find((r) => r.type === 'author')?.attributes?.name;
  const genres = (attr.tags ?? [])
    .map((t: any) => t?.attributes?.name?.en)
    .filter((n: any): n is string => typeof n === 'string');
  const year = Number(attr.year);
  const alts = altTitles(attr);
  return {
    id: String(item.id),
    title: pickTitle(attr),
    ...(author ? { author } : {}),
    ...(attr.description?.en ? { synopsis: String(attr.description.en).slice(0, 2000) } : {}),
    ...(genres.length ? { genres } : {}),
    ...(LANG_TO_CATEGORY[attr.originalLanguage] ? { category: LANG_TO_CATEGORY[attr.originalLanguage] } : {}),
    ...(attr.status ? { status: String(attr.status) } : {}),
    ...(cover ? { cover: `${UPLOADS}/covers/${item.id}/${cover}.512.jpg` } : {}),
    ...(Number.isFinite(year) && year > 0 ? { year } : {}),
    ...(alts.length ? { altTitles: alts } : {}),
    ...(attr.updatedAt && Date.parse(attr.updatedAt) ? { updatedAt: Date.parse(attr.updatedAt) } : {}),
    ...(/^(erotica|pornographic)$/i.test(String(attr.contentRating ?? '')) ? { nsfw: true } : {}),
    mangadexId: String(item.id),
  };
}

/**
 * MangaDex rates every title, so the adult gate here is a filter rather than a
 * guess: with the gate closed Yomu asks only for safe and suggestive, and the
 * erotica and pornographic ratings never leave MangaDex.
 */
const RATINGS_SAFE = '&contentRating[]=safe&contentRating[]=suggestive';
const RATINGS_ADULT = RATINGS_SAFE + '&contentRating[]=erotica&contentRating[]=pornographic';
const listQs = (adult: boolean) =>
  `includes[]=cover_art&includes[]=author&limit=32${adult ? RATINGS_ADULT : RATINGS_SAFE}`;

export function createMangadexProvider(adult = false): YomuExtension {
  const LIST_QS = listQs(adult);
  const provider: YomuExtension = {
  id: 'mangadex',
  name: 'MangaDex',

  async popular(page = 1): Promise<SearchResult> {
    const data = await md(`/manga?${LIST_QS}&offset=${(page - 1) * 32}&order[followedCount]=desc`);
    return { series: (data.data ?? []).map(toSummary), hasNextPage: (data.data ?? []).length > 0 };
  },

  async latest(page = 1): Promise<SearchResult> {
    const data = await md(`/manga?${LIST_QS}&offset=${(page - 1) * 32}&order[latestUploadedChapter]=desc`);
    return { series: (data.data ?? []).map(toSummary), hasNextPage: (data.data ?? []).length > 0 };
  },

  async search(query: string, page = 1): Promise<SearchResult> {
    const data = await md(`/manga?${LIST_QS}&offset=${(page - 1) * 32}&title=${encodeURIComponent(query)}`);
    return { series: (data.data ?? []).map(toSummary), hasNextPage: (data.data ?? []).length > 0 };
  },

  async getSeries(id: string): Promise<Series> {
    const data = await md(`/manga/${encodeURIComponent(id)}?includes[]=cover_art&includes[]=author&includes[]=artist`);
    if (!data?.data) throw new ExtensionError('MangaDex could not load that title.', 'mangadex', 'parse');
    return { ...toSummary(data.data), chapters: await provider.getChapters(id) };
  },

  async getChapters(id: string): Promise<Chapter[]> {
    // 500 is MangaDex's page size, not a title's chapter count. Read once and a
    // long-running series is silently truncated -- Martial Peak has 3,918
    // English chapters and came back with 500, so the newest 3,418 simply did
    // not exist as far as Yomu was concerned. Paged until the feed runs out,
    // with a ceiling so one pathological title cannot spend the whole request
    // budget.
    const PAGE = 500;
    const MAX_CHAPTERS = 5000;
    const rows: any[] = [];
    for (let offset = 0; offset < MAX_CHAPTERS; offset += PAGE) {
      const qs =
        `translatedLanguage[]=en&order[chapter]=asc&limit=${PAGE}&offset=${offset}` +
        (adult ? RATINGS_ADULT : RATINGS_SAFE);
      const page = await md(`/manga/${encodeURIComponent(id)}/feed?${qs}`);
      const batch = page.data ?? [];
      rows.push(...batch);
      if (batch.length < PAGE) break;
      // `total` is authoritative when present; without it the short page above
      // is what ends the loop.
      if (Number.isFinite(page.total) && rows.length >= page.total) break;
    }

    const data = { data: rows };
    return (data.data ?? [])
      .map((c: any, index: number) => {
        const attr = c.attributes ?? {};
        const number = Number(attr.chapter);
        return {
          id: String(c.id),
          number: Number.isFinite(number) ? number : index + 1,
          name: attr.title ? String(attr.title) : `Chapter ${attr.chapter ?? index + 1}`,
          ...(Number(attr.pages) ? { pageCount: Number(attr.pages) } : {}),
          ...(attr.publishAt && Date.parse(attr.publishAt) ? { publishedAt: Date.parse(attr.publishAt) } : {}),
        } as Chapter;
      })
      .filter((c: Chapter) => !!c.id);
  },

  async getPages(chapterId: string): Promise<Page[]> {
    const data = await md(`/at-home/server/${encodeURIComponent(chapterId)}`);
    const base = data?.baseUrl;
    const hash = data?.chapter?.hash;
    const files: string[] = data?.chapter?.data ?? [];
    if (!base || !hash || !files.length) throw new ExtensionError('That chapter has no readable pages.', 'mangadex', 'parse');
    return files.map((file, index) => ({ key: `${chapterId}-${index}`, index, url: `${base}/data/${hash}/${file}` }));
  },
  };
  return provider;
}

/** The safe-by-default instance. Adult listings need createMangadexProvider(true). */
export const mangadexProvider: YomuExtension = createMangadexProvider(false);
