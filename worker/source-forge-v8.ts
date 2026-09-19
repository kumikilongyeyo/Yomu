/**
 * Yomu Source Forge v8
 *
 * A successful adaptive Source Fabric resolution can be promoted into a
 * portable source-pack entry without changing the Sources UI. The Worker keeps
 * a small, deduplicated queue in KV. The yomu-extensions repository polls the
 * queue, re-tests entries, and mirrors accepted URLs into Git.
 *
 * Important boundary: Source Forge stores public website identities and probe
 * metadata only. It never stores or executes third-party code and never tries
 * to bypass login, paywall, CAPTCHA, DRM, or anti-bot protection.
 */

type AnyObject = Record<string, any>;

type ForgeEnv = {
  SYNC: KVNamespace;
  FORGE_SOURCEPACK_URL?: string;
};

export interface ForgeCandidate {
  schema: 'yomu.source-forge-candidate/1';
  id: string;
  url: string;
  host: string;
  name: string;
  route: string;
  score: number;
  strategy?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

const PREFIX = 'source-forge:pending:';
const CANDIDATE_TTL_SECONDS = 60 * 60 * 24 * 14;
const MIN_PROMOTION_SCORE = 70;
const DEFAULT_MIRROR = 'https://raw.githubusercontent.com/kumikilongyeyo/yomu-extensions/main/sourcepack.json';

const json = (body: unknown, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      'x-yomu-source-forge': '1',
    },
  });

function compactError(error: unknown): string {
  return String((error as any)?.message ?? error ?? 'Unknown error').replace(/\s+/g, ' ').slice(0, 420);
}

function obviousPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^(::1|fc|fd|fe80)/i.test(h)) return true;
  return false;
}

function publicUrl(raw: string): URL {
  const input = String(raw || '').trim();
  if (!input) throw new Error('Paste a public website URL.');
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || obviousPrivateHost(url.hostname)) {
    throw new Error('Only public http/https website URLs can enter Source Forge.');
  }
  url.hash = '';
  return url;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'source';
}

function uniqueStrings(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const v = String(value ?? '').trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function candidateTags(payload: AnyObject): string[] {
  const content = Array.isArray(payload?.adapter?.content) ? payload.adapter.content : [];
  const route = String(payload?.route ?? 'adaptive');
  return uniqueStrings([
    ...content,
    payload?.adapter?.nsfw ? 'adult' : '',
    'source-forge',
    'auto-generated',
    route,
  ]).slice(0, 16);
}

function rootFor(input: URL, payload: AnyObject): URL {
  const raw = String(payload?.probe?.rootUrl ?? '').trim();
  if (!raw) return new URL('/', input.origin);
  try {
    const root = publicUrl(raw);
    const a = input.hostname.toLowerCase().replace(/^www\./, '');
    const b = root.hostname.toLowerCase().replace(/^www\./, '');
    if (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return root;
  } catch {}
  return new URL('/', input.origin);
}

export function forgeEligibility(payload: AnyObject): { eligible: boolean; reason: string } {
  if (!payload || payload.ready !== true) return { eligible: false, reason: 'source-not-ready' };
  if (!payload.adapter || typeof payload.adapter !== 'object') return { eligible: false, reason: 'missing-adapter' };
  const route = String(payload.route ?? '');
  if (route === 'native') return { eligible: false, reason: 'already-native' };
  if (!/adaptive|reference-assisted/i.test(route)) return { eligible: false, reason: 'not-forge-generated' };
  const score = Number(payload.score ?? payload.adapter?.score ?? 0);
  if (!Number.isFinite(score) || score < MIN_PROMOTION_SCORE) return { eligible: false, reason: 'probe-score-too-low' };
  return { eligible: true, reason: 'ready' };
}

export async function queueResolvedSource(
  env: ForgeEnv,
  rawUrl: string,
  payload: AnyObject,
): Promise<{ queued: boolean; reason: string; candidate?: ForgeCandidate }> {
  const eligibility = forgeEligibility(payload);
  if (!eligibility.eligible) return { queued: false, reason: eligibility.reason };

  let input: URL;
  try { input = publicUrl(rawUrl); }
  catch (error) { return { queued: false, reason: compactError(error) }; }

  const root = rootFor(input, payload);
  root.search = '';
  root.hash = '';
  const host = root.hostname.toLowerCase().replace(/^www\./, '');
  const id = `forge-${slug(host)}`;
  const key = `${PREFIX}${host}`;
  const now = new Date().toISOString();

  let createdAt = now;
  try {
    const old = await env.SYNC.get(key);
    if (old) {
      const parsed = JSON.parse(old) as Partial<ForgeCandidate>;
      if (parsed.createdAt) createdAt = String(parsed.createdAt);
    }
  } catch {}

  const candidate: ForgeCandidate = {
    schema: 'yomu.source-forge-candidate/1',
    id,
    url: root.toString(),
    host,
    name: String(payload?.adapter?.name ?? host).slice(0, 80),
    route: String(payload.route ?? 'remote-adaptive'),
    score: Math.max(0, Math.min(100, Math.round(Number(payload.score ?? payload.adapter?.score ?? 0)))),
    ...(payload?.probe?.strategy || payload?.adapter?.strategy
      ? { strategy: String(payload.probe?.strategy ?? payload.adapter?.strategy).slice(0, 240) }
      : {}),
    tags: candidateTags(payload),
    createdAt,
    updatedAt: now,
  };

  await env.SYNC.put(key, JSON.stringify(candidate), { expirationTtl: CANDIDATE_TTL_SECONDS });
  return { queued: true, reason: 'queued-for-git-mirror', candidate };
}

export async function listForgeCandidates(env: ForgeEnv, limit = 50): Promise<ForgeCandidate[]> {
  const requested = Math.max(1, Math.min(100, Math.floor(limit || 50)));
  const listing = await env.SYNC.list({ prefix: PREFIX, limit: requested });
  const rows = await Promise.all(listing.keys.map(async (key) => {
    try {
      const value = await env.SYNC.get(key.name);
      if (!value) return null;
      const parsed = JSON.parse(value) as ForgeCandidate;
      if (parsed?.schema !== 'yomu.source-forge-candidate/1' || !parsed.url || !parsed.host) return null;
      return parsed;
    } catch {
      return null;
    }
  }));
  return rows
    .filter((row): row is ForgeCandidate => !!row)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function forgeSourcePack(candidates: ForgeCandidate[]) {
  return {
    schema: 'yomu.source-pack/1',
    id: 'yomu-source-forge',
    name: 'Yomu Source Forge',
    version: Math.max(1, candidates.length),
    updatedAt: new Date().toISOString(),
    description: 'Auto-generated public source identities that passed Yomu Source Fabric catalog → chapters → reader verification. Git mirrors re-test before accepting them.',
    sources: candidates.map((candidate) => ({
      url: candidate.url,
      tags: candidate.tags,
    })),
  };
}

export async function handleForgeRoute(request: Request, env: ForgeEnv, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/fabric/forge/')) return null;

  if (url.pathname === '/api/fabric/forge/status') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    const candidates = await listForgeCandidates(env, 100);
    return json({
      ok: true,
      version: 1,
      pending: candidates.length,
      promotionScore: MIN_PROMOTION_SCORE,
      gitMirror: env.FORGE_SOURCEPACK_URL?.trim() || DEFAULT_MIRROR,
      automatic: true,
      uiChanged: false,
    });
  }

  if (url.pathname === '/api/fabric/forge/pending') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    const candidates = await listForgeCandidates(env, Number(url.searchParams.get('limit') ?? '50'));
    return json({ ok: true, candidates, sourcePack: forgeSourcePack(candidates) });
  }

  if (url.pathname === '/api/fabric/forge/sourcepack.json') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    const candidates = await listForgeCandidates(env, 100);
    return json(forgeSourcePack(candidates), 200, 'no-store');
  }

  // /test is handled in index-v8 because it intentionally calls the v7.5
  // execution floor without recursively invoking the v8 wrapper.
  if (url.pathname === '/api/fabric/forge/test') return null;

  return json({ error: 'Unknown Source Forge route.' }, 404);
}
