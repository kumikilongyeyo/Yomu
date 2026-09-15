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

  function mountGroup() {
    if (!location.pathname.startsWith('/settings')) return;
    const labels = [...document.querySelectorAll('.group-label')];
    // After Devices, which is where the other code lives. Same neighbourhood,
    // separate group, so the difference between them is visible.
    const anchor = document.getElementById('yomu-devices')
      ?? labels.find((l) => /storage/i.test(l.textContent || ''));
    if (!anchor) return;

    let label = document.getElementById(GROUP_ID + '-label');
    let group = document.getElementById(GROUP_ID);
    if (!label || !group) {
      label = document.createElement('div');
      label.className = 'group-label';
      label.id = GROUP_ID + '-label';
      label.textContent = 'Circle';
      group = document.createElement('section');
      group.className = 'settings-group glass';
      group.id = GROUP_ID;
    }
    // Same rule as the Devices group, and for the same reason: placed once,
    // then only the label-to-group pairing is re-asserted. Testing position
    // against the neighbour makes two observer-driven groups chase each other
    // around the screen forever.
    if (!group.isConnected || label.nextElementSibling !== group) {
      anchor.after(label, group);
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

    if (!joined()) {
      const invite = document.createElement('p');
      invite.className = 'yomu-thread__quiet';
      invite.textContent = 'Reading with friends? A circle puts their comments here, and only ever the ones for chapters you have reached.';
      const go = document.createElement('a');
      go.className = 'yomu-thread__go';
      go.href = '/settings';
      go.textContent = 'Set up a circle';
      section.append(invite, go);
      return section;
    }

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

  /* --- boot -------------------------------------------------------------- */

  const pass = () => { mountGroup(); tickReader(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pass);
  else pass();

  new MutationObserver(pass).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  for (const type of ['popstate', 'hashchange']) addEventListener(type, pass);
})();
