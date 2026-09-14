/**
 * The Suwayomi bridge, as a provider.
 *
 * Unchanged in behaviour from the original bridge -- the GraphQL calls and the
 * shapes they return are the same. What changed is its standing: Suwayomi is
 * now one optional provider among several rather than the source engine. When
 * it is unconfigured or offline, `suwayomiProvider()` returns null and the
 * catalog simply has one fewer provider to try.
 */
import { ExtensionError } from '../extensions/types';
import type { Chapter, Page, SearchResult, Series, SeriesSummary, YomuExtension } from '../extensions/types';

export interface SuwayomiEnv {
  SUWAYOMI_URL?: string;
  SUWAYOMI_AUTH_HEADER?: string;
}

type AnyObject = Record<string, any>;

export function normalizeBase(input?: string): string | null {
  if (!input?.trim()) return null;
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function suwayomiHeaders(env: SuwayomiEnv): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (env.SUWAYOMI_AUTH_HEADER?.trim()) headers.Authorization = env.SUWAYOMI_AUTH_HEADER.trim();
  return headers;
}

export async function suwayomiGraphQL<T = AnyObject>(env: SuwayomiEnv, query: string, variables: AnyObject = {}): Promise<T> {
  const base = normalizeBase(env.SUWAYOMI_URL);
  if (!base) throw new ExtensionError('Suwayomi is not configured. Set SUWAYOMI_URL on this Worker.', 'suwayomi', 'config');

  let response: Response;
  try {
    response = await fetch(`${base}/api/graphql`, {
      method: 'POST',
      headers: suwayomiHeaders(env),
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error: any) {
    throw new ExtensionError('Suwayomi is offline.', 'suwayomi', error?.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (!response.ok) throw new ExtensionError(`Suwayomi returned HTTP ${response.status}.`, 'suwayomi', 'http');

  const payload = (await response.json()) as AnyObject;
  if (payload.errors?.length && !payload.data) {
    throw new ExtensionError(payload.errors[0]?.message || 'Suwayomi rejected the request.', 'suwayomi', 'graphql');
  }
  return payload.data as T;
}

export const SOURCE_FIELDS = `
  id
  name
  displayName
  lang
  contentWarning
  supportsLatest
  iconUrl
  homeUrl
`;

export const MANGA_FIELDS = `
  id
  sourceId
  url
  title
  thumbnailUrl
  artist
  author
  description
  genre
  status
  initialized
  lastFetchedAt
  chaptersLastFetchedAt
`;

export const CHAPTER_FIELDS = `
  id
  name
  uploadDate
  chapterNumber
  scanlator
  mangaId
  sourceOrder
  pageCount
`;

export async function getSuwayomiSources(env: SuwayomiEnv): Promise<AnyObject[]> {
  const data = await suwayomiGraphQL<{ sources: { nodes: AnyObject[] } }>(
    env,
    `query YomuSources { sources(first: 500) { nodes { ${SOURCE_FIELDS} } } }`,
  );
  return data.sources?.nodes ?? [];
}

export async function fetchSourceManga(
  env: SuwayomiEnv,
  sourceId: string,
  type: 'POPULAR' | 'LATEST' | 'SEARCH',
  query = '',
  page = 1,
) {
  const data = await suwayomiGraphQL<{ fetchSourceManga: { mangas: AnyObject[]; hasNextPage: boolean } }>(
    env,
    `mutation YomuFetchSource($input: FetchSourceMangaInput!) {
      fetchSourceManga(input: $input) {
        mangas { ${MANGA_FIELDS} }
        hasNextPage
      }
    }`,
    { input: { source: sourceId, type, page, ...(type === 'SEARCH' ? { query } : {}) } },
  );
  return data.fetchSourceManga ?? { mangas: [], hasNextPage: false };
}

export async function fetchMangaAndChapters(env: SuwayomiEnv, mangaId: number) {
  const data = await suwayomiGraphQL<{ fetchMangaAndChapters: { manga: AnyObject; chapters: AnyObject[] } }>(
    env,
    `mutation YomuManga($input: FetchMangaAndChaptersInput!) {
      fetchMangaAndChapters(input: $input) {
        manga { ${MANGA_FIELDS} }
        chapters { ${CHAPTER_FIELDS} }
      }
    }`,
    { input: { id: mangaId, fetchManga: true, fetchChapters: true } },
  );
  if (!data.fetchMangaAndChapters?.manga) throw new ExtensionError('Suwayomi could not load that title.', 'suwayomi', 'parse');
  return data.fetchMangaAndChapters;
}

export async function fetchChapterPages(env: SuwayomiEnv, chapterId: number) {
  const data = await suwayomiGraphQL<{ fetchChapterPages: { pages: string[]; chapter: AnyObject } }>(
    env,
    `mutation YomuPages($input: FetchChapterPagesInput!) {
      fetchChapterPages(input: $input) {
        pages
        chapter { ${CHAPTER_FIELDS} }
      }
    }`,
    { input: { chapterId } },
  );
  if (!data.fetchChapterPages?.pages?.length) throw new ExtensionError('That chapter has no readable pages.', 'suwayomi', 'parse');
  return data.fetchChapterPages;
}

/** Is the bridge configured at all? Cheap: no network. */
export const suwayomiConfigured = (env: SuwayomiEnv): boolean => !!normalizeBase(env.SUWAYOMI_URL);

/**
 * Wrap one Suwayomi source as a provider. `imageUrl` turns a Suwayomi-relative
 * image path into a Yomu-proxied URL, since the app cannot reach the tunnel.
 */
export function suwayomiSourceProvider(
  env: SuwayomiEnv,
  sourceId: string,
  sourceName: string,
  imageUrl: (path: string) => string,
): YomuExtension {
  const toSummary = (m: AnyObject): SeriesSummary => {
    const updatedSec = Number(m.chaptersLastFetchedAt ?? m.lastFetchedAt ?? 0);
    return {
      id: String(m.id),
      title: m.title || 'Untitled',
      ...(m.author || m.artist ? { author: m.author || m.artist } : {}),
      ...(m.description ? { synopsis: String(m.description).slice(0, 2000) } : {}),
      ...(Array.isArray(m.genre) && m.genre.length ? { genres: m.genre } : {}),
      ...(m.status ? { status: String(m.status).toLowerCase() } : {}),
      ...(m.thumbnailUrl ? { cover: imageUrl(m.thumbnailUrl) } : {}),
      ...(updatedSec > 0 ? { updatedAt: updatedSec * 1000 } : {}),
    };
  };
  const toChapter = (c: AnyObject, i: number): Chapter => {
    const uploadSec = Number(c.uploadDate ?? 0);
    return {
      id: String(c.id),
      number: Number.isFinite(Number(c.chapterNumber)) ? Number(c.chapterNumber) : i + 1,
      name: c.name || `Chapter ${c.chapterNumber ?? i + 1}`,
      ...(Number(c.pageCount) ? { pageCount: Number(c.pageCount) } : {}),
      ...(uploadSec > 0 ? { publishedAt: uploadSec * 1000 } : {}),
      ...(c.scanlator ? { scanlator: String(c.scanlator) } : {}),
    };
  };

  const list = async (type: 'POPULAR' | 'LATEST' | 'SEARCH', query = '', page = 1): Promise<SearchResult> => {
    const result = await fetchSourceManga(env, sourceId, type, query, page);
    return { series: result.mangas.map(toSummary), hasNextPage: !!result.hasNextPage };
  };

  return {
    id: `suwayomi:${sourceId}`,
    name: sourceName,
    popular: (page = 1) => list('POPULAR', '', page),
    latest: (page = 1) => list('LATEST', '', page),
    search: (query: string, page = 1) => list('SEARCH', query, page),
    async getSeries(id: string): Promise<Series> {
      const detail = await fetchMangaAndChapters(env, Number(id));
      return { ...toSummary(detail.manga), id, chapters: detail.chapters.map(toChapter) };
    },
    async getChapters(id: string): Promise<Chapter[]> {
      const detail = await fetchMangaAndChapters(env, Number(id));
      return detail.chapters.map(toChapter);
    },
    async getPages(chapterId: string): Promise<Page[]> {
      const result = await fetchChapterPages(env, Number(chapterId));
      return result.pages.map((path: string, index: number) => ({
        key: `${chapterId}-${index}`,
        index,
        url: imageUrl(path),
      }));
    },
  };
}
