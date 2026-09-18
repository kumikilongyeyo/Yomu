/**
 * Character cards — "who is this again?"
 *
 * Two hundred chapters into a manhwa, a face turns up that you know you
 * know. This is the sheet for that: the main cast with portraits and
 * one-line roles, from the reader's top bar, cached per title for the
 * session.
 *
 * AniList is asked from the browser, because it blocks the Worker (see
 * yomu-anilist.js). `characters` is one more field on the same kind of
 * query. Descriptions are AniList's own and can spoil, so only the first
 * sentence is shown, spoiler markup (~!...!~) is cut before anything else
 * is read, and a role label is the fallback when nothing safe is left.
 */
(() => {
  'use strict';

  const ENDPOINT = 'https://graphql.anilist.co';
  const BUTTON_ID = 'yomu-cast';
  const SHEET_ID = 'yomu-cast-sheet';
  const CACHE_PREFIX = 'yomu.v1.cast:';

  const browser = typeof document !== 'undefined';

  const QUERY = `
query ($search: String) {
  Media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
    id
    title { english romaji }
    characters(sort: [ROLE, RELEVANCE], perPage: 12) {
      edges {
        role
        node { id name { full native } image { medium } description(asHtml: false) }
      }
    }
  }
}`;

  const ROLE = { MAIN: 'Main', SUPPORTING: 'Supporting', BACKGROUND: 'Background' };
  const roleLabel = (role) => ROLE[String(role || '').toUpperCase()] || 'Cast';

  /**
   * One safe line from a description.
   *
   * Spoiler blocks go first, whole -- a sentence that starts outside one and
   * ends inside it is a sentence that spoils. Then markdown emphasis, then
   * the first sentence, then a cap. AniList descriptions often open with
   * age/height lines ("Age: 17", "Birthday: ..."); those are skipped.
   */
  function trimDescription(raw, max = 96) {
    let text = String(raw || '').replace(/~!.*?!~/gs, '').replace(/~!.*$/s, '');
    text = text.replace(/__|\*\*|\*|_(?=\w)|(?<=\w)_|<br\s*\/?>/gi, ' ');
    /* A line break is a sentence boundary too: the "Age: 17" lines are not
       punctuated, and folding them into the sentence that follows would
       drop that sentence for its first word. */
    const sentences = text.split(/\n+|(?<=[.!?])\s+/).map((s) => s.replace(/\s+/g, ' ').trim());
    /* "Age: 17", "Class: Mage", "Guild: Hunters Guild" -- a short label with
       a colon is a stat line, whatever the label, and the sentence is the
       thing after them. */
    const isLabel = (s) => /^[A-Za-z][A-Za-z /-]{0,24}:\s*\S/.test(s) && s.length < 60;
    const line = sentences.find((s) => s && !isLabel(s)) || '';
    if (!line) return '';
    return line.length > max ? line.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : line;
  }

  function shape(media) {
    const edges = media?.characters?.edges || [];
    return edges
      .map((edge) => {
        const node = edge?.node;
        if (!node?.name?.full) return null;
        return {
          name: node.name.full,
          native: node.name.native || '',
          role: roleLabel(edge.role),
          image: node.image?.medium || '',
          line: trimDescription(node.description),
        };
      })
      .filter(Boolean);
  }

  /* --- fetching -------------------------------------------------------------- */

  const cacheKey = (title) => CACHE_PREFIX + String(title || '').trim().toLowerCase();

  function cached(title) {
    try {
      const raw = sessionStorage.getItem(cacheKey(title));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function remember(title, value) {
    try { sessionStorage.setItem(cacheKey(title), JSON.stringify(value)); } catch {}
  }

  async function castFor(title) {
    const hit = cached(title);
    if (hit) return hit;
    let answer;
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { search: title } }),
      });
      if (response.status === 429) return { error: 'AniList is asking for a minute. Try again shortly.' };
      /* A miss is a 404 with a GraphQL error body, not an empty 200. Read the
         body whatever the status; an unknown title is the common case and
         deserves its own sentence. */
      const body = await response.json().catch(() => null);
      const media = body?.data?.Media;
      if (!media) {
        return response.status === 404 || body?.data
          ? { error: 'AniList does not know this one.' }
          : { error: 'AniList did not answer.' };
      }
      answer = { matched: media.title?.english || media.title?.romaji || title, cast: shape(media) };
    } catch {
      return { error: 'Could not reach AniList from here.' };
    }
    remember(title, answer);
    return answer;
  }

  /* --- the reader ------------------------------------------------------------ */

  const inReader = () => location.pathname.startsWith('/read/');
  const readerTitle = () => document.querySelector('.rd-head__copy h1')?.textContent?.trim() || '';

  function mountButton() {
    const head = inReader() && document.querySelector('.rd-head');
    const existing = document.getElementById(BUTTON_ID);
    if (!head) { existing?.remove(); if (!inReader()) closeSheet(); return; }
    let button = existing;
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.id = BUTTON_ID;
      button.className = 'yomu-imm-toggle yomu-cast-toggle';
      button.setAttribute('aria-label', 'Who is this again? The cast');
      button.title = 'Who is this again?';
      button.setAttribute('aria-haspopup', 'dialog');
      button.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.4 2.6-5 5.5-5s4.9 1.6 5.5 5"/>' +
        '<circle cx="17" cy="9.5" r="2.4"/><path d="M15.2 14.4c2.8-.2 4.6 1.2 5.3 4.1"/></svg>';
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (document.getElementById(SHEET_ID)) closeSheet(); else openSheet();
      });
    }
    /* Ahead of the fullscreen toggle when it is there, so the two window-ish
       controls sit together at the right and the cast reads as the first. */
    const imm = head.querySelector('.yomu-imm-toggle:not(.yomu-cast-toggle)');
    if (imm && button.nextElementSibling !== imm) head.insertBefore(button, imm);
    else if (!imm && button.parentElement !== head) head.append(button);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  async function openSheet() {
    closeSheet();
    const title = readerTitle();
    const root = el('div', 'yomu-cast');
    root.id = SHEET_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', SHEET_ID + '-title');
    root.addEventListener('click', (event) => event.stopPropagation());

    const scrim = el('button', 'yomu-cast__scrim');
    scrim.type = 'button';
    scrim.setAttribute('aria-label', 'Close');
    scrim.addEventListener('click', closeSheet);

    const sheet = el('section', 'yomu-cast__sheet');
    const head = el('div', 'yomu-cast__head');
    const heading = el('h2', null, 'Who is this again?');
    heading.id = SHEET_ID + '-title';
    const sub = el('small', null, title || 'This title');
    const close = el('button', 'yomu-cast__close', 'Done');
    close.type = 'button';
    close.addEventListener('click', closeSheet);
    head.append(heading, sub, close);
    sheet.append(head);

    const body = el('div', 'yomu-cast__body');
    body.append(el('p', 'yomu-cast__quiet', 'Asking AniList…'));
    sheet.append(body);

    const foot = el('p', 'yomu-cast__foot', 'Cast and portraits from AniList. Descriptions are cut to their first line, with spoiler passages removed.');
    sheet.append(foot);

    root.append(scrim, sheet);
    document.body.append(root);
    setTimeout(() => root.classList.add('is-on'), 20);
    close.focus({ preventScroll: true });
    addEventListener('keydown', onKey);

    if (!title) { body.textContent = ''; body.append(el('p', 'yomu-cast__quiet', 'The chapter has not named its series yet.')); return; }
    const answer = await castFor(title);
    if (!document.getElementById(SHEET_ID)) return;
    body.textContent = '';
    if (answer.error) { body.append(el('p', 'yomu-cast__quiet', answer.error)); return; }
    if (!answer.cast.length) { body.append(el('p', 'yomu-cast__quiet', 'AniList lists nobody for this one yet.')); return; }
    if (answer.matched && answer.matched.toLowerCase() !== title.toLowerCase()) {
      sub.textContent = title + ' · matched “' + answer.matched + '”';
    }
    for (const person of answer.cast) body.append(card(person));
  }

  function card(person) {
    const item = el('article', 'yomu-cast__card');
    const face = el('span', 'yomu-cast__face');
    if (person.image) {
      const img = document.createElement('img');
      img.src = person.image;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      face.append(img);
    } else {
      face.textContent = [...person.name][0].toUpperCase();
    }
    const copy = el('div', 'yomu-cast__copy');
    const name = el('b', null, person.name);
    const role = el('span', 'yomu-cast__role', person.role);
    const top = el('div', 'yomu-cast__top');
    top.append(name, role);
    copy.append(top);
    if (person.native) copy.append(el('small', 'yomu-cast__native', person.native));
    if (person.line) copy.append(el('p', null, person.line));
    item.append(face, copy);
    return item;
  }

  function onKey(event) {
    if (event.key === 'Escape') { event.stopPropagation(); closeSheet(); }
  }

  function closeSheet() {
    removeEventListener('keydown', onKey);
    const root = document.getElementById(SHEET_ID);
    if (!root) return;
    root.classList.remove('is-on');
    setTimeout(() => root.remove(), 200);
    document.getElementById(BUTTON_ID)?.focus?.({ preventScroll: true });
  }

  /* --- public shape ------------------------------------------------------ */

  const api = { open: openSheet, close: closeSheet, castFor, trimDescription, roleLabel };
  if (typeof window !== 'undefined') window.YomuCast = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { trimDescription, roleLabel, shape };

  /* --- boot -------------------------------------------------------------- */

  if (browser) {
    const pass = () => mountButton();
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', pass);
    else pass();
    new MutationObserver(pass).observe(document.documentElement, { childList: true, subtree: true });
    addEventListener('yomu:pet-surface', () => { pass(); closeSheet(); });
    for (const type of ['popstate', 'hashchange']) addEventListener(type, pass);
  }
})();
