import * as cheerio from 'cheerio';
import { inspectImageQuality, parseDateish } from './hunter.js';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152 Safari/537.36';

async function fetchJson(url, timeout = 18000, headers = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'application/json,text/plain,*/*',
      ...headers
    },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function fetchText(url, timeout = 18000, headers = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      ...headers
    },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

function abs(base, value) {
  try { return new URL(value, base).toString(); } catch { return null; }
}

export async function probeTapasPublicFree({ freshDays = 5, timeout = 18000 } = {}) {
  const latestUrl = new URL('https://story-api.tapas.io/cosmos/api/v1/landing/genre');
  latestUrl.searchParams.set('category_type', 'COMIC');
  latestUrl.searchParams.set('sort_option', 'NEWEST_EPISODE');
  latestUrl.searchParams.set('subtab_id', '17');
  latestUrl.searchParams.set('pageSize', '25');
  latestUrl.searchParams.set('page', '0');

  const latest = await fetchJson(latestUrl, timeout, { Referer: 'https://m.tapas.io/' });
  const series = latest?.data?.items || [];
  if (!series.length) throw new Error('Tapas public latest-comics API returned no series.');

  const attempts = [];
  for (const item of series.slice(0, 8)) {
    const seriesId = item?.seriesId;
    if (!seriesId) continue;

    const episodesUrl = new URL(`https://tapas.io/series/${seriesId}/episodes`);
    episodesUrl.searchParams.set('page', '1');
    episodesUrl.searchParams.set('sort', 'NEWEST');
    episodesUrl.searchParams.set('since', Date.now().toString());
    episodesUrl.searchParams.set('large', 'true');
    episodesUrl.searchParams.set('last_access', '0');
    episodesUrl.searchParams.set('', '');

    try {
      const episodePayload = await fetchJson(episodesUrl, timeout, { Referer: 'https://m.tapas.io/' });
      const episodes = (episodePayload?.data?.episodes || []).filter(ep => !ep?.scheduled);
      const latestEpisode = episodes
        .map(ep => ({ ...ep, parsedDate: parseDateish(ep?.publish_date) }))
        .filter(ep => ep.parsedDate)
        .sort((a, b) => b.parsedDate - a.parsedDate)[0] || null;
      const freeEpisodes = episodes.filter(ep => ep?.free || ep?.unlocked).slice(0, 3);
      if (!freeEpisodes.length) {
        attempts.push({ seriesId, title: item?.title || null, reason: 'no public/free episode in sampled page' });
        continue;
      }

      const samplePages = [];
      for (const episode of freeEpisodes.slice(0, 2)) {
        const episodeUrl = `https://tapas.io/episode/${episode.id}`;
        const html = await fetchText(episodeUrl, timeout, { Referer: `https://tapas.io/series/${seriesId}` });
        const $ = cheerio.load(html);
        const pages = [];
        $('img.content__img').each((_, img) => {
          const raw = $(img).attr('data-src') || $(img).attr('src');
          const url = raw && abs(episodeUrl, raw);
          if (url && !pages.includes(url)) pages.push(url);
        });
        if (pages.length) samplePages.push({ chapter: { url: episodeUrl }, pages });
      }

      if (!samplePages.length) {
        attempts.push({ seriesId, title: item?.title || null, reason: 'free episode HTML exposed no reader images' });
        continue;
      }

      const quality = await inspectImageQuality(samplePages, { timeout: Math.min(timeout, 14000), maxImages: 3 });
      const latestAt = latestEpisode?.parsedDate || null;
      const ageDays = latestAt ? Math.max(0, (Date.now() - latestAt.getTime()) / 86400000) : null;
      const fresh = ageDays != null && ageDays <= freshDays;
      const status = fresh && quality.highQuality ? 'PASS' : quality.status === 'low' || (ageDays != null && !fresh) ? 'REJECT' : 'REVIEW';
      const reasons = [];
      if (fresh) reasons.push(`fresh ${Number(ageDays.toFixed(2))}d`);
      else if (ageDays != null) reasons.push(`latest visible episode is ${Number(ageDays.toFixed(2))} days old`);
      else reasons.push('freshness could not be proven');
      if (quality.highQuality) reasons.push(`${quality.strong}/${quality.usable} strong image samples`);
      else if (quality.status === 'low') reasons.push('reader image samples did not meet the quality floor');
      else reasons.push('image quality could not be proven');
      reasons.push(`${freeEpisodes.length} public/free episode(s) found`);

      return {
        host: 'tapas.io',
        name: 'Tapas',
        url: 'https://tapas.io/',
        status,
        score: Math.round((fresh ? 45 : ageDays == null ? 15 : 0) + (quality.highQuality ? 45 : quality.status === 'unknown' ? 15 : 0) + 10),
        reasons,
        adapterAware: true,
        discovery: {
          method: 'keiyoushi public Tapas API + public episode HTML',
          seriesId,
          seriesTitle: item?.title || null,
          seriesUrl: `https://tapas.io/series/${seriesId}`,
          freeEpisodeCount: freeEpisodes.length
        },
        freshness: {
          status: fresh ? 'fresh' : ageDays == null ? 'unknown' : 'stale',
          fresh,
          latestAt: latestAt?.toISOString() || null,
          ageDays: ageDays == null ? null : Number(ageDays.toFixed(2))
        },
        quality,
        attempts
      };
    } catch (error) {
      attempts.push({ seriesId, title: item?.title || null, reason: String(error?.message || error) });
    }
  }

  return {
    host: 'tapas.io',
    name: 'Tapas',
    url: 'https://tapas.io/',
    status: 'REJECT',
    score: 0,
    reasons: ['Tapas public API returned series, but Hunter could not prove a public/free reader path from the sampled titles.'],
    adapterAware: true,
    attempts
  };
}

export function registrySeedUrls(candidate) {
  const urls = [];
  for (const item of candidate?.evidence || []) {
    if (item?.sample && /^https?:\/\//i.test(item.sample) && !urls.includes(item.sample)) urls.push(item.sample);
  }
  return urls;
}
