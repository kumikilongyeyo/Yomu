/**
 * The Yomu catalog.
 *
 * Everything above this line is a provider: native MangaDex, a Yomu extension,
 * or a Suwayomi bridge source. The catalog is what turns a pile of providers
 * into one browsable library -- it ranks them, tries them in order until one
 * answers, and merges the duplicates that inevitably come back when four sites
 * all carry the same title.
 *
 * The two rules that matter:
 *   - No single provider can break a request. Every call is isolated; a failure
 *     demotes that provider and the next one is tried.
 *   - Suwayomi is optional. When it is offline the catalog simply has fewer
 *     providers -- nothing else changes.
 */
import type { Chapter, Page, SeriesSummary, YomuExtension } from './extensions/types';
import { isLikelyDown, tracked, getHealth } from './extensions/health';

export type ProviderKind = 'native' | 'extension' | 'suwayomi';

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Lower runs first. */
  rank: number;
  extension: YomuExtension;
}

/**
 * Default preference: Yomu extensions first, then native MangaDex, then the
 * Suwayomi bridge. Extensions lead because they need no server of the user's
 * own; Suwayomi trails because it depends on a machine that may be off.
 */
export const DEFAULT_RANK: Record<ProviderKind, number> = {
  extension: 0,
  native: 100,
  suwayomi: 200,
};

export function orderProviders(providers: Provider[]): Provider[] {
  return [...providers].sort((a, b) => {
    // A provider that just failed goes last regardless of its configured rank.
    const downA = isLikelyDown(a.id) ? 1 : 0;
    const downB = isLikelyDown(b.id) ? 1 : 0;
    if (downA !== downB) return downA - downB;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name.localeCompare(b.name);
  });
}

export interface AttemptLog {
  provider: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface FallbackResult<T> {
  value: T | null;
  provider: Provider | null;
  attempts: AttemptLog[];
}

/**
 * Try providers in order until one produces an acceptable answer.
 * This is the whole fallback story: Source A fails -> Source B -> MangaDex ->
 * Suwayomi, and the reader still gets pages.
 */
export async function withFallback<T>(
  providers: Provider[],
  run: (provider: Provider) => Promise<T>,
  accept: (value: T) => boolean = (v) => v != null,
): Promise<FallbackResult<T>> {
  const attempts: AttemptLog[] = [];
  for (const provider of orderProviders(providers)) {
    const started = Date.now();
    try {
      const value = await tracked(provider.id, () => run(provider));
      if (accept(value)) {
        attempts.push({ provider: provider.id, ok: true, ms: Date.now() - started });
        return { value, provider, attempts };
      }
      attempts.push({ provider: provider.id, ok: false, error: 'returned nothing usable', ms: Date.now() - started });
    } catch (error: any) {
      attempts.push({
        provider: provider.id,
        ok: false,
        error: String(error?.message ?? error).slice(0, 200),
        ms: Date.now() - started,
      });
    }
  }
  return { value: null, provider: null, attempts };
}

/** Run every provider concurrently, keeping whatever succeeds. */
export async function fromAll<T>(
  providers: Provider[],
  run: (provider: Provider) => Promise<T>,
): Promise<Array<{ provider: Provider; value: T }>> {
  const settled = await Promise.allSettled(
    providers.map(async (provider) => ({ provider, value: await tracked(provider.id, () => run(provider)) })),
  );
  const out: Array<{ provider: Provider; value: T }> = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') out.push(result.value as { provider: Provider; value: T });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Deduplication
 * ------------------------------------------------------------------ */

const NOISE =
  /\b(the|a|an|of|and|manga|manhwa|manhua|webtoon|comic|official|colou?red?|color|season|part|vol(ume)?|novel|remake|fan\s?colou?red)\b/g;

/** Reduce a title to a comparison key: no punctuation, no format words, no case. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dice coefficient over bigrams: cheap, and forgiving of word-order noise. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let shared = 0;
  let total = 0;
  for (const n of A.values()) total += n;
  for (const [g, n] of B) {
    total += n;
    const inA = A.get(g);
    if (inA) shared += Math.min(inA, n);
  }
  return total ? (2 * shared) / total : 0;
}

export interface CatalogEntry extends SeriesSummary {
  /** Every provider that carries this title, best first. */
  providers: Array<{ id: string; name: string; kind: ProviderKind; seriesId: string }>;
}

const SIMILARITY_THRESHOLD = 0.87;

/** Strong identity: two records that share one of these are the same title. */
function hardKeys(s: SeriesSummary): string[] {
  const keys: string[] = [];
  if (s.anilistId) keys.push(`al:${s.anilistId}`);
  if (s.mangadexId) keys.push(`md:${s.mangadexId}`);
  return keys;
}

/**
 * Merge results from many providers into canonical Yomu titles.
 *
 * Matching is layered: an AniList/MangaDex id is conclusive; otherwise an exact
 * normalised-title match wins; otherwise a high bigram similarity, confirmed by
 * author or year when either side knows them, so "Nano Machine" and "Nano
 * Machine" merge while "Solo Leveling" and "Solo Leveling: Ragnarok" do not.
 */
export function dedupe(
  incoming: Array<{ provider: Provider; series: SeriesSummary[] }>,
): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const byHardKey = new Map<string, CatalogEntry>();
  const byExactTitle = new Map<string, CatalogEntry[]>();

  const attach = (entry: CatalogEntry, provider: Provider, s: SeriesSummary) => {
    // One entry per provider. A provider that lists several editions of the
    // same title contributes its best (first) one; otherwise a canonical title
    // grows a list of near-identical duplicates from a single source.
    if (!entry.providers.some((p) => p.id === provider.id)) {
      entry.providers.push({ id: provider.id, name: provider.name, kind: provider.kind, seriesId: s.id });
      entry.providers.sort((a, b) => DEFAULT_RANK[a.kind] - DEFAULT_RANK[b.kind]);
    }
    // Fill gaps from later providers without overwriting what we already have.
    entry.author ??= s.author;
    entry.synopsis ||= s.synopsis;
    entry.cover ??= s.cover;
    entry.category ??= s.category;
    entry.status ??= s.status;
    entry.year ??= s.year;
    entry.anilistId ??= s.anilistId;
    entry.mangadexId ??= s.mangadexId;
    if (s.genres?.length) entry.genres = [...new Set([...(entry.genres ?? []), ...s.genres])].slice(0, 30);
    if (s.altTitles?.length) entry.altTitles = [...new Set([...(entry.altTitles ?? []), ...s.altTitles])].slice(0, 16);
    if ((s.updatedAt ?? 0) > (entry.updatedAt ?? 0)) entry.updatedAt = s.updatedAt;
    for (const key of hardKeys(entry)) byHardKey.set(key, entry);
  };

  const compatible = (entry: CatalogEntry, s: SeriesSummary): boolean => {
    // If both sides know the author or the year, they must agree.
    if (entry.author && s.author) {
      const a = normalizeTitle(entry.author);
      const b = normalizeTitle(s.author);
      if (a && b && similarity(a, b) < 0.6) return false;
    }
    if (entry.year && s.year && Math.abs(entry.year - s.year) > 1) return false;
    return true;
  };

  for (const { provider, series } of incoming) {
    // Collapse a provider's own duplicates before comparing across providers.
    const seenInProvider = new Set<string>();
    const ownDeduped = series.filter((s) => {
      const key = normalizeTitle(s.title ?? '');
      if (!key || seenInProvider.has(key)) return false;
      seenInProvider.add(key);
      return true;
    });

    for (const s of ownDeduped) {
      if (!s.title) continue;

      const hard = hardKeys(s).map((k) => byHardKey.get(k)).find(Boolean);
      if (hard) {
        attach(hard, provider, s);
        continue;
      }

      const key = normalizeTitle(s.title);
      if (!key) continue;

      const exact = (byExactTitle.get(key) ?? []).find((e) => compatible(e, s));
      if (exact) {
        attach(exact, provider, s);
        continue;
      }

      // Fall back to fuzzy matching against titles and their alternates.
      let fuzzy: CatalogEntry | undefined;
      for (const candidate of entries) {
        if (!compatible(candidate, s)) continue;
        const names = [candidate.title, ...(candidate.altTitles ?? [])].map(normalizeTitle);
        const mine = [s.title, ...(s.altTitles ?? [])].map(normalizeTitle);
        if (names.some((n) => mine.some((m) => n === m || similarity(n, m) >= SIMILARITY_THRESHOLD))) {
          fuzzy = candidate;
          break;
        }
      }
      if (fuzzy) {
        attach(fuzzy, provider, s);
        continue;
      }

      const entry: CatalogEntry = { ...s, providers: [] };
      entries.push(entry);
      const bucket = byExactTitle.get(key) ?? [];
      bucket.push(entry);
      byExactTitle.set(key, bucket);
      attach(entry, provider, s);
    }
  }

  return entries;
}

/** Chapters for a title, taken from the first provider that has any. */
export async function chaptersWithFallback(
  providers: Provider[],
  seriesIdFor: (p: Provider) => string | undefined,
): Promise<FallbackResult<Chapter[]>> {
  const usable = providers.filter((p) => seriesIdFor(p));
  return withFallback<Chapter[]>(
    usable,
    (provider) => provider.extension.getChapters(seriesIdFor(provider)!),
    (chapters) => Array.isArray(chapters) && chapters.length > 0,
  );
}

export async function pagesWithFallback(
  providers: Provider[],
  chapterIdFor: (p: Provider) => string | undefined,
): Promise<FallbackResult<Page[]>> {
  const usable = providers.filter((p) => chapterIdFor(p));
  return withFallback<Page[]>(
    usable,
    (provider) => provider.extension.getPages(chapterIdFor(provider)!),
    (pages) => Array.isArray(pages) && pages.length > 0,
  );
}

export const providerHealth = getHealth;
