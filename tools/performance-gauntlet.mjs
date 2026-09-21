#!/usr/bin/env node
/** Strict Yomu performance/loading release gate. Exactly 10/10 or block. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE = (process.argv.slice(2).find((x) => /^https?:\/\//.test(x)) || '').replace(/\/+$/, '');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const perf = read('dist-app/yomu-performance.js');
const loading = read('dist-app/yomu-loading-policy.js');
const more = read('dist-app/yomu-explore-more.js');
const optimizer = read('scripts/optimize-export.py');
const search = read('dist-app/yomu-search-v3.js');
const results = [];
const gate = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

async function live(pathname) {
  if (!BASE) return null;
  try {
    const response = await fetch(BASE + pathname, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, text: '', error: String(error?.message || error) };
  }
}

const budgetMatch = perf.match(/SOURCE_BUDGET_MS\s*=\s*(\d+)/);
const budget = Number(budgetMatch?.[1] || Infinity);
const warmMatch = perf.match(/WARM_CONCURRENCY\s*=\s*(\d+)/);
const warmConcurrency = Number(warmMatch?.[1] || Infinity);

// P1 — the fast lane has to be release-wired, and on search it must execute
// before V3 captures window.fetch. Otherwise the file exists but does nothing.
const perfIndex = optimizer.indexOf('<script src="/yomu-performance.js"></script>');
const searchIndex = optimizer.indexOf('<script src="/yomu-search-v3.js"></script>');
gate('P1 performance fast lane is wired before Search V3',
  perfIndex >= 0 && searchIndex > perfIndex && /yomu-performance\.js/.test(optimizer));

// P2 — old library source waits were 14 seconds. The app-controlled wait budget
// must be <=4.5s, more than a 3x worst-case reduction and comfortably beyond the
// user's 2x target without pretending remote server latency is controllable.
gate('P2 slow-source wait budget is at least 2x tighter',
  Number.isFinite(budget) && budget > 0 && budget <= 4500,
  `budget=${budget}ms`);

// P3 — duplicate requests must collapse onto one promise.
gate('P3 identical in-flight title requests are deduplicated',
  /const inflight = new Map/.test(perf)
  && /inflight\.has\(key\)/.test(perf)
  && /inflight\.set\(key, task\)/.test(perf)
  && /inflight\.delete\(key\)/.test(perf));

// P4 — warm title JSON must paint from session cache instead of waiting again.
gate('P4 warm title data returns immediately from cache',
  /sessionStorage\.getItem\(STORE_KEY\)/.test(perf)
  && /cachedResponse\(row, 'fresh'\)/.test(perf)
  && /Promise\.resolve\(cachedResponse/.test(perf)
  && /FRESH_MS/.test(perf));

// P5 — cached data cannot become frozen forever; revalidation must happen in
// the background and stale-while-revalidate must be bounded.
gate('P5 cache is stale-while-revalidate, not stale-forever',
  /cachedResponse\(row, 'stale'\)/.test(perf)
  && /network\(key, input, init, true\)/.test(perf)
  && /STALE_MS/.test(perf)
  && /MAX_ROWS/.test(perf));

// P6 — aggressive warmup must back off for Save-Data / 2G users.
gate('P6 speculative work respects constrained connections',
  /connection\?\.saveData/.test(perf)
  && /effectiveType/.test(perf)
  && /2g/.test(perf));

// P7 — warming sources is bounded like p-limit, not Promise.all over 43 hosts.
gate('P7 source warmup concurrency is bounded',
  Number.isFinite(warmConcurrency) && warmConcurrency >= 2 && warmConcurrency <= 8
  && /async function pool/.test(perf)
  && /Math\.min\(limit, items\.length\)/.test(perf),
  `concurrency=${warmConcurrency}`);

// P8 — destination prefetch follows quicklink's near-viewport idea and never
// sprays cross-origin reader URLs.
gate('P8 likely title destinations prefetch near viewport only',
  /IntersectionObserver/.test(perf)
  && /rootMargin: '500px 0px'/.test(perf)
  && /u\.origin !== location\.origin/.test(perf)
  && /link\.rel = 'prefetch'/.test(perf));

// P9 — the regression from the screenshot: ordinary network activity may not
// create a persistent bottom-right loader. Only blank content + .on can reveal
// it, and reader/cards/skeletons count as usable content.
gate('P9 global loader is blank-page-only and background-silent',
  /#yomu-load\{display:none!important;opacity:0!important/.test(loading)
  && /data-yomu-blank-loading='1'\] #yomu-load\.on/.test(loading)
  && /requested && !hasUsableContent\(\)/.test(loading)
  && /\.reader img/.test(loading)
  // `.yl-card` used to be listed here as a title card and is in fact the
  // loader's own card, so the loader counted itself as content. The canonical
  // title card and its skeleton are what "usable" means now.
  && /\.yt-card:not\(\.yt-card--skeleton\)/.test(loading)
  && /\.yt-card--skeleton/.test(loading)
  && /\.yv3-wait/.test(loading));

// P10 — exploration itself must stay progressive: rails and search both expose
// More, search walks page 2+, source fan-out is bounded, and NamiComi is blocked.
const livePerf = await live('/yomu-performance.js');
const liveLoading = await live('/yomu-loading-policy.js');
const liveMore = await live('/yomu-explore-more.js');
const liveFind = await live('/find?q=nano%20machine');
gate('P10 segmented More controls and live production wiring',
  /More results/.test(more)
  /* A rail's control opens the shelf's own screen. It used to append AniList
     page 2 to the right-hand end of a horizontal strip, where the new cards
     landed outside the viewport and the reader saw nothing happen. Append is
     still the rule for grids -- the full library, search, and the shelf screen
     itself -- because there the growth is in front of them. */
  && /kind=rail&id=/.test(more)
  && /yt-more--link/.test(more)
  && /kind === 'rail'/.test(read('dist-app/more.html'))
  && /YomuPager\?\.claim\(foot/.test(read('dist-app/more.html'))
  && /searchPages/.test(more)
  && /\|\| 2/.test(more)
  && /SEARCH_CONCURRENCY\s*=\s*8/.test(more)
  && /namicomi/i.test(more)
  /* The duplicate control may still be *named* -- the rail head sweeps it away
     before placing its own, so a stale one from a cached bundle cannot
     survive. What must not exist is anywhere that builds one. */
  && !/el\(\s*'button'\s*,\s*'yomu-generic-more'/.test(more)
  && /querySelectorAll\('\[data-yomu-pager\], \.yomu-generic-more, \.yomu-rail-more'\)/.test(more)
  && /yomu-explore-more\.js/.test(optimizer)
  && /yomu-pager\.js/.test(optimizer)
  && /yomu-titlecard\.js/.test(optimizer)
  && (!BASE || (
    livePerf?.ok && liveLoading?.ok && liveMore?.ok && liveFind?.ok
    && /SOURCE_BUDGET_MS/.test(livePerf.text)
    && /data-yomu-blank-loading/.test(liveLoading.text)
    && /More results/.test(liveMore.text)
    && /yomu-explore-more\.js/.test(liveFind.text)
  )),
  BASE ? `perf=${livePerf?.status}; loading=${liveLoading?.status}; more=${liveMore?.status}; find=${liveFind?.status}` : 'offline');

const passed = results.filter((r) => r.ok).length;
for (const [i, row] of results.entries()) {
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${String(i + 1).padStart(2, '0')}/10  ${row.name}${row.ok || !row.detail ? '' : `\n             ${row.detail}`}`);
}
console.log(`\nPerformance Gauntlet: ${passed}/10 ${passed === 10 ? 'PASS' : 'FAIL — RELEASE BLOCKED'}`);
if (passed !== 10) process.exit(1);
