import fs from 'node:fs/promises';
import { testCandidate } from './hunter.js';

const candidates = [
  {
    host: 'comix.to',
    name: 'Comix',
    url: 'https://comix.to/',
    evidence: [{ ecosystem: 'aidoku-community', repo: 'Aidoku-Community/sources', sourceId: 'en.comix', tags: ['manhua', 'adult-capable'] }]
  },
  {
    host: 'mangafire.to',
    name: 'MangaFire',
    url: 'https://mangafire.to/',
    evidence: [{ ecosystem: 'aidoku-community', repo: 'Aidoku-Community/sources', sourceId: 'multi.mangafire', tags: ['manhua', 'adult-capable'] }]
  }
];

const config = { freshDays: 5, timeout: 18000, maxProbes: 12 };
const results = [];
for (const candidate of candidates) {
  console.log(`Testing ${candidate.name} — ${candidate.url}`);
  const result = await testCandidate(candidate, config);
  results.push(result);
  console.log(`${result.status} ${result.score}/100 — ${(result.reasons || []).join('; ')}`);
}

const pass = results.filter(x => x.status === 'PASS');
const generatedAt = new Date().toISOString();
const report = {
  schema: 'yomu.hunter-targeted-report/1',
  target: 'adult-capable manhua sources',
  generatedAt,
  freshDays: 5,
  requestedPasses: 2,
  passCount: pass.length,
  results
};
const pack = {
  schema: 'yomu.source-pack/1',
  id: 'yomu-hunter-adult-manhua-candidates',
  name: 'Yomu Hunter Adult Manhua Candidates',
  version: 1,
  updatedAt: generatedAt,
  sources: pass.slice(0, 2).map(row => ({
    url: row.url,
    tags: ['hunter-v2', '18+', 'manhua', 'high-quality', 'fresh-5d']
  }))
};

await fs.mkdir('hunter-adult-manhua-output', { recursive: true });
await fs.writeFile('hunter-adult-manhua-output/report.json', JSON.stringify(report, null, 2) + '\n');
await fs.writeFile('hunter-adult-manhua-output/candidate-pack.json', JSON.stringify(pack, null, 2) + '\n');
await fs.writeFile(
  'hunter-adult-manhua-output/summary.md',
  `# Adult/manhua Hunter test\n\n${pass.length}/2 PASS\n\n${results.map(r => `- ${r.status} — ${r.name}: ${r.score}/100 — ${(r.reasons || []).join('; ')}`).join('\n')}\n`
);

process.exit(0);
