/* ==================================================================== *
 * Yomu stickers — the reward type nothing displayed
 * ====================================================================
 *
 * The progression store has granted sticker ids since it shipped
 * (reader-first-steps at five chapters, page-turner-sticker at ten) and no
 * surface ever drew one. This is the renderer, and the catalogue of what
 * each id looks like and how it is earned.
 *
 * A sticker is printed art, not theme ink: it is die-cut paper with a white
 * rim and a pastel plate, and it looks like that on Aurora and on Paper
 * alike. So unlike the badges there are no mode blocks here -- the colours
 * are fixed, and the only thing the theme supplies is the shadow under it.
 *
 * Stickers are also how you react to a Circle comment, and the picker there
 * offers only the ones you have earned. That is the whole point of drawing
 * them: a rare sticker under a comment says something a heart cannot.
 *
 *   YomuStickers.svg('century-sticker', {size: 40})   -> markup string
 *   YomuStickers.el('finisher-sticker', {size: 28})   -> an <svg> element
 *   YomuStickers.info(id)                             -> {id, title, hint, tone}
 *   YomuStickers.earned()                             -> ids this reader owns
 * ==================================================================== */
(function (w) {
  'use strict';

  /* Plate tones. Pastel enough that the dark ink reads on all of them, and
     distinct enough that a row of five is a row of five. */
  var TONES = {
    mint: '#bfe8d3',
    sky:  '#c5daf7',
    gold: '#f6d98a',
    rose: '#f7c7c9',
    plum: '#dccaf3',
    sand: '#efe1c2',
  };

  var STICKERS = {
    'reader-first-steps': {
      title: 'First Steps', tone: 'mint', hint: 'Five chapters finished',
      em: '<ellipse class="k" cx="40" cy="58" rx="7" ry="10"/><circle class="k" cx="35" cy="44" r="3"/><circle class="k" cx="42" cy="42" r="3"/>' +
          '<ellipse class="k" cx="60" cy="44" rx="7" ry="10"/><circle class="k" cx="55" cy="30" r="3"/><circle class="k" cx="62" cy="28" r="3"/>',
    },
    'page-turner-sticker': {
      title: 'Page Turner', tone: 'sky', hint: 'Ten chapters finished',
      em: '<path d="M32 28 h36 v30 l-14 14 h-22 z"/><path d="M54 72 v-14 h14"/>' +
          '<path d="M40 40 h20 M40 48 h20 M40 56 h10"/>',
    },
    'century-sticker': {
      title: 'Century', tone: 'gold', hint: 'One hundred chapters',
      em: '<text class="t" x="50" y="60" text-anchor="middle" font-size="30">100</text>' +
          '<path d="M30 68 h40"/>',
    },
    'tome-eater-sticker': {
      title: 'Tome Eater', tone: 'rose', hint: 'Five hundred chapters',
      em: '<path d="M32 30 h36 v40 h-36 z"/><path d="M50 30 v40"/>' +
          '<path class="p" d="M60 30 a9 9 0 0 0 8 9 v-9 z"/>' +
          '<path d="M38 62 l4 -5 l4 5 l4 -5 l4 5 l4 -5 l4 5"/>',
    },
    'living-library-sticker': {
      title: 'Living Library', tone: 'plum', hint: 'A thousand chapters',
      em: '<path d="M30 34 v36 M40 34 v36 M50 38 v32 M60 34 v36 M67 40 l5 30"/>' +
          '<path d="M26 70 h48 M26 34 h40"/>',
    },
    'well-sourced-sticker': {
      title: 'Well Sourced', tone: 'sky', hint: 'Five sources switched on',
      em: '<circle cx="50" cy="52" r="6"/>' +
          '<path d="M50 46 v-14 M44.5 54.5 l-12 8 M55.5 54.5 l12 8 M46 47 l-10 -8 M54 47 l10 -8"/>' +
          '<circle class="k" cx="50" cy="28" r="4"/><circle class="k" cx="30" cy="66" r="4"/><circle class="k" cx="70" cy="66" r="4"/>' +
          '<circle class="k" cx="33" cy="36" r="4"/><circle class="k" cx="67" cy="36" r="4"/>',
    },
    'finisher-sticker': {
      title: 'Finisher', tone: 'gold', hint: 'A saved title read to its last chapter',
      em: '<path d="M34 26 v50"/><path d="M34 28 h34 v24 h-34 z"/>' +
          '<path class="k" d="M34 28 h8.5 v8 h-8.5 z M51 28 h8.5 v8 h-8.5 z M42.5 36 h8.5 v8 h-8.5 z M59.5 36 h8.5 v8 h-8.5 z M34 44 h8.5 v8 h-8.5 z M51 44 h8.5 v8 h-8.5 z"/>',
    },
    'three-shores-sticker': {
      title: 'Three Shores', tone: 'mint', hint: 'A title each from Korea, Japan and China',
      em: '<path d="M26 40 q6 -7 12 0 t12 0 t12 0 t12 0"/>' +
          '<path d="M26 52 q6 -7 12 0 t12 0 t12 0 t12 0"/>' +
          '<path d="M26 64 q6 -7 12 0 t12 0 t12 0 t12 0"/>',
    },
  };

  var INK = '#1e1b16';
  var RIM = '#fffdfa';

  function svg(id, opts) {
    var row = STICKERS[id];
    if (!row) { return ''; }
    opts = opts || {};
    var plate = TONES[row.tone] || TONES.sand;
    var size = opts.size ? ' width="' + opts.size + '" height="' + opts.size + '"' : '';
    var cls = ['ys', 'ys--' + row.tone];
    if (opts.locked) { cls.push('ys--locked'); }
    if (opts.className) { cls.push(opts.className); }
    return '<svg class="' + cls.join(' ') + '" viewBox="0 0 100 100"' + size +
      ' role="img" aria-label="' + row.title + (opts.locked ? ', not earned yet' : '') + '">' +
      /* The white die-cut rim, then the plate, then the art. The rim is a
         stroke on the plate's own circle so the two stay concentric at any
         size. */
      '<circle class="rim" cx="50" cy="50" r="45" fill="' + RIM + '"/>' +
      '<circle class="plate" cx="50" cy="50" r="39" fill="' + plate + '"/>' +
      '<g class="em" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"' +
      ' style="--ys-plate:' + plate + ';--ys-ink:' + INK + '">' +
      row.em +
      '</g></svg>';
  }

  function el(id, opts) {
    var box = document.createElement('div');
    box.innerHTML = svg(id, opts);
    return box.firstChild;
  }

  function info(id) {
    var row = STICKERS[id];
    return row ? { id: id, title: row.title, hint: row.hint, tone: row.tone } : null;
  }

  function list() {
    var out = [];
    for (var k in STICKERS) {
      if (Object.prototype.hasOwnProperty.call(STICKERS, k)) { out.push(info(k)); }
    }
    return out;
  }

  /** The ids this reader has, in catalogue order, and only ones with art. */
  function earned() {
    var have = (w.YomuProgress && w.YomuProgress.get && w.YomuProgress.get().earnedStickerIds) || [];
    var out = [];
    for (var k in STICKERS) {
      if (Object.prototype.hasOwnProperty.call(STICKERS, k) && have.indexOf(k) !== -1) { out.push(k); }
    }
    return out;
  }

  /* Fills every [data-sticker] under root, once. */
  function mount(root) {
    var nodes = (root || document).querySelectorAll('[data-sticker]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.getAttribute('data-sticker-done')) { continue; }
      var made = svg(n.getAttribute('data-sticker'), {
        size: n.getAttribute('data-sticker-size') || 0,
        locked: n.hasAttribute('data-sticker-locked'),
      });
      if (!made) { continue; }
      n.innerHTML = made;
      n.setAttribute('data-sticker-done', '1');
    }
  }

  var api = { svg: svg, el: el, info: info, list: list, earned: earned, mount: mount, tones: TONES };

  if (typeof w !== 'undefined' && w) { w.YomuStickers = api; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { STICKERS: STICKERS, TONES: TONES, svg: svg }; }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { mount(document); });
    } else {
      mount(document);
    }
  }
})(typeof window !== 'undefined' ? window : undefined);
