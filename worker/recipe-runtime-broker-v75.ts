import type { Env } from './index';

const VERSION = '7.5';
const UA = `Mozilla/5.0 (compatible; Yomu-Recipe-Broker/${VERSION}; +https://yomu.yomuread.workers.dev)`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-yomu-recipe-broker': VERSION,
  },
});

function runtimeConfig(env: Env): { url?: string; token?: string } {
  const row = env as Env & { SOURCE_RUNTIME_URL?: string; SOURCE_RUNTIME_TOKEN?: string };
  const raw = String(row.SOURCE_RUNTIME_URL ?? '').trim();
  if (!raw) return {};
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol)) return {};
    return {
      url: url.toString().replace(/\/+$/, ''),
      token: String(row.SOURCE_RUNTIME_TOKEN ?? '').trim() || undefined,
    };
  } catch {
    return {};
  }
}

function publicImplementations(evidence: any[]): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const row of Array.isArray(evidence) ? evidence : []) {
    const store = String(row?.storeName ?? row?.store ?? '').trim();
    const ecosystem = String(row?.ecosystem ?? '').trim();
    if (!/keiyoushi|mihon/i.test(`${store} ${ecosystem}`)) continue;
    const item = {
      ecosystem: ecosystem || 'mihon',
      storeName: store || 'Keiyoushi',
      storeId: row?.storeId,
      name: row?.name,
      id: row?.id,
      package: row?.package,
      baseUrl: row?.baseUrl,
      language: row?.language,
      version: row?.version ?? row?.versionCode,
      sourceCodeUrl: row?.sourceCodeUrl,
    };
    const key = `${item.storeName}|${item.name ?? ''}|${item.id ?? ''}|${item.baseUrl ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 8);
}

async function callRuntime(env: Env, targetUrl: string, implementations: any[]): Promise<any | null> {
  const config = runtimeConfig(env);
  if (!config.url || !implementations.length) return null;
  try {
    const response = await fetch(`${config.url}/v1/resolve`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': UA,
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({ targetUrl, implementations }),
      signal: AbortSignal.timeout(45_000),
    });
    const payload: any = await response.json().catch(() => null);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export async function upgradeWithRemoteRecipe(
  bodyText: string,
  env: Env,
  fallbackPromise: Promise<Response>,
): Promise<Response> {
  const fallback = await fallbackPromise;
  const type = fallback.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return fallback;
  const payload: any = await fallback.clone().json().catch(() => null);
  if (!payload || typeof payload !== 'object') return fallback;
  if (payload.ready && payload.adapter) return fallback;

  let body: any = {};
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch {}
  let targetUrl = '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(String(body?.url ?? '')) ? String(body.url) : `https://${String(body?.url ?? '')}`);
    if (!['https:', 'http:'].includes(u.protocol)) return fallback;
    targetUrl = u.toString();
  } catch {
    return fallback;
  }

  const implementations = publicImplementations(payload.evidence);
  if (!implementations.length) return fallback;
  const remote = await callRuntime(env, targetUrl, implementations);
  if (!remote) return fallback;

  const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  const remoteEvidence = remote.recipe ? {
    ecosystem: 'remote-recipe-runtime',
    store: 'Yomu Source Runtime',
    name: remote.recipe.name,
    family: remote.recipe.family,
    sourceFiles: remote.recipe.sourceFiles,
  } : undefined;

  if (remote.ready && remote.adapter) {
    return json({
      ...payload,
      ok: true,
      ready: true,
      route: 'remote-recipe',
      confidence: remote.confidence ?? 'high',
      score: remote.score ?? 99,
      adapter: remote.adapter,
      runtime: remote.runtime ?? 'hatchable-browser-recipe',
      remoteRecipe: remote.recipe,
      remoteProbe: remote.probe,
      evidence: remoteEvidence ? [...evidence, remoteEvidence] : evidence,
      message: remote.message ?? 'The maintained recipe passed through Yomu Remote Recipe Runtime.',
      fabric: {
        ...(payload.fabric ?? {}),
        version: VERSION,
        generation: 'Recipe Engine',
        remoteRecipeRuntime: true,
      },
    });
  }

  if (remote.browserRequired) {
    return json({
      ...payload,
      ok: true,
      ready: false,
      route: 'recipe-browser-required',
      browserRequired: true,
      confidence: 'high',
      score: 0,
      runtime: 'browser',
      remoteRecipe: remote.recipe,
      evidence: remoteEvidence ? [...evidence, remoteEvidence] : evidence,
      message: remote.message ?? 'The maintained upstream recipe explicitly requires browser/WebView state.',
      fabric: {
        ...(payload.fabric ?? {}),
        version: VERSION,
        generation: 'Recipe Engine',
        remoteRecipeRuntime: true,
      },
    });
  }

  if (Array.isArray(remote.failures) && remote.failures.length) {
    return json({
      ...payload,
      ok: true,
      ready: false,
      route: 'remote-recipe-exhausted',
      runtime: remote.runtime ?? 'hatchable-browser-recipe',
      remoteFailures: remote.failures,
      message: remote.message ?? 'The maintained recipe compiled, but the remote reader gauntlet did not pass.',
      fabric: {
        ...(payload.fabric ?? {}),
        version: VERSION,
        generation: 'Recipe Engine',
        remoteRecipeRuntime: true,
      },
    });
  }

  return fallback;
}
