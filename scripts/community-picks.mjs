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
 *   reddit        Mentions counted across recommendation threads and their
 *                 comments in the manga/manhwa/manhua subreddits.
 *
 * Every source may fail independently. A source that does not answer is
 * recorded as unavailable with the reason, and the file still ships: a missing
 * community is a smaller answer, never a broken one, and never a silent one.
 *
 * ## Reddit needs credentials, by design
 *
 * Anonymous JSON endpoints answer 403 now, and scraping around that would be
 * both unreliable and rude. The collector uses Reddit's documented OAuth
 * application flow instead, which is rate-limit friendly and identifies
 * itself. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET (a free "script" app
 * at reddit.com/prefs/apps) and it turns on; without them it reports itself
 * unavailable and the other three still run.
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

/* Subreddits whose whole subject is recommending these books to each other. */
const SUBS = ['manga', 'manhwa', 'manhua', 'MangaCollectors', 'OtomeIsekai', 'Isekai', 'Webtoons', 'noveltranslations'];
const REDDIT_QUERIES = ['recommendation', 'recommend me', 'what should i read', 'best manhwa', 'best manga', 'hidden gem'];

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
    const body = await json(url.toString(), {}, 25000);
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

/* --- Reddit -------------------------------------------------------------- */

async function redditToken() {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) throw new Error('no REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET set');
  const body = await json('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!body?.access_token) throw new Error('no access_token in the OAuth answer');
  return body.access_token;
}

/**
 * Count how often a known title is named in recommendation threads.
 *
 * Only titles the other collectors already found are counted. That is what
 * keeps this honest: no free-text guessing at what is or is not a title, no
 * inventing a work that does not exist, and a mention only counts when a
 * ranked catalogue agrees the name is real.
 */
async function collectReddit(report) {
  const token = await redditToken();
  const api = async (pathname, params) => {
    const url = new URL('https://oauth.reddit.com' + pathname);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
    return json(url.toString(), { headers: { authorization: `Bearer ${token}` } });
  };

  /* The haystack: every title any other community already named, longest
     first, so "Solo Leveling: Ragnarok" is counted before "Solo Leveling". */
  const known = [...works.values()]
    .map((row) => ({ key: row.key, title: row.title, needle: normalize(row.title) }))
    .filter((row) => row.needle.length >= 5)
    .sort((a, b) => b.needle.length - a.needle.length);
  if (!known.length) throw new Error('nothing to count mentions against');

  const mentions = new Map();
  const threads = [];
  let scanned = 0;

  for (const sub of SUBS) {
    for (const query of REDDIT_QUERIES) {
      let listing;
      try {
        listing = await api(`/r/${sub}/search`, { q: query, restrict_sr: 1, sort: 'top', t: 'year', limit: 12, raw_json: 1 });
      } catch { continue; }
      for (const child of listing?.data?.children || []) {
        const post = child?.data;
        if (!post?.id || post.over_18) continue;
        threads.push({ sub, id: post.id, title: post.title, permalink: post.permalink, comments: post.num_comments || 0 });
      }
      await sleep(1100);
    }
  }

  /* The busiest threads only: a recommendation thread with four replies is
     one person's opinion, and the point of this is the aggregate. */
  threads.sort((a, b) => b.comments - a.comments);
  for (const thread of threads.slice(0, 40)) {
    let body;
    try { body = await api(`/comments/${thread.id}`, { limit: 200, depth: 2, sort: 'top', raw_json: 1 }); }
    catch { continue; }
    scanned += 1;

    const texts = [thread.title];
    const walk = (node) => {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.kind === 'Listing') { walk(node.data?.children); return; }
      if (node.data?.body) texts.push(node.data.body);
      if (node.data?.replies) walk(node.data.replies);
    };
    walk(body);

    const haystack = normalize(texts.join(' \n '));
    const counted = new Set();
    for (const row of known) {
      if (counted.has(row.key) || !haystack.includes(row.needle)) continue;
      counted.add(row.key);
      const hit = mentions.get(row.key) || { title: row.title, count: 0, links: [] };
      hit.count += 1;
      if (hit.links.length < 3 && thread.permalink) hit.links.push('https://www.reddit.com' + thread.permalink);
      mentions.set(row.key, hit);
    }
    await sleep(1100);
  }

  const ranked = [...mentions.values()].sort((a, b) => b.count - a.count);
  ranked.forEach((hit, index) => {
    if (hit.count < 2) return;
    record(hit.title, {
      source: 'reddit',
      rank: index,
      of: Math.max(ranked.length, 1),
      mentions: hit.count,
      link: hit.links[0] || '',
      note: `Named in ${hit.count} recommendation thread${hit.count === 1 ? '' : 's'}`,
    });
  });

  report('reddit', {
    ok: true,
    rows: ranked.filter((h) => h.count >= 2).length,
    threads: scanned,
    subs: SUBS,
    label: 'Reddit',
    about: 'Mentions counted across recommendation threads',
  });
}

/* --- run ----------------------------------------------------------------- */

const sources = {};
const report = (id, row) => { sources[id] = row; };

const COLLECTORS = [
  ['anilist', collectAniList, 'AniList', 'Community score and readership'],
  ['mangaupdates', collectMangaUpdates, 'MangaUpdates', 'Reader ratings, weighted by vote count'],
  ['myanimelist', collectMyAnimeList, 'MyAnimeList', 'MAL rankings and favourites, via Jikan'],
  /* Last, because it counts mentions of what the others found. */
  ['reddit', collectReddit, 'Reddit', 'Mentions counted across recommendation threads'],
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
