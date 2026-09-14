import * as cheerio from 'cheerio';
import { normalizeUrl, unique } from './runtime.js';

const STABLE_CLASS = /^[a-zA-Z_-][a-zA-Z0-9_-]{1,40}$/;
const HASHY = /(?:^|[-_])[a-f0-9]{7,}(?:$|[-_])|\d{5,}|css-|jsx-|sc-|chakra-|emotion-/i;
const CHAPTER_WORD = /\b(ch(?:apter)?|ep(?:isode)?|vol(?:ume)?|cap(?:itulo)?|chapitre|chapter|episode)\b/i;
const READER_WORD = /(reader|reading|chapter|page|comic|manga|webtoon|content)/i;
const BAD_MEDIA = /(logo|icon|avatar|emoji|banner|advert|ads?[._/-]|sprite|tracking|pixel|favicon|placeholder|loading|comment)/i;
const IMAGE_EXT = /\.(?:avif|webp|jpe?g|png|gif)(?:$|[?#])/i;

const cleanText = v => String(v || '').replace(/\s+/g, ' ').trim();
const cssEsc = v => String(v).replace(/([ #;?%&,.+*~\\':"!^$[\]()=>|/@])/g, '\\$1');
const stableClasses = raw => String(raw || '').split(/\s+/).filter(c => STABLE_CLASS.test(c) && !HASHY.test(c)).slice(0, 3);

function elementSelector($, el, suffix='') {
  const $el = $(el);
  const tag = el?.tagName || el?.name || '*';
  const id = $el.attr('id');
  if (id && STABLE_CLASS.test(id) && !HASHY.test(id)) return `#${cssEsc(id)}${suffix}`;
  const classes = stableClasses($el.attr('class'));
  if (classes.length) return `${tag}.${classes.map(cssEsc).join('.')}${suffix}`;
  return `${tag}${suffix}`;
}

function parentSelectors($, el, child='a[href]') {
  const out = [];
  let p = $(el).parent();
  for (let i = 0; i < 3 && p.length; i++, p = p.parent()) {
    const node = p.get(0);
    const sel = elementSelector($, node);
    if (sel !== (node?.tagName || node?.name || '*')) out.push(`${sel} ${child}`);
  }
  return out;
}

function attrValue($el, attrs) {
  for (const attr of attrs || []) {
    if (attr === 'text') {
      const t = cleanText($el.text());
      if (t) return t;
      continue;
    }
    const v = $el.attr(attr);
    if (v) return cleanText(v);
  }
  return null;
}

export function extractByStrategies(html, baseUrl, strategies=[], { url=false }={}) {
  const $ = cheerio.load(html);
  for (const s of strategies) {
    let values = [];
    try {
      $(s.selector).each((_, el) => {
        const v = attrValue($(el), s.attrs || ['text']);
        const normalized = url ? normalizeUrl(baseUrl, v) : v;
        if (normalized) values.push(normalized);
      });
    } catch {}
    values = unique(values);
    if (values.length) return { value: s.multiple ? values : values[0], strategy: s };
  }
  return { value: null, strategy: null };
}

export function extractChapters(html, baseUrl, strategy) {
  const $ = cheerio.load(html);
  const out = [];
  try {
    $(strategy.selector).each((_, el) => {
      const $a = $(el);
      const href = normalizeUrl(baseUrl, attrValue($a, strategy.urlAttrs || ['href']));
      const title = attrValue($a, strategy.titleAttrs || ['text','title','aria-label']) || href?.split('/').filter(Boolean).pop();
      if (href && title) out.push({ title: cleanText(title), url: href });
    });
  } catch {}
  const seen = new Set();
  return out.filter(x => !seen.has(x.url) && seen.add(x.url));
}

export function extractPages(html, baseUrl, strategy) {
  const $ = cheerio.load(html);
  const out = [];
  try {
    $(strategy.selector).each((_, el) => {
      const $el = $(el);
      let raw = attrValue($el, strategy.attrs || ['data-src','data-lazy-src','data-original','data-cfsrc','src','srcset']);
      if (!raw) return;
      if ((strategy.attrs || []).includes('srcset') || /\s\d+[wx](?:,|$)/.test(raw)) {
        const items = raw.split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
        raw = items.at(-1) || raw;
      }
      const abs = normalizeUrl(baseUrl, raw);
      if (abs && !abs.startsWith('data:') && !abs.startsWith('blob:')) out.push(abs);
    });
  } catch {}
  return unique(out);
}

function scoreChapterStrategy(html, baseUrl, selector) {
  const strategy = { selector, titleAttrs:['text','title','aria-label'], urlAttrs:['href'] };
  const rows = extractChapters(html, baseUrl, strategy);
  if (!rows.length) return null;
  const chapterish = rows.filter(x => CHAPTER_WORD.test(`${x.title} ${x.url}`)).length / rows.length;
  const uniqueRatio = new Set(rows.map(x=>x.url)).size / rows.length;
  const saneLabels = rows.filter(x => x.title.length >= 1 && x.title.length <= 160).length / rows.length;
  const semantic = READER_WORD.test(selector) ? 1 : 0;
  const countScore = Math.min(30, Math.log2(rows.length + 1) * 6);
  const score = Math.round(countScore + chapterish*35 + uniqueRatio*15 + saneLabels*10 + semantic*10);
  return { ...strategy, score, count: rows.length, chapterish: +chapterish.toFixed(2) };
}

export function detectChapterStrategies(html, baseUrl) {
  const $ = cheerio.load(html);
  const selectors = new Set([
    '.chapter-list a[href]', '.chapters a[href]', '.chapter a[href]', '.chapter-item a[href]',
    '.wp-manga-chapter a[href]', '.listing-chapters_wrap a[href]',
    '[class*="chapter-list"] a[href]', '[class*="chapters"] a[href]', '[class*="chapter-item"] a[href]',
    'a[href*="/chapter"]', 'a[href*="/chap-"]', 'a[href*="/ch-"]', 'a[href*="/episode"]'
  ]);
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const text = cleanText($a.text());
    const href = $a.attr('href') || '';
    if (!CHAPTER_WORD.test(`${text} ${href}`)) return;
    const own = elementSelector($, el, '[href]');
    if (own !== 'a[href]') selectors.add(own);
    for (const p of parentSelectors($, el, 'a[href]')) selectors.add(p);
  });
  return [...selectors]
    .map(s => scoreChapterStrategy(html, baseUrl, s))
    .filter(Boolean)
    .filter(x => x.count >= 1)
    .sort((a,b) => b.score - a.score || b.count - a.count)
    .slice(0, 10);
}

function scorePageStrategy(html, baseUrl, selector) {
  const strategy = { selector, attrs:['data-src','data-lazy-src','data-original','data-cfsrc','data-url','src','srcset'] };
  const pages = extractPages(html, baseUrl, strategy);
  if (!pages.length) return null;
  const extRatio = pages.filter(x => IMAGE_EXT.test(x)).length / pages.length;
  const badRatio = pages.filter(x => BAD_MEDIA.test(x)).length / pages.length;
  const semantic = READER_WORD.test(selector) ? 1 : 0;
  const plausibleCount = pages.length >= 2 && pages.length <= 250 ? 1 : pages.length === 1 ? 0.25 : 0.5;
  const score = Math.round(Math.min(35, Math.log2(pages.length + 1)*8) + extRatio*15 + semantic*25 + plausibleCount*20 - badRatio*35);
  return { ...strategy, score, count: pages.length, badRatio:+badRatio.toFixed(2) };
}

export function detectPageStrategies(html, baseUrl) {
  const $ = cheerio.load(html);
  const selectors = new Set([
    '.reader img', '.reading-content img', '.chapter-content img', '.chapter-page img', '.page-break img',
    '.container-chapter-reader img', '.wp-manga-chapter-img', '#readerarea img', '#chapter-content img',
    '[class*="reader"] img', '[class*="reading"] img', '[class*="chapter-content"] img',
    '[class*="chapter-page"] img', 'article img', 'main img'
  ]);
  $('img').each((_, el) => {
    const $img = $(el);
    const raw = attrValue($img, ['data-src','data-lazy-src','data-original','data-cfsrc','data-url','src','srcset']) || '';
    const cls = $img.attr('class') || '';
    const pcls = $img.parent().attr('class') || '';
    if (!(READER_WORD.test(`${cls} ${pcls}`) || IMAGE_EXT.test(raw))) return;
    const own = elementSelector($, el);
    if (own !== 'img') selectors.add(own);
    for (const p of parentSelectors($, el, 'img')) selectors.add(p);
  });
  return [...selectors]
    .map(s => scorePageStrategy(html, baseUrl, s))
    .filter(Boolean)
    .sort((a,b) => b.score - a.score || b.count - a.count)
    .slice(0, 12);
}

function candidateSeries(html, baseUrl, defs, kind) {
  const $ = cheerio.load(html);
  const out = [];
  for (const d of defs) {
    let val = null;
    try {
      const n = $(d.selector).first();
      val = attrValue(n, d.attrs);
      if (kind === 'url') val = normalizeUrl(baseUrl, val);
    } catch {}
    if (!val) continue;
    let score = d.score || 0;
    if (kind === 'text') {
      if (val.length >= 2 && val.length <= 220) score += 8;
      if (/home|login|search/i.test(val)) score -= 10;
    }
    if (kind === 'url' && IMAGE_EXT.test(val)) score += 6;
    out.push({ selector:d.selector, attrs:d.attrs, score, sample:cleanText(val).slice(0,180) });
  }
  return out.sort((a,b)=>b.score-a.score).slice(0,5);
}

export function detectSeriesStrategies(html, baseUrl) {
  const titleDefs = [
    {selector:'h1',attrs:['text'],score:34},
    {selector:'[itemprop="name"]',attrs:['text','content'],score:30},
    {selector:'meta[property="og:title"]',attrs:['content'],score:28},
    {selector:'meta[name="twitter:title"]',attrs:['content'],score:24},
    {selector:'title',attrs:['text'],score:15}
  ];
  const coverDefs = [
    {selector:'meta[property="og:image"]',attrs:['content'],score:34},
    {selector:'[itemprop="image"]',attrs:['src','data-src','content'],score:31},
    {selector:'img.cover',attrs:['data-src','src'],score:30},
    {selector:'img[class*="cover"]',attrs:['data-src','src'],score:26},
    {selector:'img[class*="poster"]',attrs:['data-src','src'],score:24}
  ];
  const descDefs = [
    {selector:'[itemprop="description"]',attrs:['text','content'],score:31},
    {selector:'.description',attrs:['text'],score:29},
    {selector:'[class*="description"]',attrs:['text'],score:25},
    {selector:'.summary',attrs:['text'],score:24},
    {selector:'[class*="synopsis"]',attrs:['text'],score:24},
    {selector:'meta[name="description"]',attrs:['content'],score:20},
    {selector:'meta[property="og:description"]',attrs:['content'],score:20}
  ];
  return {
    title: candidateSeries(html, baseUrl, titleDefs, 'text'),
    cover: candidateSeries(html, baseUrl, coverDefs, 'url'),
    description: candidateSeries(html, baseUrl, descDefs, 'text')
  };
}

export function selectorBrittleness(selector='') {
  let score = 0;
  if (/:nth-(?:child|of-type)\(/.test(selector)) score += 35;
  if ((selector.match(/>/g)||[]).length >= 3) score += 25;
  if ((selector.match(/\s+/g)||[]).length >= 5) score += 15;
  if (HASHY.test(selector)) score += 30;
  if (/\[[^\]]*style[=\]]/.test(selector)) score += 20;
  return Math.min(100, score);
}

export function overlapRatio(a=[], b=[]) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let same = 0;
  for (const x of A) if (B.has(x)) same++;
  return same / Math.min(A.size, B.size);
}

export function inferSourceIdentity(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./,'');
  const label = host.split('.')[0].replace(/[-_]+/g,' ');
  const name = label.replace(/\b\w/g, m=>m.toUpperCase());
  const id = host.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').toLowerCase();
  return { id, name, baseUrl:`${u.protocol}//${u.host}` };
}

const CATALOG_BAD = /(login|sign[-_ ]?in|register|account|privacy|terms|contact|discord|facebook|twitter|instagram|logout|admin|feed|rss|javascript:|mailto:)/i;
const SERIES_PATH_WORD = /(manga|manhwa|manhua|webtoon|comic|series|title|book|read)/i;

function sameSiteHost(a, b) {
  try {
    const A = new URL(a), B = new URL(b);
    const ah = A.hostname.replace(/^www\./,'');
    const bh = B.hostname.replace(/^www\./,'');
    return ah === bh || ah.endsWith(`.${bh}`) || bh.endsWith(`.${ah}`);
  } catch { return false; }
}

function catalogRow($, el, baseUrl) {
  const $item = $(el);
  const isAnchor = (el?.tagName || el?.name) === 'a';
  const anchors = isAnchor ? $item : $item.find('a[href]');
  let chosen = null;
  anchors.each((_, a) => {
    if (chosen) return;
    const raw = $(a).attr('href');
    const url = normalizeUrl(baseUrl, raw);
    const label = cleanText($(a).text() || $(a).attr('title') || $(a).attr('aria-label'));
    if (!url || !sameSiteHost(url, baseUrl)) return;
    if (CATALOG_BAD.test(`${url} ${label}`) || CHAPTER_WORD.test(`${url} ${label}`)) return;
    const path = new URL(url).pathname;
    const seriesish = SERIES_PATH_WORD.test(path) || path.split('/').filter(Boolean).length >= 2;
    if (!seriesish) return;
    chosen = { a, url, label };
  });
  if (!chosen) return null;
  const titleCandidates = ['h1','h2','h3','h4','h5','.title','[class*="title"]','strong'];
  let title = chosen.label;
  let titleSelector = isAnchor ? '' : 'a[href]';
  for (const sel of titleCandidates) {
    const t = cleanText($item.find(sel).first().text());
    if (t && t.length >= 2 && t.length <= 180) { title=t; titleSelector=sel; break; }
  }
  if (!title || title.length > 220) return null;
  const img = $item.find('img').first();
  const cover = normalizeUrl(baseUrl, attrValue(img, ['data-src','data-lazy-src','data-original','data-cfsrc','src']));
  return {
    url: chosen.url,
    title,
    cover,
    linkSelector: isAnchor ? '' : 'a[href]',
    titleSelector,
    coverSelector: 'img'
  };
}

function scoreCatalogSelector(html, baseUrl, selector) {
  const $ = cheerio.load(html);
  const rows = [];
  try {
    $(selector).each((_, el) => {
      const row = catalogRow($, el, baseUrl);
      if (row) rows.push(row);
    });
  } catch { return null; }
  const uniqueRows = [];
  const seen = new Set();
  for (const row of rows) if (!seen.has(row.url)) { seen.add(row.url); uniqueRows.push(row); }
  if (uniqueRows.length < 2) return null;
  const count = uniqueRows.length;
  const imageRatio = uniqueRows.filter(x=>x.cover).length / count;
  const seriesRatio = uniqueRows.filter(x=>SERIES_PATH_WORD.test(new URL(x.url).pathname)).length / count;
  const titleRatio = uniqueRows.filter(x=>x.title.length>=2 && x.title.length<=180).length / count;
  const brittle = selectorBrittleness(selector);
  let score = Math.min(35, Math.log2(count+1)*7) + imageRatio*25 + titleRatio*20 + seriesRatio*20 - brittle*.35;
  if (count > 250) score -= 20;
  const titleVotes = new Map();
  const linkVotes = new Map();
  for (const r of uniqueRows.slice(0,80)) {
    titleVotes.set(r.titleSelector,(titleVotes.get(r.titleSelector)||0)+1);
    linkVotes.set(r.linkSelector,(linkVotes.get(r.linkSelector)||0)+1);
  }
  const winner = m => [...m.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0] ?? '';
  return {
    selector,
    listSelector: selector,
    linkSelector: winner(linkVotes),
    titleSelector: winner(titleVotes),
    coverSelector: 'img',
    coverAttrs: ['data-src','data-lazy-src','data-original','data-cfsrc','src'],
    count,
    imageRatio:+imageRatio.toFixed(2),
    seriesRatio:+seriesRatio.toFixed(2),
    score:Math.max(0,Math.round(score)),
    sample:uniqueRows.slice(0,12)
  };
}

export function detectCatalogStrategies(html, baseUrl) {
  const $ = cheerio.load(html);
  const selectors = new Set([
    'article',
    '[class*="manga-item"]','[class*="series-item"]','[class*="title-item"]',
    '[class*="manga-card"]','[class*="series-card"]','[class*="title-card"]',
    '[class*="comic-item"]','[class*="webtoon-item"]'
  ]);

  $('a[href]').each((_, el) => {
    const $a = $(el);
    const url = normalizeUrl(baseUrl,$a.attr('href'));
    const text = cleanText($a.text() || $a.attr('title') || $a.attr('aria-label'));
    if (!url || !sameSiteHost(url,baseUrl) || CATALOG_BAD.test(`${url} ${text}`) || CHAPTER_WORD.test(`${url} ${text}`)) return;
    let path;
    try { path = new URL(url).pathname; } catch { return; }
    if (!SERIES_PATH_WORD.test(path) && !ancestorHasImage($,el)) return;

    const segments = path.split('/').filter(Boolean);
    const semantic = segments.find(seg=>SERIES_PATH_WORD.test(seg));
    if (semantic && semantic.length < 40) selectors.add(`a[href*="/${semantic.replace(/"/g,'')}/"]`);

    const own = elementSelector($,el);
    if (own !== 'a') selectors.add(own);
    let p = $a.parent();
    for (let i=0;i<3 && p.length;i++,p=p.parent()) {
      const node=p.get(0);
      if (!node) continue;
      const sel=elementSelector($,node);
      const tag=node.tagName || node.name || '';
      if (sel!==tag && p.find('img').length && p.find('a[href]').length) selectors.add(sel);
    }
  });

  return [...selectors]
    .map(s=>scoreCatalogSelector(html,baseUrl,s))
    .filter(Boolean)
    .sort((a,b)=>b.score-a.score || b.count-a.count)
    .slice(0,10);
}
