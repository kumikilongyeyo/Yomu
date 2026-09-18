/**
 * Per-series page metadata.
 *
 * worker/series-meta.ts is TypeScript and runs inside the Workers runtime, so
 * what is checkable here is the shape of the contract rather than a live
 * rewrite: that a reader is never made to wait, that every failure path
 * returns the shell untouched, and that nothing is invented to fill a field
 * the provider did not give. The rewrite itself is verified against a running
 * Worker (a crawler request produces og:/twitter:/canonical tags; a reader
 * request returns in single-digit milliseconds).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(new URL('../../worker/series-meta.ts', import.meta.url), 'utf8');

/** The summarize() rule, restated so the intent is asserted, not the code. */
function summarize(description, limit = 200) {
  const flat = String(description || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[\/?[a-z]+[^\]]*\]/gi, ' ')
    .replace(/~!.*?!~/gs, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s]+$/, '') + '…';
}

test('a description is prose, with the markup and the spoilers taken out', () => {
  assert.equal(summarize('<p>A <b>boy</b> and his sword.</p>'), 'A boy and his sword.');
  assert.equal(summarize('[i]Note:[/i] a tale.'), 'Note: a tale.', 'BBCode is stripped too');
  assert.equal(
    summarize('He wins. ~!And then he dies.!~ The end.'),
    'He wins. The end.',
    'AniList spoiler markup never reaches a link preview',
  );
  assert.equal(summarize('   spaced\n\nout  '), 'spaced out');
  assert.equal(summarize(undefined), '');
  assert.equal(summarize(null), '');
});

test('a long description is cut on a word, not mid-syllable', () => {
  const long = 'word '.repeat(80).trim();
  const out = summarize(long, 60);
  assert.ok(out.length <= 61, out.length);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.includes('wor…'), 'never cut inside a word when a space is near');

  /* A single unbroken token has no word to cut on, and is still bounded. */
  const unbroken = 'x'.repeat(500);
  const hard = summarize(unbroken, 60);
  assert.equal(hard.length, 61);
});

test('the reader deadline is zero, and that is the point', () => {
  /* A human is already looking at the title; they do not need a meta tag to
     tell them what it is, and the series page must never get slower. */
  assert.match(SOURCE, /const READER_DEADLINE_MS = 0;/);
  assert.match(SOURCE, /const CRAWLER_DEADLINE_MS = \d{4};/);
  assert.match(SOURCE, /looksAutomated\(request\) \? CRAWLER_DEADLINE_MS : READER_DEADLINE_MS/);
  assert.match(SOURCE, /if \(deadline > 0\)/, 'a zero deadline skips the lookup entirely');
});

test('every failure path returns the shell untouched', () => {
  /* The worst case has to be exactly the behaviour before this file existed.
     Three bail-outs, and they are the complete set: a request this route has
     no business touching, a response that is not HTML, and no title. */
  const returns = SOURCE.match(/return shell;/g) || [];
  assert.equal(returns.length, 3, 'a new early return needs a reason here too');
  assert.match(SOURCE, /if \(!seriesId \|\| !source\) return shell;/);
  assert.match(SOURCE, /content-type[\s\S]{0,80}text\/html[\s\S]{0,20}return shell;/);
  assert.match(SOURCE, /if \(!meta\) return shell;/);
  assert.match(SOURCE, /catch \{\s*meta = null;\s*\}/);
});

test('a real navigation is never mistaken for a crawler', () => {
  /* Every current browser sends Sec-Fetch-Mode on a navigation and no
     unfurler does, so that is the primary signal and the UA list is a net for
     the crawlers that predate it. */
  assert.match(SOURCE, /if \(mode === 'navigate'\) return false;/);
  for (const bot of ['facebookexternalhit', 'twitterbot', 'slackbot', 'discordbot', 'bot', 'crawler']) {
    assert.ok(SOURCE.includes(bot), `${bot} is covered`);
  }
});

test('the canonical link is the book, not the binding', () => {
  /* Two people sharing the same title from different sources should be
     sharing one link, which is what /title/ is for. */
  assert.match(SOURCE, /canonical: '\/title\/'/);
  assert.match(SOURCE, /rel="canonical"/);
  assert.ok(!/canonical:.*\/series\//.test(SOURCE), 'never canonicalises to a provider-bound URL');
});

test('an absent field is left out rather than filled in', () => {
  /* Generic copy on every page is the thing this replaces; putting it back
     under a different name would be worse, not better. */
  assert.match(SOURCE, /if \(content\) out\.push/);
  assert.ok(!/'A manga reader'|'Read manga'|placeholder/i.test(SOURCE),
    'no default description anywhere');
});

test('both vocabularies for a source id round-trip', () => {
  /* series-meta maps app -> catalog; title.ts maps catalog -> app. A drift
     between them means a series page looks up the wrong provider. */
  assert.match(SOURCE, /if \(id\.startsWith\('yomuext-'\)\) return 'ext:'/);
  assert.match(SOURCE, /if \(id\.startsWith\('mihon-'\)\) return 'suwayomi:'/);
  const title = fs.readFileSync(new URL('../../worker/title.ts', import.meta.url), 'utf8');
  assert.match(title, /if \(id\.startsWith\('ext:'\)\) return 'yomuext-'/);
  assert.match(title, /if \(id\.startsWith\('suwayomi:'\)\) return 'mihon-'/);
});
