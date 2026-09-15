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

  async function api(route, payload) {
    const response = await fetch('/api/circle/' + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: state().code, memberId: state().memberId, ...payload }),
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
      isOwner ? 'Close this circle' : 'Leave this circle',
      isOwner
        ? 'Ends it for everyone, and deletes every comment in it.'
        : 'Your comments stay, with your name on them.',
      isOwner ? closeCircle : leaveCircle,
    ));
  }

  function adopt(circle, name) {
    setState({ code: circle.code, memberId: circle.memberId, name });
    members = circle.members || [];
    isOwner = !!circle.youAreOwner;
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
      members = circle.members || [];
      isOwner = !!circle.youAreOwner;
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
      if (thread.circle) {
        isOwner = !!thread.circle.youAreOwner;
        members = thread.circle.members || members;
      }
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
    const when = document.createElement('span');
    when.textContent = ago(comment.at) + (comment.present ? '' : ' · left the circle');
    head.append(who, when);

    const text = document.createElement('p');
    text.textContent = comment.text;

    const tools = document.createElement('div');
    tools.className = 'yomu-cmt__tools';

    const like = document.createElement('button');
    like.type = 'button';
    like.className = 'yomu-cmt__like' + (comment.likedByMe ? ' is-on' : '');
    like.textContent = '♥' + (comment.likes ? ' ' + comment.likes : '');
    // Who, not how many: at this size that is the more useful fact, and the
    // server sends the names precisely so it can be shown.
    if (comment.likedBy?.length) like.title = comment.likedBy.join(', ');
    like.addEventListener('click', async (event) => {
      event.stopPropagation();
      const context = readerContext();
      if (!context) return;
      try {
        await api('like', { ...context, commentId: comment.id });
        loadThread(context);
      } catch (error) { note(error.message); }
    });
    tools.append(like);

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
    item.append(face, body);
    return item;
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
        if (seriesThread.circle) isOwner = !!seriesThread.circle.youAreOwner;
      } catch { seriesThread = { comments: [] }; }
    }
    paintSeries(context);
  }

  /* --- boot -------------------------------------------------------------- */

  const pass = () => { mountGroup(); tickReader(); tickSeries(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pass);
  else pass();

  new MutationObserver(pass).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  for (const type of ['popstate', 'hashchange']) addEventListener(type, pass);
})();
