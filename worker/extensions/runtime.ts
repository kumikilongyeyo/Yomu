/**
 * Compiles a declarative adapter descriptor into a live YomuExtension.
 *
 * Nothing here executes adapter-supplied code. A descriptor can only say
 * "fetch this URL shape, then read these paths/selectors out of the answer",
 * and every one of those steps is bounded: the host must be on the adapter's
 * own declared allowlist, the request is time-boxed, the response is size-
 * capped, and any failure is converted into an ExtensionError that the catalog
 * can route around.
 */
import { ExtensionError } from './types';
import type { Chapter, Page, Series, SeriesSummary, SearchResult, YomuExtension, ContentKind } from './types';
import { CONTENT_KINDS } from './types';
import { applyTransforms, asNumber, asString, asStringArray, fillTemplate, readPath, resolveField } from './expr';
import type { FieldSpec } from './expr';
import { extractHtml } from './html';

export const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 6_000_000;
const MAX_LIST_ITEMS = 200;

/**
 * A declarative predicate. Deliberately not an expression language: a fixed set
 * of comparisons, each against one field, so filtering can never become a way
 * to smuggle logic in.
 */
export interface FilterSpec {
  field: string;
  contains?: string;
  equals?: string;
  matches?: string;
  exists?: boolean;
  notEmpty?: boolean;
  caseInsensitive?: boolean;
  negate?: boolean;
}

export interface ParseSpec {
  type: 'json' | 'html';
  /** Cap on records; chapter lists need more than the default. */
  limit?: number;
  /** Records must satisfy every filter to survive. */
  filter?: FilterSpec[];
  /** Pull a JSON blob out of an HTML page (e.g. `__NEXT_DATA__`) before parsing. */
  extract?: { regex: string; group?: number };
  list?: string;
  fields: Record<string, FieldSpec>;
  chapters?: { list: string; fields: Record<string, FieldSpec> };
}

/** Declarative arithmetic, so a descriptor can turn a page number into an offset. */
export interface VarSpec {
  from: string;
  plus?: number;
  minus?: number;
  times?: number;
}

export interface EndpointSpec {
  path: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  /** Derived request variables, usable as `{{name}}` in path/query/body. */
  vars?: Record<string, VarSpec>;
  /**
   * Request chaining: run this first and expose its first record's fields as
   * variables to the main request. One level only -- enough to turn a slug into
   * an id, or fetch a token, without letting a descriptor build a crawler.
   */
  before?: {
    path: string;
    method?: 'GET' | 'POST';
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: string;
    parse: ParseSpec;
    /** Prefix for the variables it contributes, default `chain`. */
    as?: string;
  };
  /** Edge cache lifetime for this endpoint, seconds. */
  cacheTtl?: number;
  parse: ParseSpec;
}

function deriveVars(ep: EndpointSpec, vars: Record<string, string | number | undefined>): Record<string, string | number | undefined> {
  if (!ep.vars) return vars;
  const out = { ...vars };
  for (const [name, spec] of Object.entries(ep.vars)) {
    const base = Number(vars[spec.from]);
    if (!Number.isFinite(base)) continue;
    let n = base;
    if (spec.minus != null) n -= spec.minus;
    if (spec.plus != null) n += spec.plus;
    if (spec.times != null) n *= spec.times;
    out[name] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

export interface Descriptor {
  id: string;
  name: string;
  version: number;
  language: string;
  content: ContentKind[];
  base: string;
  hosts: string[];
  nsfw?: boolean;
  headers?: Record<string, string>;
  /** Fallback content kind when a title carries no format of its own. */
  defaultCategory?: ContentKind;
  /** Per-source request timeout in ms (clamped to a sane ceiling). */
  timeoutMs?: number;
  /** Politeness limit, applied per isolate. */
  rateLimit?: { requests: number; perSeconds: number };
  endpoints: {
    popular?: EndpointSpec;
    latest?: EndpointSpec;
    search?: EndpointSpec;
    series?: EndpointSpec;
    chapters?: EndpointSpec;
    pages?: EndpointSpec;
  };
}

const USER_AGENT = 'Mozilla/5.0 (compatible; Yomu/0.3; +https://yomu.yomuread.workers.dev)';

/**
 * Per-source rate limiting, isolate-local. Not a global guarantee -- Workers
 * run many isolates -- but it stops one Yomu request fanning out into a burst
 * against a small scanlation site, which is the case that actually matters.
 */
const rateState = new Map<string, { windowStart: number; count: number }>();

async function rateLimit(d: Descriptor): Promise<void> {
  const limit = d.rateLimit;
  if (!limit || limit.requests <= 0 || limit.perSeconds <= 0) return;
  const windowMs = limit.perSeconds * 1000;
  const now = Date.now();
  const state = rateState.get(d.id) ?? { windowStart: now, count: 0 };
  if (now - state.windowStart >= windowMs) {
    state.windowStart = now;
    state.count = 0;
  }
  if (state.count >= limit.requests) {
    const wait = Math.min(windowMs - (now - state.windowStart), 2000);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    state.windowStart = Date.now();
    state.count = 0;
  }
  state.count += 1;
  rateState.set(d.id, state);
}

function passesFilters(record: Record<string, unknown>, filters: FilterSpec[] | undefined, vars: Record<string, string | number | undefined>): boolean {
  if (!filters?.length) return true;
  for (const f of filters) {
    const rawValue = record[f.field];
    const value = Array.isArray(rawValue) ? rawValue.join(' ') : rawValue == null ? '' : String(rawValue);
    const fold = (s: string) => (f.caseInsensitive === false ? s : s.toLowerCase());
    let ok = true;
    if (f.exists != null) ok = (value !== '') === f.exists;
    else if (f.notEmpty) ok = value.trim() !== '';
    else if (f.equals != null) ok = fold(value) === fold(fillTemplate(f.equals, vars));
    else if (f.contains != null) {
      const needle = fold(fillTemplate(f.contains, vars)).trim();
      ok = needle === '' || fold(value).includes(needle);
    } else if (f.matches != null) {
      try {
        ok = new RegExp(f.matches, f.caseInsensitive === false ? '' : 'i').test(value);
      } catch {
        ok = true; // a broken pattern must not silently empty a listing
      }
    }
    if (f.negate) ok = !ok;
    if (!ok) return false;
  }
  return true;
}

function hostAllowed(url: URL, hosts: string[]): boolean {
  const h = url.hostname.toLowerCase();
  return hosts.some((allowed) => {
    const a = allowed.toLowerCase().replace(/^\*\./, '');
    return h === a || h.endsWith(`.${a}`);
  });
}

/** Build the request URL for an endpoint, refusing anything off the allowlist. */
function buildUrl(d: Descriptor, ep: EndpointSpec, vars: Record<string, string | number | undefined>): URL {
  const path = fillTemplate(ep.path, vars);
  let url: URL;
  try {
    url = new URL(path, d.base);
  } catch {
    throw new ExtensionError('Adapter produced an invalid URL.', d.id, 'descriptor');
  }
  for (const [key, raw] of Object.entries(ep.query ?? {})) {
    const value = fillTemplate(raw, vars);
    if (value !== '') url.searchParams.set(key, value);
  }
  if (url.protocol !== 'https:') throw new ExtensionError('Adapters may only use https.', d.id, 'policy');
  if (!hostAllowed(url, d.hosts)) {
    throw new ExtensionError(`Adapter tried to reach ${url.hostname}, which it did not declare.`, d.id, 'policy');
  }
  return url;
}

async function request(d: Descriptor, ep: EndpointSpec, rawVars: Record<string, string | number | undefined>): Promise<Response> {
  const vars = deriveVars(ep, rawVars);
  const url = buildUrl(d, ep, vars);
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: ep.parse.type === 'json' ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${new URL(d.base).origin}/`,
    ...(d.headers ?? {}),
    ...(ep.headers ?? {}),
  };

  const timeoutMs = Math.min(Math.max(d.timeoutMs ?? REQUEST_TIMEOUT_MS, 1000), 20_000);
  await rateLimit(d);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: ep.method ?? 'GET',
      headers,
      body: ep.body ? fillTemplate(ep.body, vars) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      cf: { cacheEverything: true, cacheTtl: Math.min(Math.max(ep.cacheTtl ?? 300, 0), 86_400) },
    } as RequestInit);
  } catch (error: any) {
    const timedOut = error?.name === 'TimeoutError' || /timeout|aborted/i.test(String(error?.message));
    throw new ExtensionError(
      timedOut ? `${d.name} did not answer within ${timeoutMs / 1000}s.` : `${d.name} is unreachable.`,
      d.id,
      timedOut ? 'timeout' : 'network',
    );
  }

  // A redirect must not be able to walk the adapter off its own allowlist.
  try {
    const finalUrl = new URL(response.url || url.toString());
    if (!hostAllowed(finalUrl, d.hosts)) {
      throw new ExtensionError(`${d.name} redirected to an undeclared host.`, d.id, 'policy');
    }
  } catch (e) {
    if (e instanceof ExtensionError) throw e;
  }

  if (response.status === 403 || response.status === 401) {
    // Anti-bot or auth wall. Yomu does not attempt to defeat either.
    throw new ExtensionError(`${d.name} refused the request (${response.status}).`, d.id, 'blocked');
  }
  if (!response.ok) throw new ExtensionError(`${d.name} returned HTTP ${response.status}.`, d.id, 'http');

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) {
    throw new ExtensionError(`${d.name} returned an oversized response.`, d.id, 'size');
  }
  return response;
}

/** Turn one endpoint response into a list of flat records. */
async function readRecords(
  d: Descriptor,
  ep: EndpointSpec,
  response: Response,
  vars: Record<string, string | number | undefined> = {},
): Promise<Record<string, unknown>[]> {
  const spec = ep.parse;
  if (spec.type === 'html' && !spec.extract) {
    const rows = (await extractHtml(
      response,
      { list: spec.list, fields: spec.fields, limit: spec.limit },
      d.base,
      vars,
    )) as Record<string, unknown>[];
    return rows.filter((record) => passesFilters(record, spec.filter, vars));
  }

  const text = (await response.text()).slice(0, MAX_RESPONSE_BYTES);
  let payload: unknown;
  if (spec.extract) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(spec.extract.regex, 's');
    } catch {
      throw new ExtensionError('Adapter carries an invalid extract pattern.', d.id, 'descriptor');
    }
    const m = re.exec(text);
    if (!m) throw new ExtensionError(`${d.name} page did not contain the expected data block.`, d.id, 'parse');
    payload = safeJson(m[spec.extract.group ?? 1], d);
  } else {
    payload = safeJson(text, d);
  }

  const listed = spec.list ? readPath(payload, spec.list) : payload;
  const cap = Math.min(spec.limit ?? MAX_LIST_ITEMS, 3000);
  // A payload may present a list as an array or, as some sites do, as an object
  // keyed by index. Both are lists as far as an adapter is concerned.
  const rows = Array.isArray(listed)
    ? listed.slice(0, cap)
    : listed && typeof listed === 'object' && spec.list
      ? Object.values(listed as Record<string, unknown>).slice(0, cap)
      : [listed];
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(spec.fields)) {
      if (field.template == null) out[name] = resolveField(field, row, out, d.base, payload);
    }
    // Templates read request variables as well as sibling fields, so a page URL
    // can be built from the chapter id that was asked for.
    const bag = { ...vars, ...out };
    for (const [name, field] of Object.entries(spec.fields)) {
      if (field.template != null) out[name] = resolveField(field, row, bag, d.base, payload);
    }
    (out as any).__raw = row;
    return out;
  }).filter((record) => passesFilters(record, spec.filter, vars));
}

function safeJson(text: string, d: Descriptor): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ExtensionError(`${d.name} did not return valid JSON.`, d.id, 'parse');
  }
}

const CATEGORY_WORDS: Array<[RegExp, ContentKind]> = [
  [/webtoon/i, 'webtoon'],
  [/manhwa|korean/i, 'manhwa'],
  [/manhua|chinese|cultivation|wuxia|xianxia/i, 'manhua'],
  [/manga|japanese/i, 'manga'],
];

function categoryOf(record: Record<string, unknown>, d: Descriptor): ContentKind | undefined {
  const explicit = asString(record.category)?.toLowerCase();
  if (explicit && (CONTENT_KINDS as string[]).includes(explicit)) return explicit as ContentKind;
  const haystack = [asString(record.title) ?? '', ...(asStringArray(record.genres) ?? [])].join(' ');
  return CATEGORY_WORDS.find(([re]) => re.test(haystack))?.[1] ?? d.defaultCategory;
}

function toSummary(record: Record<string, unknown>, d: Descriptor): SeriesSummary | null {
  const id = asString(record.id);
  const title = asString(record.title);
  if (!id || !title) return null;
  const category = categoryOf(record, d);
  return {
    id,
    title,
    ...(asString(record.author) ? { author: asString(record.author)! } : {}),
    ...(asString(record.synopsis) ? { synopsis: asString(record.synopsis)!.slice(0, 2000) } : {}),
    ...(asStringArray(record.genres) ? { genres: asStringArray(record.genres)!.slice(0, 25) } : {}),
    ...(category ? { category } : {}),
    ...(asString(record.status) ? { status: asString(record.status)!.toLowerCase() } : {}),
    ...(asString(record.cover) ? { cover: asString(record.cover)! } : {}),
    ...(asNumber(record.updatedAt) ? { updatedAt: asNumber(record.updatedAt)! } : {}),
    ...(asStringArray(record.altTitles) ? { altTitles: asStringArray(record.altTitles)!.slice(0, 12) } : {}),
    ...(asNumber(record.year) ? { year: asNumber(record.year)! } : {}),
    ...(asString(record.anilistId) ? { anilistId: asString(record.anilistId)! } : {}),
    ...(asString(record.mangadexId) ? { mangadexId: asString(record.mangadexId)! } : {}),
  };
}

function toChapter(record: Record<string, unknown>, index: number): Chapter | null {
  const id = asString(record.id);
  if (!id) return null;
  const number = asNumber(record.number);
  return {
    id,
    number: number ?? index + 1,
    name: asString(record.name) || (number != null ? `Chapter ${number}` : `Chapter ${index + 1}`),
    ...(asNumber(record.pageCount) ? { pageCount: asNumber(record.pageCount)! } : {}),
    ...(asNumber(record.publishedAt) ? { publishedAt: asNumber(record.publishedAt)! } : {}),
    ...(asString(record.scanlator) ? { scanlator: asString(record.scanlator)! } : {}),
  };
}

/** Chapters nested inside a series-detail response. */
async function chaptersFromDetail(
  d: Descriptor,
  ep: EndpointSpec,
  raw: unknown,
  vars: Record<string, string | number | undefined> = {},
): Promise<Chapter[]> {
  const nested = ep.parse.chapters;
  if (!nested) return [];
  const rows = readPath(raw, nested.list);
  if (!Array.isArray(rows)) return [];
  return rows
    .slice(0, 2000)
    .map((row, i) => {
      const out: Record<string, unknown> = {};
      for (const [name, field] of Object.entries(nested.fields)) {
        if (field.template == null) out[name] = resolveField(field, row, out, d.base);
      }
      const bag = { ...vars, ...out };
      for (const [name, field] of Object.entries(nested.fields)) {
        if (field.template != null) out[name] = resolveField(field, row, bag, d.base);
      }
      return toChapter(out, i);
    })
    .filter((c): c is Chapter => !!c);
}

export function compileExtension(d: Descriptor): YomuExtension {
  const need = (name: keyof Descriptor['endpoints']): EndpointSpec => {
    const ep = d.endpoints[name];
    if (!ep) throw new ExtensionError(`${d.name} does not support ${name}.`, d.id, 'capability');
    return ep;
  };

  /** Resolve an endpoint's `before` chain into extra request variables. */
  const chained = async (
    ep: EndpointSpec,
    vars: Record<string, string | number | undefined>,
  ): Promise<Record<string, string | number | undefined>> => {
    if (!ep.before) return vars;
    const prefix = ep.before.as ?? 'chain';
    const step: EndpointSpec = { ...ep.before, parse: ep.before.parse };
    const response = await request(d, step, vars);
    const records = await readRecords(d, step, response, vars);
    const first = records[0] ?? {};
    const extra: Record<string, string | number | undefined> = { ...vars };
    for (const [key, value] of Object.entries(first)) {
      if (key === '__raw') continue;
      extra[`${prefix}_${key}`] = value == null ? undefined : String(value);
    }
    return extra;
  };

  const listing = async (name: 'popular' | 'latest' | 'search', rawVars: Record<string, string | number>): Promise<SearchResult> => {
    const ep = need(name);
    const vars = await chained(ep, rawVars);
    const response = await request(d, ep, vars);
    const records = await readRecords(d, ep, response, vars);
    const series = records.map((r) => toSummary(r, d)).filter((s): s is SeriesSummary => !!s);
    return { series, hasNextPage: series.length > 0 };
  };

  return {
    id: d.id,
    name: d.name,
    popular: (page = 1) => listing('popular', { page }),
    latest: (page = 1) => listing('latest', { page }),
    search: (query: string, page = 1) => listing('search', { query: encodeURIComponent(query), rawQuery: query, page }),

    async getSeries(id: string): Promise<Series> {
      const ep = need('series');
      const vars = await chained(ep, { id, rawId: id });
      const response = await request(d, ep, vars);
      const records = await readRecords(d, ep, response, vars);
      const summary = records[0] ? toSummary({ ...records[0], id: records[0].id ?? id }, d) : null;
      if (!summary) throw new ExtensionError(`${d.name} could not load that title.`, d.id, 'parse');
      const chapters = await chaptersFromDetail(d, ep, (records[0] as any).__raw, vars);
      return { ...summary, id, ...(chapters.length ? { chapters } : {}) };
    },

    async getChapters(id: string): Promise<Chapter[]> {
      if (d.endpoints.chapters) {
        const ep = d.endpoints.chapters;
        const vars = await chained(ep, { id, rawId: id });
        const response = await request(d, ep, vars);
        const records = await readRecords(d, ep, response, vars);
        return records.map((r, i) => toChapter(r, i)).filter((c): c is Chapter => !!c);
      }
      const series = await this.getSeries(id);
      return series.chapters ?? [];
    },

    async getPages(chapterId: string): Promise<Page[]> {
      const ep = need('pages');
      const vars = await chained(ep, { chapterId, id: chapterId, rawId: chapterId });
      const response = await request(d, ep, vars);
      const records = await readRecords(d, ep, response, vars);
      const pages: Page[] = [];
      for (const record of records) {
        const url = asString(record.url);
        if (!url) continue;
        let absolute: string;
        try {
          absolute = new URL(url, d.base).toString();
        } catch {
          continue;
        }
        pages.push({ key: `${chapterId}-${pages.length}`, index: pages.length, url: absolute });
      }
      if (!pages.length) throw new ExtensionError(`${d.name} returned no readable pages.`, d.id, 'parse');
      return pages;
    },
  };
}

/** Image hosts an adapter is allowed to serve pages/covers from. */
export function descriptorAllowsImage(d: Descriptor, url: URL): boolean {
  return url.protocol === 'https:' && hostAllowed(url, d.hosts);
}

export { applyTransforms, readPath };
