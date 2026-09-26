/**
 * A title card for a series you are reading says where you are.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/* A just-enough DOM: the card renderer only builds elements and sets text. */
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attrs = {}; this.style = {}; this.className = ''; this.textContent = ''; }
  append(...kids) { this.children.push(...kids.map((k) => (typeof k === 'string' ? Object.assign(new Node('#text'), { textContent: k }) : k))); }
  prepend(...kids) { this.children.unshift(...kids); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener() {}
  querySelector() { return null; }
  remove() {}
  get classList() { const self = this; return { add: (c) => { self.className += ' ' + c; } }; }
  find(cls) { if (String(this.className).split(/\s+/).includes(cls)) return this; for (const c of this.children) { const f = c.find?.(cls); if (f) return f; } return null; }
}

function loadCards(storage) {
  const window = {
    localStorage: { getItem: (k) => (k in storage ? JSON.stringify(storage[k]) : null), setItem() {} },
    document: { createElement: (t) => new Node(t), createTextNode: (t) => Object.assign(new Node('#text'), { textContent: t }), addEventListener() {}, querySelector: () => null, readyState: 'complete' },
    addEventListener() {}, console, Date, Math, JSON, Number, String, Array, Object, Map, Set, RegExp,
  };
  window.window = window;
  vm.runInContext(fs.readFileSync(new URL('../../dist-app/yomu-titlecard.js', import.meta.url), 'utf8'), vm.createContext(window));
  return window.YomuTitleCard;
}

const note = (card) => card.find('yt-card__note')?.textContent || '';

test('a series in the reading index shows its chapter, matched by source and id', () => {
  const cards = loadCards({ 'yomu.v1.reading': { 'yomuext-asura:solo-1': { title: 'Solo Leveling', chapterLabel: 'Chapter 87', at: 1 } } });
  const card = cards.create({ title: 'Solo Leveling', category: 'manhwa', status: 'completed', providers: [{ id: 'yomuext-asura', seriesId: 'solo-1', name: 'Asura' }] });
  assert.equal(card.dataset.ytReading, '87');
  assert.match(note(card), /^Ch\. 87 · Manhwa · Completed$/);
  assert.equal(card.find('yt-card__progress'), null, 'no total known, so no bar');
});

test('matched by title when the card came from a different source', () => {
  const cards = loadCards({
    'yomu.v1.reading': { 'yomuext-flame:x': { title: 'Solo  Leveling', chapterLabel: 'Ch. 41', at: 1 } },
    'yomu.v1.collection': { library: [{ title: 'Solo Leveling', total: 200 }] },
  });
  const card = cards.create({ title: 'Solo Leveling', providers: [{ id: 'mangadex', seriesId: 'md-1', name: 'MangaDex' }] });
  assert.match(note(card), /^Ch\. 41 \/ 200/);
  const bar = card.find('yt-card__progress');
  assert.ok(bar, 'a known total draws the bar');
  assert.equal(bar.children[0].style.width, '21%');
});

test('a series you are not reading looks exactly as before', () => {
  const cards = loadCards({ 'yomu.v1.reading': { 'a:b': { title: 'Something Else', chapterLabel: 'Chapter 3' } } });
  const card = cards.create({ title: 'Omniscient Reader', category: 'manhwa', status: 'ongoing' });
  assert.equal(card.dataset.ytReading, undefined);
  assert.equal(note(card), 'Manhwa · Ongoing');
});

test('an explicit note still wins', () => {
  const cards = loadCards({ 'yomu.v1.reading': { 'a:b': { title: 'X', chapterLabel: 'Chapter 3' } } });
  assert.equal(note(cards.create({ title: 'X' }, { note: '1,200 readers' })), '1,200 readers');
});
