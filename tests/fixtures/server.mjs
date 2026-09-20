/**
 * Fixture app server.
 *
 * Serves the real dist-app export with the Worker's route mapping, and answers
 * /api/* from tests/fixtures/catalog.mjs instead of the internet. Per-source
 * latency and failure are set at runtime through /__fixture/config, which is
 * what makes "one dead provider must not block the visible batch" a test
 * rather than an opinion.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PAGES_PER_SOURCE, collection, extensions, searchPage, sourcePage } from './catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/* YOMU_DIST lets the benchmark point the same server at the baseline export,
   so "2x faster" is one harness measuring two trees rather than two harnesses. */
const DIST = process.env.YOMU_DIST ? path.resolve(process.env.YOMU_DIST) : path.join(ROOT, 'dist-app');

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}));

/** Runtime knobs a test flips before loading a page. */
const config = {
  latency: {},          // sourceId -> ms
  fail: {},             // sourceId -> true | { pages: [2, 3] }
  baseLatency: 12,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (res, body, status = 200) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(text);
};

async function sendFile(res, file) {
  try {
    const extension = path.extname(file).toLowerCase();
    let body = await fsp.readFile(file);
    if (extension === '.html') {
      body = Buffer.from(injectHelpers(body.toString('utf8'), path.relative(DIST, file).split(path.sep).join('/')), 'utf8');
    }
    res.writeHead(200, {
      'content-type': TYPES.get(extension) || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
    return true;
  } catch { return false; }
}

const exists = (file) => {
  try { return fs.statSync(file).isFile(); } catch { return false; }
};

/* --- release wiring ------------------------------------------------------ *
 *
 * scripts/optimize-export.py injects the route-aware helper tags in CI, just
 * before upload, so the committed HTML does not carry them. Tests must see
 * what production serves, and a second hand-maintained copy of that list is
 * exactly how a test stops describing the release. The lists are read out of
 * the optimizer itself.
 */
/* The tree being served supplies its own wiring, so pointing YOMU_DIST at the
   baseline export measures the baseline's release, not this branch's. */
const OPTIMIZER = path.join(path.dirname(DIST), 'scripts', 'optimize-export.py');

function pythonList(source, name) {
  const match = source.match(new RegExp(`^${name}\\s*=\\s*\\[([\\s\\S]*?)^\\]`, 'm'));
  if (!match) throw new Error(`optimize-export.py has no ${name} list`);
  const out = [];
  for (const line of match[1].split('\n')) {
    const tag = line.match(/^\s*'(<[^']+>)',?\s*$/);
    if (tag) out.push(tag[1]);
    const splat = line.match(/^\s*\*(\w+),?\s*$/);
    if (splat) out.push(...pythonList(source, splat[1]));
  }
  return out;
}

function helperTags() {
  const source = fs.readFileSync(OPTIMIZER, 'utf8');
  const groups = {};
  for (const name of ['COMMON', 'LIBRARY', 'CATALOG', 'SEARCH', 'READER', 'SOURCES']) {
    groups[name] = pythonList(source, name);
  }
  const pages = (name) => new Set(
    (source.match(new RegExp(`^${name}\\s*=\\s*\\{([^}]*)\\}`, 'm'))?.[1] || '')
      .split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean),
  );
  return {
    groups,
    catalogPages: pages('CATALOG_PAGES'),
    searchPages: pages('SEARCH_PAGES'),
    sourcePages: pages('SOURCE_PAGES'),
  };
}

const WIRING = helperTags();

function tagsFor(relative) {
  const tags = [...WIRING.groups.COMMON];
  if (WIRING.catalogPages.has(relative)) tags.push(...WIRING.groups.CATALOG);
  else if (WIRING.searchPages.has(relative)) tags.push(...WIRING.groups.SEARCH);
  else if (WIRING.sourcePages.has(relative)) tags.push(...WIRING.groups.SOURCES);
  else if (relative.startsWith('read/') || relative.startsWith('series/')) tags.push(...WIRING.groups.READER);
  return [...new Set(tags)];
}

function injectHelpers(html, relative) {
  if (!html.includes('</head>')) return html;
  const missing = tagsFor(relative).filter((tag) => !html.includes(tag));
  return missing.length ? html.replace('</head>', missing.join('') + '</head>') : html;
}

/** dist-app is an Expo export: /find is find.html, /series/x is series/[id].html. */
function resolveRoute(pathname) {
  const clean = decodeURIComponent(pathname.split('?')[0]).replace(/^\/+/, '');
  if (!clean) return path.join(DIST, 'index.html');

  const direct = path.join(DIST, clean);
  if (exists(direct)) return direct;
  if (exists(direct + '.html')) return direct + '.html';
  if (exists(path.join(direct, 'index.html'))) return path.join(direct, 'index.html');

  const segments = clean.split('/');
  if (segments.length >= 2) {
    const dynamic = path.join(DIST, segments[0], `[${segments[0] === 'read' ? 'chapterId' : 'id'}].html`);
    if (exists(dynamic)) return dynamic;
  }
  return path.join(DIST, 'index.html');
}

function sourceFailure(id, page) {
  const rule = config.fail[id];
  if (!rule) return false;
  if (rule === true) return true;
  if (Array.isArray(rule.pages)) return rule.pages.includes(page);
  return false;
}

async function api(req, res, url, origin) {
  const parts = url.pathname.split('/').filter(Boolean); // api, ext, source, <id>, <verb>
  const page = Math.max(1, Number(url.searchParams.get('page') || '1') || 1);

  if (url.pathname === '/api/ext/sources') {
    await sleep(config.baseLatency);
    return json(res, { extensions: extensions(origin) });
  }

  if (parts[1] === 'ext' && parts[2] === 'source' && parts[3]) {
    const id = parts[3];
    const verb = parts[4] || 'series';
    await sleep(config.baseLatency + (config.latency[id] || 0));
    if (sourceFailure(id, page)) return json(res, { error: 'fixture failure' }, 503);
    if (verb === 'search') {
      return json(res, { series: searchPage(id, url.searchParams.get('q'), page), page, hasMore: page < PAGES_PER_SOURCE });
    }
    return json(res, { series: sourcePage(id, page), page, hasMore: page < PAGES_PER_SOURCE });
  }

  /* The app asks for these on boot. Answering them keeps the console-clean
     gate about the product instead of about the fixture. */
  if (url.pathname === '/api/profile') return json(res, { account: 'local-account', name: 'Fixture reader', avatar: null });
  if (url.pathname.startsWith('/api/md/manga')) {
    // The MangaDex passthrough the search fast lane warms with.
    await sleep(config.baseLatency);
    const rows = searchPage('alpha', url.searchParams.get('title') || 'manga', page);
    return json(res, { data: rows.map((row) => ({ id: row.id, attributes: { title: { en: row.title } }, relationships: [] })) });
  }
  if (url.pathname === '/api/sync' || url.pathname.startsWith('/api/sync/')) return json(res, { ok: true, rows: [] });

  if (url.pathname === '/api/catalog/chapters') {
    // A ledger with dated releases on a fixed weekly cadence, so Mori's
    // "next release" estimate is a value the test can predict exactly.
    await sleep(config.baseLatency);
    const week = 7 * 86400000;
    const latest = Date.UTC(2026, 8, 14);
    const rows = Array.from({ length: 42 }, (_, i) => ({
      number: 42 - i,
      label: String(42 - i),
      name: `Chapter ${42 - i}`,
      publishedAt: latest - i * week,
      releases: [{ providerId: 'ext:alpha', providerName: 'Alpha Comics', chapterId: `c${42 - i}` }],
    }));
    return json(res, {
      rows,
      gaps: [],
      sources: [{ providerId: 'ext:alpha', providerName: 'Alpha Comics', kind: 'extension', seriesId: 'alpha-1', chapterCount: rows.length, ok: true }],
      partial: false,
      generatedAt: Date.now(),
    });
  }

  if (url.pathname.startsWith('/api/catalog/')) {
    const kind = url.pathname.split('/')[3] || 'popular';
    await sleep(config.baseLatency + (config.latency.mangadex || 0));
    if (sourceFailure('mangadex', page)) return json(res, { error: 'fixture failure' }, 503);
    if (kind === 'search') {
      const rows = searchPage('alpha', url.searchParams.get('q'), page)
        .map((row) => ({ ...row, providers: [{ id: 'mangadex', name: 'MangaDex', seriesId: row.id }] }));
      return json(res, { series: rows, providersTried: 1, providersTotal: 1 });
    }
    return json(res, { series: sourcePage('mangadex', page), page, hasMore: page < PAGES_PER_SOURCE });
  }

  return json(res, { error: 'not a fixture route', path: url.pathname }, 404);
}

export async function startFixtureServer({ port = 0 } = {}) {
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, origin);

    if (url.pathname === '/__fixture/config') {
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        config.latency = body.latency || {};
        config.fail = body.fail || {};
        config.baseLatency = Number.isFinite(body.baseLatency) ? body.baseLatency : 12;
      }
      return json(res, { ok: true, config });
    }
    if (url.pathname === '/__fixture/collection') {
      return json(res, collection(origin, { includeNami: url.searchParams.get('nami') !== '0' }));
    }
    if (url.pathname.startsWith('/api/')) return api(req, res, url, origin);
    if (url.pathname === '/fixtures/cover.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="#2a3a4a"/></svg>');
    }

    const file = resolveRoute(url.pathname);
    if (await sendFile(res, file)) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4173);
  const { origin } = await startFixtureServer({ port });
  console.log(`Yomu fixture server on ${origin}`);
}
