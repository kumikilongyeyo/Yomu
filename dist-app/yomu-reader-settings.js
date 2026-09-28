/**
 * The reader's settings, its paged view, and its keyboard.
 *
 * The Expo reader draws one continuous strip and lets the mode switch between
 * that strip and the same strip with scroll-snap. This file is the other half
 * of the reliability pass's bundle edits (tools/patch-bundle.mjs, "reader
 * reliability"), and every hook into it is optional-chained there, so without
 * it the reader is exactly the old one:
 *
 *   windowRange  which pages keep an <img> mounted. Sized in decoded bytes,
 *                not a page count: three 720x10000 strips either side is
 *                350MB, which is how iPhone Safari ends up reloading the tab.
 *                And in how fast pages are arriving here, measured from the
 *                page loads themselves -- iPhone Safari has no
 *                navigator.connection, so the old connection check was always
 *                "assume a fast line" exactly where it mattered.
 *
 *   Paged        a real page-by-page view for manga: one page fitted to the
 *                screen, or two as a spread on a wide screen (the first page
 *                alone, a page that is already a double spread alone),
 *                left-to-right or right-to-left, tap zones, swipe, keys, the
 *                next pages decoded before you turn to them, and an end panel
 *                that takes you into the next chapter.
 *
 *   settings     continuous chapters, reading direction, spread offset, page
 *                gap, page width and image quality, drawn into the reader's
 *                own Reading settings sheet in its own controls.
 *
 *   keys         desktop shortcuts: arrows and Space turn pages, [ and ] move
 *                between chapters, M changes mode, C and S open the sheets, F
 *                is fullscreen, ? lists them.
 *
 *   suggestion   a page-shaped Japanese manga opened in Scroll gets one quiet
 *                offer of Page mode; a tall strip opened in Page gets one offer
 *                of Scroll. Once per title, never automatic: the reader decides.
 *
 * Loaded on demand with the other reading helpers (yomu-fabric-route.js). If
 * it lands after the reader's first render it nudges one more render.
 */
(() => {
  'use strict';

  const browser = typeof document !== 'undefined';
  const KEY = 'yomu.v2.reader.settings';
  const HINT_KEY = 'yomu.v2.reader.modeHint';
  const PAGED_TIP_KEY = 'yomu.v2.reader.pagedTip';

  const DEFAULTS = Object.freeze({
    width: 900,
    gap: 0,
    rtl: false,
    quality: 'original',
    /* On by default in Scroll: reaching the foot of a chapter is reaching the
       top of the next one, the way long-strip readers work. One switch away. */
    continuous: true,
    /* Spread pairs start after the first page (a cover, or a chapter title
       page), the way the printed book does. Off shifts every pair by one. */
    cover: true,
  });

  const WIDTH = { min: 480, max: 1600, step: 20 };
  const GAP = { min: 0, max: 32, step: 2 };

  /* --- preferences ------------------------------------------------------- */

  const clampNumber = (value, { min, max }, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  /** Stored preferences, cleaned: a hand-edited or older value cannot break the layout. */
  function readPrefs(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    return {
      width: clampNumber(input.width, WIDTH, DEFAULTS.width),
      gap: clampNumber(input.gap, GAP, DEFAULTS.gap),
      rtl: input.rtl === true,
      quality: input.quality === 'saver' ? 'saver' : 'original',
      continuous: typeof input.continuous === 'boolean' ? input.continuous : DEFAULTS.continuous,
      cover: typeof input.cover === 'boolean' ? input.cover : DEFAULTS.cover,
    };
  }

  let prefs = readPrefs(null);
  if (browser) {
    try { prefs = readPrefs(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch {}
  }

  const listeners = new Set();
  function save(values) {
    prefs = readPrefs({ ...prefs, ...values });
    api.prefs = prefs;
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
    listeners.forEach((fn) => { try { fn(); } catch {} });
    /* The strip relayouts on resize (see "reader: adjustable width"); the
       look-ahead listens for this one. */
    try { dispatchEvent(new Event('resize')); } catch {}
    try { dispatchEvent(new Event('yomu:reader-settings')); } catch {}
  }

  /** The smaller copy when Data saver is on and the adapter has one. */
  function uri(adapter, page) {
    const variant = prefs.quality === 'saver' && page?.dataSaverUrl;
    return variant || adapter.resolveImageUri(page);
  }

  /* --- how fast pages are arriving here ----------------------------------- *
   *
   * An exponentially weighted average of how long chapter images take, from
   * Resource Timing. Only this origin's /api/ images: those are the chapter
   * pages, and a cover from elsewhere says nothing about the page proxy.
   */

  const pace = { ms: 0, samples: 0 };

  function notePace(ms) {
    if (!(ms > 0) || ms > 120000) return;
    pace.ms = pace.samples ? pace.ms * 0.75 + ms * 0.25 : ms;
    pace.samples++;
  }

  /** 'fast' | 'normal' | 'slow' | 'unknown', from the average. */
  function paceOf(ms, samples) {
    if (!(samples >= 3)) return 'unknown';
    if (ms <= 700) return 'fast';
    if (ms <= 2200) return 'normal';
    return 'slow';
  }

  if (browser && typeof PerformanceObserver === 'function') {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.initiatorType !== 'img') continue;
          let url;
          try { url = new URL(entry.name); } catch { continue; }
          if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) continue;
          notePace(entry.duration);
        }
      }).observe({ type: 'resource', buffered: false });
    } catch {}
  }

  /* --- the mounted window --------------------------------------------------- */

  const MB = 1024 * 1024;
  /** A page whose size nobody has told us: a typical 800x1200 page. */
  const UNKNOWN_PAGE_BYTES = 800 * 1200 * 4;

  const coarsePointer = () => {
    try { return browser && matchMedia('(pointer: coarse)').matches; } catch { return false; }
  };

  function environment() {
    const connection = browser ? navigator.connection : null;
    const constrained = prefs.quality === 'saver' || !!connection?.saveData || /(^|-)2g$/.test(String(connection?.effectiveType || ''));
    let speed = paceOf(pace.ms, pace.samples);
    if (speed === 'unknown' && connection?.effectiveType === '3g') speed = 'slow';
    const phone = coarsePointer();
    /* Decoded bytes the window may hold. iPhone Safari gives a tab far less
       than a desktop, and a page's decoded size is width x height x 4
       whatever its file size. */
    const deviceMemory = browser ? Number(navigator.deviceMemory || 0) : 0;
    const budget = phone ? (deviceMemory && deviceMemory <= 2 ? 64 : 110) * MB : 220 * MB;
    return { constrained, speed, budget };
  }

  /** Decoded bytes for a page: what the reader measured, else what the manifest declares. */
  function pageBytes(page, measured) {
    const m = page && measured && typeof measured.get === 'function' ? measured.get(page.key) : null;
    const w = Number(m?.width || page?.width || 0);
    const h = Number(m?.height || page?.height || 0);
    return w > 0 && h > 0 ? w * h * 4 : null;
  }

  /**
   * The pages to keep mounted around `index`: { start, end }.
   *
   * Ahead first, because that is where the reader is going: up to four pages
   * on a fast line, three on a normal one, two on a slow one, one with Data
   * saver. Two behind (one with Data saver), for the reader who scrolls back
   * up a panel. All of it inside a decoded-byte budget, but never fewer than
   * one either side -- a page you can scroll to must be there.
   */
  function windowRange(index, count, pages, measured, env = environment()) {
    if (!(count > 0)) return { start: 0, end: -1 };
    const at = Math.min(Math.max(0, index | 0), count - 1);
    const ahead = env.constrained ? 1 : env.speed === 'slow' ? 2 : env.speed === 'normal' ? 3 : 4;
    const behind = env.constrained ? 1 : 2;

    const known = [];
    if (Array.isArray(pages)) {
      for (let i = Math.max(0, at - 6); i < Math.min(count, at + 7); i++) {
        const bytes = pageBytes(pages[i], measured);
        if (bytes) known.push(bytes);
      }
    }
    known.sort((a, b) => a - b);
    const typical = known.length ? known[known.length >> 1] : UNKNOWN_PAGE_BYTES;
    const cost = (i) => (Array.isArray(pages) && pageBytes(pages[i], measured)) || typical;

    let used = cost(at);
    let start = at;
    let end = at;
    /* One either side, whatever it costs. */
    if (end + 1 < count) { end++; used += cost(end); }
    if (start - 1 >= 0) { start--; used += cost(start); }
    /* Then ahead, then behind, while the budget holds. */
    while (end - at < ahead && end + 1 < count && used + cost(end + 1) <= env.budget) { end++; used += cost(end); }
    while (at - start < behind && start - 1 >= 0 && used + cost(start - 1) <= env.budget) { start--; used += cost(start); }
    return { start, end };
  }

  /* --- spreads ------------------------------------------------------------- */

  /**
   * Group pages into what one screen shows. Single: every page alone. Spread:
   * pairs, with the first page alone when `cover` is on, and any page that is
   * already wider than tall (a double page scanned as one) alone.
   * `aspect(i)` is width/height when known, else null.
   */
  function spreadGroups(count, aspect, { spread = false, cover = true } = {}) {
    const groups = [];
    if (!(count > 0)) return groups;
    if (!spread) { for (let i = 0; i < count; i++) groups.push([i]); return groups; }
    const wide = (i) => { const a = aspect(i); return a != null && a > 1.05; };
    let i = 0;
    if (cover) { groups.push([0]); i = 1; }
    while (i < count) {
      if (wide(i)) { groups.push([i]); i++; continue; }
      if (i + 1 < count && !wide(i + 1)) { groups.push([i, i + 1]); i += 2; }
      else { groups.push([i]); i++; }
    }
    return groups;
  }

  /** The group that shows page `index`. */
  function groupOf(groups, index) {
    let found = 0;
    for (let g = 0; g < groups.length; g++) {
      if (groups[g][0] <= index) found = g;
      else break;
    }
    return found;
  }

  /* --- turning pages ---------------------------------------------------------- */

  /** A tap at fraction `x` across the page: the edges turn, the middle is the menu. */
  function tapAction(x, rtl) {
    if (!(x >= 0)) return 'menu';
    if (x < 0.3) return rtl ? 'next' : 'back';
    if (x > 0.7) return rtl ? 'back' : 'next';
    return 'menu';
  }

  /** A finished swipe: mostly sideways and far enough is a turn. */
  function swipeAction(dx, dy, rtl) {
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.4) return null;
    /* Dragging the page to the left brings the next one in from the right. */
    const leftward = dx < 0;
    return leftward ? (rtl ? 'back' : 'next') : (rtl ? 'next' : 'back');
  }

  /** A key in the paged view. Arrows follow the direction on screen. */
  function keyAction(key, shift, rtl) {
    if (key === 'ArrowRight') return rtl ? 'back' : 'next';
    if (key === 'ArrowLeft') return rtl ? 'next' : 'back';
    if (key === 'ArrowDown' || key === 'PageDown') return 'next';
    if (key === ' ' || key === 'Spacebar') return shift ? 'back' : 'next';
    if (key === 'ArrowUp' || key === 'PageUp') return 'back';
    if (key === 'Home') return 'first';
    if (key === 'End') return 'last';
    return null;
  }

  /* --- which mode a chapter looks like ----------------------------------- */

  /**
   * 'page', 'scroll' or null, from page heights over widths and what the
   * title is. Tall strips are a long-strip comic wherever they come from. A
   * page-shaped image is only manga when the title is Japanese: plenty of
   * webtoon sites slice their strip into page-sized pieces, and offering Page
   * mode for those would be wrong every time.
   */
  function inferMode(ratios, origin) {
    const values = (ratios || []).filter((r) => r > 0).sort((a, b) => a - b);
    if (values.length < 6) return null;
    const median = values[values.length >> 1];
    if (median >= 2.2) return 'scroll';
    const pageShaped = values.filter((r) => r >= 1.2 && r <= 1.8).length / values.length;
    if (origin === 'manga' && median >= 1.25 && median <= 1.75 && pageShaped >= 0.7) return 'page';
    return null;
  }

  /** 'manga' | 'strip' | null, from the series and the AniList cache. */
  function originOf(series) {
    const category = String(series?.category || '').toLowerCase();
    if (category === 'manga') return 'manga';
    if (/manhwa|manhua|webtoon/.test(category)) return 'strip';
    try {
      const hit = globalThis.YomuAniList?.cached?.(series?.title);
      const country = String(hit?.country || '').toUpperCase();
      if (country === 'JP') return 'manga';
      if (country === 'KR' || country === 'CN' || country === 'TW') return 'strip';
    } catch {}
    return null;
  }

  /* --- shortcuts ------------------------------------------------------------- */

  const SHORTCUTS = [
    ['← →', 'Turn pages (in Page mode, the way the pages face)'],
    ['↑ ↓  Space', 'Scroll, or turn pages'],
    ['[  ]', 'Previous and next chapter'],
    ['M', 'Change mode: Scroll, Page, Spread'],
    ['C', 'Chapters'],
    ['S', 'Reading settings'],
    ['F', 'Full screen'],
    ['?', 'This list'],
    ['Esc', 'Close'],
  ];

  function shortcutAction(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return null;
    const key = event.key;
    if (key === '[' || key === ',') return 'previous-chapter';
    if (key === ']' || key === '.') return 'next-chapter';
    if (key === 'm' || key === 'M') return 'mode';
    if (key === 'c' || key === 'C') return 'chapters';
    if (key === 's' || key === 'S') return 'settings';
    if (key === 'f' || key === 'F') return 'fullscreen';
    if (key === '?') return 'help';
    return null;
  }

  /** The mode after `choice`, skipping Spread on a narrow screen. */
  function nextMode(choice, wide) {
    const order = wide ? ['scroll', 'page', 'spread'] : ['scroll', 'page'];
    const at = order.indexOf(choice);
    return order[(at + 1) % order.length];
  }

  /* --- the paged view ------------------------------------------------------ */

  const reader = () => (browser && location.pathname.startsWith('/read/') ? globalThis.__yomuReader : null);

  function chapterLabel(series, chapterId) {
    const chapter = series?.chapters?.find?.((c) => c.id === chapterId);
    if (!chapter) return '';
    /* A name that only restates the number ("Chapter 1194") is not repeated. */
    const plain = String(chapter.name || '').trim();
    const bare = plain.replace(/^(?:chapter|ch\.?|episode|ep\.?)\s*/i, '').replace(/[\s:.\-–—]+$/, '');
    const name = plain && plain !== String(chapter.number) && bare !== String(chapter.number) ? ` · ${plain}` : '';
    return `Chapter ${chapter.number}${name}`;
  }

  function Paged({ React: R, adapter, pages, chapterId, initialIndex = 0, onPositionChange, onCountChange, onTap, spread }) {
    const h = R.createElement;
    const count = pages.length;
    const clampIndex = (n) => Math.min(Math.max(0, n | 0), Math.max(0, count - 1));

    const [index, setIndex] = R.useState(() => clampIndex(initialIndex));
    const [atEnd, setAtEnd] = R.useState(false);
    const [dims, setDims] = R.useState(() => new Map());
    const [, refresh] = R.useState(0);
    const [tip, setTip] = R.useState(false);
    const rootRef = R.useRef(null);
    const gesture = R.useRef(null);
    const warmRef = R.useRef([]);

    const wide = !!spread && browser && innerWidth >= 768;
    const aspect = R.useCallback((i) => {
      const page = pages[i];
      const m = page && dims.get(page.key);
      const w = Number(m?.width || page?.width || 0);
      const hgt = Number(m?.height || page?.height || 0);
      return w > 0 && hgt > 0 ? w / hgt : null;
    }, [pages, dims]);
    const groups = R.useMemo(() => spreadGroups(count, aspect, { spread: wide, cover: prefs.cover }), [count, aspect, wide, prefs.cover]);
    const g = groupOf(groups, index);
    const group = groups[g] || [index];
    const lastGroup = g >= groups.length - 1;

    /* A new chapter starts where the reader said. */
    R.useEffect(() => { setIndex(clampIndex(initialIndex)); setAtEnd(false); setDims(new Map()); }, [chapterId]);

    R.useEffect(() => {
      const fn = () => refresh((n) => n + 1);
      listeners.add(fn);
      addEventListener('resize', fn);
      return () => { listeners.delete(fn); removeEventListener('resize', fn); };
    }, []);

    /* The position is the first page on screen; at the end panel, the last. */
    R.useEffect(() => {
      const shown = atEnd ? count - 1 : group[0];
      onPositionChange(shown, 0);
      onCountChange?.(shown);
    }, [index, atEnd, g, count, onPositionChange, onCountChange]);

    /* The next two screens' pages, fetched and decoded before the turn. Keyed
       on which pages those are, so learning a page's size does not restart
       the downloads. */
    const upcoming = [...(groups[g + 1] || []), ...(environment().constrained ? [] : groups[g + 2] || [])];
    const warmKey = upcoming.map((i) => pages[i]?.key).join('|');
    R.useEffect(() => {
      for (const img of warmRef.current) img.removeAttribute('src');
      warmRef.current = [];
      for (const i of upcoming) {
        const page = pages[i];
        if (!page) continue;
        const img = new Image();
        img.decoding = 'async';
        img.src = uri(adapter, page);
        img.decode?.().then(() => {
          if (img.naturalWidth > 0) setDims((map) => (map.has(page.key) ? map : new Map(map).set(page.key, { width: img.naturalWidth, height: img.naturalHeight })));
        }).catch(() => {});
        warmRef.current.push(img);
      }
      return () => { for (const img of warmRef.current) img.removeAttribute('src'); warmRef.current = []; };
    }, [warmKey, chapterId]);

    /* One look at the tap zones, the first time Page mode is used. */
    R.useEffect(() => {
      let seen = false;
      try { seen = !!localStorage.getItem(PAGED_TIP_KEY); } catch {}
      if (seen) return;
      try { localStorage.setItem(PAGED_TIP_KEY, '1'); } catch {}
      setTip(true);
      const timer = setTimeout(() => setTip(false), 2600);
      return () => clearTimeout(timer);
    }, []);

    const go = R.useCallback((action) => {
      if (action === 'first') { setAtEnd(false); setIndex(0); return; }
      if (action === 'last') { setAtEnd(false); setIndex(groups.length ? groups[groups.length - 1][0] : 0); return; }
      if (action === 'next') {
        if (atEnd) {
          const r = reader();
          if (r?.next) r.navigate?.(r.next);
          return;
        }
        if (!lastGroup) { setIndex(groups[g + 1][0]); return; }
        setAtEnd(true);
        return;
      }
      if (action === 'back') {
        if (atEnd) { setAtEnd(false); return; }
        if (g > 0) setIndex(groups[g - 1][0]);
      }
    }, [atEnd, g, groups, lastGroup]);

    /* A layout effect: the listeners exist before the view is painted, so a
       seek sent the moment Page mode mounts (a source switch restoring the
       place) is not dropped between the commit and a passive effect. */
    R.useLayoutEffect(() => {
      const key = (event) => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target;
        if (target?.closest?.('input,select,textarea,[contenteditable],.rd-sheet,[role="dialog"]') || reader()?.sheet) return;
        /* A focused button keeps Space and Enter; the arrows still turn pages,
           or clicking the arrow once would leave the keyboard dead. */
        if ((event.key === ' ' || event.key === 'Enter') && target?.closest?.('button,a')) return;
        const action = keyAction(event.key, event.shiftKey, prefs.rtl);
        if (!action) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        go(action);
      };
      const seek = (event) => {
        const n = Number(event.detail);
        if (!Number.isFinite(n)) return;
        setAtEnd(false);
        setIndex(clampIndex(n));
      };
      addEventListener('keydown', key, true);
      addEventListener('yomu:seek-page', seek);
      return () => { removeEventListener('keydown', key, true); removeEventListener('yomu:seek-page', seek); };
    }, [go, count]);

    const onPointerDown = (event) => {
      /* A new press is a new gesture: whatever a finished swipe armed is off. */
      suppressClick.armed = false;
      if (event.pointerType === 'mouse' || !event.isPrimary) return;
      gesture.current = { x: event.clientX, y: event.clientY, at: Date.now(), turned: false };
    };
    const onPointerUp = (event) => {
      const start = gesture.current;
      gesture.current = null;
      if (!start || Date.now() - start.at > 900) return;
      /* A pinch-zoomed page is being panned, not turned. */
      if ((globalThis.visualViewport?.scale || 1) > 1.02) return;
      const action = swipeAction(event.clientX - start.x, event.clientY - start.y, prefs.rtl);
      if (!action) return;
      /* A browser may follow the same touch with a click. That click has no
         press of its own, so it is swallowed; a real tap starts with one,
         which disarms this (onPointerDown). */
      suppressClick.armed = true;
      go(action);
    };
    const onClick = (event) => {
      if (suppressClick.armed) { suppressClick.armed = false; return; }
      if (event.target.closest('button,a,textarea,input,.yomu-paged-end')) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const action = tapAction((event.clientX - rect.left) / (rect.width || 1), prefs.rtl);
      if (action === 'menu') onTap?.();
      else go(action);
    };

    const r = reader();
    const nextLabel = r?.next ? chapterLabel(r.series, r.next) : '';
    const hereLabel = chapterLabel(r?.series, chapterId);
    const single = group.length === 1;
    const visualLeft = prefs.rtl ? 'next' : 'back';
    const visualRight = prefs.rtl ? 'back' : 'next';
    const canLeft = visualLeft === 'back' ? (atEnd || g > 0) : true;
    const canRight = visualRight === 'back' ? (atEnd || g > 0) : true;
    const arrowLabel = (action) => (action === 'next' ? (atEnd ? 'Next chapter' : 'Next page') : 'Previous page');
    const shownOnScreen = prefs.rtl ? [...group].reverse() : group;

    const pageNodes = shownOnScreen.map((i, slot) => {
      const page = pages[i];
      const position = single ? 'center' : slot === 0 ? 'right center' : 'left center';
      return h('div', { key: page.key, 'data-page-index': i, className: 'yomu-paged-page' },
        h(PagedImage, {
          React: R, page, adapter, position,
          onDims: (key, width, height) => setDims((map) => {
            const old = map.get(key);
            return old && old.width === width && old.height === height ? map : new Map(map).set(key, { width, height });
          }),
        }));
    });

    const end = atEnd
      ? h('section', { className: 'yomu-paged-end', 'data-yomu-thread-host': '', role: 'group', 'aria-label': 'End of chapter' },
        h('div', { className: 'yomu-paged-end__card' },
          h('small', null, hereLabel ? `End of ${hereLabel}` : 'End of chapter'),
          r?.next
            ? h('button', { type: 'button', className: 'yomu-paged-end__next', onClick: () => r.navigate?.(r.next) },
              h('span', null, 'Next'), h('strong', null, nextLabel || 'Next chapter'))
            : h('p', { className: 'yomu-paged-end__done' }, 'You are caught up with this title.'),
          h('button', { type: 'button', className: 'yomu-paged-end__back', onClick: () => go('back') }, 'Back to the last page')))
      : null;

    return h('div', {
      ref: rootRef,
      className: 'yomu-paged' + (single ? ' is-single' : ' is-spread'),
      'data-testid': 'reader-paged',
      'data-at-end': atEnd || lastGroup ? '1' : '0',
      'data-rtl': prefs.rtl ? '1' : '0',
      onClick, onPointerDown, onPointerUp,
      onPointerCancel: () => { gesture.current = null; },
    },
    atEnd ? end : h('div', {
      className: 'yomu-paged-pages',
      style: { maxWidth: single ? prefs.width : undefined },
    }, ...pageNodes),
    h('button', { type: 'button', className: 'yomu-page-arrow yomu-page-arrow--left', 'aria-label': arrowLabel(visualLeft), disabled: !canLeft || (visualLeft === 'next' && atEnd && !r?.next), onClick: (e) => { e.stopPropagation(); go(visualLeft); } }, '‹'),
    h('button', { type: 'button', className: 'yomu-page-arrow yomu-page-arrow--right', 'aria-label': arrowLabel(visualRight), disabled: !canRight || (visualRight === 'next' && atEnd && !r?.next), onClick: (e) => { e.stopPropagation(); go(visualRight); } }, '›'),
    tip ? h('div', { className: 'yomu-paged-tip', 'aria-hidden': true },
      h('span', null, prefs.rtl ? 'Next' : 'Back'), h('span', null, 'Menu'), h('span', null, prefs.rtl ? 'Back' : 'Next')) : null);
  }
  const suppressClick = { armed: false };

  function PagedImage({ React: R, page, adapter, position, onDims }) {
    const h = R.createElement;
    /* Which src loaded and which failed, rather than one state reset by an
       effect: a cached page can fire load before an effect would run. */
    const [loaded, setLoaded] = R.useState('');
    const [failed, setFailed] = R.useState('');
    const [attempt, setAttempt] = R.useState(0);
    const src = uri(adapter, page);
    const state = loaded === src ? 'loaded' : failed === src ? 'failed' : 'loading';
    return h(R.Fragment, null,
      h('img', {
        key: attempt,
        src,
        alt: `Page ${page.index + 1}`,
        decoding: 'async',
        draggable: false,
        style: { objectPosition: position },
        onLoad: (event) => {
          setLoaded(src);
          setFailed('');
          const img = event.currentTarget;
          if (img.naturalWidth > 0) onDims(page.key, img.naturalWidth, img.naturalHeight);
        },
        /* Page rescue is still trying another door: this is loading, not failed. */
        onError: (event) => { if (event.currentTarget?.dataset?.yomuRescue !== 'pending') setFailed(src); },
      }),
      state === 'loading' ? h('span', { className: 'yomu-paged-wait', 'aria-hidden': true }) : null,
      state === 'failed'
        ? h('div', { className: 'yomu-paged-failed', role: 'status' },
          h('span', null, `Page ${page.index + 1} did not load`),
          h('button', {
            type: 'button',
            onClick: (event) => {
              event.stopPropagation();
              globalThis.YomuPageRescue?.reset?.(src);
              setFailed('');
              setAttempt((n) => n + 1);
            },
          }, 'Try again'))
        : null);
  }

  /* --- the settings, in the reader's own sheet --------------------------- */

  function switchRow(label, hint, key) {
    const row = document.createElement('div');
    row.className = 'rd-row yomu-rs-row';
    const text = document.createElement('span');
    text.className = 'yomu-rs-label';
    text.textContent = label;
    if (hint) {
      const small = document.createElement('small');
      small.textContent = hint;
      text.append(small);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rd-switch';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-label', label);
    button.dataset.pref = key;
    button.append(document.createElement('i'));
    button.addEventListener('click', () => save({ [key]: !prefs[key] }));
    row.append(text, button);
    return row;
  }

  function rangeRow(label, key, range, format) {
    const wrap = document.createElement('div');
    wrap.className = 'yomu-rs-range';
    const head = document.createElement('div');
    head.className = 'rd-row yomu-rs-row';
    const text = document.createElement('span');
    text.className = 'yomu-rs-label';
    text.textContent = label;
    const out = document.createElement('output');
    out.dataset.out = key;
    head.append(text, out);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.dataset.pref = key;
    input.setAttribute('aria-label', label);
    input.addEventListener('input', () => { out.textContent = format(Number(input.value)); });
    input.addEventListener('change', () => save({ [key]: Number(input.value) }));
    wrap.append(head, input);
    return wrap;
  }

  function qualityRow() {
    const wrap = document.createElement('div');
    wrap.className = 'yomu-rs-quality';
    const head = document.createElement('div');
    head.className = 'rd-sub';
    head.textContent = 'Image quality';
    const modes = document.createElement('div');
    modes.className = 'rd-modes yomu-rs-modes';
    for (const [value, title] of [['original', 'Original'], ['saver', 'Data saver']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rd-mode';
      button.dataset.quality = value;
      button.textContent = title;
      button.addEventListener('click', () => save({ quality: value }));
      modes.append(button);
    }
    wrap.append(head, modes);
    return wrap;
  }

  const fmtWidth = (n) => (n >= WIDTH.max ? 'Full width' : `${n}px`);
  const fmtGap = (n) => (n ? `${n}px` : 'Flush');

  function buildGroup() {
    const group = document.createElement('div');
    group.dataset.readerComfort = '1';
    const title = document.createElement('h3');
    title.className = 'rd-sub';
    title.textContent = 'Reading';
    group.append(
      title,
      switchRow('Continuous chapters', 'Scroll straight on into the next chapter', 'continuous'),
      switchRow('Right to left', 'Page and Spread, for manga', 'rtl'),
      switchRow('First page alone in Spread', 'Turn off if pairs look one page out', 'cover'),
      rangeRow('Page gap', 'gap', GAP, fmtGap),
      rangeRow('Page width', 'width', WIDTH, fmtWidth),
      qualityRow(),
    );
    const note = document.createElement('p');
    note.className = 'rd-note';
    note.textContent = 'Data saver loads fewer pages ahead, and uses smaller images where the source has them.';
    group.append(note);
    if (finePointer()) {
      const keys = document.createElement('button');
      keys.type = 'button';
      keys.className = 'yomu-rs-keys';
      keys.textContent = 'Keyboard shortcuts';
      keys.addEventListener('click', () => showShortcuts());
      group.append(keys);
    }
    return group;
  }

  function paintGroup(group) {
    for (const button of group.querySelectorAll('.rd-switch[data-pref]')) {
      const on = !!prefs[button.dataset.pref];
      if (button.getAttribute('aria-checked') !== String(on)) button.setAttribute('aria-checked', String(on));
      button.classList.toggle('is-on', on);
    }
    for (const input of group.querySelectorAll('input[type="range"][data-pref]')) {
      const value = String(prefs[input.dataset.pref]);
      if (document.activeElement !== input && input.value !== value) input.value = value;
    }
    for (const out of group.querySelectorAll('output[data-out]')) {
      const key = out.dataset.out;
      const text = key === 'width' ? fmtWidth(prefs.width) : fmtGap(prefs.gap);
      if (out.textContent !== text) out.textContent = text;
    }
    for (const button of group.querySelectorAll('.rd-mode[data-quality]')) {
      const on = prefs.quality === button.dataset.quality;
      button.classList.toggle('is-on', on);
      if (button.getAttribute('aria-pressed') !== String(on)) button.setAttribute('aria-pressed', String(on));
    }
  }

  function mountSettings() {
    const sheet = document.querySelector('.rd-sheet[aria-label="Reading settings"]');
    if (!sheet) return;
    let group = sheet.querySelector('[data-reader-comfort]');
    if (!group) {
      group = buildGroup();
      /* Before Appearance, so the reading controls sit together. */
      const appearance = [...sheet.querySelectorAll(':scope > .rd-sub')].find((node) => /appearance/i.test(node.textContent || ''));
      if (appearance) sheet.insertBefore(group, appearance);
      else sheet.append(group);
    }
    paintGroup(group);
  }

  /* --- shortcuts sheet -------------------------------------------------------- */

  const finePointer = () => {
    try { return matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return false; }
  };

  function closeShortcuts() {
    document.getElementById('yomu-keys')?.remove();
  }

  function showShortcuts() {
    if (document.getElementById('yomu-keys')) { closeShortcuts(); return; }
    const panel = document.createElement('div');
    panel.id = 'yomu-keys';
    panel.className = 'yomu-keys glass';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Keyboard shortcuts');
    const head = document.createElement('div');
    head.className = 'yomu-keys__head';
    const title = document.createElement('h2');
    title.textContent = 'Keyboard shortcuts';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'rd-icon';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', closeShortcuts);
    head.append(title, close);
    const list = document.createElement('dl');
    for (const [keys, what] of SHORTCUTS) {
      const dt = document.createElement('dt');
      for (const part of keys.split(/\s{2,}|\s(?=\S)/).filter(Boolean)) {
        const kbd = document.createElement('kbd');
        kbd.textContent = part;
        dt.append(kbd);
      }
      const dd = document.createElement('dd');
      dd.textContent = what;
      list.append(dt, dd);
    }
    panel.append(head, list);
    document.body.append(panel);
    close.focus();
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen?.();
    } catch {}
  }

  function onShortcut(event) {
    const r = reader();
    if (!r) return;
    if (event.key === 'Escape' && document.getElementById('yomu-keys')) { closeShortcuts(); event.preventDefault(); return; }
    if (event.defaultPrevented || event.target?.closest?.('input,select,textarea,[contenteditable]')) return;
    const action = shortcutAction(event);
    if (!action) return;
    if (action !== 'help' && r.sheet && action !== 'chapters' && action !== 'settings') return;
    event.preventDefault();
    switch (action) {
      case 'previous-chapter': if (r.previous) r.navigate?.(r.previous); break;
      case 'next-chapter': if (r.next) r.navigate?.(r.next); break;
      case 'mode': r.setMode?.(nextMode(r.choice, r.wide)); r.show?.(); break;
      case 'chapters': r.openSheet?.(r.sheetName === 'chapters' ? '' : 'chapters'); break;
      case 'settings': r.openSheet?.(r.sheetName === 'settings' ? '' : 'settings'); break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'help': showShortcuts(); break;
      default:
    }
  }

  /* --- the mode suggestion ----------------------------------------------------- */

  const hints = () => { try { return JSON.parse(localStorage.getItem(HINT_KEY) || '{}') || {}; } catch { return {}; } };
  function noteHint(key, value) {
    const all = hints();
    all[key] = value;
    const keys = Object.keys(all);
    if (keys.length > 400) delete all[keys[0]];
    try { localStorage.setItem(HINT_KEY, JSON.stringify(all)); } catch {}
  }

  let hintFor = '';
  function measuredRatios() {
    const out = [];
    for (const img of document.querySelectorAll('[data-testid="reader-scroll"] [data-page-index] img, [data-testid="reader-paged"] [data-page-index] img')) {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) out.push(img.naturalHeight / img.naturalWidth);
    }
    return out;
  }

  function considerHint(r) {
    if (!r || !(r.count >= 8) || r.sheet) return;
    const key = `${r.source}:${r.seriesId}`;
    if (hintFor === key || hints()[key]) return;
    const want = inferMode(measuredRatios(), originOf(r.series));
    if (!want || want === r.mode) return;
    hintFor = key;
    noteHint(key, 'shown');
    const chip = document.createElement('div');
    chip.id = 'yomu-mode-hint';
    chip.className = 'yomu-mode-hint';
    chip.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = want === 'page' ? 'These are manga pages. Read one page at a time?' : 'This is a vertical strip. Scroll it instead?';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.textContent = want === 'page' ? 'Page mode' : 'Scroll mode';
    yes.addEventListener('click', () => { noteHint(key, 'accepted'); reader()?.setMode?.(want); chip.remove(); });
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'yomu-mode-hint__x';
    no.setAttribute('aria-label', 'No thanks');
    no.textContent = '×';
    no.addEventListener('click', () => { noteHint(key, 'dismissed'); chip.remove(); });
    chip.append(text, yes, no);
    document.getElementById('yomu-mode-hint')?.remove();
    document.body.append(chip);
    setTimeout(() => chip.remove(), 9000);
  }

  /* --- wiring ----------------------------------------------------------------- */

  let hintTimer = null;
  function onReader() {
    const r = reader();
    if (!r) return;
    if (r.sheetName === 'settings') mountSettings();
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => considerHint(reader()), 2500);
  }

  const api = {
    prefs, save, uri, windowRange, Paged,
    /** 'fast' | 'normal' | 'slow' | 'unknown': how pages are arriving here. */
    speed: () => environment().speed,
    constrained: () => environment().constrained,
    /* pure, for the tests */
    readPrefs, pageBytes, spreadGroups, groupOf, tapAction, swipeAction, keyAction,
    inferMode, originOf, shortcutAction, nextMode, paceOf, DEFAULTS,
  };

  if (browser) {
    window.YomuReaderSettings = api;
    addEventListener('yomu:reader', onReader);
    addEventListener('keydown', onShortcut);
    addEventListener('yomu:reader-settings', () => {
      const group = document.querySelector('[data-reader-comfort]');
      if (group) paintGroup(group);
    });
    /* Arrived after the reader drew itself with the bundle's defaults: one
       relayout for the strip, and one render for the route, which is what
       swaps in the paged view. */
    if (globalThis.__yomuReader) {
      try { dispatchEvent(new Event('resize')); } catch {}
      if (globalThis.__yomuReader.choice && globalThis.__yomuReader.choice !== 'scroll') globalThis.__yomuReader.show?.();
      onReader();
    }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      readPrefs, pageBytes, windowRange, spreadGroups, groupOf, tapAction, swipeAction, keyAction,
      inferMode, originOf, shortcutAction, nextMode, paceOf, DEFAULTS,
    };
  }
})();
