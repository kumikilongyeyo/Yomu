/**
 * The engineering gauntlet, for the gates a machine can hold.
 *
 * The audit's release gate has fourteen of them; most need a browser, a
 * device or a person. These are the ones that are a property of what the
 * server actually sends, which means they can be run on every change instead
 * of once before a release, and they are exactly the ones that regressed
 * silently before:
 *
 *   G1  build / type safety      typecheck, unit suite, patcher is applied
 *   G2  routing                  every title entry point reaches the title
 *   G3  theme bootstrap          the mode is set before anything can paint
 *   G8  offline / PWA            caches are versioned, bounded, and not the
 *                                app's to delete
 *   G11 content safety           no open proxy, no unescaped injection
 *
 *   node tools/gauntlet.mjs                     # against a local wrangler dev
 *   node tools/gauntlet.mjs https://yomu...     # against a deployment
 *
 * Exit code is the gate: 0 is PASS, 1 is a blocked release. Every check says
 * what it wanted and what it got, because a red line that does not tell you
 * which page it was on costs more than it saves.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.argv[2] || 'http://localhost:8788').replace(/\/+$/, '');
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

let failed = 0;
let passed = 0;
const results = [];

function check(gate, what, ok, detail) {
  if (ok) { passed++; } else { failed++; }
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${gate}  ${what}${ok || !detail ? '' : `\n        ${detail}`}`);
}

/* Manual by default, because a gate that checks *where* a redirect goes must
   see the redirect. `{ redirect: 'follow' }` opts back in for the gates that
   care about the page at the end of it. */
const get = async (url, init) => {
  const response = await fetch(url, { redirect: 'manual', ...init });
  return { status: response.status, headers: response.headers, body: await response.text() };
};

/* --- G1: it builds, it passes, and the patcher has been run -------------- */

async function g1() {
  const run = (cmd, args) => {
    try {
      execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe' });
      return null;
    } catch (error) {
      return (error.stdout?.toString() || '') + (error.stderr?.toString() || '') || error.message;
    }
  };

  check('G1', 'Worker typechecks', !run('npm', ['run', 'typecheck']));
  /* The glob, not the directory: `node --test <dir>` is resolved as a
     module by this Node and fails with MODULE_NOT_FOUND. */
  const units = run('node', ['--test', 'tools/progression/*.test.js']);
  check('G1', 'unit suite passes', !units, units && units.split('\n').filter((l) => l.startsWith('✖')).slice(0, 3).join('\n        '));
  const patch = run('node', ['tools/patch-bundle.mjs', '--check']);
  check('G1', 'bundle patches are applied', !patch, patch && patch.split('\n').filter((l) => l.includes('NOT APPLIED')).slice(0, 3).join('\n        '));
}

/* --- G2: a title card's href reaches the title, with no JavaScript ------- */

async function g2() {
  const known = await get(`${BASE}/title/solo-leveling?q=Solo%20Leveling&al=105398`);
  check('G2', 'a canonical title URL redirects', known.status === 302, `got ${known.status}`);
  const to = known.headers.get('location') || '';
  check('G2', 'and it redirects to a series page, not to search',
    /\/series\/[^?]+\?source=/.test(to), `went to ${to || '(nowhere)'}`);

  const unknown = await get(`${BASE}/title/zzz-not-a-real-title?q=zzz%20not%20a%20real%20title`);
  check('G2', 'an unknown title falls through to search deliberately',
    unknown.status === 302 && /\/search\?q=/.test(unknown.headers.get('location') || ''),
    `got ${unknown.status} -> ${unknown.headers.get('location')}`);

  const empty = await get(`${BASE}/title/`);
  check('G2', 'a title route with no name does not 500', empty.status < 500, `got ${empty.status}`);

  /* The href a rail card actually renders has to be that route, not a search
     fallback dressed up by a click handler. */
  const rails = fs.readFileSync(path.join(ROOT, 'dist-app/yomu-open-title.js'), 'utf8');
  check('G2', 'title cards are bound to the canonical route',
    /node\.href = canonicalHref\(item\);/.test(rails),
    'yomu-open-title.js bind() must set the canonical href');
  check('G2', 'modified clicks are left to the browser',
    /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/.test(rails));
}

/* --- G3: the mode is decided before the first paint ---------------------- */

/* Extensionless, because that is what the asset server canonicalises to: a
   request for /find.html is answered with a 307 to /find. A reader following
   a link is redirected, so the gate follows redirects too -- checking the body
   of a 307 would only ever be checking an empty string. */
const THEME_ROUTES = ['/', '/find', '/library', '/you', '/settings', '/discover'];

async function g3() {
  for (const route of THEME_ROUTES) {
    const page = await get(`${BASE}${route}`, { redirect: 'follow' });
    if (page.status >= 400) { check('G3', `${route} is served`, false, `got ${page.status}`); continue; }
    const head = page.body.slice(page.body.indexOf('<head'), page.body.indexOf('</head>'));
    const boot = head.indexOf('id="yomu-boot"');
    check('G3', `${route} carries the prepaint bootstrap`, boot >= 0);
    if (boot < 0) continue;
    const before = head.slice(0, boot);
    check('G3', `${route} runs it before any stylesheet or script`,
      !/<link[^>]*stylesheet|<script[^>]*src=/.test(before),
      'something paintable is loaded ahead of the mode');
  }

  const pages = fs.readdirSync(path.join(ROOT, 'dist-app')).filter((f) => f.endsWith('.html'));
  const late = pages.filter((f) => /dataset\.mode\s*=\s*localStorage/.test(
    fs.readFileSync(path.join(ROOT, 'dist-app', f), 'utf8'),
  ));
  check('G3', 'no page re-interprets the mode for itself', late.length === 0, late.join(', '));
}

/* --- G8: the service worker's caches ------------------------------------- */

async function g8() {
  const sw = await get(`${BASE}/sw.js`);
  check('G8', 'the service worker is served', sw.status === 200, `got ${sw.status}`);
  check('G8', 'its shell cache is versioned', /const SHELL_VERSION = '[^']+'/.test(sw.body));
  check('G8', 'it deletes its own older caches on activate',
    /caches\.delete\(name\)/.test(sw.body) && /name !== SHELL/.test(sw.body));
  check('G8', 'it never deletes the downloads the reader asked for',
    /OURS = \/\^yomu-shell-\//.test(sw.body),
    'cleanup must be scoped to this worker\'s own cache names');
  check('G8', 'the shell cache is bounded', /SHELL_MAX_ENTRIES = \d+/.test(sw.body));
  check('G8', 'the API is never cached', /pathname\.startsWith\('\/api\/'\)\) return/.test(sw.body));
}

/* --- G11: nothing that takes a URL will fetch anything ------------------- */

async function g11() {
  const openProxy = await get(`${BASE}/api/img?u=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`);
  check('G11', 'the image proxy refuses a link-local address',
    openProxy.status >= 400, `got ${openProxy.status}`);

  const scheme = await get(`${BASE}/api/img?u=${encodeURIComponent('file:///etc/passwd')}`);
  check('G11', 'the image proxy refuses a file: URL', scheme.status >= 400, `got ${scheme.status}`);

  /* The series rewriter puts provider text into attributes. It escapes. */
  const meta = fs.readFileSync(path.join(ROOT, 'worker/series-meta.ts'), 'utf8');
  check('G11', 'injected metadata is attribute-escaped',
    /escapeAttr\(/.test(meta) && /replace\(\/"\/g, '&quot;'\)/.test(meta));
}

/* --- run ----------------------------------------------------------------- */

const only = process.argv.slice(3).filter((a) => /^G\d+$/i.test(a)).map((a) => a.toUpperCase());
const gates = { G1: g1, G2: g2, G3: g3, G8: g8, G11: g11 };

console.log(`\nYomu engineering gauntlet — ${BASE}\n`);
for (const [name, fn] of Object.entries(gates)) {
  if (only.length && !only.includes(name)) continue;
  try {
    await fn();
  } catch (error) {
    check(name, 'gate ran to completion', false, error.message);
  }
}
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
