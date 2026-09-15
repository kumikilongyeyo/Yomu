import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSeriesEntry } from './discovery.js';
import { forgeAdapter } from './forge.js';
import { inspectFreshness, inspectImageQuality, normalizeHost } from './hunter.js';

const AIDOKU_INDEX = 'https://raw.githubusercontent.com/Aidoku-Community/sources/gh-pages/index.min.json';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const OUT_DIR = path.join(repoRoot, 'adult-hunter-output');
const TARGET_PASSES = 2;
const MAX_ATTEMPTS = 8;
const FRESH_DAYS = 5;
const TIMEOUT = 15000;
const WEBTOON_HINT = /(manhwa|manhua|webtoon|toon)/i;

function compactError(error) {
  return String(error?.message || error || 'Unknown error').replace(/\s+/g, ' ').slice(0, 500);
}

function sameHost(a, b) {
  const A = normalizeHost(a);
  const B = normalizeHost(b);
  return !!A && !!B && (A === B || A.endsWith(`.${B}`) || B.endsWith(`.${A}`));
}

async function existingHosts() {
  const pack = JSON.parse(await fs.readFile(path.join(repoRoot, 'dist-app/source-packs/community.json'), 'utf8'));
  return (pack.sources || []).map(source => normalizeHost(source.url)).filter(Boolean);
}

async function fetchAdultCandidates() {
  const response = await fetch(AIDOKU_INDEX, {
    headers: { 'User-Agent': 'Yomu-Hunter-Adult-Smoke/1.0' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Aidoku index returned HTTP ${response.status}`);
  const body = await response.json();
  const sources = Array.isArray(body?.sources) ? body.sources : [];
  const known = await existingHosts();

  const adult = sources
    .filter(source => Number(source?.contentRating) >= 2)
    .filter(source => Array.isArray(source?.languages) && source.languages.some(language => ['en', 'all'].includes(String(language).toLowerCase())))
    .filter(source => source?.baseURL)
    .filter(source => !known.some(host => sameHost(source.baseURL, host)))
    .map(source => ({
      host: normalizeHost(source.baseURL),
      name: source.name || normalizeHost(source.baseURL),
      url: source.baseURL,
      sourceId: source.id || null,
      contentRating: source.contentRating,
      languages: source.languages || [],
      priority: WEBTOON_HINT.test(`${source.name || ''} ${source.baseURL || ''}`) ? 1 : 0
    }))
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  return adult;
}

async function testCandidate(candidate) {
  const startedAt = new Date().toISOString();
  try {
    const discovery = await discoverSeriesEntry(candidate.url, {
      timeout: TIMEOUT,
      maxProbes: 8,
      accessMode: 'headless'
    });
    const forged = await forgeAdapter(discovery.seriesUrl, {
      timeout: TIMEOUT,
      accessMode: 'headless'
    });

    const [freshness, quality] = await Promise.all([
      inspectFreshness(discovery.seriesUrl, {
        freshDays: FRESH_DAYS,
        timeout: TIMEOUT
      }).catch(error => ({ status: 'unknown', fresh: false, error: compactError(error) })),
      inspectImageQuality(forged.samplePages, {
        timeout: Math.min(TIMEOUT, 12000)
      }).catch(error => ({ status: 'unknown', highQuality: false, error: compactError(error) }))
    ]);

    const gauntlet = forged.gauntlet;
    const pass = Boolean(gauntlet?.pass && freshness.fresh && quality.highQuality);
    const reasons = [];
    if (!gauntlet?.pass) reasons.push(`reader gauntlet ${gauntlet?.grade || 'FAIL'} (${gauntlet?.score ?? 0})`);
    if (!freshness.fresh) reasons.push(freshness.status === 'stale' ? `latest visible chapter is ${freshness.ageDays} days old` : 'freshness could not be proven');
    if (!quality.highQuality) reasons.push(quality.status === 'low' ? 'reader images below quality floor' : 'image quality could not be proven');
    if (pass) reasons.push(`reader ${gauntlet.grade} ${gauntlet.score}/100`, `fresh ${freshness.ageDays}d`, `${quality.strong}/${quality.usable} strong image samples`);

    return {
      ...candidate,
      status: pass ? 'PASS' : 'REJECT',
      score: Math.round((gauntlet?.score || 0) * 0.55 + (freshness.fresh ? 25 : 0) + (quality.highQuality ? 20 : 0)),
      reasons,
      discovery: { seriesUrl: discovery.seriesUrl, confidence: discovery.confidence, inputKind: discovery.inputKind },
      gauntlet: { pass: Boolean(gauntlet?.pass), score: gauntlet?.score ?? 0, grade: gauntlet?.grade || 'FAIL' },
      freshness,
      quality,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      ...candidate,
      status: 'REJECT',
      score: 0,
      reasons: [compactError(error)],
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

function markdown(report) {
  const lines = [
    '# Yomu Adult Hunter smoke test',
    '',
    `Goal: ${TARGET_PASSES} verified 18+ manhwa/manhua/webtoon sources`,
    `Freshness gate: <= ${FRESH_DAYS} days`,
    '',
    `**${report.passes.length}/${TARGET_PASSES} PASS after ${report.results.length} attempts**`,
    '',
    '| Status | Source | Score | Reader | Freshness | Images |',
    '|---|---|---:|---|---|---|'
  ];
  for (const row of report.results) {
    lines.push(`| ${row.status} | ${row.name} (${row.host}) | ${row.score} | ${row.gauntlet ? `${row.gauntlet.grade} ${row.gauntlet.score}` : '—'} | ${row.freshness?.fresh ? `${row.freshness.ageDays}d` : row.freshness?.status || '—'} | ${row.quality?.status || '—'} |`);
  }
  return lines.join('\n');
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const candidates = await fetchAdultCandidates();
  const results = [];
  const passes = [];

  for (const candidate of candidates.slice(0, MAX_ATTEMPTS)) {
    console.log(`[Adult Hunter] ${candidate.name} — ${candidate.url}`);
    const result = await testCandidate(candidate);
    results.push(result);
    console.log(`  ${result.status} ${result.score}/100 — ${result.reasons.join('; ')}`);
    if (result.status === 'PASS') passes.push(result);
    if (passes.length >= TARGET_PASSES) break;
  }

  const report = {
    schema: 'yomu.hunter-adult-smoke/1',
    generatedAt: new Date().toISOString(),
    targetPasses: TARGET_PASSES,
    availableCandidates: candidates.length,
    results,
    passes: passes.slice(0, TARGET_PASSES)
  };

  const candidatePack = {
    schema: 'yomu.source-pack/1',
    id: 'yomu-adult-hunter-smoke',
    name: 'Yomu Adult Hunter Smoke Survivors',
    version: 1,
    updatedAt: report.generatedAt,
    description: 'Strict Hunter survivors: adult-rated source metadata + reader gauntlet + high-quality images + visible chapter activity within 5 days.',
    sources: report.passes.map(row => ({
      url: row.url,
      tags: ['18+', 'adult', 'manhwa-manhua-webtoon', 'hunter-v2', 'high-quality', 'fresh-5d']
    }))
  };

  await fs.writeFile(path.join(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(OUT_DIR, 'summary.md'), `${markdown(report)}\n`);
  await fs.writeFile(path.join(OUT_DIR, 'candidate-pack.json'), `${JSON.stringify(candidatePack, null, 2)}\n`);

  if (report.passes.length < TARGET_PASSES) {
    throw new Error(`Adult Hunter found only ${report.passes.length}/${TARGET_PASSES} strict PASS sources. Community Pack was not changed.`);
  }

  console.log(`Adult Hunter complete: ${report.passes.length}/${TARGET_PASSES} strict PASS.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
