/**
 * The Circle rules that badges and stickers added: a reaction is gated the
 * way a like is, a badge rides on the member and never the comment, and an
 * unread count is taken behind the gate.
 *
 * circle.ts is a Worker module. Node strips the types, the one import is
 * stubbed, and the exports are collected by hand -- so the file under test
 * is the shipped one, not a copy of its logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const circle = (() => {
  const source = fs.readFileSync(new URL('../../worker/circle.ts', import.meta.url), 'utf8');
  let js = stripTypeScriptTypes(source);
  js = js.replace(/import \{ generateCode \} from '\.\/sync';/, "const generateCode = () => 'ABCDEFGHJK';");
  js = js.replace(/^export (async function|function|const|let)/gm, '$1');
  js = js.replace(/^export \{[^}]*\};?$/gm, '');
  js += '\nreturn { gate, react, setBadge, unreadCount, publicComment, sanitiseBadge, sanitiseSticker, reactionSummary, recordProgress, reachedIn, raceView, RACE_WEEK_MS };';
  return new Function(js)();
})();

const doc = () => ({
  schema: 'yomu.circle/1', revision: 3, createdAt: 1, name: 'Test', ownerId: 'a',
  members: {
    a: { name: 'Ana', joinedAt: 1, lastSeen: 1, badge: 'century' },
    b: { name: 'Bo', joinedAt: 1, lastSeen: 1 },
  },
  progress: { a: { 'src:s1': 40 }, b: { 'src:s1': 12 } },
});

const comment = (over) => ({
  id: 'c1', memberId: 'a', name: 'Ana', chapter: 20, text: 'oh no', at: 100, likes: [], ...over,
});

test('a badge is validated by shape, and null means leave it alone', () => {
  assert.equal(circle.sanitiseBadge('tower-climber:3'), 'tower-climber:3');
  assert.equal(circle.sanitiseBadge('century'), 'century');
  assert.equal(circle.sanitiseBadge(''), '', 'empty is a deliberate clear');
  assert.equal(circle.sanitiseBadge(undefined), null);
  assert.equal(circle.sanitiseBadge('data:image/png;base64,AAAA'), null, 'a picture is not a badge');
  assert.equal(circle.sanitiseBadge('Tower Climber'), null);
  assert.equal(circle.sanitiseSticker('finisher-sticker'), 'finisher-sticker');
  assert.equal(circle.sanitiseSticker('<img>'), '');
});

test('setBadge returns the same document when nothing changes', () => {
  const d = doc();
  assert.equal(circle.setBadge(d, 'a', null), d);
  assert.equal(circle.setBadge(d, 'a', 'century'), d);
  assert.equal(circle.setBadge(d, 'nobody', 'century'), d);
  const next = circle.setBadge(d, 'b', 'finisher');
  assert.notEqual(next, d);
  assert.equal(next.members.b.badge, 'finisher');
  assert.equal(d.members.b.badge, undefined, 'the old document is untouched');
  const cleared = circle.setBadge(next, 'b', '');
  assert.equal('badge' in cleared.members.b, false);
});

test('a reaction toggles, replaces, and clears', () => {
  const c = comment();
  assert.equal(circle.react(c, 'b', 'finisher-sticker'), true);
  assert.equal(c.reactions.b, 'finisher-sticker');
  assert.equal(circle.react(c, 'b', 'finisher-sticker'), true, 'same again removes');
  assert.equal(c.reactions.b, undefined);
  circle.react(c, 'b', 'century-sticker');
  assert.equal(circle.react(c, 'b', 'finisher-sticker'), true, 'a different one replaces');
  assert.equal(c.reactions.b, 'finisher-sticker');
  assert.equal(circle.react(c, 'b', ''), true, 'empty clears');
  assert.equal(circle.react(c, 'b', ''), false, 'clearing nothing changes nothing');
});

test('the public comment carries the badge live and the reactions by name', () => {
  const d = doc();
  const c = comment({ reactions: { a: 'century-sticker', b: 'century-sticker', ghost: 'finisher-sticker' } });
  const shown = circle.publicComment(c, d, 'b');
  assert.equal(shown.badge, 'century', 'the author is wearing Century');
  assert.equal(shown.myReaction, 'century-sticker');
  assert.deepEqual(shown.reactions[0], { sticker: 'century-sticker', count: 2, names: ['Ana', 'Bo'], mine: true });
  assert.deepEqual(shown.reactions[1], { sticker: 'finisher-sticker', count: 1, names: [], mine: false },
    'a member who left counts, but has no name to give');
  assert.ok(!JSON.stringify(shown).includes('ghost'), 'member ids never leave the server');
  const asGhost = circle.publicComment(comment({ memberId: 'ghost' }), d, 'b');
  assert.equal(asGhost.badge, '', 'a member who left wears nothing');
});

test('unread counts are taken behind the gate and after the clock', () => {
  const thread = { schema: 'yomu.circle/1', comments: [
    comment({ id: '1', memberId: 'a', chapter: 5, at: 50 }),
    comment({ id: '2', memberId: 'a', chapter: 10, at: 150 }),
    comment({ id: '3', memberId: 'a', chapter: 30, at: 200 }),   // past Bo's mark
    comment({ id: '4', memberId: 'b', chapter: 10, at: 300 }),   // Bo's own
  ] };
  assert.equal(circle.unreadCount(thread, 12, 'b', 0), 2, 'two readable, neither his');
  assert.equal(circle.unreadCount(thread, 12, 'b', 100), 1, 'one since the last look');
  assert.equal(circle.unreadCount(thread, 12, 'b', 300), 0);
  assert.equal(circle.unreadCount(thread, 0, 'b', 0), 0, 'nothing reached, nothing counted');
  assert.equal(circle.unreadCount(thread, 40, 'b', 0), 3, 'the whole thread once he gets there');
});

test('the gate itself is unchanged by reactions', () => {
  const thread = { schema: 'yomu.circle/1', comments: [comment({ chapter: 30, reactions: { b: 'x' } })] };
  const view = circle.gate(thread, 12, 'b');
  assert.equal(view.visible.length, 0);
  assert.equal(view.lockedTotal, 1);
});

/* --- the reading race ------------------------------------------------------ */

test('recordProgress stamps when it advances and leaves the document alone otherwise', () => {
  const d = doc();
  const same = circle.recordProgress(d, 'b', 'src:s1', 5, 1000);
  assert.equal(same, d, 'not an advance');
  const next = circle.recordProgress(d, 'b', 'src:s1', 20, 1000);
  assert.equal(next.progress.b['src:s1'], 20);
  assert.equal(next.progressAt.b['src:s1'], 1000);
  assert.equal(d.progressAt, undefined, 'old document untouched');
});

test('the race view counts anonymously and names only at or below your mark', () => {
  const d = doc();
  d.members.c = { name: 'Cy', joinedAt: 1, lastSeen: 1 };
  d.progress.c = { 'src:s1': 12 };
  // Bo at 12, Cy at 12, Ana at 40. Viewer Bo.
  const view = circle.raceView(d, 'src:s1', 'b', 5000);
  assert.equal(view.mine, 12);
  assert.deepEqual(view.marks, [{ chapter: 12, count: 2 }, { chapter: 40, count: 1 }]);
  assert.equal(view.ahead, 1);
  assert.equal(view.alongside, 1);
  assert.equal(view.behind, 0);
  assert.deepEqual(view.known, [{ name: 'Cy', chapter: 12 }], 'Ana is ahead and unnamed');
  assert.equal(view.on, false);
  assert.equal(view.leader, null, 'no leader while the race is off');
  assert.ok(!JSON.stringify(view).includes('Ana'));
});

test("with the race on, the week's leader is the freshest furthest mark, unnamed when ahead of you", () => {
  const now = 10 * 86400000;
  const d = { ...doc(), race: true, progressAt: { a: { 'src:s1': now - 86400000 }, b: { 'src:s1': now - 2 * 86400000 } } };
  const asBo = circle.raceView(d, 'src:s1', 'b', now);
  assert.deepEqual(asBo.leader, { chapter: 40, name: null, isYou: false }, 'Ana leads but Bo has not got there');
  const asAna = circle.raceView(d, 'src:s1', 'a', now);
  assert.deepEqual(asAna.leader, { chapter: 40, name: 'Ana', isYou: true });
  // Ana's mark is from three weeks ago: Bo leads the week from chapter 12.
  const stale = { ...d, progressAt: { a: { 'src:s1': now - 21 * 86400000 }, b: { 'src:s1': now - 86400000 } } };
  assert.deepEqual(circle.raceView(stale, 'src:s1', 'b', now).leader, { chapter: 12, name: 'Bo', isYou: true });
  // A mark that never had a stamp (a circle from before) cannot lead.
  const unstamped = { ...d, progressAt: {} };
  assert.equal(circle.raceView(unstamped, 'src:s1', 'b', now).leader, null);
});
