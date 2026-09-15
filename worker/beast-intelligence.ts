import type { Env } from './index';
import { handleFabric } from './source-fabric-v7';
import { findFederatedSources } from './store-federation';
import type { FederatedMatch, KnownReadingSite } from './store-federation';

type FamilyName = 'madara' | 'tsreader' | 'wordpress' | 'nextjs' | 'nuxt' | 'api-first' | 'generic';
type StrategyMode = 'family-seed' | 'direct-worker' | 'aidoku-runtime';
type FamilyScore = { family: FamilyName; score: number; signals: string[] };

type Fingerprint = {
  primary: FamilyName;
  confidence: 'high' | 'medium' | 'low';
  ranked: FamilyScore[];
  seedSeries?: string;
  finalUrl?: string;
  access?: 'ok' | 'blocked' | 'unreachable';
};

type MemoryStat = { wins: number; failures: number; lastSuccess?: number; lastFailure?: number };
type HostMemory = {
  expires: number;
  family?: FamilyName;
  stats: Partial<Record<StrategyMode, MemoryStat>>;
};

type BrokerAttempt = {
  configured: boolean;
  connected: boolean;
  ready: boolean;
  payload?: any;
  error?: string;
  implementations: number;
};

const VERSION = '7.3-dev';
const UA = `Mozilla/5.0 (compatible; Yomu-Beast-Intelligence/${VERSION}; +https://yomu.yomuread.workers.dev)`;
const MAX_HTML = 900_000;
const FINGERPRINT_TIMEOUT_MS = 7_000;
const MEMORY_TTL_MS = 45 * 60_000;
const MAX_MEMORY_HOSTS = 256;
const memory = new Map<string, HostMemory>();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-yomu-beast-intelligence': VERSION,
  },
});

function hostOf(input: string): string {
  try { return new URL(input).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return /^(::1|fc|fd|fe80)/i.test(h);
}

function publicUrl(value: string): URL {
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || isPrivateHost(url.hostname)) {
    throw new Error('Paste a normal public http/https reading-site URL.');
  }
  url.hash = '';
  return url;
}

function sameSite(a: string, b: string): boolean {
  const left = hostOf(a);
  const right = hostOf(b);
  return !!left && !!right && (left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`));
}

function blockedHtml(status: number, html: string): boolean {
  if (status === 401 || status === 403) return true;
  return /cf-chl-|challenge-platform|cloudflare ray id|checking your browser|just a moment\.\.\.|g-recaptcha|hcaptcha-container/i.test(html.slice(0, 100_000));
}

function addScore(scores: Map<FamilyName, FamilyScore>, family: FamilyName, points: number, signal: string) {
  const row = scores.get(family) ?? { family, score: 0, signals: [] };
  row.score += points;
  if (!row.signals.includes(signal)) row.signals.push(signal);
  scores.set(family, row);
}

function seriesSeed(html: string, base: string): string | undefined {
  const candidates: Array<{ url: string; score: number }> = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
    const raw = String(match[2] ?? '').replace(/&amp;/gi, '&').trim();
    if (!raw || /^(javascript:|mailto:|tel:|#)/i.test(raw)) continue;
    let url: URL;
    try { url = new URL(raw, base); } catch { continue; }
    if (!sameSite(url.toString(), base)) continue;
    const path = url.pathname;
    if (/\/(chapter|chapters?|read|reader|episode|ep[-_/]?\d|ch[-_/]?\d)\b/i.test(path)) continue;
    let score = 0;
    if (/\/(manga|manhwa|manhua|series|webtoon|comic|title|book|novel)\//i.test(path)) score += 8;
    if (/\/(manga|series|comic)\/[a-z0-9][a-z0-9_-]{2,}/i.test(path)) score += 4;
    const depth = path.replace(/\/$/, '').split('/').filter(Boolean).length;
    if (depth >= 2) score += 2;
    if (/\/(tag|genre|author|search|login|register|privacy|terms)(\/|$)/i.test(path)) score -= 10;
    if (score > 0) candidates.push({ url: url.toString(), score });
    if (candidates.length >= 300) break;
  }
  candidates.sort((a, b) => b.score - a.score || a.url.length - b.url.length);
  return candidates[0]?.url;
}

function fingerprintHtml(html: string, finalUrl: string): Fingerprint {
  const scores = new Map<FamilyName, FamilyScore>();
  const lower = html.toLowerCase();

  if (/wp-manga|manga-chapters-holder|manga_get_chapters|listing-chapters_wrap|madara-core|madara-js/i.test(html)) {
    addScore(scores, 'madara', 12, 'madara markup');
  }
  if (/\/ajax\/chapters\/?|manga-ajax|wp-admin\/admin-ajax\.php/i.test(html)) {
    addScore(scores, 'madara', 6, 'madara ajax');
  }
  if (/ts_reader\.run|ts-reader|readerarea|chapter_preloaded_images/i.test(html)) {
    addScore(scores, 'tsreader', 12, 'tsreader payload');
  }
  if (/__next_data__|\/_next\//i.test(html)) {
    addScore(scores, 'nextjs', 11, 'next.js state');
  }
  if (/__nuxt__|\/_nuxt\//i.test(html)) {
    addScore(scores, 'nuxt', 11, 'nuxt state');
  }
  if (/wp-content|wp-includes|api\.w\.org|\/wp-json\//i.test(html)) {
    addScore(scores, 'wordpress', 8, 'wordpress markers');
  }
  if (/api\.mangadex\.org|graphql|\/api\/(?:v\d+\/)?(?:manga|series|chapter)|application\/json/i.test(lower)) {
    addScore(scores, 'api-first', 5, 'public api hints');
  }
  // Madara is a WordPress family; preserve the hybrid signal rather than
  // pretending one label explains the whole site.
  if ((scores.get('madara')?.score ?? 0) > 0) addScore(scores, 'wordpress', 3, 'madara wordpress parent');

  const ranked = [...scores.values()].sort((a, b) => b.score - a.score || a.family.localeCompare(b.family));
  const first = ranked[0];
  const primary: FamilyName = first && first.score >= 4 ? first.family : 'generic';
  const confidence = !first || first.score < 4 ? 'low' : first.score >= 11 ? 'high' : 'medium';
  return { primary, confidence, ranked, seedSeries: seriesSeed(html, finalUrl), finalUrl, access: 'ok' };
}

async function fingerprint(target: URL): Promise<Fingerprint> {
  try {
    const response = await fetch(target.toString(), {
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.4',
        'accept-language': 'en-US,en;q=0.8',
        'user-agent': UA,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FINGERPRINT_TIMEOUT_MS),
    });
    const finalUrl = response.url || target.toString();
    if (!sameSite(finalUrl, target.toString())) return { primary: 'generic', confidence: 'low', ranked: [], access: 'unreachable' };
    const html = (await response.text()).slice(0, MAX_HTML);
    if (blockedHtml(response.status, html)) return { primary: 'generic', confidence: 'low', ranked: [], finalUrl, access: 'blocked' };
    if (!response.ok) return { primary: 'generic', confidence: 'low', ranked: [], finalUrl, access: 'unreachable' };
    return fingerprintHtml(html, finalUrl);
  } catch {
    return { primary: 'generic', confidence: 'low', ranked: [], access: 'unreachable' };
  }
}

function getMemory(host: string): HostMemory | undefined {
  const row = memory.get(host);
  if (!row) return undefined;
  if (row.expires <= Date.now()) {
    memory.delete(host);
    return undefined;
  }
  return row;
}

function ensureMemory(host: string): HostMemory {
  let row = getMemory(host);
  if (!row) {
    if (memory.size >= MAX_MEMORY_HOSTS) {
      const oldest = memory.keys().next().value;
      if (oldest) memory.delete(oldest);
    }
    row = { expires: Date.now() + MEMORY_TTL_MS, stats: {} };
    memory.set(host, row);
  }
  row.expires = Date.now() + MEMORY_TTL_MS;
  return row;
}

function remember(host: string, family: FamilyName, mode: StrategyMode, ok: boolean) {
  const row = ensureMemory(host);
  row.family = family;
  const stat = row.stats[mode] ?? { wins: 0, failures: 0 };
  if (ok) {
    stat.wins += 1;
    stat.lastSuccess = Date.now();
  } else {
    stat.failures += 1;
    stat.lastFailure = Date.now();
  }
  row.stats[mode] = stat;
}

function modeBase(mode: StrategyMode, family: FamilyName, hasSeed: boolean, hasAidoku: boolean): number {
  if (mode === 'family-seed') {
    if (!hasSeed) return -100;
    return family === 'madara' || family === 'tsreader' || family === 'nextjs' || family === 'nuxt' ? 11 : 7;
  }
  if (mode === 'aidoku-runtime') return hasAidoku ? (family === 'api-first' || family === 'generic' ? 12 : 8) : -100;
  return family === 'generic' ? 10 : 8;
}

function modeOrder(host: string, family: FamilyName, hasSeed: boolean, hasAidoku: boolean): { order: StrategyMode[]; memoryHit: boolean } {
  const row = getMemory(host);
  const candidates: StrategyMode[] = ['family-seed', 'direct-worker', 'aidoku-runtime'];
  const now = Date.now();
  const scored = candidates.map((mode) => {
    const stat = row?.stats[mode];
    let score = modeBase(mode, family, hasSeed, hasAidoku);
    if (stat) {
      score += stat.wins * 5 - stat.failures * 2;
      if (stat.lastSuccess && now - stat.lastSuccess < 20 * 60_000) score += 4;
    }
    return { mode, score };
  }).filter((row) => row.score > -50).sort((a, b) => b.score - a.score);
  return { order: scored.map((x) => x.mode), memoryHit: Boolean(row && Object.keys(row.stats).length) };
}

function memorySnapshot(host: string) {
  const row = getMemory(host);
  if (!row) return { warm: false };
  const compact: Record<string, unknown> = {};
  for (const [mode, stat] of Object.entries(row.stats)) {
    if (!stat) continue;
    compact[mode] = { wins: stat.wins, failures: stat.failures, lastSuccess: stat.lastSuccess };
  }
  return { warm: true, family: row.family, expiresAt: row.expires, strategies: compact };
}

function runtimeConfig(env: Env): { url?: string; token?: string } {
  const row = env as Env & { SOURCE_RUNTIME_URL?: string; SOURCE_RUNTIME_TOKEN?: string };
  const raw = String(row.SOURCE_RUNTIME_URL ?? '').trim();
  if (!raw) return {};
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol)) return {};
    return { url: url.toString().replace(/\/+$/, ''), token: String(row.SOURCE_RUNTIME_TOKEN ?? '').trim() || undefined };
  } catch { return {}; }
}

function safeAidokuArtifact(match: FederatedMatch): string | undefined {
  if (match.artifact && /^[a-z0-9_./-]+\.aix(?:[?#].*)?$/i.test(match.artifact) && !match.artifact.includes('..')) return match.artifact;
  if (match.storeId !== 'aidoku-community') return undefined;
  const id = String(match.id ?? '');
  const version = String(match.version ?? '');
  if (!/^[a-z0-9._-]{2,100}$/i.test(id) || !/^\d{1,8}$/.test(version)) return undefined;
  return `sources/${id}-v${version}.aix`;
}

function evidence(match: FederatedMatch) {
  return {
    ecosystem: match.ecosystem,
    store: match.storeName,
    storeId: match.storeId,
    name: match.name,
    id: match.id,
    version: match.version,
    package: match.package,
    baseUrl: match.baseUrl,
    artifact: match.ecosystem === 'aidoku' ? safeAidokuArtifact(match) : match.artifact,
    sourceCodeUrl: match.sourceCodeUrl,
    language: match.language,
    runtimeHint: match.runtimeHint,
    hasCloudflare: match.hasCloudflare,
  };
}

function knownEvidence(site?: KnownReadingSite) {
  return site ? { source: site.source, name: site.name, baseUrl: site.baseUrl, library: site.library, category: site.category, directory: site.directory } : undefined;
}

async function tryAidokuBroker(env: Env, target: URL, matches: FederatedMatch[]): Promise<BrokerAttempt> {
  const config = runtimeConfig(env);
  const aidoku = matches
    .filter((match) => match.ecosystem === 'aidoku' && match.runtimeHint === 'aidoku-wasm')
    .map((match) => ({ ...match, artifact: safeAidokuArtifact(match) }))
    .filter((match) => Boolean(match.artifact))
    .slice(0, 6);
  if (!config.url) return { configured: false, connected: false, ready: false, implementations: aidoku.length };
  if (!aidoku.length) return { configured: true, connected: true, ready: false, implementations: 0 };
  try {
    const response = await fetch(`${config.url}/v1/resolve`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': UA,
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({ targetUrl: target.toString(), implementations: aidoku.map(evidence) }),
      signal: AbortSignal.timeout(38_000),
    });
    const payload: any = await response.json().catch(() => null);
    if (!payload) return { configured: true, connected: true, ready: false, error: `Runtime returned HTTP ${response.status} without JSON.`, implementations: aidoku.length };
    return { configured: true, connected: true, ready: Boolean(payload.ready && payload.adapter), payload, implementations: aidoku.length };
  } catch (error: any) {
    return { configured: true, connected: false, ready: false, error: String(error?.message ?? error).slice(0, 320), implementations: aidoku.length };
  }
}

function mergeEvidence(existing: any[], matches: FederatedMatch[], known?: KnownReadingSite): any[] {
  const rows = [...(Array.isArray(existing) ? existing : []), ...matches.map(evidence)];
  if (known) rows.push({ ecosystem: 'directory', store: 'Wotaku Websites', ...knownEvidence(known) });
  const out: any[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row?.ecosystem ?? ''}|${row?.storeId ?? row?.store ?? ''}|${row?.id ?? row?.package ?? row?.name ?? ''}|${row?.baseUrl ?? ''}`;
    if (!key.replace(/\|/g, '') || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out.slice(0, 28);
}

async function workerResolve(request: Request, env: Env, url: URL, body: any, targetUrl: string): Promise<{ response: Response; payload: any; elapsedMs: number }> {
  const started = Date.now();
  const next = new Request(url.toString(), {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify({ ...body, url: targetUrl }),
  });
  const response = await handleFabric(next, env, url);
  const payload = await response.clone().json().catch(() => null);
  return { response, payload, elapsedMs: Date.now() - started };
}

function intelligenceBlock(fp: Fingerprint, host: string, order: StrategyMode[], memoryHit: boolean, chosen?: StrategyMode) {
  return {
    version: VERSION,
    fingerprint: fp,
    strategyMemory: memorySnapshot(host),
    memoryHit,
    preferredOrder: order,
    chosen,
  };
}

export async function resolveWithBeastIntelligence(request: Request, env: Env, url: URL, bodyText: string): Promise<Response> {
  let body: any = {};
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = {}; }
  let target: URL;
  try { target = publicUrl(String(body?.url ?? '')); } catch {
    const fallback = await workerResolve(request, env, url, body, String(body?.url ?? ''));
    return fallback.response;
  }

  const [fp, federationResult] = await Promise.all([
    fingerprint(target),
    findFederatedSources(target).catch(() => ({ matches: [] as FederatedMatch[], storesChecked: 0, storesHealthy: 0, directoriesChecked: 1, directoriesHealthy: 0 })),
  ]);
  const host = hostOf(target.toString());
  const aidokuMatches = federationResult.matches.filter((match) => match.ecosystem === 'aidoku');
  const planning = modeOrder(host, fp.primary, Boolean(fp.seedSeries), aidokuMatches.length > 0);
  const preferredWorkerMode = planning.order.find((mode) => mode === 'family-seed' || mode === 'direct-worker') ?? 'direct-worker';
  const workerUrl = preferredWorkerMode === 'family-seed' && fp.seedSeries ? fp.seedSeries : target.toString();

  // Run the proven Worker engine and the executable Aidoku runtime concurrently.
  // This keeps the source-panel request inside its existing timeout while still
  // allowing either weapon to win the gauntlet.
  const workerPromise = workerResolve(request, env, url, body, workerUrl);
  const brokerPromise = aidokuMatches.length ? tryAidokuBroker(env, target, aidokuMatches) : Promise.resolve({ configured: Boolean(runtimeConfig(env).url), connected: Boolean(runtimeConfig(env).url), ready: false, implementations: 0 } as BrokerAttempt);
  const [worker, broker] = await Promise.all([workerPromise, brokerPromise]);

  const workerReady = Boolean(worker.payload?.ready && worker.payload?.adapter);
  if (workerReady) {
    remember(host, fp.primary, preferredWorkerMode, true);
    if (broker.implementations) remember(host, fp.primary, 'aidoku-runtime', broker.ready);
    const evidenceRows = mergeEvidence(worker.payload?.evidence, federationResult.matches, federationResult.knownSite);
    return json({
      ...worker.payload,
      evidence: evidenceRows,
      federation: {
        version: VERSION,
        storesChecked: federationResult.storesChecked,
        storesHealthy: federationResult.storesHealthy,
        directoriesChecked: federationResult.directoriesChecked,
        directoriesHealthy: federationResult.directoriesHealthy,
        implementations: federationResult.matches.length,
        best: federationResult.matches[0] ? evidence(federationResult.matches[0]) : undefined,
        discovery: knownEvidence(federationResult.knownSite),
        runtimeBrokerConfigured: broker.configured,
        runtimeBrokerConnected: broker.connected,
        aidokuExecutable: broker.implementations,
      },
      intelligence: intelligenceBlock(fp, host, planning.order, planning.memoryHit, preferredWorkerMode),
    });
  }
  remember(host, fp.primary, preferredWorkerMode, false);

  if (broker.ready && broker.payload?.adapter) {
    remember(host, fp.primary, 'aidoku-runtime', true);
    return json({
      ok: true,
      ready: true,
      route: 'federated-runtime',
      confidence: broker.payload.confidence ?? 'high',
      score: broker.payload.score ?? 98,
      adapter: broker.payload.adapter,
      runtime: broker.payload.runtime ?? 'aidoku-wasm',
      probe: broker.payload.probe,
      evidence: mergeEvidence(worker.payload?.evidence, federationResult.matches, federationResult.knownSite),
      federation: {
        version: VERSION,
        storesChecked: federationResult.storesChecked,
        storesHealthy: federationResult.storesHealthy,
        directoriesChecked: federationResult.directoriesChecked,
        directoriesHealthy: federationResult.directoriesHealthy,
        implementations: federationResult.matches.length,
        best: federationResult.matches[0] ? evidence(federationResult.matches[0]) : undefined,
        discovery: knownEvidence(federationResult.knownSite),
        runtimeBrokerConfigured: broker.configured,
        runtimeBrokerConnected: broker.connected,
        aidokuExecutable: broker.implementations,
        runtimeAttempts: broker.payload?.attempts,
      },
      intelligence: intelligenceBlock(fp, host, planning.order, planning.memoryHit, 'aidoku-runtime'),
      message: broker.payload.message ?? 'A maintained Aidoku implementation passed catalog → details → chapters → reader pages.',
    });
  }
  if (broker.implementations) remember(host, fp.primary, 'aidoku-runtime', false);

  const evidenceRows = mergeEvidence(worker.payload?.evidence, federationResult.matches, federationResult.knownSite);
  const best = federationResult.matches[0];
  const brokerDetail = broker.payload?.attempts?.length
    ? `${broker.payload.attempts.length} Aidoku runtime attempt${broker.payload.attempts.length === 1 ? '' : 's'} failed the reader gauntlet.`
    : broker.error;
  return json({
    ...(worker.payload ?? { ok: true, ready: false, route: 'adaptive-exhausted' }),
    ok: true,
    ready: false,
    route: federationResult.matches.length ? 'store-federation' : (worker.payload?.route ?? 'adaptive-exhausted'),
    evidence: evidenceRows,
    federation: {
      version: VERSION,
      storesChecked: federationResult.storesChecked,
      storesHealthy: federationResult.storesHealthy,
      directoriesChecked: federationResult.directoriesChecked,
      directoriesHealthy: federationResult.directoriesHealthy,
      implementations: federationResult.matches.length,
      best: best ? evidence(best) : undefined,
      discovery: knownEvidence(federationResult.knownSite),
      runtimeBrokerConfigured: broker.configured,
      runtimeBrokerConnected: broker.connected,
      aidokuExecutable: broker.implementations,
      runtimeAttempts: broker.payload?.attempts,
      runtimeError: brokerDetail,
    },
    intelligence: intelligenceBlock(fp, host, planning.order, planning.memoryHit),
    runtime: best?.runtimeHint ?? worker.payload?.runtime,
    message: federationResult.matches.length
      ? broker.connected
        ? `Beast found ${best?.name ?? 'a maintained source implementation'} and reached the runtime broker, but no implementation completed the full reader gauntlet.${brokerDetail ? ` ${brokerDetail}` : ''}`
        : `Beast found ${best?.name ?? 'a maintained source implementation'}, but the remote runtime broker was unreachable. Safe Worker fallbacks were also exhausted.`
      : (worker.payload?.message ?? 'Beast exhausted its safe Worker strategies.'),
  });
}
