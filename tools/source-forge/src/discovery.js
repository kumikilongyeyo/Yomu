import * as cheerio from 'cheerio';
import { loadPage, normalizeUrl, unique } from './runtime.js';
import { detectChapterStrategies, detectSeriesStrategies, inferSourceIdentity } from './heuristics.js';

const SERIES_WORD = /(manga|manhwa|manhua|webtoon|comic|series|title|book|novel|read)/i;
const CATALOG_WORD = /(manga|manhwa|manhua|webtoon|comic|library|browse|series|titles|catalog|directory|latest|popular)/i;
const CHAPTER_WORD = /(chapter|chap[-_/ ]?\d|episode|ep[-_/ ]?\d|\/ch[-_/])/i;
const BAD_WORD = /(login|sign[-_ ]?in|register|account|privacy|terms|contact|discord|facebook|twitter|instagram|javascript:|mailto:|logout|admin|wp-admin|feed|rss)/i;
const ASSET_EXT = /\.(?:jpg|jpeg|png|gif|webp|avif|svg|css|js|json|xml|pdf|zip|rar|7z|mp4|mp3)(?:$|[?#])/i;

const clean = v => String(v || '').replace(/\s+/g, ' ').trim();

function sameSite(a, b) {
  try {
    const A = new URL(a), B = new URL(b);
    return A.hostname === B.hostname || A.hostname.endsWith(`.${B.hostname}`) || B.hostname.endsWith(`.${A.hostname}`);
  } catch { return false; }
}

function ancestorHasImage($, el) {
  let p = $(el);
  for (let i=0; i<3 && p.length; i++, p=p.parent()) {
    if (p.find('img').length) return true;
  }
  return false;
}

export function rankSeriesLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const rows = new Map();
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const raw = $a.attr('href');
    const url = normalizeUrl(baseUrl, raw);
    const text = clean($a.text() || $a.attr('title') || $a.attr('aria-label'));
    if (!url || !/^https?:/i.test(url) || !sameSite(url, baseUrl)) return;
    if (url === baseUrl || ASSET_EXT.test(url) || BAD_WORD.test(`${url} ${text}`) || CHAPTER_WORD.test(`${url} ${text}`)) return;
    let score = 0;
    const path = new URL(url).pathname;
    if (SERIES_WORD.test(path)) score += 28;
    if (SERIES_WORD.test(text)) score += 6;
    if (text.length >= 2 && text.length <= 120) score += 14;
    if (ancestorHasImage($, el)) score += 18;
    if (path.split('/').filter(Boolean).length >= 2) score += 8;
    if (/\d{3,}/.test(text)) score -= 8;
    if (/^(home|next|previous|prev|more|read more|view all)$/i.test(text)) score -= 16;
    const old = rows.get(url);
    const row = { url, text:text.slice(0,140), score };
    if (!old || row.score > old.score) rows.set(url, row);
  });
  return [...rows.values()].sort((a,b)=>b.score-a.score).slice(0,120);
}

export function rankCatalogLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const out = [];
  $('a[href]').each((_, el) => {
    const text = clean($(el).text());
    const url = normalizeUrl(baseUrl, $(el).attr('href'));
    if (!url || !sameSite(url, baseUrl) || BAD_WORD.test(`${url} ${text}`) || ASSET_EXT.test(url)) return;
    let score = 0;
    if (CATALOG_WORD.test(text)) score += 25;
    if (CATALOG_WORD.test(new URL(url).pathname)) score += 25;
    if (/browse|directory|library|manga|manhwa|manhua|webtoon|series|titles/i.test(`${url} ${text}`)) score += 20;
    if (score) out.push({url,text:text.slice(0,120),score});
  });
  const seen = new Set();
  return out.sort((a,b)=>b.score-a.score).filter(x=>!seen.has(x.url)&&seen.add(x.url)).slice(0,12);
}

async function probeSeries(url, timeout) {
  try {
    const page = await loadPage(url,{scroll:false,timeout});
    const chapters = detectChapterStrategies(page.html,page.finalUrl);
    const series = detectSeriesStrategies(page.html,page.finalUrl);
    const top = chapters[0];
    let score = 0;
    if (top?.count) score += Math.min(55, 18 + Math.log2(top.count+1)*10);
    if (series.title?.length) score += 16;
    if (series.cover?.length) score += 8;
    if (top?.chapterish >= .5) score += 12;
    return {url:page.finalUrl,score:Math.round(score),chapterCount:top?.count||0,title:series.title?.[0]?.sample||null,ok:!!top?.count};
  } catch(error) {
    return {url,score:0,chapterCount:0,title:null,ok:false,error:error?.message||String(error)};
  }
}

export async function discoverSeriesEntry(inputUrl, options={}) {
  const timeout = options.timeout || 14000;
  const maxProbes = Math.max(4, Math.min(options.maxProbes || 12, 24));
  const identity = inferSourceIdentity(inputUrl);
  const start = await loadPage(inputUrl,{scroll:false,timeout});
  const directChapters = detectChapterStrategies(start.html,start.finalUrl);
  const directSeries = detectSeriesStrategies(start.html,start.finalUrl);
  const catalogUrls = rankCatalogLinks(start.html,start.finalUrl).map(x=>x.url);

  if ((directChapters[0]?.count || 0) >= 1 && directSeries.title?.length) {
    return {
      inputUrl,
      inputKind:'series',
      rootUrl:identity.baseUrl,
      seriesUrl:start.finalUrl,
      catalogUrls:unique([identity.baseUrl,...catalogUrls]).slice(0,8),
      tested:[{url:start.finalUrl,ok:true,chapterCount:directChapters[0].count,score:100,title:directSeries.title[0]?.sample||null}],
      confidence:100
    };
  }

  let candidates = rankSeriesLinks(start.html,start.finalUrl).slice(0,maxProbes);
  const tested = [];
  for (const candidate of candidates) {
    const p = await probeSeries(candidate.url, timeout);
    tested.push(p);
    if (p.ok && p.score >= 72) break;
  }

  if (!tested.some(x=>x.ok) && catalogUrls.length) {
    for (const catalogUrl of catalogUrls.slice(0,3)) {
      if (tested.length >= maxProbes) break;
      try {
        const catalog = await loadPage(catalogUrl,{scroll:false,timeout});
        const more = rankSeriesLinks(catalog.html,catalog.finalUrl).slice(0,Math.max(2,maxProbes-tested.length));
        for (const candidate of more) {
          if (tested.length >= maxProbes) break;
          if (tested.some(x=>x.url===candidate.url)) continue;
          tested.push(await probeSeries(candidate.url,timeout));
          if (tested.at(-1)?.ok && tested.at(-1)?.score >= 72) break;
        }
      } catch {}
      if (tested.some(x=>x.ok && x.score>=72)) break;
    }
  }

  const winner = tested.filter(x=>x.ok).sort((a,b)=>b.score-a.score || b.chapterCount-a.chapterCount)[0];
  if (!winner) {
    const err = new Error('Could not automatically find a series page from this URL. Paste a title/series URL from the site, or use a site with ordinary HTML title links.');
    err.code = 'NO_SERIES_DISCOVERED';
    throw err;
  }

  return {
    inputUrl,
    inputKind:'site',
    rootUrl:identity.baseUrl,
    seriesUrl:winner.url,
    catalogUrls:unique([identity.baseUrl,...catalogUrls]).slice(0,8),
    tested:tested.slice(0,maxProbes),
    confidence:Math.min(99,winner.score)
  };
}
