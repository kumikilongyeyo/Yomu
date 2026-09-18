/**
 * The chapter reaction heatmap — does this get good?
 *
 * A thin strip above the chapter list showing where the circle reacted
 * most: comments and stickers per chapter, drawn only up to the reader's
 * own high-water mark. It answers "does this get good" without saying how.
 *
 * The data is the same gated answer the Circle client already fetched for
 * the series page -- comments on chapters you have reached, with their
 * reactions -- so nothing here can leak a chapter you have not got to: the
 * server never sent it. Chapters beyond your mark are one dashed tail that
 * says how many there are and nothing else.
 */
(() => {
  'use strict';

  const ROOT_ID = 'yomu-heat';
  const browser = typeof document !== 'undefined';

  /* --- pure ------------------------------------------------------------------ */

  /** chapter -> {comments, stickers, heat}. Stickers count for half. */
  function heatFrom(comments) {
    const out = new Map();
    for (const c of comments || []) {
      const n = Number(c.chapter);
      if (!Number.isFinite(n)) continue;
      const row = out.get(n) || { comments: 0, stickers: 0, heat: 0 };
      row.comments++;
      for (const r of c.reactions || []) row.stickers += Number(r.count) || 0;
      row.heat = row.comments + row.stickers / 2;
      out.set(n, row);
    }
    return out;
  }

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  function seriesKey() {
    if (!location.pathname.startsWith('/series/')) return '';
    let id = location.pathname.slice('/series/'.length);
    try { id = decodeURIComponent(id); } catch {}
    const source = new URLSearchParams(location.search).get('source') || '';
    return source && id ? source + ':' + id : '';
  }

  function paint() {
    const key = seriesKey();
    const list = document.querySelector('.chapter-list');
    const data = key && window.YomuCircle?.series?.();
    const existing = document.getElementById(ROOT_ID);
    if (!list || !data || data.key !== key) { existing?.remove(); return; }

    const heat = heatFrom(data.comments);
    const reached = Number(data.reached) || 0;
    const numbers = [...list.querySelectorAll('.chapter-line[data-chn]')]
      .map((row) => Number(row.getAttribute('data-chn')))
      .filter((n) => Number.isFinite(n));
    const shown = [...new Set(numbers.filter((n) => n <= reached))].sort((a, b) => a - b);
    const beyond = new Set(numbers.filter((n) => n > reached)).size;
    const total = [...heat.values()].reduce((sum, r) => sum + r.heat, 0);
    if (!shown.length || !total) { existing?.remove(); return; }

    const max = Math.max(...shown.map((n) => heat.get(n)?.heat || 0), 1);
    const sig = shown.join(',') + '|' + [...heat].map(([n, r]) => n + ':' + r.heat).join(',') + '|' + beyond;
    if (existing && existing.dataset.sig === sig) { if (!existing.isConnected) list.before(existing); return; }

    const root = el('div', 'yomu-heat');
    root.id = ROOT_ID;
    root.dataset.sig = sig;
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', 'Where your circle reacted, up to chapter ' + reached);

    const head = el('div', 'yomu-heat__head');
    head.append(el('span', null, 'Where your circle reacted'));
    head.append(el('span', 'yomu-heat__upto', 'up to ch. ' + reached));
    root.append(head);

    const strip = el('div', 'yomu-heat__strip');
    for (const n of shown) {
      const row = heat.get(n);
      const seg = el('button', 'yomu-heat__seg');
      seg.type = 'button';
      const level = row ? row.heat / max : 0;
      seg.style.setProperty('--heat', level.toFixed(3));
      seg.classList.toggle('is-hot', level >= 0.66);
      const what = row
        ? `${row.comments} comment${row.comments === 1 ? '' : 's'}` + (row.stickers ? `, ${row.stickers} sticker${row.stickers === 1 ? '' : 's'}` : '')
        : 'quiet';
      seg.title = 'Chapter ' + n + ' · ' + what;
      seg.setAttribute('aria-label', seg.title);
      seg.addEventListener('click', (event) => {
        event.stopPropagation();
        list.querySelector(`.chapter-line[data-chn="${n}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
      strip.append(seg);
    }
    if (beyond) {
      const tail = el('span', 'yomu-heat__beyond');
      tail.title = beyond + ' chapter' + (beyond === 1 ? '' : 's') + ' past your mark';
      tail.textContent = '+' + beyond;
      strip.append(tail);
    }
    root.append(strip);

    if (existing) existing.replaceWith(root);
    else {
      /* Under the ledger's own bar when it is there, so the two strips read
         as one block above the list. */
      const bar = document.getElementById('yomu-ledger-bar');
      if (bar && bar.parentElement) bar.after(root); else list.before(root);
    }
  }

  const api = { heatFrom, repaint: paint };
  if (typeof window !== 'undefined') window.YomuHeat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { heatFrom };

  if (browser) {
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', paint);
    else paint();
    new MutationObserver(paint).observe(document.documentElement, { childList: true, subtree: true });
    addEventListener('yomu:circle-series', paint);
    for (const type of ['popstate', 'hashchange']) addEventListener(type, paint);
  }
})();
