/**
 * Tapping Mori.
 *
 * Before this, a tap played a wave and said one of four lines. Pleasant, and
 * not a reason to tap twice. This makes the tap open a small menu instead:
 * pick up where you left off, or ask what to read next.
 *
 * **Nothing here is a model call.** There was a chat panel once, backed by a
 * paid API key, and it was removed: a companion whose best affordance stops
 * working when a key expires is worse than one that never had it. Suggest
 * reads the reader's own library and asks AniList what is similar to
 * something they already have -- from the browser, with Yomu's own catalogue
 * as the floor. It costs nothing and is always there.
 *
 * Every recommendation is a title Yomu can actually open. Nothing here
 * invents a name.
 */
(() => {
  'use strict';

  const MENU_ID = 'yomu-mori-menu';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const RESUME_PREFIX = 'yomu.v1.resume.local-account.';
  const CIRCLE_KEY = 'yomu.v1.circle';

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };

  /* Same guard as yomu-pet.js: this file is imported by its tests, where
     there is no window, and a bare addEventListener at module scope throws
     before a single assertion runs. */
  const browser = typeof document !== 'undefined';
  const on = (type, fn, opts) => { if (browser) addEventListener(type, fn, opts); };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  /* --- what we know about the reader -------------------------------------- */

  const library = () => {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    return Array.isArray(collection.library) ? collection.library.filter((t) => t && !t.hidden) : [];
  };

  /**
   * The series with the most finished chapters, preferring one we can name.
   *
   * You can read a great deal of something without ever saving it, and the
   * read lists are keyed by series id with no title in them. Taking the
   * highest count outright means the answer is often a bare id, and every
   * caller here needs a title -- so a nameable runner-up beats an anonymous
   * leader, and the leader is still returned when nothing is nameable.
   */
  function mostRead() {
    const counts = [];
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(RESUME_PREFIX) || !key.endsWith('.read')) continue;
        const list = readJSON(key, []);
        if (!Array.isArray(list) || !list.length) continue;
        counts.push({ seriesId: key.slice(RESUME_PREFIX.length, -'.read'.length), count: list.length });
      }
    } catch {}
    if (!counts.length) return null;
    counts.sort((a, b) => b.count - a.count);

    const shelf = library();
    const nameOf = (id) =>
      shelf.find((t) => t && (t.id === id || t.seriesId === id))?.title || '';

    for (const row of counts) {
      const title = nameOf(row.seriesId);
      if (title) return { ...row, title };
    }
    return { ...counts[0], title: '' };
  }

  /** A title to base a suggestion on: what you read most, else anything saved. */
  function seedTitle() {
    const top = mostRead();
    if (top?.title) return top.title;
    const shelf = library();
    return shelf.length ? (shelf[Math.floor(Math.random() * shelf.length)].title || '') : '';
  }

  /* --- the menu ------------------------------------------------------------ */

  let open = false;

  function close() {
    open = false;
    document.getElementById(MENU_ID)?.remove();
  }

  /** Anchor to the pet, flipping when it is close to an edge. */
  function place(panel, root) {
    const box = root.getBoundingClientRect();
    panel.style.position = 'fixed';
    /* Above the pet when there is room, below when there is not. */
    const below = box.top < 260;
    panel.style.top = below ? (box.bottom + 10) + 'px' : 'auto';
    panel.style.bottom = below ? 'auto' : (innerHeight - box.top + 10) + 'px';
    /* The dock is a row of four icons and is as wide as they are; the old
       text menu had a fixed column width. Measuring beats guessing, and it is
       what keeps the row centred on the pet rather than on a number. */
    const wide = Math.min(
      panel.classList.contains('ym-dock') ? Math.ceil(panel.getBoundingClientRect().width) || 232 : 260,
      innerWidth - 24,
    );
    panel.style.width = wide + 'px';
    panel.style.left = Math.max(12, Math.min(box.left + box.width / 2 - wide / 2, innerWidth - wide - 12)) + 'px';
  }

  /* --- the dock ------------------------------------------------------------ *
   *
   * A tap on Mori opens four icons, not a chat.
   *
   * It used to open the chat panel outright, which is a whole dialog and a
   * keyboard for what is often "make it dark" or "go away". The tap is a
   * choice between the four things Mori is actually for now -- talk to it,
   * change the look, flip the mode, put it away -- and the chat is one of the
   * four rather than the only one.
   *
   * The icons are inline SVG: no request, no sprite to keep in sync, and they
   * inherit currentColor, so the skins and the customizer reach them for free.
   * Every one is a real <button> with a label, and the row is a menubar the
   * arrow keys walk.
   */

  const GLYPH = {
    /* a speech bubble */
    message: 'M4 4.8h16a1.6 1.6 0 0 1 1.6 1.6v9.2a1.6 1.6 0 0 1-1.6 1.6H9.4L4.6 21v-3.8H4a1.6 1.6 0 0 1-1.6-1.6V6.4A1.6 1.6 0 0 1 4 4.8Z',
    /* sliders */
    customize: 'M4 7h9.1a3.2 3.2 0 0 0 6.2 0H21a1 1 0 0 0 0-2h-1.7a3.2 3.2 0 0 0-6.2 0H4a1 1 0 0 0 0 2Zm17 10h-9.1a3.2 3.2 0 0 0-6.2 0H4a1 1 0 0 0 0 2h1.7a3.2 3.2 0 0 0 6.2 0H21a1 1 0 0 0 0-2Z',
    /* a lamp: the light switch */
    mode: 'M12 2.6a6.6 6.6 0 0 0-3.9 11.9c.5.4.8 1 .8 1.6v.4h6.2v-.4c0-.6.3-1.2.8-1.6A6.6 6.6 0 0 0 12 2.6ZM9 18.2h6v1.1a1.4 1.4 0 0 1-1.4 1.4h-.2a1.5 1.5 0 0 1-2.8 0h-.2A1.4 1.4 0 0 1 9 19.3v-1.1Z',
    /* an eye, struck through */
    hide: 'M2.4 4.1 4 2.5l17.5 17.5-1.6 1.6-3.1-3.1a10.8 10.8 0 0 1-4.8 1.1c-4.6 0-8.6-2.9-10.3-7a12.3 12.3 0 0 1 3.9-5L2.4 4.1Zm9.6 3.3a4.6 4.6 0 0 1 4.6 4.6c0 .6-.1 1.1-.3 1.6l-5.9-5.9c.5-.2 1-.3 1.6-.3Zm0-3.9c4.6 0 8.6 2.9 10.3 7a12.4 12.4 0 0 1-2.6 4l-2.9-2.9a4.6 4.6 0 0 0-5.9-5.9L8.4 3.9c1.1-.3 2.3-.4 3.6-.4Z',
  };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ym-dock__glyph');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', GLYPH[name] || GLYPH.message);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
    return svg;
  }

  function openMenu() {
    const root = window.YomuPet?.root?.();
    if (!root) return;
    if (open) { close(); return; }
    open = true;
    window.YomuPet.hush?.();

    const menu = el('div', 'ym-dock');
    menu.id = MENU_ID;
    menu.setAttribute('role', 'menubar');
    menu.setAttribute('aria-label', 'Mori');

    /* Two names per icon: a short one under the glyph, because 58px of 9px
       text is four characters and a word cut in half reads as a bug, and the
       whole phrase on `aria-label` and `title`, because a screen reader and a
       hover both want the sentence. */
    const add = (name, label, short, run, missing) => {
      const item = el('button', 'ym-item ym-dock__button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('aria-label', label);
      item.title = label;
      item.dataset.ymAction = name;
      item.append(icon(name), el('span', 'ym-dock__label', short));
      /* A door that leads nowhere on this page is not offered at all rather
         than offered and dead. */
      if (missing) return null;
      item.addEventListener('click', run);
      menu.append(item);
      return item;
    };

    const look = window.YomuLook;

    add('message', 'Message Mori', 'Chat', () => {
      close();
      /* The chat is a door off this row now, not the room the tap lands in. */
      if (window.YomuMoriChat?.open) window.YomuMoriChat.open();
      else suggest();
    });

    add('customize', 'Customize look', 'Look', () => { close(); look.open(); }, !look?.open);

    const paper = look?.mode?.() === 'light';
    add('mode', paper ? 'Aurora mode' : 'Paper mode', paper ? 'Dark' : 'Light', () => { close(); look.toggleMode(); }, !look?.toggleMode);

    add('hide', 'Hide Mori', 'Hide', () => {
      close();
      window.YomuPet.set({ minimized: true });
      window.YomuPet.refresh();
    });

    /* A menubar walks with the arrow keys, wrapping at both ends. */
    menu.addEventListener('keydown', (event) => {
      if (!/^Arrow(Left|Right)$/.test(event.key)) return;
      const items = [...menu.querySelectorAll('.ym-item')];
      const here = items.indexOf(document.activeElement);
      if (here < 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      items[(here + step + items.length) % items.length].focus();
    });

    document.body.append(menu);
    place(menu, root);
    menu.querySelector('.ym-item')?.focus();
  }

  /* Clicking away closes it; so does Escape. Bound once, not per open. */
  on('pointerdown', (event) => {
    if (!open) return;
    if (event.target.closest?.('#' + MENU_ID)) return;
    if (event.target.closest?.('#yomu-pet')) return;
    close();
  }, true);

  on('keydown', (event) => { if (open && event.key === 'Escape') close(); });

  /* --- suggest: recommendations without a model ---------------------------- */

  async function suggest() {
    close();
    const title = seedTitle();
    if (!title) {
      window.YomuPet.say('Save a couple of things first and I will have something to go on.', 5200);
      return;
    }

    window.YomuPet.setState('thinking', 12000);
    window.YomuPet.say('Looking at your shelf…', 12000);

    try {
      /* From this browser, not the Worker: AniList blocks datacentre egress
         outright (403, "manually blocked"), so the server can never be the
         one to ask. YomuAniList falls through to the Worker's MangaDex floor
         on its own if this browser cannot reach it either. */
      const data = (await window.YomuAniList?.similar?.(title)) || {};
      const rows = (data.picks || []).slice(0, 3);
      if (!rows.length) {
        window.YomuPet.release();
        window.YomuPet.say('Nothing close to ' + title + ' in the catalogue today.', 5200);
        return;
      }
      /* The lookup is over, so the busy hold ends before the reaction --
         'happy' ranks below 'thinking' and would otherwise be refused. */
      window.YomuPet.release();
      window.YomuPet.setState('happy', 2000);
      showPicks(data.matched || title, rows, data.because || []);
    } catch {
      window.YomuPet.release();
      window.YomuPet.say('I could not reach the shelf just now.', 4200);
    }
  }

  /**
   * The picks, as a panel rather than a bubble.
   *
   * A speech bubble auto-dismisses and cannot be tapped through to a series,
   * which is the one thing a recommendation has to allow.
   */
  function showPicks(seed, rows, because) {
    const root = window.YomuPet?.root?.();
    if (!root) return;
    window.YomuPet.hush?.();
    close();
    open = true;

    const panel = el('div', 'ym-menu');
    panel.id = MENU_ID;

    const head = el('div', 'ym-head');
    head.append(el('span', 'ym-head__kicker', 'Because you read'));
    head.append(el('strong', null, seed));
    if (because.length) head.append(el('span', 'ym-head__tags', because.slice(0, 3).join(' · ')));
    panel.append(head);

    for (const row of rows) {
      const item = el('button', 'ym-item');
      item.type = 'button';
      item.append(el('span', 'ym-item__label', row.title));
      /* The vote count is the recommendation's evidence, so it is on screen
         rather than only in the model's head. */
      const hint = row.votes
        ? row.votes.toLocaleString() + (row.votes === 1 ? ' reader' : ' readers')
        : [row.year, row.status].filter(Boolean).join(' · ');
      if (hint) item.append(el('span', 'ym-item__hint', hint));
      item.addEventListener('click', () => {
        close();
        /* Search rather than a direct link: the related rows are MangaDex
           ids, and which source can actually serve the title is the search
           page's job to work out. */
        location.href = '/search?q=' + encodeURIComponent(row.title);
      });
      panel.append(item);
    }

    document.body.append(panel);
    place(panel, root);
  }

  /* --- boot ---------------------------------------------------------------- *
   *
   * The chat kept its transcript in localStorage. The feature is gone, so the
   * transcript is somebody's typing sitting on their device for a panel that
   * no longer opens -- cleared once, on the load that first lacks it.
   */

  if (browser) {
    try { localStorage.removeItem('yomu.v1.mori.history'); } catch {}
  }


  /* Returning true claims the tap. The pet keeps its own fallback for the
     case where this file is absent. */
  const claim = () => { openMenu(); return true; };

  if (browser) {
    if (window.YomuPet?.onTap) window.YomuPet.onTap(claim);
    else on('load', () => window.YomuPet?.onTap?.(claim), { once: true });
  }

  /* A moved or unmounted pet must not leave a menu floating where it was. */
  on('resize', () => { if (open) close(); });
  /* popstate and hashchange miss the app's own navigation, which is
     pushState and fires neither -- so the pet announces the surface change
     and this listens for that rather than wrapping history a second time. */
  on('yomu:pet-surface', close);
  /* Mori wanders Home now (yomu-roam.js), and a menu anchored to where it
     used to stand is a menu floating over a cover. */
  on('yomu:pet-moved', close);
  for (const type of ['popstate', 'hashchange']) on(type, close);

  if (browser) window.YomuMori = { openMenu, suggest, close };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { mostRead, seedTitle, library };
  }
})();
