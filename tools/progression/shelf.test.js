/**
 * The shelf and the stickers: every id the store pays has art, and the art
 * is well formed. A reward with no picture is the state the whole feature
 * set out to end, so the catalogue and the milestone table are held to each
 * other here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MILESTONES, TIER_XP } = await import('../../dist-app/yomu-progress.js');
const { MILESTONE_FAMILIES, parse } = await import('../../dist-app/yomu-shelf.js');
const { STICKERS, TONES, svg } = await import('../../dist-app/yomu-stickers.js');

test('every badge the roadmap pays is a registered milestone family', () => {
  for (const m of MILESTONES) {
    for (const r of m.rewards) {
      if (r.type !== 'badge') continue;
      assert.ok(MILESTONE_FAMILIES[r.id], m.id + ' pays badge ' + r.id + ' which has no art');
    }
  }
});

test('every sticker the roadmap pays is in the catalogue, and draws', () => {
  for (const m of MILESTONES) {
    for (const r of m.rewards) {
      if (r.type !== 'sticker') continue;
      assert.ok(STICKERS[r.id], m.id + ' pays sticker ' + r.id + ' which has no art');
      const markup = svg(r.id, { size: 40 });
      assert.match(markup, /^<svg class="ys ys--\w+" viewBox="0 0 100 100" width="40" height="40"/);
      assert.match(markup, /aria-label="[^"]+"/);
    }
  }
});

test('no sticker in the catalogue is unearnable', () => {
  const paid = new Set(MILESTONES.flatMap((m) => m.rewards.filter((r) => r.type === 'sticker').map((r) => r.id)));
  for (const id of Object.keys(STICKERS)) assert.ok(paid.has(id), id + ' can never be earned');
  for (const row of Object.values(STICKERS)) {
    assert.ok(TONES[row.tone], row.title + ' has a real tone');
    assert.ok(row.hint, row.title + ' says how it is earned');
  }
});

test('milestone families have a plate tier and an emblem', () => {
  for (const [slug, row] of Object.entries(MILESTONE_FAMILIES)) {
    assert.ok(row.tier >= 1 && row.tier <= 5, slug + ' tier');
    assert.ok(row.em.includes('<path') || row.em.includes('<circle') || row.em.includes('<ellipse'), slug + ' draws something');
    assert.ok(row.title && row.theme, slug + ' is labelled');
  }
});

test('the stage badges match the stage names the store uses', async () => {
  const { STAGES } = await import('../../dist-app/yomu-progress.js');
  for (const stage of STAGES.slice(1)) {
    const slug = 'stage-' + stage.name.toLowerCase();
    assert.ok(MILESTONE_FAMILIES[slug], slug + ' exists for the ceremony to drop');
    const paid = MILESTONES.find((m) => m.metric === 'petXp' && m.threshold === stage.at);
    assert.ok(paid && paid.quiet, slug + ' is paid quietly at ' + stage.at + ' XP');
  }
});

test('parse reads both id shapes and rejects the rest', () => {
  assert.deepEqual(parse('tower-climber:3'), { slug: 'tower-climber', tier: 3, milestone: false });
  assert.deepEqual(parse('century'), { slug: 'century', tier: 3, milestone: true });
  assert.equal(parse('tower-climber'), null, 'a family with no tier is not a badge');
  assert.equal(parse(''), null);
  assert.equal(parse(null), null);
  assert.equal(TIER_XP.length, 5);
});
