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

export type KnownReadingSite = {
  source: 'wotaku-websites';
  name: string;
  baseUrl: string;
  library?: string;
  category: 'manga';
  directory: string;
};

const STORE_DEFINITIONS: StoreDefinition[] = [
  { id: 'aidoku-yomu-community', name: 'Yomu Aidoku Sources', ecosystem: 'aidoku', url: 'https://smexhy.github.io/yomu-aidoku-sources/index.json', priority: 100 },
  { id: 'aidoku-community', name: 'Aidoku Community', ecosystem: 'aidoku', url: 'https://aidoku-community.github.io/sources/index.min.json', priority: 90 },
  { id: 'mangayomi-community', name: 'Mangayomi Community', ecosystem: 'mangayomi', url: 'https://raw.githubusercontent.com/m2k3a/mangayomi-extensions/main/index.json', priority: 82 },
  { id: 'mihon-keiyoushi', name: 'Keiyoushi', ecosystem: 'mihon', url: 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json', priority: 100, directory: 'https://wotaku.wiki/ext/mihon' },
  { id: 'mihon-yuzono', name: 'Yuzono', ecosystem: 'mihon', url: 'https://raw.githubusercontent.com/yuzono/cursed-manga-repo/repo/index.min.json', priority: 92, directory: 'https://wotaku.wiki/ext/mihon' },
];

const WOTAKU_DIRECTORY = {
  id: 'wotaku-websites',
  name: 'Wotaku Websites',
  page: 'https://wotaku.wiki/websites',
  source: 'https://raw.githubusercontent.com/wotakumoe/wotaku/main/docs/websites.md',
};

const UA = 'Mozilla/5.0 (compatible; Yomu-Store-Federation/6.1; +https://yomu.yomuread.workers.dev)';
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

async function fetchWotakuDirectory(): Promise<KnownReadingSite[]> {
  const response = await fetch(WOTAKU_DIRECTORY.source, { headers: { accept: 'text/plain, text/markdown;q=0.9, */*;q=0.5', 'user-agent': UA }, signal: AbortSignal.timeout(7_000) });
  if (!response.ok) throw new Error(`${WOTAKU_DIRECTORY.name} returned HTTP ${response.status}.`);
  return parseWotakuMangaMarkdown(await response.text());
}

function parseWotakuMangaMarkdown(markdown: string): KnownReadingSite[] {
  const header = markdown.search(/^##\s+Manga\s*$/m);
  if (header < 0) return [];
  const firstBreak = markdown.indexOf('\n', header);
  if (firstBreak < 0) return [];
  const tail = markdown.slice(firstBreak + 1);
  const nextSection = tail.search(/^##\s+/m);
  const section = nextSection >= 0 ? tail.slice(0, nextSection) : tail;
  const rows: KnownReadingSite[] = [];
  const seen = new Set<string>();

  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const websiteCell = cells[1] ?? '';
    const link = websiteCell.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/i);
    if (!link) continue;
    const name = link[1].trim();
    const baseUrl = link[2].trim();
    const host = normalizeHost(baseUrl);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    const libraryRaw = (cells[2] ?? '').replace(/==[^=]+==/g, '').replace(/[*_`]/g, '').trim();
    rows.push({ source: 'wotaku-websites', name, baseUrl, library: libraryRaw || undefined, category: 'manga', directory: WOTAKU_DIRECTORY.page });
  }
  return rows;
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

function bestKnownSite(rows: KnownReadingSite[], targetHost: string): KnownReadingSite | undefined {
  return rows
    .map((site) => ({ site, score: hostMatch(site.baseUrl, targetHost) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.site.name.localeCompare(b.site.name))[0]?.site;
}

export async function findFederatedSources(target: URL): Promise<{
  matches: FederatedMatch[];
  storesChecked: number;
  storesHealthy: number;
  directoriesChecked: number;
  directoriesHealthy: number;
  knownSite?: KnownReadingSite;
}> {
  const targetHost = target.hostname.toLowerCase().replace(/^www\./, '');
  const storesPromise = Promise.allSettled(STORE_DEFINITIONS.map(async (store) => ({ store, rows: parseStore(store, await fetchStore(store)) })));
  const directoryPromise = fetchWotakuDirectory().then((rows) => ({ healthy: true, rows })).catch(() => ({ healthy: false, rows: [] as KnownReadingSite[] }));
  const [settled, directory] = await Promise.all([storesPromise, directoryPromise]);
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
  return {
    matches,
    storesChecked: STORE_DEFINITIONS.length,
    storesHealthy,
    directoriesChecked: 1,
    directoriesHealthy: directory.healthy ? 1 : 0,
    knownSite: bestKnownSite(directory.rows, targetHost),
  };
}

function publicEvidence(match: FederatedMatch) {
  return { ecosystem: match.ecosystem, store: match.storeName, storeId: match.storeId, name: match.name, id: match.id, version: match.version, package: match.package, baseUrl: match.baseUrl, artifact: match.artifact, sourceCodeUrl: match.sourceCodeUrl, language: match.language, runtimeHint: match.runtimeHint, hasCloudflare: match.hasCloudflare };
}

function publicKnownSite(site: KnownReadingSite) {
  return { source: site.source, name: site.name, baseUrl: site.baseUrl, library: site.library, category: site.category, directory: site.directory };
}

function mergeEvidence(existing: any[], matches: FederatedMatch[], knownSite?: KnownReadingSite): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  const discovery = knownSite ? [{ ecosystem: 'directory', store: WOTAKU_DIRECTORY.name, storeId: WOTAKU_DIRECTORY.id, ...publicKnownSite(knownSite) }] : [];
  for (const row of [...(Array.isArray(existing) ? existing : []), ...matches.map(publicEvidence), ...discovery]) {
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
  const [federationResult, fallbackResponse] = await Promise.all([federationPromise, fallbackResponsePromise]);
  const { matches, storesChecked, storesHealthy, directoriesChecked, directoriesHealthy, knownSite } = federationResult;
  const fallbackPayload: any = await fallbackResponse.clone().json().catch(() => null);
  if (!fallbackPayload) return fallbackResponse;
  const evidence = mergeEvidence(fallbackPayload.evidence, matches, knownSite);
  const best = matches[0];
  const federation = {
    version: '6.1',
    storesChecked,
    storesHealthy,
    directoriesChecked,
    directoriesHealthy,
    implementations: matches.length,
    best: best ? publicEvidence(best) : undefined,
    discovery: knownSite ? publicKnownSite(knownSite) : undefined,
    runtimeBrokerConfigured: Boolean(runtimeConfig(env).url),
  };
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
    return json({
      ok: true,
      version: '6.1',
      runtimeBrokerConfigured: Boolean(config.url),
      stores: STORE_DEFINITIONS.map(({ id, name, ecosystem, priority, directory }) => ({ id, name, ecosystem, priority, directory })),
      directories: [{ id: WOTAKU_DIRECTORY.id, name: WOTAKU_DIRECTORY.name, page: WOTAKU_DIRECTORY.page, source: WOTAKU_DIRECTORY.source, role: 'discovery-only' }],
    });
  }
  if (url.pathname === '/api/fabric/stores/lookup') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    let target: URL;
    try { target = normalizeInput(url.searchParams.get('url') ?? ''); } catch (error: any) { return json({ error: error?.message ?? 'Invalid URL.' }, 400); }
    const result = await findFederatedSources(target);
    return json({ ok: true, target: target.toString(), ...result, knownSite: result.knownSite ? publicKnownSite(result.knownSite) : undefined, matches: result.matches.map(publicEvidence) });
  }
  return json({ error: 'Unknown Store Federation route.' }, 404);
}
