#!/usr/bin/env node
/**
 * What the reading communities actually recommend.
 *
 * Mori's recommendations came from three places, all of which describe *this*
 * reader: their own history, AniList's charts, and their enabled sources. None
 * of them answers "what do people who read a lot of this say is good", which
 * is the question a reader is usually asking.
 *
 * This collects that, once, on a schedule, in CI -- not in the browser and not
 * in the Worker:
 *
 *   - **A browser cannot.** reddit.com and api.mangaupdates.com send no
 *     `access-control-allow-origin`, so the page is not allowed to read them.
 *   - **The Worker should not.** AniList already returns 403 to Cloudflare
 *     egress, Reddit rate-limits per client, and doing it per request would
 *     mean every reader paying for the same answer.
 *
 * So a GitHub Action runs this, and it commits one small JSON file the app
 * serves as a static asset. Every reader gets the same warm answer for free,
 * and the aggregation is reviewable in git rather than happening invisibly.
 *
 * ## The sources
 *
 * Each is a separate reader community with its own bias, which is the point --
 * a title three of them agree on is a stronger signal than a title one of them
 * ranks first.
 *
 *   anilist       Community score and popularity. Votes from AniList readers.
 *   mangaupdates  Bayesian rating and vote count. The long-running scanlation
 *                 reader community; strongest on manhwa/manhua.
 *   myanimelist   MAL's own rankings, read through Jikan (open source, no key).
 *
 * Reddit is deliberately not here. Its anonymous JSON endpoints answer 403
 * since 2023 and its RSS feeds rate-limit to roughly nothing, so the only
 * reliable route is an OAuth application -- credentials this repository does
 * not have and should not require to build. Three communities that work beat
 * a fourth that reports itself broken every day.
 *
 * Every source may fail independently. A source that does not answer is
 * recorded as unavailable with the reason, and the file still ships: a missing
 * community is a smaller answer, never a broken one, and never a silent one.
 *
 * Nothing here copies anyone's writing. What is stored is a count of how often
 * a title was named, and a link back to the thread that named it.
 *
 *   node scripts/community-picks.mjs [--out dist-app/community-picks.json]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-app', 'community-picks.json');
const UA = 'yomu-community-picks/1.0 (+https://github.com/kumikilongyeyo/Yomu)';
const MAX_PICKS = 120;



const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url, init = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: 'application/json', ...(init.headers || {}) },
    });
    const type = response.headers.get('content-type') || '';
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!/json/i.test(type)) throw new Error(`answered ${type || 'no content-type'} instead of JSON`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** One key per work, so four communities spelling it differently still agree. */
function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|of|and|manga|manhwa|manhua|webtoon|comic|official|colou?red?|color|season|part|vol(?:ume)?|novel|remake)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* --- the ledger ---------------------------------------------------------- */

const works = new Map();

/**
 * @param {string} title
 * @param {{source: string, rank?: number, of?: number, weight?: number, note?: string,
 *          cover?: string, anilistId?: number, malId?: number, category?: string,
 *          year?: number, score?: number, mentions?: number, link?: string}} hit
 */
function record(title, hit) {
  const key = normalize(title);
  if (!key || key.length < 2) return;
  let row = works.get(key);
  if (!row) {
    row = { key, title: String(title).trim(), signals: {}, cover: '', category: '', year: null, anilistId: null, malId: null, score: null };
    works.set(key, row);
  }
  /* First non-empty value wins for the display fields: AniList runs first and
     has the best covers, and a later source must not overwrite a good cover
     with nothing. */
  row.cover ||= hit.cover || '';
  row.category ||= hit.category || '';
  row.year ??= hit.year ?? null;
  row.anilistId ??= hit.anilistId ?? null;
  row.malId ??= hit.malId ?? null;
  if (row.score == null && Number.isFinite(hit.score)) row.score = hit.score;

  /* A source counts once per work. Its strength is its rank within that
     source's own list, so a top-10 finish anywhere beats a long tail. */
  const strength = hit.weight ?? (hit.rank != null && hit.of ? 1 - (hit.rank / Math.max(hit.of, 1)) * 0.75 : 0.5);
  const existing = row.signals[hit.source];
  if (existing && existing.strength >= strength) {
    if (hit.mentions) existing.mentions = (existing.mentions || 0) + hit.mentions;
    return;
  }
  row.signals[hit.source] = {
    strength: Number(strength.toFixed(4)),
    ...(hit.rank != null ? { rank: hit.rank } : {}),
    ...(hit.note ? { note: hit.note } : {}),
    ...(hit.mentions ? { mentions: (existing?.mentions || 0) + hit.mentions } : existing?.mentions ? { mentions: existing.mentions } : {}),
    ...(hit.link ? { link: hit.link } : {}),
  };
}

/* --- AniList ------------------------------------------------------------- */

const ANILIST_QUERY = `
query ($sort: [MediaSort], $country: CountryCode, $page: Int) {
  Page(page: $page, perPage: 50) {
    media(type: MANGA, sort: $sort, isAdult: false, countryOfOrigin: $country) {
      id
      idMal
      title { english romaji native }
      coverImage { large }
      averageScore
      popularity
      countryOfOrigin
      startDate { year }
    }
  }
}`;

const COUNTRY_CATEGORY = { JP: 'manga', KR: 'manhwa', CN: 'manhua' };

async function collectAniList(report) {
  let added = 0;
  for (const country of ['JP', 'KR', 'CN']) {
    for (const sort of [['SCORE_DESC'], ['POPULARITY_DESC']]) {
      const body = await json('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: ANILIST_QUERY, variables: { sort, country, page: 1 } }),
      });
      const rows = body?.data?.Page?.media || [];
      rows.forEach((media, index) => {
        const title = media?.title?.english || media?.title?.romaji || media?.title?.native;
        if (!title) return;
        record(title, {
          source: 'anilist',
          rank: index,
          of: rows.length,
          cover: media.coverImage?.large || '',
          anilistId: media.id ?? null,
          malId: media.idMal ?? null,
          category: COUNTRY_CATEGORY[media.countryOfOrigin] || '',
          year: media.startDate?.year ?? null,
          score: media.averageScore ?? null,
          note: sort[0] === 'SCORE_DESC' ? 'Rated highly by AniList readers' : 'Widely read on AniList',
        });
        added += 1;
      });
      /* AniList allows 30 requests a minute and says so in a header. Six
         requests with a breath between them is not worth being clever about. */
      await sleep(1200);
    }
  }
  report('anilist', { ok: true, rows: added, label: 'AniList', about: 'Community score and readership' });
}

/* --- MangaUpdates -------------------------------------------------------- */

/**
 * MangaUpdates ranks by a Bayesian rating over reader votes, which is the
 * oldest continuous community signal for this medium and the strongest one for
 * translated manhwa. Its search needs a term, so the catalogue is walked by
 * type rather than asked for a global top list.
 */
async function collectMangaUpdates(report) {
  let added = 0;
  for (const type of ['Manga', 'Manhwa', 'Manhua']) {
    for (let page = 1; page <= 2; page += 1) {
      const body = await json('https://api.mangaupdates.com/v1/series/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ search: 'a', orderby: 'rating', type: [type], perpage: 50, page }),
      });
      const rows = (body?.results || []).map((r) => r.record).filter(Boolean);
      rows.forEach((row, index) => {
        const votes = Number(row.rating_votes || 0);
        /* A 10/10 from nine people is not a community recommendation. */
        if (votes < 250 || !row.title) return;
        record(row.title, {
          source: 'mangaupdates',
          rank: (page - 1) * 50 + index,
          of: 100,
          category: String(row.type || '').toLowerCase(),
          year: Number(row.year) || null,
          link: row.url || '',
          note: `${row.bayesian_rating}/10 from ${votes.toLocaleString()} MangaUpdates readers`,
        });
        added += 1;
      });
      await sleep(900);
    }
  }
  report('mangaupdates', { ok: true, rows: added, label: 'MangaUpdates', about: 'Reader ratings, weighted by vote count' });
}

/* --- MyAnimeList, through Jikan ------------------------------------------ */

async function collectMyAnimeList(report) {
  let added = 0;
  for (const filter of ['bypopularity', 'favorite', '']) {
    const url = new URL('https://api.jikan.moe/v4/top/manga');
    url.searchParams.set('limit', '25');
    if (filter) url.searchParams.set('filter', filter);
    /* Jikan proxies MyAnimeList, so a 504 here is usually MAL having a moment
       rather than Jikan being down. One patient retry is the difference between
       a community that answers most days and one that answers some days. */
    let body = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { body = await json(url.toString(), {}, 25000); break; }
      catch (error) {
        if (attempt === 2) throw error;
        await sleep(4000 * (attempt + 1));
      }
    }
    const rows = body?.data || [];
    rows.forEach((row, index) => {
      if (!row?.title) return;
      record(row.title_english || row.title, {
        source: 'myanimelist',
        rank: index,
        of: rows.length,
        malId: row.mal_id ?? null,
        year: row.published?.prop?.from?.year ?? null,
        link: row.url || '',
        note: filter === 'favorite' ? 'A MyAnimeList favourite' : 'High on MyAnimeList',
      });
      added += 1;
    });
    /* Jikan asks for 3 requests a second and 60 a minute. */
    await sleep(1400);
  }
  report('myanimelist', { ok: true, rows: added, label: 'MyAnimeList', about: 'MAL rankings and favourites, via Jikan' });
}

/* --- run ----------------------------------------------------------------- */

const sources = {};
const report = (id, row) => { sources[id] = row; };

const COLLECTORS = [
  ['anilist', collectAniList, 'AniList', 'Community score and readership'],
  ['mangaupdates', collectMangaUpdates, 'MangaUpdates', 'Reader ratings, weighted by vote count'],
  ['myanimelist', collectMyAnimeList, 'MyAnimeList', 'MAL rankings and favourites, via Jikan'],
];

for (const [id, run, label, about] of COLLECTORS) {
  try {
    await run(report);
    console.log(`  ${id}: ${sources[id]?.rows ?? 0} rows`);
  } catch (error) {
    sources[id] = { ok: false, rows: 0, label, about, error: String(error?.message || error) };
    console.warn(`  ${id}: unavailable — ${sources[id].error}`);
  }
}

/**
 * Agreement first, then strength.
 *
 * Two communities naming the same work is worth more than one community
 * ranking it first, because the failure mode of a single ranking is that it
 * measures that site's own audience. `total` is what the app sorts by;
 * `signals` is what it shows, so a pick can always explain itself.
 */
const picks = [...works.values()]
  .map((row) => {
    const ids = Object.keys(row.signals);
    const strength = ids.reduce((sum, id) => sum + row.signals[id].strength, 0);
    return { ...row, agree: ids.length, total: Number((strength * (1 + (ids.length - 1) * 0.6)).toFixed(4)) };
  })
  .filter((row) => row.agree > 0)
  .sort((a, b) => b.agree - a.agree || b.total - a.total)
  .slice(0, MAX_PICKS)
  .map(({ key, ...row }) => row);

const payload = {
  schema: 'yomu.community-picks/1',
  generatedAt: new Date().toISOString(),
  sources: Object.fromEntries(
    COLLECTORS.map(([id, , label, about]) => [id, sources[id] || { ok: false, rows: 0, label, about, error: 'did not run' }]),
  ),
  counts: { works: works.size, picks: picks.length },
  picks,
};

const outPath = (() => {
  const flag = process.argv.indexOf('--out');
  return flag > -1 && process.argv[flag + 1] ? path.resolve(process.argv[flag + 1]) : OUT;
})();

if (!picks.length) {
  console.error('No community source answered. Leaving the existing file alone.');
  process.exit(1);
}

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(payload, null, 1) + '\n', 'utf8');
console.log(`\n${picks.length} picks from ${Object.values(sources).filter((s) => s.ok).length} of ${COLLECTORS.length} communities -> ${path.relative(ROOT, outPath)}`);
