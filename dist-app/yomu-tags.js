/**
 * Tile tags, dressed as glass chips.
 *
 * The chip system is yomu-tags.css (the delivered "Yomu Badges v3", vendored
 * under the ytg prefix). This file is the Yomu half: it knows which tag wears
 * which chip, per docs/tile-tags-spec.md, and puts the icon sprite in the
 * document once, because <use> cannot reach into an external SVG in Safari.
 *
 * Tags the app itself renders (freshness, Hot) are decorated in place: their
 * text node stays, React owns it, and it sits at font-size 0 under the glass
 * while the visible label and icon are children added here. Tags other Yomu
 * files render (progress, circle, rating, rail badge) are built as chips at
 * the source; this file only re-asserts. The completed seal is new here: a
 * chip in the top-left stack where an image used to be painted.
 *
 * Every decoration is signed and re-asserted from the observer, never
 * rebuilt when nothing changed -- React re-renders freely and the page must
 * settle.
 */
(() => {
  'use strict';

  const browser = typeof document !== 'undefined';
  const SPRITE_ID = 'yomu-tags-sprite';
  const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"><defs>
<symbol id="ytg-i-spark" viewBox="0 0 24 24"><path d="M12 1.6Q13.3 10.7 22.4 12 13.3 13.3 12 22.4 10.7 13.3 1.6 12 10.7 10.7 12 1.6Z"/></symbol>
<symbol id="ytg-i-bolt" viewBox="0 0 24 24"><path d="M13.4 1.6 4.2 13.3h5.6L10.1 22.4 19.8 10.4h-5.9l-.5-8.8Z"/></symbol>
<symbol id="ytg-i-check" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm5.2 6.9-6.6 6.6a1.1 1.1 0 0 1-1.5 0L6 12.4a1.1 1.1 0 0 1 1.5-1.5l2.4 2.4 5.8-5.9a1.1 1.1 0 0 1 1.5 1.5Z"/></symbol>
<symbol id="ytg-i-book" viewBox="0 0 24 24"><path d="M3 5.4C3 4.6 3.6 4 4.4 4H10c1.1 0 2 .9 2 2v13.4c0-1.1-.9-2-2-2H4.4c-.8 0-1.4-.6-1.4-1.4V5.4Zm18 0v10.6c0 .8-.6 1.4-1.4 1.4H14c-1.1 0-2 .9-2 2V6c0-1.1.9-2 2-2h5.6c.8 0 1.4.6 1.4 1.4Z"/></symbol>
<symbol id="ytg-i-users" viewBox="0 0 24 24"><path d="M8.6 11.6a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Zm7.6.2a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2ZM1.5 19c0-3.3 3.2-5.6 7.1-5.6s7.1 2.3 7.1 5.6v1H1.5v-1Zm15.3-5.4c3 .2 5.2 2.2 5.2 4.8V20h-4.3v-1c0-1.7-.6-3.2-1.6-4.4.2-.4.5-.8.7-1Z"/></symbol>
<symbol id="ytg-i-fire" viewBox="0 0 24 24"><path d="M12.8 1.6c.5 3-1.2 4.7-2.8 6.2-1.9 1.8-3.6 3.5-3.6 6.3a5.7 5.7 0 0 0 11.4 0c0-2.2-1-3.7-2.1-5.1-.3 1-.9 1.7-1.7 2 .5-3.1-1.2-6.6-1.2-9.4Zm-.6 9.8c1 1.3 2 2.1 2 3.5a2.2 2.2 0 0 1-4.4 0c0-1.4 1-2.2 2.4-3.5Z"/></symbol>
<symbol id="ytg-i-star" viewBox="0 0 24 24"><path d="m12 2.4 3 6 6.6 1-4.8 4.6 1.1 6.6L12 17.5l-5.9 3.1 1.1-6.6L2.4 9.4l6.6-1 3-6Z"/></symbol>
<symbol id="ytg-i-mark" viewBox="0 0 24 24"><path d="M6.5 2.5h11c.8 0 1.5.7 1.5 1.5v17c0 .8-.9 1.3-1.6.8L12 18.1l-5.4 3.7c-.7.5-1.6 0-1.6-.8V4c0-.8.7-1.5 1.5-1.5Z"/></symbol>
<symbol id="ytg-i-out" viewBox="0 0 24 24"><path d="M14 3h7v7h-2.3V6.9l-7.8 7.8-1.6-1.6L17.1 5.3H14V3ZM5 5h5v2.3H5.3v11.4h11.4V14H19v5c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7c0-1.1.9-2 2-2Z"/></symbol>
<symbol id="ytg-i-chev" viewBox="0 0 24 24"><path d="M9.2 5.3 15.9 12l-6.7 6.7-1.8-1.8L12.3 12 7.4 7.1l1.8-1.8Z"/></symbol>
</defs></svg>`;

  /** Which chip a tag wears: palette, icon, shape. Look lives in the CSS. */
  const WEAR = {
    fresh:     { palette: 'aurora', icon: 'spark', tail: false },
    updated:   { palette: 'ocean',  icon: 'bolt',  tail: false },
    completed: { palette: 'matcha', icon: 'check', leaf: true },
    progress:  { palette: 'ink',    icon: 'book',  leaf: true },
    circle:    { palette: 'ocean',  icon: 'users' },
    rating:    { palette: 'ember',  icon: 'star' },
    hot:       { palette: 'ember',  icon: 'fire' },
    trending:  { palette: 'sunset', icon: 'fire' },
    gem:       { palette: 'matcha', icon: 'spark' },
    new:       { palette: 'aurora', icon: 'bolt' },
  };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ytg-i');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#ytg-i-' + name);
    svg.append(use);
    return svg;
  }

  /**
   * A chip. `kind` picks the wear; `text` is the label; opts.size is 'sm'
   * (default) or 'xs'; opts.el lets a caller dress an existing element.
   */
  function chip(kind, text, opts) {
    const o = opts || {};
    const wear = WEAR[kind] || WEAR.fresh;
    const node = o.el || document.createElement('span');
    node.classList.add('ytg', 'ytg--' + (o.size || 'sm'), 'ytg--flat');
    if (wear.leaf) node.classList.add('ytg--leaf');
    if (wear.tail && !o.noTail) node.classList.add('ytg--tail');
    node.setAttribute('data-ytg', wear.palette);
    node.dataset.ytgKind = kind;
    if (!node.querySelector(':scope > .ytg-i')) node.append(icon(wear.icon));
    let label = node.querySelector(':scope > .ytg-label');
    if (!label) { label = document.createElement('span'); label.className = 'ytg-label'; node.append(label); }
    if (label.textContent !== text) label.textContent = text;
    /* A short form the stylesheet swaps in where the chip has no room. */
    let brief = node.querySelector(':scope > .ytg-short');
    if (o.short) {
      if (!brief) { brief = document.createElement('span'); brief.className = 'ytg-short'; node.append(brief); }
      if (brief.textContent !== o.short) brief.textContent = o.short;
    } else brief?.remove();
    return node;
  }

  function sprite() {
    if (document.getElementById(SPRITE_ID)) return;
    const box = document.createElement('div');
    box.innerHTML = SPRITE;
    const svg = box.firstElementChild;
    if (!svg) return;
    svg.id = SPRITE_ID;
    svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    svg.style.width = '0';
    svg.style.height = '0';
    document.body.prepend(svg);
  }

  /* --- the React-owned tags ------------------------------------------------ */

  function dressFreshness() {
    for (const el of document.querySelectorAll('.freshness')) {
      const updated = el.classList.contains('freshness--updated');
      const kind = updated ? 'updated' : 'fresh';
      if (el.dataset.ytgKind === kind && el.querySelector(':scope > .ytg-i')) continue;
      chip(kind, updated ? 'Updated' : 'New chapter', { el, size: 'sm', short: updated ? 'Updated' : 'New' });
    }
  }

  function dressHot() {
    for (const el of document.querySelectorAll('.tile-card__hot')) {
      if (el.dataset.ytgKind === 'hot' && el.querySelector(':scope > .ytg-i')) continue;
      chip('hot', 'Hot', { el, size: 'xs' });
    }
  }

  /* --- the completed seal -------------------------------------------------- */

  function dressCompleted() {
    for (const tile of document.querySelectorAll('.tile-card')) {
      const cover = tile.querySelector('.tile-card__cover');
      const done = tile.getAttribute('data-yomu-tag') === 'completed';
      let mark = cover?.querySelector(':scope > .yomu-tile__done');
      if (!done || !cover) { mark?.remove(); continue; }
      if (mark) continue;
      mark = chip('completed', 'Completed', { size: 'sm' });
      mark.classList.add('yomu-tile__done');
      mark.setAttribute('role', 'img');
      mark.setAttribute('aria-label', 'Completed');
      cover.append(mark);
    }
  }

  /* --- tags other Yomu files render --------------------------------------- */

  function dressProgress() {
    for (const el of document.querySelectorAll('.yomu-tile__progress')) {
      /* The shell writes textContent when the chapter changes, which wipes
         the children; the label it wrote is the text to re-dress with. */
      const own = el.querySelector(':scope > .ytg-label');
      const text = own ? own.textContent : el.textContent.trim();
      if (own && el.dataset.ytgKind === 'progress' && el.querySelector(':scope > .ytg-i')) continue;
      if (!own) el.textContent = '';
      chip('progress', text, { el, size: 'sm' });
    }
  }

  function dressCircle() {
    for (const el of document.querySelectorAll('.yomu-tile__circle')) {
      const count = el.dataset.count || '';
      const label = count ? count : '';
      if (el.dataset.ytgKind === 'circle' && el.querySelector(':scope > .ytg-label')?.textContent === label) continue;
      chip('circle', label, { el, size: 'xs' });
    }
  }

  function dressRails() {
    for (const el of document.querySelectorAll('.yr-badge:not(.ytg)')) {
      const word = el.textContent.trim();
      const kind = /trend/i.test(word) ? 'trending' : /gem/i.test(word) ? 'gem' : 'new';
      el.textContent = '';
      chip(kind, word, { el, size: 'xs' });
    }
  }

  /* A rating painted before this file ran is a plain "★ 8.7" pill; it is
     re-dressed here so load order does not decide the look. */
  function dressRatings() {
    for (const el of document.querySelectorAll('.yomu-tile__rating:not(.ytg), .yr-card__rating:not(.ytg), .yomu-series-rating:not(.ytg)')) {
      const text = el.textContent.replace(/★/g, '').trim();
      if (!text) continue;
      el.textContent = '';
      chip('rating', text, { el, size: el.classList.contains('yomu-series-rating') ? 'sm' : 'xs' });
    }
  }

  const pass = () => { sprite(); dressFreshness(); dressHot(); dressCompleted(); dressProgress(); dressCircle(); dressRails(); dressRatings(); };

  const api = { chip, WEAR, repaint: pass };
  if (typeof window !== 'undefined') window.YomuTags = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { WEAR };

  if (browser) {
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', pass);
    else pass();
    new MutationObserver(pass).observe(document.documentElement, { childList: true, subtree: true });
    for (const type of ['popstate', 'hashchange']) addEventListener(type, pass);
  }
})();
