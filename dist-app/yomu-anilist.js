/**
 * AniList, asked from the browser.
 *
 * This file exists because of one response:
 *
 *   403 "You have been manually blocked. Please come to the principal's
 *        office."
 *
 * That is what AniList returns to a Cloudflare Worker. It blocks datacentre
 * egress, and Yomu's Worker shares an address with every other Worker on the
 * platform, so the server can never be the one to ask -- no amount of caching
 * or backoff changes a manual block.
 *
 * The reader's own browser is not blocked, and AniList sends
 * `access-control-allow-origin: *`, so the request works from the page. It is
 * also the better place for it: the 30-requests-a-minute limit is per IP, and
 * one person on their own address will never come close, where a Worker
 * pooling every reader through one address would.
 *
 * What comes back is not an algorithm's guess. AniList's readers vote on "if
 * you liked X, read Y", so each pick carries a count -- Solo Leveling to
 * Omniscient Reader is over a thousand people. That is the thing worth having
 * and the reason none of it is computed here.
 *
 * `/api/catalog/similar` stays as the floor for a browser that cannot reach
 * AniList at all -- an extension blocking it, an offline device, a network
 * that does not like GraphQL -- and answers from MangaDex instead.
 */
(() => {
  'use strict';

  const ENDPOINT = 'https://graphql.anilist.co';
  const CACHE_KEY = 'yomu.v1.anilist';
  /** A title does not change what it is like. A week is conservative. */
  const TTL = 7 * 86400000;
  const MAX_CACHED = 120;

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  const QUERY = `
query ($search: String) {
  Media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
    id
    title { romaji english native }
    genres
    countryOfOrigin
    tags { name rank isMediaSpoiler }
    recommendations(sort: RATING_DESC, perPage: 12) {
      nodes {
        rating
        mediaRecommendation {
          title { romaji english }
          genres
          averageScore
        }
      }
    }
  }
}`;

  /* --- the cache ----------------------------------------------------------- *
   *
   * localStorage, keyed by the lowercased title. Bounded, because a reader
   * with a large library would otherwise grow this without limit in a store
   * that is shared with their actual reading progress and is not large.
   */

  const store = () => readJSON(CACHE_KEY, {}) || {};

  function cached(key) {
    const row = store()[key];
    if (!row || typeof row !== 'object') return null;
    if (Date.now() - (row.at || 0) > TTL) return null;
    return row.answer;
  }

  function remember(key, answer) {
    const all = store();
    all[key] = { at: Date.now(), answer };
    const keys = Object.keys(all);
    if (keys.length > MAX_CACHED) {
      /* Oldest out first. A reader who looks up a hundred titles is not
         someone whose first lookup still matters. */
      keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
      for (const old of keys.slice(0, keys.length - MAX_CACHED)) delete all[old];
    }
    writeJSON(CACHE_KEY, all);
  }

  /* --- the call ------------------------------------------------------------ */

  const nameOf = (t) => (t && (t.english || t.romaji || t.native)) || '';

  function shape(media) {
    if (!media) return null;

    /* Spoiler tags are dropped. They are the interesting ones -- the twist is
       what makes a title distinctive -- which is exactly why showing one
       beside a recommendation spoils it. */
    const tags = (media.tags || [])
      .filter((t) => t && !t.isMediaSpoiler && typeof t.rank === 'number')
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 8)
      .map((t) => ({ name: String(t.name), rank: t.rank }));

    const picks = (media.recommendations?.nodes || [])
      .map((node) => {
        const row = node?.mediaRecommendation;
        const title = nameOf(row?.title);
        if (!title) return null;
        return {
          title,
          votes: Number(node.rating) || 0,
          score: typeof row.averageScore === 'number' ? row.averageScore : undefined,
        };
      })
      .filter(Boolean)
      /* An unvoted pairing is noise, not a recommendation. */
      .filter((p) => p.votes > 0)
      .slice(0, 10);

    if (!picks.length && !tags.length) return null;

    return {
      source: 'anilist',
      matched: nameOf(media.title),
      tags,
      genres: Array.isArray(media.genres) ? media.genres : [],
      /* JP / KR / CN. The only honest basis for Manga vs Manhwa vs Manhua --
         source metadata calls half of them "webtoon" or nothing at all. */
      country: media.countryOfOrigin || '',
      picks,
      because: tags.slice(0, 4).map((t) => t.name),
    };
  }

  /**
   * Everything known about a title, best source first.
   *
   * Cache, then AniList from this browser, then the Worker's MangaDex floor.
   * Never throws: a recommendation failing is a smaller thing than the page
   * it was asked from.
   */
  async function similar(title) {
    const key = String(title || '').trim().toLowerCase();
    if (!key) return null;

    const hit = cached(key);
    if (hit) return hit;

    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { search: title } }),
      });
      if (response.ok) {
        const data = await response.json();
        const answer = shape(data?.data?.Media);
        if (answer) { remember(key, answer); return answer; }
      } else if (response.status === 429) {
        /* Per-IP, so this is one person having asked a lot in a minute --
           worth waiting out rather than falling through to a worse answer. */
        console.warn('[anilist] rate limited');
      }
    } catch {
      /* Blocked, offline, or a network that dislikes GraphQL. Fall through. */
    }

    try {
      const response = await fetch('/api/catalog/similar?title=' + encodeURIComponent(title));
      if (!response.ok) return null;
      const answer = await response.json();
      if (answer?.picks?.length) { remember(key, answer); return answer; }
      return answer?.source === 'none' ? null : answer;
    } catch { return null; }
  }

  const api = { similar, cached: (t) => cached(String(t || '').trim().toLowerCase()) };

  if (typeof window !== 'undefined') window.YomuAniList = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { shape, nameOf };
})();
