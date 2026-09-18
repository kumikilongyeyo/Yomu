/**
 * The end of a chapter, when something is nearly earned.
 *
 * A chapter finishes and the reader is three away from Century, or eight
 * chapters short of the next Tower Climber tier. That is the one moment the
 * number means something, and until now it was spent silently: the counters
 * moved, the You page knew, and the person actually reading found out days
 * later.
 *
 * So: a small composition at the bottom centre of the reader, for about
 * three seconds. Mori, a line from Mori, and one bar that visibly travels
 * from where the count was to where it is now. Then it leaves.
 *
 * Three rules it keeps.
 *
 *   **Only when it is close.** Chapter 51 of 100 gets nothing. An overlay
 *   that appears after every chapter is furniture, and furniture is ignored;
 *   the window is what makes it worth looking at. NEAR_CHAPTERS, or a tenth
 *   of the way out for the big round numbers where three chapters is noise.
 *
 *   **It owns the reader-end moment, alone.** yomu-pet.js already had a
 *   reader reprieve for `yomu:chapter-complete`, and a reward toast on top of
 *   that. Two of them at once is the "duplicate toast + overlay + ceremony"
 *   failure, so pet.js asks `YomuChapterEnd.owns()` and stands down while
 *   this is up. Nothing else changes: outside the reader Mori speaks exactly
 *   as it did.
 *
 *   **Nothing here is truth.** Every number is read from YomuProgress and
 *   YomuMileage at the moment of drawing. There is no counter in this file,
 *   no milestone table, and no store.
 *
 * Mori's saved position is never touched. The sprite is its own, borrowed
 * from `YomuPet.sprite()` so it shares the one animation loop, and the real
 * Mori stays wherever the reader put it.
 */
(() => {
  'use strict';

  const ROOT_ID = 'yomu-chapter-end';
  const browser = typeof document !== 'undefined';

  /** How close counts as close. */
  const NEAR_CHAPTERS = 3;
  /** ...or this much of the way, for thresholds where three is nothing. */
  const NEAR_FRACTION = 0.1;

  /* The beats, in ms. Travel is the bar; hold is how long the finished state
     sits there; leave is the fade. Total is inside the 2.5-3.5s the spec
     asks for, and a reward beat holds longer because there is more to look
     at. */
  const TRAVEL = 760;
  const HOLD = 1500;
  const HOLD_REWARD = 2400;
  const LEAVE = 380;

  const reduced = () => browser && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  /* The tests load this file into a bare realm, so every global is reached
     through one guarded handle rather than `window.` at each site. */
  const W = typeof window !== 'undefined' ? window : {};
  const P = () => W.YomuProgress;
  const M = () => W.YomuMileage;

  const inReader = () => browser && location.pathname.startsWith('/read/');

  /* --- what is worth showing --------------------------------------------- *
   *
   * Pure, given the two engines' snapshots, so the window can be tested
   * without a DOM. Returns the nearest thing within the window, or null --
   * and null is the common answer, which is the point.
   */

  /** Is `remaining` close enough to `threshold` to be worth interrupting for? */
  function isNear(remaining, threshold) {
    if (!(remaining > 0)) return false;
    return remaining <= NEAR_CHAPTERS || remaining <= Math.ceil(threshold * NEAR_FRACTION);
  }

  /**
   * @param roadmap  YomuProgress.roadmap()
   * @param close    YomuMileage.closeToEarning(n)
   * @param gained   chapters finished in this pulse, so the bar can start
   *                 from where the count was rather than from zero.
   */
  function choose(roadmap, close, gained) {
    const step = Math.max(1, Number(gained) || 1);

    /* The chapter road first: it is the thing the reader is actually
       counting, and a family tier is a quieter kind of progress. */
    const stop = (roadmap || [])
      .filter((row) => !row.collected && isNear(row.remaining, row.threshold))
      .sort((a, b) => a.remaining - b.remaining)[0];
    if (stop) {
      const count = stop.threshold - stop.remaining;
      const badge = (stop.rewards || []).find((r) => r.type === 'badge');
      return {
        kind: 'milestone',
        id: stop.id,
        badgeId: badge ? badge.id : null,
        label: stop.title,
        kicker: 'Chapter milestone',
        count,
        from: Math.max(0, count - step),
        goal: stop.threshold,
        floor: 0,
        remaining: stop.remaining,
      };
    }

    const row = (close || []).filter((r) => r.nextAt && isNear(r.remaining, r.nextAt))[0];
    if (row) {
      return {
        kind: 'tier',
        id: row.family + ':' + (row.tier + 1),
        badgeId: row.family + ':' + (row.tier + 1),
        label: familyTitle(row.family),
        kicker: 'Family badge',
        count: row.count,
        from: Math.max(0, row.count - step),
        goal: row.nextAt,
        floor: tierFloor(row.tier),
        remaining: row.remaining,
        family: row.family,
        tier: row.tier,
      };
    }
    return null;
  }

  /**
   * Where this tier started, so a bar for the 100..250 tier does not read as
   * nearly full the moment it opens. The engine's own TIERS, never a copy.
   */
  function tierFloor(tier) {
    const tiers = M()?.TIERS;
    if (!Array.isArray(tiers) || !tier) return 0;
    return tiers[tier - 1] || 0;
  }

  const familyTitle = (slug) => W.YomuBadges?.families?.[slug]?.title || slug;

  /** 0..100 for a count inside [floor, goal]. */
  function pct(count, floor, goal) {
    const span = goal - floor;
    if (!(span > 0)) return 100;
    return Math.max(0, Math.min(100, ((count - floor) / span) * 100));
  }

  /* --- the composition ---------------------------------------------------- */

  let sprite = null;
  let timers = [];
  let showing = false;

  const clearTimers = () => { for (const t of timers) clearTimeout(t); timers = []; };
  const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };

  function teardown() {
    clearTimers();
    showing = false;
    try { sprite?.stop(); } catch {}
    sprite = null;
    document.getElementById(ROOT_ID)?.remove();
  }

  /** Mori's own sprite, sharing the pet's loop, owing nothing to its position. */
  function moriNode(state) {
    const pet = W.YomuPet;
    if (!pet?.sprite) return null;
    try {
      sprite = pet.sprite(76, state || 'idle');
      const id = pet.prefs?.().selectedPetId;
      if (id && sprite.skin) sprite.skin(id);
      return sprite.node;
    } catch { return null; }
  }

  function badgeNode(pick, size) {
    const id = pick.badgeId;
    if (!id) return null;
    try {
      if (W.YomuShelf?.el) return W.YomuShelf.el(id, { variant: 'locked', size });
      if (pick.kind === 'tier' && W.YomuBadges?.el) {
        return W.YomuBadges.el(pick.family, pick.tier + 1, { variant: 'locked', size });
      }
    } catch {}
    return null;
  }

  /** Mori's line for this moment, from the one pool file that owns its voice. */
  function lineFor(pick, reward) {
    const G = W.YomuGreetings;
    if (reward) {
      return G?.line?.('milestone', { title: reward.title || pick.label })
        || (pick.label + '. That is a real number.');
    }
    if (pick.kind === 'tier') {
      return G?.line?.('near_tier', { left: pick.remaining, family: pick.label })
        || (pick.remaining + ' to go.');
    }
    return G?.line?.('near_milestone', { left: pick.remaining, title: pick.label })
      || ('Close now. ' + pick.remaining + ' to go.');
  }

  /**
   * Draw it.
   *
   * `reward` is set when the threshold was actually crossed in this pulse --
   * the bar lands full, the card lights, the badge turns from locked art to
   * earned, and the burst plays once.
   */
  function show(pick, reward) {
    if (!browser) return false;
    teardown();

    const root = el('div', 'ych');
    root.id = ROOT_ID;
    /* Announced, not focused, and never in the way of the page: the reader's
       own next-chapter control sits under this and has to stay reachable. */
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');

    const mori = el('div', 'ych__mori');
    const node = moriNode(reward ? 'celebrating' : 'happy');
    if (node) mori.append(node);
    else mori.hidden = true;

    const stack = el('div', 'ych__stack');

    const bubble = el('div', 'ych__bubble');
    bubble.append(el('span', 'ych__says', lineFor(pick, reward)));
    stack.append(bubble);

    const card = el('div', 'ych__card' + (reward ? ' is-reward' : ''));
    const art = badgeNode(pick, 40);
    if (art) {
      const holder = el('div', 'ych__badge' + (reward ? ' is-earned' : ''));
      holder.setAttribute('aria-hidden', 'true');
      holder.append(art);
      card.append(holder);
    }

    const copy = el('div', 'ych__copy');
    copy.append(el('span', 'ych__kicker', reward ? 'Earned' : pick.kicker));
    copy.append(el('b', 'ych__label', pick.label));

    const bar = el('div', 'ych__bar');
    const fill = el('i', 'ych__fill');
    const sheen = el('span', 'ych__sheen');
    bar.append(fill, sheen);
    copy.append(bar);

    const foot = el('small', 'ych__left');
    copy.append(foot);
    card.append(copy);
    stack.append(card);

    root.append(mori, stack);
    document.body.append(root);

    /* The travel. Start at where the count was, then hand the browser one
       width change -- the transition is in CSS so a reduced-motion reader
       gets the end state and no journey. */
    const from = pct(pick.from, pick.floor, pick.goal);
    const to = reward ? 100 : pct(pick.count, pick.floor, pick.goal);
    fill.style.setProperty('--p', from.toFixed(2) + '%');
    foot.textContent = countLine(pick, pick.from, reward);

    const quiet = reduced();
    showing = true;

    /* Two frames, not one: the first commits the starting width, the second
       changes it. Done on a timer rather than rAF because a background tab
       never gets a frame and the whole beat would sit at 0%. */
    later(() => {
      root.classList.add('is-on');
      fill.style.setProperty('--p', to.toFixed(2) + '%');
      if (!quiet) sheen.classList.add('is-running');
      countUp(foot, pick, reward, quiet);
    }, 40);

    const hold = reward ? HOLD_REWARD : HOLD;
    if (reward && !quiet) later(() => burst(root), TRAVEL - 120);

    later(() => {
      root.classList.remove('is-on');
      root.classList.add('is-off');
      later(teardown, LEAVE + 60);
    }, 40 + TRAVEL + hold);

    return true;
  }

  const countLine = (pick, at, reward) => {
    if (reward) return pick.kind === 'tier' ? pick.goal + ' chapters' : pick.goal + ' chapters read';
    return at + ' of ' + pick.goal + ' · ' + Math.max(0, pick.goal - at) + ' to go';
  };

  /** The number walks up with the bar. Timer-driven, for the same reason. */
  function countUp(node, pick, reward, quiet) {
    const to = reward ? pick.goal : pick.count;
    if (quiet || to <= pick.from) { node.textContent = countLine(pick, to, reward); return; }
    const started = Date.now();
    const step = () => {
      const t = Math.min(1, (Date.now() - started) / TRAVEL);
      const at = Math.round(pick.from + (to - pick.from) * (1 - Math.pow(1 - t, 3)));
      node.textContent = countLine(pick, at, reward);
      if (t < 1 && showing) later(step, 60);
    };
    later(step, 60);
  }

  /** The reward burst. Reuses the one the streak card already draws. */
  function burst(root) {
    if (reduced()) return;
    const anchor = root.querySelector('.ych__badge') || root;
    if (W.YomuStreakUI?.confetti) { W.YomuStreakUI.confetti(anchor); return; }
    root.classList.add('is-pop');
  }

  /* --- when ---------------------------------------------------------------- *
   *
   * `yomu:chapter-complete` fires on the route change that ends a chapter --
   * including reader to next chapter, which is what "the end of a chapter"
   * means in this app. `yomu:reward` arrives in the same pulse when the
   * threshold was crossed, so the two are merged inside one tick and only
   * the stronger of them is drawn.
   */

  let pendingReward = null;
  let merge = 0;

  function present(gained) {
    if (!inReader()) return false;
    if (!P()?.roadmap) return false;

    const reward = pendingReward;
    pendingReward = null;

    /* A quiet reward is the stage-badge case, which yomu-ceremony.js is
       already making an occasion of. Not ours. */
    if (reward && reward.quiet) return false;

    const roadmap = P().roadmap();
    const close = M()?.closeToEarning ? M().closeToEarning(3) : [];

    if (reward) {
      /* The crossed stop, found by the id the event carries, so the bar is
         the one that just filled rather than the next one along. */
      const row = roadmap.find((r) => r.id === reward.milestoneId);
      const badge = (reward.rewards || []).find((r) => r.type === 'badge');
      const pick = row
        ? {
            kind: 'milestone', id: row.id, badgeId: badge ? badge.id : null,
            label: row.title, kicker: 'Chapter milestone',
            count: row.threshold, from: Math.max(0, row.threshold - Math.max(1, gained)),
            goal: row.threshold, floor: 0, remaining: 0,
          }
        : {
            kind: 'milestone', id: reward.milestoneId, badgeId: badge ? badge.id : null,
            label: reward.title || 'Milestone', kicker: 'Chapter milestone',
            count: 1, from: 0, goal: 1, floor: 0, remaining: 0,
          };
      return show(pick, reward);
    }

    const pick = choose(roadmap, close, gained);
    if (!pick) return false;
    return show(pick, null);
  }

  /* --- public shape --------------------------------------------------------- */

  const api = {
    /**
     * Whether this file is handling the reader-end moment, so yomu-pet.js can
     * stand its own reprieve down instead of speaking over it.
     *
     * It is asked *about an event*, not about this module's state, and that is
     * the whole point. The first version answered from `pendingReward`, which
     * made the answer depend on whether this file's listener had run before
     * pet.js's -- and that in turn depended on script order in the head, which
     * is historical, differs per page, and is appended to by a deploy workflow.
     * It came out wrong: the reader got the card *and* the pet's unlock toast
     * for one Century. Asked this way the answer is a function of the event
     * alone and the two files cannot disagree however they are loaded.
     *
     * @param kind   'reward' | 'chapter', or nothing for a bare state check
     * @param detail the event's own detail, when there is one
     */
    owns(kind, detail) {
      if (!inReader() || !P()?.roadmap) return false;
      /* A quiet reward is the stage-badge case; yomu-ceremony.js is already
         making an occasion of that one and neither of us should. */
      if (kind === 'reward') return !detail?.quiet;
      if (showing) return true;
      if (pendingReward && !pendingReward.quiet) return true;
      return !!choose(P().roadmap(), M()?.closeToEarning ? M().closeToEarning(3) : [], 1);
    },
    /** Test and debug seam: draw one without reading a chapter. */
    __show: show,
    __choose: choose,
    isNear,
    pct,
    close: teardown,
    NEAR_CHAPTERS,
    NEAR_FRACTION,
  };

  if (typeof window !== 'undefined') window.YomuChapterEnd = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { choose, isNear, pct, NEAR_CHAPTERS, NEAR_FRACTION };
  }

  if (browser) {
    /* Both events come out of one pulse, in either order. They are held for a
       tick and drawn once, so a chapter that crosses a milestone is one beat
       rather than a near-milestone card replaced by a reward card. */
    let pendingGained = 1;

    const flush = () => {
      clearTimeout(merge);
      merge = setTimeout(() => {
        const gained = pendingGained;
        pendingGained = 1;
        present(gained);
      }, 30);
    };

    addEventListener('yomu:reward', (event) => {
      if (!inReader()) return;
      pendingReward = event.detail || null;
      flush();
    });

    addEventListener('yomu:chapter-complete', (event) => {
      if (!inReader()) return;
      pendingGained = Math.max(pendingGained, event.detail?.count || 1);
      flush();
    });

    /* Leaving the reader takes it with us: this is a reader-end moment and
       has no business sitting on the library. */
    addEventListener('popstate', () => { if (!inReader()) teardown(); });
    addEventListener('yomu:pet-surface', () => { if (!inReader()) teardown(); });
  }
})();
