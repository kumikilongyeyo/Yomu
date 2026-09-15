/**
 * The desktop sidebar from the approved kit.
 *
 * Everything else in the kit was a restyle of structure the app already had --
 * hero, filters, cover grid, badges, save button -- and went into
 * yomu-overrides.css. The sidebar is the one piece with no counterpart: Yomu
 * navigates from a floating dock at the bottom on every width, where the kit
 * puts a 184px rail on desktop and keeps the dock for phones.
 *
 * It is built here rather than in the bundle because it is new DOM, not a
 * changed value, and because it lives outside React's tree: appended to
 * <body>, it is never a child of anything the app re-renders, so there is
 * nothing to race and no MutationObserver to keep it alive.
 *
 * Routes are the app's real ones. The kit's board also shows Collections;
 * Yomu has no such route, and a nav item that goes nowhere is worse than one
 * that is missing, so it is not invented here.
 *
 * When the Expo source turns up this belongs in app/_layout.tsx beside the
 * Dock; delete this file then.
 */
(() => {
  'use strict';

  const ID = 'yomu-sidebar';

  const ITEMS = [
    { href: '/', label: 'Home', icon: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5' },
    { href: '/find.html', label: 'Discover', icon: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35' },
    { href: '/library', label: 'Library', icon: 'M4 4h6v16H4zM14 4h6v16h-6z' },
    { href: '/settings', label: 'Settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 0 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 0 1 0-4 1.7 1.7 0 0 0 1.5-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 0 1 4 0a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 0 1 0 4Z' },
  ];

  /** The item a path belongs to. The reader and series pages sit under Home. */
  function activeHref(pathname) {
    if (pathname.startsWith('/find') || pathname.startsWith('/search')) return '/find.html';
    if (pathname.startsWith('/library') || pathname.startsWith('/downloads')) return '/library';
    if (pathname.startsWith('/settings') || pathname.startsWith('/sources')
        || pathname.startsWith('/extensions') || pathname.startsWith('/suwayomi')) return '/settings';
    return '/';
  }

  function build() {
    const nav = document.createElement('nav');
    nav.id = ID;
    nav.setAttribute('aria-label', 'Main');

    const brand = document.createElement('a');
    brand.className = 'yomu-sidebar__brand';
    brand.href = '/';
    brand.setAttribute('aria-label', 'Yomu home');
    nav.append(brand);

    const current = activeHref(location.pathname);
    for (const item of ITEMS) {
      const link = document.createElement('a');
      link.href = item.href;
      link.className = 'yomu-sidebar__item' + (item.href === current ? ' is-active' : '');
      if (item.href === current) link.setAttribute('aria-current', 'page');
      link.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        `<path d="${item.icon}"></path></svg><span></span>`;
      link.querySelector('span').textContent = item.label;
      nav.append(link);
    }

    const note = document.createElement('p');
    note.className = 'yomu-sidebar__note';
    note.textContent = 'Read more worlds.';
    nav.append(note);

    return nav;
  }

  /* ------------------------------------------------------------------ *
   * Completed seal
   *
   * The app computes only two freshness states, "New chapter" and "Updated",
   * so the grid could only ever show one of the kit's four tabs. It does know
   * whether a series is finished -- every tile carries an Ongoing / Completed
   * / Hiatus status -- and that is the Completed seal. Read here because CSS
   * cannot match on text; drawn in yomu-overrides.css.
   * ------------------------------------------------------------------ */
  function tagCompleted() {
    for (const tile of document.querySelectorAll('.tile-card:not([data-yomu-tag])')) {
      const status = tile.querySelector('.tile-card__status');
      if (!status) continue;
      if (/^\s*completed\s*$/i.test(status.textContent || '')) tile.setAttribute('data-yomu-tag', 'completed');
      else tile.setAttribute('data-yomu-tag', '');
    }
  }

  /* ------------------------------------------------------------------ *
   * Reading index
   *
   * Yomu records where you stopped in
   *   yomu.v1.resume.<account>.<seriesId>  ->  { anchor: { chapterId, pageIndex } }
   * and which chapters are finished in the sibling ".read" key. Between them
   * that is the position and nothing else: no title, no cover, no source. To
   * draw a card you need those three, and both existing surfaces go hunting
   * for them somewhere they are not reliably kept.
   *
   * That is the whole reason Continue Reading kept vanishing. The shell's own
   * row looked the title up in the library, so reading something without
   * saving it drew nothing -- the position was there the entire time. The
   * app's built-in card is worse again: it maps readResume over the discovery
   * feed, never over listSeriesWithProgress, so it appears only when a source
   * happens to return that title in its first eighteen results this minute.
   *
   * So the reader writes down what is on screen in front of it -- title,
   * chapter, page and page count -- plus the cover, which only a series page
   * can see. One key, one small write per position change, and the row becomes
   * answerable from storage alone: no library row needed, no source reachable,
   * nothing to lose by quitting.
   *
   * This belongs beside ProgressStore in the Expo source; it is out here
   * because that source was never handed over.
   * ------------------------------------------------------------------ */

  const RESUME_PREFIX = 'yomu.v1.resume.local-account.';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const READING_KEY = 'yomu.v1.reading';
  const ADULT_TITLES_KEY = 'yomu.v1.adultTitles';
  const CONTINUE_ID = 'yomu-continue';
  const MAX_CARDS = 6;
  const READING_MAX = 30;
  const HOLD_MS = 2000;

  /** Series ids picked for removal, or null when not selecting. */
  let selection = null;

  // Read by the bundle while it renders its own Continue card, which is why it
  // is set here at load rather than when the row mounts: the app must know the
  // shell is present before its first paint, or the two flash over each other.
  // Left as a flag rather than deleting the app's card, so that if this file
  // ever fails to load the old card still appears on the days it can.
  globalThis.__yomuContinue = true;

  function readJSON(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  /** "<sourceId>:<seriesId>" -- the key find.html and the 18+ gate already use. */
  const titleKey = (sourceId, seriesId) => sourceId + ':' + seriesId;

  function library() {
    const collection = readJSON(COLLECTION_KEY, null);
    return Array.isArray(collection && collection.library) ? collection.library : [];
  }

  /**
   * Titles a provider rated adult, as recorded by find.html. Home is a normal
   * surface, so nothing on this list belongs on it -- not even something you
   * were part-way through. 18+ has its own page.
   */
  function adultTitles() {
    const raw = readJSON(ADULT_TITLES_KEY, []);
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  }

  const readingIndex = () => {
    const value = readJSON(READING_KEY, null);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  };

  /**
   * Fold what we just learned into the record for one title.
   *
   * Only truthy fields overwrite, so a cover learned on the series page
   * survives every later write from the reader, which has no cover to offer.
   */
  function noteReading(patch) {
    if (!patch || !patch.seriesId || !patch.sourceId) return;
    const index = readingIndex();
    const key = titleKey(patch.sourceId, patch.seriesId);
    const before = index[key] || {};
    const after = { ...before };
    for (const [field, value] of Object.entries(patch)) {
      if (value !== '' && value != null) after[field] = value;
    }

    // The reader calls this on every observer tick and localStorage writes are
    // synchronous, so nothing is written when only the clock would move.
    const settled = Object.keys(after).every((f) => after[f] === before[f]);
    if (settled && before.at) return;
    after.at = Date.now();
    index[key] = after;

    // Trimmed newest-first, so the cap eats old history rather than the thing
    // being read right now.
    const keys = Object.keys(index).sort((a, b) => (index[b].at || 0) - (index[a].at || 0));
    for (const stale of keys.slice(READING_MAX)) delete index[stale];
    writeJSON(READING_KEY, index);
  }

  function dropReading(seriesIds) {
    const wanted = new Set(seriesIds);
    const index = readingIndex();
    let touched = false;
    for (const [key, record] of Object.entries(index)) {
      if (!record || !wanted.has(record.seriesId)) continue;
      delete index[key];
      touched = true;
    }
    if (touched) writeJSON(READING_KEY, index);
  }

  /* --- finished chapters ------------------------------------------------ *
   *
   * Written in the app's own shape under the app's own key, so the series
   * screen -- which already reads it and already draws a tick -- picks these
   * up without knowing the shell exists.
   *
   * Nothing wrote it on web. markChapterRead is called from the native reader
   * screen only; the web reader passes reportPosition straight through. So
   * every chapter list has been blank no matter how much you had read.
   * -------------------------------------------------------------------- */

  const readKey = (seriesId) => RESUME_PREFIX + seriesId + '.read';

  function readChapters(seriesId) {
    const raw = readJSON(readKey(seriesId), []);
    return new Set(Array.isArray(raw) ? raw.filter((c) => typeof c === 'string') : []);
  }

  function markChapterRead(seriesId, chapterId) {
    const done = readChapters(seriesId);
    if (done.has(chapterId)) return false;
    done.add(chapterId);
    writeJSON(readKey(seriesId), [...done]);
    return true;
  }

  /* --- what Continue Reading draws -------------------------------------- */

  function resumeEntries() {
    const out = [];
    let keys;
    try { keys = Object.keys(localStorage); } catch { return out; }
    for (const key of keys) {
      if (!key.startsWith(RESUME_PREFIX) || key.endsWith('.read')) continue;
      const value = readJSON(key, null);
      const anchor = value && value.anchor;
      if (!anchor || typeof anchor.chapterId !== 'string') continue;
      out.push({ seriesId: key.slice(RESUME_PREFIX.length), anchor });
    }
    return out;
  }

  /**
   * The index first, because it can answer on its own. Then anything the index
   * has not seen but the library can identify, so positions recorded before
   * any of this existed still draw a card instead of silently dropping.
   */
  function continueItems() {
    const blocked = adultTitles();
    const saved = library();
    const byId = new Map();

    const hiddenOrAdult = (entry, sourceId, seriesId) =>
      blocked.has(titleKey(sourceId, seriesId))
      || (entry && (entry.hidden || String(entry.category || '').toLowerCase() === 'adult'));

    for (const record of Object.values(readingIndex())) {
      if (!record || !record.seriesId || !record.sourceId || !record.chapterId) continue;
      const entry = saved.find((t) => String(t.id) === record.seriesId);
      if (hiddenOrAdult(entry, record.sourceId, record.seriesId)) continue;
      const pages = Number(record.pages) || 0;
      const page = Number(record.page) || 0;
      byId.set(record.seriesId, {
        seriesId: record.seriesId,
        sourceId: record.sourceId,
        title: record.title || (entry && entry.title) || 'Untitled',
        cover: record.cover || (entry && entry.cover) || '',
        chapterId: record.chapterId,
        chapterLabel: record.chapterLabel || '',
        percent: pages > 0 ? Math.min(100, Math.round(page / pages * 100)) : null,
        at: Number(record.at) || 0,
      });
    }

    for (const { seriesId, anchor } of resumeEntries()) {
      if (byId.has(seriesId)) continue;
      const entry = saved.find((t) => String(t.id) === seriesId);
      if (!entry || !entry.sourceId) continue;
      if (hiddenOrAdult(entry, entry.sourceId, seriesId)) continue;
      byId.set(seriesId, {
        seriesId,
        sourceId: entry.sourceId,
        title: entry.title || 'Untitled',
        cover: entry.cover || '',
        chapterId: anchor.chapterId,
        chapterLabel: '',
        // No percentage for these. The anchor carries pageIndex but not a page
        // count -- pageListVersion is a manifest version, not a total, and
        // reading it as one is what used to print "3200% through". Once the
        // title is opened again the index has the real count.
        percent: null,
        at: Number(anchor.updatedAtLocal) || 0,
      });
    }

    return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, MAX_CARDS);
  }

  /* --- selection ------------------------------------------------------- */

  function forget(seriesIds) {
    for (const id of seriesIds) {
      try { localStorage.removeItem(RESUME_PREFIX + id); } catch {}
    }
    dropReading(seriesIds);
  }

  const inSelection = () => selection !== null;

  function toggleSelected(seriesId) {
    if (!selection) return;
    if (selection.has(seriesId)) selection.delete(seriesId);
    else selection.add(seriesId);
    if (!selection.size) selection = null;
    mountContinue();
  }

  /* --- rendering ------------------------------------------------------- */

  /**
   * Press and hold for two seconds to start picking cards to remove.
   *
   * A hold rather than a tap because the card's whole job is to be tapped, and
   * because this deletes reading position -- the one thing here that reopening
   * the title will not bring back. The card fills while held, so the wait is
   * visible and letting go plainly cancels it. Holding drops straight into
   * selection with that card already picked, so removing several is the same
   * gesture plus taps.
   */
  function attachHold(card, item) {
    let timer = null;
    const stop = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      card.classList.remove('is-holding');
    };
    card.addEventListener('pointerdown', (event) => {
      if (inSelection() || (event.button != null && event.button !== 0)) return;
      card.classList.add('is-holding');
      timer = setTimeout(() => {
        stop();
        selection = new Set([item.seriesId]);
        mountContinue();
      }, HOLD_MS);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
      card.addEventListener(type, stop);
    }
  }

  function buildCard(item) {
    const card = document.createElement('article');
    card.className = 'yomu-continue__card';

    const cover = document.createElement('div');
    cover.className = 'yomu-continue__cover';
    if (item.cover) cover.style.backgroundImage = 'url("' + item.cover + '")';

    const info = document.createElement('div');
    info.className = 'yomu-continue__info';

    const name = document.createElement('strong');
    name.textContent = item.title;

    const meta = document.createElement('small');
    meta.textContent = [
      item.chapterLabel || null,
      item.percent == null ? null : item.percent + '%',
    ].filter(Boolean).join(' · ') || 'In progress';

    const bar = document.createElement('progress');
    if (item.percent == null) bar.removeAttribute('value');
    else { bar.max = 100; bar.value = item.percent; }

    const go = document.createElement('a');
    go.className = 'yomu-continue__go';
    go.href = '/read/' + encodeURIComponent(item.chapterId)
      + '?source=' + encodeURIComponent(item.sourceId);
    go.textContent = 'Continue Chapter →';

    info.append(name, meta, bar, go);
    card.append(cover, info);

    if (inSelection()) {
      const picked = selection.has(item.seriesId);
      card.classList.add('is-selecting');
      card.classList.toggle('is-picked', picked);
      card.setAttribute('role', 'checkbox');
      card.setAttribute('aria-checked', String(picked));
      card.setAttribute('aria-label', item.title);
      card.tabIndex = 0;

      const mark = document.createElement('span');
      mark.className = 'yomu-continue__check';
      mark.setAttribute('aria-hidden', 'true');
      card.append(mark);

      // While picking, the card is a checkbox -- nothing navigates.
      go.setAttribute('aria-hidden', 'true');
      go.tabIndex = -1;
      card.addEventListener('click', (event) => {
        event.preventDefault();
        toggleSelected(item.seriesId);
      });
      card.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggleSelected(item.seriesId);
      });
    } else {
      attachHold(card, item);
    }

    return card;
  }

  function buildBar(items) {
    const bar = document.createElement('div');
    bar.className = 'yomu-continue__bar';

    const count = document.createElement('span');
    count.className = 'yomu-continue__count';
    count.textContent = selection.size + ' selected';

    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'yomu-continue__quiet';
    const everything = selection.size === items.length;
    all.textContent = everything ? 'Select none' : 'Select all';
    all.addEventListener('click', () => {
      selection = everything ? null : new Set(items.map((i) => i.seriesId));
      mountContinue();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'yomu-continue__danger';
    remove.textContent = 'Remove ' + selection.size;
    remove.addEventListener('click', () => {
      forget([...selection]);
      selection = null;
      mountContinue();
    });

    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'yomu-continue__quiet';
    done.textContent = 'Done';
    done.addEventListener('click', () => { selection = null; mountContinue(); });

    bar.append(count, all, remove, done);
    return bar;
  }

  function buildContinue(items) {
    const section = document.createElement('section');
    section.id = CONTINUE_ID;
    if (inSelection()) section.classList.add('is-selecting');

    const head = document.createElement('div');
    head.className = 'yomu-continue__head';
    const h2 = document.createElement('h2');
    h2.textContent = 'Continue Reading';
    head.append(h2);

    if (inSelection()) {
      const hint = document.createElement('span');
      hint.className = 'yomu-continue__all';
      hint.textContent = 'Tap cards to pick';
      head.append(hint);
    } else {
      const all = document.createElement('a');
      all.href = '/library';
      all.className = 'yomu-continue__all';
      all.textContent = 'See All →';
      head.append(all);
    }

    const row = document.createElement('div');
    row.className = 'yomu-continue__row';
    for (const item of items) row.append(buildCard(item));

    section.append(head, row);
    if (inSelection()) section.append(buildBar(items));
    return section;
  }

  /**
   * Where the row goes.
   *
   * Under the hero, which is where the kit puts it -- anchored to the hero
   * rather than to the section below it, because the app grows a "Your
   * library" section once anything is saved, so "the first .home-sec" is not a
   * stable position.
   *
   * But the hero *is* the discovery feed, and the feed is the first thing to
   * fail when a source is down or the phone is offline. Anchoring to it alone
   * meant the one section on this page that needs no network was the one that
   * vanished with the network -- which is most of why Continue Reading kept
   * disappearing. With no hero the row goes to the top of the page, above the
   * "no source could be reached" box: what you were reading matters more than
   * the reason the grid below it is empty.
   */
  function continueAnchor() {
    const hero = document.querySelector('.hero-pagination')
      ?? document.querySelector('.hero-carousel');
    if (hero && hero.parentNode) return { parent: hero.parentNode, after: hero };
    const main = document.querySelector('.g-main');
    return main ? { parent: main, after: null } : null;
  }

  function mountContinue() {
    // Home only. The kit places the row directly under the featured hero.
    if (location.pathname !== '/' && location.pathname !== '/index.html') return;

    const anchor = continueAnchor();
    if (!anchor) return;

    const items = continueItems();
    let section = document.getElementById(CONTINUE_ID);
    if (!items.length) { selection = null; section?.remove(); return; }

    // A card that vanished while it was picked must not keep the bar alive.
    if (selection) {
      const live = new Set(items.map((i) => i.seriesId));
      for (const id of [...selection]) if (!live.has(id)) selection.delete(id);
      if (!selection.size) selection = null;
    }

    const signature = items.map((i) => i.chapterId + ':' + i.percent).join('|')
      + '#' + (selection ? [...selection].sort().join(',') : '');
    if (!section || section.dataset.signature !== signature) {
      const built = buildContinue(items);
      built.dataset.signature = signature;
      section?.remove();
      section = built;
    }
    // Re-asserted on every tick: React re-renders .g-main, which leaves an
    // unmanaged node wherever it likes.
    const placed = section.parentNode === anchor.parent && (anchor.after
      ? section.previousElementSibling === anchor.after
      : anchor.parent.firstElementChild === section);
    if (!placed) {
      if (anchor.after) anchor.after.after(section);
      else anchor.parent.prepend(section);
    }
  }


  /* ------------------------------------------------------------------ *
   * Watching the reader
   *
   * Everything the index needs is already on screen while you read: the title
   * in the header, "Chapter 41" beneath it, "23 / 78" in the dock. Rather than
   * reach into React's state the shell reads its output -- the same surface a
   * person is looking at, so what gets stored cannot disagree with what they
   * saw.
   *
   * The series id is not on screen and does not need to be. The reader's URL
   * is /read/<chapterId>?source=<sourceId>, and a chapterId is
   * "<seriesId>:<rest>" -- the app splits it the same way.
   * ------------------------------------------------------------------ */

  function routeContext(prefix) {
    if (!location.pathname.startsWith(prefix)) return null;
    const raw = location.pathname.slice(prefix.length);
    if (!raw) return null;
    let id = raw;
    try { id = decodeURIComponent(raw); } catch {}
    const sourceId = new URLSearchParams(location.search).get('source') || '';
    return id && sourceId ? { id, sourceId } : null;
  }

  function readerContext() {
    const route = routeContext('/read/');
    if (!route) return null;
    return { chapterId: route.id, seriesId: route.id.split(':')[0], sourceId: route.sourceId };
  }

  function seriesPageContext() {
    const route = routeContext('/series/');
    return route ? { seriesId: route.id, sourceId: route.sourceId } : null;
  }

  /** The address inside background-image: url("..."), or ''. */
  function backgroundUrl(element) {
    const raw = element && element.style && element.style.backgroundImage;
    const match = /^url\((['"]?)(.*)\1\)$/.exec(String(raw || '').trim());
    return match ? match[2] : '';
  }

  /** "23 / 78" -> { page: 23, pages: 78 } */
  function dockCount() {
    const match = /(\d+)\s*\/\s*(\d+)/.exec(
      document.querySelector('.rd-count')?.textContent || '',
    );
    return match ? { page: Number(match[1]), pages: Number(match[2]) } : null;
  }

  /**
   * The cover, which is the one thing the reader never sees.
   *
   * Recorded on the way past rather than only for titles already being read,
   * because the way past is the normal route: series page, tap a chapter,
   * reader. Waiting for a position would mean the first card a title ever
   * draws is the one without a picture.
   */
  function trackSeriesPage() {
    const context = seriesPageContext();
    if (!context) return;
    const cover = backgroundUrl(document.querySelector('.cover'));
    const title = document.querySelector('.page-heading h1, h1')?.textContent?.trim() || '';
    if (!cover && !title) return;
    noteReading({ ...context, cover, title });
  }

  /** Chapters marked read in this document already, to skip the storage read. */
  const markedRead = new Set();

  /**
   * Whether the chapter has been read to the end.
   *
   * Not "the counter reached the last page", which is the obvious test and is
   * wrong. The counter names the last page whose top has passed the top of the
   * viewport, so on any chapter whose final page is shorter than the screen it
   * stops one short -- an 18 page chapter sits at "17 / 18" with the last page
   * fully visible and the scroll at its maximum. Marking on the counter would
   * mean those chapters were never marked at all.
   *
   * The scroll position has no such edge: reaching the bottom is reaching the
   * bottom. The tolerance covers sub-pixel heights and elastic overscroll.
   */
  function atChapterEnd() {
    const scroller = document.querySelector('[data-testid="reader-scroll"]');
    if (!scroller) return false;
    const room = scroller.scrollHeight - scroller.clientHeight;
    // Nothing to scroll means the whole chapter is already on screen. That is
    // still having seen it, but only once the pages are actually laid out.
    if (room <= 0) return scroller.scrollHeight > 0;
    return scroller.scrollTop >= room - 24;
  }

  function trackReader() {
    const context = readerContext();
    if (!context) return;

    const title = document.querySelector('.rd-head__copy h1')?.textContent?.trim() || '';
    const count = dockCount();

    noteReading({
      ...context,
      // "Loading…" is the placeholder the header shows before the series
      // arrives. Storing it would name the card after the spinner.
      title: /^loading/i.test(title) ? '' : title,
      chapterLabel: document.querySelector('.rd-head__copy p')?.textContent?.trim() || '',
      page: count ? count.page : null,
      pages: count ? count.pages : null,
    });

    if (!count || count.pages <= 0 || !atChapterEnd()) return;
    const seen = context.seriesId + ' ' + context.chapterId;
    if (markedRead.has(seen)) return;
    markedRead.add(seen);
    markChapterRead(context.seriesId, context.chapterId);
  }

  // Scrolling to the foot of the last page changes no markup, so the mutation
  // observer never runs and the chapter goes unmarked. Capture phase because a
  // scroll event does not bubble; coalesced to a frame because this fires at
  // the rate of the scroll.
  let scrollQueued = false;
  document.addEventListener('scroll', () => {
    if (scrollQueued || !inReader()) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; trackReader(); });
  }, true);


  /* ------------------------------------------------------------------ *
   * Chapters sheet: what a row can say before you open it
   *
   * The sheet listed a number and a name, so the only chapter distinguishable
   * from any other was the one you were on. Now each row carries the cover and
   * says where you are: a tick for finished, a percentage for the one in hand.
   *
   * No source ships per-chapter artwork, so the picture is the series cover
   * panned to a different corner per chapter -- the same trick the series
   * screen already plays with Artwork. It makes a row recognisable at a glance
   * without pretending to be a page out of it.
   *
   * React owns these buttons, so the two extra nodes are appended and placed
   * by flex order rather than inserted among children it is tracking.
   * ------------------------------------------------------------------ */

  /** Stable small integer from a string -- the bundle's own hash, for parity. */
  function hashCode(text) {
    let total = 0;
    for (let i = 0; i < text.length; i++) total = (total * 31 + text.charCodeAt(i)) % 360;
    return total;
  }

  const CORNERS = ['0% 0%', '100% 0%', '0% 100%', '100% 100%'];

  function decorateChapters() {
    const list = document.querySelector('.rd-chapters');
    if (!list) return;
    const context = readerContext();
    if (!context) return;

    const done = readChapters(context.seriesId);
    const record = readingIndex()[titleKey(context.sourceId, context.seriesId)] || {};
    const pages = Number(record.pages) || 0;
    const here = pages > 0 ? Math.min(100, Math.round((Number(record.page) || 0) / pages * 100)) : null;

    for (const button of list.querySelectorAll('button[data-ch]')) {
      const chapterId = button.getAttribute('data-ch') || '';
      const tone = hashCode(chapterId);

      let art = button.querySelector('.yomu-ch__art');
      if (!art) {
        art = document.createElement('i');
        art.className = 'yomu-ch__art';
        art.setAttribute('aria-hidden', 'true');
        button.append(art);
      }
      const picture = record.cover ? 'url("' + record.cover + '")' : '';
      if (art.style.backgroundImage !== picture) art.style.backgroundImage = picture;
      art.style.backgroundPosition = CORNERS[tone % CORNERS.length];
      // Without a cover the tile still has to read as belonging to this
      // chapter rather than as a hole, so it takes a hue from the same hash.
      art.style.setProperty('--tone', String(tone));
      art.classList.toggle('is-empty', !record.cover);

      const current = chapterId === context.chapterId;
      const state = current ? (here == null ? 'Reading' : here + '%')
        : done.has(chapterId) ? '✓' : '';
      const kind = current ? 'now' : done.has(chapterId) ? 'read' : '';

      let mark = button.querySelector('.yomu-ch__state');
      if (!state) { mark?.remove(); continue; }
      if (!mark) {
        mark = document.createElement('em');
        mark.className = 'yomu-ch__state';
        button.append(mark);
      }
      if (mark.textContent !== state) mark.textContent = state;
      if (mark.getAttribute('data-kind') !== kind) mark.setAttribute('data-kind', kind);
    }
  }


  /* ------------------------------------------------------------------ *
   * Progress on a title you meet again
   *
   * "I cannot see my progress when I search for it again" is the same gap as
   * the missing Continue row, one surface along: the position was recorded,
   * nothing on a cover tile ever looked it up. A tile now says which chapter
   * you were on, whether or not the title was ever saved.
   * ------------------------------------------------------------------ */

  function badgeProgress() {
    const tiles = document.querySelectorAll('.tile-card[data-series]');
    if (!tiles.length) return;

    const bySeries = new Map();
    for (const record of Object.values(readingIndex())) {
      if (record && record.seriesId && record.chapterId) bySeries.set(record.seriesId, record);
    }

    for (const tile of tiles) {
      const record = bySeries.get(tile.getAttribute('data-series'));
      let badge = tile.querySelector('.yomu-tile__progress');
      if (!record || !record.chapterLabel) { badge?.remove(); continue; }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'yomu-tile__progress';
        (tile.querySelector('.tile-card__cover') ?? tile).append(badge);
      }
      // A tile is 2:3 and about 150px wide. "Chapter 41" is the header's
      // phrasing and it does not fit here; the abbreviation is the app's own,
      // from tile-card__chapter directly below.
      const label = record.chapterLabel.replace(/^chapter\s+/i, 'Ch. ');
      if (badge.textContent !== label) badge.textContent = label;
    }
  }


  /* ------------------------------------------------------------------ *
   * Tooltips for icon-only buttons
   *
   * Several controls are a bare glyph with an aria-label and no title, so a
   * screen reader is told what they do and a sighted reader is not. The worst
   * of them is the source on/off switch, which draws a checkmark when the
   * source is on -- it reads as "verify this source", which is a different
   * button entirely ("Check sources", at the top of the screen).
   *
   * Copying the label into title costs nothing and makes them hoverable. The
   * labels are the app's own, so this stays correct as they change.
   * ------------------------------------------------------------------ */
  function explainIconButtons() {
    const buttons = document.querySelectorAll(
      '.source-tools button[aria-label]:not([title]), .tile-card__save[aria-label]:not([title])',
    );
    for (const button of buttons) button.title = button.getAttribute('aria-label');
  }


  /* ------------------------------------------------------------------ *
   * Settings: fold the long optional groups away
   *
   * Settings runs to 22 rows across six groups, and two of them are things you
   * set up once and never touch again -- five public-domain and self-hosted
   * source entries under "Free to read", and four developer settings under
   * "Advanced". They are most of the screen's length and almost none of its
   * use, which is what makes it feel like the hardest part of the app.
   *
   * Folded, the screen opens at thirteen rows. Nothing is removed and the
   * state is remembered, so anyone who wants them keeps them open.
   *
   * These belong in the Settings screen's own source; the group is React's, so
   * the marker and the toggle are re-asserted whenever it re-renders.
   * ------------------------------------------------------------------ */

  const FOLDABLE = ['free to read', 'advanced'];
  const FOLD_KEY = 'yomu.v1.settingsOpen';

  const openGroups = () => {
    try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')); } catch { return new Set(); }
  };
  const rememberOpen = (set) => {
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...set])); } catch {}
  };

  /** The group a label heads, plus any explanatory note that trails it. */
  function groupUnder(label) {
    const parts = [];
    let node = label.nextElementSibling;
    while (node) {
      const cls = typeof node.className === 'string' ? node.className : '';
      if (cls.includes('group-label')) break;
      parts.push(node);
      node = node.nextElementSibling;
    }
    return parts;
  }

  function foldSettingsGroups() {
    if (!location.pathname.startsWith('/settings')) return;
    const open = openGroups();

    for (const label of document.querySelectorAll('.group-label')) {
      // Only the label's own text nodes. The toggle is appended into the label,
      // so textContent would grow to include "Show 5" and the group would stop
      // matching its own name on the next pass -- which is why it folded once
      // and then refused to open again.
      const name = [...label.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join('')
        .trim()
        .toLowerCase();
      if (!FOLDABLE.includes(name)) continue;

      const parts = groupUnder(label);
      const group = parts.find((p) => (p.className || '').includes('settings-group'));
      if (!group) continue;

      const isOpen = open.has(name);
      for (const part of parts) if (part.hidden === isOpen) part.hidden = !isOpen;

      let toggle = label.querySelector('.yomu-fold');
      if (!toggle) {
        toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'yomu-fold';
        label.append(toggle);
        toggle.addEventListener('click', () => {
          const now = openGroups();
          if (now.has(name)) now.delete(name); else now.add(name);
          rememberOpen(now);
          // Folding a group moves everything below it, including the rows this
          // file owns, so the whole pass runs rather than just this group.
          pass();
        });
      }
      // Written only when it would actually change. Setting textContent
      // replaces a text node, which is a childList mutation -- and this runs
      // from a MutationObserver, so writing unconditionally means the observer
      // retriggers itself forever and the page locks up.
      const wanted = isOpen ? 'Hide' : `Show ${group.children.length}`;
      if (toggle.textContent !== wanted) toggle.textContent = wanted;
      const expanded = String(isOpen);
      if (toggle.getAttribute('aria-expanded') !== expanded) {
        toggle.setAttribute('aria-expanded', expanded);
        toggle.setAttribute('aria-label', `${isOpen ? 'Hide' : 'Show'} ${name}`);
      }
    }
  }


  /* ------------------------------------------------------------------ *
   * Mihon bridge, on the Sources screen
   *
   * The bridge lived on a page of its own, reached by a button that did not
   * look like one. Sources is where you go to think about sources, so the
   * picker belongs there: scroll down, open the section, tick what you want.
   * The standalone page still exists and still works -- this is the same job
   * in the place you were already looking.
   *
   * Folded until asked for, and nothing is fetched until it is opened: the
   * bridge talks to a home server over a tunnel, and that is not a cost to pay
   * for everyone who opens Sources.
   * ------------------------------------------------------------------ */

  const BRIDGE_ID = 'yomu-bridge';
  // Same switch Settings and the 18+ page read; yomu-gate.js has its own copy,
  // and these two scripts deliberately share no scope.
  const adultAllowed = () => {
    try { return localStorage.getItem('yomu.v1.adult') === 'on'; } catch { return false; }
  };
  const MIHON_PREFIX = 'mihon-';
  let bridgeLoaded = false;
  let bridgeOpen = false;
  let bridgeState = { families: [], chosen: new Map() };

  const familyOf = (s) =>
    String(s.displayName || s.name || `Source ${s.id}`).replace(/\s*\([^)]*\)\s*$/, '').trim();
  const flatten = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const isAdultSource = (s) => /nsfw|adult|explicit|porn/i.test(String(s.contentWarning || ''));

  function readCollection() {
    try {
      const v = JSON.parse(localStorage.getItem(COLLECTION_KEY) || 'null');
      if (v && typeof v === 'object') return v;
    } catch {}
    return { revision: 0, sources: [], library: [], progress: {} };
  }

  async function loadBridge(body) {
    body.textContent = 'Asking your Suwayomi server…';
    try {
      const status = await (await fetch('/api/suwayomi/status')).json();
      if (!status.configured) { body.textContent = 'No Suwayomi server is configured for this Yomu.'; return; }
      if (!status.reachable) { body.textContent = `Configured, but not answering: ${status.error ?? 'unreachable'}`; return; }

      const [list, ext] = await Promise.all([
        (await fetch('/api/suwayomi/sources')).json(),
        (await fetch('/api/ext/sources')).json().catch(() => ({ extensions: [] })),
      ]);
      const yomu = ext.extensions || [];

      const byFamily = new Map();
      for (const s of list.sources || []) {
        if (String(s.id) === '0') continue;
        const family = familyOf(s);
        let f = byFamily.get(family);
        if (!f) f = (byFamily.set(family, { family, variants: [], adult: false }), byFamily.get(family));
        f.variants.push({ id: String(s.id), lang: String(s.lang || '??') });
        f.adult = f.adult || isAdultSource(s);
      }
      for (const f of byFamily.values()) {
        const key = flatten(f.family);
        const twin = yomu.find((e) => {
          const h = flatten(e.name || '');
          return h && (key.startsWith(h) || h.startsWith(key));
        });
        f.inYomu = !!twin;
        // The one worth leading with: Yomu lists this source but cannot open
        // its chapters, and the bridge version can.
        f.addsReading = !!twin && !twin.capabilities?.pages;
        f.variants.sort((a, b) => (a.lang === 'en' ? -1 : b.lang === 'en' ? 1 : a.lang.localeCompare(b.lang)));
      }
      const rank = (f) => (f.addsReading ? 0 : f.inYomu ? 2 : 1);
      bridgeState.families = [...byFamily.values()]
        .filter((f) => !f.adult || adultAllowed())
        .sort((a, b) => rank(a) - rank(b) || a.family.localeCompare(b.family));

      // Anything already installed stays ticked, so opening this is not
      // destructive; otherwise start from what the bridge actually adds.
      const installed = new Set(
        (readCollection().sources || []).map((s) => String(s.id)).filter((id) => id.startsWith(MIHON_PREFIX)),
      );
      bridgeState.chosen = new Map();
      for (const f of bridgeState.families) {
        const already = f.variants.find((v) => installed.has(MIHON_PREFIX + v.id));
        if (already) { bridgeState.chosen.set(f.family, already.id); continue; }
        if (installed.size) continue;
        if (f.inYomu && !f.addsReading) continue;
        const en = f.variants.find((v) => v.lang === 'en');
        if (en) bridgeState.chosen.set(f.family, en.id);
      }

      bridgeLoaded = true;
      drawBridge(body, status);
    } catch (error) {
      body.textContent = `Could not reach the bridge: ${error?.message ?? error}`;
    }
  }

  function drawBridge(body, status) {
    body.textContent = '';

    const note = document.createElement('p');
    note.className = 'fine-note';
    note.style.margin = '0 0 6px';
    note.textContent = `${status.sources} sources on ${status.server}. Each one you add becomes its own fallback in Yomu.`;
    body.append(note);

    for (const f of bridgeState.families) {
      const row = document.createElement('label');
      row.className = 'setting-link';
      row.style.cursor = 'pointer';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = bridgeState.chosen.has(f.family);
      box.style.cssText = 'width:19px;height:19px;accent-color:var(--accent);flex:none;margin:0';

      const copy = document.createElement('div');
      copy.className = 'row-copy';
      const h3 = document.createElement('h3');
      h3.textContent = f.family;
      const small = document.createElement('small');
      small.textContent = f.addsReading
        ? 'Listed in Yomu but cannot open chapters — this one can'
        : f.inYomu
          ? 'Already a Yomu source'
          : `${f.variants.length} language${f.variants.length === 1 ? '' : 's'}`;
      copy.append(h3, small);

      let select = null;
      if (f.variants.length > 1) {
        select = document.createElement('select');
        select.style.cssText =
          'background:var(--raised);color:var(--text);border:1px solid var(--line);' +
          'border-radius:8px;padding:6px 8px;font:inherit;font-size:12.5px;flex:none';
        for (const v of f.variants) {
          const opt = document.createElement('option');
          opt.value = v.id;
          opt.textContent = v.lang;
          select.append(opt);
        }
        select.value = bridgeState.chosen.get(f.family) ?? f.variants[0].id;
        select.addEventListener('click', (e) => e.preventDefault());
        select.addEventListener('change', () => {
          if (bridgeState.chosen.has(f.family)) bridgeState.chosen.set(f.family, select.value);
        });
      }

      box.addEventListener('change', () => {
        if (box.checked) bridgeState.chosen.set(f.family, select ? select.value : f.variants[0].id);
        else bridgeState.chosen.delete(f.family);
        updateBridgeButton();
      });

      row.append(box, copy);
      if (f.addsReading) {
        const tag = document.createElement('span');
        tag.className = 'tile-card__status';
        tag.style.cssText = 'background:var(--accent);color:var(--accentText);border:0;font-weight:700';
        tag.textContent = 'ADDS READING';
        row.append(tag);
      }
      if (select) row.append(select);
      body.append(row);
    }

    const foot = document.createElement('div');
    foot.className = 'action-row';
    foot.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 18px';

    const save = document.createElement('button');
    save.id = BRIDGE_ID + '-save';
    save.className = 'g-button primary';
    save.type = 'button';
    save.addEventListener('click', () => saveBridge(save));
    foot.append(save);

    const said = document.createElement('span');
    said.id = BRIDGE_ID + '-said';
    said.className = 'fine-note';
    foot.append(said);

    body.append(foot);
    updateBridgeButton();
  }

  function updateBridgeButton() {
    const save = document.getElementById(BRIDGE_ID + '-save');
    if (!save) return;
    const n = bridgeState.chosen.size;
    save.textContent = n ? `Add ${n} source${n === 1 ? '' : 's'}` : 'Remove all bridge sources';
  }

  function saveBridge(save) {
    const collection = readCollection();
    const keep = (collection.sources || []).filter((s) => !String(s.id).startsWith(MIHON_PREFIX));
    const added = [];
    for (const [family, id] of bridgeState.chosen) {
      const lang = bridgeState.families.find((f) => f.family === family)
        ?.variants.find((v) => v.id === id)?.lang;
      added.push({
        id: MIHON_PREFIX + id,
        label: lang && lang !== 'en' ? `${family} (${lang})` : family,
        category: 'Mihon / Suwayomi',
        kind: 'api',
        url: `${location.origin}/api/suwayomi/source/${encodeURIComponent(id)}/`,
        enabled: true,
      });
    }
    try {
      localStorage.setItem(COLLECTION_KEY, JSON.stringify({
        ...collection,
        revision: (Number.isInteger(collection.revision) ? collection.revision : 0) + 1,
        sources: [...keep, ...added],
      }));
    } catch (error) {
      document.getElementById(BRIDGE_ID + '-said').textContent = `Could not save: ${error?.message ?? error}`;
      return;
    }
    const said = document.getElementById(BRIDGE_ID + '-said');
    said.textContent = added.length
      ? `Saved ${added.length}. Reload to see them in the list above.`
      : 'All bridge sources removed.';
  }

  function mountBridge() {
    if (!location.pathname.startsWith('/sources')) return;

    // Our own heading is a .group-label too, so it is excluded from the search.
    const labels = [...document.querySelectorAll('.group-label')]
      .filter((l) => l.id !== BRIDGE_ID + '-label');
    const anchor = labels.find((l) => /add a source/i.test(l.textContent || ''));
    // On the first pass React may not have mounted "Add a source" yet. Waiting
    // for it beats guessing: an earlier version fell back to the last label it
    // could see and pinned the section above the source list, where it stayed.
    if (!anchor?.parentNode) return;

    let label = document.getElementById(BRIDGE_ID + '-label');
    let card = document.getElementById(BRIDGE_ID);
    if (!label) {
      label = document.createElement('div');
      label.className = 'group-label';
      label.id = BRIDGE_ID + '-label';
      label.append(document.createTextNode('Mihon bridge'));

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'yomu-fold';
      toggle.textContent = 'Show';
      toggle.addEventListener('click', () => {
        bridgeOpen = !bridgeOpen;
        const body = document.getElementById(BRIDGE_ID);
        if (body) {
          body.hidden = !bridgeOpen;
          if (bridgeOpen && !bridgeLoaded) loadBridge(body);
        }
        toggle.textContent = bridgeOpen ? 'Hide' : 'Show';
        toggle.setAttribute('aria-expanded', String(bridgeOpen));
      });
      label.append(toggle);

      card = document.createElement('section');
      card.className = 'settings-group glass';
      card.id = BRIDGE_ID;
      card.hidden = true;
      card.textContent = '';
    }
    // Re-asserted rather than rebuilt: React owns this list and re-renders it.
    // Checking the card sits immediately before the anchor -- not merely that
    // the pair are adjacent to each other -- is what lets a section placed
    // early, against a label that had not mounted yet, correct itself later.
    if (card.nextElementSibling !== anchor || label.nextElementSibling !== card) {
      anchor.before(label, card);
    }
  }


  /* ------------------------------------------------------------------ *
   * Immersive reading
   *
   * The reader's own bars fade after two seconds, but that only ever dealt
   * with Yomu's furniture. What stayed around the page was everyone else's: an
   * address bar, a home indicator, a status bar.
   *
   * Two seconds in, the reader now takes everything it is allowed to take.
   * Where the Fullscreen API exists that includes the browser's chrome, and on
   * a desktop or an Android phone the result really is only the page.
   *
   * Where it does not exist, say so rather than ship a button that lies.
   * Safari on iPhone has never implemented requestFullscreen, and no web page
   * -- installed to the Home Screen or not -- can hide the iOS status bar or
   * the home indicator. Those two are the operating system's, and there is no
   * API, meta tag or manifest field that removes them. What immersive can
   * still do there it does: every pixel Yomu owns goes, the art runs edge to
   * edge underneath the rest, and the bars stop coming back on their own.
   *
   * Entering fullscreen requires a user gesture and a timer is not one, so the
   * attempt at two seconds is exactly that. When the browser refuses, the next
   * deliberate tap carries it -- in practice the tap you were going to make
   * anyway, so the seam rarely shows.
   * ------------------------------------------------------------------ */

  const IMM_KEY = 'yomu.v1.immersive';
  const IMM_HINT_KEY = 'yomu.v1.immersiveHint';
  const HOME_HINT_KEY = 'yomu.v1.homeScreenHint';
  const IMM_CLASS = 'yomu-immersive';
  const IMM_DELAY = 2000;
  const IMM_ID = 'yomu-immersive-toggle';

  // On by default: this is the behaviour that was asked for, and the button
  // and the double tap are both one gesture away from turning it off.
  const immWanted = () => { try { return localStorage.getItem(IMM_KEY) !== 'off'; } catch { return true; } };
  const setImmWanted = (on) => { try { localStorage.setItem(IMM_KEY, on ? 'on' : 'off'); } catch {} };

  const inReader = () => location.pathname.startsWith('/read/');
  const immOn = () => document.documentElement.classList.contains(IMM_CLASS);

  const fsElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
  const fsTarget = () => document.querySelector('.rd');
  const fsSupported = () => {
    const el = fsTarget();
    return !!(el && (el.requestFullscreen || el.webkitRequestFullscreen));
  };
  /** Already running without browser chrome: installed to the Home Screen. */
  const isStandalone = () =>
    window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

  /** True once a timed attempt has been refused for want of a gesture. */
  let fsAwaitingGesture = false;

  function requestFullscreen() {
    if (!fsSupported() || fsElement()) return;
    const el = fsTarget();
    try {
      const attempt = el.requestFullscreen?.({ navigationUI: 'hide' })
        ?? el.webkitRequestFullscreen?.();
      Promise.resolve(attempt).then(
        () => { fsAwaitingGesture = false; },
        () => { fsAwaitingGesture = true; },
      );
    } catch { fsAwaitingGesture = true; }
  }

  function enterImmersive() {
    if (!inReader()) return;
    if (!immOn()) {
      document.documentElement.classList.add(IMM_CLASS);
      showExitHint();
      showHomeScreenHint();
    }
    requestFullscreen();
    mountImmersiveToggle();
  }

  /**
   * Returns true when it actually left something.
   *
   * That return is what the reader's double-tap handler reads: true means the
   * tap was spent getting out, so it brings its own bars back rather than
   * toggling them, and a single gesture never does two things at once.
   */
  function leaveImmersive() {
    if (!immOn() && !fsElement()) return false;
    fsAwaitingGesture = false;
    armed = false;
    document.documentElement.classList.remove(IMM_CLASS);
    if (fsElement()) {
      try { (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document); } catch {}
    }
    mountImmersiveToggle();
    return true;
  }
  globalThis.__yomuExit = () => leaveImmersive();

  /* --- the two-second arm ---------------------------------------------- *
   *
   * Armed per chapter rather than per visit, so moving to the next chapter
   * drops back into immersive by itself. Leaving disarms, which is what keeps
   * a deliberate exit from being undone two seconds later; the next chapter
   * arms again, because wanting the bars once is not the same as wanting them
   * from now on. That standing answer is the toggle's job, and it is stored.
   * -------------------------------------------------------------------- */

  let armed = false;
  let armedFor = '';
  let armTimer = null;

  function armImmersive() {
    const context = readerContext();
    const here = context ? context.chapterId : '';

    if (!here) {
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
      armed = false;
      armedFor = '';
      if (immOn()) leaveImmersive();
      return;
    }
    if (here === armedFor) return;

    armedFor = here;
    armed = true;
    if (armTimer) clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      armTimer = null;
      if (armed && inReader() && immWanted()) enterImmersive();
    }, IMM_DELAY);
  }

  /* --- the notes -------------------------------------------------------- */

  /**
   * Shown the first time immersive engages and never again, because after the
   * first time it is something you know. Two seconds, no button, no backdrop:
   * long enough to read four words, short enough that it is gone before it is
   * in the way.
   */
  function showExitHint() {
    try { if (localStorage.getItem(IMM_HINT_KEY) === 'seen') return; } catch {}
    if (document.getElementById(IMM_HINT_KEY)) return;
    try { localStorage.setItem(IMM_HINT_KEY, 'seen'); } catch {}

    const note = document.createElement('p');
    note.id = IMM_HINT_KEY;
    note.className = 'yomu-imm-note';
    note.setAttribute('role', 'status');
    note.textContent = window.matchMedia?.('(pointer: coarse)').matches
      ? 'Double-tap to exit' : 'Double-click to exit';
    document.body.append(note);

    setTimeout(() => {
      note.classList.add('is-going');
      // Removed on a timer rather than transitionend: a dropped event would
      // otherwise leave it on the page for the rest of the session.
      setTimeout(() => note.remove(), 400);
    }, 2000);
  }

  /**
   * The one thing worth saying on an iPhone, said once.
   *
   * Safari there cannot go fullscreen and never will, so a button promising it
   * would be a lie. Add to Home Screen is the real answer -- it drops Safari's
   * own bars for good -- and it is worth the interruption exactly once. The
   * iOS status bar and home indicator stay either way; nothing can move those.
   */
  function showHomeScreenHint() {
    if (fsSupported() || isStandalone()) return;
    try { if (localStorage.getItem(HOME_HINT_KEY) === 'seen') return; } catch {}
    if (document.getElementById(HOME_HINT_KEY)) return;
    try { localStorage.setItem(HOME_HINT_KEY, 'seen'); } catch {}

    const note = document.createElement('p');
    note.id = HOME_HINT_KEY;
    note.className = 'yomu-imm-note yomu-imm-note--wide';
    note.textContent =
      'Safari cannot go fullscreen on iPhone. Share → Add to Home Screen and Yomu opens with no browser bars.';
    document.body.append(note);

    const dismiss = () => note.remove();
    note.addEventListener('click', dismiss);
    setTimeout(dismiss, 7000);
  }

  /* --- the toggle ------------------------------------------------------- */

  const IMM_ICON_ON =
    'M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3';
  const IMM_ICON_OFF =
    'M3 8h3a2 2 0 0 0 2-2V3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M21 16h-3a2 2 0 0 0-2 2v3';

  function mountImmersiveToggle() {
    if (!inReader()) return;
    const foot = document.querySelector('.rd-foot');
    if (!foot) return;

    let button = document.getElementById(IMM_ID);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.id = IMM_ID;
      button.className = 'yomu-imm-toggle';
      button.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path/></svg>';
      button.addEventListener('click', (event) => {
        // The footer sits inside the reader's tap surface, and a tap there is
        // half of the gesture that exits. Stopping it here keeps pressing the
        // button from also counting as the first of a double tap.
        event.stopPropagation();
        if (immOn()) { setImmWanted(false); leaveImmersive(); }
        else { setImmWanted(true); armed = true; enterImmersive(); }
      });
    }

    const on = immOn();
    const path = button.querySelector('path');
    const want = on ? IMM_ICON_OFF : IMM_ICON_ON;
    if (path.getAttribute('d') !== want) path.setAttribute('d', want);

    const label = on ? 'Leave fullscreen' : 'Read fullscreen';
    if (button.getAttribute('aria-label') !== label) {
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    button.setAttribute('aria-pressed', String(on));

    // Re-asserted rather than rebuilt: React owns the footer.
    if (button.parentElement !== foot) foot.append(button);
  }

  /* --- gestures and the browser's own exits ----------------------------- */

  // A refused timed attempt is retried on the next deliberate touch, which is
  // the gesture the browser was holding out for. Capture phase, so it runs
  // whether or not the reader stops the event.
  document.addEventListener('pointerdown', () => {
    if (!fsAwaitingGesture || !inReader() || !immOn()) return;
    fsAwaitingGesture = false;
    requestFullscreen();
  }, true);

  // Esc, the browser's own exit button, or a swipe out of fullscreen: whatever
  // the route, immersive should not be left half on.
  for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(type, () => {
      if (!fsElement() && immOn()) leaveImmersive();
      else mountImmersiveToggle();
    });
  }

  /**
   * One pass over everything this file maintains.
   *
   * All of it is idempotent and all of it is cheap -- each step either matches
   * nothing on the current route or finds the work already done and returns.
   * That is what lets the same pass serve both the initial mount and every
   * later mutation, with no per-screen bookkeeping to get out of step.
   */
  const pass = () => {
    tagCompleted();
    badgeProgress();
    trackSeriesPage();
    trackReader();
    mountContinue();
    explainIconButtons();
    foldSettingsGroups();
    mountBridge();
    decorateChapters();
    armImmersive();
    mountImmersiveToggle();
  };

  const mount = () => {
    if (!document.getElementById(ID)) document.body.append(build());
    pass();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  // The grid mounts as results arrive, so new tiles need tagging as they land.
  // Cheap: tagCompleted only looks at tiles it has not already marked.
  new MutationObserver(pass).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // The app navigates without a document load, so a chapter change is a URL
  // change and nothing else. The observer catches it in practice -- the new
  // chapter always repaints something -- but a chapter that renders identical
  // markup would not fire one, and the arm would stay pointed at the old id.
  for (const type of ['popstate', 'hashchange']) addEventListener(type, pass);
})();
