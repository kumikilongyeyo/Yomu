import test from 'node:test';
import assert from 'node:assert/strict';
import { detectChapterStrategies, detectPageStrategies, detectSeriesStrategies, detectCatalogStrategies, extractChapters, extractPages } from '../src/heuristics.js';

const series=`<html><head><meta property="og:image" content="/cover.jpg"><meta name="description" content="A test comic"></head><body><h1>Beast Reader</h1><div class="chapter-list"><div class="chapter-item"><a href="/chapter-3">Chapter 3</a></div><div class="chapter-item"><a href="/chapter-2">Chapter 2</a></div><div class="chapter-item"><a href="/chapter-1">Chapter 1</a></div></div></body></html>`;
const reader=`<html><body><header><img src="/logo.png"></header><main class="reading-content"><img data-src="/p1.webp"><img data-src="/p2.webp"><img data-src="/p3.webp"></main></body></html>`;

test('finds strong chapter selector',()=>{const s=detectChapterStrategies(series,'https://example.com/manga/x');assert.ok(s.length);const rows=extractChapters(series,'https://example.com/manga/x',s[0]);assert.equal(rows.length,3);assert.match(rows[0].url,/chapter-/)});
test('finds reader images without site chrome',()=>{const s=detectPageStrategies(reader,'https://example.com/chapter-1');assert.ok(s.length);const pages=extractPages(reader,'https://example.com/chapter-1',s[0]);assert.ok(pages.length>=3);assert.ok(!pages.some(x=>x.includes('logo.png')))});
test('finds series fields',()=>{const s=detectSeriesStrategies(series,'https://example.com/manga/x');assert.equal(s.title[0].selector,'h1');assert.ok(s.cover.length);assert.ok(s.description.length)});

const catalog=`<main><article class="series-card"><a href="/manga/a"><img src="/a.jpg"><h3>A</h3></a></article><article class="series-card"><a href="/manga/b"><img src="/b.jpg"><h3>B</h3></a></article><article class="series-card"><a href="/manga/c"><img src="/c.jpg"><h3>C</h3></a></article><article class="series-card"><a href="/manga/d"><img src="/d.jpg"><h3>D</h3></a></article></main>`;
test('finds repeatable catalog cards',()=>{const s=detectCatalogStrategies(catalog,'https://example.com');assert.ok(s.length);assert.ok(s[0].count>=4);assert.ok(s[0].score>=60)});
