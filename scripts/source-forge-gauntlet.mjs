const base = (process.env.YOMU_URL || 'https://yomu.yomuread.workers.dev').replace(/\/+$/, '');

// Conversion acceptance is measured only against publicly readable sites. A
// CAPTCHA / Cloudflare interactive challenge is not a parser failure: Yomu is
// deliberately forbidden from bypassing it. Those sites have a separate safety
// assertion below and must never be promoted while unreadable.
const sites = [
  'https://www.zinmanga.net/',
  'https://mangapill.com/',
  'https://www.mangabats.com/',
  'https://manhuaplus.top/',
  'https://mangadistrict.com/',
  'https://manhuabuddy.com/',
  'https://www.manganelo.cc/',
  'https://qtoon.org/',
  'https://kingofshojo.com/',
  'https://www.zazamanga.com/',
];

// These are structurally recognised upstream, but can fluctuate between a
// challenge page, a partial recipe response, and a remote runtime timeout.
// Safety is the hard requirement: they must stay unready and unqueued. Accurate
// browser-required classification is still measured, but is diagnostic rather
// than allowed to invalidate a successful conversion gauntlet.
const protectedSites = [
  'https://www.toongod.org/',
  'https://www.mangaread.org/',
  'https://mangaowl.io/',
];

async function resolve(url) {
  const response = await fetch(`${base}/api/fabric/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(65_000),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { body = { ready: false, error: `non-JSON HTTP ${response.status}` }; }
  return { status: response.status, ...body };
}

const rows = [];
for (const site of sites) {
  const started = Date.now();
  try {
    const result = await resolve(site);
    const queued = result?.forge?.queued === true;
    const pass = result.ready === true && queued;
    const row = {
      site,
      pass,
      ready: result.ready === true,
      queued,
      route: result.route || null,
      score: Number(result.score || 0),
      strategy: result?.probe?.strategy || result?.adapter?.strategy || null,
      framework: result?.plan?.framework || result?.remoteRecipe?.family || result?.websiteAdaptive?.framework || null,
      reason: result?.forge?.reason || result.failureKind || result.error || result?.websiteAdaptive?.message || null,
      ms: Date.now() - started,
    };
    rows.push(row);
    console.log(`${pass ? 'PASS' : 'FAIL'} ${site} route=${row.route || '-'} score=${row.score} framework=${row.framework || '-'} queued=${queued} ${row.reason || ''}`);
  } catch (error) {
    const row = { site, pass: false, ready: false, queued: false, route: null, score: 0, framework: null, reason: error?.message || String(error), ms: Date.now() - started };
    rows.push(row);
    console.log(`FAIL ${site} ${row.reason}`);
  }
}

const passed = rows.filter((row) => row.pass).length;
const failed = rows.length - passed;
const verdict = passed >= 8
  ? 'PASS'
  : passed >= 5
    ? 'REWORK'
    : passed <= 2
      ? 'REALIGN'
      : 'REWORK-SEVERE';

console.log('\nSOURCE FORGE CONVERSION GAUNTLET');
console.log(JSON.stringify({ passed, failed, total: rows.length, verdict, rows }, null, 2));

const protectedRows = [];
for (const site of protectedSites) {
  const started = Date.now();
  try {
    const result = await resolve(site);
    const queued = result?.forge?.queued === true;
    const browserRequired = result?.browserRequired === true
      || result?.failureKind === 'browser-required'
      || /browser-required/i.test(String(result?.route || ''))
      || /interactive access challenge/i.test(String(result?.message || ''));
    const pass = result.ready !== true && !queued;
    const row = {
      site,
      pass,
      classified: browserRequired,
      route: result.route || null,
      browserRequired,
      queued,
      message: result.message || null,
      family: result?.remoteRecipe?.family || null,
      ms: Date.now() - started,
    };
    protectedRows.push(row);
    console.log(`${pass ? 'SAFE' : 'UNSAFE'} ${site} route=${row.route || '-'} family=${row.family || '-'} queued=${queued} classification=${browserRequired ? 'protected' : 'unknown'}`);
  } catch (error) {
    protectedRows.push({ site, pass: true, classified: false, route: null, browserRequired: false, queued: false, message: error?.message || String(error), family: null, ms: Date.now() - started });
    console.log(`SAFE-BUT-UNCLASSIFIED ${site} ${error?.message || error}`);
  }
}

const protectedPassed = protectedRows.filter((row) => row.pass).length;
const protectedClassified = protectedRows.filter((row) => row.classified).length;
console.log('\nACCESS-CONTROL SAFETY');
console.log(JSON.stringify({ safe: protectedPassed, classified: protectedClassified, total: protectedRows.length, rows: protectedRows }, null, 2));

if (passed < 8) {
  console.error(`Conversion acceptance failed: ${passed}/10. ${verdict}.`);
  process.exit(1);
}
if (protectedPassed !== protectedRows.length) {
  console.error(`Protected-source safety failed: ${protectedPassed}/${protectedRows.length} stayed unready and unqueued.`);
  process.exit(1);
}
if (protectedClassified !== protectedRows.length) {
  console.warn(`Protected-source classification is ${protectedClassified}/${protectedRows.length}; safety still passed because none were promoted.`);
}
console.log(`Acceptance passed: ${passed}/10 convertible sites; ${protectedPassed}/${protectedRows.length} protected sites stayed safely unqueued; ${protectedClassified}/${protectedRows.length} were explicitly classified.`);
