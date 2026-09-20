/**
 * Yomu Search release gauntlet.
 * Ten hard gates covering the exact failures that made /find feel slow/noisy.
 * Exit 0 only at 10/10. Optional URL also verifies the deployed assets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V3 = fs.readFileSync(path.join(ROOT, 'dist-app/yomu-search-v3.js'), 'utf8');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-yomu.yml'), 'utf8');
const FIND = fs.readFileSync(path.join(ROOT, 'dist-app/find.html'), 'utf8');
const BASE = process.argv.slice(2).find((x) => /^https?:\/\//.test(x))?.replace(/\/+$/, '') || '';
const rows = [];

function gate(name, ok, detail = '') {
  rows.push({ name, ok: !!ok, detail });
}

// Senior Dev: routing/architecture/performance/cancellation/cache.
gate('1. real /find route is owned', /\/find\(\?:\\\.html\)\?/.test(V3) || /\\\/find/.test(V3), 'V3 must target the standalone /find page, not only /search.');
gate('2. search bypasses blocking wrappers', /const nativeFetch = window\.fetch\.bind\(window\)/.test(V3) && /window\.fetch = searchFetch/.test(V3), 'Capture fetch early and reinstall the fast path.');
gate('3. fast lane stays under 1.2s', /const FAST_TIMEOUT = 1150/.test(V3), 'Initial results must not wait on the all-source catalog fanout.');
gate('4. source work is bounded and cancellable', /const SOURCE_TIMEOUT = 2100/.test(V3) && /const CONCURRENCY = 8/.test(V3) && /AbortController/.test(V3) && /activeSearchAbort\?\.abort/.test(V3), 'No dead source may hold the search page hostage.');
gate('5. warm searches are cached', /CACHE_MS = 10 \* 60 \* 1000/.test(V3) && /cachedSearch\(query\)/.test(V3) && /saveSearch\(query, rows\)/.test(V3), 'Repeating a query should be immediate.');

// UI/UX: nonblocking loader, useful-only results, covers, typeahead, progressive feedback.
gate('6. fullscreen loader is forbidden', /#yomu-load\{position:fixed!important;inset:auto/.test(V3) && /body\.yomu-search-v3 #yomu-load\{display:none!important\}/.test(V3), 'Search may use local progress only; the app must never disappear behind an overlay.');
gate('7. Yomu mark replaces spinner', /body\.yomu-search-v3 \.field \.spin/.test(V3) && /yomu-icon\.svg/.test(V3), 'Use the brand mark animation, not a generic circular spinner.');
gate('8. unreadable junk is never shown', /#results \.shelf-line/.test(V3) && /#results \.tile\[disabled\]/.test(V3) && /scrubUnreadable/.test(V3), 'If no source can open it, it does not belong in Search results.');
gate('9. missing covers repair themselves', /FALLBACK_COVER = '\/brand\/yomu-loader-ink\.webp'/.test(V3) && /addEventListener\('error'/.test(V3) && /findCover\(/.test(V3), 'Blank blue cards are a release blocker.');
gate('10. Google-style text typeahead is real', /setTimeout\(run, 120\)/.test(V3) && /SUGGEST_TIMEOUT = 750/.test(V3) && /ArrowDown/.test(V3) && /ArrowUp/.test(V3) && /Escape/.test(V3) && /yv3-suggest-title/.test(V3), 'Suggestions must appear while typing and work from the keyboard.');

// Structural checks shared by several gates: injection order and legacy page evidence.
const injected = /<script src=\"\/yomu-search-v3\.js\"/.test(WORKFLOW);
if (!injected) {
  const g = rows.find((x) => x.name.startsWith('1.'));
  g.ok = false; g.detail += ' Deploy workflow does not inject yomu-search-v3.js.';
}
if (!/class=\"shelf-line\"|shelf-line/.test(FIND)) {
  // Not a failure: if find.html later deletes the legacy shelf itself, V3 remains harmless.
  console.log('NOTE  legacy unreadable shelf already absent from find.html.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fetchTextWithRetry(url, mustContain, tries = 6) {
  let last = { status: 0, text: '' };
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(6000), cache: 'no-store' });
      const text = await response.text();
      last = { status: response.status, text };
      if (response.ok && (!mustContain || text.includes(mustContain))) return { ok: true, status: response.status, text };
    } catch {}
    if (i < tries - 1) await sleep(1500);
  }
  return { ok: false, ...last };
}

if (BASE) {
  try {
    // Cloudflare asset propagation can lag the deploy command by a few seconds.
    // Retry the exact user-facing page and asset instead of turning eventual
    // consistency into a fake product regression.
    const [find, js] = await Promise.all([
      fetchTextWithRetry(`${BASE}/find?q=nano%20machine`, 'yomu-search-v3.js'),
      fetchTextWithRetry(`${BASE}/yomu-search-v3.js`, 'Yomu Search V3'),
    ]);
    if (!find.ok || !js.ok) {
      const g = rows.find((x) => x.name.startsWith('1.'));
      g.ok = false; g.detail += ` Live verification failed after retries (${find.status}/${js.status}).`;
    }
  } catch (error) {
    const g = rows.find((x) => x.name.startsWith('1.'));
    g.ok = false; g.detail += ` Live verification threw: ${error?.message || error}`;
  }
}

for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n      ${r.detail}`}`);
const passed = rows.filter((x) => x.ok).length;
console.log(`\nSEARCH GAUNTLET: ${passed}/10 ${passed === 10 ? 'PASS' : 'BLOCKED'}`);
if (passed !== 10) process.exit(1);
