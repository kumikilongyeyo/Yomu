/**
 * The canonical title address, resolved on the server.
 *
 * `/title/<slug>?q=<name>&al=<anilistId>` has to be a *valid* destination
 * before any script runs, because cmd-click, middle-click, copy-link, a
 * bookmark and a restored session all follow the href and never reach a click
 * handler. These are the pure parts of that route: the slug, the id
 * vocabulary, which search result is the title asked for, and which provider
 * the redirect points at. The redirect itself is exercised against a running
 * Worker.
 *
 * worker/title.ts is TypeScript, so the assertions here are against the
 * client's copy of the same two rules plus a source-level check that the two
 * files still agree. They are deliberately duplicated across the wire -- the
 * browser knows which sources the device enabled and the Worker does not --
 * and a drift between them is a routing bug, so it is asserted rather than
 * hoped for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { canonicalHref, slugify, appSourceId, BAKED_BLIND } =
  await import('../../dist-app/yomu-open-title.js');

const worker = fs.readFileSync(new URL('../../worker/title.ts', import.meta.url), 'utf8');

test('a title has an address that works without JavaScript', () => {
  assert.equal(
    canonicalHref({ title: 'Solo Leveling', anilistId: 105398 }),
    '/title/solo-leveling?q=Solo+Leveling&al=105398',
  );
  assert.equal(
    canonicalHref({ title: 'Berserk' }),
    '/title/berserk?q=Berserk',
    'no AniList id is fine; the name still identifies it',
  );
  assert.match(canonicalHref({ title: 'Komi Can’t Communicate' }), /^\/title\/komi-cant-communicate\?/);
  assert.equal(canonicalHref({ title: '' }), '/', 'nothing to point at is the front page, not a broken link');
  assert.equal(canonicalHref(null), '/');
});

test('the exact name travels beside the slug, because the slug loses punctuation', () => {
  const href = canonicalHref({ title: "I'm the Max-Level Newbie" });
  assert.match(href, /^\/title\/im-the-max-level-newbie\?/, 'the slug is readable');
  const query = new URLSearchParams(href.split('?')[1]);
  assert.equal(query.get('q'), "I'm the Max-Level Newbie", 'and the searchable name is intact');
});

test('slugs are safe to put in a path', () => {
  for (const name of ['Solo Leveling', 'Re:Zero − Starting Life', '86—EIGHTY-SIX', '  spaced  out  ', 'Ω/x?y#z']) {
    const slug = slugify(name);
    assert.match(slug, /^[a-z0-9-]*$/, `${name} -> ${slug}`);
    assert.equal(slug, slug.replace(/^-+|-+$/g, ''), 'no leading or trailing dashes');
    assert.ok(slug.length <= 80);
    assert.equal(encodeURIComponent(slug), slug, 'needs no escaping');
  }
});

test('an unnameable title still produces a usable path', () => {
  /* A purely non-Latin name slugs to nothing. The path must stay well-formed
     and let `q` do the identifying. */
  const href = canonicalHref({ title: '進撃の巨人' });
  assert.match(href, /^\/title\/title\?/, 'a placeholder segment rather than /title/?q=');
  assert.equal(new URLSearchParams(href.split('?')[1]).get('q'), '進撃の巨人');
});

test('the Worker and the browser spell provider ids the same way', () => {
  /* Both files map catalog provider ids to the app's source ids. If they ever
     disagree, a server-resolved link opens a source the app cannot address. */
  assert.equal(appSourceId('ext:weebcentral'), 'yomuext-weebcentral');
  assert.equal(appSourceId('suwayomi:14'), 'mihon-14');
  assert.match(worker, /id\.startsWith\('ext:'\)\s*\)\s*return 'yomuext-' \+ id\.slice\(4\)/);
  assert.match(worker, /id\.startsWith\('suwayomi:'\)\s*\)\s*return 'mihon-' \+ id\.slice\(9\)/);
});

test('the Worker will not redirect to a source that cannot serve pages', () => {
  /* The client bakes 'yomuext-comick'; the Worker sees catalog ids, so it
     bakes 'comick'. Same provider, two vocabularies -- assert the pair rather
     than trusting that whoever edits one remembers the other. */
  assert.ok(BAKED_BLIND.includes('yomuext-comick'));
  assert.match(worker, /const BLIND = new Set\(\['comick'\]\)/);
  for (const id of BAKED_BLIND) {
    const catalogId = id.replace(/^yomuext-/, '');
    assert.ok(worker.includes(`'${catalogId}'`), `the Worker also knows ${catalogId} is metadata-only`);
  }
});

test('the route falls through to Search rather than to an error', () => {
  /* A name the catalog does not carry is a real answer: Search is where a
     reader turns a name into a source they can add. What matters is that it
     is reached deliberately, not because the href was wrong all along. */
  assert.match(worker, /const search = '\/search\?q=' \+ encodeURIComponent\(name\)/);
  assert.match(worker, /return redirect\(search, 'no-store'\)/);
  assert.match(worker, /status: 302/, 'temporary: the binding can change when sources do');
});
