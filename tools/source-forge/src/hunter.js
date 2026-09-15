import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { discoverSeriesEntry } from './discovery.js';
import { forgeAdapter } from './forge.js';
import { detectChapterStrategies } from './heuristics.js';
import { loadPage, unique } from './runtime.js';

const AIDOKU_INDEX = 'https://raw.githubusercontent.com/Aidoku-Community/sources/gh-pages/index.min.json';
const MANGA_SCRAPER_MODULES = 'https://raw.githubusercontent.com/YofaGh/MangaScraper/master/modules.yaml';
const USER_AGENT = 'Yomu-Hunter/2.1 (+github.com/kumikilongyeyo/Yomu)';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export const normalizeHost = input => {
  try {
    return new URL(input).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return String(input || '')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0];
  }
};

export const sameHost = (a, b) => {
  const A = normalizeHost(a);
  const B = normalizeHost(b);
  return !!A && !!B && (A === B || A.endsWith(`.${B}`) || B.endsWith(`.${A}`));
};

async function fetchText(url, timeout = 30000) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json,text/plain;q=0.9,*/*;q=0.5'
    },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

export function parseMangaScraperModules(text) {
  const rows = [];
  let current = null;

  const flush = () => {
    if (current && String(current.type || '').toLowerCase() === 'manga') {
      rows.push({
        name: current.domain,
        baseUrl: `https://${current.domain}/`,
        languages: ['unknown'],
        ecosystem: 'manga-scraper',
        repo: 'YofaGh/MangaScraper',
        sample: current.sample || null
      });
    }
    current = null;
  };

  for (const line of String(text || '').split(/\r?\n/)) {
    const domain = line.match(/^([A-Za-z0-9.-]+\.[A-Za-z]{2,}):\s*$/);
    if (domain) {
      flush();
      current = { domain: domain[1] };
      continue;
    }
    if (!current) continue;

    const type = line.match(/^\s+type:\s*(.+?)\s*$/i);
    if (type) current.type = type[1].trim();

    const sample = line.match(/^\s+url:\s*["']?(.+?)["']?\s*$/i);
    if (sample && !current.sample) current.sample = sample[1].trim();
  }

  flush();
  return rows;
}

export function parseAidokuIndex(index, { allLanguages = false } = {}) {
  const sources = Array.isArray(index)
    ? index
    : Array.isArray(index?.sources)
      ? index.sources
      : [];

  return sources.flatMap(source => {
    if (!source?.baseURL) return [];
    const languages = Array.isArray(source.languages)
      ? source.languages
      : [source.language].filter(Boolean);
    const englishish = !languages.length || languages.some(language =>
      ['en', 'all'].includes(String(language).toLowerCase())
    );
    if (!allLanguages && !englishish) return [];

    return [{
      name: source.name || normalizeHost(source.baseURL),
      baseUrl: source.baseURL,
      languages,
      ecosystem: 'aidoku-community',
      repo: 'Aidoku-Community/sources',
      sourceId: source.id || null,
      version: source.version ?? null,
      contentRating: source.contentRating ?? null
    }];
  });
}

export function mergeCandidates(rows) {
  const map = new Map();

  for (const row of rows || []) {
    const host = normalizeHost(row.baseUrl);
    if (!host || !host.includes('.')) continue;

    const candidate = map.get(host) || {
      host,
      name: row.name || host,
      url: row.baseUrl || `https://${host}/`,
      evidence: [],
      score: 0
    };

    candidate.score += row.ecosystem === 'aidoku-community'
      ? 30
      : row.ecosystem === 'manga-scraper'
        ? 24
        : 10;

    const key = `${row.ecosystem}:${row.repo}:${row.sourceId || row.sample || row.baseUrl}`;
    if (!candidate.evidence.some(item => item.key === key)) {
      candidate.evidence.push({ key, ...row });
    }

    if (row.ecosystem === 'aidoku-community') {
      candidate.name = row.name || candidate.name;
      candidate.url = row.baseUrl || candidate.url;
    }

    map.set(host, candidate);
  }

  for (const candidate of map.values()) {
    if (candidate.evidence.length >= 2) candidate.score += 20;
    if (candidate.evidence.some(item =>
      (item.languages || []).some(language => String(language).toLowerCase() === 'en')
    )) candidate.score += 8;
  }

  return [...map.values()].sort((a, b) => b.score - a.score || a.host.localeCompare(b.host));
}

function parseUnix(value) {
  const raw = String(value || '').trim();
  if (!/^\d{10,13}$/.test(raw)) return null;
  const number = Number(raw);
  const ms = raw.length === 10 ? number * 1000 : number;
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function parseDateish(value, now = new Date()) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const unix = parseUnix(text);
  if (unix && !Number.isNaN(unix.getTime())) return unix;

  const lower = text.toLowerCase();
  const relative = lower.match(/\b(\d+(?:\.\d+)?)\s*(minute|hour|day|week|month)s?\s*ago\b/);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = {
      minute: 60000,
      hour: 3600000,
      day: 86400000,
      week: 604800000,
      month: 2592000000
    }[relative[2]];
    return new Date(now.getTime() - amount * unitMs);
  }

  if (/\bjust now\b|\btoday\b/.test(lower)) return new Date(now);
  if (/\byesterday\b/.test(lower)) return new Date(now.getTime() - 86400000);

  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) {
    const date = new Date(
      `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}T00:00:00Z`
    );
    if (!Number.isNaN(date.getTime())) return date;
  }

  const monthFirst = text.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s+20\d{2}\b/i);
  const dayFirst = text.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+20\d{2}\b/i);
  const named = monthFirst || dayFirst;
  if (named) {
    const cleaned = named[0].replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
    const date = new Date(cleaned);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return null;
}

function datesNearChapter($, element, now) {
  const anchor = $(element);
  const row = anchor.closest('li,tr,article,[class*="chapter"],[class*="episode"],div').first();
  const values = [
    row.text(),
    anchor.attr('title'),
    anchor.attr('data-date'),
    anchor.attr('data-time'),
    anchor.attr('data-timestamp')
  ];

  row.find('time,[datetime],[data-date],[data-time],[data-timestamp]').slice(0, 8).each((_, node) => {
    const item = $(node);
    values.push(
      item.text(),
      item.attr('datetime'),
      item.attr('data-date'),
      item.attr('data-time'),
      item.attr('data-timestamp')
    );
  });

  return values
    .map(value => parseDateish(value, now))
    .filter(date => date && !Number.isNaN(date.getTime()));
}

export async function inspectFreshness(seriesUrl, {
  freshDays = 5,
  timeout = 16000,
  now = new Date()
} = {}) {
  const page = await loadPage(seriesUrl, { scroll: false, timeout, mode: 'headless' });
  const strategy = detectChapterStrategies(page.html, page.finalUrl)[0];
  if (!strategy) {
    return { status: 'unknown', fresh: false, latestAt: null, ageDays: null, evidenceCount: 0 };
  }

  const $ = cheerio.load(page.html);
  const dates = [];
  $(strategy.selector).slice(0, 30).each((_, element) => {
    dates.push(...datesNearChapter($, element, now));
  });

  if (!dates.length) {
    return { status: 'unknown', fresh: false, latestAt: null, ageDays: null, evidenceCount: 0 };
  }

  const latest = new Date(Math.max(...dates.map(date => date.getTime())));
  const ageDays = Math.max(0, (now.getTime() - latest.getTime()) / 86400000);
  return {
    status: ageDays <= freshDays ? 'fresh' : 'stale',
    fresh: ageDays <= freshDays,
    latestAt: latest.toISOString(),
    ageDays: Number(ageDays.toFixed(2)),
    evidenceCount: dates.length
  };
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
}

function gifDimensions(buffer) {
  if (buffer.length < 10 || !/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), format: 'gif' };
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;

  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buffer.length) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
        format: 'jpeg'
      };
    }
    offset += 2 + length;
  }

  return null;
}

function webpDimensions(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  if (buffer.toString('ascii', 12, 16) !== 'VP8X') return { width: null, height: null, format: 'webp' };
  return {
    width: 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16),
    height: 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16),
    format: 'webp'
  };
}

export function parseImageDimensions(input, contentType = '') {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  return pngDimensions(buffer)
    || gifDimensions(buffer)
    || jpegDimensions(buffer)
    || webpDimensions(buffer)
    || {
      width: null,
      height: null,
      format: String(contentType).split('/')[1]?.split(';')[0] || null
    };
}

async function readPrefix(response, maxBytes = 262144) {
  if (!response.body?.getReader) {
    return Buffer.from(await response.arrayBuffer()).subarray(0, maxBytes);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const take = Math.min(value.length, maxBytes - total);
      chunks.push(Buffer.from(value.subarray(0, take)));
      total += take;
      if (take < value.length) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

async function inspectImage(url, referer, timeout) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Range: 'bytes=0-262143',
        ...(referer ? { Referer: referer } : {})
      },
      signal: AbortSignal.timeout(timeout)
    });

    const contentType = response.headers.get('content-type') || '';
    const imageish = contentType.startsWith('image/')
      || /\.(?:avif|webp|jpe?g|png|gif)(?:$|[?#])/i.test(url);
    if (!response.ok || !imageish) {
      return { url, ok: false, status: response.status, contentType };
    }

    const prefix = await readPrefix(response);
    const dimensions = parseImageDimensions(prefix, contentType);
    const lengthHeader = Number(response.headers.get('content-length')) || null;
    const rangeTotal = Number((response.headers.get('content-range') || '').match(/\/(\d+)$/)?.[1]) || null;
    const totalBytes = rangeTotal || lengthHeader;
    const width = dimensions.width || null;
    const height = dimensions.height || null;
    const pixels = width && height ? width * height : null;
    const strong = Boolean(
      (width && height && ((width >= 700 && height >= 900) || pixels >= 800000))
      || (!width && !height && totalBytes && totalBytes >= 120000)
    );

    return {
      url,
      ok: true,
      status: response.status,
      contentType,
      totalBytes,
      width,
      height,
      pixels,
      format: dimensions.format,
      strong
    };
  } catch (error) {
    return { url, ok: false, error: String(error?.message || error) };
  }
}

export async function inspectImageQuality(samplePages, { timeout = 12000, maxImages = 3 } = {}) {
  const pool = [];
  for (const sample of samplePages || []) {
    for (const url of sample.pages || []) {
      pool.push({ url, referer: sample.chapter?.url || null });
    }
  }

  const seen = new Set();
  const selected = pool
    .filter(item => !seen.has(item.url) && seen.add(item.url))
    .slice(0, maxImages);

  if (!selected.length) {
    return { status: 'unknown', highQuality: false, tested: 0, usable: 0, strong: 0, measurements: [] };
  }

  const measurements = [];
  for (const item of selected) {
    measurements.push(await inspectImage(item.url, item.referer, timeout));
  }

  const usable = measurements.filter(item => item.ok);
  const strong = usable.filter(item => item.strong).length;
  const required = Math.max(1, Math.ceil(usable.length * 0.67));
  const highQuality = usable.length >= 2 && strong >= required;

  return {
    status: usable.length < 2 ? 'unknown' : highQuality ? 'high' : 'low',
    highQuality,
    tested: measurements.length,
    usable: usable.length,
    strong,
    measurements
  };
}

async function loadExistingHosts() {
  const hosts = new Set();
  const add = value => {
    const host = normalizeHost(value);
    if (host) hosts.add(host);
  };

  try {
    const pack = JSON.parse(await fs.readFile(
      path.join(repoRoot, 'dist-app/source-packs/community.json'),
      'utf8'
    ));
    for (const source of pack.sources || []) add(source.url);
  } catch {}

  try {
    const index = JSON.parse(await fs.readFile(
      path.join(repoRoot, 'extensions/index.json'),
      'utf8'
    ));
    for (const extension of index.extensions || []) {
      for (const host of extension.hosts || []) add(host);
    }
  } catch {}

  return hosts;
}

function alreadyKnown(candidate, hosts) {
  return [...hosts].some(host => sameHost(candidate.host, host));
}

async function collectCandidates({ allLanguages = false } = {}) {
  const [aidokuResult, scraperResult] = await Promise.allSettled([
    fetchText(AIDOKU_INDEX).then(JSON.parse),
    fetchText(MANGA_SCRAPER_MODULES)
  ]);

  const rows = [];
  const registries = [];

  if (aidokuResult.status === 'fulfilled') {
    const parsed = parseAidokuIndex(aidokuResult.value, { allLanguages });
    rows.push(...parsed);
    registries.push({ name: 'Aidoku-Community/sources', ok: true, candidates: parsed.length });
  } else {
    registries.push({
      name: 'Aidoku-Community/sources',
      ok: false,
      error: String(aidokuResult.reason?.message || aidokuResult.reason)
    });
  }

  if (scraperResult.status === 'fulfilled') {
    const parsed = parseMangaScraperModules(scraperResult.value);
    rows.push(...parsed);
    registries.push({ name: 'YofaGh/MangaScraper', ok: true, candidates: parsed.length });
  } else {
    registries.push({
      name: 'YofaGh/MangaScraper',
      ok: false,
      error: String(scraperResult.reason?.message || scraperResult.reason)
    });
  }

  return { candidates: mergeCandidates(rows), registries };
}

function rotateDaily(rows, max) {
  if (!rows.length) return [];
  const limit = Math.min(Math.max(1, max), rows.length);
  const day = Math.floor(Date.now() / 86400000);
  const start = (day * limit) % rows.length;
  return Array.from({ length: limit }, (_, offset) => rows[(start + offset) % rows.length]);
}

function compactError(error) {
  return String(error?.message || error || 'Unknown error').replace(/\s+/g, ' ').slice(0, 500);
}

function candidateSeedUrls(candidate) {
  const urls = [];
  for (const evidence of candidate?.evidence || []) {
    const sample = evidence?.sample;
    if (/^https?:\/\//i.test(sample || '') && sameHost(sample, candidate.host) && !urls.includes(sample)) {
      urls.push(sample);
    }
  }
  if (candidate?.url && !urls.includes(candidate.url)) urls.push(candidate.url);
  return urls;
}

function failureKind(error) {
  const code = error?.code || '';
  const message = compactError(error).toLowerCase();
  if (code === 'ACCESS_BLOCKED' || code === 'ACCESS_CHALLENGE' || /http 403|captcha|access check/.test(message)) return 'access-blocked';
  if (code === 'NO_SERIES_DISCOVERED' || /could not automatically find a series/.test(message)) return 'discovery-miss';
  if (/timeout/.test(message)) return 'timeout';
  return 'probe-error';
}

async function tryAdapterAware(candidate, config) {
  if (sameHost(candidate.host, 'tapas.io')) {
    const { probeTapasPublicFree } = await import('./source-intel.js');
    const result = await probeTapasPublicFree(config);
    return {
      ...result,
      evidence: candidate.evidence,
      strategy: 'adapter-aware-public',
      strategyAttempts: [{ strategy: 'adapter-aware-public', input: candidate.url, ok: result.status !== 'REJECT', status: result.status }]
    };
  }
  return null;
}

async function genericProbe(candidate, config) {
  const attempts = [];
  let lastError = null;

  for (const inputUrl of candidateSeedUrls(candidate)) {
    const source = inputUrl === candidate.url ? 'generic-site' : 'registry-sample';
    try {
      const discovery = await discoverSeriesEntry(inputUrl, {
        timeout: config.timeout,
        maxProbes: config.maxProbes,
        accessMode: 'headless'
      });
      const forged = await forgeAdapter(discovery.seriesUrl, {
        timeout: config.timeout,
        accessMode: 'headless'
      });
      attempts.push({ strategy: source, input: inputUrl, ok: true, seriesUrl: discovery.seriesUrl });
      return { discovery, forged, attempts, strategy: source };
    } catch (error) {
      lastError = error;
      attempts.push({
        strategy: source,
        input: inputUrl,
        ok: false,
        failureKind: failureKind(error),
        error: compactError(error)
      });
    }
  }

  const error = lastError || new Error('No Hunter probe strategy succeeded.');
  error.strategyAttempts = attempts;
  throw error;
}

export async function testCandidate(candidate, config) {
  const startedAt = new Date().toISOString();
  try {
    const adapterAware = await tryAdapterAware(candidate, config).catch(error => ({
      adapterProbeError: compactError(error),
      adapterProbeFailureKind: failureKind(error)
    }));
    if (adapterAware?.status) {
      return {
        ...adapterAware,
        host: candidate.host,
        name: candidate.name,
        url: candidate.url,
        startedAt,
        finishedAt: new Date().toISOString()
      };
    }

    const { discovery, forged, attempts, strategy } = await genericProbe(candidate, config);

    const [freshness, quality] = await Promise.all([
      inspectFreshness(discovery.seriesUrl, {
        freshDays: config.freshDays,
        timeout: config.timeout
      }).catch(error => ({ status: 'unknown', fresh: false, error: compactError(error) })),
      inspectImageQuality(forged.samplePages, {
        timeout: Math.min(config.timeout, 14000)
      }).catch(error => ({ status: 'unknown', highQuality: false, error: compactError(error) }))
    ]);

    const gauntlet = forged.gauntlet;
    const reasons = [];
    let status = 'REVIEW';

    if (!gauntlet?.pass) {
      status = 'REJECT';
      reasons.push(`reader gauntlet ${gauntlet?.grade || 'FAIL'} (${gauntlet?.score ?? 0})`);
    }
    if (freshness.status === 'stale') {
      status = 'REJECT';
      reasons.push(`latest visible chapter is ${freshness.ageDays} days old`);
    }
    if (quality.status === 'low') {
      status = 'REJECT';
      reasons.push('reader image samples did not meet the quality floor');
    }

    if (gauntlet?.pass && freshness.fresh && quality.highQuality) {
      status = 'PASS';
      reasons.push(
        `reader ${gauntlet.grade} ${gauntlet.score}/100`,
        `fresh ${freshness.ageDays}d`,
        `${quality.strong}/${quality.usable} strong image samples`
      );
    } else if (status === 'REVIEW') {
      if (freshness.status === 'unknown') reasons.push('freshness could not be proven automatically');
      if (quality.status === 'unknown') reasons.push('image quality could not be proven automatically');
    }

    const score = Math.round(
      (gauntlet?.score || 0) * 0.55
      + (freshness.fresh ? 25 : freshness.status === 'unknown' ? 8 : 0)
      + (quality.highQuality ? 20 : quality.status === 'unknown' ? 6 : 0)
    );

    return {
      host: candidate.host,
      name: candidate.name,
      url: candidate.url,
      status,
      score,
      reasons,
      evidence: candidate.evidence,
      strategy,
      strategyAttempts: attempts,
      discovery: {
        seriesUrl: discovery.seriesUrl,
        confidence: discovery.confidence,
        inputKind: discovery.inputKind
      },
      gauntlet: {
        pass: Boolean(gauntlet?.pass),
        score: gauntlet?.score ?? 0,
        grade: gauntlet?.grade || 'FAIL',
        errors: gauntlet?.errors ?? null,
        warnings: gauntlet?.warnings ?? null
      },
      freshness,
      quality,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      host: candidate.host,
      name: candidate.name,
      url: candidate.url,
      status: 'REJECT',
      score: 0,
      reasons: [compactError(error)],
      evidence: candidate.evidence,
      strategy: 'exhausted',
      strategyAttempts: error?.strategyAttempts || [],
      errorCode: error?.code || null,
      failureKind: failureKind(error),
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

function markdownReport(report) {
  const lines = [
    '# Yomu Hunter v2.1',
    '',
    `Run: ${report.generatedAt}`,
    `Filter: adaptive strategy ladder + full reader gauntlet + high-quality image samples + activity within ${report.config.freshDays} days`,
    '',
    `**${report.counts.pass} PASS · ${report.counts.review} REVIEW · ${report.counts.reject} REJECT · ${report.counts.skippedKnown} already known**`,
    '',
    '| Status | Source | Score | Strategy | Reader | Freshness | Images |',
    '|---|---|---:|---|---|---|---|'
  ];

  for (const row of report.results) {
    const reader = row.gauntlet ? `${row.gauntlet.grade} ${row.gauntlet.score}` : '—';
    const freshness = row.freshness?.status === 'fresh'
      ? `${row.freshness.ageDays}d`
      : row.freshness?.status || '—';
    lines.push(
      `| ${row.status} | ${row.name || row.host} (${row.host}) | ${row.score} | ${row.strategy || '—'} | ${reader} | ${freshness} | ${row.quality?.status || '—'} |`
    );
  }

  lines.push('', 'PASS means candidate only. Hunter never edits the production Community Pack automatically.');
  return lines.join('\n');
}

function candidatePack(report) {
  return {
    schema: 'yomu.source-pack/1',
    id: 'yomu-hunter-candidates',
    name: 'Yomu Hunter Candidates',
    version: 2,
    updatedAt: report.generatedAt,
    description: `Hunter v2.1 survivors: adaptive probe ladder + reader gauntlet + high-quality images + activity within ${report.config.freshDays} days. Review before promotion.`,
    sources: report.results
      .filter(row => row.status === 'PASS')
      .map(row => ({
        url: row.url,
        tags: unique([
          'hunter-v2',
          'adaptive-probe',
          'high-quality',
          `fresh-${report.config.freshDays}d`,
          ...row.evidence.map(item => item.ecosystem).filter(Boolean)
        ])
      }))
  };
}

function parseArgs(argv) {
  const config = {
    max: 8,
    freshDays: 5,
    timeout: 18000,
    maxProbes: 12,
    outDir: 'hunter-output',
    allLanguages: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--max') config.max = Number(argv[++index]) || config.max;
    else if (arg === '--fresh-days') config.freshDays = Number(argv[++index]) || config.freshDays;
    else if (arg === '--timeout') config.timeout = Number(argv[++index]) || config.timeout;
    else if (arg === '--max-probes') config.maxProbes = Number(argv[++index]) || config.maxProbes;
    else if (arg === '--out') config.outDir = argv[++index] || config.outDir;
    else if (arg === '--all-languages') config.allLanguages = true;
  }

  config.max = Math.max(1, Math.min(30, config.max));
  config.freshDays = Math.max(1, Math.min(30, config.freshDays));
  config.timeout = Math.max(5000, Math.min(45000, config.timeout));
  config.maxProbes = Math.max(4, Math.min(30, config.maxProbes));
  return config;
}

export async function runHunter(options = {}) {
  const config = {
    max: 8,
    freshDays: 5,
    timeout: 18000,
    maxProbes: 12,
    outDir: 'hunter-output',
    allLanguages: false,
    ...options
  };

  const existingHosts = await loadExistingHosts();
  const discovery = await collectCandidates({ allLanguages: config.allLanguages });
  const novel = discovery.candidates.filter(candidate => !alreadyKnown(candidate, existingHosts));
  const selected = rotateDaily(novel, config.max);
  const results = [];

  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    console.log(`[Hunter ${index + 1}/${selected.length}] ${candidate.name} — ${candidate.url}`);
    const result = await testCandidate(candidate, config);
    results.push(result);
    console.log(`  ${result.status} ${result.score}/100 [${result.strategy || 'unknown'}] — ${result.reasons.join('; ')}`);
  }

  const rank = { PASS: 0, REVIEW: 1, REJECT: 2 };
  results.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.score - a.score));

  const report = {
    schema: 'yomu.hunter-report/3',
    generatedAt: new Date().toISOString(),
    config: {
      max: config.max,
      freshDays: config.freshDays,
      timeout: config.timeout,
      maxProbes: config.maxProbes,
      allLanguages: config.allLanguages,
      adaptiveStrategies: true
    },
    registries: discovery.registries,
    discovery: {
      totalCandidates: discovery.candidates.length,
      novelCandidates: novel.length,
      selected: selected.length
    },
    counts: {
      pass: results.filter(row => row.status === 'PASS').length,
      review: results.filter(row => row.status === 'REVIEW').length,
      reject: results.filter(row => row.status === 'REJECT').length,
      skippedKnown: discovery.candidates.length - novel.length
    },
    results
  };

  const outDir = path.resolve(repoRoot, config.outDir);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'summary.md'), `${markdownReport(report)}\n`);
  await fs.writeFile(path.join(outDir, 'candidate-pack.json'), `${JSON.stringify(candidatePack(report), null, 2)}\n`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHunter(parseArgs(process.argv.slice(2)))
    .then(report => {
      console.log(
        `Hunter complete: ${report.counts.pass} PASS, ${report.counts.review} REVIEW, ${report.counts.reject} REJECT`
      );
    })
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
}
