/**
 * A series page's chapter list, read the way a person reads it.
 *
 * The adaptive runtimes (Website Adaptive, Recipe Adaptive) find chapters by
 * scoring every <a> on a series page. That finds them, but three things went
 * wrong on real sites, all measured on 2026-09-24:
 *
 *   1. Other series leaked in. A Madara or MangaThemesia page carries a
 *      "latest updates" or "popular" sidebar full of chapter links for other
 *      titles, and they score exactly like the real ones. Blue Lock on
 *      mangaread.org came back with 380 chapters for a 368-chapter title; the
 *      twelve extras belonged to six other series.
 *   2. The name was the whole link. MangaThemesia puts the release date inside
 *      the chapter's own anchor, and the "First Chapter" / "New Chapter"
 *      buttons link to the same URLs as the rows, so rows read
 *      "Chapter 52 25 Jul 2025" and "First Chapter Chapter 0" -- and chapter 0
 *      was numbered 63, because 0 was treated as "no number".
 *   3. Long titles were cut. The list stopped at 650 (500 in Recipe Adaptive)
 *      after a 2,600-anchor scan, so One Piece showed 650 of 1,200 chapters and
 *      Martial Peak 650 of 3,864 -- every older chapter simply did not exist.
 *
 * This module is the one place that knows how to turn anchors into chapters.
 * It never decides what *is* a chapter link -- each runtime keeps its own
 * scoring and passes it in as `accept` -- it only scopes, names, numbers and
 * de-duplicates what the runtime accepted, and keeps the page's order.
 *
 * Self-contained on purpose (no imports) so `node --test` can load it as-is.
 */

export type HygieneLink = { url: string; text: string };
export type HygieneChapter = { url: string; text: string; number: number | null };

/** Enough for Martial Peak (3,864) with room; far past anything a site paginates less. */
export const MAX_CHAPTERS = 6000;
/** Anchors scanned per page. A 3,864-chapter Madara page has ~4,100 in total. */
const MAX_ANCHORS = 12_000;
/** A chapter anchor's markup is a few hundred bytes; a runaway one is not a label. */
const MAX_INNER = 2_000;

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const TITLE_ATTR = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NOISE: RegExp[] = [
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+\\d{4}\\b`, 'gi'),
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi'),
  /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,
  /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g,
  /\b(?:\d+|an?|one)\s+(?:sec(?:ond)?|min(?:ute)?|h(?:ou)?r|day|week|month|year)s?\s+ago\b/gi,
  /\b(?:yesterday|today|just now)\b/gi,
  /\b\d[\d.,]*\s*[km]?\s*(?:views?|reads?|likes?|comments?)\b/gi,
];
/** Labels that mark a button, not a row: "First Chapter", "Read Last", "New Chapter". */
const NAV_LABEL = /\b(?:(?:first|last|latest|newest|oldest|new|start|begin|continue)\s+(?:chapter|episode|ep)|read\s+(?:first|last|now|latest)|start\s+reading)\b/i;
const BADGE_TAIL = /(?:\s+(?:new|hot|up|free|coin|coins|locked|premium|\u{1F525}|⭐))+!?\s*$/iu;
const CHAPTER_WORD = /\b((?:chapter|chap|ch\.?|episode|ep\.?|issue)\s*#?\s*\d+(?:\.\d+)?)/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(Number(dec)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&[lr]squo;/gi, "'")
    .replace(/&[lr]dquo;/gi, '"')
    .replace(/&[mn]dash;/gi, '-')
    .replace(/&hellip;/gi, '...');
}

function safeChar(code: number): string {
  try { return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''; } catch { return ''; }
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function absolute(raw: string, base: string): string | null {
  try {
    const url = new URL(decodeEntities(raw.trim()), base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

/**
 * The chapter's own label out of its anchor markup: the element a theme names
 * as the chapter title if there is one, with dates, view counts and badges
 * removed either way.
 */
function labelFrom(inner: string, titleAttr: string): string {
  let html = inner
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<time\b[\s\S]*?<\/time>/gi, ' ')
    .replace(/<(span|i|em|small|div|p|b|strong)\b[^>]*\bclass\s*=\s*["'][^"']*(?:date|time|release|ago|view|badge|label-new|new-chap|\bnew\b|\bhot\b|rating|score|like|comment|coin|lock)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const named = html.match(/<(span|div|p|h[1-6]|strong|b)\b[^>]*\bclass\s*=\s*["'][^"']*(?:chapternum|chapter-?title|chapter-?name|chapter-?label|ch-?num|ch-?title|epl-num|episode-?title)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i);
  if (named) html = named[2];
  const text = textOf(html) || textOf(titleAttr);
  return tidy(text);
}

/** Text-level cleanup that applies whatever the markup looked like. */
export function tidy(raw: string): string {
  let text = ` ${raw} `;
  for (const pattern of NOISE) text = text.replace(pattern, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  // "First Chapter Chapter 0" -> "Chapter 0"; "Read First" alone is left for
  // the caller to lose against the row that carries the same URL.
  const nav = text.match(new RegExp(`^(?:${NAV_LABEL.source})\\s*[:\\-]?\\s*(?=${CHAPTER_WORD.source})`, 'i'));
  if (nav) text = text.slice(nav[0].length);

  // "Blue Lock Chapter 12" -> "Chapter 12", but keep "Vol. 2 Chapter 12".
  const at = text.search(CHAPTER_WORD);
  if (at > 0) {
    const prefix = text.slice(0, at).trim();
    if (!/^vol(?:ume)?\.?\s*\d+[:\-]?$/i.test(prefix) && !/^s(?:eason)?\s*\d+[:\-]?$/i.test(prefix)) text = text.slice(at);
  }

  text = text.replace(BADGE_TAIL, '').replace(/[\s\-–—:|·•]+$/u, '').trim();
  // A trailing lone score ("Chapter 170 9.9") is a rating widget, not a title.
  text = text.replace(new RegExp(`^(${CHAPTER_WORD.source})\\s+\\d(?:\\.\\d)?$`, 'i'), '$1');
  return text.replace(/\s+/g, ' ').trim();
}

/** A chapter number from the label first, then the URL. 0 is a real chapter. */
export function numberOf(label: string, url: string): number | null {
  const fromLabel = label.match(/(?:chapter|chap|ch\.?|episode|ep\.?|issue|#)\s*#?\s*(\d+(?:\.\d+)?)/i)?.[1]
    ?? label.match(/^(\d+(?:\.\d+)?)(?:\s|$|[:\-])/)?.[1];
  if (fromLabel !== undefined) return round(Number(fromLabel));

  let path = '';
  try { path = decodeURIComponent(new URL(url).pathname); } catch { return null; }
  const tail = path.split('/').filter(Boolean).pop() || '';
  // Madara writes 138.1 as chapter-138-1; a two-digit-or-less trailer is a decimal.
  const slug = tail.match(/(?:chapter|chap|ch|episode|ep|issue)[-_ ]?(\d+)(?:[-_.](\d{1,2}))?(?=$|[-_?.])/i)
    ?? path.match(/(?:chapter|chap|ch|episode|ep|issue)[-_/ ]?(\d+)(?:[-_.](\d{1,2}))?(?=\/|$)/i);
  if (slug) return round(Number(slug[2] ? `${slug[1]}.${slug[2]}` : slug[1]));
  return null;
}

function round(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : null;
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return ''; }
}

/**
 * Which of the accepted links belong to this series, not to a sidebar.
 *
 * Conservative: only narrows when at least three links pass a test, so a site
 * whose chapter URLs are opaque ids (`/read/82731`) keeps everything it had.
 */
export function scope<T extends { url: string }>(links: T[], seriesUrl: string): T[] {
  if (links.length < 4) return links;
  const seriesPath = pathOf(seriesUrl).replace(/\/+$/, '');
  if (seriesPath) {
    const under = links.filter((l) => pathOf(l.url).startsWith(`${seriesPath}/`));
    if (under.length >= 3) return under;
  }
  const slug = seriesPath.split('/').filter(Boolean).pop()?.toLowerCase() || '';
  if (slug.length >= 4) {
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The slug followed by a chapter token or the end of a segment -- so
    // "blue-lock" does not claim "blue-lock-episode-nagi-chapter-1" by prefix alone.
    const own = new RegExp(`(?:^|[/_-])${escaped}(?:/|[-_](?:chapter|chap|ch|episode|ep|issue)\\b|[-_]\\d)`, 'i');
    const named = links.filter((l) => own.test(pathOf(l.url)));
    if (named.length >= 3) return named;
  }
  return links;
}

/** How much a label looks like a chapter row rather than a button or a thumbnail. */
function labelQuality(raw: string, label: string, number: number | null): number {
  let q = 0;
  if (label) q += 1;
  if (number !== null) q += 2;
  if (CHAPTER_WORD.test(label)) q += 1;
  if (NAV_LABEL.test(raw)) q -= 3;
  return q;
}

/**
 * Chapters from a series page, in page order.
 *
 * `accept` is the runtime's own "is this a chapter link" test, given the same
 * `{url, text}` shape its scorer already takes.
 */
export function chaptersFromHtml(
  html: string,
  base: string,
  seriesUrl: string,
  accept: (link: HygieneLink) => boolean,
): HygieneChapter[] {
  type Row = { url: string; raw: string; label: string; number: number | null; quality: number; order: number };
  const best = new Map<string, Row>();
  let scanned = 0;
  let seq = 0;
  for (const match of html.matchAll(ANCHOR)) {
    if (++scanned > MAX_ANCHORS) break;
    const attrs = match[1] || '';
    const href = attrs.match(HREF);
    const url = href ? absolute(href[1] ?? href[2] ?? href[3] ?? '', base) : null;
    if (!url) continue;
    const inner = (match[2] || '').slice(0, MAX_INNER);
    const titleMatch = attrs.match(TITLE_ATTR);
    const titleAttr = titleMatch ? (titleMatch[1] ?? titleMatch[2] ?? '') : '';
    const raw = textOf(inner) || textOf(titleAttr);
    if (!accept({ url, text: raw.slice(0, 240) })) continue;
    const label = labelFrom(inner, titleAttr);
    const number = numberOf(label, url);
    const quality = labelQuality(raw, label, number);
    const order = seq++;
    const seen = best.get(url);
    // The better label wins *and* brings its position: a "First Chapter"
    // button sits above the list, and the row is where chapter 0 belongs.
    if (!seen || quality > seen.quality) best.set(url, { url, raw, label, number, quality, order });
  }

  const rows = scope([...best.values()].sort((a, b) => a.order - b.order), seriesUrl);
  return rows.slice(0, MAX_CHAPTERS).map((row) => ({
    url: row.url,
    text: row.label || (row.number !== null ? `Chapter ${row.number}` : ''),
    number: row.number,
  }));
}

/**
 * A Madara page whose chapter list is filled in by `/ajax/chapters/` after
 * load: the holder is there, the rows are not. The runtimes used to ask the
 * AJAX endpoint only when *zero* chapter links were found, and a page with a
 * "Read First / Read Last" pair or a sidebar never reached zero.
 */
export function madaraListIsDeferred(html: string, found: number): boolean {
  if (found < 3) return true;
  const holder = /id=["']manga-chapters-holder["']/i.test(html);
  const rows = (html.match(/class=["'][^"']*\bwp-manga-chapter\b/gi) || []).length;
  return holder && rows < Math.min(found, 3);
}
