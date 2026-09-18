/* ==================================================================== *
 * Yomu badges — one renderer, 30 families, 5 tiers
 * ====================================================================
 *
 * Needs yomu-badges.css. Every colour lives there, so this file only ever
 * emits geometry and class names, and a mode switch is free.
 *
 * The plate is the Yomu mark's own construction: a polygon drawn twice, fat
 * stroke then thin, both with stroke-linejoin:round, so the corners soften by
 * exactly the amount the mark's do. Do not replace it with a rounded rect.
 *
 *   YomuBadges.svg('tower-climber', 4)                  -> markup string
 *   YomuBadges.svg('dao-seeker', 5, {variant:'micro'})  -> mileage marker
 *   YomuBadges.el('heart-chaser', 1, {size: 96})        -> an <svg> element
 *   YomuBadges.mount(root)                              -> fills
 *                [data-badge="slug" data-tier="3" data-badge-variant="micro"]
 *
 * variant: '' | 'micro' | 'locked' | 'mono' | 'emblem'
 * ==================================================================== */
(function (w) {
  'use strict';

  var PLATES = {
    "1": {
      "shape": "15,20 50,27 85,20 85,72 50,88 15,72",
      "instep": "19.55,24.42 50.0,30.51 80.45,24.42 80.45,69.66 50.0,83.58 19.55,69.66",
      "bevel": "M18 21 L50 29 L82 21",
      "nubs": false,
      "wings": false,
      "crest": false
    },
    "2": {
      "shape": "15,20 50,27 85,20 85,72 50,88 15,72",
      "instep": "19.55,24.42 50.0,30.51 80.45,24.42 80.45,69.66 50.0,83.58 19.55,69.66",
      "bevel": "M18 21 L50 29 L82 21",
      "nubs": true,
      "wings": false,
      "crest": false
    },
    "3": {
      "shape": "15,20 50,29 85,20 85,42 90,52 85,62 85,72 50,88 15,72 15,62 10,52 15,42",
      "instep": "19.55,24.42 50.0,32.25 80.45,24.42 80.45,43.56 84.8,52.26 80.45,60.96 80.45,69.66 50.0,83.58 19.55,69.66 19.55,60.96 15.200000000000003,52.26 19.55,43.56",
      "bevel": "M18 21 L50 31 L82 21",
      "nubs": false,
      "wings": false,
      "crest": false
    },
    "4": {
      "shape": "15,20 50,29 85,20 85,42 90,52 85,62 85,72 50,88 15,72 15,62 10,52 15,42",
      "instep": "19.55,24.42 50.0,32.25 80.45,24.42 80.45,43.56 84.8,52.26 80.45,60.96 80.45,69.66 50.0,83.58 19.55,69.66 19.55,60.96 15.200000000000003,52.26 19.55,43.56",
      "bevel": "M18 21 L50 31 L82 21",
      "nubs": false,
      "wings": true,
      "crest": false
    },
    "5": {
      "shape": "15,20 50,29 85,20 85,42 90,52 85,62 85,72 50,88 15,72 15,62 10,52 15,42",
      "instep": "19.55,24.42 50.0,32.25 80.45,24.42 80.45,43.56 84.8,52.26 80.45,60.96 80.45,69.66 50.0,83.58 19.55,69.66 19.55,60.96 15.200000000000003,52.26 19.55,43.56",
      "bevel": "M18 21 L50 31 L82 21",
      "nubs": false,
      "wings": true,
      "crest": true
    }
  };
  var PARTS = {
    "nubL": "6,46 16,50 16,58 6,54",
    "nubR": "94,46 84,50 84,58 94,54",
    "wingL": "4,30 14,34 14,47 4,43",
    "wingR": "96,30 86,34 86,47 96,43",
    "crest": [
      "50,4 58,26 42,26",
      "29,12 38,16 38,26 29,22",
      "71,12 62,16 62,26 71,22"
    ],
    "foot": "44,89 56,89 53,95 47,95"
  };
  var FAMILIES = {
    "world-hopper": {
      "cat": "manga",
      "theme": "Isekai",
      "title": "World Hopper",
      "em": "<ellipse cx=\"50\" cy=\"50\" rx=\"13.5\" ry=\"18\"/> <path class=\"a\" d=\"M50 32.5 a13 17.5 0 0 0 0 35\"/> <path d=\"M38 67 h24\"/>"
    },
    "battle-junkie": {
      "cat": "manga",
      "theme": "Shonen / action",
      "title": "Battle Junkie",
      "em": "<path class=\"f\" d=\"M50 27 L56 43 L72 49 L56 55 L50 71 L44 55 L28 49 L44 43 Z\"/> <path class=\"a\" d=\"M68 32 L62 38\"/> <path class=\"a\" d=\"M32 68 L38 62\"/>"
    },
    "realm-wanderer": {
      "cat": "manga",
      "theme": "Fantasy",
      "title": "Realm Wanderer",
      "em": "<path class=\"f\" d=\"M32 49 h36 l-12 17 h-12 Z\"/> <path d=\"M36 49 c3 -7 10 -9 15 -5 c4 -6 12 -4 13 5\"/> <path class=\"af\" d=\"M62 29 l2.2 4.8 l4.8 2.2 l-4.8 2.2 l-2.2 4.8 l-2.2 -4.8 l-4.8 -2.2 l4.8 -2.2 Z\"/>"
    },
    "heart-chaser": {
      "cat": "manga",
      "theme": "Romance",
      "title": "Heart Chaser",
      "em": "<path d=\"M50 67 C 33 54, 29 43, 35.5 37 C 42 31, 50 35.5, 50 42 C 50 35.5, 58 31, 64.5 37 C 71 43, 67 54, 50 67 Z\"/> <path class=\"a\" d=\"M42 65 L50 70 L58 65\"/>"
    },
    "quiet-observer": {
      "cat": "manga",
      "theme": "Slice of life",
      "title": "Quiet Observer",
      "em": "<path d=\"M35 46 h26 v5 a13 13 0 0 1 -26 0 Z\"/> <path d=\"M61 49 a6 6 0 0 1 0 10\"/> <path d=\"M31 68 h38\"/> <path class=\"a\" d=\"M44 38 c3.5 -4 -3.5 -6.5 0 -10\"/> <path class=\"a\" d=\"M56 38 c3.5 -4 -3.5 -6.5 0 -10\"/>"
    },
    "yokai-watcher": {
      "cat": "manga",
      "theme": "Horror / supernatural",
      "title": "Yokai Watcher",
      "em": "<path d=\"M32 50 C 39 39, 61 39, 68 50 C 61 61, 39 61, 32 50 Z\"/> <ellipse class=\"af\" cx=\"50\" cy=\"50\" rx=\"3.2\" ry=\"6.6\"/> <path class=\"a\" d=\"M38 38 L35 31\"/> <path class=\"a\" d=\"M62 38 L65 31\"/>"
    },
    "truth-seeker": {
      "cat": "manga",
      "theme": "Mystery / thriller",
      "title": "Truth Seeker",
      "em": "<circle cx=\"47\" cy=\"46\" r=\"15\"/> <path d=\"M57.5 56.5 L68 67\"/> <circle class=\"af\" cx=\"47\" cy=\"43\" r=\"3.4\"/> <path class=\"af\" d=\"M44.6 47 L43.4 53.5 h7.2 l-1.2 -6.5 Z\"/>"
    },
    "final-challenger": {
      "cat": "manga",
      "theme": "Sports",
      "title": "Final Challenger",
      "em": "<path d=\"M40 34 h20 v8 a10 10 0 0 1 -20 0 Z\"/> <path d=\"M40 37 a5 5 0 0 0 -7 5 a8 8 0 0 0 7 5\"/> <path d=\"M60 37 a5 5 0 0 1 7 5 a8 8 0 0 1 -7 5\"/> <path d=\"M50 52 v9\"/> <path d=\"M41 65 h18\"/> <path class=\"a\" d=\"M45 41 h10\"/>"
    },
    "ronin-reader": {
      "cat": "manga",
      "theme": "Historical / samurai",
      "title": "Ronin Reader",
      "em": "<path d=\"M36 64 L67 33\"/> <path d=\"M41 55 L50 64\"/> <path class=\"a\" d=\"M32.5 67.5 L39 61\"/> <circle class=\"af\" cx=\"31\" cy=\"69\" r=\"2.6\"/>"
    },
    "starbound-pilot": {
      "cat": "manga",
      "theme": "Sci-fi / mecha",
      "title": "Starbound Pilot",
      "em": "<circle cx=\"50\" cy=\"51\" r=\"12.5\"/> <ellipse class=\"a\" cx=\"50\" cy=\"51\" rx=\"22\" ry=\"7\" transform=\"rotate(-20 50 51)\"/> <path class=\"af\" d=\"M67 29 l1.8 4 l4 1.8 l-4 1.8 l-1.8 4 l-1.8 -4 l-4 -1.8 l4 -1.8 Z\"/>"
    },
    "tower-climber": {
      "cat": "manhwa",
      "theme": "Towers",
      "title": "Tower Climber",
      "em": "<path class=\"af\" d=\"M50 27 L57.5 39 H42.5 Z\"/> <path d=\"M43.5 39 h13 v9 h-13 Z\"/> <path d=\"M40.5 48 h19 v9 h-19 Z\"/> <path d=\"M37.5 57 h25 v9 h-25 Z\"/> <path d=\"M32 66 h36\"/>"
    },
    "dungeon-raider": {
      "cat": "manhwa",
      "theme": "Dungeons / gates",
      "title": "Dungeon Raider",
      "em": "<path d=\"M35 69 V50 a15 15 0 0 1 30 0 v19\"/> <path d=\"M42 69 V51 a8 8 0 0 1 16 0 v18\"/> <path class=\"af\" d=\"M50 27 l5 6.5 l-5 6.5 l-5 -6.5 Z\"/> <path d=\"M32 69 h36\"/>"
    },
    "returner": {
      "cat": "manhwa",
      "theme": "Regression",
      "title": "Returner",
      "em": "<path d=\"M63 36 A17 17 0 1 1 63 64\"/> <path class=\"af\" d=\"M63 30 l7.5 6 l-7.5 6 Z\"/> <path class=\"a\" d=\"M50 41 v10 h-9\"/>"
    },
    "second-lifer": {
      "cat": "manhwa",
      "theme": "Reincarnation",
      "title": "Second Lifer",
      "em": "<path class=\"af\" d=\"M50 30 c9 10 12 18 6 25 c-1 -5 -3 -7 -6 -9 c-3 2 -5 4 -6 9 c-6 -7 -3 -15 6 -25 Z\"/> <path d=\"M33 52 c-2 12 8 20 17 20 c9 0 19 -8 17 -20\"/>"
    },
    "system-breaker": {
      "cat": "manhwa",
      "theme": "System / leveling",
      "title": "System Breaker",
      "em": "<path d=\"M32 40 V32 h8\"/> <path d=\"M68 40 V32 h-8\"/> <path d=\"M32 60 V68 h8\"/> <path d=\"M68 60 V68 h-8\"/> <path class=\"a\" d=\"M40 52 L50 42 L60 52\"/> <path d=\"M40 64 L50 54 L60 64\"/>"
    },
    "murim-wanderer": {
      "cat": "manhwa",
      "theme": "Murim",
      "title": "Murim Wanderer",
      "em": "<path d=\"M30 66 L41 47 L48 57 L56 43 L68 66 Z\"/> <path class=\"a\" d=\"M62 39 v-8\"/> <path class=\"a\" d=\"M58.5 35 h7 M58.5 31.5 h7\"/>"
    },
    "academy-prodigy": {
      "cat": "manhwa",
      "theme": "Academy",
      "title": "Academy Prodigy",
      "em": "<path d=\"M32 66 V49 c7.5 -4.5 13 -4.5 18 -1 c5 -3.5 10.5 -3.5 18 1 v17 c-7.5 -4.5 -13 -4.5 -18 -1 c-5 -3.5 -10.5 -3.5 -18 1 Z\"/> <path d=\"M50 48 v17\"/> <path class=\"af\" d=\"M50 28 l2.8 6 l6 2.8 l-6 2.8 l-2.8 6 l-2.8 -6 l-6 -2.8 l6 -2.8 Z\"/>"
    },
    "villainess-enjoyer": {
      "cat": "manhwa",
      "theme": "Villainess",
      "title": "Villainess Enjoyer",
      "em": "<path d=\"M36 61 L33 39 L42 46 L50 33 L58 46 L67 39 L64 61 Z\"/> <path d=\"M34 67 h32\"/> <circle class=\"af\" cx=\"50\" cy=\"54\" r=\"4.2\"/> <path class=\"a\" d=\"M39 67 l-3 4 M61 67 l3 4\"/>"
    },
    "contract-romantic": {
      "cat": "manhwa",
      "theme": "Romance",
      "title": "Contract Romantic",
      "em": "<path d=\"M34 31 h26 v28 h-26 Z\"/> <path d=\"M39.5 40 h15 M39.5 47.5 h11\"/> <circle class=\"af\" cx=\"60\" cy=\"60\" r=\"7\"/> <path class=\"a\" d=\"M56.5 66 l-1.5 7 l5 -2.5 l5 2.5 l-1.5 -7\"/>"
    },
    "power-fantasy-addict": {
      "cat": "manhwa",
      "theme": "OP protagonist",
      "title": "Power Fantasy Addict",
      "em": "<path class=\"f\" d=\"M34 62 L31 37 L41 46 L50 31 L59 46 L69 37 L66 62 Z\"/> <path class=\"crack\" d=\"M50 33 L45.5 44 L53 50 L47.5 62\"/> <path class=\"a\" d=\"M28 31 l4 4 M72 31 l-4 4\"/>"
    },
    "dao-seeker": {
      "cat": "manhua",
      "theme": "Cultivation",
      "title": "Dao Seeker",
      "em": "<circle cx=\"50\" cy=\"50\" r=\"17\"/> <path d=\"M50 33 a8.5 8.5 0 0 1 0 17 a8.5 8.5 0 0 0 0 17\"/> <circle class=\"af\" cx=\"50\" cy=\"41.5\" r=\"2.8\"/> <circle class=\"f\" cx=\"50\" cy=\"58.5\" r=\"2.8\"/>"
    },
    "jianghu-wanderer": {
      "cat": "manhua",
      "theme": "Wuxia",
      "title": "Jianghu Wanderer",
      "em": "<path d=\"M32 55 L44 35 L56 55 Z\"/> <path d=\"M31 62 c5 -4 9 4 14 0 c5 -4 9 4 14 0\"/> <path d=\"M31 69 c5 -4 9 4 14 0 c5 -4 9 4 14 0\"/> <path class=\"a\" d=\"M57 37 c8 3 10 9 7 15\"/>"
    },
    "immortal-aspirant": {
      "cat": "manhua",
      "theme": "Xianxia",
      "title": "Immortal Aspirant",
      "em": "<ellipse cx=\"50\" cy=\"32\" rx=\"14\" ry=\"5.5\"/> <path d=\"M41 42 h18 v22 l-9 7 l-9 -7 Z\"/> <path class=\"a\" d=\"M46 49 h8 M46 56 h8\"/>"
    },
    "martial-disciple": {
      "cat": "manhua",
      "theme": "Martial arts",
      "title": "Martial Disciple",
      "em": "<rect x=\"33\" y=\"33\" width=\"34\" height=\"34\" rx=\"8\"/> <path d=\"M43 33 v34 M57 33 v34 M33 43 h34 M33 57 h34\"/> <rect class=\"af\" x=\"43\" y=\"43\" width=\"14\" height=\"14\" rx=\"3\"/>"
    },
    "sect-elder": {
      "cat": "manhua",
      "theme": "Sect stories",
      "title": "Sect Elder",
      "em": "<path d=\"M31 45 L50 33 L69 45 Z\"/> <path d=\"M35 57 L50 47 L65 57 Z\"/> <path d=\"M39 68 h22 v-7 h-22 Z\"/> <path class=\"a\" d=\"M50 33 v-5\"/>"
    },
    "reborn-sage": {
      "cat": "manhua",
      "theme": "Reincarnation",
      "title": "Reborn Sage",
      "em": "<path d=\"M50 62 C 38 57, 30 45, 34 31 C 42 38, 47 47, 50 57\"/> <path d=\"M50 62 C 62 57, 70 45, 66 31 C 58 38, 53 47, 50 57\"/> <path class=\"a\" d=\"M50 62 l-4.5 9 M50 62 l4.5 9 M50 62 v10\"/>"
    },
    "pill-master": {
      "cat": "manhua",
      "theme": "Alchemy",
      "title": "Pill Master",
      "em": "<path d=\"M35 50 h30 v4 a15 15 0 0 1 -30 0 Z\"/> <path d=\"M32 50 h36\"/> <path d=\"M43 66 v5 M57 66 v5\"/> <circle class=\"af\" cx=\"50\" cy=\"39\" r=\"4.6\"/>"
    },
    "spirit-tamer": {
      "cat": "manhua",
      "theme": "Spirit beasts",
      "title": "Spirit Tamer",
      "em": "<path class=\"f\" d=\"M50 70 c-8 0 -13 -5 -13 -9 c0 -5.5 5.5 -8.5 13 -8.5 c7.5 0 13 3 13 8.5 c0 4 -5 9 -13 9 Z\"/> <ellipse class=\"f\" cx=\"35.5\" cy=\"45\" rx=\"4.4\" ry=\"5.8\"/> <ellipse class=\"f\" cx=\"45\" cy=\"38.5\" rx=\"4.4\" ry=\"6.2\"/> <ellipse class=\"f\" cx=\"55\" cy=\"38.5\" rx=\"4.4\" ry=\"6.2\"/> <ellipse class=\"af\" cx=\"64.5\" cy=\"45\" rx=\"4.4\" ry=\"5.8\"/>"
    },
    "court-strategist": {
      "cat": "manhua",
      "theme": "Historical / court",
      "title": "Court Strategist",
      "em": "<path d=\"M50 65 L29 48 A34 34 0 0 1 71 48 Z\"/> <path d=\"M34 52 A27 27 0 0 1 66 52\"/> <path class=\"a\" d=\"M50 65 V44 M50 65 L38 52 M50 65 L62 52\"/> <circle class=\"f\" cx=\"50\" cy=\"65\" r=\"2.8\"/>"
    },
    "heaven-defier": {
      "cat": "manhua",
      "theme": "OP cultivation MC",
      "title": "Heaven Defier",
      "em": "<path d=\"M37 41 A16 16 0 1 0 63 41\"/> <path class=\"af\" d=\"M54 30 L43 50 h8 L47 70 L61 47 h-8 Z\"/>"
    }
  };

  var seq = 0;

  function svg(slug, tier, opts) {
    var fam = FAMILIES[slug];
    if (!fam) { return ''; }
    tier = Math.min(5, Math.max(1, tier | 0 || 1));
    opts = opts || {};
    var variant = opts.variant || '';
    var plate = PLATES[tier];
    var id = 'yb' + (++seq);
    var cls = ['yb', 'yb--t' + tier];
    if (variant) { cls.push('yb--' + variant); }
    if (opts.className) { cls.push(opts.className); }

    var size = opts.size ? ' width="' + opts.size + '" height="' + opts.size + '"' : '';
    var label = fam.title + ', tier ' + tier + (variant === 'locked' ? ', locked' : '');
    var o = ['<svg class="' + cls.join(' ') + '" viewBox="0 0 100 100"' + size +
             ' role="img" aria-label="' + label + '">'];

    if (variant !== 'emblem') {
      o.push('<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
             '<stop offset="0" stop-color="var(--yb-pl-hi)"/>' +
             '<stop offset="1" stop-color="var(--yb-pl-lo)"/></linearGradient></defs>');
      o.push('<g class="frame">');
      if (plate.wings && variant !== 'micro') {
        o.push(poly('wing', PARTS.wingL), poly('wing', PARTS.wingR));
      }
      if (plate.nubs) {
        o.push(poly('wing', PARTS.nubL), poly('wing', PARTS.nubR));
      }
      if (plate.crest && variant !== 'micro') {
        for (var i = 0; i < PARTS.crest.length; i++) { o.push(poly('crest', PARTS.crest[i])); }
        o.push(poly('crest', PARTS.foot));
      }
      o.push(poly('rimfill', plate.shape));
      o.push('<polygon class="platefill" points="' + plate.shape + '" fill="url(#' + id + ')"/>');
      if (variant !== 'micro' && variant !== 'locked' && variant !== 'mono') {
        o.push('<path class="bevel" d="' + plate.bevel + '"/>');
        o.push('<polygon class="step" points="' + plate.instep + '"/>');
      }
      o.push('</g>');
    }

    var scale = variant === 'micro' ? 0.96 : 0.84;
    o.push('<g class="em" transform="translate(50,52) scale(' + scale + ') translate(-50,-50)">');
    o.push(fam.em);
    o.push('</g></svg>');
    return o.join('');
  }

  function poly(cls, points) {
    return '<polygon class="' + cls + '" points="' + points + '"/>';
  }

  function el(slug, tier, opts) {
    var box = document.createElement('div');
    box.innerHTML = svg(slug, tier, opts);
    return box.firstChild;
  }

  /* Fills every [data-badge] under root. Safe to call again after a render:
     a node already filled is skipped. */
  function mount(root) {
    var nodes = (root || document).querySelectorAll('[data-badge]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.getAttribute('data-badge-done')) { continue; }
      var made = svg(n.getAttribute('data-badge'),
                     parseInt(n.getAttribute('data-tier'), 10) || 1,
                     { variant: n.getAttribute('data-badge-variant') || '',
                       size: n.getAttribute('data-badge-size') || 0 });
      if (!made) { continue; }
      n.innerHTML = made;
      n.setAttribute('data-badge-done', '1');
    }
  }

  function list(cat) {
    var out = [];
    for (var k in FAMILIES) {
      if (Object.prototype.hasOwnProperty.call(FAMILIES, k) && (!cat || FAMILIES[k].cat === cat)) {
        out.push({ slug: k, cat: FAMILIES[k].cat, theme: FAMILIES[k].theme, title: FAMILIES[k].title });
      }
    }
    return out;
  }

  /* badge_manhwa_tower-climber_t4_micro.svg */
  function filename(slug, tier, variant) {
    var fam = FAMILIES[slug];
    if (!fam) { return ''; }
    return 'badge_' + fam.cat + '_' + slug + '_t' + tier + '_' + (variant || 'profile') + '.svg';
  }

  w.YomuBadges = {
    svg: svg, el: el, mount: mount, list: list, filename: filename,
    families: FAMILIES, tiers: [1, 2, 3, 4, 5]
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mount(document); });
  } else {
    mount(document);
  }
})(window);
