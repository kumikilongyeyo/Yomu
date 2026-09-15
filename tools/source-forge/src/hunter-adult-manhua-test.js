import fs from 'node:fs/promises';
import { testCandidate } from './hunter.js';

const candidates = [
  {
    host: 'manhuagold.top',
    name: 'ManhuaGold',
    url: 'https://manhuagold.top/',
    countsTowardGoal: true,
    promotionTags: ['hunter-v2', '18+', 'manhua', 'high-quality', 'fresh-5d'],
    evidence: [{ ecosystem: 'aidoku-community', repo: 'Aidoku-Community/sources', sourceId: 'en.manhuagold', tags: ['manhua', 'adult-capable'] }]
  },
  {
    host: 'manhuaplus.org',
    name: 'ManhuaPlus.org',
    url: 'https://manhuaplus.org/',
    countsTowardGoal: true,
    promotionTags: ['hunter-v2', '18+', 'manhua', 'high-quality', 'fresh-5d'],
    evidence: [{ ecosystem: 'aidoku-community', repo: 'Aidoku-Community/sources', sourceId: 'en.manhuaplusorg', tags: ['manhua', 'adult-capable'] }]
  },
  {
    host: 'comix.to',
    name: 'Comix',
    url: 'https://comix.to/',
    countsTowardGoal: true,
    promotionTags: ['hunter-v2', '18+', 'manhua', 'high-quality', 'fresh-5d'],
    evidence: [{ ecosystem: 'aidoku-community', repo: 'Aidoku-Community/sources', sourceId: 'en.comix', tags: ['manhua', 'adult-capable'] }]
  },
  {
    host: 'mangafire.to',
    name: 'MangaFire',
    url: 'https://mangafire.to/',
    countsTowardGoal: true,
    promotionTags: ['hunter-v2', '18+', 'manhua', 'high-quality', 'fresh-5d'],
    evidence: [{ ecosystem: 'aidoku-community', repo: 'Aidoku-Community/sources', sourceId: 'multi.mangafire', tags: ['manhua', 'adult-capable'] }]
  },
  {
    host: 'tapas.io',
    name: 'Tapas',
    url: 'https://tapas.io/',
    countsTowardGoal: false,
    promotionTags: ['hunter-v2', 'official', 'public-free', 'high-quality', 'fresh-5d'],
    evidence: [{ ecosystem: 'keiyoushi', repo: 'keiyoushi/extensions-source', sourceId: 'en.tapastic', tags: ['official-platform', 'public-free-only'] }]
  }
];

const config = { freshDays: 5, timeout: 18000, maxProbes: 12 };
const results = [];
for (const candidate of candidates) {
  console.log(`Testing ${candidate.name} — ${candidate.url}`);
  const result = await testCandidate(candidate, config);
  result.countsTowardGoal = candidate.countsTowardGoal;
  result.promotionTags = candidate.promotionTags;
  results.push(result);
  console.log(`${result.status} ${result.score}/100 — ${(result.reasons || []).join('; ')}`);
}

const adultManhuaPass = results.filter(x => x.status === 'PASS' && x.countsTowardGoal);
const tapas = results.find(x => x.host === 'tapas.io') || null;
const generatedAt = new Date().toISOString();
const report = {
  schema: 'yomu.hunter-targeted-report/2',
  target: 'two adult-capable manhua sources plus Tapas public/free reader',
  generatedAt,
  freshDays: 5,
  requestedAdultManhuaPasses: 2,
  adultManhuaPassCount: adultManhuaPass.length,
  tapasStatus: tapas?.status || 'NOT_TESTED',
  results
};
const pack = {
  schema: 'yomu.source-pack/1',
  id: 'yomu-hunter-adult-manhua-candidates',
  name: 'Yomu Hunter Adult Manhua Candidates',
  version: 2,
  updatedAt: generatedAt,
  sources: adultManhuaPass.slice(0, 2).map(row => ({
    url: row.url,
    tags: row.promotionTags
  }))
};

await fs.mkdir('hunter-adult-manhua-output', { recursive: true });
await fs.writeFile('hunter-adult-manhua-output/report.json', JSON.stringify(report, null, 2) + '\n');
await fs.writeFile('hunter-adult-manhua-output/candidate-pack.json', JSON.stringify(pack, null, 2) + '\n');
await fs.writeFile(
  'hunter-adult-manhua-output/summary.md',
  `# Adult/manhua + Tapas Hunter test\n\nAdult/manhua goal: ${adultManhuaPass.length}/2 PASS\nTapas: ${tapas?.status || 'NOT_TESTED'}${tapas ? ` (${tapas.score}/100)` : ''}\n\n${results.map(r => `- ${r.status} — ${r.name}: ${r.score}/100 — ${(r.reasons || []).join('; ')}`).join('\n')}\n`
);

process.exit(0);
