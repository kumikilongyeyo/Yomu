import type { Env } from './index';

type Ecosystem = 'aidoku' | 'mihon' | 'mangayomi';

type StoreDefinition = {
  id: string;
  name: string;
  ecosystem: Ecosystem;
  url: string;
  priority: number;
  directory?: string;
};

export type FederatedMatch = {
  ecosystem: Ecosystem;
  storeId: string;
  storeName: string;
  name: string;
  baseUrl: string;
  id?: string;
  version?: string;
  package?: string;
  artifact?: string;
  sourceCodeUrl?: string;
  language?: string;
  hasCloudflare?: boolean;
  runtimeHint: 'aidoku-wasm' | 'mihon-android' | 'mangayomi-script';
  priority: number;
};

const STORE_DEFINITIONS: StoreDefinition[] = [
  { id: 'aidoku-yomu-community', name: 'Yomu Aidoku Sources', ecosystem: 'aidoku', url: 'https://smexhy.github.io/yomu-aidoku-sources/index.json', priority: 100 },
  { id: 'aidoku-community', name: 'Aidoku Community', ecosystem: 'aidoku', url: 'https://aidoku-community.github.io/sources/index.min.json', priority: 90 },
  { id: 'mangayomi-community', name: 'Mangayomi Community', ecosystem: 'mangayomi', url: 'https://raw.githubusercontent.com/m2k3a/mangayomi-extensions/main/index.json', priority: 82 },
  { id: 'mihon-keiyoushi', name: 'Keiyoushi', ecosystem: 'mihon', url: 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json', priority: 100, directory: 'https://wotaku.wiki/ext/mihon' },
  { id: 'mihon-yuzono', name: 'Yuzono', ecosystem: 'mihon', url: 'https://raw.githubusercontent.com/yuzono/cursed-manga-repo/repo/index.min.json', priority: 92, directory: 'https://wotaku.wiki/ext/mihon' },
];

const UA = 'Mozilla/5.0 (compatible; Yomu-Store-Federation/6.0; +https://yomu.yomuread.workers.dev)';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function normalizeHost(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function normalizeInput(value: string): URL {
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Paste a public website URL.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^(::1|fc|fd|fe80)/i.test(host)) {
    throw new Error('Local/private network addresses cannot be added as Yomu sources.');
  }
  url.hash = '';
  return url;
}

function hostMatch(baseUrl: string, targetHost: string): number {
  const baseHost = normalizeHost(baseUrl);
  if (!baseHost) return 0;
  if (baseHost === targetHost) return 3;
  if (targetHost.endsWith(`.${baseHost}`)) return 2;
  if (baseHost.endsWith(`.${targetHost}`)) return 1;
  return 0;
}

async function fetchStore(store: StoreDefinition): Promise<any> {
  const response = await fetch(store.url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(9_000) });
  if (!response.ok) throw new Error(`${store.name} returned HTTP ${response.status}.`);
  return response.json();
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function parseAidoku(store: StoreDefinition, document: any): FederatedMatch[] {
  const rows = Array.isArray(document) ? document : Array.isArray(document?.sources) ? document.sources : [];
  return rows.flatMap((source: any) => {
    const baseUrl = stringValue(source?.baseURL ?? source?.baseUrl ?? source?.website ?? source?.url);
    if (!baseUrl) return [];
    return [{ ecosystem: 'aidoku' as const, storeId: store.id, storeName: store.name, name: String(source?.name ?? source?.id ?? normalizeHost(baseUrl)), baseUrl, id: stringValue(source?.id), version: stringValue(source?.version), artifact: stringValue(source?.downloadURL ?? source?.downloadUrl), language: Array.isArray(source?.languages) ? source.languages.join(',') : stringValue(source?.lang), runtimeHint: 'aidoku-wasm' as const, priority: store.priority }];
  });
}

function parseMihon(store: StoreDefinition, document: any): FederatedMatch[] {
  const extensions = Array.isArray(document) ? document : Array.isArray(document?.extensions) ? document.extensions : [];
  const out: FederatedMatch[] = [];
  for (const ext of extensions) {
    const sources = Array.isArray(ext?.sources) && ext.sources.length ? ext.sources : [ext];
    for (const source of sources) {
      const baseUrl = stringValue(source?.baseUrl ?? source?.baseURL ?? source?.website ?? ext?.baseUrl ?? ext?.baseURL);
      if (!baseUrl) continue;
      out.push({ ecosystem: 'mihon', storeId: store.id, storeName: store.name, name: String(source?.name ?? ext?.name ?? normalizeHost(baseUrl)), baseUrl, id: stringValue(source?.id), version: stringValue(ext?.version ?? ext?.versionName ?? ext?.code), package: stringValue(ext?.pkg ?? ext?.packageName ?? ext?.package), artifact: stringValue(ext?.apk ?? ext?.downloadURL ?? ext?.downloadUrl), language: stringValue(source?.lang ?? ext?.lang), runtimeHint: 'mihon-android', priority: store.priority });
    }
  }
  return out;
}

function parseMangayomi(store: StoreDefinition, document: any): FederatedMatch[] {
  const rows = Array.isArray(document) ? document : Array.isArray(document?.sources) ? document.sources : [];
  return rows.flatMap((source: any) => {
    if (source?.isManga === false) return [];
    const baseUrl = stringValue(source?.baseUrl ?? source?.baseURL ?? source?.website ?? source?.url);
    if (!baseUrl) return [];
    return [{ ecosystem: 'mangayomi' as const, storeId: store.id, storeName: store.name, name: String(source?.name ?? source?.id ?? normalizeHost(baseUrl)), baseUrl, id: stringValue(source?.id), version: stringValue(source?.version), sourceCodeUrl: stringValue(source?.sourceCodeUrl), language: stringValue(source?.lang), hasCloudflare: Boolean(source?.hasCloudflare), runtimeHint: 'mangayomi-script' as const, priority: store.priority }];
  });
}

function parseStore(store: StoreDefinition, document: any): FederatedMatch[] {
  if (store.ecosystem === 'aidoku') return parseAidoku(store, document);
  if (store.ecosystem === 'mihon') return parseMihon(store, document);
  return parseMangayomi(store, document);
}

function rankMatch(match: FederatedMatch, targetHost: string): number {
  const hostScore = hostMatch(match.baseUrl, targetHost) * 1000;
  const portability = match.ecosystem === 'aidoku' ? 90 : match.ecosystem === 'mangayomi' ? 65 : 45;
  const artifact = match.artifact || match.sourceCodeUrl ? 20 : 0;
  const protectedPenalty = match.hasCloudflare ? -5 : 0;
  return hostScore + match.priority + portability + artifact + protectedPenalty;
}

export async function findFederatedSources(target: URL): Promise<{ matches: FederatedMatch[]; storesChecked: number; storesHealthy: number }> {
  const targetHost = target.hostname.toLowerCase().replace(/^www\./, '');
  const settled = await Promise.allSettled(STORE_DEFINITIONS.map(async (store) => ({ store, rows: parseStore(store, await fetchStore(store)) })));
  const all: FederatedMatch[] = [];
  let storesHealthy = 0;
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    storesHealthy += 1;
    for (const row of result.value.rows) if (hostMatch(row.baseUrl, targetHost)) all.push(row);
  }
  const seen = new Set<string>();
  const matches = all.sort((a, b) => rankMatch(b, targetHost) - rankMatch(a, targetHost)).filter((row) => {
    const key = `${row.ecosystem}|${row.storeId}|${row.id ?? row.name}|${normalizeHost(row.baseUrl)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
  return { matches, storesChecked: STORE_DEFINITIONS.length, storesHealthy };
}

function publicEvidence(match: FederatedMatch) {
  return { ecosystem: match.ecosystem, store: match.storeName, storeId: match.storeId, name: match.name, id: match.id, version: match.version, package: match.package, baseUrl: match.baseUrl, artifact: match.artifact, sourceCodeUrl: match.sourceCodeUrl, language: match.language, runtimeHint: match.runtimeHint, hasCloudflare: match.hasCloudflare };
}

function mergeEvidence(existing: any[], matches: FederatedMatch[]): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const row of [...(Array.isArray(existing) ? existing : []), ...matches.map(publicEvidence)]) {
    const key = `${row?.ecosystem ?? ''}|${row?.storeId ?? row?.store ?? ''}|${row?.id ?? row?.package ?? row?.name ?? ''}|${row?.baseUrl ?? ''}`;
    if (!key.replace(/\|/g, '') || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out.slice(0, 24);
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

async function tryRuntimeBroker(env: Env, target: URL, matches: FederatedMatch[]): Promise<any | null> {
  const config = runtimeConfig(env);
  if (!config.url || !matches.length) return null;
  const response = await fetch(`${config.url}/v1/resolve`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA, ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) }, body: JSON.stringify({ targetUrl: target.toString(), implementations: matches.slice(0, 8).map(publicEvidence) }), signal: AbortSignal.timeout(45_000) });
  if (!response.ok) return null;
  const payload: any = await response.json().catch(() => null);
  if (!payload?.ready || !payload?.adapter) return null;
  return payload;
}

export async function handleFederatedResolve(bodyText: string, env: Env, url: URL, fallbackResponsePromise: Promise<Response>): Promise<Response> {
  let body: any = {};
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = {}; }
  let target: URL;
  try { target = normalizeInput(String(body?.url ?? '')); } catch { return fallbackResponsePromise; }
  const federationPromise = findFederatedSources(target);
  const [{ matches, storesChecked, storesHealthy }, fallbackResponse] = await Promise.all([federationPromise, fallbackResponsePromise]);
  const fallbackPayload: any = await fallbackResponse.clone().json().catch(() => null);
  if (!fallbackPayload) return fallbackResponse;
  const evidence = mergeEvidence(fallbackPayload.evidence, matches);
  const best = matches[0];
  const federation = { version: '6.0', storesChecked, storesHealthy, implementations: matches.length, best: best ? publicEvidence(best) : undefined, runtimeBrokerConfigured: Boolean(runtimeConfig(env).url) };
  if (fallbackPayload.ready && fallbackPayload.adapter) return json({ ...fallbackPayload, evidence, federation });
  if (matches.length) {
    const broker = await tryRuntimeBroker(env, target, matches).catch(() => null);
    if (broker?.ready && broker?.adapter) {
      return json({ ok: true, ready: true, route: 'federated-runtime', confidence: broker.confidence ?? 'high', score: broker.score ?? 95, adapter: broker.adapter, evidence, federation, runtime: broker.runtime ?? best.runtimeHint, message: broker.message ?? `${best.name} is running through the remote ${best.runtimeHint} runtime.` });
    }
    return json({ ...fallbackPayload, ok: true, ready: false, route: 'store-federation', evidence, federation, runtime: best.runtimeHint, message: `Found ${best.name} in ${best.storeName}. Yomu knows the maintained implementation, but the remote ${best.runtimeHint} runner is not connected yet.` });
  }
  return json({ ...fallbackPayload, evidence, federation });
}

export async function handleStoreFederation(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/api/fabric/stores/status') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    const config = runtimeConfig(env);
    return json({ ok: true, version: '6.0', runtimeBrokerConfigured: Boolean(config.url), stores: STORE_DEFINITIONS.map(({ id, name, ecosystem, priority, directory }) => ({ id, name, ecosystem, priority, directory })) });
  }
  if (url.pathname === '/api/fabric/stores/lookup') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    let target: URL;
    try { target = normalizeInput(url.searchParams.get('url') ?? ''); } catch (error: any) { return json({ error: error?.message ?? 'Invalid URL.' }, 400); }
    const result = await findFederatedSources(target);
    return json({ ok: true, target: target.toString(), ...result, matches: result.matches.map(publicEvidence) });
  }
  return json({ error: 'Unknown Store Federation route.' }, 404);
}
