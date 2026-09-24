/**
 * Chapter lists from adaptive sources (worker/chapter-hygiene.ts).
 *
 * The fixtures copy the markup of the two real pages the bugs were measured
 * on, 2026-09-24: a Madara series page (mangaread.org, with its "latest
 * updates" sidebar) and a MangaThemesia one (rizzfables.com, with the date
 * inside the chapter anchor and First/New Chapter buttons above the list).
 * Node 24 strips the types, so this imports the real module.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chaptersFromHtml, madaraListIsDeferred, numberOf, scope, tidy } from '../../worker/chapter-hygiene.ts';

const chapterish = (link) => /chapter|episode/i.test(`${link.url} ${link.text}`);

function madaraPage(slug, count, { sidebar = true } = {}) {
  const rows = [];
  for (let n = count; n >= 1; n--) {
    rows.push(`<li class="wp-manga-chapter"><a href="https://site.test/manga/${slug}/chapter-${n}/">Chapter ${n} </a>
      <span class="chapter-release-date"><i>2 days ago</i></span></li>`);
  }
  const side = sidebar
    ? ['the-crown-prince', 'veteran-soldier', 'weapon-replicator'].map((s) =>
        `<div class="popular-item"><a href="https://site.test/manga/${s}/chapter-124/">Chapter 124</a>
         <a href="https://site.test/manga/${s}/chapter-123/">Chapter 123</a></div>`).join('')
    : '';
  return `<div class="c-page"><ul class="main version-chap">${rows.join('')}</ul></div><div class="sidebar">${side}</div>`;
}

function themesiaPage(slug, count) {
  const row = (n, date) => `<li data-num="${n}"><div class="chbox"><div class="eph-num">
    <a href="https://site.test/chapter/${slug}-chapter-${n}">
      <span class="chapternum">Chapter
        ${n} <i class="epn-name"> </i></span>
      <span class="chapterdate">${date}</span></a></div></div></li>`;
  const buttons = `<div class="lastend">
    <div class="inepcx"><a href="https://site.test/chapter/${slug}-chapter-0"><span>First Chapter</span><span class="epcur epcurfirst">Chapter 0</span></a></div>
    <div class="inepcx"><a href="https://site.test/chapter/${slug}-chapter-${count}"><span>New Chapter</span><span class="epcur epcurlast">Chapter ${count}</span></a></div></div>`;
  const rows = [];
  for (let n = count; n >= 0; n--) rows.push(row(n, `${(n % 27) + 1} Jul 2025`));
  const popular = `<div class="serieslist pop"><ul>
    <li><a class="series" href="https://site.test/chapter/transcension-academy-chapter-170">Transcension Academy Chapter 170 9.9</a></li>
    <li><a class="series" href="https://site.test/chapter/infinite-level-up-chapter-245">Infinite Level up in Murim Chapter 245 9.9</a></li>
    <li><a class="series" href="https://site.test/chapter/counts-son-chapter-115">The Count's Youngest Son Chapter 115 9.8</a></li></ul></div>`;
  return `${buttons}<div class="eplister" id="chapterlist"><ul>${rows.join('')}</ul></div>${popular}`;
}

test('a Madara sidebar does not add other series to the list', () => {
  const url = 'https://site.test/manga/blue-lock/';
  const rows = chaptersFromHtml(madaraPage('blue-lock', 40), url, url, chapterish);
  assert.equal(rows.length, 40);
  assert.ok(rows.every((r) => r.url.includes('/manga/blue-lock/')));
  assert.equal(rows[0].text, 'Chapter 40');
  assert.equal(rows[0].number, 40);
  assert.equal(rows.at(-1).number, 1);
});

test('a long title is not cut at 650', () => {
  const url = 'https://site.test/manga/martial-peak/';
  const rows = chaptersFromHtml(madaraPage('martial-peak', 3864), url, url, chapterish);
  assert.equal(rows.length, 3864);
  assert.equal(rows.at(-1).text, 'Chapter 1');
});

test('MangaThemesia rows lose their dates, buttons and the popular widget', () => {
  const url = 'https://site.test/series/absolute-dominion';
  const rows = chaptersFromHtml(themesiaPage('absolute-dominion', 53), url, url, chapterish);
  assert.equal(rows.length, 54, 'chapters 53..0, each once');
  assert.deepEqual(rows.slice(0, 3).map((r) => r.text), ['Chapter 53', 'Chapter 52', 'Chapter 51']);
  assert.ok(rows.every((r) => !/Jul|First|New|9\.\d/.test(r.text)), 'no dates, button labels or scores');
  assert.ok(rows.every((r) => r.url.includes('absolute-dominion-chapter-')));
});

test('chapter 0 is chapter 0, and sits where the list puts it', () => {
  const url = 'https://site.test/series/absolute-dominion';
  const rows = chaptersFromHtml(themesiaPage('absolute-dominion', 53), url, url, chapterish);
  const zero = rows.find((r) => r.url.endsWith('-chapter-0'));
  assert.equal(zero.number, 0);
  assert.equal(zero.text, 'Chapter 0');
  assert.equal(rows.at(-1), zero, 'the row, not the First Chapter button above the list');
});

test('opaque chapter URLs are left alone rather than scoped to nothing', () => {
  const html = Array.from({ length: 12 }, (_, i) => `<a href="/read/${9000 + i}">Chapter ${12 - i}</a>`).join('');
  const rows = chaptersFromHtml(html, 'https://site.test/', 'https://site.test/title/82731', chapterish);
  assert.equal(rows.length, 12);
});

test('a spin-off whose slug extends this one is not claimed by prefix', () => {
  const own = Array.from({ length: 5 }, (_, i) => ({ url: `https://s.test/c/blue-lock-chapter-${i + 1}` }));
  const spin = Array.from({ length: 3 }, (_, i) => ({ url: `https://s.test/c/blue-lock-episode-nagi-chapter-${i + 1}` }));
  // "blue-lock-episode" is followed by a chapter token too, so this is the
  // limit of what a slug can tell; the path-prefix test is what real sites hit.
  const kept = scope([...own, ...spin], 'https://s.test/series/blue-lock');
  assert.ok(kept.length >= own.length);
  const prefixed = scope(
    [...Array.from({ length: 4 }, (_, i) => ({ url: `https://s.test/manga/blue-lock/chapter-${i}` })),
     ...Array.from({ length: 4 }, (_, i) => ({ url: `https://s.test/manga/blue-lock-episode-nagi/chapter-${i}` }))],
    'https://s.test/manga/blue-lock/');
  assert.equal(prefixed.length, 4);
});

test('tidy keeps real subtitles and volumes, drops the noise', () => {
  assert.equal(tidy('Chapter 551 - Yonkou Whitebeard'), 'Chapter 551 - Yonkou Whitebeard');
  assert.equal(tidy('Vol. 2 Chapter 12'), 'Vol. 2 Chapter 12');
  assert.equal(tidy('Blue Lock Chapter 12'), 'Chapter 12');
  assert.equal(tidy('Chapter 52 25 Jul 2025'), 'Chapter 52');
  assert.equal(tidy('Chapter 7 September 3, 2025 1.2k views'), 'Chapter 7');
  assert.equal(tidy('Chapter 9 NEW'), 'Chapter 9');
  assert.equal(tidy('Chapter 3 2 hours ago'), 'Chapter 3');
  assert.equal(tidy('First Chapter Chapter 0'), 'Chapter 0');
  assert.equal(tidy('Episode 0 - Prologue'), 'Episode 0 - Prologue');
});

test('numbers come from the label, then the URL; decimals survive', () => {
  assert.equal(numberOf('Chapter 12.5', 'https://s.test/x'), 12.5);
  assert.equal(numberOf('Chapter 0', 'https://s.test/x'), 0);
  assert.equal(numberOf('', 'https://s.test/manga/x/chapter-138-1/'), 138.1);
  assert.equal(numberOf('', 'https://s.test/chapter/absolute-dominion-chapter-53'), 53);
  assert.equal(numberOf('The Return', 'https://s.test/read/82731'), null);
});

test('a Madara page whose list is filled by AJAX is recognised as deferred', () => {
  const holderOnly = '<div id="manga-chapters-holder" data-id="123"></div><a href="/manga/x/chapter-1/">Read First</a><a href="/manga/x/chapter-90/">Read Last</a>';
  assert.equal(madaraListIsDeferred(holderOnly, 2), true);
  assert.equal(madaraListIsDeferred(madaraPage('x', 40, { sidebar: false }), 40), false);
});
