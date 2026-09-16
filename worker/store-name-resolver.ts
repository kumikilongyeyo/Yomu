import type { Env } from './index';

const UA = 'Mozilla/5.0 (compatible; Yomu-Store-Name-Resolver/7.5; +https://yomu.yomuread.workers.dev)';
const KEIYOUSHI_SOURCE_ROOT = 'https://raw.githubusercontent.com/keiyoushi/extensions-source/main/src';

// Keiyoushi folder slugs are not always the compact display name. Keep this
// deliberately small and structural: it only bridges maintained source names
// to their upstream GitHub recipe folder. The recipe itself still decides the
// real base URL and Yomu still runs the full reader gauntlet before enabling it.
const SOURCE_REPO_ALIASES: Record<string, string[]> = {
  readallcomics: ['readallcomicscom'],
  hiveworks: ['hiveworks'],
  hiveworkscomics: ['hiveworks'],
  tapas: ['tapastic'],
  tapastic: ['tapastic'],
  webtoon: ['webtoons'],
  webtoons: ['webtoons'],
  webtoonscom: ['webtoons'],
  comicfury: ['comicfury'],
  comicskingdom: ['comicskingdom'],
  globalcomix: ['globalcomix'],
  killsixbilliondemons: ['killsixbilliondemons'],
  peppercarrot: ['peppercarrot'],
};

const STORES = [
  {
    id: 'mihon-keiyoushi',
    name: 'Keiyoushi',
    ecosystem: 'mihon',
    url: 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json',
    sourceRoot: KEIYOUSHI_SOURCE_ROOT,
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

type StoreDefinition = (typeof STORES)[number];

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
  theme?: string;
  version?: number;
  discoveredBy?: string;
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

async function fetchText(url: string, timeout = 8_000): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: 'text/plain,*/*;q=0.5', 'user-agent': UA },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function parseBuild(text: string) {
  return {
    name: text.match(/\bname\s*=\s*["']([^"']+)["']/)?.[1] || '',
    baseUrl: normalizeBaseUrl(text.match(/\bbaseUrl\s*=\s*["'](https?:\/\/[^"']+)["']/)?.[1]),
    language: text.match(/\blang\s*=\s*["']([^"']+)["']/)?.[1] || undefined,
    theme: text.match(/\btheme\s*=\s*["']([^"']+)["']/)?.[1] || undefined,
    version: Number(text.match(/\bversionCode\s*=\s*(\d+)/)?.[1] || 1),
  };
}

function parseStore(store: StoreDefinition, document: any, query: string): Candidate[] {
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
        discoveredBy: 'store-index',
      });
    }
  }
  return out;
}

function directSlugs(query: string): string[] {
  const q = compact(query);
  const rows = [q, ...(SOURCE_REPO_ALIASES[q] || [])];
  if (q.endsWith('s')) rows.push(q.slice(0, -1));
  else rows.push(`${q}s`);
  if (q.endsWith('comics')) rows.push(q.replace(/comics$/, 'comic'));
  if (q.endsWith('comic')) rows.push(`${q}s`);

  // Source folders sometimes keep the TLD in their slug (readallcomicscom,
  // bato.to-style names, etc.). These guesses are cheap raw-GitHub 404 probes.
  rows.push(`${q}com`, `${q}net`, `${q}org`, `${q}io`);
  return [...new Set(rows.filter((x) => x.length >= 3))].slice(0, 12);
}

async function directKeiyoushiCandidates(query: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const tasks: Promise<void>[] = [];
  for (const slug of directSlugs(query)) {
    for (const lang of ['en', 'all']) {
      tasks.push((async () => {
        try {
          const buildText = await fetchText(`${KEIYOUSHI_SOURCE_ROOT}/${encodeURIComponent(lang)}/${encodeURIComponent(slug)}/build.gradle.kts`, 6_000);
          const build = parseBuild(buildText);
          if (!build.name || !build.baseUrl) return;
          const score = scoreName(query, [build.name, slug]);
          if (score < 520) return;
          out.push({
            storeId: 'mihon-keiyoushi',
            storeName: 'Keiyoushi',
            ecosystem: 'mihon',
            name: build.name,
            id: slug,
            package: `keiyoushi.${lang}.${slug}`,
            language: build.language || lang,
            baseUrl: build.baseUrl,
            score: Math.max(score, 990),
            sourceRoot: KEIYOUSHI_SOURCE_ROOT,
            theme: build.theme,
            version: build.version,
            discoveredBy: 'source-repository',
          });
        } catch {}
      })());
    }
  }
  await Promise.all(tasks);
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
      const text = await fetchText(url);
      const build = parseBuild(text);
      if (build.baseUrl) return build.baseUrl;
    } catch {}
  }
  return undefined;
}

function publicCandidate(row: Candidate) {
  return {
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
    theme: row.theme,
    version: row.version,
    discoveredBy: row.discoveredBy,
  };
}

export async function handleStoreNameSearch(request: Request, _env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
  const query = String(url.searchParams.get('q') ?? '').trim();
  if (!query) return json({ error: 'Missing q.' }, 400);

  const [settled, direct] = await Promise.all([
    Promise.allSettled(STORES.map(async (store) => ({
      store,
      rows: parseStore(store, await fetchJson(store.url), query),
    }))),
    directKeiyoushiCandidates(query),
  ]);

  const candidates: Candidate[] = [...direct];
  let storesHealthy = 0;
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    storesHealthy += 1;
    candidates.push(...result.value.rows);
  }

  candidates.sort((a, b) => b.score - a.score || Number(Boolean(b.baseUrl)) - Number(Boolean(a.baseUrl)) || a.name.localeCompare(b.name));

  const enriched: Candidate[] = [];
  for (const candidate of candidates.slice(0, 12)) {
    const baseUrl = await deriveKeiyoushiBaseUrl(candidate);
    enriched.push({ ...candidate, baseUrl });
  }

  const seen = new Set<string>();
  const unique = enriched.filter((row) => {
    const key = `${row.storeId}|${compact(row.name)}|${row.baseUrl ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => b.score - a.score || Number(Boolean(b.baseUrl)) - Number(Boolean(a.baseUrl)));

  const best = unique.find((row) => row.baseUrl) ?? unique[0];
  return json({
    ok: true,
    query,
    storesChecked: STORES.length,
    storesHealthy,
    sourceRepositoryFallback: direct.length > 0,
    found: unique.length,
    best: best ? publicCandidate(best) : null,
    matches: unique.slice(0, 8).map(publicCandidate),
  });
}
