import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHost, sameHost, testCandidate } from './hunter.js';

const TREE_URL = 'https://api.github.com/repos/keiyoushi/extensions-source/git/trees/main?recursive=1';
const RAW_ROOT = 'https://raw.githubusercontent.com/keiyoushi/extensions-source/main';
const USER_AGENT = 'Yomu-GitHub-Recipe-Hunter/1.0 (+github.com/kumikilongyeyo/Yomu)';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

function compact(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function fetchText(url, timeout = 20000) {
  const githubToken = String(process.env.GITHUB_TOKEN || '').trim();
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: url.includes('api.github.com') ? 'application/vnd.github+json' : 'text/plain,*/*;q=0.5',
      ...(githubToken && /(?:api|raw)\.githubusercontent\.com|api\.github\.com/i.test(url)
        ? { Authorization: `Bearer ${githubToken}` }
        : {})
    },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

function parseBuild(text) {
  const vars = new Map();
  for (const match of String(text || '').matchAll(/\b(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["'](https?:\/\/[^"']+)["']/g)) {
    vars.set(match[1], match[2]);
  }
  const literalBaseUrl = text.match(/\bbaseUrl\s*=\s*["'](https?:\/\/[^"']+)["']/)?.[1] || '';
  const baseRef = text.match(/\bbaseUrl\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1] || '';
  const baseUrl = literalBaseUrl || vars.get(baseRef) || '';
  return {
    name: text.match(/\bname\s*=\s*["']([^"']+)["']/)?.[1] || '',
    baseUrl,
    language: text.match(/\blang\s*=\s*["']([^"']+)["']/)?.[1] || '',
    theme: text.match(/\btheme\s*=\s*["']([^"']+)["']/)?.[1] || '',
    version: Number(text.match(/\bversionCode\s*=\s*(\d+)/)?.[1] || 1),
  };
}

function parseBuildPath(filePath) {
  const match = String(filePath || '').match(/^src\/(en|all)\/([^/]+)\/build\.gradle\.kts$/);
  if (!match) return null;
  return { path: filePath, languageDir: match[1], slug: match[2] };
}

function westernWeight(row) {
  const slug = compact(row.slug);
  let score = 0;
  if (/(comic|comix|webtoon|webcomic|toon|graphic|strip)/.test(slug)) score += 100;
  if (/(fury|hiveworks|tapas|tapastic|kingdom|pepper|globalcomix)/.test(slug)) score += 70;
  if (row.languageDir === 'en' || row.languageDir === 'all') score += 10;
  return score;
}

function rotate(rows, max, salt = 0) {
  if (!rows.length) return [];
  const count = Math.min(Math.max(1, max), rows.length);
  const day = Math.floor(Date.now() / 86400000) + salt;
  const start = (day * count) % rows.length;
  return Array.from({ length: count }, (_, i) => rows[(start + i) % rows.length]);
}

async function sourceTree() {
  const document = JSON.parse(await fetchText(TREE_URL, 30000));
  const rows = Array.isArray(document?.tree) ? document.tree : [];
  return rows.map(row => parseBuildPath(row?.path)).filter(Boolean);
}

async function loadKnownHosts() {
  const hosts = new Set();
  const add = value => {
    const host = normalizeHost(value);
    if (host) hosts.add(host);
  };
  try {
    const pack = JSON.parse(await fs.readFile(path.join(repoRoot, 'dist-app/source-packs/community.json'), 'utf8'));
    for (const source of pack.sources || []) add(source.url);
  } catch {}
  try {
    const index = JSON.parse(await fs.readFile(path.join(repoRoot, 'extensions/index.json'), 'utf8'));
    for (const ext of index.extensions || []) for (const host of ext.hosts || []) add(host);
  } catch {}
  return hosts;
}

function alreadyKnown(url, known) {
  return [...known].some(host => sameHost(url, host));
}

async function buildCandidates(rows, known, fetchBudget) {
  const candidates = [];
  for (const row of rows.slice(0, fetchBudget)) {
    try {
      const build = parseBuild(await fetchText(`${RAW_ROOT}/${row.path}`, 10000));
      if (!build.baseUrl || alreadyKnown(build.baseUrl, known)) continue;
      const host = normalizeHost(build.baseUrl);
      if (!host || !host.includes('.')) continue;
      candidates.push({
        host,
        name: build.name || row.slug,
        url: build.baseUrl,
        score: 42 + westernWeight(row),
        evidence: [{
          key: `keiyoushi-source:${row.path}`,
          ecosystem: 'keiyoushi-source',
          repo: 'keiyoushi/extensions-source',
          sourceId: row.slug,
          path: row.path,
          languages: [build.language || row.languageDir],
          version: build.version,
          theme: build.theme || null,
          baseUrl: build.baseUrl,
        }]
      });
    } catch {}
  }
  const seen = new Set();
  return candidates
    .filter(row => !seen.has(row.host) && seen.add(row.host))
    .sort((a, b) => b.score - a.score || a.host.localeCompare(b.host));
}

function markdown(report) {
  const lines = [
    '# Yomu GitHub Recipe Hunter',
    '',
    `Run: ${report.generatedAt}`,
    `Keiyoushi tree: ${report.discovery.buildRecipes} maintained build recipes`,
    `Tested: ${report.discovery.selected}`,
    '',
    `**${report.counts.pass} PASS · ${report.counts.review} REVIEW · ${report.counts.reject} REJECT**`,
    '',
    '| Status | Source | Score | Strategy |',
    '|---|---|---:|---|'
  ];
  for (const row of report.results) {
    lines.push(`| ${row.status} | ${row.name || row.host} (${row.host}) | ${row.score} | ${row.strategy || '—'} |`);
  }
  lines.push('', 'PASS is still candidate-only. Production Community Pack promotion remains gated.');
  return lines.join('\n');
}

function candidatePack(report) {
  return {
    schema: 'yomu.source-pack/1',
    id: 'yomu-github-recipe-candidates',
    name: 'Yomu GitHub Recipe Candidates',
    version: 1,
    updatedAt: report.generatedAt,
    description: 'Maintained GitHub recipe candidates that survived Hunter checks. Review before promotion.',
    sources: report.results.filter(row => row.status === 'PASS').map(row => ({
      url: row.url,
      tags: ['hunter-github', 'keiyoushi-source', `fresh-${report.config.freshDays}d`]
    }))
  };
}

function parseArgs(argv) {
  const config = {
    max: 6,
    fetchBudget: 40,
    freshDays: 5,
    timeout: 18000,
    maxProbes: 12,
    outDir: 'hunter-github-output',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--max') config.max = Number(argv[++i]) || config.max;
    else if (arg === '--fetch-budget') config.fetchBudget = Number(argv[++i]) || config.fetchBudget;
    else if (arg === '--fresh-days') config.freshDays = Number(argv[++i]) || config.freshDays;
    else if (arg === '--timeout') config.timeout = Number(argv[++i]) || config.timeout;
    else if (arg === '--max-probes') config.maxProbes = Number(argv[++i]) || config.maxProbes;
    else if (arg === '--out') config.outDir = argv[++i] || config.outDir;
  }
  config.max = Math.max(1, Math.min(20, config.max));
  config.fetchBudget = Math.max(config.max, Math.min(100, config.fetchBudget));
  config.freshDays = Math.max(1, Math.min(30, config.freshDays));
  config.timeout = Math.max(5000, Math.min(45000, config.timeout));
  return config;
}

export async function runGitHubRecipeHunter(options = {}) {
  const config = { ...parseArgs([]), ...options };
  const [tree, known] = await Promise.all([sourceTree(), loadKnownHosts()]);

  const weighted = [...tree].sort((a, b) => westernWeight(b) - westernWeight(a) || a.path.localeCompare(b.path));
  const priorityPool = weighted.filter(row => westernWeight(row) >= 70);
  const generalPool = weighted.filter(row => westernWeight(row) < 70);
  const fetchRows = [
    ...rotate(priorityPool, Math.ceil(config.fetchBudget * 0.65), 11),
    ...rotate(generalPool, Math.floor(config.fetchBudget * 0.35), 23),
  ];
  const candidates = await buildCandidates(fetchRows, known, config.fetchBudget);
  const selected = rotate(candidates, config.max, 41);
  const results = [];

  for (let i = 0; i < selected.length; i += 1) {
    const candidate = selected[i];
    console.log(`[GitHub Recipe Hunter ${i + 1}/${selected.length}] ${candidate.name} — ${candidate.url}`);
    const result = await testCandidate(candidate, config);
    results.push(result);
    console.log(`  ${result.status} ${result.score}/100 [${result.strategy || 'unknown'}]`);
  }

  const rank = { PASS: 0, REVIEW: 1, REJECT: 2 };
  results.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.score - a.score));
  const report = {
    schema: 'yomu.github-recipe-hunter-report/1',
    generatedAt: new Date().toISOString(),
    config,
    discovery: {
      buildRecipes: tree.length,
      priorityRecipes: priorityPool.length,
      fetched: fetchRows.length,
      novelCandidates: candidates.length,
      selected: selected.length,
    },
    counts: {
      pass: results.filter(row => row.status === 'PASS').length,
      review: results.filter(row => row.status === 'REVIEW').length,
      reject: results.filter(row => row.status === 'REJECT').length,
    },
    results,
  };

  const outDir = path.resolve(repoRoot, config.outDir);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'summary.md'), `${markdown(report)}\n`);
  await fs.writeFile(path.join(outDir, 'candidate-pack.json'), `${JSON.stringify(candidatePack(report), null, 2)}\n`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGitHubRecipeHunter(parseArgs(process.argv.slice(2)))
    .then(report => console.log(`GitHub Recipe Hunter complete: ${report.counts.pass} PASS, ${report.counts.review} REVIEW, ${report.counts.reject} REJECT`))
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
}
