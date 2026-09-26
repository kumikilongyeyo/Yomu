/**
 * A failed chapter page, retried through a different door.
 *
 * The reader's own handler marks a broken page failed and prints "This page
 * could not be loaded." There is no retry, so one dead image is a chapter you
 * cannot finish. What is testable here is the ladder: given the URL that
 * failed and how many times this image has already been rescued, what to try
 * next -- and, just as importantly, when to stop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { nextAttempt, upstreamOf, MAX_TRIES } = await import('../../dist-app/yomu-page-rescue.js');

const UPSTREAM = 'https://cdn.example.com/chapters/18.jpg';
const extPage = `https://yomu.test/api/ext/image?ext=weeb&u=${encodeURIComponent(UPSTREAM)}`;
const imgPage = `https://yomu.test/api/img?u=${encodeURIComponent(UPSTREAM)}`;

test('the first try is the same door, without the cached answer', () => {
  const first = nextAttempt(extPage, 0);
  const url = new URL(first);
  assert.equal(url.pathname, '/api/ext/image', 'same proxy');
  assert.equal(url.searchParams.get('u'), UPSTREAM, 'same upstream');
  assert.equal(url.searchParams.get('yomuRetry'), '1', 'but not the same request');
});

test('the second try is a genuinely different door', () => {
  /* Repeating the request that just failed is not a retry strategy. The
     general proxy has its own allowlist, its own Referer -- the image's own
     origin, which is what a hotlink check is looking at -- and a thirty-day
     edge cache. */
  const second = nextAttempt(extPage, 1);
  const url = new URL(second);
  assert.equal(url.pathname, '/api/img');
  assert.equal(url.searchParams.get('u'), UPSTREAM, 'the upstream is carried across, not re-derived');
  assert.notEqual(new URL(extPage).pathname, url.pathname);
});

test('there is no third try', () => {
  assert.equal(MAX_TRIES, 2);
  assert.equal(nextAttempt(extPage, 2), null);
  assert.equal(nextAttempt(extPage, 9), null,
    'a page that has refused twice gets the reader\'s own message, not a spinner');
});

test('the general proxy is not asked twice', () => {
  /* /api/img has already declined this host; sending it there again is the
     same request with a different query string. */
  assert.equal(nextAttempt(imgPage, 1), null);
  assert.match(nextAttempt(imgPage, 0), /yomuRetry=1/, 'though one plain retry is still worth it');
});

test('a page this origin did not proxy is left alone entirely', () => {
  /* Every chapter image goes out through /api/. Anything else is furniture,
     or a relative string that resolved against the reader's own path, and
     retrying it is a request nobody asked for. */
  assert.equal(nextAttempt('https://cdn.example.com/raw.jpg', 0), null);
  assert.equal(nextAttempt('https://cdn.example.com/raw.jpg', 1), null);
  assert.equal(upstreamOf('https://cdn.example.com/raw.jpg'), null);
  assert.equal(nextAttempt('https://yomu.test/brand/logo.svg', 0), null, 'same origin, not a page');
});

test('nothing is lifted out of a URL that is not ours', () => {
  /* upstreamOf feeds a URL to a fetching proxy. It only ever reads one off
     this origin's own proxy paths. */
  assert.equal(upstreamOf(`https://evil.test/api/img?u=${encodeURIComponent(UPSTREAM)}`), null);
  assert.equal(upstreamOf('https://yomu.test/api/other?u=' + encodeURIComponent(UPSTREAM)), null);
  assert.equal(upstreamOf('https://yomu.test/api/img'), null, 'no u= at all');
  assert.equal(upstreamOf(`https://yomu.test/api/img?u=${encodeURIComponent('file:///etc/passwd')}`), null,
    'a non-http scheme is never handed onward');
  assert.equal(upstreamOf(`https://yomu.test/api/img?u=${encodeURIComponent('javascript:alert(1)')}`), null);
});

test('a real upstream survives the round trip intact', () => {
  const messy = 'https://cdn.example.com/a b/ch?page=18&t=1#frag';
  const proxied = `https://yomu.test/api/ext/image?ext=weeb&u=${encodeURIComponent(messy)}`;
  assert.equal(upstreamOf(proxied), new URL(messy).toString());
  const second = new URL(nextAttempt(proxied, 1));
  assert.equal(second.searchParams.get('u'), new URL(messy).toString());
});

test('garbage in is null out, not a throw', () => {
  for (const bad of ['', null, undefined, 'not a url', '::::', '/read/x']) {
    assert.equal(nextAttempt(bad, 0), null, String(bad));
  }
  assert.equal(upstreamOf(''), null);
});

/* --- the third door: the same page from another source ---------------------- */

const { pickAlternate } = await import('../../dist-app/yomu-page-rescue.js');

const alt = (providerId, n) => ({ providerId, providerName: providerId, pages: Array.from({ length: n }, (_, i) => ({ index: i, url: `https://yomu.test/api/img?u=${providerId}-${i}` })) });

test('the third door takes the same page index from the first matching copy', () => {
  const pick = pickAlternate([alt('ext:flame', 20), alt('ext:weeb', 20)], 17, 0);
  assert.equal(pick.providerId, 'ext:flame');
  assert.match(pick.url, /ext:flame-17$/);
});

test('a second failure on the third door moves to the next copy, then stops', () => {
  const copies = [alt('ext:flame', 20), alt('ext:weeb', 20)];
  assert.equal(pickAlternate(copies, 3, 1).providerId, 'ext:weeb');
  assert.equal(pickAlternate(copies, 3, 2), null);
});

test('no copies, or a copy without that page, is no answer rather than a wrong page', () => {
  assert.equal(pickAlternate([], 0, 0), null);
  assert.equal(pickAlternate(undefined, 0, 0), null);
  assert.equal(pickAlternate([alt('ext:short', 5)], 12, 0), null);
});
