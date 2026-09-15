import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availabilityState,
  buildAvailabilityPack,
  freshnessTag,
  isPromotionEligible
} from '../src/availability-policy.js';

test('unknown freshness does not block a proven reader', () => {
  const row = {
    url: 'https://example.com/',
    gauntlet: { pass: true },
    quality: { highQuality: true },
    freshness: { status: 'unknown', fresh: false }
  };
  assert.equal(isPromotionEligible(row), true);
  assert.equal(freshnessTag(row, 5), 'freshness-unverified');
  assert.equal(availabilityState(row, 5).freshnessPriority, 'unverified');
});

test('stale but readable source remains eligible as back catalog', () => {
  const row = {
    url: 'https://archive.example/',
    gauntlet: { pass: true },
    quality: { highQuality: true },
    freshness: { status: 'stale', fresh: false, ageDays: 60 }
  };
  assert.equal(isPromotionEligible(row), true);
  assert.equal(freshnessTag(row, 5), 'back-catalog');
});

test('fresh readable source is preferred', () => {
  const row = {
    url: 'https://fresh.example/',
    gauntlet: { pass: true },
    quality: { highQuality: true },
    freshness: { status: 'fresh', fresh: true, ageDays: 1 }
  };
  assert.equal(availabilityState(row, 5).freshnessPriority, 'preferred');
  assert.equal(freshnessTag(row, 5), 'fresh-5d');
});

test('broken reader or low quality still blocks promotion', () => {
  assert.equal(isPromotionEligible({ gauntlet: { pass: false }, quality: { highQuality: true } }), false);
  assert.equal(isPromotionEligible({ gauntlet: { pass: true }, quality: { highQuality: false } }), false);
});

test('adapter-aware public reader can qualify without generic gauntlet', () => {
  const tapasLike = {
    url: 'https://official.example/',
    adapterAware: true,
    discovery: { freeEpisodeCount: 3 },
    quality: { highQuality: true },
    freshness: { status: 'unknown', fresh: false }
  };
  assert.equal(isPromotionEligible(tapasLike), true);
});

test('candidate pack includes readable unverified and back-catalog sources', () => {
  const report = {
    generatedAt: '2026-09-15T00:00:00.000Z',
    config: { freshDays: 5 },
    results: [
      {
        url: 'https://unknown.example/',
        gauntlet: { pass: true },
        quality: { highQuality: true },
        freshness: { status: 'unknown', fresh: false },
        evidence: []
      },
      {
        url: 'https://stale.example/',
        gauntlet: { pass: true },
        quality: { highQuality: true },
        freshness: { status: 'stale', fresh: false },
        evidence: []
      },
      {
        url: 'https://bad.example/',
        gauntlet: { pass: false },
        quality: { highQuality: true },
        freshness: { status: 'fresh', fresh: true },
        evidence: []
      }
    ]
  };

  const pack = buildAvailabilityPack(report);
  assert.equal(pack.sources.length, 2);
  assert.ok(pack.sources[0].tags.includes('freshness-unverified'));
  assert.ok(pack.sources[1].tags.includes('back-catalog'));
});
