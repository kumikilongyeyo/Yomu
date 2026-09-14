/**
 * The Yomu extension contract.
 *
 * Every source -- native MangaDex, a Yomu extension, or a Suwayomi bridge
 * source -- is normalised into these types before the catalog or the app ever
 * sees it. Site-specific shapes stop here; nothing downstream knows which kind
 * of provider produced a record.
 */

export type ContentKind = 'manga' | 'manhwa' | 'manhua' | 'webtoon' | 'comic' | 'adult';

export const CONTENT_KINDS: ContentKind[] = ['manga', 'manhwa', 'manhua', 'webtoon', 'comic', 'adult'];

export interface SeriesSummary {
  id: string;
  title: string;
  author?: string;
  synopsis?: string;
  genres?: string[];
  category?: ContentKind;
  status?: string;
  cover?: string;
  updatedAt?: number;
  /** Cross-provider identity hints, used for deduplication. */
  altTitles?: string[];
  year?: number;
  anilistId?: string;
  mangadexId?: string;
}

export interface Chapter {
  id: string;
  number: number;
  name: string;
  pageCount?: number;
  publishedAt?: number;
  scanlator?: string;
}

export interface Series extends SeriesSummary {
  chapters?: Chapter[];
}

export interface Page {
  key: string;
  index: number;
  url: string;
}

export interface SearchResult {
  series: SeriesSummary[];
  hasNextPage?: boolean;
}

/**
 * What every adapter must provide. Declarative descriptors are compiled into
 * this shape by the runtime, so the rest of the Worker only ever talks to this
 * interface -- a future natively-bundled adapter can implement it directly.
 */
export interface YomuExtension {
  id: string;
  name: string;
  search(query: string, page?: number): Promise<SearchResult>;
  popular(page?: number): Promise<SearchResult>;
  latest(page?: number): Promise<SearchResult>;
  getSeries(id: string): Promise<Series>;
  getChapters(id: string): Promise<Chapter[]>;
  getPages(chapterId: string): Promise<Page[]>;
}

export type Capability = 'search' | 'popular' | 'latest' | 'details' | 'chapters' | 'pages';

export const CAPABILITIES: Capability[] = ['search', 'popular', 'latest', 'details', 'chapters', 'pages'];

/** One record in the repository's index.json. */
export interface RegistryEntry {
  id: string;
  name: string;
  version: number;
  language: string;
  content: ContentKind[];
  module: string;
  capabilities: Record<Capability, boolean>;
  /** Hosts the adapter is allowed to reach. Enforced by the runtime. */
  hosts?: string[];
  nsfw?: boolean;
  disabled?: boolean;
}

export interface RegistryIndex {
  schema: string;
  updatedAt?: string;
  extensions: RegistryEntry[];
}

export class ExtensionError extends Error {
  constructor(message: string, readonly extensionId?: string, readonly kind: string = 'extension') {
    super(message);
    this.name = 'ExtensionError';
  }
}
