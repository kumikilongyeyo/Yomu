/**
 * Yomu Circles — the client half.
 *
 * Two surfaces, and no new screen for either.
 *
 * Settings gets a Circle group beside Devices: start one, join one with a
 * code, see who is in it. Deliberately next to Devices and deliberately not
 * merged with it -- they look alike and they are not alike. The sync code
 * pairs your own devices and carries your whole library. The circle code lets
 * other people write comments and nothing else. Two rows that far apart in
 * consequence should not share one.
 *
 * The reader gets the chapter's conversation, at the foot of the chapter,
 * where you arrive the moment you have earned the right to read it. That is
 * the spoiler gate working: the server sends only comments on chapters you
 * have reached, and a count of the ones waiting further on. This file never
 * receives the hidden text, so there is nothing here to leak.
 *
 * When the Expo source turns up this belongs beside the reader; delete this
 * file then.
 */
(() => {
  'use strict';

  const STATE_KEY = 'yomu.v1.circle';
  const GROUP_ID = 'yomu-circle';
  const THREAD_ID = 'yomu-thread';
  /** Read for the equipped badge only. yomu-progress.js owns the store. */
  const PROGRESS_KEY = 'yomu.v1.progress';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const READING_KEY = 'yomu.v1.reading';

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  const state = () => {
    const value = readJSON(STATE_KEY, null);
    return value && typeof value === 'object' ? value : {};
  };
  const setState = (patch) => writeJSON(STATE_KEY, { ...state(), ...patch });
  const joined = () => !!(state().code && state().memberId);
  /**
   * Comments in the reader, off unless asked for.
   *
   * The end of a chapter is the end of a chapter. Putting a conversation
   * there by default -- and, worse, an invitation to set one up when there is
   * no circle at all -- turns the last page into a prompt. The circle is
   * worth having and is not worth interrupting a book with uninvited.
   */
  const commentsInReader = () => state().inReader === true;

  const display = (code) =>
    code ? 'YOMU-' + code.slice(0, 5) + '-' + code.slice(5) : '';

  /** The badge beside your name, sent with every call so the circle sees
   *  what you are wearing without a call of its own. '' means none. */
  const equippedBadge = () => {
    const progress = readJSON(PROGRESS_KEY, null);
    return progress && typeof progress.equippedBadgeId === 'string' ? progress.equippedBadgeId : '';
  };

  async function api(route, payload) {
    const response = await fetch('/api/circle/' + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: state().code, memberId: state().memberId, badge: equippedBadge(), ...payload,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'That did not work.');
    return data;
  }

  /* --- where we are ------------------------------------------------------ */

  function readerContext() {
    if (!location.pathname.startsWith('/read/')) return null;
    const raw = location.pathname.slice('/read/'.length);
    if (!raw) return null;
    let chapterId = raw;
    try { chapterId = decodeURIComponent(raw); } catch {}
    const sourceId = new URLSearchParams(location.search).get('source') || '';
    if (!sourceId) return null;

    // The chapter *number*, which is what the gate compares -- not the id.
    // The header is the only place it appears, and it is the same string the
    // reader is showing the person, so the two cannot disagree.
    const label = document.querySelector('.rd-head__copy p')?.textContent || '';
    const match = /(\d+(?:\.\d+)?)/.exec(label);
    return {
      sourceId,
      seriesId: chapterId.split(':')[0],
      chapter: match ? Number(match[1]) : 0,
      label: label.trim(),
    };
  }

  const ago = (at) => {
    const seconds = Math.max(0, (Date.now() - at) / 1000);
    if (seconds < 90) return 'just now';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm';
    if (seconds < 86400) return Math.round(seconds / 3600) + 'h';
    if (seconds < 172800) return 'yesterday';
    return Math.round(seconds / 86400) + 'd';
  };

  /** A stable colour per name, so a face is recognisable down a thread. */
  function hue(name) {
    let total = 0;
    for (let i = 0; i < name.length; i++) total = (total * 31 + name.charCodeAt(i)) % 360;
    return total;
  }

  const initial = (name) => [...(name || '?')][0].toUpperCase();

  /* ------------------------------------------------------------------ *
   * Settings: the Circle group
   * ------------------------------------------------------------------ */

  let members = [];
  let isOwner = false;
  /** The reading race switch, as the server last reported it. */
  let raceOn = false;
  const takeCircle = (circle) => {
    if (!circle) return;
    if (Array.isArray(circle.members)) members = circle.members;
    isOwner = !!circle.youAreOwner;
    raceOn = !!circle.race;
  };

  function row(title, subtitle, onClick, extra) {
    const element = document.createElement(onClick ? 'button' : 'div');
    if (onClick) { element.type = 'button'; element.addEventListener('click', onClick); }
    element.className = 'settings-row' + (extra || '');
    const copy = document.createElement('div');
    copy.className = 'settings-row__copy';
    const strong = document.createElement('strong');
    strong.textContent = title;
    copy.append(strong);
    if (subtitle) {
      const small = document.createElement('small');
      small.textContent = subtitle;
      copy.append(small);
    }
    element.append(copy);
    return element;
  }

  function askName(prompt, fallback) {
    const given = window.prompt(prompt, state().name || fallback || '');
    return given === null ? null : (given.trim().slice(0, 32) || fallback || 'Someone');
  }

  function renderGroup() {
    const group = document.getElementById(GROUP_ID);
    if (!group) return;
    group.textContent = '';

    if (!joined()) {
      group.append(row(
        'Start a reading circle',
        'Chapter comments for people you invite. Nobody else can see them.',
        async () => {
          const name = askName('What should the circle call you?', 'Me');
          if (name === null) return;
          try {
            const circle = await api('create', { name, circleName: 'Reading circle', code: undefined });
            adopt(circle, name);
          } catch (error) { note(error.message); }
        },
      ));
      group.append(row('Join with a circle code', 'Someone has to invite you first', async () => {
        const code = window.prompt('Circle code');
        if (!code) return;
        const name = askName('What should the circle call you?', 'Me');
        if (name === null) return;
        try {
          const circle = await api('join', { code, name, memberId: undefined });
          adopt(circle, name);
        } catch (error) { note(error.message); }
      }));
      // Said once, here, because this is where the two codes could be
      // confused and confusing them is the expensive mistake.
      group.append(row(
        'This is not your sync code',
        'A circle code lets other people comment. It gives nobody your library.',
      ));
      return;
    }

    group.append(row('Circle code', display(state().code), () => {
      navigator.clipboard?.writeText(display(state().code)).catch(() => {});
      note('Code copied. Send it only to people you want reading along.');
    }, ' is-accent'));

    for (const member of members) {
      group.append(row(
        member.name + (member.isYou ? ' (you)' : '') + (member.isOwner ? ' · started it' : ''),
        'Last seen ' + ago(member.lastSeen),
        isOwner && !member.isYou ? () => removeMember(member) : null,
      ));
    }

    const showing = commentsInReader();
    group.append(row(
      'Comments in the reader',
      showing
        ? 'On · shown at the end of each chapter'
        : 'Off · the reader stays a reader',
      () => { setState({ inReader: !showing }); renderGroup(); },
      showing ? ' is-accent' : '',
    ));

    group.append(row(
      'Reading race',
      raceOn
        ? 'On · a leader badge for the week, on every chapter list'
        : 'Off · chapter lists still show where everyone is',
      async () => {
        if (!isOwner) { note('Only whoever started the circle can switch the race.'); return; }
        try {
          const circle = await api('race', { on: !raceOn });
          takeCircle(circle);
          renderGroup();
        } catch (error) { note(error.message); }
      },
      raceOn ? ' is-accent' : '',
    ));

    group.append(row(
      isOwner ? 'Close this circle' : 'Leave this circle',
      isOwner
        ? 'Ends it for everyone, and deletes every comment in it.'
        : 'Your comments stay, with your name on them.',
      isOwner ? closeCircle : leaveCircle,
    ));
  }

  function adopt(circle, name) {
    setState({ code: circle.code, memberId: circle.memberId, name });
    takeCircle(circle);
    renderGroup();
  }

  async function removeMember(member) {
    if (!confirm('Remove ' + member.name + "? Their comments stay, with their name greyed out.")) return;
    try {
      const circle = await api('remove', { target: member.id });
      members = circle.members || [];
      renderGroup();
    } catch (error) { note(error.message); }
  }

  async function closeCircle() {
    if (!confirm('Close this circle? Every comment in it is deleted, for everyone. This cannot be undone.')) return;
    try {
      await api('destroy', {});
      try { localStorage.removeItem(STATE_KEY); } catch {}
      members = [];
      isOwner = false;
      renderGroup();
    } catch (error) { note(error.message); }
  }

  async function leaveCircle() {
    if (!confirm('Leave this circle? You will need the code again to come back.')) return;
    try { await api('leave', {}); } catch {}
    try { localStorage.removeItem(STATE_KEY); } catch {}
    members = [];
    renderGroup();
  }

  function note(message) {
    const existing = document.getElementById('yomu-circle-note');
    if (existing) existing.remove();
    const element = document.createElement('p');
    element.id = 'yomu-circle-note';
    element.className = 'yomu-imm-note yomu-imm-note--wide';
    element.textContent = message;
    document.body.append(element);
    setTimeout(() => element.remove(), 5000);
  }

  /**
   * The circle lives on Your Yomu, not in Settings.
   *
   * It was a third group of mine in a screen that already had six of the
   * app's own plus whatever Source Fabric injects, and the result was that
   * nothing in there had room -- including things that were there first.
   * Settings keeps the one job that is unambiguously settings: pairing your
   * own devices. Who you are, and who reads with you, belong together on the
   * screen that is about that.
   *
   * you.html supplies the container; this stays the only copy of the UI.
   */
  function mountGroup() {
    const host = document.getElementById('yomu-circle-here');
    if (!host) return;

    let group = document.getElementById(GROUP_ID);
    if (!group) {
      group = document.createElement('section');
      group.className = 'settings-group glass';
      group.id = GROUP_ID;
    }
    if (!group.isConnected) {
      host.append(group);
      renderGroup();
      if (joined()) refreshMembers();
    }
  }

  async function refreshMembers() {
    try {
      const circle = await api('info', {});
      takeCircle(circle);
      renderGroup();
    } catch (error) {
      if (/not a member|No circle/i.test(error.message)) {
        try { localStorage.removeItem(STATE_KEY); } catch {}
        members = [];
        renderGroup();
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * The reader: the chapter's conversation, at the foot of the chapter
   *
   * Mounted inside the scroll surface, after the last page, so it is where
   * you arrive rather than somewhere you navigate. React owns one child of
   * that surface -- the sized page container -- and this is appended as a
   * second, which it leaves alone.
   * ------------------------------------------------------------------ */

  let threadFor = '';
  let thread = null;
  let loading = false;

  const threadKeyOf = (context) =>
    context ? `${context.sourceId}:${context.seriesId}:${context.chapter}` : '';

  async function loadThread(context) {
    if (loading) return;
    loading = true;
    try {
      thread = await api('read', {
        sourceId: context.sourceId,
        seriesId: context.seriesId,
        chapter: context.chapter,
      });
      // Taken from the thread rather than from Settings. These are set when
      // the Circle group mounts, which only happens on /settings -- so an
      // owner who opened the reader directly had no Delete on anyone else's
      // comment, which is most of the moderation this design has.
      if (thread.circle) takeCircle(thread.circle);
      /* The race and the heat strip listen for this: the same gated answer
         feeds every social surface, so nothing is fetched twice. */
      dispatchEvent(new CustomEvent('yomu:circle-thread', {
        detail: {
          key: context.sourceId + ':' + context.seriesId,
          chapter: context.chapter,
          reached: thread.reached,
          comments: thread.comments || [],
          race: thread.race || null,
        },
      }));
      // Opening a chapter's conversation is having seen it, which is what the
      // series page's "3 new" counts against. Marked on the newest comment
      // rather than on the clock, so a comment posted while this was open is
      // still new next time.
      const newest = (thread.comments || []).reduce((high, c) => Math.max(high, c.at), 0);
      if (newest) markSeen(context.sourceId + ':' + context.seriesId, newest);
    } catch (error) {
      thread = { error: error.message };
      if (/not a member|No circle/i.test(error.message)) {
        try { localStorage.removeItem(STATE_KEY); } catch {}
      }
    } finally {
      loading = false;
      paintThread();
    }
  }

  function commentNode(comment) {
    const item = document.createElement('article');
    item.className = 'yomu-cmt' + (comment.present ? '' : ' is-gone');

    const face = document.createElement('span');
    face.className = 'yomu-cmt__face';
    face.style.background = `hsl(${hue(comment.name)} 58% 62%)`;
    face.textContent = initial(comment.name);

    const body = document.createElement('div');
    body.className = 'yomu-cmt__body';

    const head = document.createElement('div');
    head.className = 'yomu-cmt__head';
    const who = document.createElement('b');
    who.textContent = comment.name;
    // The badge they are wearing, live from the membership -- so a badge
    // changed today shows on a comment from last week, the way a name does
    // not. Micro, and inside the name so a long thread stays one line per
    // head.
    if (comment.badge && window.YomuShelf?.el) {
      const mark = window.YomuShelf.el(comment.badge, { variant: 'micro', size: 16 });
      if (mark) {
        const wrap = document.createElement('span');
        wrap.className = 'yomu-cmt__badge';
        wrap.title = window.YomuShelf.title(comment.badge) || '';
        wrap.append(mark);
        who.append(wrap);
      }
    }
    const when = document.createElement('span');
    when.textContent = ago(comment.at) + (comment.present ? '' : ' · left the circle');
    head.append(who, when);

    const text = document.createElement('p');
    text.textContent = comment.text;

    const tools = document.createElement('div');
    tools.className = 'yomu-cmt__tools';

    tools.append(reactionsNode(comment));

    if (comment.mine || isOwner) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'yomu-cmt__del';
      remove.textContent = 'Delete';
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        const context = readerContext();
        if (!context || !confirm('Delete this comment?')) return;
        try {
          await api('delete', { ...context, commentId: comment.id });
          loadThread(context);
        } catch (error) { note(error.message); }
      });
      tools.append(remove);
    }

    body.append(head, text, tools);
    if (pickerFor === comment.id) body.append(pickerNode(comment));
    item.append(face, body);
    return item;
  }

  /* ------------------------------------------------------------------ *
   * Reactions: stickers instead of a heart
   *
   * A like was a counter anyone could bump. A sticker is something the
   * reader earned by reading -- the store grants them at five chapters, a
   * hundred, a finished title -- so the picker offers only the ones you
   * have, and a rare one under a comment says something. One per member,
   * replaceable, and gated exactly as likes were: you cannot react to what
   * you cannot read.
   * ------------------------------------------------------------------ */

  /** Which comment's picker is open. One at a time; the thread is small. */
  let pickerFor = '';

  const owned = () => window.YomuStickers?.earned?.() || [];

  async function reactWith(comment, sticker) {
    const context = readerContext();
    if (!context) return;
    try {
      await api('react', { ...context, commentId: comment.id, sticker });
      pickerFor = '';
      loadThread(context);
    } catch (error) { note(error.message); }
  }

  function reactionsNode(comment) {
    const box = document.createElement('div');
    box.className = 'yomu-cmt__reactions';
    const S = window.YomuStickers;
    const mine = owned();

    for (const group of comment.reactions || []) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'yomu-react' + (group.mine ? ' is-mine' : '');
      const art = S?.el?.(group.sticker, { size: 20 });
      if (art) chip.append(art);
      chip.append(document.createTextNode(String(group.count)));
      const info = S?.info?.(group.sticker);
      // Who, not how many: at this size that is the more useful fact, and
      // the server sends the names precisely so they can be shown.
      chip.title = (info ? info.title : 'Sticker') + (group.names?.length ? ' · ' + group.names.join(', ') : '');
      chip.setAttribute('aria-label',
        (info ? info.title : 'Sticker') + ', ' + group.count + (group.mine ? ', yours' : ''));
      chip.addEventListener('click', (event) => {
        event.stopPropagation();
        if (group.mine) { reactWith(comment, ''); return; }
        // Joining in with a sticker you own is one tap. One you have not
        // earned opens the picker instead, which is where it says so.
        if (mine.includes(group.sticker)) { reactWith(comment, group.sticker); return; }
        pickerFor = comment.id;
        paintThread();
      });
      box.append(chip);
    }

    // Hearts from before stickers existed. History, not a control.
    if (comment.likes) {
      const old = document.createElement('span');
      old.className = 'yomu-react__old';
      old.textContent = '♥ ' + comment.likes;
      if (comment.likedBy?.length) old.title = comment.likedBy.join(', ');
      box.append(old);
    }

    const open = pickerFor === comment.id;
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'yomu-react__add';
    add.textContent = open ? '×' : '+';
    add.setAttribute('aria-label', open ? 'Close the sticker picker' : 'React with a sticker');
    add.setAttribute('aria-expanded', String(open));
    add.addEventListener('click', (event) => {
      event.stopPropagation();
      pickerFor = open ? '' : comment.id;
      paintThread();
    });
    box.append(add);
    return box;
  }

  function pickerNode(comment) {
    const box = document.createElement('div');
    box.className = 'yomu-react__picker';
    const S = window.YomuStickers;
    const mine = owned();

    if (!S || !mine.length) {
      const hint = document.createElement('p');
      hint.className = 'yomu-react__hint';
      hint.textContent = 'Stickers come from reading. Finish five chapters and your first one will be here.';
      box.append(hint);
      return box;
    }

    for (const id of mine) {
      const info = S.info(id);
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'yomu-react__pick';
      pick.title = info?.title || id;
      pick.setAttribute('aria-label', 'React with ' + (info?.title || id) + (comment.myReaction === id ? ', yours now' : ''));
      pick.setAttribute('aria-pressed', String(comment.myReaction === id));
      pick.append(S.el(id, { size: 32 }));
      pick.addEventListener('click', (event) => {
        event.stopPropagation();
        reactWith(comment, comment.myReaction === id ? '' : id);
      });
      box.append(pick);
    }

    if (comment.myReaction) {
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'yomu-react';
      off.textContent = 'Take mine off';
      off.addEventListener('click', (event) => { event.stopPropagation(); reactWith(comment, ''); });
      box.append(off);
    }
    return box;
  }

  function buildThread(context) {
    const section = document.createElement('section');
    section.id = THREAD_ID;
    section.className = 'yomu-thread';
    // The reader treats taps as page gestures; this is a place to read and
    // type, so its taps stop here.
    section.addEventListener('click', (event) => event.stopPropagation());

    const top = document.createElement('div');
    top.className = 'yomu-thread__top';
    const kicker = document.createElement('span');
    kicker.textContent = 'End of chapter';
    const title = document.createElement('strong');
    title.textContent = (document.querySelector('.rd-head__copy h1')?.textContent || '')
      + (context.label ? ' · ' + context.label.replace(/^chapter\s*/i, '') : '');
    top.append(kicker, title);
    section.append(top);

    const head = document.createElement('div');
    head.className = 'yomu-thread__head';
    const label = document.createElement('h3');
    label.textContent = 'Your circle';
    head.append(label);
    section.append(head);

    if (thread?.error) {
      const problem = document.createElement('p');
      problem.className = 'yomu-thread__quiet';
      problem.textContent = thread.error;
      section.append(problem);
      return section;
    }
    if (!thread) {
      const wait = document.createElement('p');
      wait.className = 'yomu-thread__quiet';
      wait.textContent = 'Looking…';
      section.append(wait);
      return section;
    }

    const here = (thread.comments || []).filter((c) => c.chapter === context.chapter);
    if (!here.length) {
      const empty = document.createElement('p');
      empty.className = 'yomu-thread__quiet';
      empty.textContent = 'Nothing on this chapter yet. Say the first thing.';
      section.append(empty);
    } else {
      for (const comment of here) section.append(commentNode(comment));
    }

    // The locked row is the whole idea: you can see a conversation is waiting
    // without any of it spoiling anything.
    if (thread.lockedTotal) {
      const chapters = Object.keys(thread.locked)
        .map(Number).sort((a, b) => a - b);
      const locked = document.createElement('div');
      locked.className = 'yomu-thread__locked';
      const dots = document.createElement('span');
      dots.textContent = '●●●';
      const says = document.createElement('span');
      const count = thread.lockedTotal;
      says.textContent = `${count} comment${count === 1 ? '' : 's'} on chapter `
        + (chapters.length === 1 ? chapters[0] : `${chapters[0]}–${chapters[chapters.length - 1]}`)
        + ' — hidden until you get there';
      locked.append(dots, says);
      section.append(locked);
    }

    const field = document.createElement('textarea');
    field.className = 'yomu-thread__field';
    field.rows = 2;
    field.placeholder = 'Say something about chapter ' + context.chapter;
    field.setAttribute('aria-label', 'Add a comment');

    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'yomu-thread__send';
    send.textContent = 'Post';
    send.addEventListener('click', async () => {
      const text = field.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        thread = await api('post', { ...context, text });
        field.value = '';
      } catch (error) { note(error.message); }
      send.disabled = false;
      paintThread();
    });

    section.append(field, send);
    return section;
  }

  function paintThread() {
    const context = readerContext();
    const scroller = document.querySelector('[data-testid="reader-scroll"]');
    const existing = document.getElementById(THREAD_ID);

    // No chapter number means the header has not resolved yet; a thread keyed
    // on chapter zero would ask the server the wrong question.
    if (!context || !context.chapter || !scroller) { existing?.remove(); return; }

    const built = buildThread(context);
    // Rebuilt rather than diffed: it is small, it is off screen almost always,
    // and the alternative is reconciling a list by hand for no gain. The
    // exception is a field someone is typing in.
    const typing = existing?.querySelector('.yomu-thread__field');
    if (typing && document.activeElement === typing) {
      built.querySelector('.yomu-thread__field').value = typing.value;
    }
    existing?.replaceWith(built);
    if (!built.isConnected) scroller.append(built);
    if (typing && document.activeElement === typing) {
      built.querySelector('.yomu-thread__field').focus();
    }
  }

  function tickReader() {
    const context = readerContext();
    // Not joined, or not asked for: the reader is left completely alone. No
    // thread, no placeholder, no invitation.
    if (!joined() || !commentsInReader()) {
      threadFor = '';
      thread = null;
      document.getElementById(THREAD_ID)?.remove();
      return;
    }
    if (!context || !context.chapter) {
      threadFor = '';
      thread = null;
      document.getElementById(THREAD_ID)?.remove();
      return;
    }
    const key = threadKeyOf(context);
    if (key !== threadFor) {
      threadFor = key;
      thread = null;
      paintThread();
      if (joined()) loadThread(context);
      return;
    }
    if (!document.getElementById(THREAD_ID)) paintThread();
  }

  /* ------------------------------------------------------------------ *
   * The series page: which chapters have a conversation
   *
   * The reader answers "what did they say about this chapter", which you only
   * get to by opening it. This answers the question you actually have while
   * looking at a list of forty chapters: which of these is anyone talking
   * about, and is any of it new.
   *
   * Only ever chapters you have reached. The same gated response feeds this,
   * so a chapter you are not far enough along for contributes nothing here --
   * not a count, not a dot. A marker on chapter 43 is itself a spoiler: it
   * says something happened there.
   * ------------------------------------------------------------------ */

  const SEEN_KEY = 'yomu.v1.circleSeen';
  const BADGE_ID = 'yomu-circle-badge';

  let seriesFor = '';
  let seriesThread = null;
  /** The last series answer, for a listener that mounted after it landed. */
  let lastSeries = null;

  function seriesPageContext() {
    if (!location.pathname.startsWith('/series/')) return null;
    const raw = location.pathname.slice('/series/'.length);
    if (!raw) return null;
    let seriesId = raw;
    try { seriesId = decodeURIComponent(raw); } catch {}
    const sourceId = new URLSearchParams(location.search).get('source') || '';
    return sourceId ? { sourceId, seriesId } : null;
  }

  const seenAt = (key) => Number(readJSON(SEEN_KEY, {})[key]) || 0;
  function markSeen(key, at) {
    const all = readJSON(SEEN_KEY, {}) || {};
    if ((Number(all[key]) || 0) >= at) return;
    all[key] = at;
    writeJSON(SEEN_KEY, all);
    // The card's dot is answered from a cached count; having just opened
    // the thread is exactly the moment that count went stale.
    unreadCache.at = 0;
  }

  /* ------------------------------------------------------------------ *
   * Series cards: the unread dot
   *
   * Circles rewarded you only if you remembered to look. This is the
   * reminder: a dot on a card when its circle has comments you are far
   * enough along to read and have not opened. One request for the whole
   * grid, answered behind the gate on the server, cached for five minutes
   * -- so a library of forty titles costs one round trip per visit, not
   * forty, and a chapter you have not reached contributes nothing, not
   * even a dot.
   * ------------------------------------------------------------------ */

  const UNREAD_TTL = 5 * 60000;
  let unreadCache = { sig: '', at: 0, counts: {} };
  let unreadInFlight = false;

  /** seriesId -> sourceId, from the library and the reading index. Built
   *  once per tick: the grid can hold a hundred tiles and a pass runs on
   *  every mutation. */
  function sourceMap() {
    const map = new Map();
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    for (const row of Array.isArray(collection.library) ? collection.library : []) {
      if (row && row.id && row.sourceId && !map.has(row.id)) map.set(row.id, row.sourceId);
    }
    const index = readJSON(READING_KEY, {}) || {};
    for (const record of Object.values(index)) {
      if (record && record.seriesId && record.sourceId && !map.has(record.seriesId)) {
        map.set(record.seriesId, record.sourceId);
      }
    }
    return map;
  }

  function tickTiles() {
    const tiles = document.querySelectorAll('.tile-card[data-series]');
    if (!joined()) {
      for (const dot of document.querySelectorAll('.yomu-tile__circle')) dot.remove();
      return;
    }
    if (!tiles.length) return;

    const sources = sourceMap();
    const wanted = new Map();
    for (const tile of tiles) {
      const seriesId = tile.getAttribute('data-series');
      const sourceId = sources.get(seriesId);
      if (sourceId) wanted.set(sourceId + ':' + seriesId, { sourceId, seriesId });
    }
    if (!wanted.size) return;

    const sig = [...wanted.keys()].sort().join('|');
    const fresh = unreadCache.sig === sig && Date.now() - unreadCache.at < UNREAD_TTL;
    if (!fresh && !unreadInFlight) {
      unreadInFlight = true;
      const series = [...wanted.values()].slice(0, 60)
        .map((row) => ({ ...row, since: seenAt(row.sourceId + ':' + row.seriesId) }));
      api('unread', { series })
        .then((data) => { unreadCache = { sig, at: Date.now(), counts: data.counts || {} }; })
        // A failed ask keeps the last answer and waits out the TTL rather
        // than asking again on every mutation.
        .catch(() => { unreadCache = { sig, at: Date.now(), counts: unreadCache.counts }; })
        .finally(() => { unreadInFlight = false; paintTiles(sources); });
    }
    paintTiles(sources);
  }

  function paintTiles(sources) {
    const map = sources || sourceMap();
    for (const tile of document.querySelectorAll('.tile-card[data-series]')) {
      const seriesId = tile.getAttribute('data-series');
      const sourceId = map.get(seriesId);
      const count = sourceId ? unreadCache.counts[sourceId + ':' + seriesId] || 0 : 0;
      let dot = tile.querySelector('.yomu-tile__circle');
      if (!count) { dot?.remove(); continue; }
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'yomu-tile__circle';
        (tile.querySelector('.tile-card__cover') ?? tile).append(dot);
      }
      const label = count + ' new circle comment' + (count === 1 ? '' : 's');
      if (dot.title !== label) {
        dot.title = label;
        dot.setAttribute('role', 'img');
        dot.setAttribute('aria-label', label);
      }
    }
  }

  function paintSeries(context) {
    const line = document.querySelector('.section-line');
    if (!line) return;
    const key = context.sourceId + ':' + context.seriesId;
    const comments = seriesThread?.comments || [];

    let badge = document.getElementById(BADGE_ID);
    if (!comments.length) { badge?.remove(); }
    else {
      const since = seenAt(key);
      const fresh = comments.filter((c) => c.at > since).length;
      const text = fresh
        ? `Your circle · ${fresh} new`
        : `Your circle · ${comments.length} comment${comments.length === 1 ? '' : 's'}`;
      if (!badge) {
        badge = document.createElement('span');
        badge.id = BADGE_ID;
        badge.className = 'yomu-circle-badge';
        line.append(badge);
      }
      badge.classList.toggle('is-new', !!fresh);
      if (badge.textContent !== text) badge.textContent = text;
      if (badge.parentElement !== line) line.append(badge);
    }

    // Per-row markers. Counted per chapter number, which is why the rows now
    // carry it rather than having their label parsed back apart.
    const byChapter = new Map();
    for (const comment of comments) {
      byChapter.set(comment.chapter, (byChapter.get(comment.chapter) || 0) + 1);
    }
    for (const row of document.querySelectorAll('.chapter-line[data-chn]')) {
      const count = byChapter.get(Number(row.getAttribute('data-chn')));
      let dot = row.querySelector('.yomu-chapter-talk');
      if (!count) { dot?.remove(); continue; }
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'yomu-chapter-talk';
        row.append(dot);
      }
      const label = '● ' + count;
      if (dot.textContent !== label) dot.textContent = label;
      dot.title = count + (count === 1 ? ' comment' : ' comments') + ' from your circle';
    }
  }

  async function tickSeries() {
    const context = seriesPageContext();
    if (!context) { seriesFor = ''; seriesThread = null; return; }
    if (!joined()) return;

    const key = context.sourceId + ':' + context.seriesId;
    if (key !== seriesFor) {
      seriesFor = key;
      seriesThread = null;
      try {
        // No chapter: asking what is already visible, without claiming to have
        // reached anything. recordProgress ignores a missing or zero chapter,
        // so opening a series page can never move your own high-water mark.
        seriesThread = await api('read', { sourceId: context.sourceId, seriesId: context.seriesId });
        if (seriesThread.circle) takeCircle(seriesThread.circle);
      } catch { seriesThread = { comments: [] }; }
      lastSeries = { key, reached: seriesThread.reached || 0, comments: seriesThread.comments || [], race: seriesThread.race || null };
      dispatchEvent(new CustomEvent('yomu:circle-series', { detail: lastSeries }));
    }
    paintSeries(context);
  }

  if (typeof window !== 'undefined') {
    window.YomuCircle = {
      joined,
      series: () => lastSeries,
      thread: () => (thread && !thread.error ? { key: threadFor, reached: thread.reached, comments: thread.comments || [], race: thread.race || null } : null),
      raceOn: () => raceOn,
    };
  }

  /* --- boot -------------------------------------------------------------- */

  const pass = () => { mountGroup(); tickReader(); tickSeries(); tickTiles(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pass);
  else pass();

  new MutationObserver(pass).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  for (const type of ['popstate', 'hashchange']) addEventListener(type, pass);
})();
