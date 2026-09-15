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

  /* ------------------------------------------------------------------ *
   * The chosen accent
   *
   * Applied before anything is drawn, because the app reads --accent for
   * almost every coloured thing on every screen. One token, set once, and
   * /you.html is the screen that chooses it.
   * ------------------------------------------------------------------ */
  (() => {
    const ACCENTS = {
      blue:   ['#9db8ff', '#111a2e'],
      green:  ['#7fd6b0', '#0d241c'],
      coral:  ['#ff968c', '#2c1110'],
      violet: ['#d3a2ff', '#231133'],
    };
    let chosen = '';
    try { chosen = localStorage.getItem('yomu.v1.accent') || ''; } catch {}
    const accent = ACCENTS[chosen];
    if (!accent) return;                       // amber is the stylesheet's own
    const root = document.documentElement;
    root.style.setProperty('--accent', accent[0]);
    root.style.setProperty('--accentText', accent[1]);
    root.style.setProperty('--accentSoft', accent[0] + '1f');
    root.style.setProperty('--accentLine', accent[0] + '66');
  })();

  /* ------------------------------------------------------------------ *
   * First run
   *
   * A brand new install lands on a home page with nothing on it, which is a
   * bad first thirty seconds and the whole reason /start exists. This is the
   * redirect, and it is deliberately strict in the other direction: the
   * failure worth avoiding is not "somebody missed the setup flow", it is
   * "somebody who set this up months ago gets marched through it again".
   *
   * So every one of these has to be true. Any single sign of prior use --
   * a saved title, a position, a paired device, a circle, a source they
   * turned on themselves -- means they are not new and this never fires.
   *
   * Runs before the sidebar is built, and only on Home, so no other screen
   * can be interrupted by it.
   * ------------------------------------------------------------------ */
  (() => {
    const at = location.pathname;
    if (at !== '/' && at !== '/index.html') return;

    const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
    if (read('yomu.v1.setupDone')) return;

    let collection = null;
    try { collection = JSON.parse(read('yomu.v1.collection') || 'null'); } catch {}
    const library = Array.isArray(collection?.library) ? collection.library : [];
    if (library.length) return;
    if (read('yomu.v1.sync') || read('yomu.v1.circle') || read('yomu.v1.reading')) return;

    // A source the app did not ship on by default is somebody's own choice.
    const DEFAULTS = new Set(['mangadex', 'internet-archive']);
    const sources = Array.isArray(collection?.sources) ? collection.sources : [];
    if (sources.some((s) => s && !DEFAULTS.has(String(s.id)))) return;

    let anyProgress = false;
    try {
      anyProgress = Object.keys(localStorage).some((k) => k.startsWith('yomu.v1.resume.'));
    } catch {}
    if (anyProgress) return;

    location.replace('/start');
  })();

  const ID = 'yomu-sidebar';

  const ITEMS = [
    { href: '/', label: 'Home', icon: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5' },
    { href: '/find.html', label: 'Discover', icon: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35' },
    { href: '/library', label: 'Library', icon: 'M4 4h6v16H4zM14 4h6v16h-6z' },
    { href: '/you', label: 'You', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0' },
    { href: '/settings', label: 'Settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 0 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 0 1 0-4 1.7 1.7 0 0 0 1.5-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 0 1 4 0a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 0 1 0 4Z' },
  ];

  /** The item a path belongs to. The reader and series pages sit under Home. */
  function activeHref(pathname) {
    if (pathname.startsWith('/find') || pathname.startsWith('/search')) return '/find.html';
    if (pathname.startsWith('/library') || pathname.startsWith('/downloads')) return '/library';
    if (pathname.startsWith('/you')) return '/you';
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
   * What the home grid shows, and in what order
   *
   * Two separate complaints, and they had one cause each.
   *
   * ORDER. The default view led with the most recently updated titles across
   * every enabled source. That is a firehose: the first thing on the page was
   * whatever some site touched in the last hour, which is mostly one-chapter
   * uploads nobody asked for. Recency is worth knowing -- the tiles already
   * carry a "New chapter" tag for it -- but it is a bad thing to sort by. The
   * popular feed leads now, and the recent ones fall in behind it.
   *
   * QUALITY. There is no rating, no view count and no follower count anywhere
   * in a SeriesSummary, so there is no quality number to sort on and inventing
   * one would be a lie. What there is: whether a source bothered to give the
   * title a cover, and whether anything is actually published. Those two
   * remove most of what reads as junk without pretending to judge anything.
   *
   * ABOUT "manga, manhua, manhwa": that was the ask, and taken literally it
   * empties the page. Weeb Central -- the largest source here, over a thousand
   * chapters on a long series -- sets no category at all, and Webtoons.com
   * sets "webtoon". Filtering to the three named kinds would delete both.
   * Absence of a label is not evidence of low quality, so the rule is the
   * other way round: everything is welcome except the kinds that were
   * deliberately not asked for.
   * ------------------------------------------------------------------ */

  /** The two the ask left out. Adult has its own page and its own gate. */
  const UNWANTED_KINDS = new Set(['adult', 'comic']);

  function worthShowing(item) {
    const summary = item && item.summary;
    if (!summary) return false;
    if (UNWANTED_KINDS.has(String(summary.category || '').toLowerCase())) return false;
    // No cover is the one signal that means the same thing on every source:
    // nobody has looked at this entry.
    if (!summary.cover) return false;
    // Nothing published yet. A real series acquires both of these quickly.
    if (!summary.latestChapter && !summary.synopsis) return false;
    return true;
  }

  /**
   * Called by the home grid with the popular feed and the recently-updated
   * one. Returns what to draw.
   *
   * Falls back to the unfiltered list only when the filter keeps nothing at
   * all. That is the one outcome that means the rule is wrong rather than
   * working -- a source that never sets a cover, say -- and an empty grid is
   * a worse answer than an imperfect one. Short of that the filter is
   * trusted: two good titles out of forty is the right answer when
   * thirty-eight of them have no cover and nothing published.
   */
  globalThis.__yomuGrid = (recentFirst, popular) => {
    const seen = new Set();
    const ordered = [];
    for (const item of [...(popular || []), ...(recentFirst || [])]) {
      const key = item.sourceId + ':' + item.summary.id;
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(item);
    }
    const kept = ordered.filter(worthShowing);
    return kept.length ? kept : ordered;
  };


  /* ------------------------------------------------------------------ *
   * Pull down to get different titles
   *
   * The phone half of the refresh button. Only on Home, only from a page that
   * is already at the top, and only for touch -- a mouse has the button.
   *
   * Deliberately not preventDefault on the move: fighting the browser's own
   * overscroll to own the gesture is how pull-to-refresh ends up feeling
   * worse than no pull-to-refresh. This watches, shows how far along the pull
   * is, and lets the platform do the rubber-banding.
   * ------------------------------------------------------------------ */

  const PULL_TRIGGER = 88;
  const PULL_ID = 'yomu-pull';

  let pullFrom = null;

  const onHome = () => location.pathname === '/' || location.pathname === '/index.html';
  const scrolledToTop = () =>
    (document.scrollingElement || document.documentElement).scrollTop <= 0;

  function pullIndicator(distance, armed) {
    let mark = document.getElementById(PULL_ID);
    if (distance <= 0) { mark?.remove(); return; }
    if (!mark) {
      mark = document.createElement('div');
      mark.id = PULL_ID;
      mark.className = 'yomu-pull';
      mark.innerHTML = '<span></span>';
      document.body.append(mark);
    }
    const reach = Math.min(1, distance / PULL_TRIGGER);
    mark.style.setProperty('--reach', String(reach));
    mark.classList.toggle('is-armed', armed);
    const label = armed ? 'Release for different titles' : 'Pull for different titles';
    if (mark.querySelector('span').textContent !== label) {
      mark.querySelector('span').textContent = label;
    }
  }

  addEventListener('touchstart', (event) => {
    pullFrom = onHome() && scrolledToTop() && event.touches.length === 1
      ? event.touches[0].clientY
      : null;
  }, { passive: true });

  addEventListener('touchmove', (event) => {
    if (pullFrom === null) return;
    // Scrolled away mid-gesture, or the finger went up: this is a scroll now.
    if (!scrolledToTop()) { pullFrom = null; pullIndicator(0); return; }
    const distance = event.touches[0].clientY - pullFrom;
    pullIndicator(Math.max(0, distance), distance >= PULL_TRIGGER);
  }, { passive: true });

  addEventListener('touchend', (event) => {
    if (pullFrom === null) return;
    const distance = (event.changedTouches[0]?.clientY ?? pullFrom) - pullFrom;
    pullFrom = null;
    pullIndicator(0);
    // __yomuReload is the home screen's own reset-and-refetch. Absent means
    // the screen is not mounted, and there is nothing sensible to refresh.
    if (distance >= PULL_TRIGGER) globalThis.__yomuReload?.();
  }, { passive: true });


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
   *
   * Two things make this harder than it looks, and getting either wrong stores
   * the wrong picture against the right title -- which then sticks, because
   * the reader has no cover of its own to correct it with.
   *
   * The selectors are the series screen's own, not the first .cover and the
   * first h1 on the page. Those matched the home carousel's hero and recorded
   * whatever happened to be featured that minute.
   *
   * And the route is required to have been current for a moment first. This
   * app navigates without a document load, so for a tick or two after a tap
   * the URL is already the new series while the DOM is still the old screen --
   * long enough for an observer callback to read one and attribute it to the
   * other.
   */
  const SETTLE_MS = 600;
  let seriesSettling = { route: '', at: 0, timer: null };

  function trackSeriesPage() {
    const context = seriesPageContext();
    if (!context) {
      if (seriesSettling.timer) clearTimeout(seriesSettling.timer);
      seriesSettling = { route: '', at: 0, timer: null };
      return;
    }

    const route = titleKey(context.sourceId, context.seriesId);
    if (seriesSettling.route !== route) {
      if (seriesSettling.timer) clearTimeout(seriesSettling.timer);
      // A settled page stops mutating, so the tick that would finally pass the
      // check may never come. This is that tick.
      seriesSettling = {
        route,
        at: Date.now(),
        // pass(), not trackSeriesPage(): everything else that waits on this
        // settle needs the tick too, and a page that has finished rendering
        // stops mutating -- so this timer is the only tick that arrives.
        timer: setTimeout(() => { seriesSettling.timer = null; pass(); }, SETTLE_MS + 60),
      };
      return;
    }
    if (Date.now() - seriesSettling.at < SETTLE_MS) return;

    const cover = backgroundUrl(document.querySelector('.series-hero-art'));
    const title = document.querySelector('.series-hero-copy h1')?.textContent?.trim() || '';
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

    // Measured against the foot of the last page, not the foot of the scroll
    // container. Anything mounted below the pages -- the circle's chapter
    // thread is the first thing to do it -- makes the container taller than
    // the chapter, and marking read at the container's end would mean
    // scrolling past the comments to finish a chapter you had already read.
    const pages = scroller.querySelectorAll('[data-page-index]');
    const last = pages[pages.length - 1];
    const end = last
      ? (parseFloat(last.style.top) || 0) + (parseFloat(last.style.height) || 0)
      : scroller.scrollHeight;

    const seen = scroller.scrollTop + scroller.clientHeight;
    // A chapter shorter than the screen has no scrolling to do and is already
    // read -- but only once it has actually been laid out.
    if (end <= 0) return false;
    return seen >= end - 24;
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

    if (!count || count.pages <= 0 || !atChapterEnd()) { atEnd = false; return; }

    // Reaching the foot of a chapter is the one moment the reader can be
    // sure you want the controls back: the next chapter is behind them, and
    // double tapping to summon something the reader already knows you need
    // is a step for nothing. Held open rather than flashed for two seconds,
    // so it waits for you. Announced once per arrival -- scrolling about
    // down there must not keep re-summoning a bar you just dismissed.
    if (!atEnd) {
      atEnd = true;
      globalThis.__yomuHoldChrome?.();
    }

    const seen = context.seriesId + ' ' + context.chapterId;
    if (markedRead.has(seen)) return;
    markedRead.add(seen);
    markChapterRead(context.seriesId, context.chapterId);
  }

  /** Whether the foot of the current chapter has already been announced. */
  let atEnd = false;

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
   * Swipe up and hold, at the end of a chapter, for the next one
   *
   * The end of a chapter is the one place in a reader where there is exactly
   * one thing you are likely to want, and it was two taps away: wake the bars,
   * find the arrow. This is the same motion you were already making -- you
   * reached the bottom by pushing the page up -- carried on for a moment
   * longer.
   *
   * A hold rather than a flick because a flick is indistinguishable from the
   * end of an ordinary scroll, and loading the next chapter by accident is a
   * worse failure than not loading it at all. The ring fills while you hold,
   * so the wait is visible and letting go plainly cancels it.
   *
   * It drives the reader's own Next chapter button rather than routing itself:
   * that button already knows whether there is a next chapter, handles the
   * flush of your position, and goes wherever the app would have gone.
   * ------------------------------------------------------------------ */

  const NEXT_HOLD_MS = 1500;
  const NEXT_PULL_PX = 40;
  const NEXT_ID = 'yomu-next-hold';

  let pullStart = null;
  let pullTimer = null;

  const nextChapterButton = () =>
    [...document.querySelectorAll('.rd-dock .rd-icon')]
      .find((b) => /next chapter/i.test(b.getAttribute('aria-label') || ''));

  function nextHint(on) {
    let ring = document.getElementById(NEXT_ID);
    if (!on) { ring?.remove(); return; }
    if (ring) return ring;
    ring = document.createElement('div');
    ring.id = NEXT_ID;
    ring.className = 'yomu-next-hold';
    ring.innerHTML = '<i></i><span></span>';
    ring.querySelector('span').textContent = 'Hold for the next chapter';
    document.body.append(ring);
    // Started on the next frame so the transition has a value to run from.
    requestAnimationFrame(() => ring.classList.add('is-filling'));
    return ring;
  }

  function cancelPull() {
    if (pullTimer) { clearTimeout(pullTimer); pullTimer = null; }
    pullStart = null;
    nextHint(false);
  }

  addEventListener('touchstart', (event) => {
    cancelPull();
    if (!inReader() || event.touches.length !== 1) return;
    if (!atChapterEnd()) return;
    const button = nextChapterButton();
    if (!button || button.disabled) return;   // nothing after this one
    pullStart = event.touches[0].clientY;
  }, { passive: true });

  addEventListener('touchmove', (event) => {
    if (pullStart === null) return;
    // Up is negative. Anything downward is a scroll back into the chapter.
    const lifted = pullStart - event.touches[0].clientY;
    if (lifted < NEXT_PULL_PX || !atChapterEnd()) {
      if (pullTimer) { clearTimeout(pullTimer); pullTimer = null; nextHint(false); }
      return;
    }
    if (pullTimer) return;                    // already counting
    nextHint(true);
    pullTimer = setTimeout(() => {
      pullTimer = null;
      pullStart = null;
      nextHint(false);
      nextChapterButton()?.click();
    }, NEXT_HOLD_MS);
  }, { passive: true });

  for (const type of ['touchend', 'touchcancel']) {
    addEventListener(type, cancelPull, { passive: true });
  }


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
   * Continue reading, on the title itself
   *
   * The series page could tell you a title had 231 chapters and that you had
   * read some of them, and then leave you to find your place in the list. The
   * app's own "Play chapter N" button is the resume, but it says a number
   * without saying what the number means -- on a title you last opened weeks
   * ago, "Play chapter 41" and "start from the beginning" look alike.
   *
   * This says where you are, how far through the title that is, and how far
   * through the chapter, and it is the same stored record the Home row and
   * sync already use -- so it survives quitting, and it is already on your
   * other devices.
   * ------------------------------------------------------------------ */

  const RESUME_ID = 'yomu-series-resume';

  /** "231 chapters" out of the app's own facts line. */
  function chapterTotal() {
    const match = /(\d[\d,]*)\s+chapters?/i.exec(
      document.querySelector('.series-facts')?.textContent || '');
    if (match) return Number(match[1].replace(/,/g, ''));
    const rows = document.querySelectorAll('.chapter-line[data-chn]').length;
    return rows || null;
  }

  function mountSeriesResume() {
    const context = seriesPageContext();
    if (!context) { document.documentElement.removeAttribute('data-yomu-resume'); return; }
    const line = document.querySelector('.section-line');
    if (!line) return;

    const record = readingIndex()[titleKey(context.sourceId, context.seriesId)];
    const existing = document.getElementById(RESUME_ID);

    /* The app's own "Play chapter N" is the same action, and it was giving a
     * different answer -- it read chapter 1 on a title this card knew was on
     * chapter 2, because its resume only sees what the current screen loaded.
     * Two buttons doing one job and disagreeing about it is worse than either
     * alone, so the accurate one speaks and the other stands down. Marked on
     * <html> rather than removed, so it comes back the moment there is no
     * position to resume. */
    document.documentElement.toggleAttribute(
      'data-yomu-resume', !!(record && record.chapterId));

    if (!record || !record.chapterId) { existing?.remove(); return; }

    const pages = Number(record.pages) || 0;
    const page = Number(record.page) || 0;
    const percent = pages > 0 ? Math.min(100, Math.round(page / pages * 100)) : null;
    const total = chapterTotal();
    const label = (record.chapterLabel || '').replace(/^chapter\s*/i, '') || '?';

    const detail = [
      total ? `Chapter ${label} of ${total}` : `Chapter ${label}`,
      percent == null ? null : `${percent}% through it`,
    ].filter(Boolean).join(' · ');

    const signature = record.chapterId + '|' + detail;
    if (existing && existing.dataset.sig === signature) return;

    const card = document.createElement('a');
    card.id = RESUME_ID;
    card.dataset.sig = signature;
    card.className = 'yomu-resume';
    card.href = '/read/' + encodeURIComponent(record.chapterId)
      + '?source=' + encodeURIComponent(record.sourceId);

    const glyph = document.createElement('i');
    glyph.setAttribute('aria-hidden', 'true');

    const copy = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = 'Continue reading';
    const small = document.createElement('small');
    small.textContent = detail;
    copy.append(strong, small);

    if (percent != null) {
      const bar = document.createElement('progress');
      bar.max = 100;
      bar.value = percent;
      copy.append(bar);
    }

    card.append(glyph, copy);
    if (existing) existing.replaceWith(card);
    else line.before(card);
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
    // Top right, beside Save, not in the footer.
    //
    // It sat under the page counter and the chapter arrows, which are the
    // controls you press while reading -- so the one control that changes the
    // shape of the screen was mixed in with the ones that turn pages, and it
    // read as a misplaced part of the pager rather than a mode switch. Top
    // right is where a window control belongs, and the header is the bar that
    // is already about this chapter rather than about your position in it.
    const head = document.querySelector('.rd-head');
    if (!head) return;

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

    // Re-asserted rather than rebuilt: React owns the header.
    if (button.parentElement !== head) head.append(button);
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
   * Source Fabric, on every /sources -- not only the ones that arrive as a
   * document load.
   *
   * The three source-fabric-*.js files are injected by the Worker into
   * /sources responses, and each returns immediately unless
   * location.pathname says /sources at the moment it runs. Yomu is a single
   * page, so that moment is whichever screen was opened first. One cause,
   * two symptoms: tap through to Sources from inside the app and the command
   * card is not there at all, and hard-load /sources then tap Home and it
   * rides along onto the landing page.
   *
   * Handled here because those files are not mine to edit. Load them on
   * demand when the route becomes /sources -- the same three tags the Worker
   * writes, in the same order -- and hide the panel by class while the route
   * is anything else. The hide is a rule in yomu-overrides.css keyed off
   * <html> rather than a write to the panel: source-fabric-layout.js
   * re-places that node on every document mutation, and two scripts editing
   * one node is how you get a loop.
   */
  const FABRIC_ID = 'yomu-source-fabric-command';

  /**
   * Fabric pieces that mount *into* the panel, and the id each leaves behind.
   *
   * All three mount once and then opt out of watching -- each ends in
   * `if (mount()) return`, and that first mount succeeds against the
   * prerendered markup, before React has hydrated. React then replaces that
   * tree, source-fabric-panel.js rebuilds the card from its own observer,
   * which never stops, and everything the others added is gone with nobody
   * left to put it back. The tell is a page carrying the bulk stylesheet
   * with no tabs on the card: the script ran, it just ran against a DOM that
   * no longer exists.
   *
   * They also stack. Reviving the bulk importer builds a fresh pack block,
   * which throws away the Load JSON row that source-pack-json.js had put in
   * the old one -- and arming the Community pack button is a third script
   * again. So the chain is checked and re-run in order, and because they are
   * appended with async=false they execute in that order too.
   *
   * Re-running is the whole fix, and each script's own guard makes a re-run
   * a no-op once its part is there. Done from here because these files are
   * not mine to edit.
   */
  const FABRIC_PARTS = [
    { src: '/source-fabric-bulk.js', has: '#yomu-source-pack-mode', pending: false },
    { src: '/source-pack-json.js', has: '.sp-json-import', pending: false },
    { src: '/source-pack-live.js', has: '.sp-json-community[data-yomu-live-pack="1"]', pending: false },
  ];
  /** Enough to cover a rebuild or two; past that something else is wrong. */
  const REVIVE_LIMIT = 3;

  /** Long enough for hydration to settle and for the scripts' own observers
   *  to win on their own, short enough not to be a visible wait. */
  const REVIVE_SETTLE_MS = 400;

  let fabricAsked = false;
  let revivedFor = null;
  let revivedSince = 0;
  let revived = 0;
  let reviveTimer = null;

  /* Every /source-*.js the Worker writes, not only the source-fabric- ones:
     the fifth file it grew was called source-pack-json.js. */
  const fabricScriptsHere = () =>
    [...document.querySelectorAll('script[src*="/source-"]')]
      .map((tag) => { try { return new URL(tag.src).pathname; } catch { return ''; } })
      .filter((path) => /^\/source-[a-z0-9-]+\.js$/.test(path));

  function runFabric(src) {
    const tag = document.createElement('script');
    tag.src = src;
    // Not `defer`, which does nothing for a script inserted this late.
    // async=false is what keeps inserted scripts running in order.
    tag.async = false;
    document.body.append(tag);
    return tag;
  }

  /**
   * The scripts this route would have been served, asked of the route.
   *
   * Hardcoded here first, and the list was stale within the day: the Worker
   * grew a fourth file and in-app navigation to Sources silently lost the
   * feature it carried. The Worker's own HTML is the only list that cannot
   * drift.
   */
  async function loadFabricFor(path) {
    let wanted = [];
    try {
      const response = await fetch(path, { headers: { accept: 'text/html' } });
      if (response.ok) {
        const html = await response.text();
        wanted = [...html.matchAll(/src="(\/source-[a-z0-9-]+\.js)"/g)].map((hit) => hit[1]);
      }
    } catch {}
    if (!wanted.length) {
      wanted = ['/source-fabric-panel.js', '/source-fabric-layout.js', '/source-fabric-diagnostics.js'];
    }
    for (const src of [...new Set(wanted)]) runFabric(src);
  }

  const gateFabric = () => {
    const onSources = location.pathname.startsWith('/sources');
    const root = document.documentElement;
    // Checked before writing: this runs on every mutation, and setting a
    // class the element already has would be a mutation of its own.
    if (root.classList.contains('yomu-fabric-away') === onSources) {
      root.classList.toggle('yomu-fabric-away', !onSources);
    }
    if (!onSources) return;

    const panel = document.getElementById(FABRIC_ID);
    if (!panel) {
      // Nothing to do when this load came in through /sources: the Worker has
      // already put the tags in the document.
      if (fabricAsked || fabricScriptsHere().length) return;
      fabricAsked = true;
      loadFabricFor(location.pathname + location.search);
      return;
    }

    if (panel !== revivedFor) {
      revivedFor = panel;
      revivedSince = Date.now();
      revived = 0;
    }
    if (revived >= REVIVE_LIMIT) return;
    /* Give the card a moment to stop being replaced. Reviving the instant a
       panel appears means reviving into the pre-hydration one and then doing
       it all again -- and most of the time the scripts' own observers get
       there first inside this window, so the best outcome is no revival at
       all. The timer is here because a settled page stops mutating, and this
       runs off mutations. */
    if (Date.now() - revivedSince < REVIVE_SETTLE_MS) {
      if (!reviveTimer) {
        reviveTimer = setTimeout(() => { reviveTimer = null; gateFabric(); }, REVIVE_SETTLE_MS + 40);
      }
      return;
    }
    const here = fabricScriptsHere();
    let round = false;
    for (const part of FABRIC_PARTS) {
      if (part.pending || document.querySelector(part.has)) continue;
      // Only revive a part this build actually ships.
      if (!here.includes(part.src)) continue;
      part.pending = true;
      round = true;
      const tag = runFabric(part.src);
      tag.onload = tag.onerror = () => { part.pending = false; };
    }
    // Counted per round, not per script: the chain is three deep and a limit
    // counting scripts would be spent before the first pass finished.
    if (round) revived++;
  };

  /* ------------------------------------------------------------------ *
   * More from this author, and what this title is actually like
   *
   * The series screen already ended with a Related row. On Vagabond it
   * offered Solo Leveling and Mushoku Tensei -- a match on Action and
   * Adventure, tags half the catalogue carries, ranked by popularity. It also
   * sat below 112 chapters, eleven thousand pixels down, where nobody was
   * ever going to see it.
   *
   * This answers the two questions a reader on a series page is actually
   * asking -- what else did this person make, and what is this one like --
   * from /api/catalog/related. It sits directly under the chapter list,
   * where the app's own Related row used to be and where it stands down in
   * favour of this one. Chapters come first: they are what the page is for.
   * ------------------------------------------------------------------ */

  const KIN_ID = 'yomu-kin';

  /** MangaDex's word for the relationship, in the reader's words. */
  const RELATION = {
    sequel: 'Sequel',
    prequel: 'Prequel',
    side_story: 'Side story',
    main_story: 'Main story',
    spin_off: 'Spin-off',
    adapted_from: 'Adapted from',
    based_on: 'Based on',
    colored: 'Colour edition',
    alternate_story: 'Alternate story',
    alternate_version: 'Alternate version',
    preserialization: 'Pre-serialisation',
    serialization: 'Serialisation',
    same_franchise: 'Same franchise',
    shared_universe: 'Shared universe',
    doujinshi: 'Doujinshi',
  };

  /** One answer per title, for the length of the session. */
  const kinCache = new Map();

  function kinFetch(key, context, title) {
    if (kinCache.has(key)) return kinCache.get(key);
    const query = new URLSearchParams({
      id: context.seriesId,
      source: context.sourceId,
      title,
    });
    const pending = fetch('/api/catalog/related?' + query)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    kinCache.set(key, pending);
    return pending;
  }

  function kinTile(entry) {
    const tile = document.createElement('a');
    tile.className = 'yomu-kin-tile';
    tile.href = '/series/' + encodeURIComponent(entry.id) + '?source=mangadex';

    const art = document.createElement('i');
    art.setAttribute('aria-hidden', 'true');
    if (entry.cover) art.style.backgroundImage = 'url("' + entry.cover + '")';
    tile.append(art);

    const name = document.createElement('strong');
    name.textContent = entry.title;
    tile.append(name);

    if (entry.relation && RELATION[entry.relation]) {
      const badge = document.createElement('em');
      badge.textContent = RELATION[entry.relation];
      tile.append(badge);
    } else {
      const facts = [entry.year, entry.status].filter(Boolean).join(' · ');
      if (facts) {
        const sub = document.createElement('small');
        sub.textContent = facts;
        tile.append(sub);
      }
    }
    return tile;
  }

  function kinRow(heading, note, entries) {
    const row = document.createElement('div');
    row.className = 'yomu-kin-row';

    const head = document.createElement('div');
    head.className = 'yomu-kin-head';
    const h2 = document.createElement('h2');
    h2.textContent = heading;
    head.append(h2);
    if (note) {
      const small = document.createElement('small');
      small.textContent = note;
      head.append(small);
    }

    const rail = document.createElement('div');
    rail.className = 'yomu-kin-rail';
    for (const entry of entries) rail.append(kinTile(entry));

    row.append(head, rail);
    return row;
  }

  function mountKin() {
    const context = seriesPageContext();
    const existing = document.getElementById(KIN_ID);
    if (!context) {
      // React drops it with the screen, but a route that renders without
      // repainting this branch would leave it behind.
      existing?.remove();
      document.documentElement.removeAttribute('data-yomu-kin');
      return;
    }

    // The same settle the cover tracking waits for, and for the same reason:
    // for a tick after a tap the URL is the new title while the DOM is still
    // the old one, and a request keyed off the wrong pair caches the wrong
    // author against the right page.
    const key = titleKey(context.sourceId, context.seriesId);
    if (seriesSettling.route !== key || Date.now() - seriesSettling.at < SETTLE_MS) return;

    const list = document.querySelector('.chapter-list');
    if (!list) return;
    const title = document.querySelector('.series-hero-copy h1')?.textContent?.trim() || '';
    if (!title) return;

    if (existing && existing.dataset.key === key) return;

    const section = document.createElement('section');
    section.id = KIN_ID;
    section.className = 'yomu-kin';
    section.dataset.key = key;
    // Holds its height while the answer is in flight, so the page does not
    // jump when the rows land under a reader already sitting at the bottom.
    section.dataset.pending = '1';
    if (existing) existing.replaceWith(section);
    else list.after(section);

    kinFetch(key, context, title).then((answer) => {
      // Gone, or the reader moved on while this was in the air.
      if (!section.isConnected || section.dataset.key !== key) return;
      section.removeAttribute('data-pending');
      if (!answer || !answer.matched) { section.remove(); return; }

      const rows = [];
      for (const credit of [answer.author, answer.artist]) {
        if (credit && credit.series && credit.series.length) {
          rows.push(kinRow('More from ' + credit.name, '', credit.series));
        }
      }
      if (answer.related && answer.related.length) {
        rows.push(kinRow('Related', 'Same work', answer.related));
      }
      if (answer.similar && answer.similar.length) {
        const because = (answer.similarBecause || []).join(' · ');
        rows.push(kinRow('You might like', because, answer.similar));
      }

      if (!rows.length) { section.remove(); return; }
      section.append(...rows);
      // Only now does the app's own Related row stand down: something better
      // sourced is on the page in its place.
      document.documentElement.toggleAttribute(
        'data-yomu-kin', !!(answer.similar && answer.similar.length));
    });
  }

  /* ------------------------------------------------------------------ *
   * Long chapter lists
   *
   * Martial Peak has 3,844 chapters and the series screen renders every one
   * of them: five buttons and a cover thumbnail per row, 64,000 nodes, a
   * scroll container 415,000 pixels tall. On a desktop that is merely
   * wasteful. On a phone it is the whole experience.
   *
   * Two earlier attempts, both measured, both aimed at the wrong thing:
   *
   * `visibility: hidden` skips the painting and keeps the layout. It took
   * the frame rate to 60 and did not help, because painting was not the
   * cost -- one reflow of this list still measured 88ms idle and 414ms
   * loaded, and a page being scrolled reflows constantly.
   *
   * `content-visibility: hidden` skips laying out a row's contents too, and
   * took the same reflow to 12ms. Better, and still not enough on a phone --
   * every row keeps a box, and Safari only understood the property at all
   * from version 18, so an older iPhone got nothing from it whatsoever.
   *
   * So: `display: none`, which every browser has always understood and which
   * takes the row out of the layout tree completely. The height it would
   * have occupied is held by two spacers, one above the window and one
   * below, sized from heights measured while the rows were standing on their
   * own. Nothing is removed from the DOM -- React owns these nodes and would
   * not survive finding them gone -- but nothing outside the window is laid
   * out, painted, or measured either.
   *
   * With positions no longer readable from skipped rows, they are computed
   * instead, from the same measurements the spacers are built from. That
   * makes the window arithmetic rather than DOM reads: one rect per
   * placement instead of two dozen, and the positions cannot disagree with
   * the layout because they are what produced it.
   *
   * The cost is that a skipped row is invisible to find-in-page and to a
   * screen reader until it is scrolled near, which is the reason the jump
   * field next to the Chapters heading searches the chapter numbers rather
   * than the page.
   * ------------------------------------------------------------------ */

  /** Under this a list costs little enough that the bookkeeping is waste. */
  const LONG_LIST = 250;
  /** Pixels kept rendered past each edge of the viewport. */
  const LIST_MARGIN = 4000;
  /** How far the viewport must travel before the window is worth moving. */
  const LIST_STEP = 1500;
  /** The list must hold one height this long before anything is skipped. */
  const LIST_SETTLE = 500;
  /** ...and no longer than this, however restless it turns out to be. */
  const LIST_PATIENCE = 6000;

  const windowedLists = new Set();

  function releaseList(state) {
    removeEventListener('scroll', state.onScroll, true);
    removeEventListener('resize', state.onResize);
    for (const row of state.rows) row.style.display = '';
    state.padTop?.remove();
    state.padEnd?.remove();
    windowedLists.delete(state);
  }

  /**
   * Heights, and the running total they add up to.
   *
   * Read only from rows that are standing on their own; a skipped row has no
   * box to report. An earlier version measured whatever was in front of it
   * and shipped a list 52,256 pixels short of itself, every skipped row
   * holding 14.6px less than it owed, so everything below the window sat in
   * the wrong place.
   */
  function measureList(state) {
    const { rows } = state;
    const gap = parseFloat(getComputedStyle(state.list).rowGap) || 0;
    const heights = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      heights[i] = rows[i].style.display === 'none' ? (state.heights?.[i] ?? 0)
        : rows[i].getBoundingClientRect().height;
    }
    const offsets = new Array(rows.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < rows.length; i++) offsets[i + 1] = offsets[i] + heights[i] + gap;

    state.gap = gap;
    state.heights = heights;
    state.offsets = offsets;
    state.natural = state.list.getBoundingClientRect().height;
    state.measured = heights.every((h) => h > 0);
  }

  function spacer(state, which) {
    const key = which === 'top' ? 'padTop' : 'padEnd';
    let pad = state[key];
    if (!pad || !pad.isConnected) {
      pad = document.createElement('div');
      pad.className = 'yomu-list-pad';
      pad.setAttribute('aria-hidden', 'true');
      pad.style.gridColumn = '1 / -1';
      pad.style.pointerEvents = 'none';
      state[key] = pad;
    }
    const first = state.list.firstElementChild;
    if (which === 'top' && first !== pad) state.list.prepend(pad);
    if (which === 'end' && state.list.lastElementChild !== pad) state.list.append(pad);
    return pad;
  }

  function placeWindow(state) {
    const { rows } = state;

    // The filter owns `display` while it is on, and hands it back on clear.
    if (state.filter) return;
    // Reads nothing: the scroll handler already knows how far the page went.
    if (state.placedAt !== null && Math.abs(state.top - state.placedAt) < LIST_STEP) return;

    /* Nothing is skipped until the list has stopped growing.
     *
     * These rows gain a row of release chips shortly after they first
     * render, and each one is about 15px taller afterwards. Measure before
     * that and every skipped row is holding 15px less than it owes -- the
     * list came out 59,903 pixels short, and the rows above the window would
     * grow under the reader as they arrived. A skipped row never gains its
     * chips, so the mistake is permanent once it is made and no amount of
     * re-checking finds it: the sum agrees with itself perfectly, and is
     * wrong. The only cure is to look later. */
    if (!state.measured) {
      const now = performance.now();
      const tall = state.list.getBoundingClientRect().height;
      if (tall !== state.lastTall) {
        state.lastTall = tall;
        state.stableAt = now;
      }
      // Give up waiting eventually: a list that never settles still deserves
      // a window, and a slightly wrong one beats none at all.
      if (now - state.stableAt < LIST_SETTLE && now - state.firstSeen < LIST_PATIENCE) {
        if (!state.settleTimer) {
          state.settleTimer = setTimeout(() => {
            state.settleTimer = null;
            state.placedAt = null;
            placeWindow(state);
          }, LIST_SETTLE + 60);
        }
        return;
      }
      measureList(state);
    }
    const { offsets, gap } = state;
    if (!offsets) return;

    // The only measurement a placement needs.
    const listTop = state.list.getBoundingClientRect().top;
    const want = (edge) => {
      // First row whose bottom is past `edge`, in viewport coordinates.
      let low = 0;
      let high = rows.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (listTop + offsets[middle + 1] < edge) low = middle + 1; else high = middle;
      }
      return low;
    };
    const lo = want(-LIST_MARGIN);
    const hi = want(innerHeight + LIST_MARGIN);
    if (lo === state.lo && hi === state.hi) { state.placedAt = state.top; return; }

    for (let i = 0; i < rows.length; i++) {
      const shown = i >= lo && i <= hi;
      const value = shown ? '' : 'none';
      if (rows[i].style.display !== value) rows[i].style.display = value;
    }

    /* The gap goes with the row: a grid lays one between each pair of items
       it can see, so the ones it can no longer see take theirs with them. */
    const above = offsets[lo];
    const below = offsets[rows.length] - offsets[hi + 1];
    spacer(state, 'top').style.height = Math.max(0, above - gap).toFixed(2) + 'px';
    spacer(state, 'end').style.height = Math.max(0, below - gap).toFixed(2) + 'px';

    state.lo = lo;
    state.hi = hi;
    state.placedAt = state.top;

    /* Check the arithmetic against the height the list had when every row
       was standing on its own. If the two disagree, everything below the
       window is sitting in the wrong place -- the one failure here a reader
       would feel. A pixel a row is the tolerance; past that the list is let
       go and measured again, later, when whatever was still arriving has
       arrived. */
    if (state.retries < 3) {
      const now = state.list.getBoundingClientRect().height;
      if (Math.abs(now - state.natural) > rows.length) {
        state.retries++;
        for (const row of rows) row.style.display = '';
        state.padTop?.remove();
        state.padEnd?.remove();
        state.measured = false;
        state.lo = -1;
        state.hi = -1;
        state.placedAt = null;
        setTimeout(() => placeWindow(state), 900);
      }
    }
  }

  function windowLongLists() {
    for (const state of [...windowedLists]) {
      if (!state.list.isConnected) releaseList(state);
    }

    for (const list of document.querySelectorAll('.chapter-list')) {
      const rows = [...list.children].filter((row) => !row.classList.contains('yomu-list-pad'));
      let state = null;
      for (const known of windowedLists) if (known.list === list) state = known;

      if (rows.length < LONG_LIST) {
        if (state) releaseList(state);
        continue;
      }
      // Rebuilt when the list is: a different row count, or a sort that put
      // a different row at the top.
      if (state && state.rows.length === rows.length && state.rows[0] === rows[0]) {
        placeWindow(state);
        continue;
      }
      if (state) releaseList(state);

      state = {
        list, rows, top: 0, placedAt: null, ticking: false,
        heights: null, offsets: null, gap: 0, natural: 0, measured: false,
        lo: -1, hi: -1, retries: 0, padTop: null, padEnd: null,
        firstSeen: performance.now(), lastTall: -1, stableAt: performance.now(),
        settleTimer: null, filter: '', text: null, hits: 0,
        onScroll: null, onResize: null,
      };
      state.onScroll = (event) => {
        // Whatever scrolled says so, and says how far. Identifying the
        // scrolling ancestor up front was guessed wrong once already -- at
        // mount the list is short and nothing looks scrollable yet.
        const node = event.target === document || event.target === window
          ? document.scrollingElement
          : event.target;
        if (!node || !node.contains || !node.contains(state.list)) return;
        state.top = node.scrollTop || 0;
        if (state.ticking) return;
        state.ticking = true;
        requestAnimationFrame(() => { state.ticking = false; placeWindow(state); });
      };
      state.onResize = () => {
        /* A different width is different heights. Every row is let go first,
           so the next pass measures what they are rather than what they were
           told to be. */
        for (const row of state.rows) row.style.display = '';
        state.padTop?.remove();
        state.padEnd?.remove();
        state.measured = false;
        state.lastTall = -1;
        state.stableAt = performance.now();
        state.firstSeen = performance.now();
        state.lo = -1;
        state.hi = -1;
        state.placedAt = null;
        placeWindow(state);
      };
      // Capture, because a scroll event does not bubble out of the element
      // that scrolled.
      addEventListener('scroll', state.onScroll, { capture: true, passive: true });
      addEventListener('resize', state.onResize, { passive: true });
      windowedLists.add(state);
      placeWindow(state);
    }
  }

  /* ------------------------------------------------------------------ *
   * Finding a chapter in a list of thousands
   *
   * Martial Peak's list is 415,000 pixels long and sorted newest first, so
   * chapter 1,200 is somewhere in the middle of five hundred screens and the
   * only tool for reaching it is distance. Windowing made that scroll
   * smooth; it did not make it short.
   *
   * A field beside the Chapters heading filters the list instead. Numbers
   * match chapter numbers, anything else matches the chapter's own text, and
   * the filter drives the same `display` the window does -- so a filtered
   * list is as cheap to render as a windowed one, and clearing it hands the
   * rows straight back to the window.
   * ------------------------------------------------------------------ */

  const JUMP_ID = 'yomu-chapter-jump';
  /** Short lists are faster to look at than to describe. */
  const JUMP_MIN = 40;

  /** What a row can be matched against, worked out once and kept. */
  function rowText(state, row, index) {
    if (!state.text) state.text = [];
    if (state.text[index] === undefined) {
      state.text[index] = (row.textContent || '').toLowerCase().replace(/\s+/g, ' ');
    }
    return state.text[index];
  }

  function applyFilter(state) {
    const rows = state.rows;
    const query = state.filter;
    if (!query) return;

    const numeric = /^[0-9]+(\.[0-9]+)?$/.test(query);
    let hits = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let match;
      if (numeric) {
        const n = row.getAttribute('data-chn');
        // Exact first, then "starts with", so 12 finds 12 before 120.
        match = n === query || (n != null && String(n).startsWith(query));
      } else {
        match = rowText(state, row, i).includes(query);
      }
      if (match) hits++;
      const value = match ? '' : 'none';
      if (row.style.display !== value) row.style.display = value;
    }
    // Nothing is standing in for hidden rows while filtering: the list is
    // meant to be short.
    if (state.padTop) state.padTop.style.height = '0px';
    if (state.padEnd) state.padEnd.style.height = '0px';
    state.hits = hits;
    return hits;
  }

  function setFilter(list, query) {
    let state = null;
    for (const known of windowedLists) if (known.list === list) state = known;
    // A list too short to window still gets to be searched.
    if (!state) {
      state = {
        list,
        rows: [...list.children].filter((row) => !row.classList.contains('yomu-list-pad')),
        text: null, filter: '', hits: 0, padTop: null, padEnd: null, loose: true,
      };
      looseFilters.set(list, state);
    }
    state.filter = query;
    const field = document.getElementById(JUMP_ID);

    if (!query) {
      for (const row of state.rows) row.style.display = '';
      state.placedAt = null;
      state.lo = -1;
      state.hi = -1;
      field?.removeAttribute('data-empty');
      if (!state.loose) placeWindow(state);
      return;
    }
    const hits = applyFilter(state);
    if (field) field.toggleAttribute('data-empty', hits === 0);
  }

  /** Filter state for lists short enough that no window was built for them. */
  const looseFilters = new WeakMap();

  function mountChapterJump() {
    const list = document.querySelector('.chapter-list');
    const line = document.querySelector('.section-line');
    const existing = document.getElementById(JUMP_ID);
    if (!list || !line) { existing?.remove(); return; }

    const rows = [...list.children].filter((row) => !row.classList.contains('yomu-list-pad'));
    if (rows.length < JUMP_MIN) { existing?.remove(); return; }
    if (existing && existing.parentElement === line) return;

    const field = existing || document.createElement('input');
    field.id = JUMP_ID;
    field.type = 'search';
    field.inputMode = 'numeric';
    field.autocomplete = 'off';
    field.placeholder = 'Chapter…';
    field.setAttribute('aria-label', 'Find a chapter');
    if (!field.dataset.wired) {
      field.dataset.wired = '1';
      field.addEventListener('input', () => {
        const target = document.querySelector('.chapter-list');
        if (target) setFilter(target, field.value.trim().toLowerCase());
      });
      // A search input's own clear button fires `search`, not `input`.
      field.addEventListener('search', () => {
        const target = document.querySelector('.chapter-list');
        if (target) setFilter(target, field.value.trim().toLowerCase());
      });
    }
    // Between the heading and the sort control, which is the order the line
    // already reads in.
    const sort = line.querySelector('button');
    if (sort) line.insertBefore(field, sort); else line.append(field);
  }

  /* ------------------------------------------------------------------ *
   * The source switcher, folded to its first line
   *
   * The app opens a series page with every other source that carries the
   * title listed in full. On a title four sources carry, with one of them
   * naming it in Chinese, that is most of a phone screen standing above the
   * cover -- the artwork, the title and Play all below the fold on the one
   * screen whose job is to make you want to read.
   *
   * Folded rather than removed. Which source you are reading from is the
   * useful half, and it is how you move off a source that is behind on
   * chapters; the list of the others is a thing you go looking for, once.
   * So the line stays, gains a count, and opens on a tap.
   *
   * The state lives on <html> and the tap is a delegated listener, so
   * nothing here writes to the bar itself -- React rebuilds that subtree
   * whenever the source list changes, and anything written into it would go
   * with it.
   * ------------------------------------------------------------------ */

  const SRC_FOLD_KEY = 'yomu.v1.srcSwitch';
  let srcFoldOpen = false;
  try { srcFoldOpen = localStorage.getItem(SRC_FOLD_KEY) === 'open'; } catch {}

  function paintSrcFold() {
    const want = srcFoldOpen ? 'expanded' : 'collapsed';
    const root = document.documentElement;
    if (root.getAttribute('data-yomu-src') !== want) root.setAttribute('data-yomu-src', want);
    const now = document.querySelector('.src-switch__now[role="button"]');
    if (now) now.setAttribute('aria-expanded', String(srcFoldOpen));
  }

  function foldSourceSwitch() {
    const bar = document.querySelector('.src-switch');
    if (!bar) return;
    const now = bar.querySelector('.src-switch__now');
    if (!now) return;
    const others = bar.querySelectorAll('.src-switch__list > li').length;

    // Nothing to fold away: one line is all there was.
    if (!others) {
      now.querySelector('.yomu-src-more')?.remove();
      now.removeAttribute('role');
      now.removeAttribute('tabindex');
      now.removeAttribute('aria-expanded');
      document.documentElement.setAttribute('data-yomu-src', 'expanded');
      return;
    }

    if (now.getAttribute('role') !== 'button') {
      now.setAttribute('role', 'button');
      now.setAttribute('tabindex', '0');
    }

    let more = now.querySelector('.yomu-src-more');
    if (!more) {
      more = document.createElement('em');
      more.className = 'yomu-src-more';
      now.append(more);
    }
    const label = others + (others === 1 ? ' other' : ' others');
    if (more.textContent !== label) more.textContent = label;

    paintSrcFold();
  }

  /**
   * One pass over everything this file maintains.
   *
   * All of it is idempotent and all of it is cheap -- each step either matches
   * nothing on the current route or finds the work already done and returns.
   * That is what lets the same pass serve both the initial mount and every
   * later mutation, with no per-screen bookkeeping to get out of step.
   */
  /* ------------------------------------------------------------------ *
   * The brand lockup
   *
   * The app's logo is an inline <svg class="yomu-logo"> compiled into the
   * bundle, and the kit's lockup is a different shape entirely: the mark, then
   * "Yomu" as live text with one span per letter so each can lift and turn
   * accent 85ms after the one before it. Pseudo-elements do not render on an
   * <svg>, so this cannot be done from the stylesheet -- it is new DOM, which
   * is what this file is for.
   *
   * Inserted as the logo's previous sibling rather than replacing it, so the
   * app's own element is never touched: React re-renders it freely, and the
   * stylesheet hides it with an adjacent-sibling rule. Idempotent -- a logo
   * that already has a lockup in front of it is skipped -- so the pass that
   * runs on every mutation costs nothing after the first.
   *
   * Geometry is the kit's: 195x168, two rounded parallelograms, 16 stroke.
   * ------------------------------------------------------------------ */
  const MARK_POINTS = [
    '8.00,12.75 79.00,47.02 79.00,155.25 8.00,120.98',
    '116.00,47.02 187.00,12.75 187.00,120.98 116.00,155.25',
  ];

  function brandLockup() {
    for (const logo of document.querySelectorAll('svg.yomu-logo')) {
      const prev = logo.previousElementSibling;
      if (prev && prev.classList.contains('yomu-lockup')) continue;

      const lockup = document.createElement('span');
      lockup.className = 'yomu-lockup';
      lockup.setAttribute('role', 'img');
      lockup.setAttribute('aria-label', 'Yomu');

      const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      mark.setAttribute('class', 'ymark');
      mark.setAttribute('viewBox', '0 0 195 168');
      mark.setAttribute('aria-hidden', 'true');
      for (const points of MARK_POINTS) {
        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        poly.setAttribute('points', points);
        poly.setAttribute('fill', 'currentColor');
        poly.setAttribute('stroke', 'currentColor');
        poly.setAttribute('stroke-width', '16');
        poly.setAttribute('stroke-linejoin', 'round');
        mark.append(poly);
      }

      // aria-hidden because the lockup already carries the name; a screen
      // reader should hear "Yomu" once, not four letters.
      const word = document.createElement('span');
      word.className = 'yword';
      word.setAttribute('aria-hidden', 'true');
      [...'Yomu'].forEach((letter, i) => {
        const span = document.createElement('span');
        span.style.setProperty('--i', String(i));
        span.textContent = letter;
        word.append(span);
      });

      lockup.append(mark, word);
      logo.before(lockup);
    }
  }

  const pass = () => {
    brandLockup();
    gateFabric();
    tagCompleted();
    badgeProgress();
    trackSeriesPage();
    mountSeriesResume();
    mountChapterJump();
    foldSourceSwitch();
    mountKin();
    windowLongLists();
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
  /* Delegated from the document, so it survives every rebuild of the bar. */
  const toggleSrcFold = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const now = target.closest('.src-switch__now[role="button"]');
    if (!now) return;
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    srcFoldOpen = !srcFoldOpen;
    try { localStorage.setItem(SRC_FOLD_KEY, srcFoldOpen ? 'open' : 'shut'); } catch {}
    paintSrcFold();
  };
  addEventListener('click', toggleSrcFold);
  addEventListener('keydown', toggleSrcFold);

  for (const type of ['popstate', 'hashchange']) addEventListener(type, pass);
})();
