/**
 * The reader, a little further ahead of you.
 *
 * Driven from the state the Expo reader publishes on globalThis.__yomuReader
 * (see patch-bundle.mjs, "its state is readable from outside"):
 *
 *   1. The chrome follows the scroll. Scrolling down hides the bars, scrolling
 *      up brings them back -- the gesture every long-strip reader knows. While
 *      they are away, a small page counter is all that is left on screen.
 *
 *   2. Pages further ahead. The reader keeps a window of pages mounted
 *      (yomu-reader-settings.js sizes it in decoded bytes); on a line that is
 *      delivering pages quickly, a few more past that window are fetched into
 *      the HTTP cache -- fetched, not decoded, so they cost bandwidth and no
 *      memory. Nothing extra on a slow line or with Data saver.
 *
 *   3. The next chapter before you get there. At seven tenths through, its
 *      manifest is fetched and handed to the reader (manifests are no-store,
 *      so fetching early is only worth anything because the bundle's handoff
 *      wrapper uses it instead of fetching again). At 85%, its first pages are
 *      warmed. Moving on is then instant.
 *
 *   4. What is below the last page. With Continuous chapters on (the
 *      default, in Scroll), a divider and the next chapter's first page; the
 *      moment that page reaches the top of the screen the reader moves into
 *      that chapter at exactly the same spot, so nothing jumps. With it off, a
 *      card: the end of this chapter, the next one a tap away.
 *
 * Nothing here is load-bearing: without the bundle's __yomuReader the file does
 * nothing, and without yomu-reader-settings.js it keeps its old defaults.
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

  /** The bundle's own window is +/-3 (MOUNT_RADIUS); pages just past it. */
  const MOUNT_RADIUS = 3;
  function aheadPages(page, count, extra, end = page + MOUNT_RADIUS) {
    const out = [];
    for (let i = end + 1; i <= end + extra && i < count; i++) out.push(i);
    return out;
  }

  /**
   * How far to go with the next chapter: nothing yet, fetch its manifest, or
   * also warm its first pages. Short chapters count in pages left, not
   * fractions -- 70% of an 8-page chapter is two pages from the end already.
   */
  function nextChapterStage(page, count) {
    if (!(count > 0)) return 'none';
    const left = count - 1 - page;
    const through = (page + 1) / count;
    if (through >= 0.85 || left <= 1) return 'images';
    if (through >= 0.7 || left <= 3) return 'manifest';
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

  /**
   * Where the top of the screen is inside the next chapter's first page, as a
   * fraction of that page -- or null while the screen is still above it.
   * That fraction is where the next chapter opens, so the switch is invisible.
   */
  function handoffOffset(scrollTop, pageTop, pageHeight) {
    if (!(pageHeight > 0) || !(scrollTop >= pageTop - 1)) return null;
    return Math.min(0.995, Math.max(0, (scrollTop - pageTop) / pageHeight));
  }

  /**
   * A chapter's name when it says more than its number. Sources fill the
   * field with "12", "Chapter 12", "Ch. 12" or "Episode 12" as often as with
   * a title, and "Chapter 1194 / Chapter 1194" is a line saying nothing twice.
   */
  function realName(name, number) {
    const text = String(name || '').trim();
    if (!text) return '';
    const n = String(number ?? '').trim();
    if (text === n) return '';
    const bare = text.replace(/^(?:chapter|ch\.?|episode|ep\.?)\s*/i, '').replace(/[\s:.\-–—]+$/, '');
    return bare === n ? '' : text;
  }

  /** "Chapter 13 · Name" for a chapter id, from the series the reader loaded. */
  function chapterName(series, chapterId) {
    const chapter = series?.chapters?.find?.((c) => c.id === chapterId);
    if (!chapter) return { number: '', name: '' };
    return {
      number: chapter.number != null ? `Chapter ${chapter.number}` : '',
      name: realName(chapter.name, chapter.number),
    };
  }

  /* --- doing it ------------------------------------------------------------ */

  const reader = () => (browser && location.pathname.startsWith('/read/') ? globalThis.__yomuReader : null);
  const settings = () => globalThis.YomuReaderSettings;
  const continuous = () => settings()?.prefs?.continuous ?? true;
  const constrained = () => {
    const c = browser ? navigator.connection : null;
    return !!c?.saveData || /(^|-)2g$/.test(String(c?.effectiveType || '')) || settings()?.prefs?.quality === 'saver';
  };

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
      const timeout = setTimeout(done, 12000);
      inFlight.add(done);
      img.onload = done;
      img.onerror = done;
      img.src = uri;
    }
  }

  function resolve(r, page) {
    try { return page ? settings()?.uri(r.adapter, page) || r.adapter.resolveImageUri(page) : null; } catch { return null; }
  }

  /** Extra pages past the mounted window, by how fast pages are arriving here. */
  function extraAhead() {
    if (constrained()) return 0;
    const byConnection = aheadCount(browser ? navigator.connection : null);
    const speed = settings()?.speed?.() || 'unknown';
    const byPace = speed === 'fast' ? 3 : speed === 'normal' ? 2 : speed === 'slow' ? 0 : 1;
    return Math.min(byConnection, byPace);
  }

  /* The next chapter, fetched once per (source, chapter). */
  const next = { key: '', promise: null, manifest: null, warmed: false, fetchedAt: 0 };

  function handoff() {
    return (globalThis.__yomuManifestHandoff ||= new Map());
  }

  /* The bundle only takes a handed-off manifest younger than two minutes, and
     a chapter takes longer than that to read, so a manifest fetched at 70%
     was usually stale by the end and fetched again -- the "instant" next
     chapter was not. It is fetched again when warming starts if it has aged,
     and re-stamped when the reader moves on if it is younger than this. Image
     links in a manifest can be signed (MangaDex's are good for fifteen
     minutes), which is the ceiling. */
  const HANDOFF_REFRESH_MS = 90 * 1000;
  const HANDOFF_TRUST_MS = 8 * 60 * 1000;

  function prepareNext(r, stage) {
    if (!r.next || stage === 'none') return;
    const key = `${r.source}|${r.next}`;
    const entry = handoff().get(key);
    const aged = next.key === key && stage === 'images' && (!entry || Date.now() - entry.at > HANDOFF_REFRESH_MS) && next.fetchedAt && Date.now() - next.fetchedAt > HANDOFF_REFRESH_MS;
    if (next.key !== key || aged) {
      if (next.key !== key) { next.warmed = false; next.manifest = null; }
      next.key = key;
      next.fetchedAt = Date.now();
      let promise;
      try { promise = Promise.resolve(r.adapter.getManifest(r.next)); } catch (error) { promise = Promise.reject(error); }
      next.promise = promise;
      handoff().set(key, { at: Date.now(), promise });
      for (const [id, value] of handoff()) if (Date.now() - value.at > 120000 || (handoff().size > 3 && id !== key)) handoff().delete(id);
      promise.then((manifest) => { if (next.key === key) { next.manifest = manifest; next.fetchedAt = Date.now(); paintTail(); } }).catch(() => {});
      promise.catch(() => { handoff().delete(key); if (next.key === key) { next.key = ''; next.promise = null; } });
      try { performance.mark(`reader:prefetch:manifest:${r.next}`); } catch {}
    }
    if (stage === 'images' && !next.warmed) {
      next.warmed = true;
      const adapter = r.adapter;
      const count = constrained() ? (continuous() ? 1 : 0) : 3;
      next.promise.then((manifest) => {
        if (next.key !== key || reader()?.chapterId !== r.chapterId) return;
        for (const page of (manifest?.pages || []).slice(0, count)) warm(resolve({ adapter }, page));
      }).catch(() => {});
    }
  }

  /* --- below the last page --------------------------------------------------- */

  const TAIL_ATTR = 'data-yomu-next';
  let advancing = false;

  const scroller = () => {
    for (const el of document.querySelectorAll('[data-testid="reader-scroll"]')) if (el.clientHeight > 0) return el;
    return null;
  };

  function removeTail() {
    document.querySelectorAll(`[${TAIL_ATTR}]`).forEach((node) => node.remove());
  }

  function button(className, text, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = text;
    b.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    return b;
  }

  function goNext() {
    const r = reader();
    if (!r?.next || advancing) return;
    advancing = true;
    const key = `${r.source}|${r.next}`;
    if (next.manifest && next.key === key && Date.now() - next.fetchedAt < HANDOFF_TRUST_MS) {
      handoff().set(key, { at: Date.now(), promise: Promise.resolve(next.manifest) });
    }
    Promise.resolve(r.navigate?.(r.next)).catch(() => { advancing = false; });
  }

  function backToSeries() {
    document.querySelector('.rd-head .rd-icon[aria-label="Back to the series"]')?.click();
  }

  /** The card below a chapter when it does not run on into the next one. */
  function buildCard(r) {
    const here = chapterName(r.series, r.chapterId);
    const section = document.createElement('section');
    section.setAttribute(TAIL_ATTR, 'card');
    section.className = 'yomu-next yomu-next--card';
    const done = document.createElement('small');
    done.className = 'yomu-next__done';
    done.textContent = here.number ? `End of ${here.number}` : 'End of chapter';
    section.append(done);
    if (r.next) {
      const upcoming = chapterName(r.series, r.next);
      const go = button('yomu-next__go', '', goNext);
      const label = document.createElement('span');
      label.textContent = 'Next';
      const title = document.createElement('strong');
      title.textContent = upcoming.number || 'Next chapter';
      go.append(label, title);
      if (upcoming.name) { const name = document.createElement('small'); name.textContent = upcoming.name; go.append(name); }
      section.append(go);
    } else {
      const caught = document.createElement('p');
      caught.className = 'yomu-next__caught';
      caught.textContent = 'You are caught up with this title.';
      section.append(caught);
    }
    section.append(button('yomu-next__back', 'Back to the series', backToSeries));
    return section;
  }

  /** The next chapter's first page, below this chapter's last. */
  function buildPreview(r, manifest) {
    const upcoming = chapterName(r.series, r.next);
    const here = chapterName(r.series, r.chapterId);
    const section = document.createElement('section');
    section.setAttribute(TAIL_ATTR, 'preview');
    section.setAttribute('data-next-chapter-preview', r.next);
    section.className = 'yomu-next yomu-next--preview';
    const divider = document.createElement('div');
    divider.className = 'yomu-next__divider';
    const done = document.createElement('small');
    done.textContent = here.number ? `End of ${here.number}` : 'End of chapter';
    const title = document.createElement('strong');
    title.textContent = upcoming.number || 'Next chapter';
    divider.append(done, title);
    if (upcoming.name) { const name = document.createElement('span'); name.textContent = upcoming.name; divider.append(name); }
    section.append(divider);

    const first = manifest.pages[0];
    const holder = document.createElement('div');
    holder.className = 'yomu-next__page';
    const el = scroller();
    const width = Math.min(el?.clientWidth || innerWidth, settings()?.prefs?.width || 900);
    holder.style.width = `${width}px`;
    if (!constrained()) {
      const img = document.createElement('img');
      img.alt = `${upcoming.number || 'Next chapter'}, page 1`;
      img.decoding = 'async';
      img.src = resolve(r, first);
      img.addEventListener('load', () => section.setAttribute('data-ready', '1'), { once: true });
      holder.append(img);
    }
    section.append(holder);
    /* Room below it. The hand-over happens when this page reaches the top of
       the screen, and a page shorter than the screen with nothing under it
       can never get there -- on a phone the reader would stop at the end of
       the strip for good, looking at the next chapter and unable to reach it. */
    const room = document.createElement('div');
    room.className = 'yomu-next__room';
    room.style.height = `${Math.max(0, (el?.clientHeight || innerHeight))}px`;
    section.append(room);
    return section;
  }

  /** What belongs below the pages now; built once per chapter and state. */
  function paintTail() {
    const r = reader();
    const root = scroller();
    if (!r || !root || r.mode !== 'scroll' || !(r.count > 0)) { removeTail(); return; }
    const wantPreview = continuous() && !!r.next && !!next.manifest?.pages?.length && next.key === `${r.source}|${r.next}`;
    const kind = wantPreview ? 'preview' : 'card';
    const tag = `${kind}|${r.source}|${r.chapterId}|${r.next || ''}`;
    let tail = root.querySelector(`:scope > [${TAIL_ATTR}]`);
    if (tail && tail.dataset.yomuTag !== tag) { tail.remove(); tail = null; }
    if (!tail) {
      removeTail();
      tail = wantPreview ? buildPreview(r, next.manifest) : buildCard(r);
      tail.dataset.yomuTag = tag;
      root.append(tail);
    } else if (tail.nextElementSibling) {
      /* Something was mounted after it (the Circle thread): the next chapter
         stays last. Moved only when out of place, so nothing fights. */
      root.append(tail);
    }
  }

  function resumeKey(seriesId) {
    return `yomu.v1.resume.local-account.${seriesId}`;
  }

  /**
   * Into the next chapter at the spot on screen. The position is written as
   * the next chapter's resume anchor -- after this chapter's own save, which
   * would otherwise overwrite it -- and the reader restores anchors exactly.
   */
  async function advanceAt(r, offset) {
    advancing = true;
    const manifest = next.manifest;
    const first = manifest?.pages?.[0];
    try {
      await r.flush?.();
      if (first && offset > 0.001) {
        localStorage.setItem(resumeKey(r.seriesId), JSON.stringify({
          sourceSeriesId: r.seriesId,
          anchor: {
            schema: 'yomu.reading-anchor/1',
            chapterId: r.next,
            pageKey: first.key,
            pageIndex: 0,
            offsetInPage: offset,
            manifestVersion: String(manifest.manifestVersion || ''),
            pageListVersion: Number(manifest.pageListVersion || 0),
            updatedAtLocal: Date.now(),
          },
        }));
      }
    } catch {}
    /* Handed over fresh, so the reader opens it without asking again. */
    const key = `${r.source}|${r.next}`;
    if (manifest && next.key === key && Date.now() - next.fetchedAt < HANDOFF_TRUST_MS) {
      handoff().set(key, { at: Date.now(), promise: Promise.resolve(manifest) });
    }
    try { performance.mark('reader:continuous'); } catch {}
    Promise.resolve(r.navigate?.(r.next)).catch(() => { advancing = false; });
  }

  function maybeAdvance(el, r) {
    if (advancing || r.sheet || r.mode !== 'scroll' || !continuous() || !r.next) return;
    const tail = el.querySelector(':scope > [data-yomu-next="preview"]');
    if (!tail) return;
    const holder = tail.querySelector('.yomu-next__page');
    const img = holder?.querySelector('img');
    const top = tail.offsetTop + (holder ? holder.offsetTop : tail.offsetHeight);
    /* No image (Data saver): the divider leaving the screen is the moment. */
    const height = img && img.naturalWidth > 0 ? holder.offsetHeight : 0;
    const offset = height ? handoffOffset(el.scrollTop, top, height) : (el.scrollTop >= top - 1 ? 0 : null);
    if (offset == null) return;
    advanceAt(r, offset);
  }

  /* --- the counter left on screen while the chrome is away ----------------- */

  function showProgress(r) {
    let badge = document.querySelector('.yomu-reader-progress');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'yomu-reader-progress';
      badge.setAttribute('aria-hidden', 'true');
      document.body.append(badge);
    }
    const text = r.count > 0 ? `${Math.min(r.page + 1, r.count)} / ${r.count}` : '';
    if (badge.textContent !== text) badge.textContent = text;
    const away = r.chrome === false && !!text;
    if (badge.classList.contains('is-on') !== away) badge.classList.toggle('is-on', away);
    /* The desktop rail follows the chrome (yomu-overrides.css). */
    const state = r.chrome === false ? 'away' : 'here';
    if (document.documentElement.getAttribute('data-yomu-reader') !== state) document.documentElement.setAttribute('data-yomu-reader', state);
  }

  function onReader() {
    const r = reader();
    if (!r || !r.chapterId) return;
    const chapterKey = `${r.source}|${r.chapterId}`;
    if (warmedFor !== chapterKey) {
      warmedFor = chapterKey;
      warmed.clear();
      queue.length = 0;
      [...inFlight].forEach((cancel) => cancel());
      advancing = false;
      removeTail();
    }

    const extra = extraAhead();
    if (extra > 0 && r.count > 0) {
      const range = settings()?.windowRange?.(r.page, r.count, r.pages, null);
      const end = range && range.end >= r.page ? range.end : r.page + MOUNT_RADIUS;
      for (const index of aheadPages(r.page, r.count, extra, end)) warm(resolve(r, r.pages?.[index]));
    }
    prepareNext(r, nextChapterStage(r.page, r.count));
    showProgress(r);
    if (r.count > 0 && (r.page + 1) / r.count >= 0.5) paintTail();
  }

  let chrome = null;
  let lastIntentAt = 0;
  function onScroll(event) {
    const el = event.target;
    if (!el || el.nodeType !== 1 || el.getAttribute('data-testid') !== 'reader-scroll') return;
    const r = reader();
    if (!r) return;
    maybeAdvance(el, r);
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
    addEventListener('yomu:reader-settings', () => { removeTail(); onReader(); });
    /* Leaving the reader takes the counter and the tail with it. */
    addEventListener('yomu:route', () => {
      if (reader()) return;
      document.querySelector('.yomu-reader-progress')?.remove();
      document.documentElement.removeAttribute('data-yomu-reader');
      removeTail();
    });
    new MutationObserver(() => {
      if (!reader() && document.querySelector('.yomu-reader-progress')) document.querySelector('.yomu-reader-progress')?.remove();
    }).observe(document.body || document.documentElement, { childList: true });
    onReader(); /* loaded after the reader's last render: do not wait for the next */
  }

  if (typeof window !== 'undefined') {
    window.YomuReaderPlus = { aheadCount, aheadPages, nextChapterStage, chromeStep, handoffOffset, chapterName, realName };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { aheadCount, aheadPages, nextChapterStage, chromeStep, handoffOffset, chapterName, realName, SHOW_AFTER, HIDE_AFTER };
  }
})();
