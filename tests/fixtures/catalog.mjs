/**
 * Deterministic catalog fixtures.
 *
 * Every number the runtime gauntlet and the benchmark quote has to come from
 * the same generator on every run, on every machine, or "2x faster" means
 * nothing. Titles are synthetic on purpose: no live provider is contacted, so
 * a slow Saturday at Weeb Central cannot fail a release.
 */

export const SOURCE_IDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo',
  'foxtrot', 'golf', 'hotel', 'india', 'juliet',
  'namicomi',
];

export const PAGES_PER_SOURCE = 6;
export const PER_PAGE = 24;

const CATEGORIES = ['manga', 'manhwa', 'manhua'];
const STATUSES = ['ongoing', 'ongoing', 'ongoing', 'completed'];
const GENRES = [
  ['Action', 'Fantasy'],
  ['Romance', 'Drama'],
  ['Martial arts', 'Action'],
  ['Comedy', 'Slice of life'],
  ['Isekai', 'Fantasy'],
  ['Historical', 'Drama'],
];

const label = (id) => id === 'namicomi'
  ? 'NamiComi'
  : id.charAt(0).toUpperCase() + id.slice(1) + ' Comics';

/** Stable per (source, page, index) so a rerun compares like with like. */
function seriesFor(sourceId, page, index) {
  const ordinal = (page - 1) * PER_PAGE + index;
  const shared = ordinal % 7 === 0; // Appears on every source: dedupe fodder.
  const key = shared ? `Shared Saga ${ordinal}` : `${label(sourceId)} Tale ${ordinal}`;
  return {
    id: `${sourceId}-${ordinal}`,
    title: key,
    cover: `/fixtures/cover.svg?t=${encodeURIComponent(key)}`,
    category: CATEGORIES[ordinal % CATEGORIES.length],
    status: STATUSES[ordinal % STATUSES.length],
    genres: GENRES[ordinal % GENRES.length],
    year: 2016 + (ordinal % 9),
    updatedAt: 1_700_000_000_000 + ordinal * 60_000,
    nsfw: false,
  };
}

export function sourcePage(sourceId, page) {
  if (page > PAGES_PER_SOURCE) return [];
  return Array.from({ length: PER_PAGE }, (_, i) => seriesFor(sourceId, page, i));
}

export function searchPage(sourceId, query, page) {
  if (page > PAGES_PER_SOURCE) return [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return Array.from({ length: 6 }, (_, i) => {
    const row = seriesFor(sourceId, page, i);
    return { ...row, id: `${row.id}-q`, title: `${q} ${label(sourceId)} ${(page - 1) * 6 + i}` };
  });
}

export function extensions(origin) {
  return SOURCE_IDS.map((id) => ({
    id,
    name: label(id),
    api: `${origin}/api/ext/source/${id}/`,
    capabilities: { popular: true, latest: true, search: true, chapters: true, pages: true, details: true },
    nsfw: false,
    status: 'ok',
    language: 'en',
    version: 3,
  }));
}

/** The collection blob the app keeps in localStorage. */
export function collection(origin, { includeNami = true } = {}) {
  const sources = extensions(origin)
    .filter((ext) => includeNami || ext.id !== 'namicomi')
    .map((ext) => ({
      id: `yomuext-${ext.id}`,
      label: ext.name,
      name: ext.name,
      url: ext.api,
      kind: 'api',
      enabled: true,
      nsfw: false,
      capabilities: ext.capabilities,
    }));
  return { sources, library: [] };
}

/* --- AniList ------------------------------------------------------------- *
 *
 * The rails read graphql.anilist.co straight from the browser. The tests
 * intercept that origin and answer with this, so a rail's contents, its page
 * 2 and its failure mode are all decisions the test makes.
 */

export function anilistMedia(alias, page = 1, count = 14) {
  return Array.from({ length: count }, (_, i) => {
    const ordinal = (page - 1) * count + i;
    return {
      id: 900000 + ordinal + alias.length * 1000,
      title: { english: `${alias} pick ${ordinal}`, romaji: null, native: null },
      coverImage: { large: `/fixtures/cover.svg?t=${alias}-${ordinal}`, medium: null },
      genres: GENRES[ordinal % GENRES.length],
      averageScore: 90 - (ordinal % 25),
      popularity: 100000 - ordinal * 37,
      trending: 500 - ordinal,
      status: 'RELEASING',
      countryOfOrigin: ['JP', 'KR', 'CN'][ordinal % 3],
      startDate: { year: 2015 + (ordinal % 10) },
      tags: [{ name: 'Dungeon', rank: 80, isMediaSpoiler: false }],
    };
  });
}
