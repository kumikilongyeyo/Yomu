/**
 * Yomu Universal Source Fabric v8
 *
 * This module adds repository detection, repository metadata normalization,
 * health scoring, canonical-title comparison, and the Runtime Broker 2.0
 * capability surface without replacing the proven v7.5 source execution path.
 *
 * Security rule: repository probing reads metadata/manifests only. It never
 * evals or executes third-party repository code in the Cloudflare Worker.
 */

type AnyObject = Record<string, any>;

export type Ecosystem =
  | 'aidoku'
  | 'mangayomi'
  | 'mihon'
  | 'paperback'
  | 'synthetiq'
  | 'yomu'
  | 'unknown';

export type RuntimeClass =
  | 'DIRECT_HTTP'
  | 'AIDOKU_WASM'
  | 'MANGAYOMI_SCRIPT'
  | 'MIHON_ANDROID'
  | 'PAPERBACK'
  | 'BROWSER_REQUIRED'
  | 'AUTH_REQUIRED'
  | 'BROKEN';

export interface RepositoryPreview {
  id: string;
  input: string;
  repositoryUrl: string;
  owner?: string;
  name: string;
  ecosystem: Ecosystem;
  sourceCount: number | null;
  manifestUrl?: string;
  manifestKind?: string;
  defaultBranch?: string;
  lastRepositoryUpdate?: string;
  trust: 'verified-format' | 'community-maintained' | 'custom-unverified';
  compatibility: 'ready' | 'requires-runtime' | 'partially-supported' | 'review';
  runtimeClass: RuntimeClass;
  verifiedFormat: boolean;
  warnings: string[];
  fingerprint: string;
}

const VERSION = '8.0';
const GENERATION = 'Universal Source Fabric';
const UA = `Yomu-Universal-Source-Fabric/${VERSION} (+https://yomu.yomuread.workers.dev)`;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_MANIFEST_BYTES = 2_000_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-yomu-source-fabric': VERSION,
    },
  });

function compactError(error: unknown): string {
  return String((error as any)?.message ?? error ?? 'Unknown error').replace(/\s+/g, ' ').slice(0, 420);
}

function safeUrl(raw: string): URL {
  const input = String(raw || '').trim();
  if (!input) throw new Error('Paste a repository or manifest URL.');
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public http/https repository URLs are supported.');
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error('Private or local network repositories cannot be probed.');
  }
  url.hash = '';
  return url;
}

function fingerprint(parts: unknown[]): string {
  // Stable, tiny non-cryptographic fingerprint for update comparison only.
  const text = parts.map((value) => String(value ?? '')).join('|');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `v8-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeGitHubRepo(url: URL): { owner: string; repo: string; repositoryUrl: string } | null {
  if (url.hostname.toLowerCase() !== 'github.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { owner, repo, repositoryUrl: `https://github.com/${owner}/${repo}` };
}

function knownEcosystem(owner: string, repo: string): Ecosystem | null {
  const key = `${owner}/${repo}`.toLowerCase();
  if (key === 'aidoku-community/sources') return 'aidoku';
  if (key.includes('mangayomi')) return 'mangayomi';
  if (
    key === 'keiyoushi/extensions' ||
    key.includes('tachiyomi-extensions') ||
    key.includes('mihon') ||
    key.includes('manga-repo')
  ) return 'mihon';
  if (key.includes('paperback')) return 'paperback';
  if (key.includes('synthetiq')) return 'synthetiq';
  if (key.includes('yomu')) return 'yomu';
  return null;
}

function runtimeFor(ecosystem: Ecosystem): RuntimeClass {
  switch (ecosystem) {
    case 'aidoku': return 'AIDOKU_WASM';
    case 'mangayomi': return 'MANGAYOMI_SCRIPT';
    case 'mihon': return 'MIHON_ANDROID';
    case 'paperback': return 'PAPERBACK';
    case 'synthetiq': return 'DIRECT_HTTP';
    case 'yomu': return 'DIRECT_HTTP';
    default: return 'DIRECT_HTTP';
  }
}

function compatibilityFor(ecosystem: Ecosystem): RepositoryPreview['compatibility'] {
  if (ecosystem === 'yomu') return 'ready';
  if (ecosystem === 'aidoku' || ecosystem === 'mangayomi' || ecosystem === 'mihon') return 'requires-runtime';
  if (ecosystem === 'paperback' || ecosystem === 'synthetiq') return 'partially-supported';
  return 'review';
}

function manifestCandidates(owner: string, repo: string, branch: string): Array<{ url: string; kind: string }> {
  const raw = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}`;
  return [
    { url: `${raw}/repo.json`, kind: 'repo.json' },
    { url: `${raw}/index.min.json`, kind: 'index.min.json' },
    { url: `${raw}/index.json`, kind: 'index.json' },
    { url: `${raw}/repo/index.min.json`, kind: 'repo/index.min.json' },
    { url: `${raw}/repo/index.json`, kind: 'repo/index.json' },
    { url: `${raw}/versioning.json`, kind: 'versioning.json' },
    { url: `${raw}/manifest.json`, kind: 'manifest.json' },
    { url: `${raw}/package.json`, kind: 'package.json' },
    { url: `${raw}/index.pb`, kind: 'index.pb' },
  ];
}

function countInstallable(payload: any): number | null {
  if (Array.isArray(payload)) return payload.length;
  if (!payload || typeof payload !== 'object') return null;
  const directArrays = ['sources', 'manga', 'extensions', 'packages', 'items', 'repos'];
  for (const key of directArrays) {
    if (Array.isArray(payload[key])) return payload[key].length;
  }
  if (payload.sources && typeof payload.sources === 'object') return Object.keys(payload.sources).length;
  if (payload.manga && typeof payload.manga === 'object') return Object.keys(payload.manga).length;
  return null;
}

function inferEcosystem(kind: string, payload: any, owner = '', repo = ''): Ecosystem {
  const known = owner && repo ? knownEcosystem(owner, repo) : null;
  if (known) return known;
  const lowerKind = kind.toLowerCase();
  if (lowerKind.endsWith('index.pb')) return 'mihon';
  if (lowerKind.endsWith('versioning.json')) return 'paperback';
  if (lowerKind.endsWith('repo.json')) {
    if (payload && (payload.manga || payload.anime || payload.novel || payload.sources)) return 'mangayomi';
  }
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.sources) ? payload.sources : [];
  const first = rows[0] ?? payload ?? {};
  if (first && typeof first === 'object') {
    if ('pkg' in first || 'apk' in first || 'packageName' in first || 'versionCode' in first) return 'mihon';
    if ('lang' in first && ('id' in first || 'sourceId' in first) && ('version' in first || 'name' in first)) return 'aidoku';
    if ('baseUrl' in first && ('selectors' in first || 'capabilities' in first || 'runtime' in first)) return 'yomu';
  }
  const name = `${owner}/${repo}`.toLowerCase();
  if (name.includes('synthetiq')) return 'synthetiq';
  return 'unknown';
}

async function fetchText(url: string, accept = 'application/json,text/plain,*/*;q=0.4'): Promise<{ text: string; response: Response }> {
  const response = await fetch(url, {
    headers: { accept, 'user-agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  const text = (await response.text()).slice(0, MAX_MANIFEST_BYTES);
  return { text, response };
}

async function fetchJson(url: string): Promise<any> {
  const { text } = await fetchText(url);
  return JSON.parse(text);
}

async function probeManifest(
  candidate: { url: string; kind: string },
  owner = '',
  repo = '',
): Promise<{ ecosystem: Ecosystem; sourceCount: number | null; payload: any; etag: string; lastModified: string } | null> {
  try {
    if (candidate.kind === 'index.pb') {
      const response = await fetch(candidate.url, {
        method: 'GET',
        headers: { accept: 'application/octet-stream,*/*;q=0.2', 'user-agent': UA, range: 'bytes=0-31' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      return {
        ecosystem: inferEcosystem(candidate.kind, null, owner, repo),
        sourceCount: null,
        payload: null,
        etag: response.headers.get('etag') ?? '',
        lastModified: response.headers.get('last-modified') ?? '',
      };
    }
    const result = await fetchText(candidate.url);
    let payload: any = null;
    try { payload = JSON.parse(result.text); } catch { return null; }
    return {
      ecosystem: inferEcosystem(candidate.kind, payload, owner, repo),
      sourceCount: countInstallable(payload),
      payload,
      etag: result.response.headers.get('etag') ?? '',
      lastModified: result.response.headers.get('last-modified') ?? '',
    };
  } catch {
    return null;
  }
}

function knownManifest(owner: string, repo: string): { url: string; kind: string } | null {
  const key = `${owner}/${repo}`.toLowerCase();
  if (key === 'aidoku-community/sources') {
    return { url: 'https://aidoku-community.github.io/sources/index.min.json', kind: 'index.min.json' };
  }
  if (key === 'keiyoushi/extensions') {
    return { url: 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json', kind: 'repo/index.json' };
  }
  return null;
}

async function detectGitHub(input: URL, github: { owner: string; repo: string; repositoryUrl: string }): Promise<RepositoryPreview> {
  const { owner, repo, repositoryUrl } = github;
  let defaultBranch = 'main';
  let pushedAt = '';
  let displayName = repo;
  const warnings: string[] = [];

  try {
    const meta = await fetchJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    defaultBranch = String(meta?.default_branch || 'main');
    pushedAt = String(meta?.pushed_at || meta?.updated_at || '');
    displayName = String(meta?.name || repo);
  } catch (error) {
    warnings.push(`Repository metadata could not be read: ${compactError(error)}`);
  }

  const special = knownManifest(owner, repo);
  const candidates = special
    ? [special, ...manifestCandidates(owner, repo, defaultBranch).filter((x) => x.url !== special.url)]
    : manifestCandidates(owner, repo, defaultBranch);

  let best: Awaited<ReturnType<typeof probeManifest>> = null;
  let bestCandidate: { url: string; kind: string } | null = null;
  const known = knownEcosystem(owner, repo);

  for (const candidate of candidates) {
    const probe = await probeManifest(candidate, owner, repo);
    if (!probe) continue;
    best = probe;
    bestCandidate = candidate;
    // Prefer a concrete known ecosystem over a generic package.json hit.
    if (probe.ecosystem !== 'unknown' || candidate.kind !== 'package.json') break;
  }

  const ecosystem = best?.ecosystem && best.ecosystem !== 'unknown' ? best.ecosystem : (known ?? 'unknown');
  const verifiedFormat = ecosystem !== 'unknown' && !!bestCandidate;
  const trust: RepositoryPreview['trust'] = known
    ? 'community-maintained'
    : verifiedFormat
      ? 'verified-format'
      : 'custom-unverified';

  if (!bestCandidate) warnings.push('No supported repository manifest was discovered automatically. Review before enabling sources.');
  if (ecosystem === 'unknown') warnings.push('Repository ecosystem is unknown; Yomu will not execute repository code in the Worker.');

  const runtimeClass = runtimeFor(ecosystem);
  const sourceCount = best?.sourceCount ?? null;
  const lastRepositoryUpdate = best?.lastModified || pushedAt || undefined;
  const fp = fingerprint([
    repositoryUrl,
    ecosystem,
    sourceCount,
    bestCandidate?.url,
    best?.etag,
    best?.lastModified,
    pushedAt,
  ]);

  return {
    id: fingerprint([repositoryUrl]),
    input: input.toString(),
    repositoryUrl,
    owner,
    name: displayName,
    ecosystem,
    sourceCount,
    manifestUrl: bestCandidate?.url,
    manifestKind: bestCandidate?.kind,
    defaultBranch,
    lastRepositoryUpdate,
    trust,
    compatibility: compatibilityFor(ecosystem),
    runtimeClass,
    verifiedFormat,
    warnings,
    fingerprint: fp,
  };
}

async function detectManifest(input: URL): Promise<RepositoryPreview> {
  const kind = input.pathname.split('/').filter(Boolean).pop() || 'manifest';
  const probe = await probeManifest({ url: input.toString(), kind });
  if (!probe) throw new Error('Yomu could not read or recognize this repository manifest.');
  const ecosystem = probe.ecosystem;
  const warnings: string[] = [];
  if (ecosystem === 'unknown') warnings.push('The manifest is readable but its ecosystem is not recognized. Review before activation.');
  const verifiedFormat = ecosystem !== 'unknown';
  const repositoryUrl = input.toString();
  return {
    id: fingerprint([repositoryUrl]),
    input: input.toString(),
    repositoryUrl,
    name: input.hostname,
    ecosystem,
    sourceCount: probe.sourceCount,
    manifestUrl: input.toString(),
    manifestKind: kind,
    lastRepositoryUpdate: probe.lastModified || undefined,
    trust: verifiedFormat ? 'verified-format' : 'custom-unverified',
    compatibility: compatibilityFor(ecosystem),
    runtimeClass: runtimeFor(ecosystem),
    verifiedFormat,
    warnings,
    fingerprint: fingerprint([repositoryUrl, ecosystem, probe.sourceCount, probe.etag, probe.lastModified]),
  };
}

export async function detectRepository(raw: string): Promise<RepositoryPreview> {
  const input = safeUrl(raw);
  const github = normalizeGitHubRepo(input);
  if (github) return detectGitHub(input, github);
  if (/\.(?:json|pb)(?:$|[?#])/i.test(input.pathname) || /manifest|versioning|repo|index/i.test(input.pathname)) {
    return detectManifest(input);
  }
  throw new Error('This looks like a website rather than a repository. Use Add Source for websites, or paste a GitHub/manifest URL here.');
}

const RECOMMENDED_REPOSITORIES = [
  {
    name: 'Aidoku Community Sources',
    url: 'https://github.com/Aidoku-Community/sources',
    ecosystem: 'aidoku',
    pack: ['manga', 'manhwa', 'manhua', 'high-quality'],
  },
  {
    name: 'Mangayomi Extensions',
    url: 'https://github.com/m2k3a/mangayomi-extensions',
    ecosystem: 'mangayomi',
    pack: ['manga', 'manhwa', 'manhua'],
  },
  {
    name: 'Keiyoushi Extensions',
    url: 'https://github.com/keiyoushi/extensions',
    ecosystem: 'mihon',
    pack: ['manga', 'manhwa', 'manhua', 'recently-active'],
  },
  {
    name: 'Yuzono Tachiyomi Extensions',
    url: 'https://github.com/yuzono/tachiyomi-extensions',
    ecosystem: 'mihon',
    pack: ['manga', 'mirrors'],
  },
];

function clamp01(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export function healthScore(input: AnyObject): AnyObject {
  const signals = {
    readerPageSuccess: clamp01(input.readerPageSuccess),
    chapterFreshness: clamp01(input.chapterFreshness),
    imageQuality: clamp01(input.imageQuality),
    chapterDetailsSuccess: clamp01(input.chapterDetailsSuccess),
    latency: clamp01(input.latency),
    recentErrorTrend: clamp01(input.recentErrorTrend),
    repositoryRecency: clamp01(input.repositoryRecency),
    runtimeReliability: clamp01(input.runtimeReliability),
  };
  const weights = {
    readerPageSuccess: 0.25,
    chapterFreshness: 0.20,
    imageQuality: 0.18,
    chapterDetailsSuccess: 0.12,
    latency: 0.08,
    recentErrorTrend: 0.07,
    repositoryRecency: 0.05,
    runtimeReliability: 0.05,
  };
  const score = Math.round(Object.entries(weights).reduce((sum, [key, weight]) => sum + signals[key as keyof typeof signals] * weight, 0) * 100);
  const state = score >= 80 ? 'healthy' : score >= 55 ? 'degraded' : 'needs-action';
  return { score, state, signals, weights };
}

function normText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function jaccard(a: string, b: string): number {
  const aa = new Set(a.split(' ').filter(Boolean));
  const bb = new Set(b.split(' ').filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let overlap = 0;
  for (const token of aa) if (bb.has(token)) overlap += 1;
  return overlap / (aa.size + bb.size - overlap);
}

export function canonicalMatch(body: AnyObject): AnyObject {
  const a = body.a ?? {};
  const b = body.b ?? {};
  const titleA = normText(a.title);
  const titleB = normText(b.title);
  const aliasesA = [titleA, ...(Array.isArray(a.aliases) ? a.aliases.map(normText) : [])].filter(Boolean);
  const aliasesB = [titleB, ...(Array.isArray(b.aliases) ? b.aliases.map(normText) : [])].filter(Boolean);
  let title = 0;
  for (const left of aliasesA) for (const right of aliasesB) title = Math.max(title, left === right ? 1 : jaccard(left, right));
  const language = a.language && b.language ? (normText(a.language) === normText(b.language) ? 1 : 0) : 0.5;
  const author = a.author && b.author ? jaccard(normText(a.author), normText(b.author)) : 0.5;
  const external = a.externalId && b.externalId ? (String(a.externalId) === String(b.externalId) ? 1 : 0) : 0.5;
  const score = Math.round((title * 0.62 + language * 0.12 + author * 0.12 + external * 0.14) * 100);
  const confidence = score >= 88 ? 'high' : score >= 72 ? 'medium' : score >= 52 ? 'low' : 'none';
  return { score, confidence, signals: { title, language, author, external } };
}

export function v8Status() {
  return {
    ok: true,
    version: VERSION,
    generation: GENERATION,
    userLabel: 'Source system ready',
    architecture: {
      detector: 'universal',
      normalizedContract: true,
      safeUpdates: true,
      lastKnownGoodRollback: true,
      healthQualityRanking: true,
      canonicalTitleMatching: true,
      automaticFallbackGraph: true,
      progressiveDisclosure: true,
    },
    registryAdapters: ['aidoku', 'mangayomi', 'mihon', 'yomu', 'paperback', 'synthetiq'],
    runtimeBroker: {
      version: '2.0',
      classes: [
        'DIRECT_HTTP',
        'AIDOKU_WASM',
        'MANGAYOMI_SCRIPT',
        'MIHON_ANDROID',
        'PAPERBACK',
        'BROWSER_REQUIRED',
        'AUTH_REQUIRED',
        'BROKEN',
      ],
      security: 'isolated-runtime-only',
    },
    guardrails: {
      arbitraryRepositoryCodeInWorker: false,
      protectionBypass: false,
      testBeforeTrust: true,
      preserveLastKnownGood: true,
    },
  };
}

async function readBody(request: Request): Promise<AnyObject> {
  const text = await request.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error('Request body must be valid JSON.'); }
}

export async function handleV8Route(request: Request, url: URL): Promise<Response | null> {
  if (url.pathname === '/api/fabric/v8/status') return json(v8Status());

  if (url.pathname === '/api/fabric/repositories/catalog') {
    return json({
      version: VERSION,
      repositories: RECOMMENDED_REPOSITORIES,
      packs: {
        'high-quality': ['Aidoku Community Sources', 'Keiyoushi Extensions'],
        manga: ['Aidoku Community Sources', 'Mangayomi Extensions', 'Keiyoushi Extensions'],
        manhwa: ['Aidoku Community Sources', 'Mangayomi Extensions', 'Keiyoushi Extensions'],
        'recently-active': ['Keiyoushi Extensions'],
      },
    });
  }

  if (url.pathname === '/api/fabric/repositories/detect') {
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    try {
      const body = await readBody(request);
      const input = String(body.input ?? body.url ?? '').trim();
      const repository = await detectRepository(input);
      return json({ ok: true, repository });
    } catch (error) {
      return json({ ok: false, error: compactError(error) }, 400);
    }
  }

  if (url.pathname === '/api/fabric/v8/health-score') {
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    try { return json({ ok: true, ...healthScore(await readBody(request)) }); }
    catch (error) { return json({ ok: false, error: compactError(error) }, 400); }
  }

  if (url.pathname === '/api/fabric/v8/canonical-match') {
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    try { return json({ ok: true, ...canonicalMatch(await readBody(request)) }); }
    catch (error) { return json({ ok: false, error: compactError(error) }, 400); }
  }

  return null;
}
