import type { Env } from './index';

const UA = 'Mozilla/5.0 (compatible; Yomu-Store-Name-Resolver/7.3; +https://yomu.yomuread.workers.dev)';

const STORES = [
  {
    id: 'mihon-keiyoushi',
    name: 'Keiyoushi',
    ecosystem: 'mihon',
    url: 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json',
    sourceRoot: 'https://raw.githubusercontent.com/keiyoushi/extensions-source/main/src',
  },
  {
    id: 'mihon-yuzono',
    name: 'Yuzono',
    ecosystem: 'mihon',
    url: 'https://raw.githubusercontent.com/yuzono/cursed-manga-repo/repo/index.min.json',
  },
  {
    id: 'aidoku-community',
    name: 'Aidoku Community',
    ecosystem: 'aidoku',
    url: 'https://aidoku-community.github.io/sources/index.min.json',
  },
  {
    id: 'mangayomi-community',
    name: 'Mangayomi Community',
    ecosystem: 'mangayomi',
    url: 'https://raw.githubusercontent.com/m2k3a/mangayomi-extensions/main/index.json',
  },
] as const;

type Candidate = {
  storeId: string;
  storeName: string;
  ecosystem: string;
  name: string;
  id?: string;
  package?: string;
  language?: string;
  baseUrl?: string;
  artifact?: string;
  score: number;
  sourceRoot?: string;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
});

function compact(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function normalizeBaseUrl(value: unknown): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['https:', 'http:'].includes(u.protocol)) return undefined;
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function scoreName(query: string, values: unknown[]): number {
  const q = compact(query);
  if (!q) return 0;
  let best = 0;
  for (const value of values) {
    const v = compact(value);
    if (!v) continue;
    if (v === q) best = Math.max(best, 1000);
    else if (v.startsWith(q) || q.startsWith(v)) best = Math.max(best, 760);
    else if (v.includes(q) || q.includes(v)) best = Math.max(best, 520);
  }
  return best;
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function parseStore(store: typeof STORES[number], document: any, query: string): Candidate[] {
  const rows = Array.isArray(document)
    ? document
    : Array.isArray(document?.extensions)
      ? document.extensions
      : Array.isArray(document?.sources)
        ? document.sources
        : [];

  const out: Candidate[] = [];
  for (const ext of rows) {
    const sources = Array.isArray(ext?.sources) && ext.sources.length ? ext.sources : [ext];
    for (const source of sources) {
      const name = String(source?.name ?? ext?.name ?? source?.id ?? ext?.id ?? '').trim();
      if (!name) continue;
      const pkg = stringValue(ext?.pkg ?? ext?.packageName ?? ext?.package ?? source?.pkg ?? source?.packageName);
      const id = stringValue(source?.id ?? ext?.id);
      const language = stringValue(source?.lang ?? ext?.lang ?? (Array.isArray(source?.languages) ? source.languages[0] : undefined));
      const baseUrl = normalizeBaseUrl(source?.baseUrl ?? source?.baseURL ?? source?.website ?? source?.url ?? ext?.baseUrl ?? ext?.baseURL ?? ext?.website ?? ext?.url);
      const artifact = stringValue(ext?.apk ?? ext?.downloadURL ?? ext?.downloadUrl ?? source?.downloadURL ?? source?.downloadUrl);
      const score = scoreName(query, [name, id, pkg]);
      if (!score) continue;
      out.push({
        storeId: store.id,
        storeName: store.name,
        ecosystem: store.ecosystem,
        name,
        id,
        package: pkg,
        language,
        baseUrl,
        artifact,
        score,
        sourceRoot: 'sourceRoot' in store ? store.sourceRoot : undefined,
      });
    }
  }
  return out;
}

async function deriveKeiyoushiBaseUrl(candidate: Candidate): Promise<string | undefined> {
  if (candidate.baseUrl || candidate.storeId !== 'mihon-keiyoushi' || !candidate.sourceRoot) return candidate.baseUrl;
  const lang = compact(candidate.language || 'en') || 'en';
  const slugFromPackage = String(candidate.package || '').split('.').filter(Boolean).pop() || '';
  const slugs = [...new Set([slugFromPackage, compact(candidate.name), compact(candidate.id)].filter(Boolean))];

  for (const slug of slugs) {
    const url = `${candidate.sourceRoot}/${encodeURIComponent(lang)}/${encodeURIComponent(slug)}/build.gradle.kts`;
    try {
      const response = await fetch(url, {
        headers: { accept: 'text/plain', 'user-agent': UA },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) continue;
      const text = await response.text();
      const match = text.match(/baseUrl\s*=\s*["'](https?:\/\/[^"']+)["']/i);
      const resolved = normalizeBaseUrl(match?.[1]);
      if (resolved) return resolved;
    } catch {}
  }
  return undefined;
}

export async function handleStoreNameSearch(request: Request, _env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
  const query = String(url.searchParams.get('q') ?? '').trim();
  if (!query) return json({ error: 'Missing q.' }, 400);

  const settled = await Promise.allSettled(STORES.map(async (store) => ({
    store,
    rows: parseStore(store, await fetchJson(store.url), query),
  })));

  const candidates: Candidate[] = [];
  let storesHealthy = 0;
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    storesHealthy += 1;
    candidates.push(...result.value.rows);
  }

  candidates.sort((a, b) => b.score - a.score || Number(Boolean(b.baseUrl)) - Number(Boolean(a.baseUrl)) || a.name.localeCompare(b.name));

  const enriched: Candidate[] = [];
  for (const candidate of candidates.slice(0, 8)) {
    const baseUrl = await deriveKeiyoushiBaseUrl(candidate);
    enriched.push({ ...candidate, baseUrl });
  }
  enriched.sort((a, b) => b.score - a.score || Number(Boolean(b.baseUrl)) - Number(Boolean(a.baseUrl)));

  const best = enriched.find((row) => row.baseUrl) ?? enriched[0];
  return json({
    ok: true,
    query,
    storesChecked: STORES.length,
    storesHealthy,
    found: enriched.length,
    best: best ? {
      storeId: best.storeId,
      storeName: best.storeName,
      ecosystem: best.ecosystem,
      name: best.name,
      id: best.id,
      package: best.package,
      language: best.language,
      baseUrl: best.baseUrl,
      artifact: best.artifact,
      score: best.score,
    } : null,
    matches: enriched.slice(0, 8).map((row) => ({
      storeId: row.storeId,
      storeName: row.storeName,
      ecosystem: row.ecosystem,
      name: row.name,
      id: row.id,
      package: row.package,
      language: row.language,
      baseUrl: row.baseUrl,
      artifact: row.artifact,
      score: row.score,
    })),
  });
}
