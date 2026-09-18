/**
 * Yomu badge shelf — the art was in the repo and nothing showed it.
 *
 * yomu-badges.js draws thirty affinity families at five tiers, and
 * yomu-progress.js has had `equipBadge` since it shipped. Neither had a
 * surface. This file is that surface, in three places:
 *
 *   - the shelf on Your Yomu: earned and locked badges, tap to equip
 *   - the equipped badge beside the name in the masthead
 *   - a renderer the Circle client uses to draw a badge on a comment
 *
 * It also gives the roadmap badges their art. The store pays plain ids
 * ("page-turner", "century") where the affinity system pays "family:tier",
 * and the badge renderer only knew families. Rather than fork the renderer,
 * the milestone badges are registered into it as families of their own,
 * with a fixed plate tier each, so one renderer still draws everything and
 * the mode switch stays free.
 *
 * Nothing here is reward truth. Earned, equipped and claimed all come from
 * YomuProgress; this file only asks and draws.
 */
(() => {
  'use strict';

  const SHELF_ID = 'yomu-shelf';
  const STICKERS_ID = 'yomu-stickers';
  const MAST_CLASS = 'yomu-greet__badge';

  const browser = typeof document !== 'undefined';

  /* --- the milestone families -------------------------------------------- *
   *
   * Same drawing rules as the family emblems in yomu-badges.js: strokes in
   * a 100x100 box, `.a`/`.af` for the accent stroke/fill, `.f` for an ink
   * fill. The plate tier is the badge's rank on the shelf: a Tier V plate is
   * gold with a crest, and a thousand chapters has earned that.
   */
  const MILESTONE_FAMILIES = {
    'page-turner': {
      tier: 1, title: 'Page Turner', theme: '10 chapters',
      em: '<path d="M30 34 c8 -3 14 -3 20 2 c6 -5 12 -5 20 -2 v32 c-8 -3 -14 -3 -20 2 c-6 -5 -12 -5 -20 2 Z"/><path d="M50 36 v32"/><path class="a" d="M58 44 h7 M58 50 h7"/>',
    },
    'book-goblin': {
      tier: 2, title: 'Book Goblin', theme: '50 chapters',
      em: '<path d="M32 60 h36 v8 h-36 Z"/><path d="M36 50 h28 v8 h-28 Z"/><path d="M40 40 h20 v8 h-20 Z"/>' +
          '<circle class="af" cx="45" cy="33" r="2.8"/><circle class="af" cx="55" cy="33" r="2.8"/>' +
          '<path class="f" d="M36 38 l-9 -9 l2 13 Z"/><path class="f" d="M64 38 l9 -9 l-2 13 Z"/>',
    },
    century: {
      tier: 3, title: 'Century', theme: '100 chapters',
      em: '<path d="M63 38 a17 17 0 1 0 0 24"/><path class="a" d="M50 28 v-4 M50 76 v-4"/><circle class="af" cx="66" cy="50" r="3"/>',
    },
    'shelf-bender': {
      tier: 3, title: 'Shelf Bender', theme: '250 chapters',
      em: '<path d="M30 42 v-12 h8 v14 M42 43 v-15 h8 v17 M54 44 v-12 h8 v13"/><path d="M26 45 q24 13 48 0"/><path class="a" d="M30 48 v14 M70 48 v14"/>',
    },
    'tome-eater': {
      tier: 4, title: 'Tome Eater', theme: '500 chapters',
      em: '<path d="M33 32 h34 v36 h-34 Z"/><path d="M50 32 v36"/><path class="af" d="M59 32 a8 8 0 0 0 8 8 v-8 Z"/>' +
          '<path class="a" d="M38 62 l4 -5 l4 5 l4 -5 l4 5 l4 -5 l4 5"/>',
    },
    'living-library': {
      tier: 5, title: 'Living Library', theme: '1000 chapters',
      em: '<path d="M30 40 v28 M40 40 v28 M50 40 v28 M60 40 v28 M70 40 v28 M26 68 h48 M26 40 h48"/>' +
          '<path class="af" d="M50 22 l2.6 5.4 l6 .9 l-4.3 4.2 l1 6 l-5.3 -2.8 l-5.3 2.8 l1 -6 l-4.3 -4.2 l6 -.9 Z"/>',
    },
    'well-sourced': {
      tier: 2, title: 'Well Sourced', theme: 'Five sources on',
      em: '<circle cx="50" cy="52" r="6"/><path d="M50 46 v-14 M44.5 54.5 l-12 8 M55.5 54.5 l12 8 M46 47 l-10 -8 M54 47 l10 -8"/>' +
          '<circle class="af" cx="50" cy="28" r="3.6"/><circle class="f" cx="30" cy="66" r="3.6"/><circle class="f" cx="70" cy="66" r="3.6"/><circle class="f" cx="33" cy="36" r="3.6"/><circle class="f" cx="67" cy="36" r="3.6"/>',
    },
    finisher: {
      tier: 2, title: 'Finisher', theme: 'A title finished',
      em: '<path d="M36 28 v44"/><path d="M36 30 h30 l-5 9 l5 9 h-30 Z"/><path class="af" d="M40 34 h7 v6 h-7 Z M54 40 h7 v6 h-7 Z"/>',
    },
    closer: {
      tier: 3, title: 'Closer', theme: 'Ten titles finished',
      em: '<path d="M32 34 h36 v32 h-36 Z"/><path d="M32 40 h36"/><path class="a" d="M40 52 l7 7 l14 -14"/>',
    },
    'three-shores': {
      tier: 3, title: 'Three Shores', theme: 'Korea, Japan and China',
      em: '<path d="M28 42 q5.5 -6 11 0 t11 0 t11 0 t11 0"/><path class="a" d="M28 53 q5.5 -6 11 0 t11 0 t11 0 t11 0"/><path d="M28 64 q5.5 -6 11 0 t11 0 t11 0 t11 0"/>',
    },
    'bingo-line': {
      tier: 2, title: 'Bingo', theme: 'A line on the card',
      em: '<path d="M30 30 h40 v40 h-40 Z"/><path d="M43 30 v40 M57 30 v40 M30 43 h40 M30 57 h40"/><path class="a" d="M33 33 l34 34"/>',
    },
    'bingo-card': {
      tier: 4, title: 'Full Card', theme: 'Every square in a month',
      em: '<path d="M30 30 h40 v40 h-40 Z"/><path d="M43 30 v40 M57 30 v40 M30 43 h40 M30 57 h40"/><path class="af" d="M33 33 h7 v7 h-7 Z M46 33 h8 v7 h-8 Z M60 33 h7 v7 h-7 Z M33 46 h7 v8 h-7 Z M46 46 h8 v8 h-8 Z M60 46 h7 v8 h-7 Z M33 60 h7 v7 h-7 Z M46 60 h8 v7 h-8 Z M60 60 h7 v7 h-7 Z"/>',
    },
    'streak-week': {
      tier: 2, title: 'Week of Pages', theme: 'Seven days running',
      em: '<path d="M50 28 c5 10 14 14 14 27 a14 14 0 0 1 -28 0 c0 -8 5 -12 7 -18 c2 5 5 7 7 7 c-1 -6 -2 -10 0 -16 Z"/><path class="af" d="M50 52 c3 4 6 7 6 11 a6 6 0 0 1 -12 0 c0 -4 3 -7 6 -11 Z"/>',
    },
    'streak-month': {
      tier: 4, title: 'Month of Pages', theme: 'Thirty days running',
      em: '<path d="M50 26 c5 10 14 14 14 29 a14 14 0 0 1 -28 0 c0 -8 5 -12 7 -18 c2 5 5 7 7 7 c-1 -6 -2 -10 0 -18 Z"/><path class="af" d="M50 52 c3 4 6 7 6 11 a6 6 0 0 1 -12 0 c0 -4 3 -7 6 -11 Z"/><path class="a" d="M30 70 h40"/>',
    },
    'streak-hundred': {
      tier: 5, title: 'Hundred Days', theme: 'A hundred days running',
      em: '<path d="M50 24 c5 10 15 15 15 31 a15 15 0 0 1 -30 0 c0 -9 5 -13 7 -19 c2 5 5 7 7 7 c-1 -6 -2 -10 1 -19 Z"/><path class="af" d="M50 52 c3 4 6 7 6 11 a6 6 0 0 1 -12 0 c0 -4 3 -7 6 -11 Z"/><path class="a" d="M26 72 h48 M32 66 l4 -6 M68 66 l-4 -6"/>',
    },
    'stage-fledgling': {
      tier: 1, title: 'Fledgling', theme: 'Mori, stage 2',
      em: '<path d="M50 30 c-12 0 -16 13 -16 21 a16 16 0 0 0 32 0 c0 -8 -4 -21 -16 -21 Z"/><path class="a" d="M45 44 l4 5 l-3 5 l4 5"/>',
    },
    'stage-companion': {
      tier: 2, title: 'Companion', theme: 'Mori, stage 3',
      em: '<circle cx="50" cy="50" r="18"/><circle class="af" cx="44" cy="46" r="2.6"/><circle class="af" cx="56" cy="46" r="2.6"/><path d="M42 56 q8 6 16 0"/>',
    },
    'stage-familiar': {
      tier: 3, title: 'Familiar', theme: 'Mori, stage 4',
      em: '<ellipse cx="50" cy="58" rx="12" ry="9"/><circle class="f" cx="36" cy="46" r="4.4"/><circle class="f" cx="45" cy="38" r="4.4"/><circle class="f" cx="55" cy="38" r="4.4"/><circle class="af" cx="64" cy="46" r="4.4"/>',
    },
    'stage-sage': {
      tier: 5, title: 'Sage', theme: 'Mori, fully grown',
      em: '<path d="M50 72 v-24"/><path d="M50 48 c-16 0 -22 -12 -20 -22 c12 -2 22 6 20 22 Z"/><path class="af" d="M50 48 c16 0 22 -12 20 -22 c-12 -2 -22 6 -20 22 Z"/>',
    },
  };

  const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

  function register() {
    const badges = typeof window !== 'undefined' && window.YomuBadges;
    if (!badges || !badges.families) return false;
    for (const [slug, row] of Object.entries(MILESTONE_FAMILIES)) {
      if (badges.families[slug]) continue;
      badges.families[slug] = { cat: 'yomu', theme: row.theme, title: row.title, em: row.em };
    }
    return true;
  }

  /** "tower-climber:3" -> {slug, tier}; "century" -> {slug, tier: 3}. */
  function parse(id) {
    const text = String(id || '');
    if (!text) return null;
    const [slug, tierText] = text.split(':');
    if (MILESTONE_FAMILIES[slug]) return { slug, tier: MILESTONE_FAMILIES[slug].tier, milestone: true };
    const tier = Number(tierText);
    if (!slug || !tier) return null;
    return { slug, tier, milestone: false };
  }

  function family(slug) {
    const badges = window.YomuBadges;
    return (badges && badges.families && badges.families[slug]) || null;
  }

  /** The reader-facing title: "Tower Climber III", "Century". */
  function title(id) {
    const parts = parse(id);
    if (!parts) return '';
    const fam = family(parts.slug);
    if (!fam) return '';
    return parts.milestone ? fam.title : fam.title + ' ' + ROMAN[parts.tier - 1];
  }

  /* --- the rendered art ------------------------------------------------------ *
   *
   * The thirty affinity families also have painted, cartoon badges, shipped
   * at 256px under /brand/badges. They are an exception to the live-vector
   * rule, made on purpose: at shelf size the painting is the point. Below
   * about 40px a painting goes muddy and the vector micro badge takes over,
   * so the masthead and a comment's name stay vector. The tier rides on a
   * corner chip, because the art has no tiers of its own; locked is the
   * same picture, greyed.
   */
  const ART_BASE = '/brand/badges/';
  const ART_MIN = 40;
  const artFor = (slug) => {
    const fam = family(slug);
    return fam && ['manga', 'manhwa', 'manhua'].includes(fam.cat) ? ART_BASE + fam.cat + '_' + slug + '.png' : '';
  };

  function artEl(parts, opts) {
    const size = Number(opts.size) || 56;
    const locked = opts.variant === 'locked';
    const wrap = document.createElement('span');
    wrap.className = 'yba yba--t' + parts.tier + (locked ? ' is-locked' : '');
    wrap.style.width = size + 'px';
    wrap.style.height = size + 'px';
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', title(parts.slug + ':' + parts.tier) + (locked ? ', locked' : ''));
    const img = document.createElement('img');
    img.src = artFor(parts.slug);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    wrap.append(img);
    const chip = document.createElement('i');
    chip.className = 'yba__tier';
    chip.textContent = ROMAN[parts.tier - 1];
    wrap.append(chip);
    return wrap;
  }

  function el(id, opts) {
    register();
    const parts = parse(id);
    if (!parts || !family(parts.slug) || !window.YomuBadges) return null;
    const o = opts || {};
    const size = Number(o.size) || 0;
    if (o.art !== false && !parts.milestone && o.variant !== 'micro' && size >= ART_MIN && artFor(parts.slug)) {
      return artEl(parts, o);
    }
    return window.YomuBadges.el(parts.slug, parts.tier, o);
  }

  /* --- the masthead ------------------------------------------------------- *
   *
   * The shell owns `.yomu-greet` and rewrites the name's text only when it
   * changes. The badge goes inside the name element as an inline mark, so
   * `textContent` still equals the name and the shell never sees a reason to
   * wipe it. Re-asserted on every pass: the shell rebuilds the whole block on
   * a route change.
   */
  function paintMasthead() {
    const name = document.querySelector('.yomu-greet__name');
    if (!name) return;
    const id = window.YomuProgress?.get?.().equippedBadgeId || '';
    const existing = name.querySelector('.' + MAST_CLASS);
    if (!id) { existing?.remove(); return; }
    if (existing && existing.dataset.badgeId === id) return;
    existing?.remove();
    const badge = el(id, { variant: 'micro', size: 18 });
    if (!badge) return;
    const wrap = document.createElement('span');
    wrap.className = MAST_CLASS;
    wrap.dataset.badgeId = id;
    wrap.title = title(id);
    wrap.append(badge);
    name.append(wrap);
  }

  /* --- the shelf ---------------------------------------------------------- */

  let note = '';

  function affinityRows(state) {
    const tiers = window.YomuProgress.tierXp ? window.YomuProgress.tierXp() : [10, 40, 120, 300, 700];
    const rows = [];
    /* Earned: the highest tier per family, since the lower tiers are the
       same emblem on a plainer plate and a shelf of duplicates is clutter. */
    const best = new Map();
    for (const id of state.earnedBadgeIds) {
      const parts = parse(id);
      if (!parts || parts.milestone) continue;
      if (!best.has(parts.slug) || best.get(parts.slug) < parts.tier) best.set(parts.slug, parts.tier);
    }
    for (const [slug, tier] of best) {
      rows.push({ id: slug + ':' + tier, slug, tier, earned: true, kind: 'affinity',
        how: (family(slug)?.theme || slug) + ' · tier ' + ROMAN[tier - 1] });
    }
    /* Next up: the families with some reading behind them and the next tier
       still ahead. The four closest, so the shelf shows where you are
       heading without listing thirty families you have never touched. */
    const ahead = [];
    for (const [slug, xp] of Object.entries(state.affinity || {})) {
      if (!family(slug)) continue;
      const have = best.get(slug) || 0;
      if (have >= tiers.length) continue;
      const need = tiers[have];
      ahead.push({ id: slug + ':' + (have + 1), slug, tier: have + 1, earned: false, kind: 'affinity',
        fraction: xp / need,
        how: `${family(slug).theme} · ${Math.max(0, Math.ceil(need - xp))} more chapters of it` });
    }
    ahead.sort((a, b) => b.fraction - a.fraction);
    return rows.concat(ahead.slice(0, 4));
  }

  function milestoneRows(state) {
    const P = window.YomuProgress;
    const rows = [];
    for (const badge of P.milestoneBadges()) {
      const parts = parse(badge.id);
      if (!parts) continue;
      let how = badge.how || '';
      if (!how) {
        if (badge.metric === 'chaptersRead') how = badge.threshold + ' chapters';
        else if (badge.metric === 'petXp') how = 'Mori reaches ' + badge.title;
      }
      if (!badge.earned) {
        const value = badge.metric === 'chaptersRead' ? state.chaptersRead
          : badge.metric === 'petXp' ? state.petXp
          : badge.metric === 'sourcesUsed' ? state.sourcesUsed
          : badge.metric === 'titlesCompleted' ? state.titlesCompleted
          : badge.metric === 'originsRead' ? (state.origins || []).length
          : badge.metric === 'currentStreak' ? (P.streak ? P.streak().current : 0)
          : badge.metric === 'bingoLines' ? state.bingoLines
          : badge.metric === 'bingoCards' ? state.bingoCards : 0;
        const left = Math.max(0, badge.threshold - Math.floor(value));
        if (badge.metric === 'chaptersRead') how += ` · ${left} to go`;
        else if (badge.metric === 'petXp') how += ` · ${left} XP to go`;
        else if (badge.metric === 'currentStreak') how += ` · ${left} more day${left === 1 ? '' : 's'}`;
      }
      rows.push({ id: badge.id, slug: parts.slug, tier: parts.tier, earned: badge.earned, kind: 'milestone', how });
    }
    return rows;
  }

  function badgeButton(row, equippedId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ysh-badge' + (row.earned ? '' : ' is-locked') + (row.id === equippedId ? ' is-equipped' : '');
    button.setAttribute('aria-pressed', String(row.id === equippedId));
    button.setAttribute('aria-label', title(row.id) + (row.earned ? '' : ', locked') + (row.id === equippedId ? ', equipped' : ''));
    const art = el(row.id, { variant: row.earned ? '' : 'locked', size: 56 });
    if (art) button.append(art);
    const label = document.createElement('span');
    label.className = 'ysh-badge__label';
    label.textContent = title(row.id);
    button.append(label);

    button.addEventListener('click', () => {
      const P = window.YomuProgress;
      if (!row.earned) {
        note = title(row.id) + ' · ' + row.how;
        paintShelf();
        return;
      }
      const wasOn = P.get().equippedBadgeId === row.id;
      P.equipBadge(wasOn ? null : row.id);
      note = wasOn ? 'Taken off.' : title(row.id) + ' is on your name now.';
      /* yomu:progress repaints the shelf, the masthead and the You page. */
    });
    return button;
  }

  function paintShelf() {
    const host = document.getElementById(SHELF_ID);
    if (!host || !window.YomuProgress || !window.YomuBadges) return;
    register();
    const state = window.YomuProgress.get();
    const equippedId = state.equippedBadgeId || '';

    const rows = [...milestoneRows(state), ...affinityRows(state)];
    const earned = rows.filter((r) => r.earned);
    const locked = rows.filter((r) => !r.earned);
    /* An adopted badge -- chosen on another device -- is equipped without
       being in this device's earned list. It still gets drawn, and first. */
    if (equippedId && !rows.some((r) => r.id === equippedId) && parse(equippedId)) {
      earned.unshift({ id: equippedId, earned: true, kind: 'adopted', how: 'Chosen on another device' });
    }

    host.textContent = '';

    const head = document.createElement('div');
    head.className = 'ysh-head';
    const strong = document.createElement('strong');
    strong.textContent = equippedId && title(equippedId)
      ? 'Wearing ' + title(equippedId)
      : (earned.length ? 'Tap a badge to wear it' : 'Nothing earned yet');
    head.append(strong);
    if (equippedId) {
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'ysh-off';
      off.textContent = 'Take off';
      off.addEventListener('click', () => { window.YomuProgress.equipBadge(null); note = 'Taken off.'; });
      head.append(off);
    }
    host.append(head);

    const grid = document.createElement('div');
    grid.className = 'ysh-grid';
    for (const row of earned) grid.append(badgeButton(row, equippedId));
    for (const row of locked) grid.append(badgeButton(row, equippedId));
    host.append(grid);

    const small = document.createElement('p');
    small.className = 'ysh-note';
    small.textContent = note || (earned.length
      ? `${earned.length} earned. Locked ones say how to get them.`
      : 'Badges come from the mileage road and from what you read. Ten chapters is the first.');
    host.append(small);
  }

  /* --- the sticker shelf -------------------------------------------------- */

  let stickerNote = '';

  function paintStickers() {
    const host = document.getElementById(STICKERS_ID);
    if (!host || !window.YomuProgress || !window.YomuStickers) return;
    const rows = window.YomuProgress.stickers();
    host.textContent = '';

    const strip = document.createElement('div');
    strip.className = 'ysh-stickers';
    for (const row of rows) {
      const info = window.YomuStickers.info(row.id);
      if (!info) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ysh-sticker' + (row.earned ? '' : ' is-locked');
      button.setAttribute('aria-label', info.title + (row.earned ? '' : ', not earned yet'));
      button.append(window.YomuStickers.el(row.id, { size: 52, locked: !row.earned }));
      button.addEventListener('click', () => {
        stickerNote = info.title + ' · ' + (row.earned ? 'earned. ' : '') + info.hint + '.';
        paintStickers();
      });
      strip.append(button);
    }
    host.append(strip);

    const earned = rows.filter((r) => r.earned).length;
    const small = document.createElement('p');
    small.className = 'ysh-note';
    small.textContent = stickerNote || (earned
      ? `${earned} of ${rows.length}. Stickers are how you react to your circle's comments.`
      : 'Stickers are how you react in your circle, and they come from reading. Five chapters is the first.');
    host.append(small);
  }

  /* --- boot -------------------------------------------------------------- */

  const api = { parse, title, el, artFor, register, families: MILESTONE_FAMILIES, repaint() { paintShelf(); paintStickers(); paintMasthead(); } };

  if (typeof window !== 'undefined') window.YomuShelf = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MILESTONE_FAMILIES, parse, ROMAN };
  }

  if (browser) {
    const pass = () => { register(); paintMasthead(); };
    const settle = () => { paintShelf(); paintStickers(); };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { pass(); settle(); });
    } else { pass(); settle(); }

    /* The masthead is React's and is rebuilt on every route; the shelf is
       ours and is drawn once per state change. Only the first needs the
       observer, and it is cheap: one querySelector when nothing is there. */
    new MutationObserver(pass).observe(document.documentElement, { childList: true, subtree: true });
    addEventListener('yomu:progress', () => { pass(); settle(); });
    addEventListener('yomu:reward', () => { pass(); settle(); });
  }
})();
