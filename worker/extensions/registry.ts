/**
 * The extension registry: where adapters come from, and what is allowed in.
 *
 * Adapters live in a GitHub repository as data. The Worker fetches the index,
 * validates every record against the schema, then fetches and validates the
 * descriptor each record points at. Nothing is trusted on arrival: a record
 * that fails validation is dropped with a reason and the rest still load, so a
 * single bad commit in the repo cannot take Yomu's sources down.
 *
 * The same `extensions/` directory is also bundled into the Worker, so Yomu has
 * a working source set before the repo exists -- and keeps one if the repo ever
 * becomes unreachable.
 */
import { CONTENT_KINDS, CAPABILITIES, ExtensionError } from './types';
import type { Capability, ContentKind, RegistryEntry, RegistryIndex, YomuExtension } from './types';
import { compileExtension } from './runtime';
import type { Descriptor } from './runtime';
import bundledIndex from '../../extensions/index.json';
import { BUNDLED_DESCRIPTORS } from './bundled';

export const DEFAULT_REPO = 'https://raw.githubusercontent.com/yomuread/yomu-extensions/main';

const INDEX_TTL_SECONDS = 900; // 15 min: new extension versions appear within this window
const FETCH_TIMEOUT_MS = 8000;

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,48}$/;
const LANG_RE = /^([a-z]{2}(-[A-Za-z]{2,8})?|all)$/;
const HOST_RE = /^\*?\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export interface LoadedExtension {
  entry: RegistryEntry;
  descriptor: Descriptor;
  extension: YomuExtension;
}

export interface RegistrySnapshot {
  source: 'repo' | 'bundled';
  repo: string | null;
  updatedAt?: string;
  loaded: LoadedExtension[];
  /** Entries that failed validation, with the reason -- surfaced as "Broken". */
  rejected: Array<{ id: string; reason: string }>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate one index record. Returns a reason string when the record is unusable. */
export function validateEntry(raw: unknown): { entry?: RegistryEntry; reason?: string } {
  if (!isPlainObject(raw)) return { reason: 'entry is not an object' };
  const id = raw.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) return { reason: 'invalid id' };
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 80) return { reason: 'invalid name', };
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1 || raw.version > 100000) {
    return { reason: 'invalid version' };
  }
  if (typeof raw.language !== 'string' || !LANG_RE.test(raw.language)) return { reason: 'invalid language' };
  if (!Array.isArray(raw.content) || raw.content.length === 0) return { reason: 'missing content kinds' };
  const content = raw.content.filter((c): c is ContentKind => typeof c === 'string' && (CONTENT_KINDS as string[]).includes(c));
  if (!content.length) return { reason: 'no recognised content kinds' };
  if (typeof raw.module !== 'string' || !raw.module || raw.module.includes('..') || /^[a-z]+:/i.test(raw.module) || raw.module.startsWith('/')) {
    return { reason: 'module must be a relative path inside the repository' };
  }
  if (!isPlainObject(raw.capabilities)) return { reason: 'missing capabilities' };
  const capabilities = {} as Record<Capability, boolean>;
  for (const cap of CAPABILITIES) capabilities[cap] = raw.capabilities[cap] === true;
  if (!capabilities.search && !capabilities.popular && !capabilities.latest) {
    return { reason: 'extension must support at least one listing capability' };
  }
  const hosts = Array.isArray(raw.hosts)
    ? raw.hosts.filter((h): h is string => typeof h === 'string' && HOST_RE.test(h))
    : undefined;
  return {
    entry: {
      id,
      name: raw.name.trim(),
      version: raw.version,
      language: raw.language,
      content,
      module: raw.module,
      capabilities,
      ...(hosts?.length ? { hosts } : {}),
      nsfw: raw.nsfw === true,
      disabled: raw.disabled === true,
    },
  };
}

/** Validate a descriptor against the record that pointed at it. */
export function validateDescriptor(raw: unknown, entry: RegistryEntry): { descriptor?: Descriptor; reason?: string } {
  if (!isPlainObject(raw)) return { reason: 'descriptor is not an object' };
  if (raw.id !== entry.id) return { reason: `descriptor id "${String(raw.id)}" does not match index id "${entry.id}"` };
  if (raw.version !== entry.version) {
    return { reason: `descriptor version ${String(raw.version)} does not match index version ${entry.version}` };
  }
  if (typeof raw.base !== 'string') return { reason: 'missing base url' };
  let base: URL;
  try {
    base = new URL(raw.base);
  } catch {
    return { reason: 'invalid base url' };
  }
  if (base.protocol !== 'https:') return { reason: 'base url must be https' };

  const hosts = Array.isArray(raw.hosts) ? raw.hosts.filter((h): h is string => typeof h === 'string' && HOST_RE.test(h)) : [];
  if (!hosts.length) return { reason: 'descriptor declares no hosts' };
  if (hosts.some((h) => h === '*' || h === '*.')) return { reason: 'wildcard host allowlists are not permitted' };
  if (!hosts.some((h) => base.hostname === h || base.hostname.endsWith(h.replace(/^\*\./, '')))) {
    return { reason: 'base url host is not in the declared host allowlist' };
  }
  // The index may narrow, but never widen, the descriptor's reach.
  const effectiveHosts = entry.hosts?.length ? hosts.filter((h) => entry.hosts!.includes(h)) : hosts;
  if (!effectiveHosts.length) return { reason: 'index host allowlist excludes every descriptor host' };

  if (!isPlainObject(raw.endpoints)) return { reason: 'missing endpoints' };
  const endpoints: Descriptor['endpoints'] = {};
  for (const [name, ep] of Object.entries(raw.endpoints)) {
    if (!['popular', 'latest', 'search', 'series', 'chapters', 'pages'].includes(name)) continue;
    if (!isPlainObject(ep) || typeof ep.path !== 'string') return { reason: `endpoint ${name} has no path` };
    if (!isPlainObject(ep.parse) || (ep.parse.type !== 'json' && ep.parse.type !== 'html')) {
      return { reason: `endpoint ${name} has an invalid parser type` };
    }
    if (!isPlainObject(ep.parse.fields)) return { reason: `endpoint ${name} declares no fields` };
    if (ep.method != null && ep.method !== 'GET' && ep.method !== 'POST') {
      return { reason: `endpoint ${name} uses an unsupported method` };
    }
    (endpoints as any)[name] = ep;
  }
  if (!Object.keys(endpoints).length) return { reason: 'descriptor declares no usable endpoints' };

  const defaultCategory =
    typeof raw.defaultCategory === 'string' && (CONTENT_KINDS as string[]).includes(raw.defaultCategory)
      ? (raw.defaultCategory as ContentKind)
      : undefined;

  return {
    descriptor: {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      language: entry.language,
      content: entry.content,
      base: raw.base,
      hosts: effectiveHosts,
      nsfw: entry.nsfw,
      headers: isPlainObject(raw.headers)
        ? Object.fromEntries(Object.entries(raw.headers).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        : undefined,
      ...(defaultCategory ? { defaultCategory } : {}),
      ...(typeof raw.timeoutMs === 'number' && raw.timeoutMs >= 1000 && raw.timeoutMs <= 20_000
        ? { timeoutMs: raw.timeoutMs }
        : {}),
      ...(isPlainObject(raw.seriesIdFromChapter) &&
      (typeof raw.seriesIdFromChapter.regex === 'string' || typeof raw.seriesIdFromChapter.queryParam === 'string')
        ? {
            seriesIdFromChapter: {
              ...(typeof raw.seriesIdFromChapter.regex === 'string' ? { regex: raw.seriesIdFromChapter.regex } : {}),
              ...(typeof raw.seriesIdFromChapter.group === 'number' ? { group: raw.seriesIdFromChapter.group } : {}),
              ...(typeof raw.seriesIdFromChapter.queryParam === 'string'
                ? { queryParam: raw.seriesIdFromChapter.queryParam }
                : {}),
            },
          }
        : {}),
      ...(isPlainObject(raw.rateLimit) &&
      typeof raw.rateLimit.requests === 'number' &&
      typeof raw.rateLimit.perSeconds === 'number' &&
      raw.rateLimit.requests > 0 &&
      raw.rateLimit.perSeconds > 0
        ? { rateLimit: { requests: raw.rateLimit.requests, perSeconds: raw.rateLimit.perSeconds } }
        : {}),
      endpoints,
    },
  };
}

async function fetchJson(url: string, ttl: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Yomu-ExtensionRegistry/1' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cf: { cacheEverything: true, cacheTtl: ttl },
  } as RequestInit);
  if (!response.ok) throw new ExtensionError(`registry fetch returned HTTP ${response.status}`, undefined, 'registry');
  return response.json();
}

/** Assemble the registry from the repo, falling back to what is bundled. */
export async function loadRegistry(repoUrl: string | null | undefined, force = false): Promise<RegistrySnapshot> {
  const repo = (repoUrl ?? '').trim().replace(/\/+$/, '') || null;
  const rejected: Array<{ id: string; reason: string }> = [];

  let index: RegistryIndex | null = null;
  let source: 'repo' | 'bundled' = 'bundled';

  if (repo) {
    try {
      const raw = await fetchJson(`${repo}/index.json${force ? `?t=${Date.now()}` : ''}`, force ? 0 : INDEX_TTL_SECONDS);
      if (isPlainObject(raw) && Array.isArray((raw as any).extensions)) {
        index = raw as unknown as RegistryIndex;
        source = 'repo';
      } else {
        rejected.push({ id: '(index)', reason: 'repository index.json is not a valid registry' });
      }
    } catch (error: any) {
      rejected.push({ id: '(index)', reason: `repository unreachable: ${error?.message ?? 'unknown error'}` });
    }
  }
  if (!index) index = bundledIndex as unknown as RegistryIndex;

  const loaded: LoadedExtension[] = [];
  for (const rawEntry of index.extensions ?? []) {
    const { entry, reason } = validateEntry(rawEntry);
    if (!entry) {
      rejected.push({ id: String((rawEntry as any)?.id ?? '(unknown)'), reason: reason! });
      continue;
    }
    if (entry.disabled) continue;

    let rawDescriptor: unknown;
    if (source === 'repo') {
      try {
        // The version is part of the URL so a bumped version always misses cache.
        rawDescriptor = await fetchJson(`${repo}/${entry.module}?v=${entry.version}`, 86_400);
      } catch (error: any) {
        // Repo module missing or broken: fall back to the bundled copy if we have one.
        rawDescriptor = BUNDLED_DESCRIPTORS[entry.id];
        if (!rawDescriptor) {
          rejected.push({ id: entry.id, reason: `module unavailable: ${error?.message ?? 'fetch failed'}` });
          continue;
        }
      }
    } else {
      rawDescriptor = BUNDLED_DESCRIPTORS[entry.id];
      if (!rawDescriptor) {
        rejected.push({ id: entry.id, reason: 'no bundled descriptor for this entry' });
        continue;
      }
    }

    const { descriptor, reason: descReason } = validateDescriptor(rawDescriptor, entry);
    if (!descriptor) {
      rejected.push({ id: entry.id, reason: descReason! });
      continue;
    }
    try {
      loaded.push({ entry, descriptor, extension: compileExtension(descriptor) });
    } catch (error: any) {
      rejected.push({ id: entry.id, reason: `could not compile: ${error?.message ?? 'unknown'}` });
    }
  }

  return { source, repo, updatedAt: index.updatedAt, loaded, rejected };
}
