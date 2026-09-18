/**
 * Tapping Mori.
 *
 * Before this, a tap played a wave and said one of four lines. Pleasant, and
 * not a reason to tap twice. This makes the tap open a small menu instead:
 * pick up where you left off, ask what to read next, or talk to Mori.
 *
 * Two different things answer "what should I read", and the difference is
 * worth keeping straight:
 *
 *   **Suggest** is not AI. It reads the reader's own library, asks Yomu's
 *   catalogue what is similar to something they already have, and shows the
 *   answer. It costs nothing, works offline-ish, and is always available.
 *
 *   **Ask** is a real model call, and is the only part of Yomu that costs
 *   money per use. It is hidden entirely unless the deployment has a key --
 *   `/api/mori/status` decides, not this file -- so it cannot render a button
 *   that leads nowhere.
 *
 * Every recommendation, from either path, is a title Yomu can actually open.
 * Nothing here invents a name.
 */
(() => {
  'use strict';

  const MENU_ID = 'yomu-mori-menu';
  const CHAT_ID = 'yomu-mori-chat';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const RESUME_PREFIX = 'yomu.v1.resume.local-account.';
  const CIRCLE_KEY = 'yomu.v1.circle';
  const HISTORY_KEY = 'yomu.v1.mori.history';

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
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

  const displayName = () => {
    const raw = readJSON(CIRCLE_KEY, {})?.name;
    return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 24) : '';
  };

  /** The genres the progression store has been quietly learning. */
  function topGenres() {
    const affinity = window.YomuProgress?.get?.().affinity || {};
    const families = window.YomuBadges?.list?.() || [];
    return Object.entries(affinity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([slug]) => families.find((f) => f.slug === slug)?.theme || slug);
  }

  /* --- is chat even available? -------------------------------------------- *
   *
   * Asked once, cached for the page. A deployment with no key must show no
   * chat affordance at all -- a button that always fails is worse than a
   * feature that is not there.
   */

  let chatReady = null;

  async function chatAvailable() {
    if (chatReady !== null) return chatReady;
    try {
      const response = await fetch('/api/mori/status');
      const data = await response.json();
      chatReady = !!data.configured;
    } catch { chatReady = false; }
    return chatReady;
  }

  /* --- the menu ------------------------------------------------------------ */

  let open = false;

  function close() {
    open = false;
    document.getElementById(MENU_ID)?.remove();
    document.getElementById(CHAT_ID)?.remove();
  }

  /** Anchor to the pet, flipping when it is close to an edge. */
  function place(panel, root) {
    const box = root.getBoundingClientRect();
    panel.style.position = 'fixed';
    /* Above the pet when there is room, below when there is not. */
    const below = box.top < 260;
    panel.style.top = below ? (box.bottom + 10) + 'px' : 'auto';
    panel.style.bottom = below ? 'auto' : (innerHeight - box.top + 10) + 'px';
    const wide = Math.min(260, innerWidth - 24);
    panel.style.width = wide + 'px';
    panel.style.left = Math.max(12, Math.min(box.left + box.width / 2 - wide / 2, innerWidth - wide - 12)) + 'px';
  }

  async function openMenu() {
    const root = window.YomuPet?.root?.();
    if (!root) return;
    if (open) { close(); return; }
    open = true;
    window.YomuPet.hush?.();

    const menu = el('div', 'ym-menu');
    menu.id = MENU_ID;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Mori');

    const add = (label, hint, run) => {
      const item = el('button', 'ym-item');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.append(el('span', 'ym-item__label', label));
      if (hint) item.append(el('span', 'ym-item__hint', hint));
      item.addEventListener('click', run);
      menu.append(item);
      return item;
    };

    const resume = mostRead();
    if (resume?.title) {
      add('Keep reading', resume.title, () => {
        close();
        location.href = '/library';
      });
    }

    add('What should I read?', 'From your shelf', () => suggest());

    /* Only when the deployment can actually answer. */
    if (await chatAvailable()) {
      add('Ask Mori…', 'Talk about books', () => openChat());
    }

    add('Hide Mori', null, () => {
      close();
      window.YomuPet.set({ minimized: true });
      window.YomuPet.refresh();
    });

    document.body.append(menu);
    place(menu, root);
    menu.querySelector('.ym-item')?.focus();
  }

  /* Clicking away closes it; so does Escape. Bound once, not per open. */
  on('pointerdown', (event) => {
    if (!open) return;
    if (event.target.closest?.('#' + MENU_ID)) return;
    if (event.target.closest?.('#' + CHAT_ID)) return;
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

  /* --- chat ---------------------------------------------------------------- */

  const history = () => {
    const rows = readJSON(HISTORY_KEY, []);
    return Array.isArray(rows) ? rows.slice(-8) : [];
  };

  function openChat() {
    const root = window.YomuPet?.root?.();
    if (!root) return;
    close();
    open = true;
    window.YomuPet.hush?.();

    const panel = el('div', 'ym-chat');
    panel.id = CHAT_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Ask Mori');

    const head = el('div', 'ym-chat__head');
    head.append(el('strong', null, 'Ask Mori'));
    const shut = el('button', 'ym-chat__x', '×');
    shut.type = 'button';
    shut.setAttribute('aria-label', 'Close');
    shut.addEventListener('click', close);
    head.append(shut);
    panel.append(head);

    const log = el('div', 'ym-log');
    log.setAttribute('aria-live', 'polite');
    panel.append(log);

    for (const turn of history()) addTurn(log, turn.role, turn.content);
    if (!history().length) {
      addTurn(log, 'assistant', 'Ask me what to read next, or about something on your shelf.');
    }

    const form = el('form', 'ym-form');
    const input = el('input', 'ym-input');
    input.type = 'text';
    input.maxLength = 600;
    input.placeholder = 'Something like Solo Leveling?';
    input.setAttribute('aria-label', 'Message Mori');
    const send = el('button', 'ym-send', 'Ask');
    send.type = 'submit';
    form.append(input, send);
    panel.append(form);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || send.disabled) return;
      input.value = '';
      addTurn(log, 'user', text);

      send.disabled = true;
      const pending = addTurn(log, 'assistant', '…');
      pending.classList.add('is-pending');
      window.YomuPet.setState('thinking', 30000);

      const reply = await ask(text);
      pending.remove();
      addTurn(log, 'assistant', reply);
      window.YomuPet.release();
      window.YomuPet.setState('happy', 1600);
      send.disabled = false;
      input.focus();

      const rows = history();
      rows.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      writeJSON(HISTORY_KEY, rows.slice(-8));
    });

    document.body.append(panel);
    place(panel, root);
    input.focus();
  }

  function addTurn(log, role, text) {
    const row = el('div', 'ym-turn ym-turn--' + role, text);
    log.append(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  /**
   * One call. The context is a courtesy to the model, not a credential -- the
   * Worker treats every field of it as untrusted and only reads it back as
   * flavour text, so a tampered payload can change Mori's tone and nothing
   * else.
   */
  async function ask(message) {
    const top = mostRead();
    try {
      const response = await fetch('/api/mori/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
          history: history(),
          context: {
            name: displayName(),
            chaptersRead: window.YomuProgress?.get?.().chaptersRead ?? 0,
            topGenres: topGenres(),
            library: library().slice(0, 12).map((t) => t.title).filter(Boolean),
            reading: top?.title || '',
          },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return data.error || 'I could not answer that one.';
      return data.reply || 'I lost my thread there.';
    } catch {
      return 'I could not reach anyone just now.';
    }
  }

  /* --- boot ---------------------------------------------------------------- */

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
  for (const type of ['popstate', 'hashchange']) on(type, close);

  if (browser) window.YomuMori = { openMenu, openChat, suggest, close, chatAvailable };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { mostRead, seedTitle, library, HISTORY_KEY };
  }
})();
