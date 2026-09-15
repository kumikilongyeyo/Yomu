import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const unique = values => [...new Set((values || []).filter(Boolean))];

export function freshnessTag(row, freshDays = 5) {
  if (row?.freshness?.fresh) return `fresh-${freshDays}d`;
  if (row?.freshness?.status === 'stale') return 'back-catalog';
  return 'freshness-unverified';
}

export function isPromotionEligible(row) {
  if (!row) return false;

  const qualityGood = row?.quality?.highQuality === true;
  if (!qualityGood) return false;

  // Normal Source Forge candidates must prove a working reader gauntlet.
  if (row?.gauntlet) return row.gauntlet.pass === true;

  // Adapter-aware official/public probes (for example Tapas) can prove the
  // reader through their own public endpoint + page checks instead.
  if (row?.adapterAware) {
    const publicEpisodes = Number(row?.discovery?.freeEpisodeCount || 0);
    return publicEpisodes > 0;
  }

  return false;
}

export function availabilityState(row, freshDays = 5) {
  const eligible = isPromotionEligible(row);
  if (!eligible) {
    return {
      eligible: false,
      availability: 'rejected',
      freshnessPriority: 'n/a',
      freshnessTag: freshnessTag(row, freshDays)
    };
  }

  const priority = row?.freshness?.fresh
    ? 'preferred'
    : row?.freshness?.status === 'stale'
      ? 'back-catalog'
      : 'unverified';

  return {
    eligible: true,
    availability: 'readable',
    freshnessPriority: priority,
    freshnessTag: freshnessTag(row, freshDays)
  };
}

export function buildAvailabilityPack(report) {
  const freshDays = Number(report?.config?.freshDays || report?.freshDays || 5);
  const results = Array.isArray(report?.results) ? report.results : [];
  const eligible = results.filter(isPromotionEligible);

  return {
    schema: 'yomu.source-pack/1',
    id: 'yomu-hunter-candidates',
    name: 'Yomu Hunter Candidates',
    version: 3,
    updatedAt: report?.generatedAt || new Date().toISOString(),
    description: `Availability-first Hunter survivors. Reader + image quality are hard gates; freshness within ${freshDays} days is a ranking preference, not a requirement. Review before production promotion.`,
    sources: eligible.map(row => ({
      url: row.url,
      tags: unique([
        'hunter-v2',
        'adaptive-probe',
        'readable',
        'high-quality',
        freshnessTag(row, freshDays),
        ...(row.evidence || []).map(item => item?.ecosystem)
      ])
    }))
  };
}

export function availabilitySummary(report) {
  const freshDays = Number(report?.config?.freshDays || report?.freshDays || 5);
  const results = Array.isArray(report?.results) ? report.results : [];
  const states = results.map(row => ({ row, state: availabilityState(row, freshDays) }));
  const eligible = states.filter(item => item.state.eligible);
  const preferred = eligible.filter(item => item.state.freshnessPriority === 'preferred').length;
  const unverified = eligible.filter(item => item.state.freshnessPriority === 'unverified').length;
  const backCatalog = eligible.filter(item => item.state.freshnessPriority === 'back-catalog').length;

  const lines = [
    '',
    '## Availability-first promotion policy',
    '',
    `**${eligible.length} readable candidate(s): ${preferred} fresh-preferred · ${unverified} freshness-unverified · ${backCatalog} back-catalog**`,
    '',
    'Freshness is intentionally a soft signal. A source can be promoted as a candidate when its reader path and image quality are proven even if update recency is unknown or older.',
    ''
  ];

  for (const { row, state } of states) {
    if (!state.eligible) continue;
    lines.push(`- ${row.name || row.host}: readable · ${state.freshnessPriority} · ${row.strategy || 'generic'}`);
  }

  return lines.join('\n');
}

export async function applyAvailabilityPolicy({
  reportPath = 'hunter-output/report.json',
  packPath = 'hunter-output/candidate-pack.json',
  summaryPath = 'hunter-output/summary.md'
} = {}) {
  const absoluteReport = path.resolve(repoRoot, reportPath);
  const absolutePack = path.resolve(repoRoot, packPath);
  const absoluteSummary = path.resolve(repoRoot, summaryPath);
  const report = JSON.parse(await fs.readFile(absoluteReport, 'utf8'));
  const pack = buildAvailabilityPack(report);

  await fs.writeFile(absolutePack, `${JSON.stringify(pack, null, 2)}\n`);
  await fs.appendFile(absoluteSummary, `${availabilitySummary(report)}\n`);
  return { report, pack };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--report') options.reportPath = argv[++i];
    else if (argv[i] === '--pack') options.packPath = argv[++i];
    else if (argv[i] === '--summary') options.summaryPath = argv[++i];
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyAvailabilityPolicy(parseArgs(process.argv.slice(2)))
    .then(({ pack }) => {
      console.log(`Availability policy complete: ${pack.sources.length} readable candidate(s) eligible.`);
    })
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
}
