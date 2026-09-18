/**
 * What day it is, for a reader who is not in London.
 *
 * The progression store used the UTC calendar date, so in Manila (UTC+8)
 * everything before 08:00 local was filed under yesterday -- which is most of
 * a late-night reading session, and exactly when a streak is at risk. These
 * are the boundary cases the audit asked for, plus the rule that the two
 * files which define a "day" have to agree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const progress = await import('../../dist-app/yomu-progress.js');
const streak = await import('../../dist-app/yomu-streak.js');

const { localDay, daysBetween, DAY_START_HOUR } = progress;

/** Run `fn` as if the machine's clock were in `offsetHours` from UTC. */
function inZone(offsetHours, fn) {
  const Real = Date;
  const shift = offsetHours * 3600000;
  class Zoned extends Real {
    constructor(...args) {
      super(...(args.length ? args : [Real.now()]));
    }
    getFullYear() { return new Real(this.getTime() + shift).getUTCFullYear(); }
    getMonth() { return new Real(this.getTime() + shift).getUTCMonth(); }
    getDate() { return new Real(this.getTime() + shift).getUTCDate(); }
    getHours() { return new Real(this.getTime() + shift).getUTCHours(); }
    setHours(h) {
      /* Mirrors the real setHours in the shifted zone: move by the delta. */
      const current = this.getHours();
      this.setTime(this.getTime() + (h - current) * 3600000);
      return this.getTime();
    }
  }
  globalThis.Date = Zoned;
  try { return fn(); } finally { globalThis.Date = Real; }
}

/** An absolute instant, written as UTC. */
const utc = (iso) => Date.parse(iso);

test('the day boundary is local, not UTC', () => {
  /* 2026-03-10 00:30 in Manila is 2026-03-09 16:30 UTC. The old rule filed
     this under the 9th. It is the 10th where the reader is -- but the day
     starts at 04:00, so it still counts as the 9th's reading session. */
  const lateNightManila = utc('2026-03-09T16:30:00Z');
  assert.equal(inZone(8, () => localDay(lateNightManila)), '2026-03-09');

  /* 09:00 Manila on the 10th is unambiguously the 10th. Under the old UTC
     rule this was 01:00 UTC on the 10th and happened to agree; the cases
     below are the ones that did not. */
  assert.equal(inZone(8, () => localDay(utc('2026-03-10T01:00:00Z'))), '2026-03-10');

  /* 23:59 Manila on the 10th is 15:59 UTC on the 10th: both say the 10th. */
  assert.equal(inZone(8, () => localDay(utc('2026-03-10T15:59:00Z'))), '2026-03-10');

  /* 08:00 Manila on the 11th is 00:00 UTC on the 11th. Local says the 11th,
     and so does UTC -- but 03:00 Manila, which is 19:00 UTC on the 10th, is
     where they part company. */
  assert.equal(inZone(8, () => localDay(utc('2026-03-10T19:00:00Z'))), '2026-03-10',
    '03:00 local is still the previous reading day, not the previous UTC day by accident');
  assert.equal(inZone(8, () => localDay(utc('2026-03-10T20:00:00Z'))), '2026-03-11',
    '04:00 local opens the new day');
});

test('a zone behind UTC is not broken in the other direction', () => {
  /* 2026-03-10 22:00 in New York (UTC-5) is 2026-03-11 03:00 UTC. The UTC
     rule would have called this the 11th; it is the evening of the 10th. */
  assert.equal(inZone(-5, () => localDay(utc('2026-03-11T03:00:00Z'))), '2026-03-10');
});

test('the month a chapter lands in follows the local day', () => {
  /* 2026-04-01 01:00 Manila is 2026-03-31 17:00 UTC. Before 04:00, so it is
     still March's session -- and under the old rule it was March too, but
     for the wrong reason. The case that actually moved: 2026-04-01 09:00
     Manila = 2026-04-01 01:00 UTC, April either way; and 2026-04-01 05:00
     Manila = 2026-03-31 21:00 UTC, which UTC called March and is April. */
  assert.equal(inZone(8, () => localDay(utc('2026-03-31T21:00:00Z'))).slice(0, 7), '2026-04',
    'the first chapter of April is filed in April');
  assert.equal(inZone(8, () => localDay(utc('2026-03-31T17:00:00Z'))).slice(0, 7), '2026-03');
});

test('key arithmetic survives a DST change', () => {
  /* Adjacent keys are always exactly one day apart, because the subtraction
     happens on the key string in UTC and never on two local wall clocks. */
  assert.equal(daysBetween('2026-03-07', '2026-03-08'), 1);
  assert.equal(daysBetween('2026-03-08', '2026-03-09'), 1, 'US spring forward');
  assert.equal(daysBetween('2026-11-01', '2026-11-02'), 1, 'US fall back');
  assert.equal(daysBetween('2026-03-28', '2026-03-29'), 1, 'EU spring forward');
  assert.equal(daysBetween('2026-03-01', '2026-04-01'), 31);
  assert.equal(daysBetween('2026-03-09', '2026-03-09'), 0);
});

test('the two files that define a day agree, or one of them is wrong', () => {
  /* yomu-streak.js has owned this definition since it shipped. The store now
     defers to it at runtime; this is the check that the local copy it falls
     back to has not drifted. */
  assert.equal(DAY_START_HOUR, 4);
  const moments = [
    '2026-03-09T16:30:00Z', '2026-03-10T01:00:00Z', '2026-03-10T19:00:00Z',
    '2026-03-10T20:00:00Z', '2026-03-31T21:00:00Z', '2026-07-04T11:11:00Z',
  ].map(utc);
  for (const offset of [8, 0, -5, 5.5]) {
    for (const at of moments) {
      assert.equal(
        inZone(offset, () => localDay(at)),
        inZone(offset, () => streak.dayKey(at, 4)),
        `UTC${offset >= 0 ? '+' : ''}${offset} at ${new Date(at).toISOString()}`,
      );
    }
  }
});
