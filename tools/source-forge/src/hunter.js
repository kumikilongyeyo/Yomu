import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'node:url';
import { discoverSeriesEntry } from './discovery.js';
import { forgeAdapter } from './forge.js';
import { loadPage, unique } from './runtime.js';
import { detectChapterStrategies } from './heuristics.js';

const AIDOKU_COMMUNITY_INDEX = 'https://raw.githubusercontent.com/Aidoku-Community/sources/gh-pages/index.min.json';
const MANGA_SCRAPER_MODULES = 'https://raw.githubusercontent.com/YofaGh/MangaScraper/master/modules.yaml';
const USER_AGENT = 'Yomu-Hunter/2.0 (+github.com/kumikilongyeyo/Yomu)';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export const normalizeHost = input => {
  try { return new URL(input).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return String(input || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; }
};

export const sameHost = (a, b) => {
  a = normalizeHost(a); b = normalizeHost(b);
  return !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
};

async function fetchText(url, timeout = 30000) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain, application/json;q=0.9, */*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url, timeout = 30000) {
  return JSON.parse(await fetchText(url, timeout));
}

export function parseMangaScraperModules(text) {
  const rows = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    if (String(current.type || '').toLowerCase() === 'manga') {
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
  for (const raw of String(text || '').split(/\r?\n/)) {
    const top = raw.match(/^([A-Za-z0-9.-]+\.[A-Za-z]{2,}):\s*$/);
    if (top) {
      flush();
      current = { domain: top[1] };
      continue;
    }
    if (!current) continue;
    const type = raw.match(/^\s+type:\s*(.+?)\s*$/i);
    if (type) current.type = type[1].trim();
    const sample = raw.match(/^\s+url:\s*["']?(.+?)["']?\s*$/i);
    if (sample && !current.sample) current.sample = sample[1].trim();
  }
  flush();
  return rows;
}

export function parseAidokuIndex(index, { allLanguages = false } = {}) {
  const list = Array.isArray(index) ? index : (Array.isArray(index?.sources) ? index.sources : []);
  const rows = [];
  for (const source of list) {
    if (!source?.baseURL) continue;
    const languages = Array.isArray(source.languages) ? source.languages : [source.language].filter(Boolean);
    const englishish = !languages.length || languages.some(x => ['en', 'all'].includes(String(x).toLowerCase()));
    if (!allLanguages && !englishish) continue;
    rows.push({
      name: source.name || normalizeHost(source.baseURL),
      baseUrl: source.baseURL,
      languages,
      ecosystem: 'aidoku-community',
      repo: 'Aidoku-Community/sources',
      sourceId: source.id || null,
      contentRating: source.contentRating ?? null,
      version: source.version ?? null
    });
  }
  return rows;
}

export function mergeCandidates(rows) {
  const merged = new Map();
  for (const row of rows || []) {
    const host = normalizeHost(row.baseUrl);
    if (!host || !host.includes('.')) continue;
    const old = merged.get(host) || {
      host,
      name: row.name || host,
      url: row.baseUrl || `https://${host}/`,
      evidence: [],
      score: 0
    };
    if (row.ecosystem === 'aidoku-community') old.score += 30;
    else if (row.ecosystem === 'manga-scraper') old.score += 24;
    else old.score += 10;
    const key = `${row.ecosystem}:${row.repo}:${row.sourceId || row.sample || row.baseUrl}`;
    if (!old.evidence.some(x => x.key === key)) old.evidence.push({ key, ...row });
    if (row.ecosystem === 'aidoku-community') {
      old.name = row.name || old.name;
      old.url = row.baseUrl || old.url;
    }
    merged.set(host, old);
  }
  for (const row of merged.values()) {
    if (row.evidence.length >= 2) row.score += 20;
    if (row.evidence.some(x => (x.languages || []).some(l => String(l).toLowerCase() === 'en'))) row.score += 8;
  }
  return [...merged.values()].sort((a, b) => b.score - a.score || a.host.localeCompare(b.host));
}

function parseUnix(value) {
  const raw = String(value || '').trim();
  if (!/^\d{10,13}$/.test(raw)) return null;
  const n = Number(raw);
  const ms = raw.length === 10 ? n * 1000 : n;
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
    const n = Number(relative[1]);
    const units = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };
    return new Date(now.getTime() - n * units[relative[2]]);
  }
  if (/\bjust now\b|\btoday\b/.test(lower)) return new Date(now);
  if (/\byesterday\b/.test(lower)) return new Date(now.getTime() - 86400000);

  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s][0-9:.+-Z]*)?/i);
  if (iso) {
    const d = new Date(`${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const monthName = text.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s+20\d{2}\b/i)
    || text.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+20\d{2}\b/i);
  if (monthName) {
    const cleaned = monthName[0].replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
    const d = new Date(cleaned);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function collectDateCandidates($, anchor, now) {
  const $a = $(anchor);
  const $row = $a.closest('li, tr, article, [class*="chapter"], [class*="episode"], div').first();
  const values = [$row.text(), $a.attr('title'), $a.attr('data-date'), $a.attr('data-time'), $a.attr('data-timestamp')];
  $row.find('time, [datetime], [data-date], [data-time], [data-timestamp]').slice(0, 8).each((_, el) => {
    const $el = $(el);
    values.push($el.attr('datetime'), $el.attr('data-date'), $el.attr('data-time'), $el.attr('data-timestamp'), $el.text());
  });
  return values.map(v => parseDateish(v, now)).filter(d => d && !Number.isNaN(d.getTime()));
}

export async function inspectFreshness(seriesUrl, { freshDays = 5, timeout = 16000, accessMode = 'auto', now = new Date() } = {}) {
  const page = await loadPage(seriesUrl, { scroll: false, timeout, mode: accessMode });
  const strategies = detectChapterStrategies(page.html, page.finalUrl);
  const strategy = strategies[0];
  if (!strategy) return { status: 'unknown', fresh: false, latestAt: null, ageDays: null, evidenceCount: 0 };
  const $ = cheerio.load(page.html);
  const dates = [];
  $(strategy.selector).slice(0, 30).each((_, el) => dates.push(...collectDateCandidates($, el, now)));
  if (!dates.length) return { status: 'unknown', fresh: false, latestAt: null, ageDays: null, evidenceCount: 0 };
  const latest = new Date(Math.max(...dates.map(d => d.getTime())));
  const ageDays = Math.max(0, (now.getTime() - latest.getTime()) / 86400000);
  return {
    status: ageDays <= freshDays ? 'fresh' : 'stale',
    fresh: ageDays <= freshDays,
    latestAt: latest.toISOString(),
    ageDays: +ageDays.toFixed(2),
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
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    if (offset + 4 > buffer.length) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && offset + 9 < buffer.length) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), format: 'jpeg' };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buffer.toString('ascii', 12, 16);
  if (kind === 'VP8X' && buffer.length >= 30) {
    const width = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
    const height = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
    return { width, height, format: 'webp' };
  }
  return { width: null, height: null, format: 'webp' };
}

export function parseImageDimensions(buffer, contentType = '') {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  return pngDimensions(buffer) || gifDimensions(buffer) || jpegDimensions(buffer) || webpDimensions(buffer)
    || { width: null, height: null, format: String(contentType).split('/')[1]?.split(';')[0] || null };
}

async function readPrefix(response, maxBytes = 262144) {
  if (!response.body?.getReader) return Buffer.from(await response.arrayBuffer()).subarray(0, maxBytes);
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

async function inspectImage(url, referer, timeout = 12000) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Range: 'bytes=0-262143',
        ...(referer ? { Referer: referer } : {})
      },
      signal: AbortSignal.timeout(timeout)
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || (!contentType.startsWith('image/') && response.status !== 206)) {
      return { url, ok: false, status: response.status, contentType };
    }
    const prefix = await readPrefix(response);
    const dims = parseImageDimensions(prefix, contentType);
    const lengthHeader = Number(response.headers.get('content-length')) || null;
    const totalBytes = response.status === 206
      ? Number((response.headers.get('content-range') || '').match(/\/(\d+)$/)?.[1]) || lengthHeader
      : lengthHeader;
    const width = dims.width || null;
    const height = dims.height || null;
    const pixels = width && height ? width * height : null;
    const strong = !!(
      (width && height && ((width >= 700 && height >= 900) || pixels >= 800000))
      || (!width && !height && totalBytes && totalBytes >= 120000)
    );
    return { url, ok: true, status: response.status, contentType, totalBytes, width, height, pixels, format: dims.format, strong };
  } catch (error) {
    return { url, ok: false, error: error?.message || String(error) };
  }
}

export async function inspectImageQuality(samplePages, { timeout = 12000, maxImages = 3 } = {}) {
  const pool = [];
  for (const sample of samplePages || []) {
    for (const url of sample.pages || []) pool.push({ url, referer: sample.chapter?.url || null });
  }
  const seen = new Set();
  const selected = pool.filter(x => !seen.has(x.url) && seen.add(x.url)).slice(0, maxImages);
  if (!selected.length) return { status: 'unknown', highQuality: false, tested: 0, strong: 0, measurements: [] };
  const measurements = [];
  for (const item of selected) measurements.push(await inspectImage(item.url, item.referer, timeout));
  const usable = measurements.filter(x => x.ok);
  const strong = usable.filter(x => x.strong).length;
  const needed = Math.max(1, Math.ceil(usable.length * 0.67));
  const highQuality = usable.length >= 2 && strong >= needed;
  return {
    status: usable.length < 2 ? 'unknown' : highQuality ? 'high' : 'low',
    highQuality,
    tested: measurements.length,
    usable: usable.length,
    strong,
    measurements
  };
}

async function loadExistingHosts(root = repoRoot) {
  const hosts = new Set();
  const add = value => { const h = normalizeHost(value); if (h) hosts.add(h); };
  try {
    const pack = JSON.parse(await fs.readFile(path.join(root, 'dist-app/source-packs/community.json'), 'utf8'));
    for (const source of pack.sources || []) add(source.url);
  } catch {}
  try {
    const index = JSON.parse(await fs.readFile(path.join(root, 'extensions/index.json'), 'utf8'));
    for (const ext of index.extensions || []) for (const host of ext.hosts || []) add(host);
  } catch {}
  return hosts;
}

function isAlreadyKnown(candidate, existingHosts) {
  for (const host of existingHosts) if (sameHost(candidate.host, host)) return true;
  return false;
}

function dayChunk(rows, max) {
  if (!rows.length) return [];
  const day = Math.floor(Date.now() / 86400000);
  const start = (day * Math.max(1, max)) % rows.length;
  const out = [];
  for (let i = 0; i < Math.min(max, rows.length); i++) out.push(rows[(start + i) % rows.length]);
  return out;
}

async function collectGitHubCandidates({ allLanguages = false } = {}) {
  const [aidoku, scraper] = await Promise.allSettled([
    fetchJson(AIDOKU_COMMUNITY_INDEX),
    fetchText(MANGA_SCRAPER_MODULES)
  ]);
  const rows = [];
  const registries = [];
  if (aidoku.status === 'fulfilled') {
    const parsed = parseAidokuIndex(aidoku.value, { allLanguages });
    rows.push(...parsed);
    registries.push({ name: 'Aidoku-Community/sources', ok: true, candidates: parsed.length });
  } else registries.push({ name: 'Aidoku-Community/sources', ok: false, error: aidoku.reason?.message || String(aidoku.reason) });
  if (scraper.status === 'fulfilled') {
    const parsed = parseMangaScraperModules(scraper.value);
    rows.push(...parsed);
    registries.push({ name: 'YofaGh/MangaScraper', ok: true, candidates: parsed.length });
  } else registries.push({ name: 'YofaGh/MangaScraper', ok: false, error: scraper.reason?.message || String(scraper.reason) });
  return { candidates: mergeCandidates(rows), registries };
}

function compactError(error) {
  return String(error?.message || error || 'Unknown error').replace(/\s+/g, ' ').slice(0, 500);
}

async function huntCandidate(candidate, options) {
  const startedAt = new Date().toISOString();
  try {
    const discovery = await discoverSeriesEntry(candidate.url, {
      timeout: options.timeout,
      maxProbes: options.maxProbes,
      accessMode: 'headless'
    });
    const forged = await forgeAdapter(discovery.seriesUrl, { timeout: options.timeout, accessMode: 'headless' });
    const [freshness, quality] = await Promise.all([
      inspectFreshness(discovery.seriesUrl, { freshDays: options.freshDays, timeout: options.timeout, accessMode: 'headless' }).catch(error => ({ status: 'unknown', fresh: false, error: compactError(error) })),
      inspectImageQuality(forged.samplePages, { timeout: Math.min(options.timeout, 14000) }).catch(error => ({ status: 'unknown', highQuality: false, error: compactError(error) }))
    ]);
    const gauntlet = forged.gauntlet;
    let status = 'REVIEW';
    const reasons = [];
    if (!gauntlet?.pass) { status = 'REJECT'; reasons.push(`reader gauntlet ${gauntlet?.grade || 'FAIL'} (${gauntlet?.score ?? 0})`); }
    if (freshness.status === 'stale') { status = 'REJECT'; reasons.push(`latest visible chapter is ${freshness.ageDays} days old`); }
    if (quality.status === 'low') { status = 'REJECT'; reasons.push('sample reader images did not meet the quality floor'); }
    if (gauntlet?.pass && freshness.fresh && quality.highQuality) {
      status = 'PASS';
      reasons.push(`reader ${gauntlet.grade} ${gauntlet.score}/100`, `fresh ${freshness.ageDays}d`, `${quality.strong}/${quality.usable} strong image samples`);
    } else if (status === 'REVIEW') {
      if (freshness.status === 'unknown') reasons.push('freshness date could not be proven automatically');
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
      discovery: { seriesUrl: discovery.seriesUrl, confidence: discovery.confidence, inputKind: discovery.inputKind },
      gauntlet: { pass: !!gauntlet?.pass, score: gauntlet?.score ?? 0, grade: gauntlet?.grade || 'FAIL', errors: gauntlet?.errors ?? null, warnings: gauntlet?.warnings ?? null },
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
      errorCode: error?.code || null,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

function reportMarkdown(report) {
  const lines = [
    '# Yomu Hunter v2',
    '',
    `Run: ${report.generatedAt}`,
    `Filter: reader gauntlet + high-quality image samples + chapter activity within ${report.config.freshDays} days`,
    '',
    `**${report.counts.pass} PASS · ${report.counts.review} REVIEW · ${report.counts.reject} REJECT · ${report.counts.skippedKnown} already known**`,
    '',
    '| Status | Source | Score | Reader | Freshness | Image quality |',
    '|---|---|---:|---|---|---|'
  ];
  for (const row of report.results) {
    const reader = row.gauntlet ? `${row.gauntlet.grade} ${row.gauntlet.score}` : '—';
    const fresh = row.freshness?.status === 'fresh' ? `${row.freshness.ageDays}d` : (row.freshness?.status || '—');
    const quality = row.quality?.status || '—';
    lines.push(`| ${row.status} | ${row.name || row.host} (${row.host}) | ${row.score} | ${reader} | ${fresh} | ${quality} |`);
  }
  lines.push('', 'PASS sources are candidates only. Hunter never edits the production Community Pack automatically.');
  return lines.join('\n');
}

function candidatePack(report) {
  return {
    schema: 'yomu.source-pack/1',
    id: 'yomu-hunter-candidates',
    name: 'Yomu Hunter Candidates',
    version: 1,
    updatedAt: report.generatedAt,
    description: `Hunter v2 survivors: full reader gauntlet, high-quality image samples, and visible chapter activity within ${report.config.freshDays} days. Review before promoting.`,
    sources: report.results.filter(x => x.status === 'PASS').map(x => ({
      url: x.url,
      tags: unique(['hunter-v2', 'high-quality', `fresh-${report.config.freshDays}d`, ...x.evidence.map(e => e.ecosystem).filter(Boolean)])
    }))
  };
}

function parseArgs(argv) {
  const out = { max: 8, freshDays: 5, timeout: 18000, maxProbes: 12, outDir: 'hunter-output', allLanguages: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max') out.max = Number(argv[++i]) || out.max;
    else if (arg === '--fresh-days') out.freshDays = Number(argv[++i]) || out.freshDays;
    else if (arg === '--timeout') out.timeout = Number(argv[++i]) || out.timeout;
    else if (arg === '--max-probes') out.maxProbes = Number(argv[++i]) || out.maxProbes;
    else if (arg === '--out') out.outDir = argv[++i] || out.outDir;
    else if (arg === '--all-languages') out.allLanguages = true;
  }
  out.max = Math.max(1, Math.min(30, out.max));
  out.freshDays = Math.max(1, Math.min(30, out.freshDays));
  out.timeout = Math.max(5000, Math.min(45000, out.timeout));
  return out;
}

export async function runHunter(options = {}) {
  const config = { max: 8, freshDays: 5, timeout: 18000, maxProbes: 12, outDir: 'hunter-output', allLanguages: false, ...options };
  const existing = await loadExistingHosts();
  const github = await collectGitHubCandidates({ allLanguages: config.allLanguages });
  const novel = github.candidates.filter(x => !isAlreadyKnown(x, existing));
  const skippedKnown = github.candidates.length - novel.length;
  const selected = dayChunk(novel, config.max);
  const results = [];
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i];
    console.log(`[Hunter ${i + 1}/${selected.length}] ${c.name} — ${c.url}`);
    const result = await huntCandidate(c, config);
    results.push(result);
    console.log(`  ${result.status} ${result.score}/100 — ${result.reasons.join('; ')}`);
  }
  results.sort((a, b) => ({ PASS: 0, REVIEW: 1, REJECT: 2 }[a.status] - ({ PASS: 0, REVIEW: 1, REJECT: 2 }[b.status]) || b.score - a.score);
  const report = {
    schema: 'yomu.hunter-report/2',
    generatedAt: new Date().toISOString(),
    config: { max: config.max, freshDays: config.freshDays, timeout: config.timeout, maxProbes: config.maxProbes, allLanguages: config.allLanguages },
    registries: github.registries,
    discovery: { totalCandidates: github.candidates.length, novelCandidates: novel.length, selected: selected.length },
    counts: {
      pass: results.filter(x => x.status === 'PASS').length,
      review: results.filter(x => x.status === 'REVIEW').length,
      reject: results.filter(x => x.status === 'REJECT').length,
      skippedKnown
    },
    results
  };
  const outDir = path.resolve(repoRoot, config.outDir);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(outDir, 'summary.md'), reportMarkdown(report) + '\n');
  await fs.writeFile(path.join(outDir, 'candidate-pack.json'), JSON.stringify(candidatePack(report), null, 2) + '\n');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  runHunter(options).then(report => {
    console.log(`Hunter complete: ${report.counts.pass} PASS, ${report.counts.review} REVIEW, ${report.counts.reject} REJECT`);
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
