const base = (process.env.YOMU_URL || 'https://yomu.yomuread.workers.dev').replace(/\/+$/, '');

// Ten real source websites spanning maintained recipes, common WordPress/Madara
// layouts and generic adaptive HTML. ToonGod intentionally replaces one of the
// previous easy passes so the 8/10 bar now measures the new adaptation tier too.
// None of these are required to be native adapters: PASS means the normal Add
// Source resolver proves catalog → chapters → reader pages and Source Forge is
// willing to queue the public website identity for the Git-backed source pack.
const sites = [
  'https://www.mangaread.org/',
  'https://mangapark1.com/',
  'https://www.toongod.org/',
  'https://www.zinmanga.net/',
  'https://mangapill.com/',
  'https://www.mangabats.com/',
  'https://manhuaplus.top/',
  'https://mangadistrict.com/',
  'https://manhuabuddy.com/',
  'https://www.manganelo.cc/',
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
      framework: result?.plan?.framework || result?.websiteAdaptive?.framework || null,
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

console.log('\nSOURCE FORGE WEBSITE-ADAPTATION GAUNTLET');
console.log(JSON.stringify({ passed, failed, total: rows.length, verdict, rows }, null, 2));

if (passed < 8) {
  console.error(`Acceptance failed: ${passed}/10. ${verdict}.`);
  process.exit(1);
}
console.log(`Acceptance passed: ${passed}/10.`);
