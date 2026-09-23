(() => {
  'use strict';
  if (typeof document === 'undefined') return;

  const CLASS = 'yomu-hero-slide', DOTS = 'yomu-hero-dots', LIMIT = 6;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const key = (s) => String(s || '').trim().toLowerCase();
  const isHome = () => location.pathname === '/' || location.pathname === '/index.html';
  let top = null, loading = false, ratingTimer = 0;
  const queue = [], queued = new Set();

  function score(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? (Math.round(n) / 10).toFixed(1) : null; }
  function chip(text) {
    const n = window.YomuTags?.chip ? window.YomuTags.chip('rating', text, { size: 'sm' }) : el('span', 'yomu-hero__rating', '★ ' + text);
    n.classList.add('yomu-hero__rating'); n.dataset.score = text; n.title = text + ' / 10 on AniList'; n.setAttribute('aria-label', 'Rated ' + text + ' out of 10 on AniList'); return n;
  }
  function pick(items, own, limit) {
    const used = new Set((own || []).map(key)), out = [];
    for (const item of items || []) { if (!item?.title || !item?.cover || used.has(key(item.title))) continue; out.push(item); if (out.length >= limit) break; }
    return out;
  }
  async function loadTop() {
    if (top || loading || !window.YomuRank?.rails) return;
    loading = true;
    try { top = (await window.YomuRank.rails(['top'], 'all', 16))?.top || []; } catch { top = []; }
    loading = false; pass();
  }

  const BOOK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6.5C10.5 5 8.5 4.3 4 4.3V18c4.5 0 6.5.7 8 2.2 1.5-1.5 3.5-2.2 8-2.2V4.3c-4.5 0-6.5.7-8 2.2z"></path><path d="M12 6.5v13.7"></path></svg>';
  function slide(item) {
    const node = el('article', 'hero hero-slide ' + CLASS); node.dataset.title = item.title;
    const art = el('div', 'cover hero__art m-hero-art yomu-hero__art'); art.style.backgroundImage = 'url("' + String(item.cover).replace(/"/g, '%22') + '")';
    node.append(art, el('div', 'hero__shade'));
    const copy = el('div', 'hero__copy'); copy.append(el('span', 'hero__kicker', 'Highest rated'), el('h1', 'hero__title', item.title));
    const facts = [...(item.genres || []).slice(0, 3), item.year].filter(Boolean).join(' · '); if (facts) copy.append(el('p', 'hero__line', facts));
    const acts = el('div', 'hero__acts'), go = el('a', 'm-btn primary yomu-hero__go');
    go.href = '/find.html?q=' + encodeURIComponent(item.title); go.innerHTML = BOOK; go.append(document.createTextNode('Start reading'));
    go.addEventListener('click', () => window.YomuRank?.note?.('RECOMMENDATION_CLICK', item.title)); acts.append(go);
    const text = score(item.score); if (text) acts.append(chip(text)); copy.append(acts); node.append(copy); return node;
  }
  function placeTop(track) {
    if (!top) { loadTop(); return; }
    const own = [...track.querySelectorAll('.hero-slide:not(.' + CLASS + ') .hero__title')].map((n) => n.textContent);
    const wanted = pick(top, own, LIMIT), sig = wanted.map((item) => item.id || item.title).join('|');
    let mine = [...track.querySelectorAll('.' + CLASS)];
    if (track.dataset.yomuHero !== sig) { mine.forEach((n) => n.remove()); mine = wanted.map(slide); if (mine.length) track.append(...mine); track.dataset.yomuHero = sig; }
    else if (mine.length && track.lastElementChild !== mine[mine.length - 1]) track.append(...mine);
  }

  function cached(title) { const hit = window.YomuAniList?.cached?.(title); return hit && 'score' in hit ? score(hit.score) : null; }
  function topScore(title) { return score((top || []).find((item) => key(item.title) === key(title))?.score); }
  function queueRating(title) {
    const k = key(title); if (!k || queued.has(k) || !window.YomuAniList?.similar) return;
    queued.add(k); queue.push(title); if (!ratingTimer) ratingTimer = setTimeout(drain, 900);
  }
  async function drain() {
    ratingTimer = 0;
    if (document.hidden || !queue.length) { if (queue.length) ratingTimer = setTimeout(drain, 1800); return; }
    const title = queue.shift(); try { await window.YomuAniList?.similar?.(title); } catch {}
    paintRatings(); if (queue.length) ratingTimer = setTimeout(drain, 1800);
  }
  function paintRatings() {
    for (const s of document.querySelectorAll('.hero-slide:not(.' + CLASS + ')')) {
      const title = s.querySelector('.hero__title')?.textContent?.trim(), acts = s.querySelector('.hero__acts'); if (!title || !acts) continue;
      const text = cached(title) || topScore(title); let old = acts.querySelector('.yomu-hero__rating');
      if (!text) { queueRating(title); old?.remove(); continue; }
      if (old?.dataset.score === text) continue; old?.remove(); old = chip(text);
      const library = [...acts.children].find((n) => /library/i.test(n.textContent || '')); if (library) library.after(old); else acts.append(old);
    }
  }

  function index(track) { const w = track.clientWidth || 1; return Math.max(0, Math.min(track.children.length - 1, Math.round(track.scrollLeft / w))); }
  function raw(track, left, smooth = true) { track.dataset.yomuProgramScroll = String(Date.now()); (track.__yomuRawScrollTo || track.scrollTo.bind(track))({ left, behavior: smooth ? 'smooth' : 'auto' }); }
  function go(track, i, smooth = true) { if (!track?.children.length) return; const n = track.children.length, next = (i + n) % n; raw(track, next * track.clientWidth, smooth); }

  function dots(track) {
    const parent = track.parentElement, total = track.children.length; let strip = document.getElementById(DOTS);
    if (!parent || total < 2) { strip?.remove(); return; }
    if (!strip) { strip = el('div', 'yomu-hero-dots'); strip.id = DOTS; strip.setAttribute('role', 'tablist'); strip.setAttribute('aria-label', 'Featured title'); }
    if (strip.previousElementSibling !== parent) parent.after(strip);
    while (strip.children.length > total) strip.lastElementChild.remove();
    while (strip.children.length < total) {
      const i = strip.children.length, button = el('button'); button.type = 'button'; button.setAttribute('role', 'tab'); button.append(el('i'));
      button.addEventListener('click', () => { const live = document.querySelector('.hero-track'); if (!live) return; live.dataset.yomuUserScroll = String(Date.now()); go(live, i); }); strip.append(button);
    }
    const current = index(track);
    [...strip.children].forEach((button, i) => { button.setAttribute('aria-label', 'Show ' + (track.children[i]?.querySelector('.hero__title')?.textContent || 'featured title')); button.setAttribute('aria-current', String(i === current)); });
  }

  function wire(track) {
    if (track.dataset.yomuHeroPlus) return; track.dataset.yomuHeroPlus = '1'; track.dataset.yomuHeroWiredAt = String(Date.now());
    const original = track.scrollTo.bind(track); track.__yomuRawScrollTo = original;
    track.scrollTo = (...args) => {
      const opts = args[0], left = opts && typeof opts === 'object' ? Number(opts.left) : Number(args[0]), behavior = opts && typeof opts === 'object' ? opts.behavior : args[2], now = Date.now();
      const user = now - Number(track.dataset.yomuUserScroll || 0) < 1400, program = now - Number(track.dataset.yomuProgramScroll || 0) < 500;
      if (!user && !program && behavior === 'smooth' && Number.isFinite(left) && track.children.length > 1) {
        track.dataset.yomuAutoRemap = String(now); return original({ ...opts, left: ((index(track) + 1) % track.children.length) * track.clientWidth });
      }
      return original(...args);
    };

    let drag = null, frame = 0, settleTimer = 0;
    const user = () => { track.dataset.yomuUserScroll = String(Date.now()); };
    track.addEventListener('pointerdown', (e) => { user(); if (e.pointerType === 'mouse' && e.button === 0) drag = { x: e.clientX, left: track.scrollLeft, moved: false, id: e.pointerId }; });
    track.addEventListener('pointermove', (e) => {
      if (!drag) return; const dx = e.clientX - drag.x;
      if (!drag.moved) { if (Math.abs(dx) < 6) return; drag.moved = true; track.classList.add('is-dragging'); track.style.scrollSnapType = 'none'; try { track.setPointerCapture(drag.id); } catch {} }
      user(); track.scrollLeft = drag.left - dx; e.preventDefault();
    });
    const settle = (e) => {
      user(); if (!drag) return; const d = drag; drag = null; if (!d.moved) return;
      track.classList.remove('is-dragging'); track.style.scrollSnapType = '';
      const dx = e.clientX - d.x; let i = Math.round(d.left / (track.clientWidth || 1)); if (dx < -40) i++; else if (dx > 40) i--; go(track, i); track.dataset.yomuDragged = String(Date.now());
    };
    track.addEventListener('pointerup', settle); track.addEventListener('pointercancel', settle); track.addEventListener('touchstart', user, { passive: true }); track.addEventListener('touchend', user, { passive: true }); track.addEventListener('wheel', user, { passive: true });
    track.addEventListener('click', (e) => { if (Date.now() - Number(track.dataset.yomuDragged || 0) < 400) { e.preventDefault(); e.stopPropagation(); } }, true);
    track.addEventListener('scroll', () => {
      holdArt(track);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; dots(track); });
      clearTimeout(settleTimer); settleTimer = setTimeout(() => {
        const now = Date.now(), wired = Number(track.dataset.yomuHeroWiredAt || now), userAgo = now - Number(track.dataset.yomuUserScroll || 0), programAgo = now - Number(track.dataset.yomuProgramScroll || 0), remapAgo = now - Number(track.dataset.yomuAutoRemap || 0);
        if (now - wired < 1800 || userAgo < 1400 || programAgo < 650 || remapAgo < 2200 || track.children.length < 2) return;
        track.dataset.yomuAutoRemap = String(now); go(track, index(track) + 1);
      }, 180);
    }, { passive: true });
  }

  /* The hero shows one slide at a time, but every slide paints its cover the
   * moment it is built -- six full-size covers competing with the first paint
   * for bandwidth, five of which nobody has asked to see. Hold back everything
   * but the slide on screen and its neighbour, and let the rest in as they are
   * scrolled to, or after three seconds. The timer matters: a browser that
   * never fires a scroll still ends up exactly where it does today, only later.
   */
  const ART_HOLD_MS = 3000;
  let released = false, releaseTimer = 0;

  function artUrl(node) {
    const inline = node.style.backgroundImage || '';
    const open = inline.indexOf('url('), close = inline.lastIndexOf(')');
    if (open < 0 || close <= open) return '';
    let raw = inline.slice(open + 4, close).trim();
    const quote = raw.charAt(0);
    if ((quote === '"' || quote === "'") && raw.charAt(raw.length - 1) === quote) raw = raw.slice(1, -1);
    return raw;
  }
  function showArt(node) {
    const held = node.dataset.yomuArt; if (!held) return;
    delete node.dataset.yomuArt;
    node.style.backgroundImage = 'url("' + held.split('"').join('%22') + '")';
  }
  function releaseArt() {
    released = true;
    for (const art of document.querySelectorAll('.hero__art[data-yomu-art]')) showArt(art);
  }
  /* Runs straight from the MutationObserver, not from a frame callback: the
     browser starts the download at the next style recalculation, so a coalesced
     pass would arrive after the request it is trying to avoid. The observer
     watches childList only, and this writes attributes, so it cannot re-enter. */
  function holdArt(track) {
    if (released || !track?.children.length) return;
    const here = index(track);
    [...track.children].forEach((slide, i) => {
      const art = slide.querySelector && slide.querySelector('.hero__art'); if (!art) return;
      if (Math.abs(i - here) <= 1) { showArt(art); return; }
      if (art.dataset.yomuArt) return;
      const url = artUrl(art); if (!url) return;
      art.dataset.yomuArt = url;
      art.style.backgroundImage = '';
      if (!releaseTimer) releaseTimer = setTimeout(releaseArt, ART_HOLD_MS);
    });
  }

  function pass() {
    if (!isHome()) { document.getElementById(DOTS)?.remove(); return; }
    const track = document.querySelector('.hero-track'); if (!track) return;
    wire(track); placeTop(track); paintRatings(); dots(track); holdArt(track);
  }
  window.YomuHeroPlus = { pickSlides: pick, repaint: pass };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', pass); else pass();
  let frame = 0;
  new MutationObserver((records) => {
    /* Only while something is still being held, and only for batches that
       actually inserted nodes: index() reads layout, and paying for that on
       every mutation of a busy page would cost more than the covers it saves. */
    if (!released) {
      let inserted = false;
      for (const record of records) if (record.addedNodes.length) { inserted = true; break; }
      const track = inserted && isHome() ? document.querySelector('.hero-track') : null;
      if (track) holdArt(track);
    }
    if (frame) return; frame = requestAnimationFrame(() => { frame = 0; pass(); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  for (const type of ['popstate','hashchange','resize','visibilitychange']) addEventListener(type, () => { if (!document.hidden) pass(); });
})();
