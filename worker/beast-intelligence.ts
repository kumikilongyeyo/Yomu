import type { Env } from './index';
import { handleFabric } from './source-fabric-v7';
import { findFederatedSources } from './store-federation';
import type { FederatedMatch, KnownReadingSite } from './store-federation';

type Family = 'madara' | 'tsreader' | 'wordpress' | 'nextjs' | 'nuxt' | 'api-first' | 'generic';
type Mode = 'family-seed' | 'direct-worker' | 'aidoku-runtime';
type FamilyHit = { family: Family; score: number; signals: string[] };
type Fingerprint = {
  family: Family;
  confidence: 'high' | 'medium' | 'low';
  ranked: FamilyHit[];
  seedSeries?: string;
  finalUrl?: string;
  access: 'ok' | 'blocked' | 'unreachable';
};
type Stat = { wins: number; failures: number; lastSuccess?: number };
type HostMemory = { expires: number; family: Family; stats: Partial<Record<Mode, Stat>> };
type BrokerResult = {
  configured: boolean;
  connected: boolean;
  ready: boolean;
  executable: number;
  payload?: any;
  error?: string;
};
type Federation = Awaited<ReturnType<typeof findFederatedSources>>;

const VERSION = '7.3-dev';
const UA = `Mozilla/5.0 (compatible; Yomu-Beast/${VERSION}; +https://yomu.yomuread.workers.dev)`;
const MEMORY_TTL = 45 * 60_000;
const MAX_MEMORY = 256;
const memory = new Map<string, HostMemory>();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-yomu-beast-intelligence': VERSION,
  },
});

function hostOf(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function privateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return !h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') ||
    /^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^(::1|fc|fd|fe80)/i.test(h);
}

function publicUrl(value: string): URL {
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || privateHost(url.hostname)) {
    throw new Error('Paste a normal public http/https reading-site URL.');
  }
  url.hash = '';
  return url;
}

function sameSite(a: string, b: string): boolean {
  const x = hostOf(a), y = hostOf(b);
  return !!x && !!y && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`));
}

function blocked(status: number, html: string): boolean {
  return status === 401 || status === 403 ||
    /cf-chl-|challenge-platform|cloudflare ray id|checking your browser|just a moment\.\.\.|g-recaptcha|hcaptcha-container/i.test(html.slice(0, 100_000));
}

function addHit(map: Map<Family, FamilyHit>, family: Family, score: number, signal: string) {
  const row = map.get(family) ?? { family, score: 0, signals: [] };
  row.score += score;
  if (!row.signals.includes(signal)) row.signals.push(signal);
  map.set(family, row);
}

function findSeed(html: string, base: string): string | undefined {
  const rows: Array<{ url: string; score: number }> = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
    const raw = String(match[2] ?? '').replace(/&amp;/gi, '&').trim();
    if (!raw || /^(?:javascript:|mailto:|tel:|#)/i.test(raw)) continue;
    let url: URL;
    try { url = new URL(raw, base); } catch { continue; }
    if (!sameSite(url.toString(), base)) continue;
    const path = url.pathname;
    if (/\/(?:chapter|chapters?|read|reader|episode|ep[-_/]?\d|ch[-_/]?\d)\b/i.test(path)) continue;
    let score = 0;
    if (/\/(?:manga|manhwa|manhua|series|webtoon|comic|title|book|novel)\//i.test(path)) score += 8;
    if (/\/(?:manga|series|comic)\/[a-z0-9][a-z0-9_-]{2,}/i.test(path)) score += 4;
    if (path.replace(/\/$/, '').split('/').filter(Boolean).length >= 2) score += 2;
    if (/\/(?:tag|genre|author|search|login|register|privacy|terms)(?:\/|$)/i.test(path)) score -= 10;
    if (score > 0) rows.push({ url: url.toString(), score });
    if (rows.length >= 250) break;
  }
  rows.sort((a, b) => b.score - a.score || a.url.length - b.url.length);
  return rows[0]?.url;
}

function classify(html: string, finalUrl: string): Fingerprint {
  const hits = new Map<Family, FamilyHit>();
  if (/wp-manga|manga-chapters-holder|manga_get_chapters|listing-chapters_wrap|madara-core|madara-js/i.test(html)) addHit(hits, 'madara', 12, 'madara markup');
  if (/\/ajax\/chapters\/?|manga-ajax|wp-admin\/admin-ajax\.php/i.test(html)) addHit(hits, 'madara', 6, 'madara ajax');
  if (/ts_reader\.run|ts-reader|readerarea|chapter_preloaded_images/i.test(html)) addHit(hits, 'tsreader', 12, 'tsreader payload');
  if (/__next_data__|\/_next\//i.test(html)) addHit(hits, 'nextjs', 11, 'next.js state');
  if (/__nuxt__|\/_nuxt\//i.test(html)) addHit(hits, 'nuxt', 11, 'nuxt state');
  if (/wp-content|wp-includes|api\.w\.org|\/wp-json\//i.test(html)) addHit(hits, 'wordpress', 8, 'wordpress markers');
  if (/api\.mangadex\.org|graphql|\/api\/(?:v\d+\/)?(?:manga|series|chapter)|application\/json/i.test(html)) addHit(hits, 'api-first', 5, 'api hints');
  if ((hits.get('madara')?.score ?? 0) > 0) addHit(hits, 'wordpress', 3, 'madara wordpress parent');
  const ranked = [...hits.values()].sort((a, b) => b.score - a.score || a.family.localeCompare(b.family));
  const top = ranked[0];
  const family: Family = top && top.score >= 4 ? top.family : 'generic';
  return {
    family,
    confidence: !top || top.score < 4 ? 'low' : top.score >= 11 ? 'high' : 'medium',
    ranked,
    seedSeries: findSeed(html, finalUrl),
    finalUrl,
    access: 'ok',
  };
}

async function fingerprint(target: URL): Promise<Fingerprint> {
  try {
    const response = await fetch(target.toString(), {
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.4', 'accept-language': 'en-US,en;q=0.8', 'user-agent': UA },
      signal: AbortSignal.timeout(5_500),
    });
    const finalUrl = response.url || target.toString();
    if (!sameSite(finalUrl, target.toString())) return { family: 'generic', confidence: 'low', ranked: [], access: 'unreachable' };
    const html = (await response.text()).slice(0, 900_000);
    if (blocked(response.status, html)) return { family: 'generic', confidence: 'low', ranked: [], finalUrl, access: 'blocked' };
    if (!response.ok) return { family: 'generic', confidence: 'low', ranked: [], finalUrl, access: 'unreachable' };
    return classify(html, finalUrl);
  } catch {
    return { family: 'generic', confidence: 'low', ranked: [], access: 'unreachable' };
  }
}

function getMemory(host: string): HostMemory | undefined {
  const row = memory.get(host);
  if (row && row.expires > Date.now()) return row;
  if (row) memory.delete(host);
  return undefined;
}

function remember(host: string, family: Family, mode: Mode, ok: boolean) {
  let row = getMemory(host);
  if (!row) {
    if (memory.size >= MAX_MEMORY) {
      const first = memory.keys().next().value as string | undefined;
      if (first) memory.delete(first);
    }
    row = { expires: Date.now() + MEMORY_TTL, family, stats: {} };
    memory.set(host, row);
  }
  row.expires = Date.now() + MEMORY_TTL;
  row.family = family;
  const stat = row.stats[mode] ?? { wins: 0, failures: 0 };
  if (ok) { stat.wins += 1; stat.lastSuccess = Date.now(); } else stat.failures += 1;
  row.stats[mode] = stat;
}

function plan(host: string, family: Family, hasSeed: boolean, hasAidoku: boolean) {
  const warm = getMemory(host);
  const base: Record<Mode, number> = {
    'family-seed': hasSeed ? (family === 'generic' ? 6 : 12) : -100,
    'direct-worker': family === 'generic' ? 11 : 8,
    'aidoku-runtime': hasAidoku ? ((family === 'api-first' || family === 'generic') ? 13 : 9) : -100,
  };
  const order = (Object.keys(base) as Mode[]).map((mode) => {
    const stat = warm?.stats[mode];
    const memoryScore = stat ? stat.wins * 5 - stat.failures * 2 + (stat.lastSuccess && Date.now() - stat.lastSuccess < 20 * 60_000 ? 4 : 0) : 0;
    return { mode, score: base[mode] + memoryScore };
  }).filter((x) => x.score > -50).sort((a, b) => b.score - a.score).map((x) => x.mode);
  return { order, warm: Boolean(warm) };
}

function memoryView(host: string) {
  const row = getMemory(host);
  return row ? { warm: true, family: row.family, expiresAt: row.expires, strategies: row.stats } : { warm: false };
}

function runtimeConfig(env: Env): { url?: string; token?: string } {
  const row = env as Env & { SOURCE_RUNTIME_URL?: string; SOURCE_RUNTIME_TOKEN?: string };
  const raw = String(row.SOURCE_RUNTIME_URL ?? '').trim();
  if (!raw) return {};
  try {
    const url = new URL(raw);
    return ['https:', 'http:'].includes(url.protocol) ? { url: url.toString().replace(/\/+$/, ''), token: String(row.SOURCE_RUNTIME_TOKEN ?? '').trim() || undefined } : {};
  } catch { return {}; }
}

function safeArtifact(match: FederatedMatch): string | undefined {
  const raw = String(match.artifact ?? '');
  if (raw && /^[a-z0-9_./-]+\.aix$/i.test(raw) && !raw.includes('..')) return raw;
  if (match.storeId !== 'aidoku-community') return undefined;
  const id = String(match.id ?? ''), version = String(match.version ?? '');
  return /^[a-z0-9._-]{2,100}$/i.test(id) && /^\d{1,8}$/.test(version) ? `sources/${id}-v${version}.aix` : undefined;
}

function publicEvidence(match: FederatedMatch) {
  return {
    ecosystem: match.ecosystem,
    store: match.storeName,
    storeId: match.storeId,
    name: match.name,
    id: match.id,
    version: match.version,
    package: match.package,
    baseUrl: match.baseUrl,
    artifact: match.ecosystem === 'aidoku' ? safeArtifact(match) : match.artifact,
    sourceCodeUrl: match.sourceCodeUrl,
    language: match.language,
    runtimeHint: match.runtimeHint,
    hasCloudflare: match.hasCloudflare,
  };
}

function knownEvidence(site?: KnownReadingSite) {
  return site ? { source: site.source, name: site.name, baseUrl: site.baseUrl, library: site.library, category: site.category, directory: site.directory } : undefined;
}

async function broker(env: Env, target: URL, matches: FederatedMatch[]): Promise<BrokerResult> {
  const config = runtimeConfig(env);
  const runnable = matches.filter((x) => x.ecosystem === 'aidoku' && x.runtimeHint === 'aidoku-wasm')
    .map((x) => ({ ...x, artifact: safeArtifact(x) })).filter((x) => Boolean(x.artifact)).slice(0, 6);
  if (!config.url) return { configured: false, connected: false, ready: false, executable: runnable.length };
  if (!runnable.length) return { configured: true, connected: true, ready: false, executable: 0 };
  try {
    const response = await fetch(`${config.url}/v1/resolve`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA, ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
      body: JSON.stringify({ targetUrl: target.toString(), implementations: runnable.map(publicEvidence) }),
      signal: AbortSignal.timeout(30_500),
    });
    const payload: any = await response.json().catch(() => null);
    return payload
      ? { configured: true, connected: true, ready: Boolean(payload.ready && payload.adapter), executable: runnable.length, payload }
      : { configured: true, connected: true, ready: false, executable: runnable.length, error: `Runtime returned HTTP ${response.status} without JSON.` };
  } catch (error: any) {
    return { configured: true, connected: false, ready: false, executable: runnable.length, error: String(error?.message ?? error).slice(0, 320) };
  }
}

async function workerResolve(request: Request, env: Env, url: URL, body: any, targetUrl: string) {
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  const response = await handleFabric(new Request(url.toString(), { method: 'POST', headers, body: JSON.stringify({ ...body, url: targetUrl }) }), env, url);
  return { response, payload: await response.clone().json().catch(() => null) as any };
}

function mergeEvidence(existing: any[], federation: Federation) {
  const rows: any[] = [...(Array.isArray(existing) ? existing : []), ...federation.matches.map(publicEvidence)];
  if (federation.knownSite) rows.push({ ecosystem: 'directory', store: 'Wotaku Websites', ...knownEvidence(federation.knownSite) });
  const out: any[] = [], seen = new Set<string>();
  for (const row of rows) {
    const key = `${row?.ecosystem ?? ''}|${row?.storeId ?? row?.store ?? ''}|${row?.id ?? row?.package ?? row?.name ?? ''}|${row?.baseUrl ?? ''}`;
    if (!key.replace(/\|/g, '') || seen.has(key)) continue;
    seen.add(key); out.push(row);
  }
  return out.slice(0, 28);
}

function federationMeta(federation: Federation, result: BrokerResult) {
  return {
    version: VERSION,
    storesChecked: federation.storesChecked,
    storesHealthy: federation.storesHealthy,
    directoriesChecked: federation.directoriesChecked,
    directoriesHealthy: federation.directoriesHealthy,
    implementations: federation.matches.length,
    best: federation.matches[0] ? publicEvidence(federation.matches[0]) : undefined,
    discovery: knownEvidence(federation.knownSite),
    runtimeBrokerConfigured: result.configured,
    runtimeBrokerConnected: result.connected,
    aidokuExecutable: result.executable,
    runtimeAttempts: result.payload?.attempts,
    runtimeError: result.error,
  };
}

function intelligence(fp: Fingerprint, host: string, order: Mode[], warm: boolean, chosen?: Mode) {
  return { version: VERSION, fingerprint: fp, strategyMemory: memoryView(host), memoryHit: warm, preferredOrder: order, chosen };
}

export async function resolveWithBeastIntelligence(request: Request, env: Env, url: URL, bodyText: string): Promise<Response> {
  let body: any = {};
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch {}
  let target: URL;
  try { target = publicUrl(String(body?.url ?? '')); } catch {
    const fallback = await workerResolve(request, env, url, body, String(body?.url ?? ''));
    return fallback.response;
  }

  const emptyFederation: Federation = { matches: [], storesChecked: 0, storesHealthy: 0, directoriesChecked: 1, directoriesHealthy: 0, knownSite: undefined };
  const [fp, federation] = await Promise.all([
    fingerprint(target),
    findFederatedSources(target).catch((): Federation => emptyFederation),
  ]);
  const host = hostOf(target.toString());
  const aidoku = federation.matches.filter((x) => x.ecosystem === 'aidoku');
  const planning = plan(host, fp.family, Boolean(fp.seedSeries), aidoku.length > 0);
  const workerMode: Mode = planning.order.find((x) => x !== 'aidoku-runtime') ?? 'direct-worker';
  const workerTarget = workerMode === 'family-seed' && fp.seedSeries ? fp.seedSeries : target.toString();

  const [worker, runtime] = await Promise.all([
    workerResolve(request, env, url, body, workerTarget),
    aidoku.length ? broker(env, target, aidoku) : Promise.resolve({ configured: Boolean(runtimeConfig(env).url), connected: Boolean(runtimeConfig(env).url), ready: false, executable: 0 } as BrokerResult),
  ]);
  const workerReady = Boolean(worker.payload?.ready && worker.payload?.adapter);
  if (workerReady) remember(host, fp.family, workerMode, true); else remember(host, fp.family, workerMode, false);
  if (runtime.executable) remember(host, fp.family, 'aidoku-runtime', runtime.ready);

  const preferRuntime = planning.order[0] === 'aidoku-runtime';
  if (runtime.ready && runtime.payload?.adapter && (!workerReady || preferRuntime)) {
    return json({
      ok: true,
      ready: true,
      route: 'federated-runtime',
      confidence: runtime.payload.confidence ?? 'high',
      score: runtime.payload.score ?? 98,
      adapter: runtime.payload.adapter,
      runtime: runtime.payload.runtime ?? 'aidoku-wasm',
      probe: runtime.payload.probe,
      evidence: mergeEvidence(worker.payload?.evidence, federation),
      federation: federationMeta(federation, runtime),
      intelligence: intelligence(fp, host, planning.order, planning.warm, 'aidoku-runtime'),
      message: runtime.payload.message ?? 'A maintained Aidoku implementation passed catalog → details → chapters → reader pages.',
    });
  }

  if (workerReady) {
    return json({
      ...worker.payload,
      evidence: mergeEvidence(worker.payload?.evidence, federation),
      federation: federationMeta(federation, runtime),
      intelligence: intelligence(fp, host, planning.order, planning.warm, workerMode),
    });
  }

  if (runtime.ready && runtime.payload?.adapter) {
    return json({
      ok: true,
      ready: true,
      route: 'federated-runtime',
      confidence: runtime.payload.confidence ?? 'high',
      score: runtime.payload.score ?? 98,
      adapter: runtime.payload.adapter,
      runtime: runtime.payload.runtime ?? 'aidoku-wasm',
      probe: runtime.payload.probe,
      evidence: mergeEvidence(worker.payload?.evidence, federation),
      federation: federationMeta(federation, runtime),
      intelligence: intelligence(fp, host, planning.order, planning.warm, 'aidoku-runtime'),
      message: runtime.payload.message,
    });
  }

  if (!worker.payload) return worker.response;
  const best = federation.matches[0];
  const attemptCount = Array.isArray(runtime.payload?.attempts) ? runtime.payload.attempts.length : 0;
  const detail = attemptCount ? `${attemptCount} Aidoku runtime attempt${attemptCount === 1 ? '' : 's'} failed the reader gauntlet.` : runtime.error;
  return json({
    ...worker.payload,
    ok: true,
    ready: false,
    route: federation.matches.length ? 'store-federation' : (worker.payload.route ?? 'adaptive-exhausted'),
    evidence: mergeEvidence(worker.payload.evidence, federation),
    federation: federationMeta(federation, runtime),
    intelligence: intelligence(fp, host, planning.order, planning.warm),
    runtime: best?.runtimeHint ?? worker.payload.runtime,
    message: federation.matches.length
      ? runtime.connected
        ? `Beast found ${best?.name ?? 'a maintained implementation'} and reached the runtime broker, but no implementation completed the full reader gauntlet.${detail ? ` ${detail}` : ''}`
        : `Beast found ${best?.name ?? 'a maintained implementation'}, but the remote runtime broker was unreachable. Safe Worker fallbacks were also exhausted.`
      : (worker.payload.message ?? 'Beast exhausted its safe Worker strategies.'),
  });
}
