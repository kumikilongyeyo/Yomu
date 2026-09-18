/**
 * Yomu's discovery engine.
 *
 * Two halves that answer different questions and must not be confused:
 *
 *   GLOBAL   What is worth reading right now, for anyone. Trending, popular,
 *            highest rated, hidden gems, split by Manga / Manhwa / Manhua.
 *   PERSONAL What is worth reading for *you*. Built from what this device has
 *            actually read, and never leaves it.
 *
 * The global half is not computed here and deliberately so. AniList already
 * maintains a live `trending` score, a `popularity` count and an
 * `averageScore` for every title, recalculated continuously by people whose
 * whole job it is. Yomu has no readership of its own to aggregate -- and even
 * if it did, aggregating it would mean uploading what everybody reads, which
 * is the one thing this app has consistently refused to do. So the rankings
 * are read, not invented, and the engine's work is choosing, mixing and
 * explaining them.
 *
 * `countryOfOrigin` is what makes the three-way split honest. Source metadata
 * cannot do it: Weeb Central sets no category at all and Webtoons.com says
 * "webtoon", which is why yomu-shell.js gave up on filtering by kind. KR, JP
 * and CN are stated facts about a work.
 *
 * The personal half is on-device by design. Every signal it uses is already
 * in localStorage because the reader read something; nothing new is
 * collected, nothing is uploaded, and a reader who clears their browser gets
 * a cold start rather than a profile they cannot see or delete.
 *
 * Everything is cached with a TTL and everything degrades. A rail that cannot
 * load is a rail that does not render, never a page that does not load.
 */
(() => {
  'use strict';

  const ENDPOINT = 'https://graphql.anilist.co';
  const RAILS_KEY = 'yomu.v1.rails';
  const EVENTS_KEY = 'yomu.v1.events';
  const TASTE_KEY = 'yomu.v1.taste';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const RESUME_PREFIX = 'yomu.v1.resume.local-account.';
  const ADULT_KEY = 'yomu.v1.adult';

  /** Global rails go stale slowly. Trending moves in hours, not minutes. */
  const RAILS_TTL = 6 * 3600000;
  const MAX_EVENTS = 400;

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  const adult = () => localStorage.getItem(ADULT_KEY) === '1';

  /* --- types ---------------------------------------------------------------- *
   *
   * The reader-facing words, and the fact each one rests on. Not a guess from
   * a source's category field, which is empty or wrong more often than not.
   */

  const TYPES = [
    { id: 'all', label: 'All', country: null },
    { id: 'manga', label: 'Manga', country: 'JP' },
    { id: 'manhwa', label: 'Manhwa', country: 'KR' },
    { id: 'manhua', label: 'Manhua', country: 'CN' },
  ];

  const typeOf = (id) => TYPES.find((t) => t.id === id) || TYPES[0];

  /* --- the rails ------------------------------------------------------------ *
   *
   * Each rail is a different question and therefore a different sort. The
   * spec this was built from is explicit about that, and it is right: ranking
   * everything by one number is how every directory ends up showing the same
   * ten titles in six places.
   */

  const RAILS = {
    trending: {
      label: 'Trending now',
      why: 'Moving fastest this week',
      sort: 'TRENDING_DESC',
      /* Momentum, not lifetime popularity. A ten-year-old classic is not
         trending just because it is loved. */
    },
    popular: {
      label: 'Most read',
      why: 'What the most people are reading',
      sort: 'POPULARITY_DESC',
    },
    top: {
      label: 'Highest rated',
      why: 'Rated highest by readers',
      sort: 'SCORE_DESC',
      /* AniList's averageScore is already weighted by how many people rated
         it, so a single 100 from four readers does not reach the top. */
    },
    gems: {
      label: 'Hidden gems',
      why: 'Loved, and not yet everywhere',
      sort: 'SCORE_DESC',
      /* The whole point is to *not* be the mainstream list above. Well rated
         and genuinely less read, which the API can filter on directly. */
      filter: { averageScore_greater: 75, popularity_lesser: 20000 },
    },
    fresh: {
      label: 'New series',
      why: 'Started recently',
      sort: 'START_DATE_DESC',
      filter: { status: 'RELEASING' },
    },
  };

  const FIELDS = `
    id
    title { english romaji native }
    coverImage { large medium }
    genres
    averageScore
    popularity
    trending
    status
    countryOfOrigin
    startDate { year }
    tags { name rank isMediaSpoiler }`;

  /** One request for every rail on a page. Aliases make it a single round trip. */
  function railQuery(names, type, perPage) {
    const country = typeOf(type).country;
    const parts = names.map((name) => {
      const rail = RAILS[name];
      if (!rail) return '';
      const args = [
        'type: MANGA',
        `sort: ${rail.sort}`,
        'isAdult: false',
        country ? `countryOfOrigin: ${country}` : '',
        ...Object.entries(rail.filter || {}).map(([k, v]) =>
          `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`),
      ].filter(Boolean).join(', ');
      return `${name}: Page(perPage: ${perPage}) { media(${args}) { ${FIELDS} } }`;
    });
    return `query { ${parts.join('\n')} }`;
  }

  function shape(media) {
    if (!media) return null;
    const title = media.title?.english || media.title?.romaji || media.title?.native;
    if (!title) return null;
    return {
      id: media.id,
      title,
      cover: media.coverImage?.large || media.coverImage?.medium || '',
      genres: media.genres || [],
      score: media.averageScore ?? null,
      popularity: media.popularity ?? 0,
      trending: media.trending ?? 0,
      status: media.status || '',
      country: media.countryOfOrigin || '',
      year: media.startDate?.year ?? null,
      tags: (media.tags || [])
        .filter((t) => t && !t.isMediaSpoiler && typeof t.rank === 'number')
        .sort((a, b) => b.rank - a.rank)
        .slice(0, 6)
        .map((t) => ({ name: t.name, rank: t.rank })),
    };
  }

  /**
   * Fetch rails, cached per type.
   *
   * From the browser, because AniList answers a Cloudflare Worker with
   * `403 You have been manually blocked` -- it refuses datacentre egress, and
   * every Worker shares one address. From here the 30-a-minute limit is one
   * reader's own, which no one person will reach.
   */
  async function rails(names, type = 'all', perPage = 14) {
    const key = type + ':' + names.slice().sort().join(',');
    const cache = readJSON(RAILS_KEY, {}) || {};
    const hit = cache[key];
    if (hit && Date.now() - hit.at < RAILS_TTL) return hit.data;

    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: railQuery(names, type, perPage) }),
      });
      if (!response.ok) throw new Error('anilist ' + response.status);
      const body = await response.json();
      if (body.errors?.length) throw new Error(body.errors[0]?.message || 'graphql');

      const out = {};
      for (const name of names) {
        out[name] = (body.data?.[name]?.media || []).map(shape).filter(Boolean);
      }
      cache[key] = { at: Date.now(), data: out };
      writeJSON(RAILS_KEY, cache);
      return out;
    } catch (error) {
      console.warn('[rank] rails failed:', error.message);
      /* Stale is better than empty: a six-hour-old trending list is still a
         good answer, and an empty home page is not. */
      return hit?.data || null;
    }
  }

  /* --- interactions --------------------------------------------------------- *
   *
   * A small, bounded, on-device log. Not every click: only the events that
   * say something about taste, weighted by how much they say.
   *
   * Nothing here is uploaded. It exists so the taste profile can be rebuilt
   * from evidence rather than from a number that drifted, and so a later
   * version can do something smarter with the same history.
   */

  const WEIGHTS = {
    TITLE_FAVORITE: 5,
    TITLE_COMPLETE: 4,
    CHAPTER_COMPLETE: 1,
    TITLE_BOOKMARK: 3,
    TITLE_VIEW: 0.2,
    CHAPTER_OPEN: 0.3,
    SEARCH_CLICK: 0.5,
    RECOMMENDATION_CLICK: 1,
    /* Negative signals are the ones most systems skip, and they are why a
       feed stops being useful: without them one accidental tap on a genre
       becomes a permanent preference. */
    TITLE_DROP: -4,
    TITLE_BOUNCE: -0.5,
  };

  function note(type, title, extra) {
    if (!(type in WEIGHTS) || !title) return;
    const events = readJSON(EVENTS_KEY, []);
    events.push({ t: type, n: String(title).slice(0, 120), at: Date.now(), ...(extra || {}) });
    writeJSON(EVENTS_KEY, events.slice(-MAX_EVENTS));
  }

  /**
   * How much an event still counts.
   *
   * Half-life of three weeks. Recent reading should steer the feed -- someone
   * who read eight regression manhwa this week wants more of that now -- but
   * a phase from last year must not be erased either, or the profile lurches
   * every time taste moves. Decay, not a window.
   */
  const HALF_LIFE = 21 * 86400000;
  const decay = (at) => Math.pow(0.5, (Date.now() - at) / HALF_LIFE);

  /* --- the taste profile ----------------------------------------------------- */

  const library = () => {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    return Array.isArray(collection.library) ? collection.library.filter((t) => t && !t.hidden) : [];
  };

  /** Chapters finished per series id, which is the strongest implicit signal. */
  function readCounts() {
    const counts = {};
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(RESUME_PREFIX) || !key.endsWith('.read')) continue;
        const list = readJSON(key, []);
        if (Array.isArray(list) && list.length) {
          counts[key.slice(RESUME_PREFIX.length, -'.read'.length)] = list.length;
        }
      }
    } catch {}
    return counts;
  }

  /**
   * What this reader likes, as weighted genre and tag scores.
   *
   * Built from titles they have actually read, enriched with the metadata
   * YomuAniList has already cached for them. No lookup is forced: a title
   * that has never been looked up contributes its reading weight to nothing
   * and is simply not yet understood, which is honest and costs no requests.
   */
  function taste() {
    const cached = readJSON(TASTE_KEY, null);
    if (cached && Date.now() - cached.at < 3600000) return cached.profile;

    const genres = {};
    const tags = {};
    const countries = {};
    const seeds = [];

    const shelf = library();
    const counts = readCounts();
    const nameOf = (id) => shelf.find((t) => t && (t.id === id || t.seriesId === id))?.title || '';

    const add = (into, key, amount) => {
      if (!key) return;
      into[key] = (into[key] || 0) + amount;
    };

    /* Reading weight: chapters finished, damped. Fifty chapters of one series
       is a stronger signal than five, and not ten times stronger -- otherwise
       one long series is the entire profile. */
    for (const [seriesId, count] of Object.entries(counts)) {
      const title = nameOf(seriesId);
      if (!title) continue;
      const weight = Math.log2(1 + count);
      seeds.push({ title, weight, count });
      const meta = window.YomuAniList?.cached?.(title);
      if (!meta) continue;
      for (const g of meta.genres || []) add(genres, g, weight);
      for (const t of meta.tags || []) add(tags, t.name, weight * (t.rank / 100));
    }

    /* Saving something is a choice, and a weaker one than reading it. */
    for (const row of shelf) {
      const meta = window.YomuAniList?.cached?.(row.title);
      if (!meta) continue;
      for (const g of meta.genres || []) add(genres, g, 0.5);
      if (meta.country) add(countries, meta.country, 1);
    }

    /* Explicit events on top, decayed. */
    for (const event of readJSON(EVENTS_KEY, [])) {
      const weight = (WEIGHTS[event.t] || 0) * decay(event.at);
      if (!weight) continue;
      const meta = window.YomuAniList?.cached?.(event.n);
      if (!meta) continue;
      for (const g of meta.genres || []) add(genres, g, weight * 0.4);
      for (const t of meta.tags || []) add(tags, t.name, weight * 0.4 * (t.rank / 100));
      if (meta.country) add(countries, meta.country, weight * 0.3);
    }

    const top = (obj, n) => Object.entries(obj)
      .sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ name: k, weight: v }));

    const profile = {
      genres: top(genres, 12),
      tags: top(tags, 16),
      countries: top(countries, 3),
      /* The titles worth building "Because you read..." rails from. */
      seeds: seeds.sort((a, b) => b.weight - a.weight).slice(0, 5),
      /* Below this the profile is guesswork and the feed should stay global. */
      warm: seeds.length >= 2,
    };
    writeJSON(TASTE_KEY, { at: Date.now(), profile });
    return profile;
  }

  /** Forget the derived profile, not the evidence. Called when reading changes. */
  const forget = () => { try { localStorage.removeItem(TASTE_KEY); } catch {} };

  /**
   * Look up the handful of titles the profile is actually built from.
   *
   * Without this the profile reads only metadata something else happened to
   * cache, which on a fresh device is nothing -- so every genre and tag score
   * is zero and "For you" is the global list wearing a personal label. That
   * is worse than not having the rail.
   *
   * Bounded hard: the top few seeds, once, then cached for a week by
   * YomuAniList. A reader with sixty saved titles still costs at most this
   * many requests, and the rail is drawn from whatever has arrived rather
   * than waiting for all of them.
   */
  const WARM_LIMIT = 5;
  let warming = null;

  function warm() {
    if (warming) return warming;
    const shelf = library();
    const counts = readCounts();
    const nameOf = (id) => shelf.find((t) => t && (t.id === id || t.seriesId === id))?.title || '';

    const wanted = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => nameOf(id))
      .filter(Boolean)
      .concat(shelf.map((t) => t.title).filter(Boolean))
      .filter((title, i, all) => all.indexOf(title) === i)
      .filter((title) => !window.YomuAniList?.cached?.(title))
      .slice(0, WARM_LIMIT);

    if (!wanted.length) return Promise.resolve(false);

    warming = Promise.all(wanted.map((title) => window.YomuAniList?.similar?.(title)))
      .then(() => { forget(); return true; })
      .catch(() => false)
      .finally(() => { warming = null; });
    return warming;
  }

  /* --- scoring --------------------------------------------------------------- *
   *
   * Weights are data. Changing the balance is editing this object, not
   * rewriting the engine, which is the whole reason it is shaped this way.
   */

  const WEIGHT = {
    taste: 0.30,      // genre and tag overlap with what they read
    similarity: 0.20, // closeness to a specific title they like
    community: 0.15,  // how strongly readers rate and recommend it
    behaviour: 0.15,  // signals from their own history
    quality: 0.10,    // rating
    freshness: 0.10,  // current momentum
  };

  const norm = (value, max) => (max > 0 ? Math.min(1, value / max) : 0);

  function score(item, profile) {
    const genreWeight = Object.fromEntries((profile.genres || []).map((g) => [g.name, g.weight]));
    const tagWeight = Object.fromEntries((profile.tags || []).map((t) => [t.name, t.weight]));
    const maxGenre = Math.max(1, ...Object.values(genreWeight));
    const maxTag = Math.max(1, ...Object.values(tagWeight));

    let tasteHit = 0;
    for (const g of item.genres || []) tasteHit += norm(genreWeight[g] || 0, maxGenre);
    for (const t of item.tags || []) tasteHit += norm(tagWeight[t.name] || 0, maxTag) * (t.rank / 100);
    const tasteScore = Math.min(1, tasteHit / 3);

    const countryBonus = (profile.countries || []).some((c) => c.name === item.country) ? 1 : 0;

    return (
      WEIGHT.taste * tasteScore
      + WEIGHT.similarity * (item.similarity ?? 0)
      + WEIGHT.community * norm(item.votes ?? 0, 500)
      + WEIGHT.behaviour * countryBonus
      + WEIGHT.quality * norm(item.score ?? 0, 100)
      + WEIGHT.freshness * norm(item.trending ?? 0, 100)
    );
  }

  /* --- dedup and diversity ---------------------------------------------------- */

  /**
   * One card per work, not per source.
   *
   * Yomu can carry the same series from six sources, and the catalogue merges
   * them for the grid -- but a rail assembled from titles needs its own rule.
   * Normalising away punctuation, season markers and the usual suffixes
   * collapses "Solo Leveling", "Solo Leveling (Official Colored)" and
   * "solo-leveling" into one.
   */
  function canonical(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, ' ')
      .replace(/\b(official|colored|colour(ed)?|remastered|digital|novel|light novel|doujinshi|side story|season \d+|part \d+|vol\.? ?\d+)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  const dedupe = (items) => {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const key = canonical(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };

  /**
   * Stop the list becoming twenty of the same thing.
   *
   * Run after scoring, so the best match still leads. What it prevents is the
   * next nineteen all being that match again -- which is what a pure score
   * ordering always produces, and what makes a recommendation feed feel like
   * it has stopped listening.
   */
  function diversify(items, { perGenre = 3, perCountry = 6 } = {}) {
    const genreCount = {};
    const countryCount = {};
    const kept = [];
    const held = [];

    for (const item of items) {
      const lead = (item.genres || [])[0] || '?';
      const country = item.country || '?';
      if ((genreCount[lead] || 0) >= perGenre || (countryCount[country] || 0) >= perCountry) {
        held.push(item);
        continue;
      }
      genreCount[lead] = (genreCount[lead] || 0) + 1;
      countryCount[country] = (countryCount[country] || 0) + 1;
      kept.push(item);
    }
    /* Held-back items go to the tail rather than being dropped: they were
       good enough to score, just repetitive where they landed. */
    return kept.concat(held);
  }

  /* --- what to show ------------------------------------------------------------ */

  const readTitles = () => {
    const shelf = library();
    const counts = readCounts();
    const names = new Set();
    for (const id of Object.keys(counts)) {
      const row = shelf.find((t) => t && (t.id === id || t.seriesId === id));
      if (row?.title) names.add(canonical(row.title));
    }
    for (const row of shelf) if (row.title) names.add(canonical(row.title));
    return names;
  };

  /**
   * The personalised rail.
   *
   * A cold reader gets the global lists instead of an empty feed, and is told
   * as much -- "Popular right now" is an honest label where "For you" would
   * be a lie on a profile with nothing in it.
   */
  async function forYou(limit = 14) {
    /* Warm first: a profile built before any metadata exists scores every
       candidate at zero and silently degrades to the global list. */
    await warm();
    const profile = taste();
    const pool = await rails(['trending', 'popular', 'top', 'gems'], 'all', 20);
    if (!pool) return null;

    const already = readTitles();
    const items = dedupe([...(pool.trending || []), ...(pool.popular || []),
      ...(pool.top || []), ...(pool.gems || [])])
      .filter((item) => !already.has(canonical(item.title)));

    if (!profile.warm) {
      return {
        label: 'Popular right now',
        why: 'Read a few chapters and this becomes yours',
        items: diversify(items).slice(0, limit),
      };
    }

    const ranked = items
      .map((item) => ({ ...item, _score: score(item, profile) }))
      .sort((a, b) => b._score - a._score);

    /* Roughly 70/20/10 -- strong matches, adjacent, and a little exploration.
       Without the tail the feed narrows to one genre within a week. */
    const strong = ranked.slice(0, Math.ceil(limit * 0.7));
    const adjacent = diversify(ranked.slice(strong.length, strong.length + limit))
      .slice(0, Math.ceil(limit * 0.2));
    const explore = (pool.gems || [])
      .filter((g) => !already.has(canonical(g.title))
        && !strong.some((s) => canonical(s.title) === canonical(g.title))
        && !adjacent.some((s) => canonical(s.title) === canonical(g.title)))
      .slice(0, Math.max(1, Math.floor(limit * 0.1)));

    /* Name a tag, not just a genre. "Because you read Action" is true of half
       the catalogue and explains nothing; "Action and Dungeon" is the actual
       reason these titles are here. Tags are the specific half of the
       profile, which is why they carry the sentence. */
    const genre = profile.genres[0]?.name;
    const tag = profile.tags.map((t) => t.name)
      .find((name) => name !== genre && !/full colou?r|male protagonist|female protagonist/i.test(name));
    const why = genre && tag ? `Because you read ${genre} and ${tag}`
      : genre ? `Because you read ${genre}`
      : 'From what you have been reading';

    return {
      label: 'For you',
      why,
      items: dedupe([...strong, ...adjacent, ...explore]).slice(0, limit),
    };
  }

  /** "Because you read X" — one rail per recent strong interest. */
  async function becauseYouRead(max = 2) {
    const profile = taste();
    if (!profile.seeds.length) return [];
    const already = readTitles();
    const out = [];

    for (const seed of profile.seeds.slice(0, max)) {
      const answer = await window.YomuAniList?.similar?.(seed.title);
      if (!answer?.picks?.length) continue;
      const items = answer.picks
        .filter((p) => !already.has(canonical(p.title)))
        .map((p) => ({ title: p.title, votes: p.votes, score: p.score, genres: [], tags: [] }));
      if (!items.length) continue;
      out.push({
        label: `Because you read ${answer.matched || seed.title}`,
        why: (answer.because || []).slice(0, 3).join(' · '),
        items: dedupe(items).slice(0, 12),
      });
    }
    return out;
  }

  const api = {
    TYPES, RAILS, WEIGHT,
    rails, taste, forget, warm, note, forYou, becauseYouRead,
    score, diversify, dedupe, canonical, typeOf,
  };

  if (typeof window !== 'undefined') window.YomuRank = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { canonical, diversify, score, WEIGHT, WEIGHTS, RAILS, TYPES, railQuery, shape };
  }

  /* Reading changes taste, so the derived profile is dropped when the
     progression store notices a finished chapter. The evidence is untouched. */
  if (typeof document !== 'undefined') {
    addEventListener('yomu:chapter-complete', forget);
  }
})();
