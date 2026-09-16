import type { Env } from './index';

const VERSION = '7.5';
const UA = `Mozilla/5.0 (compatible; Yomu-Recipe-Broker/${VERSION}; +https://yomu.yomuread.workers.dev)`;
const KEIYOUSHI_RAW = 'https://raw.githubusercontent.com/keiyoushi/extensions-source/main/src';

const HOST_ALIASES: Record<string, string[]> = {
  readallcomics: ['readallcomicscom'],
  readallcomicscom: ['readallcomicscom'],
  hiveworkscomics: ['hiveworks'],
  hiveworks: ['hiveworks'],
  comicfury: ['comicfury'],
  tapas: ['tapastic'],
  tapastic: ['tapastic'],
  webtoon: ['webtoons'],
  webtoons: ['webtoons'],
  comicskingdom: ['comicskingdom'],
  wpcomicskingdom: ['comicskingdom'],
  globalcomix: ['globalcomix'],
  killsixbilliondemons: ['killsixbilliondemons'],
  peppercarrot: ['peppercarrot'],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-yomu-recipe-broker': VERSION,
  },
});

function compact(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function host(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function sameSite(a: string, b: string): boolean {
  const x = host(a);
  const y = host(b);
  return Boolean(x && y && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)));
}

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

function parseBuild(text: string) {
  const vars = new Map<string, string>();
  for (const match of text.matchAll(/\b(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["'](https?:\/\/[^"']+)["']/g)) {
    vars.set(match[1], match[2]);
  }
  const literal = text.match(/\bbaseUrl\s*=\s*["'](https?:\/\/[^"']+)["']/)?.[1];
  const ref = text.match(/\bbaseUrl\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1];
  return {
    name: text.match(/\bname\s*=\s*["']([^"']+)["']/)?.[1] || '',
    baseUrl: literal || (ref ? vars.get(ref) : undefined) || '',
    language: text.match(/\blang\s*=\s*["']([^"']+)["']/)?.[1] || '',
    version: Number(text.match(/\bversionCode\s*=\s*(\d+)/)?.[1] || 1),
  };
}

function hostRecipeSlugs(targetUrl: string): string[] {
  const h = host(targetUrl);
  if (!h) return [];
  const labels = h.split('.').filter(Boolean);
  const first = labels[0] || '';
  const second = labels[1] || '';
  const noTld = h.replace(/\.(?:com|org|net|ru|biz|io|to|co|me|xyz|site|online)$/i, '');
  const seeds = [first, noTld, h];
  if (/^(?:www|wp|m|mobile|reader|read)$/i.test(first) && second) seeds.push(second);

  const out: string[] = [];
  const push = (value: string) => {
    const x = compact(value);
    if (x.length >= 3 && !out.includes(x)) out.push(x);
  };
  for (const seed of seeds) {
    const c = compact(seed);
    push(c);
    for (const alias of HOST_ALIASES[c] || []) push(alias);
    if (c.endsWith('comics') && c.length > 6) push(c.slice(0, -6));
    if (c.endsWith('comic') && c.length > 5) push(c.slice(0, -5));
  }

  // Common upstream folder convention: keep a stripped TLD in the slug.
  const primary = compact(first);
  if (primary) {
    push(`${primary}com`);
    push(`${primary}net`);
    push(`${primary}org`);
  }
  return out.slice(0, 14);
}

async function discoverKeiyoushiByHost(targetUrl: string): Promise<any[]> {
  const slugs = hostRecipeSlugs(targetUrl);
  if (!slugs.length) return [];
  const hits: any[] = [];

  const tasks = slugs.flatMap((slug) => ['en', 'all'].map(async (lang) => {
    try {
      const response = await fetch(`${KEIYOUSHI_RAW}/${lang}/${slug}/build.gradle.kts`, {
        headers: { accept: 'text/plain,*/*;q=0.5', 'user-agent': UA },
        signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok) return;
      const build = parseBuild(await response.text());
      if (!build.baseUrl || !sameSite(targetUrl, build.baseUrl)) return;
      hits.push({
        ecosystem: 'mihon',
        storeName: 'Keiyoushi',
        storeId: 'mihon-keiyoushi',
        name: build.name || slug,
        id: slug,
        package: `keiyoushi.${lang}.${slug}`,
        baseUrl: build.baseUrl,
        language: build.language || lang,
        version: build.version,
        discoveredBy: 'source-repository-host',
      });
    } catch {}
  }));
  await Promise.all(tasks);

  const seen = new Set<string>();
  return hits.filter((row) => {
    const key = `${row.package}|${row.baseUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
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

  const evidenceImplementations = publicImplementations(payload.evidence);
  const discoveredImplementations = await discoverKeiyoushiByHost(targetUrl);
  const implementations = [...evidenceImplementations, ...discoveredImplementations]
    .filter((row, index, rows) => rows.findIndex((x) => `${x.package}|${x.baseUrl}` === `${row.package}|${row.baseUrl}`) === index)
    .slice(0, 8);
  if (!implementations.length) return fallback;

  const remote = await callRuntime(env, targetUrl, implementations);
  if (!remote) return fallback;

  const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  const discoveryEvidence = discoveredImplementations.map((row) => ({
    ecosystem: 'keiyoushi-source',
    store: 'Keiyoushi source repository',
    storeId: row.storeId,
    name: row.name,
    id: row.id,
    package: row.package,
    baseUrl: row.baseUrl,
    language: row.language,
    version: row.version,
    discoveredBy: row.discoveredBy,
  }));
  const remoteEvidence = remote.recipe ? {
    ecosystem: 'remote-recipe-runtime',
    store: 'Yomu Source Runtime',
    name: remote.recipe.name,
    family: remote.recipe.family,
    sourceFiles: remote.recipe.sourceFiles,
  } : undefined;
  const mergedEvidence = [...evidence, ...discoveryEvidence, ...(remoteEvidence ? [remoteEvidence] : [])];

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
      evidence: mergedEvidence,
      message: remote.message ?? 'The maintained recipe passed through Yomu Remote Recipe Runtime.',
      fabric: {
        ...(payload.fabric ?? {}),
        version: VERSION,
        generation: 'Recipe Engine',
        remoteRecipeRuntime: true,
        sourceRepositoryHostDiscovery: true,
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
      evidence: mergedEvidence,
      message: remote.message ?? 'The maintained upstream recipe explicitly requires browser/WebView state.',
      fabric: {
        ...(payload.fabric ?? {}),
        version: VERSION,
        generation: 'Recipe Engine',
        remoteRecipeRuntime: true,
        sourceRepositoryHostDiscovery: true,
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
      evidence: mergedEvidence,
      message: remote.message ?? 'The maintained recipe compiled, but the remote reader gauntlet did not pass.',
      fabric: {
        ...(payload.fabric ?? {}),
        version: VERSION,
        generation: 'Recipe Engine',
        remoteRecipeRuntime: true,
        sourceRepositoryHostDiscovery: true,
      },
    });
  }

  return fallback;
}
