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
 *   U14 accessibility            secondary text clears WCAG AA in every
 *                                palette, not only the one anybody looked at
 *   U7  mode integrity           no component sheet reaches for a
 *                                mode-specific token behind the mode's back
 *   G10 main-thread cost         no forced layout inside a sort comparator,
 *                                which is what locked /sources
 *   G14 crawlability             robots.txt and sitemap.xml are themselves,
 *                                not the SPA shell with a 200 on it
 *
 *   node tools/gauntlet.mjs                     # against a local wrangler dev
 *   node tools/gauntlet.mjs https://yomu...     # against a deployment
 *   node tools/gauntlet.mjs --offline           # only the gates that read
 *                                               # files, for CI before deploy
 *
 * Exit code is the gate: 0 is PASS, 1 is a blocked release. Every check says
 * what it wanted and what it got, because a red line that does not tell you
 * which page it was on costs more than it saves.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const urlArg = process.argv.slice(2).find((a) => /^https?:\/\//.test(a));
const BASE = (urlArg || 'http://localhost:8788').replace(/\/+$/, '');
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

let failed = 0;
let passed = 0;
const results = [];

function check(gate, what, ok, detail) {
  if (ok) { passed++; } else { failed++; }
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${gate}  ${what}${ok || !detail ? '' : `\n        ${detail}`}`);
}

let warned = 0;

/* An upstream that did not answer is not a release defect.
 *
 * This runs against production *after* deploying, and a failure here rolls
 * the release back. Some of G2 depends on third-party providers answering a
 * search, so a provider outage could roll back a perfectly good release for
 * something no commit caused. A warning says so without pulling the release,
 * and still shows up in the log for a person to read. Only use it where the
 * evidence distinguishes "nobody answered" from "we misbehaved" -- a warning
 * that cannot tell those apart is just a disabled check. */
function warn(gate, what, detail) {
  warned++;
  results.push(`WARN  ${gate}  ${what}${detail ? `\n        ${detail}` : ''}`);
}

/* How many results the catalog itself returned, or -1 when that is unknown.
   -1 is deliberately not 0: "we could not tell" must not excuse a failure. */
async function catalogAnswers(query) {
  try {
    const r = await get(`${BASE}/api/catalog/search?q=${encodeURIComponent(query)}`, { redirect: 'follow' });
    if (r.status !== 200) return -1;
    const body = JSON.parse(r.body);
    return Array.isArray(body?.series) ? body.series.length : -1;
  } catch {
    return -1;
  }
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
      /* `npm` is npm.cmd on Windows and execFile will not find it without a
         shell. CI is Linux, but a gate a developer cannot run locally is a
         gate that gets ignored. */
      execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' });
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
  if (/\/series\/[^?]+\?source=/.test(to)) {
    check('G2', 'and it redirects to a series page, not to search', true);
  } else {
    /* Falling through to search is what this route is *supposed* to do when
       nothing carries the title, so before calling it a defect, ask whether
       anything answered at all. */
    const answers = await catalogAnswers('Solo Leveling');
    if (answers === 0) {
      warn('G2', 'no provider answered, so a known title fell through to search',
        `went to ${to || '(nowhere)'} -- the route behaved correctly; the sources are down`);
    } else {
      check('G2', 'and it redirects to a series page, not to search', false,
        `went to ${to || '(nowhere)'}${answers > 0 ? ` while the catalog returned ${answers} result(s)` : ''}`);
    }
  }

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

/* --- U14: contrast, in every palette and both modes ---------------------- *
 *
 * `--faint` is the app's secondary text -- the reason under a rail, the hint
 * under an accordion heading, the "of 100" under a progress bar. It cleared
 * AA on Aurora, which is the palette anybody looks at while building, and
 * failed on all five of the others: 2.37:1 on Scanlation against a 4.5:1
 * requirement. A token is one value read by a hundred places, so this is
 * checked at the token rather than per component.
 */

const relativeLuminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a, b) => {
  const hi = Math.max(relativeLuminance(a), relativeLuminance(b));
  const lo = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (hi + 0.05) / (lo + 0.05);
};

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Every ground/ink pair the app can actually be wearing. */
function palettes() {
  const skin = fs.readFileSync(path.join(ROOT, 'dist-app/yomu-skin.css'), 'utf8');
  const skins = fs.readFileSync(path.join(ROOT, 'dist-app/yomu-skins.css'), 'utf8');
  const grab = (src, name) => (src.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i')) || [])[1];

  const rows = [
    { name: 'base/paper', bg: grab(skin, '--pa-bg'), inks: { faint: grab(skin, '--pa-faint'), dim: grab(skin, '--pa-dim'), muted: grab(skin, '--pa-muted') } },
    { name: 'base/aurora', bg: grab(skin, '--au-bg'), inks: { faint: grab(skin, '--au-faint'), dim: grab(skin, '--au-dim'), muted: grab(skin, '--au-muted') } },
  ];
  for (const id of ['autumn', 'midnight', 'neon', 'scanlation', 'gilt']) {
    const after = skins.split(`[data-yomu-skin='${id}']`)[1];
    if (!after) continue;
    const body = after.slice(0, after.indexOf('}'));
    for (const [prefix, mode] of [['pa', 'paper'], ['au', 'aurora']]) {
      const bg = grab(body, `--${prefix}-bg`);
      if (!bg) continue;
      rows.push({
        name: `${id}/${mode}`,
        bg,
        inks: {
          faint: grab(body, `--${prefix}-faint`),
          dim: grab(body, `--${prefix}-dim`),
          muted: grab(body, `--${prefix}-muted`),
        },
      });
    }
  }
  return rows;
}

async function u14() {
  for (const palette of palettes()) {
    if (!palette.bg) { check('U14', `${palette.name} declares a ground`, false); continue; }
    for (const [role, ink] of Object.entries(palette.inks)) {
      if (!ink) continue;
      const ratio = contrast(hexToRgb(ink), hexToRgb(palette.bg));
      check('U14', `${palette.name} ${role} clears AA`, ratio >= 4.5,
        `${ink} on ${palette.bg} is ${ratio.toFixed(2)}:1, needs 4.5`);
    }
  }
}

/* --- U7: a component may not pick a mode for the reader ------------------ *
 *
 * `--pa-*` and `--au-*` are the Paper and Aurora *sources*. The mode picks
 * between them once, in yomu-skin.css, and every component downstream is
 * supposed to read the resolved name -- `--surface`, `--text`, `--bg`.
 *
 * This exists because a component sheet reached for `--pa-surface` directly,
 * to dodge a `var()` cycle, and painted every glass panel opaque cream in
 * Aurora with near-white text still on top: the streak card, the families
 * card, the circle card and the save buttons all went unreadable in dark
 * mode. The U14 gate did not catch it, because U14 checks the tokens in the
 * palettes and this was a component reading the wrong palette on purpose.
 *
 * Only the two files that *define* the palettes may name those sources.
 */

const PALETTE_FILES = new Set(['yomu-skin.css', 'yomu-skins.css']);

async function u7() {
  const dir = path.join(ROOT, 'dist-app');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    if (PALETTE_FILES.has(file)) continue;
    const css = fs.readFileSync(path.join(dir, file), 'utf8');
    const reaches = [...css.matchAll(/var\(\s*--(pa|au)-[a-z0-9-]+/gi)].map((m) => m[0].replace(/var\(\s*/, ''));
    check('U7', `${file} reads the resolved tokens, not one mode's`, reaches.length === 0,
      `${[...new Set(reaches)].join(', ')} — use --surface/--text/--bg, which the mode has already chosen`);
  }
}

/* --- G14: what a crawler is actually served ------------------------------ *
 *
 * `not_found_handling: "single-page-application"` answers anything unmatched
 * with index.html and a 200. That is right for app routes and wrong for the
 * two files a crawler asks for by name: a robots.txt full of HTML is not
 * parseable, a sitemap.xml full of HTML is an error, and both report success.
 * The failure is invisible from inside the app, which is why it is a gate.
 */

async function g14() {
  const robots = await get(`${BASE}/robots.txt`);
  check('G14', 'robots.txt is text, not the app shell', robots.status === 200
    && (robots.headers.get('content-type') || '').includes('text/plain')
    && !robots.body.includes('<!DOCTYPE'), `content-type ${robots.headers.get('content-type')}`);
  check('G14', 'robots.txt points at the sitemap', /^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m.test(robots.body));
  check('G14', 'robots.txt keeps crawlers out of the reader and the API',
    /^Disallow: \/api\/$/m.test(robots.body) && /^Disallow: \/read\/$/m.test(robots.body));

  const map = await get(`${BASE}/sitemap.xml`);
  check('G14', 'sitemap.xml is XML, not the app shell', map.status === 200
    && (map.headers.get('content-type') || '').includes('xml')
    && map.body.startsWith('<?xml'), `content-type ${map.headers.get('content-type')}`);
  check('G14', 'sitemap.xml lists the reading surfaces',
    /<loc>https?:\/\/[^<]*\/<\/loc>/.test(map.body) && map.body.includes('/find'));
  check('G14', 'sitemap.xml does not publish provider-bound series URLs',
    !map.body.includes('/series/'),
    'those addresses change when a source dies; /title/ is the one that survives');
}

/* --- G10: the shapes that lock a tab ------------------------------------- *
 *
 * `getBoundingClientRect()` inside a sort comparator forces a synchronous
 * layout on every comparison -- O(n log n) reflows for one call. In
 * source-fabric-layout.js that call ran twice per DOM mutation, from an
 * observer watching the whole document that never disconnected, over every
 * element under #root. It was survivable until the v8 shell enlarged that
 * tree, and then /sources stopped responding to input at all.
 *
 * Measure once into a map, then sort on the numbers.
 */

const LAYOUT_READS = /getBoundingClientRect|offsetWidth|offsetHeight|offsetTop|offsetLeft|getComputedStyle|scrollHeight|scrollWidth/;

async function g10() {
  const dir = path.join(ROOT, 'dist-app');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const js = fs.readFileSync(path.join(dir, file), 'utf8');
    /* A comparator is `.sort(` up to its closing brace; good enough to catch
       the shape without parsing JavaScript. */
    const offenders = [];
    for (const match of js.matchAll(/\.sort\(\s*\((?:[^)]*)\)\s*=>\s*\{([\s\S]{0,400}?)\}\s*\)/g)) {
      if (LAYOUT_READS.test(match[1])) offenders.push(match[1].trim().split('\n')[0].slice(0, 60));
    }
    check('G10', `${file} does not force layout inside a sort`, offenders.length === 0,
      `${offenders.join(' | ')} — measure once into a map, then sort on the numbers`);
  }
}

/* --- run ----------------------------------------------------------------- */

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const only = args.filter((a) => /^[GU]\d+$/i.test(a)).map((a) => a.toUpperCase());
const gates = { G1: g1, G2: g2, G3: g3, G8: g8, G10: g10, G11: g11, G14: g14, U7: u7, U14: u14 };

/* Gates that ask a running server something. The rest read the repository,
 * which is what makes them usable as a pre-deploy check: there is nothing to
 * start, nothing to wait for, and no way for a flaky dev server to turn a
 * real failure into a green build or the reverse.
 *
 * G1 belongs to neither list and runs in both -- it shells out to typecheck,
 * the unit suite and the patcher, none of which need HTTP. */
const NEEDS_SERVER = new Set(['G2', 'G3', 'G8', 'G11', 'G14']);

console.log(`\nYomu engineering gauntlet — ${offline ? 'offline (files only)' : BASE}\n`);
for (const [name, fn] of Object.entries(gates)) {
  if (only.length && !only.includes(name)) continue;
  if (offline && NEEDS_SERVER.has(name)) {
    results.push(`SKIP  ${name}  needs a running server`);
    continue;
  }
  try {
    await fn();
  } catch (error) {
    check(name, 'gate ran to completion', false, error.message);
  }
}
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed${warned ? `, ${warned} warned` : ''}\n`);
process.exit(failed ? 1 : 0);
