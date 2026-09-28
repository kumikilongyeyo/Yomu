/**
 * The reader, a little further ahead of you.
 *
 * Three things the Expo reader does not do, all driven from the state it
 * publishes on globalThis.__yomuReader (see patch-bundle.mjs, "its state is
 * readable from outside"):
 *
 *   1. The chrome follows the scroll. Scrolling down hides the bars, scrolling
 *      up brings them back -- the one gesture every long-strip reader already
 *      knows. Before, on a phone the bars left after two seconds and only a
 *      double tap brought them back.
 *
 *   2. Pages further ahead. The reader mounts three pages either side and
 *      loads two at a time. Page images are served public, max-age=86400, so
 *      warming the HTTP cache a few pages past that window means a fast
 *      scroll lands on pages that are already here. Fewer on a slow or
 *      data-saver connection.
 *
 *   3. The next chapter before you get there. At three-quarters through, the
 *      next chapter's manifest is fetched and handed to the reader (manifests
 *      are no-store, so fetching it early is only worth anything because the
 *      bundle's handoff wrapper uses it instead of fetching again). At nine
 *      tenths, its first two pages are warmed. Moving on is then instant.
 *
 * Nothing here draws anything, and nothing here is load-bearing: without the
 * bundle's __yomuReader the file does nothing.
 */
(() => {
  'use strict';

  const browser = typeof document !== 'undefined';

  /* --- decisions, as pure functions --------------------------------------- */

  /** How many pages past the reader's own mount window to warm. */
  function aheadCount(connection) {
    if (!connection) return 3;
    if (connection.saveData) return 0;
    const type = String(connection.effectiveType || '');
    if (type === 'slow-2g' || type === '2g') return 0;
    if (type === '3g') return 1;
    return 3;
  }

  /** The reader mounts +/-3 (MOUNT_RADIUS); warm the pages just past that. */
  const MOUNT_RADIUS = 3;
  function aheadPages(page, count, extra) {
    const out = [];
    for (let i = page + MOUNT_RADIUS + 1; i <= page + MOUNT_RADIUS + extra && i < count; i++) out.push(i);
    return out;
  }

  /**
   * How far to go with the next chapter: nothing yet, fetch its manifest, or
   * also warm its first pages. Short chapters count in pages left, not
   * fractions -- 75% of an 8-page chapter is two pages from the end already.
   */
  function nextChapterStage(page, count) {
    if (!(count > 0)) return 'none';
    const left = count - 1 - page;
    const through = (page + 1) / count;
    if (through >= 0.9 || left <= 1) return 'images';
    if (through >= 0.75 || left <= 3) return 'manifest';
    return 'none';
  }

  /**
   * Scroll direction with hysteresis. Returns the next accumulator state and
   * an intent: 'show' after 24px of upward travel, 'hide' after 56px down.
   * A change of direction starts the count again, so a jittery thumb does
   * nothing.
   */
  const SHOW_AFTER = 24;
  const HIDE_AFTER = 56;
  function chromeStep(state, top) {
    const last = state?.top;
    if (last == null) return { state: { top, run: 0 }, intent: null };
    const dy = top - last;
    if (!dy) return { state, intent: null };
    const run = Math.sign(dy) === Math.sign(state.run) ? state.run + dy : dy;
    let intent = null;
    if (top < 40) intent = 'show';
    else if (run <= -SHOW_AFTER) intent = 'show';
    else if (run >= HIDE_AFTER) intent = 'hide';
    return { state: { top, run: intent ? 0 : run }, intent };
  }

  /* --- doing it ------------------------------------------------------------ */

  const reader = () => (browser && location.pathname.startsWith('/read/') ? globalThis.__yomuReader : null);

  /* Warmed URLs, per chapter; a new chapter starts a new set. */
  let warmedFor = '';
  const warmed = new Set();
  const queue = [];
  let active = 0;
  const WARM_CONCURRENCY = 2;
  const inFlight = new Set();

  function warm(uri) {
    if (!uri || warmed.has(uri)) return;
    warmed.add(uri);
    queue.push(uri);
    pump();
  }

  function pump() {
    while (active < WARM_CONCURRENCY && queue.length) {
      const uri = queue.shift();
      active++;
      const img = new Image();
      img.decoding = 'async';
      let finished = false;
      const done = () => { if (finished) return; finished = true; clearTimeout(timeout); active--; img.onload = img.onerror = null; img.removeAttribute('src'); inFlight.delete(done); pump(); };
      const timeout = setTimeout(done, 12000); inFlight.add(done);
      img.onload = done;
      img.onerror = done;
      img.src = uri;
    }
  }

  function resolve(r, page) {
    try { return page ? globalThis.YomuReaderSettings?.uri(r.adapter, page) || r.adapter.resolveImageUri(page) : null; } catch { return null; }
  }

  /* The next chapter, fetched once per (source, chapter). */
  const next = { key: '', promise: null, warmed: false };

  function handoff() {
    return (globalThis.__yomuManifestHandoff ||= new Map());
  }

  function prepareNext(r, stage) {
    if (!r.next || stage === 'none') return;
    const constrained = navigator.connection?.saveData || /2g/.test(navigator.connection?.effectiveType || '') || globalThis.YomuReaderSettings?.prefs.quality === 'saver';
    if (constrained && (!globalThis.YomuReaderSettings?.prefs.continuous || stage !== 'images')) return;
    const key = `${r.source}|${r.next}`;
    if (next.key !== key) {
      next.key = key;
      next.warmed = false;
      let promise;
      try { promise = Promise.resolve(r.adapter.getManifest(r.next)); } catch (error) { promise = Promise.reject(error); }
      next.promise = promise;
      handoff().set(key, { at: Date.now(), promise });
      for (const [id, value] of handoff()) if (Date.now() - value.at > 120000 || (handoff().size > 3 && id !== key)) handoff().delete(id);
      promise.then(manifest => { if (next.key === key && reader()?.chapterId === r.chapterId) appendNext(r, manifest); }).catch(() => {});
      promise.catch(() => { handoff().delete(key); if (next.key === key) next.key = ''; });
      try { performance.mark(`reader:prefetch:manifest:${r.next}`); } catch {}
    }
    if (stage === 'images' && !constrained && !next.warmed) {
      next.warmed = true;
      const adapter = r.adapter;
      next.promise.then((manifest) => {
        if (next.key === key && reader()?.chapterId === r.chapterId) for (const page of (manifest?.pages || []).slice(0, 2)) warm(resolve({ adapter }, page));
      }).catch(() => {});
    }
  }

  function onReader() {
    const r = reader();
    if (!r || !r.chapterId) return;
    const chapterKey = `${r.source}|${r.chapterId}`;
    if (warmedFor !== chapterKey) { warmedFor = chapterKey; warmed.clear(); queue.length = 0; [...inFlight].forEach(cancel => cancel()); advancing = false; document.querySelector('[data-next-chapter-preview]')?.remove(); }

    const extra = 0; // The mounted window itself preloads 1–4 pages. No second decode window.
    for (const index of aheadPages(r.page, r.count, extra)) warm(resolve(r, r.pages?.[index]));
    prepareNext(r, nextChapterStage(r.page, r.count));
    showProgress(r);
  }

  let advancing = false;
  function showProgress(r) {
    let badge = document.querySelector('.yomu-reader-progress');
    if (!badge) { badge = document.createElement('span'); badge.className = 'yomu-reader-progress'; document.body.append(badge); }
    const text = `${r.page + 1} / ${r.count}`;
    if (badge.textContent !== text) badge.textContent = text;
  }
  function appendNext(r, manifest) {
    const root = document.querySelector('[data-testid="reader-scroll"]');
    if (!root || r.mode !== 'scroll' || !globalThis.YomuReaderSettings?.prefs.continuous || !manifest?.pages?.length || root.querySelector('[data-next-chapter-preview]')) return;
    const preview = document.createElement('section'); preview.dataset.nextChapterPreview = r.next;
    preview.style.cssText = 'position:relative;text-align:center;min-height:160px;background:#0b0b0e;color:#ddd;padding-top:24px';
    const divider = document.createElement('p'); divider.textContent = 'Next chapter · keep scrolling'; preview.append(divider);
    const image = document.createElement('img'); image.src = resolve(r, manifest.pages[0]); image.alt = 'Next chapter preview';
    image.style.cssText = 'display:block;width:100%;max-width:900px;height:auto;margin:auto';
    if (!navigator.connection?.saveData && globalThis.YomuReaderSettings?.prefs.quality !== 'saver' && !/2g/.test(navigator.connection?.effectiveType || '')) preview.append(image);
    else image.removeAttribute('src');
    root.append(preview);
  }
  function advance(el, r) {
    const preview = el.querySelector('[data-next-chapter-preview]');
    if (!preview || advancing || r.sheet || !globalThis.YomuReaderSettings?.prefs.continuous || el.scrollTop + el.clientHeight < preview.offsetTop + 100) return;
    advancing = true;
    Promise.resolve(r.navigate?.(r.next)).catch(() => { advancing = false; });
  }
  if (browser) {
    addEventListener('yomu:reader-settings', () => {
      document.querySelector('[data-next-chapter-preview]')?.remove();
      const r = reader();
      if (r && next.promise) next.promise.then(value => { if (reader()?.chapterId === r.chapterId) appendNext(r, value); }).catch(() => {});
    });
    new MutationObserver(() => { if (!reader()) document.querySelector('.yomu-reader-progress')?.remove(); }).observe(document.documentElement, { childList: true, subtree: true });
  }

  let chrome = null;
  let lastIntentAt = 0;
  function onScroll(event) {
    const el = event.target;
    if (!el || el.nodeType !== 1 || el.getAttribute('data-testid') !== 'reader-scroll') return;
    const r = reader();
    if (!r) return;
    advance(el, r);
    const step = chromeStep(chrome, el.scrollTop);
    chrome = step.state;
    if (!step.intent) return;
    const now = Date.now();
    if (now - lastIntentAt < 200) return;
    lastIntentAt = now;
    if (step.intent === 'show') r.show?.();
    else if (!r.sheet) r.hide?.();
  }

  if (browser) {
    addEventListener('yomu:reader', onReader);
    /* scroll does not bubble; capture on the document sees the strip's. */
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    /* A new chapter is a new strip: forget the old scroll position. */
    addEventListener('yomu:reader', () => {
      const r = reader();
      const key = r ? `${r.source}|${r.chapterId}` : '';
      if (key !== onScroll.key) { onScroll.key = key; chrome = null; }
    });
  }

  if (typeof window !== 'undefined') {
    window.YomuReaderPlus = { aheadCount, aheadPages, nextChapterStage, chromeStep };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { aheadCount, aheadPages, nextChapterStage, chromeStep, SHOW_AFTER, HIDE_AFTER };
  }
})();
