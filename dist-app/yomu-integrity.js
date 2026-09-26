/**
 * Chapter integrity: which copy of a chapter to open, and why.
 *
 * Both recovery paths -- the reader's Source picker (source-auto-switch.js)
 * and the automatic rescue in yomu-source-reliability.js -- used to accept an
 * alternate copy the moment its manifest listed one page. A source returning
 * 12 pages of a 46-page chapter passed, and so did one whose manifest was fine
 * and whose images were all dead. And a series with no chapters fell over to
 * whichever source listed the most, however often that source failed.
 *
 * "It loaded" is not "it is complete". This file answers the second question,
 * as well as it can be answered without downloading the whole chapter:
 *
 *   Completeness  the page count against what the chapter says it has (MangaDex
 *                 and Suwayomi declare one) and against the other copies of the
 *                 same chapter; page indices with no gaps; no repeated pages.
 *   Delivery      the first and the last page actually decode. The last one is
 *                 the page a truncated upload loses.
 *   Quality       a page narrower than TINY_WIDTH is a thumbnail, not a page.
 *   Reliability   how each source has behaved *on this device*: page loads in
 *                 the reader, manifest answers, how often its copies were
 *                 complete, how fast it answered. Local, decaying, never sent.
 *
 * The order is Complete > Reliable > HQ > Fast. A short copy still opens when
 * it is the only copy -- a suspect chapter beats a dead end -- it just never
 * wins against a complete one.
 *
 * Page counts are never compared raw across sources. Measured on Solo
 * Leveling chapter 200 (2026-09-26): Asura 15 pages, Flame 18, Weeb Central
 * 49 -- all complete, all the same chapter, cut into different slices. So the
 * cross-source check uses a *learned* ratio per pair of sources: once this
 * device has seen Asura run at ~0.3x Weeb Central on a few chapters, a 7-page
 * Asura copy stands out. With no history for a pair, only the same-source
 * checks apply (declared count, first/last page, gaps, repeats).
 *
 * The two recovery files call in through `YomuIntegrity.verifyAll` and fall
 * back to their old behaviour when this file has not loaded, so script order
 * does not matter and removing this file is a clean rollback.
 */
(() => {
  'use strict';

  const browser = typeof document !== 'undefined';

  const HEALTH_KEY = 'yomu.v1.sourceHealth';
  const LAYOUT_KEY = 'yomu.v1.sourceLayout';
  /** A pair needs this many chapters seen together before its ratio is trusted. */
  const LAYOUT_MIN_SAMPLES = 2;
  const LAYOUT_MAX_PAIRS = 400;
  /** A week-old failure counts half. A source that was down last month is not down now. */
  const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
  /** Entries nobody has touched in this long are dropped rather than kept at the prior. */
  const FORGET_MS = 60 * 24 * 60 * 60 * 1000;
  const PROBE_TIMEOUT_MS = 6000;
  const PROBE_CONCURRENCY = 4;
  /** Narrower than this and it is a preview image, not a readable page. */
  const TINY_WIDTH = 400;

  /* --- reliability, as pure functions over a plain object ------------------ *
   *
   * store[providerId] = { at, ms, page:[ok,fail], manifest:[ok,fail],
   *                       complete:[ok,fail], quality:[ok,fail] }
   *
   * Each rate is smoothed toward a prior, so one failed page on a source seen
   * once does not bury it, and an unknown source sits a little below a proven
   * one rather than at zero or at perfect.
   */

  const PRIOR = {
    page: [0.9, 4],
    manifest: [0.85, 2],
    complete: [0.85, 2],
    quality: [0.9, 2],
  };
  const WEIGHT = { page: 0.40, complete: 0.25, quality: 0.15, latency: 0.10, manifest: 0.10 };

  function decayed(entry, now) {
    if (!entry) return null;
    const factor = Math.pow(0.5, Math.max(0, now - Number(entry.at || now)) / HALF_LIFE_MS);
    const out = { at: now, ms: entry.ms };
    for (const metric of Object.keys(PRIOR)) {
      const [ok, fail] = Array.isArray(entry[metric]) ? entry[metric] : [0, 0];
      out[metric] = [Number(ok || 0) * factor, Number(fail || 0) * factor];
    }
    return out;
  }

  function record(store, providerId, metric, ok, now = Date.now()) {
    if (!providerId || !PRIOR[metric]) return store;
    const entry = decayed(store[providerId], now) || decayed({ at: now }, now);
    entry[metric][ok ? 0 : 1] += 1;
    store[providerId] = entry;
    return store;
  }

  function recordLatency(store, providerId, ms, now = Date.now()) {
    if (!providerId || !(ms > 0)) return store;
    const entry = decayed(store[providerId], now) || decayed({ at: now }, now);
    entry.ms = entry.ms > 0 ? entry.ms * 0.7 + ms * 0.3 : ms;
    store[providerId] = entry;
    return store;
  }

  function rate(entry, metric) {
    const [ok, fail] = entry?.[metric] || [0, 0];
    const [prior, weight] = PRIOR[metric];
    return (ok + prior * weight) / (ok + fail + weight);
  }

  /** 1 under 1.5s, sliding to 0.4 at 12s. Unknown is neutral, not fast. */
  function latencyScore(ms) {
    if (!(ms > 0)) return 0.85;
    if (ms <= 1500) return 1;
    if (ms >= 12000) return 0.4;
    return 1 - 0.6 * (ms - 1500) / 10500;
  }

  function healthOf(store, providerId, now = Date.now()) {
    const entry = decayed(store?.[providerId], now);
    return WEIGHT.page * rate(entry, 'page')
      + WEIGHT.complete * rate(entry, 'complete')
      + WEIGHT.quality * rate(entry, 'quality')
      + WEIGHT.latency * latencyScore(entry?.ms)
      + WEIGHT.manifest * rate(entry, 'manifest');
  }

  function prune(store, now = Date.now()) {
    for (const id of Object.keys(store)) {
      if (now - Number(store[id]?.at || 0) > FORGET_MS) delete store[id];
    }
    return store;
  }

  /* --- one copy of one chapter ---------------------------------------------- */

  function median(values) {
    const nums = values.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (!nums.length) return 0;
    const mid = nums.length >> 1;
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  }

  /* --- how two sources cut the same chapter --------------------------------- *
   *
   * layout["a|b"] = [mean log(pages_a / pages_b), samples], with a < b. The
   * mean is a running average over the last ~10 chapters, so a source that
   * changes how it slices catches up.
   */

  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  /** Expected log(pages_p / pages_q), or null if the pair is not known well enough. */
  function learnedRatio(layout, p, q) {
    if (!p || !q || p === q) return null;
    const entry = layout?.[pairKey(p, q)];
    if (!Array.isArray(entry) || entry[1] < LAYOUT_MIN_SAMPLES) return null;
    return p < q ? entry[0] : -entry[0];
  }

  function learnLayout(layout, p, np, q, nq) {
    if (!p || !q || p === q || !(np > 0) || !(nq > 0)) return layout;
    const key = pairKey(p, q);
    const x = p < q ? Math.log(np / nq) : Math.log(nq / np);
    const [mean, count] = Array.isArray(layout[key]) ? layout[key] : [0, 0];
    const window = Math.min(count, 9);
    layout[key] = [(mean * window + x) / (window + 1), count + 1];
    return layout;
  }

  /** How many pages this copy has, measured if we fetched it, declared if not. */
  function countOf(item) {
    if (!item?.ready) return 0;
    if (Array.isArray(item.pages)) return item.pages.length;
    return Number(item.pageCount || item.release?.pageCount || 0);
  }

  /**
   * Score one verified copy. `siblings` is `{ providerId, count }` for the
   * *other* copies of the same chapter; `layout` is the learned pair ratios.
   * Returns the fields to merge into the result:
   * { ready, score 0-100, grade 'complete'|'suspect'|'broken', reasons, summary }.
   */
  function assess(item, siblings = [], layout = {}) {
    if (!item?.ready) {
      return { ready: false, score: 0, grade: 'broken', reasons: ['no pages'], summary: 'No readable pages' };
    }
    const reasons = [];
    let score = 100;
    let suspect = false;
    const measured = Array.isArray(item.pages);
    const n = countOf(item);
    const declared = Number(item.release?.pageCount || 0);

    if (measured && declared > 0 && n < declared * 0.9) {
      score -= 35; suspect = true;
      reasons.push(`${n} of ${declared} pages`);
    }

    /* A copy that delivers what its own source declares is not second-guessed
       from another site's slicing. */
    const matchesDeclared = measured && declared > 0 && n >= declared * 0.9;
    const id = String(item.release?.providerId || '');
    const relative = siblings
      .map((s) => {
        const ratio = learnedRatio(layout, id, String(s?.providerId || ''));
        return ratio == null || !(s.count > 0) ? null : n / (s.count * Math.exp(ratio));
      })
      .filter((v) => v != null);
    const shortfall = median(relative);
    if (!matchesDeclared && n > 0 && relative.length && shortfall < 0.6) {
      score -= 30; suspect = true;
      reasons.push(`${n} pages; this source usually has ~${Math.round(n / shortfall)} here`);
    }

    if (measured && n > 1) {
      const indices = item.pages.map((page) => page?.index);
      if (indices.every((index) => Number.isInteger(index))) {
        const set = new Set(indices);
        const lo = Math.min(...indices);
        const contiguous = set.size === n && (lo === 0 || lo === 1) && Math.max(...indices) === lo + n - 1;
        if (!contiguous) { score -= 15; reasons.push('gaps in page order'); }
      }
      const urls = item.pages.map((page) => String(page?.url || '')).filter(Boolean);
      const repeats = urls.length - new Set(urls).size;
      if (repeats > 0) {
        score -= Math.min(30, 10 + repeats * 5);
        if (repeats / n >= 0.1) suspect = true;
        reasons.push(`${repeats} repeated page${repeats === 1 ? '' : 's'}`);
      }
    }

    const probes = item.probes || {};
    const firstFailed = probes.first?.ok === false;
    const lastFailed = probes.last?.ok === false;
    if (firstFailed && (lastFailed || n === 1)) {
      /* The manifest answers and the images do not. That is the case the old
         check could not see: "ready" by its definition, unreadable by anyone's. */
      return { ready: false, score: 0, grade: 'broken', reasons: ['pages do not load'], summary: 'Pages do not load' };
    }
    if (firstFailed) { score -= 30; suspect = true; reasons.push('first page does not load'); }
    if (lastFailed) { score -= 30; suspect = true; reasons.push('last page does not load'); }

    const widths = [probes.first, probes.last].filter((p) => p?.ok && p.width > 0).map((p) => p.width);
    const lowRes = widths.length > 0 && Math.max(...widths) < TINY_WIDTH;
    if (lowRes) { score -= 15; reasons.push('low resolution'); }

    if (!measured) {
      /* MangaDex and the copy already open are trusted without a fetch; they
         rank with everything else but do not claim a check they did not get. */
      score = Math.min(score, 90);
    }

    score = Math.max(0, Math.min(100, score));
    const grade = !suspect && score >= 70 ? 'complete' : score > 0 ? 'suspect' : 'broken';
    const summary = grade === 'complete'
      ? (n ? `${n} pages${measured && (probes.first || probes.last) ? ' · checked' : ''}` : 'Readable')
      : reasons[0] || 'Could not confirm every page';
    return { ready: grade !== 'broken', score, grade, reasons, summary, lowRes };
  }

  const GRADE_ORDER = { complete: 0, suspect: 1, broken: 2 };

  /** Complete > Reliable > HQ > Fast, stable on the order it was given. */
  function rank(items, store = {}, now = Date.now()) {
    return items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const x = a.item, y = b.item;
        if (!!x.ready !== !!y.ready) return x.ready ? -1 : 1;
        const g = (GRADE_ORDER[x.grade] ?? 1) - (GRADE_ORDER[y.grade] ?? 1);
        if (g) return g;
        const vx = Number(x.score || 0) * (0.6 + 0.4 * healthOf(store, x.release?.providerId, now));
        const vy = Number(y.score || 0) * (0.6 + 0.4 * healthOf(store, y.release?.providerId, now));
        if (Math.abs(vx - vy) > 0.5) return vy - vx;
        const mx = Number(x.ms || Infinity), my = Number(y.ms || Infinity);
        if (mx !== my) return mx < my ? -1 : 1;
        return a.index - b.index;
      })
      .map(({ item }) => item);
  }

  const KIND_RANK = { extension: 0, native: 1, suwayomi: 2 };

  /**
   * Order whole-series candidates for the "this source has no chapters" jump.
   * Coverage (chapters against the best-stocked source) times reliability: a
   * 400-chapter source that fails a third of its pages loses to a 390-chapter
   * one that never fails, and a 50-chapter source does not win by being tidy.
   */
  function rankSources(sources, store = {}, now = Date.now()) {
    const most = Math.max(1, ...sources.map((s) => Number(s?.chapterCount || 0)));
    const value = (s) => (Number(s?.chapterCount || 0) / most) * healthOf(store, String(s?.providerId || ''), now);
    return sources
      .map((source, index) => ({ source, index, value: value(source) }))
      .sort((a, b) => (Math.abs(b.value - a.value) > 1e-9 ? b.value - a.value : 0)
        || Number(b.source.chapterCount || 0) - Number(a.source.chapterCount || 0)
        || (KIND_RANK[a.source.kind] ?? 3) - (KIND_RANK[b.source.kind] ?? 3)
        || String(a.source.providerName || '').localeCompare(String(b.source.providerName || ''))
        || a.index - b.index)
      .map(({ source }) => source);
  }

  /* --- the store on this device --------------------------------------------- */

  let memory = null;
  let layoutMemory = null;
  let saveTimer = null;

  const readObject = (key) => {
    if (!browser) return {};
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  };

  function load() {
    if (!memory) memory = prune(readObject(HEALTH_KEY));
    return memory;
  }

  function loadLayout() {
    if (!layoutMemory) layoutMemory = readObject(LAYOUT_KEY);
    return layoutMemory;
  }

  /** Keep the best-sampled pairs; a device that has read everything does not get a bigger blob. */
  function trimLayout(layout) {
    const keys = Object.keys(layout);
    if (keys.length <= LAYOUT_MAX_PAIRS) return layout;
    keys.sort((a, b) => Number(layout[b]?.[1] || 0) - Number(layout[a]?.[1] || 0));
    for (const key of keys.slice(LAYOUT_MAX_PAIRS)) delete layout[key];
    return layout;
  }

  function saveNow() {
    if (!browser) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    if (memory) {
      try { localStorage.setItem(HEALTH_KEY, JSON.stringify(prune(memory))); } catch {}
    }
    if (layoutMemory) {
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(trimLayout(layoutMemory))); } catch {}
    }
  }

  /** Reader page loads arrive in bursts; batch them. */
  function scheduleSave() {
    if (!browser || saveTimer) return;
    saveTimer = setTimeout(saveNow, 1500);
  }

  /* --- checking copies ------------------------------------------------------ */

  async function pool(items, limit, worker) {
    const out = new Array(items.length);
    let cursor = 0;
    const run = async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await worker(items[index], index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, run));
    return out;
  }

  /**
   * Load one image off-document. A timeout is "unknown", never "failed": a slow
   * network must not make every copy look broken and strand the reader.
   */
  function probeImage(url, timeout = PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
      if (!url || typeof Image === 'undefined') { resolve({ ok: null }); return; }
      const img = new Image();
      let done = false;
      const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => { img.src = ''; finish({ ok: null }); }, timeout);
      img.decoding = 'async';
      img.onload = () => finish({ ok: true, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => finish({ ok: false });
      img.src = url;
    });
  }

  async function probePages(pages, probe) {
    const first = pages[0]?.url;
    const last = pages.length > 1 ? pages[pages.length - 1]?.url : null;
    const [a, b] = await Promise.all([probe(first), last ? probe(last) : Promise.resolve(undefined)]);
    return { first: a, last: b };
  }

  /**
   * Verify, probe, score and rank a set of copies of one chapter.
   *
   * `verifyOne(release)` is the caller's own manifest check. It must resolve to
   * `{ release, ready, pageCount, pages? }` (or null); `pages` is what makes
   * the completeness checks possible, and without it a copy is ranked on its
   * declared count alone. Results come back best first, with `score`, `grade`,
   * `reasons` and `summary` added and `pages` dropped.
   */
  async function verifyAll(releases, verifyOne, options = {}) {
    const store = options.store || load();
    const layout = options.layout || loadLayout();
    const probe = options.probe || probeImage;
    const clock = options.now || (() => Date.now());
    const concurrency = options.concurrency || 3;

    const results = (await pool(releases, concurrency, async (release) => {
      const started = clock();
      let result = null;
      try { result = await verifyOne(release); } catch { result = { release, ready: false }; }
      return result ? { ...result, ms: clock() - started } : null;
    })).filter(Boolean);

    for (const item of results) {
      const id = String(item.release?.providerId || '');
      if (item.current || item.trustedNative || !id) continue;
      record(store, id, 'manifest', !!item.ready, clock());
      if (item.ready) recordLatency(store, id, item.ms, clock());
    }

    const probable = results.filter((item) => item.ready && Array.isArray(item.pages) && item.pages.length);
    await pool(probable, PROBE_CONCURRENCY, async (item) => { item.probes = await probePages(item.pages, probe); });

    const counts = results.map((item) => ({ providerId: String(item.release?.providerId || ''), count: countOf(item) }));
    results.forEach((item, i) => {
      Object.assign(item, assess(item, counts.filter((_, j) => j !== i), layout));
      const id = String(item.release?.providerId || '');
      if (id && Array.isArray(item.pages)) {
        record(store, id, 'complete', item.grade === 'complete', clock());
        if (item.probes?.first?.ok || item.probes?.last?.ok) record(store, id, 'quality', !item.lowRes, clock());
      }
    });

    /* Learn how these sources slice, from the copies that passed on their own
       evidence. A copy already flagged short would teach the wrong ratio. */
    const trusted = results.filter((item) => item.grade === 'complete' && countOf(item) > 0);
    for (let i = 0; i < trusted.length; i++) {
      for (let j = i + 1; j < trusted.length; j++) {
        learnLayout(layout,
          String(trusted[i].release?.providerId || ''), countOf(trusted[i]),
          String(trusted[j].release?.providerId || ''), countOf(trusted[j]));
      }
    }
    for (const item of results) { delete item.pages; delete item.lowRes; }

    /* Immediately, not batched: both callers navigate away within 200ms of
       getting this answer, which is before any timer would fire. */
    if (!options.store) saveNow();
    return rank(results, store, clock());
  }

  /* --- what the reader sees ------------------------------------------------- *
   *
   * Every chapter page the reader loads or fails is a data point about the
   * source it came from, and it costs nothing to collect. Only the first
   * outcome per image counts: a rescue retry (yomuRetry) is the same page, and
   * a page that needed rescuing already failed once.
   */

  const toProviderId = (sourceId) => {
    const id = String(sourceId || '');
    if (id.startsWith('yomuext-')) return 'ext:' + id.slice(8);
    if (id.startsWith('mihon-')) return 'suwayomi:' + id.slice(6);
    return id;
  };

  if (browser) {
    const seen = new Set();
    const observe = (ok) => (event) => {
      const img = event.target;
      if (!img || img.tagName !== 'IMG' || !location.pathname.startsWith('/read/')) return;
      let url;
      try { url = new URL(img.getAttribute('src') || '', location.href); } catch { return; }
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return;
      if (url.searchParams.has('yomuRetry')) return;
      if (seen.has(url.href)) return;
      if (seen.size > 2000) seen.clear();
      seen.add(url.href);
      const source = new URLSearchParams(location.search).get('source');
      if (!source) return;
      record(load(), toProviderId(source), 'page', ok);
      scheduleSave();
    };
    /* load/error do not bubble; capture sees them on the way down. */
    addEventListener('load', observe(true), true);
    addEventListener('error', observe(false), true);
    /* A batch still waiting when the reader leaves would be lost. */
    addEventListener('pagehide', () => { if (saveTimer) saveNow(); });
  }

  if (typeof window !== 'undefined') {
    window.YomuIntegrity = {
      verifyAll,
      assess,
      rank: (items) => rank(items, load()),
      rankSources: (sources) => rankSources(sources, load()),
      health: (providerId) => healthOf(load(), toProviderId(providerId)),
      /** For the console: every source this device has seen, best first. */
      snapshot: () => Object.keys(load())
        .map((id) => ({ id, health: Math.round(healthOf(load(), id) * 100) }))
        .sort((a, b) => b.health - a.health),
    };
  }
  /* An object literal: Node's CJS lexer reads named exports statically. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { assess, rank, rankSources, verifyAll, healthOf, record, recordLatency, median, latencyScore, learnLayout, learnedRatio, HALF_LIFE_MS, TINY_WIDTH };
  }
})();
