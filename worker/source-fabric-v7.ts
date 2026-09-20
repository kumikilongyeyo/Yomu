import type { Env } from './index';
import {
  fabricSourceCards,
  handleFabric as handleFabricV6,
} from './source-fabric-v6';

/**
 * Yomu Source Fabric v7.5 — Recipe Engine public surface.
 *
 * v6 remains the proven adaptive engine underneath. v7.5 keeps the v7.4
 * Worker-native recipe compiler and adds direct source-repository discovery
 * plus a remote compiled-recipe execution tier for sites Cloudflare cannot
 * execute reliably itself.
 *
 * Search compatibility note:
 * many manga sites do not use ?q= or WordPress ?s=. A verified dynamic source
 * can therefore read perfectly but still return no results from Search. This
 * layer retries a small, bounded set of common site-native search parameters
 * and converts matching series links back into the same dynamic-source IDs v6
 * already knows how to open. This is a normal public-HTML fallback only; it
 * does not bypass access controls or interactive challenges.
 */
const VERSION = '7.5';
const GENERATION = 'Recipe Engine';
const SEARCH_TIMEOUT_MS = 8_000;

export { fabricSourceCards };

async function rewriteJson(response: Response, mutate: (payload: any) => any): Promise<Response> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return response;
  const payload = await response.clone().json().catch(() => null);
  if (!payload || typeof payload !== 'object') return response;
  const next = mutate(payload);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-yomu-source-fabric', VERSION);
  return new Response(JSON.stringify(next), { status: response.status, headers });
}

function decodeDynamicRoot(token: string): URL | null {
  try {
    const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - token.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const raw = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(raw);
    const root = new URL(String(parsed?.root || ''));
    if (!['https:', 'http:'].includes(root.protocol) || root.username || root.password) return null;
    return root;
  } catch {
    return null;
  }
}

function encodeToken(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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
  const aa = new Set(a.split(' ').filter((x) => x.length > 1));
  const bb = b.split(' ').filter((x) => x.length > 1);
  if (!bb.length) return false;
  const shared = bb.filter((x) => aa.has(x)).length;
  return shared / bb.length >= 0.72;
}

function attr(tag: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  if (quoted?.[2]) return quoted[2].replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  const bare = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*([^\\s>]+)`, 'i'));
  return String(bare?.[1] || '').replace(/&amp;/gi, '&');
}

function seriesRowsFromHtml(html: string, pageUrl: string, root: URL, query: string): Array<{ id: string; title: string }> {
  const rows: Array<{ id: string; title: string }> = [];
  const seen = new Set<string>();
  const seriesPath = /\/(manga|manhwa|manhua|series|webtoon|webtoons|comic|comics|title|titles|book|books|novel|novels|toon|toons|story|stories|project|projects|works?)\//i;
  const chapterPath = /\/(chapter|chapters?|reader|read|episode|episodes?|ep[-_/]?\d|ch[-_/]?\d)\b/i;
  const junkPath = /\/(tag|tags|genre|genres|author|artist|login|register|privacy|terms|contact|about|search|wp-admin|feed|account|user)(\/|$)/i;

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(`<a ${match[1]}>`, 'href');
    if (!href || href.startsWith('#') || /^(javascript:|mailto:|tel:)/i.test(href)) continue;
    let target: URL;
    try { target = new URL(href, pageUrl); } catch { continue; }
    if (target.origin !== root.origin) continue;
    if (!seriesPath.test(target.pathname) || chapterPath.test(target.pathname) || junkPath.test(target.pathname)) continue;
    const title = cleanText(match[2] || '');
    if (!titleRelevant(title, query)) continue;
    const key = target.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ id: encodeToken(key), title: title || target.pathname.split('/').filter(Boolean).pop()?.replace(/[-_]+/g, ' ') || 'Untitled' });
    if (rows.length >= 50) break;
  }
  return rows;
}

async function siteNativeSearch(token: string, query: string): Promise<Array<{ id: string; title: string }>> {
  const root = decodeDynamicRoot(token);
  if (!root || !query.trim()) return [];

  // Mgeko-style ?search= is intentionally first. The rest cover common custom
  // directory/search implementations missed by the v6 ?s= / ?q= floor.
  const candidates = [
    new URL(`/search/?search=${encodeURIComponent(query)}`, root),
    new URL(`/search?search=${encodeURIComponent(query)}`, root),
    new URL(`/?search=${encodeURIComponent(query)}`, root),
    new URL(`/search/?keyword=${encodeURIComponent(query)}`, root),
    new URL(`/search?keyword=${encodeURIComponent(query)}`, root),
    new URL(`/search/?query=${encodeURIComponent(query)}`, root),
  ];

  let best: Array<{ id: string; title: string }> = [];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.toString(), {
        redirect: 'follow',
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.4',
          'accept-language': 'en-US,en;q=0.8',
          'user-agent': `Mozilla/5.0 (compatible; Yomu-Source-Fabric/${VERSION}; +https://yomu.yomuread.workers.dev)`,
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const finalUrl = new URL(response.url || candidate.toString());
      if (finalUrl.origin !== root.origin) continue;
      const html = (await response.text()).slice(0, 2_500_000);
      if (/cf-chl-|challenge-platform|cloudflare ray id|checking your browser|just a moment\.\.\.|g-recaptcha|hcaptcha-container/i.test(html.slice(0, 100_000))) continue;
      const rows = seriesRowsFromHtml(html, finalUrl.toString(), root, query);
      if (rows.length > best.length) best = rows;
      if (best.some((row) => normalizeTitle(row.title) === normalizeTitle(query))) break;
    } catch {}
  }
  return best;
}

async function repairDynamicSearch(request: Request, url: URL, response: Response): Promise<Response> {
  if (request.method !== 'GET') return response;
  const match = url.pathname.match(/^\/api\/fabric\/dynamic\/([^/]+)\/search$/);
  if (!match) return response;
  const query = (url.searchParams.get('q') || '').trim();
  if (!query) return response;

  const payload: any = response.headers.get('content-type')?.includes('application/json')
    ? await response.clone().json().catch(() => null)
    : null;
  const existing = Array.isArray(payload?.series) ? payload.series : [];
  if (existing.some((row: any) => titleRelevant(String(row?.title || ''), query))) return response;

  const recovered = await siteNativeSearch(match[1], query);
  if (!recovered.length) return response;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-yomu-source-fabric', VERSION);
  headers.set('x-yomu-search-recovery', 'site-native');
  return new Response(JSON.stringify({
    ...(payload && typeof payload === 'object' ? payload : {}),
    series: recovered,
    hasNextPage: false,
    searchRecovery: 'site-native',
  }), { status: 200, headers });
}

export async function handleFabric(request: Request, env: Env, url: URL): Promise<Response> {
  const response = await handleFabricV6(request, env, url);
  const repaired = await repairDynamicSearch(request, url, response);

  if (url.pathname === '/api/fabric/status') {
    return rewriteJson(repaired, (payload) => ({
      ...payload,
      version: VERSION,
      generation: GENERATION,
      core: { engine: 'adaptive-v6', version: payload.version ?? '6.0' },
      entrypoint: 'index-v7',
      engines: [...new Set([...(Array.isArray(payload.engines) ? payload.engines : []), 'recipe-adaptive', 'remote-recipe-runtime', 'store-federation', 'aidoku-wasm'])],
      capabilities: {
        adaptiveFallbacks: true,
        federation: true,
        maintainedNameResolution: true,
        sourceRepositoryNameFallback: true,
        smartSourcePackInputs: true,
        maintainedRecipeCompilation: true,
        recipeFamilyClassification: true,
        workerRecipeGauntlet: true,
        remoteCompiledRecipeRuntime: true,
        realCssSelectorExecution: true,
        browserDependencyDetection: true,
        explicitBrowserOutcome: true,
        remoteRuntime: true,
        diagnostics: true,
        liveSmoke: true,
        siteNativeSearchRecovery: true,
      },
    }));
  }

  if (url.pathname === '/api/fabric/resolve') {
    return rewriteJson(repaired, (payload) => ({
      ...payload,
      fabric: {
        ...(payload.fabric ?? {}),
        version: VERSION,
        generation: GENERATION,
        coreVersion: payload.fabric?.version ?? '6.0',
      },
    }));
  }

  return repaired;
}
