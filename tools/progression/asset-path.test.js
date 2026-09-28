/**
 * Chapter ids with a slash in them, through the asset server (worker/asset-path.ts).
 *
 * `canonical` copies the asset server's path rule from miniflare's
 * assets.worker.js (decodePath / encodePath and the redirect test beside
 * them): each segment decoded, the result split on "/" again, each piece
 * re-encoded, and a 307 whenever that differs from what was asked for.
 * Node 24 strips the types, so this imports the real module.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAsset, slashSafeAssetPath } from '../../worker/asset-path.ts';

const decodePath = (p) => p.split('/').map((x) => { try { return decodeURIComponent(x); } catch { return x; } }).join('/').replace(/\/+/g, '/');
const encodePath = (p) => p.split('/').map((x) => { try { return encodeURIComponent(x); } catch { return x; } }).join('/');
const canonical = (p) => encodePath(decodePath(p));

const ORIGIN = 'https://yomu.test';
const SHELL = '<!doctype html><title>Yomu</title>';
const FLAME = '/read/' + encodeURIComponent('1:1/385fe46707bd150c');
const ASURA = '/read/' + encodeURIComponent('solo-leveling:solo-leveling/chapters/7a3c9e2e-8f0e-4a55-9d1e-0c5a3b2f1d10');

/** The asset server, as far as these routes go: no file matches, so the SPA shell -- after the redirect rule. */
function assetServer() {
  const asked = [];
  return {
    asked,
    async fetch(request) {
      const url = new URL(request.url);
      asked.push(url.pathname);
      const to = canonical(url.pathname);
      if (to !== url.pathname) return new Response(null, { status: 307, headers: { location: to + url.search } });
      return new Response(SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
    },
  };
}

test('the bug: the asset server turns an id slash into a path separator', () => {
  assert.equal(canonical(FLAME), '/read/1%3A1/385fe46707bd150c');
  assert.equal(canonical(FLAME).split('/').length, 4, 'three segments, which no route matches');
});

test('the shell is asked for under a spelling the asset server leaves alone', () => {
  for (const path of [FLAME, ASURA, '/read/1:1%2F385fe46707bd150c', '/read/1%3a1%2f385fe46707bd150c', '/series/a%2Fb']) {
    const safe = slashSafeAssetPath(path);
    assert.ok(safe, path);
    assert.equal(canonical(safe), safe, `${path} -> ${safe} would still be redirected`);
    assert.equal(safe.split('/').length, 3, `${safe} is still one id segment`);
    /* The id the asset server sees, once decoded, still has its slash inside one segment. */
    assert.equal(decodeURIComponent(decodeURIComponent(safe.split('/')[2])), decodeURIComponent(path.split('/')[2]));
  }
  assert.equal(slashSafeAssetPath(FLAME), '/read/1%3A1%252F385fe46707bd150c');
});

test('every other address is untouched', () => {
  for (const path of ['/', '/read/abc', '/read/1%3A1', '/read/1:1', '/series/01J76XYCPSY3C4BNPBRY8JMCBE', '/sources',
    '/_expo/static/js%2Fweb/entry.js', '/api/catalog/chapters%2Fx', '/shelf/a%2Fb']) {
    assert.equal(slashSafeAssetPath(path), null, path);
  }
});

test('a segment that does not decode is left as the asset server leaves it', () => {
  assert.equal(slashSafeAssetPath('/read/a%2Fb%E0%A4%A'), null);
});

test('fetchAsset: a slash-id reader address gets the shell, not a redirect', async () => {
  const assets = assetServer();
  const response = await fetchAsset(assets, new Request(ORIGIN + FLAME + '?source=yomuext-flamecomics'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), SHELL);
  assert.deepEqual(assets.asked, ['/read/1%3A1%252F385fe46707bd150c']);

  const plain = assetServer();
  assert.equal((await fetchAsset(plain, new Request(ORIGIN + '/read/1%3A1?source=x'))).status, 200);
  assert.deepEqual(plain.asked, ['/read/1%3A1'], 'no slash: the request goes through as it is');
});

test('fetchAsset: the query string and the request itself go along', async () => {
  let seen = null;
  const assets = { async fetch(request) { seen = request; return new Response(SHELL, { status: 200 }); } };
  await fetchAsset(assets, new Request(ORIGIN + ASURA + '?source=yomuext-asurascans', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } }));
  assert.equal(new URL(seen.url).search, '?source=yomuext-asurascans');
  assert.equal(seen.headers.get('sec-fetch-mode'), 'navigate');
  assert.equal(seen.method, 'GET');
});

test('fetchAsset: never hands the browser a redirect to the stand-in spelling', async () => {
  const asked = [];
  const assets = {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      asked.push(pathname);
      return new Response(null, { status: 307, headers: { location: pathname.includes('%25') ? '/stand-in' : '/original' } });
    },
  };
  const response = await fetchAsset(assets, new Request(ORIGIN + FLAME));
  assert.equal(response.headers.get('location'), '/original');
  assert.equal(asked.length, 2);
});

test('fetchAsset: only reads are rewritten', async () => {
  const assets = assetServer();
  await fetchAsset(assets, new Request(ORIGIN + FLAME, { method: 'POST', body: 'x' }));
  assert.deepEqual(assets.asked, [FLAME]);
});

test('the Worker serves /read/ and /series/ through fetchAsset', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../../worker/index.ts', import.meta.url), 'utf8');
  assert.match(source, /withSeriesMeta\(await fetchAsset\(env\.ASSETS, request\)/);
  assert.match(source, /if \(!url\.pathname\.startsWith\('\/api\/'\)\) return fetchAsset\(env\.ASSETS, request\);/);
  /* The one direct call left is the shelf rewrite, whose path is fixed. */
  assert.deepEqual(source.match(/env\.ASSETS\.fetch\([^;]*/g), ["env.ASSETS.fetch(new Request(new URL('/shelf', url.origin).href, request))"]);
});
