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
   * Continue Reading
   *
   * The kit puts a row of resume cards under the hero. The web Home has no
   * such section -- the app only builds one on its native screen -- so unlike
   * the rest of the kit work this is new DOM rather than a restyle.
   *
   * Assembled from what the app already stores, fetching nothing:
   *   yomu.v1.resume.<account>.<seriesId>  ->  { anchor: { chapterId, pageIndex } }
   *   yomu.v1.collection .library[]        ->  { sourceId, id, title, cover, total }
   *
   * The resume key does not record which source a title came from, so a title
   * only appears once it is in the library, which is where the source lives.
   * Read something without saving it and it will not show here -- better than
   * guessing a source and sending the reader to a 404.
   * ------------------------------------------------------------------ */

  const RESUME_PREFIX = 'yomu.v1.resume.local-account.';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const CONTINUE_ID = 'yomu-continue';
  const MAX_CARDS = 6;
  const HOLD_MS = 2000;

  /** Series ids picked for removal, or null when not selecting. */
  let selection = null;

  function resumeEntries() {
    const out = [];
    let keys;
    try { keys = Object.keys(localStorage); } catch { return out; }
    for (const key of keys) {
      if (!key.startsWith(RESUME_PREFIX) || key.endsWith('.read')) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key) || 'null');
        const anchor = value && value.anchor;
        if (!anchor || typeof anchor.chapterId !== 'string') continue;
        out.push({ seriesId: key.slice(RESUME_PREFIX.length), anchor });
      } catch {}
    }
    return out;
  }

  function library() {
    try {
      const collection = JSON.parse(localStorage.getItem(COLLECTION_KEY) || 'null');
      return Array.isArray(collection && collection.library) ? collection.library : [];
    } catch { return []; }
  }

  function continueItems() {
    const saved = library();
    const items = [];
    for (const { seriesId, anchor } of resumeEntries()) {
      const entry = saved.find((t) => String(t.id) === seriesId && !t.hidden);
      if (!entry || !entry.sourceId) continue;
      // Home is a normal surface, so nothing adult belongs on it -- not even
      // something you were part-way through. 18+ has its own page.
      if (String(entry.category || '').toLowerCase() === 'adult') continue;

      const total = Number(entry.total);
      // pageIndex is within the chapter, so this is progress through the
      // chapter being read -- not through the series, which nothing records.
      const pages = Number(anchor.pageListVersion) || 0;
      const percent = pages > 0
        ? Math.min(100, Math.round(((Number(anchor.pageIndex) || 0) + 1) / pages * 100))
        : null;
      items.push({
        seriesId,
        title: entry.title || 'Untitled',
        cover: entry.cover,
        sourceId: entry.sourceId,
        chapterId: anchor.chapterId,
        chapters: Number.isFinite(total) && total > 0 ? total : null,
        percent,
      });
    }
    return items.slice(0, MAX_CARDS);
  }

  /* --- selection ------------------------------------------------------- */

  function forget(seriesIds) {
    for (const id of seriesIds) {
      try { localStorage.removeItem(RESUME_PREFIX + id); } catch {}
    }
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
      item.chapters ? item.chapters + ' chapters' : null,
      item.percent == null ? null : item.percent + '% through',
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

  function mountContinue() {
    // Home only. The kit places the row directly under the featured hero.
    if (location.pathname !== '/' && location.pathname !== '/index.html') return;

    // Anchored to the hero rather than to the section below it: the app grows a
    // "Your library" section once anything is saved, so "the first .home-sec"
    // is not a stable position -- and React re-renders .g-main, which leaves an
    // unmanaged node wherever it likes. Re-asserting on every tick is what
    // keeps it under the hero instead of drifting to the top.
    const anchor = document.querySelector('.hero-pagination')
      ?? document.querySelector('.hero-carousel');
    if (!anchor || !anchor.parentNode) return;

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
    if (section.previousElementSibling !== anchor || section.parentNode !== anchor.parentNode) {
      anchor.after(section);
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
          foldSettingsGroups();
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
   * Reader fullscreen
   *
   * The reader's own bars already fade to nothing, but the browser's chrome
   * stays -- so "hidden UI" still left an address bar and a home indicator
   * around the page. The Fullscreen API removes those where it exists.
   *
   * Where it does not exist is the case worth handling honestly: iOS Safari on
   * iPhone has never supported requestFullscreen (iPad does). There is no
   * workaround, so the button is replaced by a one-time note saying the thing
   * that actually works -- Add to Home Screen, which runs Yomu standalone with
   * no browser chrome at all.
   *
   * Entering fullscreen needs a user gesture, so the preference cannot be
   * applied on navigation. Instead the next deliberate tap inside the reader
   * restores it, which makes moving between chapters feel continuous.
   * ------------------------------------------------------------------ */

  const FS_KEY = 'yomu.v1.fullscreen';
  const FS_HINT_KEY = 'yomu.v1.fullscreenHint';
  const FS_ID = 'yomu-fullscreen';

  const fsWanted = () => { try { return localStorage.getItem(FS_KEY) === 'on'; } catch { return false; } };
  const setFsWanted = (on) => { try { localStorage.setItem(FS_KEY, on ? 'on' : 'off'); } catch {} };

  const fsElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
  const fsSupported = () => {
    const el = document.querySelector('.rd');
    return !!(el && (el.requestFullscreen || el.webkitRequestFullscreen));
  };
  /** Already running without browser chrome: installed to the Home Screen. */
  const isStandalone = () =>
    window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

  async function enterFullscreen() {
    const el = document.querySelector('.rd');
    if (!el) return;
    try {
      await (el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.());
    } catch {
      // Denied or unsupported. The preference stays, the note explains.
    }
  }
  function exitFullscreen() {
    try { (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document); } catch {}
  }

  const FS_ICON_ON =
    'M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3';
  const FS_ICON_OFF =
    'M3 8h3a2 2 0 0 0 2-2V3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M21 16h-3a2 2 0 0 0-2 2v3';

  function showHomeScreenHint() {
    try { if (localStorage.getItem(FS_HINT_KEY) === 'seen') return; } catch {}
    if (document.getElementById(FS_ID + '-hint')) return;
    const note = document.createElement('p');
    note.id = FS_ID + '-hint';
    note.className = 'yomu-fs__hint';
    note.textContent =
      'Safari cannot go fullscreen on iPhone. Share → Add to Home Screen, and Yomu opens with no browser bars at all.';
    document.body.append(note);
    const dismiss = () => {
      try { localStorage.setItem(FS_HINT_KEY, 'seen'); } catch {}
      note.remove();
    };
    note.addEventListener('click', dismiss);
    setTimeout(dismiss, 9000);
  }

  function mountFullscreen() {
    if (!location.pathname.startsWith('/read/')) return;
    // Nothing to hide when the app is already running standalone.
    if (isStandalone()) return;

    const foot = document.querySelector('.rd-foot');
    if (!foot) return;

    let button = document.getElementById(FS_ID);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.id = FS_ID;
      button.className = 'yomu-fs';
      button.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path/></svg>';
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!fsSupported()) { setFsWanted(true); showHomeScreenHint(); return; }
        if (fsElement()) { setFsWanted(false); exitFullscreen(); }
        else { setFsWanted(true); enterFullscreen(); }
      });
    }

    const on = !!fsElement();
    const path = button.querySelector('path');
    const want = on ? FS_ICON_OFF : FS_ICON_ON;
    if (path.getAttribute('d') !== want) path.setAttribute('d', want);
    const label = on ? 'Leave fullscreen' : 'Read fullscreen';
    if (button.getAttribute('aria-label') !== label) {
      button.setAttribute('aria-label', label);
      button.title = label;
    }

    // Re-asserted rather than rebuilt: React owns the footer.
    if (button.parentElement !== foot) foot.append(button);
  }

  // The preference cannot be applied without a gesture, so the first deliberate
  // tap in the reader restores it. Once only, and never fighting a manual exit.
  let fsRestoreArmed = true;
  document.addEventListener('pointerdown', () => {
    if (!fsRestoreArmed || !location.pathname.startsWith('/read/')) return;
    if (!fsWanted() || fsElement() || isStandalone() || !fsSupported()) return;
    fsRestoreArmed = false;
    enterFullscreen();
  }, true);

  for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(type, () => mountFullscreen());
  }

  const mount = () => {
    if (!document.getElementById(ID)) document.body.append(build());
    tagCompleted();
    mountContinue();
    explainIconButtons();
    foldSettingsGroups();
    mountBridge();
    mountFullscreen();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  // The grid mounts as results arrive, so new tiles need tagging as they land.
  // Cheap: tagCompleted only looks at tiles it has not already marked.
  new MutationObserver(() => { tagCompleted(); mountContinue(); explainIconButtons(); foldSettingsGroups(); mountBridge(); mountFullscreen(); }).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
