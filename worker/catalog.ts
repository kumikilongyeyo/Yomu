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
    // One provider rating a title adult is enough for the whole merged entry.
    if (s.nsfw) entry.nsfw = true;
    entry.status ??= s.status;
    entry.year ??= s.year;
    entry.anilistId ??= s.anilistId;
    entry.mangadexId ??= s.mangadexId;
    if (s.genres?.length) entry.genres = [...new Set([...(entry.genres ?? []), ...s.genres])].slice(0, 30);
    if (s.altTitles?.length) entry.altTitles = [...new Set([...(entry.altTitles ?? []), ...s.altTitles])].slice(0, 16);
    if ((s.updatedAt ?? 0) > (entry.updatedAt ?? 0)) entry.updatedAt = s.updatedAt;
    for (const key of hardKeys(entry)) byHardKey.set(key, entry);
  };

  /**
   * @param exactTitle the two records already agree on the normalised title.
   *
   * The author check exists to stop fuzzy matches collapsing distinct works
   * ("Solo Leveling" / "Solo Leveling: Ragnarok"). It must not arbitrate an
   * exact title match, because providers disagree about what "author" means --
   * MangaDex credits the publisher "Yuewen Manhua" for the same title Flame
   * Comics credits to "Little Bleary Zhao", and the veto split one work into
   * two results. Year still applies: it is a fact both sides measure the same
   * way.
   */
  const compatible = (entry: CatalogEntry, s: SeriesSummary, exactTitle = false): boolean => {
    if (!exactTitle && entry.author && s.author) {
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

      const exact = (byExactTitle.get(key) ?? []).find((e) => compatible(e, s, true));
      if (exact) {
        attach(exact, provider, s);
        continue;
      }

      // Fall back to matching against titles and their alternates. An exact
      // hit on any name pair counts as an exact title match even when it lands
      // on an alternate: MangaDex files Solo Leveling under "Na Honjaman
      // Level-Up" with "Solo Leveling" as an alternate, and crediting Chugong
      // where the scanlation sites credit someone else must not split it off.
      let fuzzy: CatalogEntry | undefined;
      const mine = [s.title, ...(s.altTitles ?? [])].map(normalizeTitle).filter(Boolean);
      for (const candidate of entries) {
        const names = [candidate.title, ...(candidate.altTitles ?? [])].map(normalizeTitle).filter(Boolean);
        const exactName = names.some((n) => mine.includes(n));
        if (!exactName && !names.some((n) => mine.some((m) => similarity(n, m) >= SIMILARITY_THRESHOLD))) continue;
        if (!compatible(candidate, s, exactName)) continue;
        fuzzy = candidate;
        break;
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

/**
 * How well a merged title answers the query, 0..1.
 *
 * Providers each return their own idea of "relevant", and merging them without
 * re-ranking leaves one source's loose matches sitting above the title the
 * reader actually typed. Scored against the title and its alternates, so a
 * match on a romanised or localised name counts.
 */
export function relevance(entry: CatalogEntry, query: string): number {
  const q = normalizeTitle(query);
  if (!q) return 0;
  let best = 0;
  for (const name of [entry.title, ...(entry.altTitles ?? [])]) {
    const n = normalizeTitle(name ?? '');
    if (!n) continue;
    const score =
      n === q ? 1
      : n.startsWith(q) || q.startsWith(n) ? Math.max(0.9, similarity(n, q))
      : n.includes(q) ? Math.max(0.8, similarity(n, q))
      : similarity(n, q);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Order search results by what was asked for, then by corroboration.
 *
 * Relevance leads, so the title the reader typed is first whichever provider
 * happened to answer soonest. Provider count only breaks ties, which is what
 * puts the copy carried by three sources above an equally-named one carried by
 * one -- without letting a well-stocked title outrank a better match.
 */
export function rankByRelevance(entries: CatalogEntry[], query: string): CatalogEntry[] {
  return entries
    .map((entry) => ({ entry, score: relevance(entry, query) }))
    .sort((a, b) =>
      b.score - a.score ||
      b.entry.providers.length - a.entry.providers.length ||
      a.entry.title.localeCompare(b.entry.title))
    .map(({ entry }) => entry);
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

/* ------------------------------------------------------------------ *
 * The chapter ledger
 *
 * One row per chapter NUMBER, carrying every source that has it -- the
 * opposite question to chaptersWithFallback, which answers "who can give me
 * this chapter" and stops at the first yes. That is right for opening a
 * chapter and useless for showing a reader that the one their source is
 * missing exists on two others.
 *
 * chaptersWithFallback is deliberately untouched. It is on the path every
 * existing screen takes, and turning it into a merge would slow all of them
 * and change fallback semantics for the reader.
 *
 * The merge is the part that decides whether any of this works, so the rules
 * are conservative and every one of them is a decision not to guess:
 *
 *   exact number match merges        57 and 57 are one chapter
 *   decimals are their own chapters  57 and 57.5 never merge; a .5 is a side
 *                                    story and readers treat it as one
 *   no tolerance window              a source off by one against another is a
 *                                    labelling disagreement this cannot
 *                                    resolve, and guessing produces a row
 *                                    whose chips open two different chapters
 *   unnumbered keeps its own row     prologues and specials, sorted together
 *
 * Determinism matters more than it looks: two devices fetching the same
 * ledger must render identical rows, or sync will look broken later. So no
 * clock in the ordering, no random tie-break, and no reliance on Map
 * iteration order for anything that reaches the output.
 * ------------------------------------------------------------------ */

export interface LedgerRelease {
  providerId: string;
  providerName: string;
  kind: ProviderKind;
  seriesId: string;
  chapterId: string;
  name: string;
  pageCount?: number;
  publishedAt?: number;
  scanlator?: string;
}

export interface LedgerRow {
  number: number;
  /** Derived from the number, never reformatted away: 57.1 stays "57.1". */
  label: string;
  name: string;
  publishedAt?: number;
  releases: LedgerRelease[];
}

export interface LedgerGap {
  fromNumber: number;
  toNumber: number;
  missingFrom: string;
  availableFrom: string[];
}

export interface LedgerSource {
  providerId: string;
  providerName: string;
  kind: ProviderKind;
  seriesId: string;
  chapterCount: number;
  ok: boolean;
  error?: string;
}

export interface Ledger {
  rows: LedgerRow[];
  gaps: LedgerGap[];
  sources: LedgerSource[];
  partial: boolean;
  truncated?: boolean;
  generatedAt: number;
}

/** Kills float noise: 57.30000000000001 and 57.3 are the same chapter. */
export const mergeKey = (n: number): number => Math.round(n * 1000) / 1000;

const UNNUMBERED = Number.NEGATIVE_INFINITY;

/** A leading "Ch. 57 - " and friends. The row prints the number in its own
 *  column, so repeating it in the name is noise. */
const DESIGNATOR = /^\s*(ch(apter)?\.?\s*)?\d+(\.\d+)?\s*[-–—:]?\s*/i;

function meaningfulName(raw: string | undefined, label: string): string {
  const stripped = String(raw ?? '').replace(DESIGNATOR, '').trim();
  if (!stripped) return '';
  // "57" as a name is the number again, which the row already shows.
  if (stripped === label) return '';
  return stripped;
}

export const LEDGER_ROW_CAP = 2000;
export const LEDGER_PROVIDER_CAP = 8;
export const LEDGER_TIMEOUT_MS = 6000;

/**
 * Chapters from every provider at once.
 *
 * Not built on fromAll(), which keeps only the fulfilled results -- the
 * failures are exactly what a partial ledger has to report, by name, so the
 * reader can be told which source is missing rather than that "something"
 * went wrong.
 */
export async function chapterLedger(
  providers: Provider[],
  seriesIdFor: (p: Provider) => string | undefined,
  preferredId?: string,
): Promise<Ledger> {
  const usable = orderProviders(providers.filter((p) => seriesIdFor(p))).slice(0, LEDGER_PROVIDER_CAP);

  const settled = await Promise.all(usable.map(async (provider) => {
    const seriesId = seriesIdFor(provider)!;
    // A bare Promise.race would leave the losing fetch running against a
    // home server that is already too slow; an abort actually stops it.
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), LEDGER_TIMEOUT_MS);
    try {
      const chapters = await tracked(provider.id, () =>
        Promise.race([
          provider.extension.getChapters(seriesId),
          new Promise<never>((_, reject) => {
            stop.signal.addEventListener('abort', () =>
              reject(new Error(`Timed out after ${LEDGER_TIMEOUT_MS}ms`)), { once: true });
          }),
        ]));
      return { provider, seriesId, chapters: Array.isArray(chapters) ? chapters : [], error: undefined };
    } catch (error: any) {
      return { provider, seriesId, chapters: [] as Chapter[], error: String(error?.message ?? 'unavailable') };
    } finally {
      clearTimeout(timer);
    }
  }));

  const sources: LedgerSource[] = settled.map(({ provider, seriesId, chapters, error }) => ({
    providerId: provider.id,
    providerName: provider.name,
    kind: provider.kind,
    seriesId,
    chapterCount: chapters.length,
    ok: !error,
    ...(error ? { error } : {}),
  }));

  const preferred = preferredId && settled.some((s) => s.provider.id === preferredId)
    ? preferredId
    : usable[0]?.id;

  /* --- group by number ------------------------------------------------- */

  const byNumber = new Map<number, LedgerRelease[]>();
  const unnumbered: LedgerRelease[] = [];

  for (const { provider, seriesId, chapters } of settled) {
    for (const chapter of chapters) {
      if (!chapter || typeof chapter.id !== 'string') continue;
      const release: LedgerRelease = {
        providerId: provider.id,
        providerName: provider.name,
        kind: provider.kind,
        seriesId,
        chapterId: chapter.id,
        name: String(chapter.name ?? ''),
        ...(typeof chapter.pageCount === 'number' ? { pageCount: chapter.pageCount } : {}),
        ...(typeof chapter.publishedAt === 'number' ? { publishedAt: chapter.publishedAt } : {}),
        ...(chapter.scanlator ? { scanlator: chapter.scanlator } : {}),
      };
      const raw = Number(chapter.number);
      if (!Number.isFinite(raw) || raw <= 0) { unnumbered.push(release); continue; }
      const key = mergeKey(raw);
      const bucket = byNumber.get(key);
      if (bucket) bucket.push(release); else byNumber.set(key, [release]);
    }
  }

  /* --- order releases within a row -------------------------------------- */

  const rankOf = (release: LedgerRelease) => {
    if (release.providerId === preferred) return -1;
    return DEFAULT_RANK[release.kind] ?? 999;
  };
  const orderReleases = (releases: LedgerRelease[]) =>
    [...releases].sort((a, b) => {
      const downA = isLikelyDown(a.providerId) ? 1 : 0;
      const downB = isLikelyDown(b.providerId) ? 1 : 0;
      if (downA !== downB) return downA - downB;
      const rankA = rankOf(a), rankB = rankOf(b);
      if (rankA !== rankB) return rankA - rankB;
      if (a.providerName !== b.providerName) return a.providerName.localeCompare(b.providerName);
      // Last resort, and it has to be total: two releases from one provider on
      // one chapter must still order the same way on every device.
      return a.chapterId.localeCompare(b.chapterId);
    });

  const buildRow = (number: number, releases: LedgerRelease[]): LedgerRow => {
    const ordered = orderReleases(releases);
    const label = number === UNNUMBERED ? '' : String(number);
    let name = '';
    for (const release of ordered) {
      name = meaningfulName(release.name, label);
      if (name) break;
    }
    const dates = ordered.map((r) => r.publishedAt).filter((d): d is number => typeof d === 'number');
    return {
      number,
      label,
      name,
      ...(dates.length ? { publishedAt: Math.min(...dates) } : {}),
      releases: ordered,
    };
  };

  // Sorted from the numbers themselves, never from Map insertion order.
  const numbers = [...byNumber.keys()].sort((a, b) => b - a);
  const rows: LedgerRow[] = numbers.map((n) => buildRow(n, byNumber.get(n)!));

  // Unnumbered chapters keep their own rows, grouped, and sort to the bottom
  // of a newest-first list. Their label comes from the name, since there is no
  // number to print.
  for (const release of orderReleases(unnumbered)) {
    rows.push({
      number: UNNUMBERED,
      label: '',
      name: meaningfulName(release.name, '') || 'Extra',
      ...(typeof release.publishedAt === 'number' ? { publishedAt: release.publishedAt } : {}),
      releases: [release],
    });
  }

  const truncated = rows.length > LEDGER_ROW_CAP;
  const kept = truncated ? rows.slice(0, LEDGER_ROW_CAP) : rows;

  return {
    rows: kept,
    gaps: preferred ? findGaps(kept, preferred) : [],
    sources,
    partial: sources.some((s) => !s.ok),
    ...(truncated ? { truncated: true } : {}),
    generatedAt: Date.now(),
  };
}

/**
 * Runs of chapters the preferred source does not have.
 *
 * Relative to the preferred source and nothing else. Against "all sources" it
 * would mark half the list, which is noise rather than information.
 *
 * A gap at the end -- the preferred source stopped at 58 and others carry on
 * -- is a gap like any other, and it is the most useful one there is, so it is
 * deliberately not special-cased away. Numbers nobody has are not gaps: the
 * ledger cannot know chapter 40 exists if no source lists it, and scanlation
 * numbering legitimately skips.
 */
export function findGaps(rows: LedgerRow[], preferred: string): LedgerGap[] {
  const numbered = rows
    .filter((row) => Number.isFinite(row.number))
    .sort((a, b) => a.number - b.number);

  const gaps: LedgerGap[] = [];
  let run: LedgerRow[] = [];

  const flush = () => {
    if (!run.length) return;
    const providers: string[] = [];
    for (const row of run) {
      for (const release of row.releases) {
        if (!providers.includes(release.providerId)) providers.push(release.providerId);
      }
    }
    gaps.push({
      fromNumber: run[0].number,
      toNumber: run[run.length - 1].number,
      missingFrom: preferred,
      availableFrom: providers,
    });
    run = [];
  };

  for (const row of numbered) {
    if (row.releases.some((r) => r.providerId === preferred)) flush();
    else run.push(row);
  }
  flush();
  return gaps;
}
