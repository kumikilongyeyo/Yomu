type WebsitePlan = {
  baseUrl?: string;
  seriesSegments?: string[];
  framework?: string;
  nsfw?: boolean;
};

const TIMEOUT_MS = 8_000;
const MAX_HTML = 2_500_000;
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

function sameSource(candidate: string, root: string): boolean {
  const a = normalizedHost(candidate);
  const b = normalizedHost(root);
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
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

function attr(tag: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  if (quoted?.[2]) return quoted[2].replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  const bare = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*([^\\s>]+)`, 'i'));
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

function titleRelevant(title: string, query: string): boolean {
  const a = normalizeTitle(title);
  const b = normalizeTitle(query);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const words = new Set(a.split(' ').filter((x) => x.length > 1));
  const queryWords = b.split(' ').filter((x) => x.length > 1);
  if (!queryWords.length) return false;
  return queryWords.filter((word) => words.has(word)).length / queryWords.length >= 0.72;
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

function parseRows(html: string, pageUrl: string, plan: WebsitePlan, query: string): any[] {
  const root = String(plan.baseUrl || '');
  const rows: any[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(`<a ${match[1]}>`, 'href');
    if (!href || href.startsWith('#') || /^(?:javascript:|mailto:|tel:)/i.test(href)) continue;
    let target: URL;
    try { target = new URL(href, pageUrl); } catch { continue; }
    if (!sameSource(target.toString(), root) || !isSeriesPath(target, plan)) continue;
    const title = cleanText(match[2] || '');
    if (!titleRelevant(title, query)) continue;
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

  const candidates = [
    new URL(`/search/?search=${encodeURIComponent(query)}`, root),
    new URL(`/search?search=${encodeURIComponent(query)}`, root),
    new URL(`/?search=${encodeURIComponent(query)}`, root),
    new URL(`/search/?keyword=${encodeURIComponent(query)}`, root),
    new URL(`/search?keyword=${encodeURIComponent(query)}`, root),
    new URL(`/search/?query=${encodeURIComponent(query)}`, root),
  ];

  let best: any[] = [];
  for (const candidate of candidates) {
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
      const rows = parseRows(html, finalUrl, plan, query);
      if (rows.length > best.length) best = rows;
      if (best.some((row) => normalizeTitle(row.title) === normalizeTitle(query))) break;
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
