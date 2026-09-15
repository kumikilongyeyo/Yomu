import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeCandidates,
  parseAidokuIndex,
  parseDateish,
  parseImageDimensions,
  parseMangaScraperModules
} from '../src/hunter.js';

test('MangaScraper registry parser keeps manga modules and ignores doujin modules', () => {
  const yaml = `
reader.example:
  className: Reader
  type: Manga
  test_sample:
    url: solo-leveling
adult.example:
  className: Adult
  type: Doujin
  test_sample:
    url: 123
other.example:
  className: Other
  type: Manga
  test_sample:
    url: tower-of-god
`;
  const rows = parseMangaScraperModules(yaml);
  assert.deepEqual(rows.map(x => x.baseUrl), [
    'https://reader.example/',
    'https://other.example/'
  ]);
  assert.equal(rows[0].sample, 'solo-leveling');
});

test('Aidoku registry parser prefers English/all-language sources by default', () => {
  const index = {
    sources: [
      { id: 'en.good', name: 'Good', baseURL: 'https://good.example', languages: ['en'] },
      { id: 'all.good', name: 'Global', baseURL: 'https://global.example', languages: ['all'] },
      { id: 'es.only', name: 'Spanish', baseURL: 'https://spanish.example', languages: ['es'] }
    ]
  };
  assert.deepEqual(parseAidokuIndex(index).map(x => x.name), ['Good', 'Global']);
  assert.equal(parseAidokuIndex(index, { allLanguages: true }).length, 3);
});

test('candidate merger collapses equivalent hosts and preserves multi-ecosystem evidence', () => {
  const rows = [
    { name: 'Example A', baseUrl: 'https://www.example.org/', ecosystem: 'manga-scraper', repo: 'a', sample: 'x' },
    { name: 'Example B', baseUrl: 'https://example.org/', ecosystem: 'aidoku-community', repo: 'b', sourceId: 'en.example', languages: ['en'] }
  ];
  const merged = mergeCandidates(rows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].host, 'example.org');
  assert.equal(merged[0].evidence.length, 2);
  assert.ok(merged[0].score >= 70);
});

test('freshness date parser handles relative and ISO-like chapter dates', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  assert.equal(parseDateish('2 days ago', now)?.toISOString(), '2026-09-13T12:00:00.000Z');
  assert.equal(parseDateish('Updated 2026-09-14', now)?.toISOString(), '2026-09-14T00:00:00.000Z');
  assert.equal(parseDateish('yesterday', now)?.toISOString(), '2026-09-14T12:00:00.000Z');
});

test('image dimension parser reads a PNG IHDR header without downloading a whole image', () => {
  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0);
  png.writeUInt32BE(1200, 16);
  png.writeUInt32BE(1800, 20);
  assert.deepEqual(parseImageDimensions(png, 'image/png'), {
    width: 1200,
    height: 1800,
    format: 'png'
  });
});
