type WebsitePlan = {
  baseUrl?: string;
  seriesSegments?: string[];
  framework?: string;
  nsfw?: boolean;
};

const TIMEOUT_MS = 6_000;
/**
 * How much of a search page is worth reading.
 *
 * This runs inside a Worker with a CPU budget, and every byte here is walked by
 * the anchor scanner below. 2.5MB of HTML on a link-dense directory is tens of
 * thousands of anchors and seconds of CPU -- enough to exceed the Worker's
 * limit, which Cloudflare answers with an HTML error 1102 page. The client then
 * reports that page as a JSON parse error ("the string did not match the
 * expected pattern" in Safari), so an over-eager recovery here surfaced as
 * "Search failed" on the reader's screen. A search page puts its results near
 * the top; 600KB reaches them on every site tested and bounds the worst case.
 */
const MAX_HTML = 600_000;
/** Anchors examined per page. A results page needs far fewer than this. */
const MAX_ANCHORS = 3_000;
/** Wall-clock budget for the whole recovery, across every candidate URL. */
const BUDGET_MS = 9_000;
const UA = 'Mozilla/5.0 (compatible; Yomu-Search-Recovery/1.0; +https://yomu.yomuread.workers.dev)';

function decodeJsonToken<T>(token: string): T | null {
  try {
    const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - token.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function encodeJsonToken(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function normalizedHost(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function hostsMatch(a: string, b: string): boolean {
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}

function sameSource(candidate: string, root: string): boolean {
  return hostsMatch(normalizedHost(candidate), normalizedHost(root));
}

function cleanText(value: string): string {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The href of one `<a>`, from its attribute text.
 *
 * Precompiled: this used to build two RegExp objects per call and was called
 * once per anchor on the page, which is most of the CPU this file ever spent.
 */
const HREF_QUOTED = /\bhref\s*=\s*(["'])(.*?)\1/i;
const HREF_BARE = /\bhref\s*=\s*([^\s>]+)/i;

function hrefOf(attrs: string): string {
  const quoted = HREF_QUOTED.exec(attrs);
  if (quoted?.[2]) return quoted[2].replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  const bare = HREF_BARE.exec(attrs);
  return String(bare?.[1] || '').replace(/&amp;/gi, '&');
}

function normalizeTitle(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|of|and|manga|manhwa|manhua|webtoon|comic|official|season|part|vol(?:ume)?|novel|remake)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `query` is already normalised -- normalizeTitle runs NFKD and is not cheap. */
function titleMatchesNormalizedQuery(title: string, b: string): boolean {
  const a = normalizeTitle(title);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const words = new Set(a.split(' ').filter((x) => x.length > 1));
  const queryWords = b.split(' ').filter((x) => x.length > 1);
  if (!queryWords.length) return false;
  return queryWords.filter((word) => words.has(word)).length / queryWords.length >= 0.72;
}

function titleRelevant(title: string, query: string): boolean {
  return titleMatchesNormalizedQuery(title, normalizeTitle(query));
}

function isSeriesPath(target: URL, plan: WebsitePlan): boolean {
  const parts = target.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part).toLowerCase());
  if (parts.length < 2) return false;
  if (parts.some((part) => /^(?:chapter|chapters|episode|episodes|reader|read)$/i.test(part))) return false;
  if (/\/(?:genre|genres|tag|tags|author|authors|category|search|login|register|privacy|terms|contact|page)(?:\/|$)/i.test(target.pathname)) return false;
  const learned = new Set((plan.seriesSegments || []).map((segment) => String(segment).toLowerCase()));
  if (learned.has(parts[0])) return true;
  return /\/(?:webtoons?|mangas?|manhwas?|manhuas?|comics?|series|titles?|novels?|books?|stories?|projects?|works?)\//i.test(target.pathname);
}

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

/**
 * Title links on one search page.
 *
 * The order of the tests matters more than any one of them: every anchor on a
 * page runs the first test, and only a handful reach the last. Cheapest first,
 * so the expensive work (URL parsing, tag stripping, NFKD normalisation) only
 * ever runs on anchors that could plausibly be a title.
 */
function parseRows(html: string, pageUrl: string, plan: WebsitePlan, normalizedQuery: string): any[] {
  const rootHost = normalizedHost(String(plan.baseUrl || ''));
  const rows: any[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  ANCHOR.lastIndex = 0;
  for (let match = ANCHOR.exec(html); match; match = ANCHOR.exec(html)) {
    if (++scanned > MAX_ANCHORS) break;

    const href = hrefOf(match[1]);
    if (!href || href.charCodeAt(0) === 35 /* # */ || /^(?:javascript:|mailto:|tel:)/i.test(href)) continue;

    let target: URL;
    try { target = new URL(href, pageUrl); } catch { continue; }
    if (!hostsMatch(normalizedHost(target.href), rootHost) || !isSeriesPath(target, plan)) continue;

    const title = cleanText(match[2] || '');
    if (!titleMatchesNormalizedQuery(title, normalizedQuery)) continue;

    target.hash = '';
    const canonical = target.toString();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    rows.push({
      id: encodeJsonToken(canonical),
      title: title || decodeURIComponent(target.pathname.split('/').filter(Boolean).pop() || target.hostname).replace(/[-_]+/g, ' '),
      category: 'comic',
      nsfw: !!plan.nsfw,
      updatedAt: Date.now() - rows.length,
    });
    if (rows.length >= 50) break;
  }
  return rows;
}

async function searchSite(plan: WebsitePlan, query: string): Promise<any[]> {
  const rootRaw = String(plan.baseUrl || '');
  let root: URL;
  try { root = new URL(rootRaw); } catch { return []; }
  if (!['https:', 'http:'].includes(root.protocol) || root.username || root.password) return [];

  const escaped = encodeURIComponent(query);
  const candidates = [
    new URL(`/search/?search=${escaped}`, root),
    new URL(`/search?search=${escaped}`, root),
    new URL(`/?search=${escaped}`, root),
    new URL(`/search/?keyword=${escaped}`, root),
    new URL(`/search?keyword=${escaped}`, root),
    new URL(`/search/?query=${escaped}`, root),
  ];

  const normalizedQuery = normalizeTitle(query);
  const deadline = Date.now() + BUDGET_MS;
  let best: any[] = [];
  for (const candidate of candidates) {
    // Six sequential fetches of a multi-megabyte page is how this exceeded the
    // Worker's limits. The budget is the stop, not the candidate count.
    if (Date.now() >= deadline) break;
    try {
      const response = await fetch(candidate.toString(), {
        redirect: 'follow',
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.4',
          'accept-language': 'en-US,en;q=0.8',
          'user-agent': UA,
          referer: root.toString(),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const finalUrl = response.url || candidate.toString();
      if (!sameSource(finalUrl, root.toString())) continue;
      const html = (await response.text()).slice(0, MAX_HTML);
      if (/cf-chl-|challenge-platform|checking your browser|just a moment\.\.\.|g-recaptcha|hcaptcha|turnstile-wrapper|captcha-container/i.test(html.slice(0, 140_000))) continue;
      const rows = parseRows(html, finalUrl, plan, normalizedQuery);
      if (rows.length > best.length) best = rows;
      // A candidate that answered with title links is the site's search page.
      // Parsing the remaining five spends CPU to confirm what is already known.
      if (best.length) break;
    } catch {}
  }
  return best;
}

export async function repairWebsiteAdaptiveSearch(request: Request, url: URL, response: Response): Promise<Response> {
  if (request.method !== 'GET') return response;
  const match = url.pathname.match(/^\/api\/fabric\/website-adaptive\/([^/]+)\/search$/);
  if (!match) return response;
  const query = String(url.searchParams.get('q') || '').trim();
  if (!query) return response;

  const payload: any = response.headers.get('content-type')?.includes('application/json')
    ? await response.clone().json().catch(() => null)
    : null;
  const existing = Array.isArray(payload?.series) ? payload.series : [];
  if (existing.some((row: any) => titleRelevant(String(row?.title || ''), query))) return response;

  const plan = decodeJsonToken<WebsitePlan>(match[1]);
  if (!plan?.baseUrl) return response;
  const recovered = await searchSite(plan, query);
  if (!recovered.length) return response;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-yomu-search-recovery', 'site-native');
  return new Response(JSON.stringify({
    ...(payload && typeof payload === 'object' ? payload : {}),
    series: recovered,
    hasNextPage: false,
    searchRecovery: 'site-native',
  }), { status: 200, headers });
}
