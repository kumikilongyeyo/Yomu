/**
 * Time capsule notes — why this one?
 *
 * When a reader saves a title, one optional sentence: why this one. It is
 * shown back the day they finish the last chapter, which is months later and
 * exactly when it lands hardest. Zero-cost sentiment.
 *
 * Notes live in `yomu.v1.capsule`, keyed by titleKey, beside the library
 * rather than in it: the app rewrites its collection rows from memory and
 * would drop a field it does not know. yomu-sync.js carries the note on the
 * library entry it belongs to, so it follows the reader across devices.
 *
 * Saving is detected, not hooked: the app has no save event, so the set of
 * saved keys is compared before and after a tap on a save control.
 */
(() => {
  'use strict';

  const KEY = 'yomu.v1.capsule';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const RESUME_PREFIX = 'yomu.v1.resume.local-account.';
  const PROMPT_ID = 'yomu-capsule-prompt';
  const LINE_ID = 'yomu-capsule-line';
  const CARD_ID = 'yomu-capsule-card';
  const MAX = 140;

  const browser = typeof document !== 'undefined';

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  const titleKey = (sourceId, id) => sourceId + ':' + id;
  const notes = () => {
    const value = readJSON(KEY, null);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  };
  const library = () => {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    return Array.isArray(collection.library) ? collection.library.filter((r) => r && r.id && r.sourceId) : [];
  };
  const keysOf = (rows) => new Set(rows.map((r) => titleKey(r.sourceId, r.id)));

  /* --- pure helpers ---------------------------------------------------------- */

  /** Keys in `after` that were not in `before`. */
  function newlySaved(before, after) {
    return [...after].filter((k) => !before.has(k));
  }

  /** "three months ago", "last year", "today". */
  function ago(from, now) {
    const days = Math.floor((now - from) / 86400000);
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 31) return days + ' days ago';
    const months = Math.round(days / 30.4);
    if (months < 12) return months === 1 ? 'a month ago' : months + ' months ago';
    const years = Math.round(days / 365);
    return years === 1 ? 'a year ago' : years + ' years ago';
  }

  /** Notes for finished titles that have not been shown back yet. */
  function due(all, finishedKeys) {
    return finishedKeys.filter((k) => all[k] && all[k].note && !all[k].shownAt);
  }

  function setNote(key, text) {
    const all = notes();
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX);
    all[key] = { ...(all[key] || {}), note: clean, at: Date.now() };
    writeJSON(KEY, all);
    dispatchEvent(new CustomEvent('yomu:capsule'));
  }

  function skip(key) {
    const all = notes();
    all[key] = { ...(all[key] || {}), skipped: true, at: Date.now() };
    writeJSON(KEY, all);
  }

  /* --- the prompt ------------------------------------------------------------ */

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function prompt(key, title, existing) {
    document.getElementById(PROMPT_ID)?.remove();
    const root = el('div', 'ycap');
    root.id = PROMPT_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Why this one?');
    root.addEventListener('click', (event) => event.stopPropagation());

    const head = el('div', 'ycap__head');
    head.append(el('span', 'ycap__kicker', existing ? 'Your note' : 'Saved'));
    head.append(el('strong', null, title || 'This title'));
    root.append(head);
    root.append(el('p', 'ycap__ask', existing ? 'Change why you saved it.' : 'Why this one? One sentence, for the day you finish it.'));

    const field = el('input', 'ycap__field');
    field.type = 'text';
    field.maxLength = MAX;
    field.placeholder = 'Because…';
    field.value = existing || '';
    field.setAttribute('aria-label', 'Why this one');
    root.append(field);

    const acts = el('div', 'ycap__acts');
    const keep = el('button', 'ycap__keep', 'Keep');
    keep.type = 'button';
    const later = el('button', 'ycap__skip', existing ? 'Cancel' : 'Skip');
    later.type = 'button';
    acts.append(later, keep);
    root.append(acts);

    const close = () => { root.classList.remove('is-on'); setTimeout(() => root.remove(), 200); };
    keep.addEventListener('click', () => {
      if (field.value.trim()) setNote(key, field.value); else if (existing) setNote(key, '');
      else skip(key);
      close();
      paintSeriesLine();
    });
    later.addEventListener('click', () => { if (!existing) skip(key); close(); });
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') keep.click();
      if (event.key === 'Escape') later.click();
    });

    document.body.append(root);
    setTimeout(() => root.classList.add('is-on'), 20);
    field.focus({ preventScroll: true });
  }

  /* --- save detection -------------------------------------------------------- */

  let known = keysOf(library());

  function afterSave() {
    /* The app writes its collection back in the same task as the tap or the
       one after; two looks cover both. */
    const look = () => {
      const rows = library();
      const now = keysOf(rows);
      const fresh = newlySaved(known, now);
      known = now;
      if (!fresh.length) return;
      const all = notes();
      const key = fresh[fresh.length - 1];
      if (all[key] && (all[key].note || all[key].skipped)) return;
      const row = rows.find((r) => titleKey(r.sourceId, r.id) === key);
      prompt(key, row?.title || '');
    };
    setTimeout(look, 120);
    setTimeout(look, 900);
  }

  const SAVE_SELECTOR = '.tile-card__save, [aria-label="Save to library"], button';
  function onTap(event) {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest(SAVE_SELECTOR);
    if (!button) return;
    const text = (button.getAttribute('aria-label') || button.textContent || '').trim();
    if (!/^(save|library|save to library|add to library)$/i.test(text) && !button.matches('.tile-card__save')) return;
    afterSave();
  }

  /* --- the series page line -------------------------------------------------- */

  function seriesContext() {
    if (!location.pathname.startsWith('/series/')) return null;
    let seriesId = location.pathname.slice('/series/'.length);
    try { seriesId = decodeURIComponent(seriesId); } catch {}
    const sourceId = new URLSearchParams(location.search).get('source') || '';
    return sourceId && seriesId ? { sourceId, seriesId } : null;
  }

  function paintSeriesLine() {
    const context = seriesContext();
    const existing = document.getElementById(LINE_ID);
    if (!context) { existing?.remove(); return; }
    const anchor = document.querySelector('.section-line');
    if (!anchor) return;
    const key = titleKey(context.sourceId, context.seriesId);
    const saved = library().some((r) => titleKey(r.sourceId, r.id) === key);
    const note = notes()[key];
    if (!saved && !note?.note) { existing?.remove(); return; }

    let line = existing;
    if (!line) {
      line = el('p', 'yomu-capsule');
      line.id = LINE_ID;
    }
    const text = note?.note ? 'Saved because: “' + note.note + '”' : 'Why this one? Add a note for the day you finish it.';
    if (line.dataset.text !== text) {
      line.textContent = '';
      line.dataset.text = text;
      line.append(el('span', null, text));
      const edit = el('button', 'yomu-capsule__edit', note?.note ? 'Edit' : 'Add');
      edit.type = 'button';
      edit.addEventListener('click', (event) => {
        event.stopPropagation();
        const row = library().find((r) => titleKey(r.sourceId, r.id) === key);
        prompt(key, row?.title || document.querySelector('h1')?.textContent || '', note?.note || '');
      });
      line.append(edit);
    }
    /* Settles once after the app's own line; re-asserted only if React
       dropped it. */
    if (!line.isConnected) anchor.after(line);
  }

  /* --- the day you finish ----------------------------------------------------- */

  function finishedKeys() {
    const out = [];
    for (const row of library()) {
      const total = Number(row.total);
      if (!Number.isFinite(total) || total <= 0) continue;
      const list = readJSON(RESUME_PREFIX + row.id + '.read', []);
      if (Array.isArray(list) && list.length >= total) out.push(titleKey(row.sourceId, row.id));
    }
    return out;
  }

  let pending = null;

  function checkFinished() {
    const all = notes();
    const ready = due(all, finishedKeys());
    if (!ready.length) return;
    pending = ready[0];
    maybeShow();
  }

  function maybeShow(force) {
    if (!pending || (document.hidden && !force)) return;
    if (window.YomuPet?.surface?.() === 'reader') return;
    const key = pending;
    pending = null;
    const all = notes();
    const entry = all[key];
    if (!entry || !entry.note) return;
    all[key] = { ...entry, shownAt: Date.now() };
    writeJSON(KEY, all);
    const row = library().find((r) => titleKey(r.sourceId, r.id) === key);
    showCard(row?.title || 'that title', entry);
  }

  function showCard(title, entry) {
    document.getElementById(CARD_ID)?.remove();
    const root = el('div', 'ycap ycap--back');
    root.id = CARD_ID;
    root.setAttribute('role', 'status');
    const head = el('div', 'ycap__head');
    head.append(el('span', 'ycap__kicker', 'You finished ' + title));
    head.append(el('strong', null, 'You saved it ' + ago(entry.at || Date.now(), Date.now()) + ' because:'));
    root.append(head);
    root.append(el('p', 'ycap__quote', '“' + entry.note + '”'));
    const ok = el('button', 'ycap__keep', 'Keep it');
    ok.type = 'button';
    const acts = el('div', 'ycap__acts');
    acts.append(ok);
    root.append(acts);
    const close = () => { root.classList.remove('is-on'); setTimeout(() => root.remove(), 200); };
    ok.addEventListener('click', close);
    document.body.append(root);
    setTimeout(() => root.classList.add('is-on'), 20);
    setTimeout(close, 12000);
  }

  /* --- public shape ------------------------------------------------------ */

  const api = {
    newlySaved, ago, due, setNote, notes, prompt, checkFinished, MAX,
    /* Debug seam: show a due note now, hidden tab or not. */
    __show: () => maybeShow(true),
  };
  if (typeof window !== 'undefined') window.YomuCapsule = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { newlySaved, ago, due, MAX };

  if (browser) {
    document.addEventListener('click', onTap, true);
    const pass = () => paintSeriesLine();
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', pass);
    else pass();
    new MutationObserver(pass).observe(document.documentElement, { childList: true, subtree: true });
    addEventListener('yomu:capsule', pass);
    addEventListener('yomu:progress', checkFinished);
    addEventListener('yomu:pet-surface', maybeShow);
    addEventListener('visibilitychange', () => { if (!document.hidden) maybeShow(); });
  }
})();
