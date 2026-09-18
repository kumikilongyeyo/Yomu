/**
 * Mori — the reading companion.
 *
 * Mori is the character. The sprite underneath is not Mori; it is one of five
 * borrowed prototype skins standing in until Yomu's own art exists, and the
 * product copy never says their names. Swapping in real art later is a change
 * to CATALOG and the files it points at, and touches nothing else here.
 *
 * Three rules the rest of this file exists to keep:
 *
 * **The overlay must not eat the page.** A fixed full-viewport layer is the
 * obvious way to let a pet roam and the reason overlay pets get uninstalled:
 * every tap on the page behind it dies. The container is `pointer-events:
 * none` and only the pet and its bubble turn them back on, so a click one
 * pixel outside Mori reaches the reader.
 *
 * **The reader is not a stage.** Mori is hidden while you are reading and
 * gets exactly one celebration when a chapter finishes, then collapses. No
 * greeting, no ambient movement, nothing that competes with a page turn.
 *
 * **Animation is not React's problem.** One rAF loop drives a background
 * position; no state update per frame, no re-render. The loop stops dead when
 * the tab is hidden and never starts when the reader asks for reduced motion.
 */
(() => {
  'use strict';

  const PREFS_KEY = 'yomu.v1.pet';
  const ROOT_ID = 'yomu-pet';

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* This file is imported by its tests, where there is no window at all, and
     a bare addEventListener at module scope throws before a single assertion
     runs. Everything browser-side goes through these two. */
  const browser = typeof document !== 'undefined';
  const on = (type, fn, opts) => { if (browser) addEventListener(type, fn, opts); };
  const every = (ms, fn) => { if (browser) setInterval(fn, ms); };

  /* --- the catalog ------------------------------------------------------- *
   *
   * Five skins, one atlas contract, so there is one renderer rather than five
   * code paths. Every sheet is 8 columns by 9 rows of 192x208 cells; the rows
   * are fixed by the format the art was drawn to.
   *
   * The product's states are not these rows. `STATES` maps what Yomu means
   * onto what the borrowed art can do, which is the whole reason a temporary
   * skin can be swapped for real art without touching behaviour: when Mori
   * gets a real sleep animation, `sleeping` stops pointing at `waiting` and
   * nothing else changes.
   */

  const ATLAS = {
    columns: 8,
    rows: 9,
    cellWidth: 192,
    cellHeight: 208,
    animations: {
      idle: { row: 0, frames: 6, ms: 160 },
      'running-right': { row: 1, frames: 8, ms: 90 },
      'running-left': { row: 2, frames: 8, ms: 90 },
      waving: { row: 3, frames: 4, ms: 140 },
      jumping: { row: 4, frames: 5, ms: 110 },
      failed: { row: 5, frames: 8, ms: 130 },
      waiting: { row: 6, frames: 6, ms: 260 },
      running: { row: 7, frames: 6, ms: 100 },
      review: { row: 8, frames: 6, ms: 180 },
    },
  };

  const CATALOG = [
    { id: 'boba', name: 'Boba', src: '/pets/prototype/boba.webp' },
    { id: 'bolt', name: 'Bolt', src: '/pets/prototype/bolt.webp' },
    { id: 'miso', name: 'Miso', src: '/pets/prototype/miso.webp' },
    { id: 'nukey', name: 'Nukey', src: '/pets/prototype/nukey.webp' },
    { id: 'noir-webling', name: 'Noir', src: '/pets/prototype/noir-webling.webp' },
  ];

  /** Product state -> the atlas row that can currently play it. */
  const STATES = {
    idle: 'idle',
    greeting: 'waving',
    happy: 'waving',
    celebrating: 'jumping',
    sleeping: 'waiting',
    walkingLeft: 'running-left',
    walkingRight: 'running-right',
    thinking: 'review',
    busy: 'running',
    error: 'failed',
    dragging: 'jumping',
  };

  /**
   * Which state wins when two want the pet at once.
   *
   * A milestone landing during an idle wander must not be swallowed by the
   * wander, and an ambient animation must never cut a reward short. Higher
   * number wins; equal numbers mean the newer one replaces the older.
   */
  const PRIORITY = {
    idle: 0, sleeping: 0, walkingLeft: 0, walkingRight: 0,
    greeting: 1,
    happy: 2,
    thinking: 3, error: 3, busy: 3,
    celebrating: 4,
    dragging: 5,
  };

  const SIZES = { small: 72, medium: 98, large: 132 };

  /* --- preferences ------------------------------------------------------- *
   * Presentation only. Nothing here is reward truth; that is the progression
   * store's business and mixing them is how a cleared cosmetic wipes a badge.
   */

  const DEFAULTS = {
    selectedPetId: 'boba',
    position: null,
    minimized: false,
    muted: false,
    size: 'medium',
    enabled: true,
  };

  let prefs = { ...DEFAULTS, ...(readJSON(PREFS_KEY, {}) || {}) };
  if (!CATALOG.some((p) => p.id === prefs.selectedPetId)) prefs.selectedPetId = DEFAULTS.selectedPetId;

  function setPrefs(patch) {
    prefs = { ...prefs, ...patch };
    writeJSON(PREFS_KEY, prefs);
    dispatchEvent(new CustomEvent('yomu:pet-prefs', { detail: { ...prefs } }));
  }

  /* --- surface policy ---------------------------------------------------- *
   *
   * Straight out of the mockup's table. One function, so a new screen cannot
   * quietly inherit "roams and talks" by default.
   */

  function surface() {
    const path = location.pathname;
    if (path.startsWith('/read/')) return 'reader';
    if (path.startsWith('/library')) return 'library';
    if (path.startsWith('/you')) return 'you';
    if (path.startsWith('/sources') || path.startsWith('/add-sources')) return 'sources';
    if (path.startsWith('/discover') || path.startsWith('/search') || path.startsWith('/find')) return 'discover';
    if (path.startsWith('/series/')) return 'series';
    if (path === '/' || path.startsWith('/index')) return 'home';
    return 'other';
  }

  /**
   * `other` is hidden, and that is the point of the table.
   *
   * Every page in dist-app now loads this file, which includes the redeem
   * page, the adult gate, the benchmark and the UI kit. A default of visible
   * would put a companion on all of them, and the first anyone would hear of
   * it is someone asking why a cartoon otter is on the age gate. A new screen
   * appears here deliberately or it does not get Mori.
   */
  const POLICY = {
    home:     { visible: true,  roam: true,  greet: true,  bubbles: true,  drag: true },
    library:  { visible: true,  roam: false, greet: true,  bubbles: true,  drag: true },
    discover: { visible: true,  roam: false, greet: true,  bubbles: true,  drag: true },
    series:   { visible: true,  roam: false, greet: false, bubbles: true,  drag: true },
    reader:   { visible: false, roam: false, greet: false, bubbles: false, drag: false },
    you:      { visible: false, roam: false, greet: false, bubbles: false, drag: false },
    sources:  { visible: true,  roam: false, greet: false, bubbles: true,  drag: true },
    other:    { visible: false, roam: false, greet: false, bubbles: false, drag: false },
  };

  /**
   * You renders its own full-size Mori inside the page, so the floating one
   * stands down there rather than appearing twice.
   *
   * `reprieve` is the one exception: a chapter finishing in the reader earns
   * a single celebration on a surface whose standing answer is "not here".
   * It is a flag rather than a mutation of POLICY because the old version
   * flipped POLICY.reader back before the bubble was spoken, so the
   * celebration mounted a pet that then refused to say anything.
   */
  let reprieve = false;

  const policy = () => {
    const found = POLICY[surface()] || POLICY.other;
    if (reprieve) return { ...found, visible: true, bubbles: true };
    return found;
  };

  const reduced = () =>
    matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- the sprite -------------------------------------------------------- *
   *
   * A div with the sheet as its background, scaled so one cell fills it, and
   * a rAF loop that moves background-position. No canvas, no per-frame React
   * state, no layout thrash -- background-position and transform are the two
   * things a compositor can do without touching the page.
   */

  function makeSprite(size) {
    const node = document.createElement('div');
    node.className = 'yp-sprite';
    apply(node, size);
    return node;
  }

  function apply(node, size) {
    const scale = size / ATLAS.cellWidth;
    const pet = CATALOG.find((p) => p.id === prefs.selectedPetId) || CATALOG[0];
    node.style.width = size + 'px';
    node.style.height = Math.round(ATLAS.cellHeight * scale) + 'px';
    node.style.backgroundImage = `url("${pet.src}")`;
    node.style.backgroundSize =
      `${ATLAS.columns * size}px ${Math.round(ATLAS.rows * ATLAS.cellHeight * scale)}px`;
    node.style.imageRendering = 'pixelated';
    node.style.backgroundRepeat = 'no-repeat';
  }

  /**
   * One loop for however many sprites are on screen -- the floating pet and
   * the one the You page draws are the same animation, and two timers would
   * drift apart visibly.
   */
  const players = new Set();
  let raf = 0;

  function frameStep(now) {
    raf = 0;
    let wants = false;
    for (const player of players) {
      const animation = ATLAS.animations[STATES[player.state] || 'idle'];
      if (!animation) continue;

      /* Reduced motion holds frame zero. The pet is still there and still
         changes pose between states; it just does not flip frames. */
      if (reduced()) {
        paint(player, animation, 0);
        continue;
      }
      wants = true;
      if (now - player.at >= animation.ms) {
        player.at = now;
        player.frame = (player.frame + 1) % animation.frames;
        paint(player, animation, player.frame);
      }
    }
    if (wants && !document.hidden && players.size) raf = requestAnimationFrame(frameStep);
  }

  function paint(player, animation, frame) {
    const size = SIZES[prefs.size] || SIZES.medium;
    const scale = size / ATLAS.cellWidth;
    player.node.style.backgroundPosition =
      `${-frame * size}px ${-Math.round(animation.row * ATLAS.cellHeight * scale)}px`;
  }

  /**
   * Put every sprite on the first frame of its current state, now, without
   * waiting for the loop.
   *
   * The loop does not run when the tab is hidden or when the reader asked for
   * reduced motion, and a pose is not motion. Without this a pet that mounts
   * in a background tab sits on whatever cell the stylesheet left it at --
   * which is cell 0,0, so idle looks right by luck and every other state is
   * silently the wrong animation until the tab is looked at.
   */
  function pose() {
    for (const player of players) {
      const animation = ATLAS.animations[STATES[player.state] || 'idle'];
      if (animation) paint(player, animation, player.frame || 0);
    }
  }

  function start() {
    pose();
    if (raf || document.hidden || !players.size) return;
    raf = requestAnimationFrame(frameStep);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  /* The whole point of the hidden-tab rule: a background tab animating a
     sprite is a battery cost with no viewer.
     Guarded because this file is also imported by its tests, where there is
     no window and a bare addEventListener throws on load. */
  on('visibilitychange', () => (document.hidden ? stop() : start()));

  /* --- the state machine ------------------------------------------------- */

  const pet = { node: null, state: 'idle', frame: 0, at: 0 };
  let revertTimer = 0;

  /**
   * @param hold ms to stay in this state before falling back to idle.
   *   A transient state that outranks what is playing replaces it; one that
   *   does not is dropped rather than queued, because a queue means a
   *   celebration arriving four taps deep plays four seconds late.
   */
  function setState(next, hold) {
    if (PRIORITY[next] < PRIORITY[pet.state] && revertTimer) return;
    pet.state = next;
    pet.frame = 0;
    pet.at = 0;
    clearTimeout(revertTimer);
    revertTimer = 0;
    if (hold) {
      revertTimer = setTimeout(() => {
        revertTimer = 0;
        pet.state = 'idle';
        pet.frame = 0;
        /* Repaint on the way back, not just on the way in. The running loop
           would pick this up next frame -- but under reduced motion the loop
           stops after one pass, so without this the pet holds the
           celebration pose for the rest of the session. */
        start();
      }, hold);
    }
    start();
  }

  /* --- the bubble -------------------------------------------------------- */

  let bubbleTimer = 0;

  /**
   * @returns whether the line actually reached the screen. Callers that hold
   *   a rate limit need to know: the greeting cooldown used to be stamped by
   *   whoever chose the line, so a greeting picked before the pet had
   *   mounted burned the next half hour and showed nothing.
   */
  function say(text, ms) {
    if (!text || prefs.muted || !policy().bubbles || prefs.minimized) return false;
    const root = document.getElementById(ROOT_ID);
    if (!root) return false;
    let bubble = root.querySelector('.yp-bubble');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'yp-bubble';
      /* Polite, not assertive: Mori is never urgent enough to interrupt what
         a screen reader is already saying. */
      bubble.setAttribute('aria-live', 'polite');
      root.appendChild(bubble);
    }
    bubble.textContent = text;
    bubble.classList.add('is-on');

    /* Flip to the other side when the pet is close enough to the left edge
       that a bubble anchored left would run off it. */
    const box = root.getBoundingClientRect();
    bubble.classList.toggle('yp-bubble--right', box.left < 180);

    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('is-on'), ms || 4200);
    return true;
  }

  const hush = () => {
    clearTimeout(bubbleTimer);
    document.getElementById(ROOT_ID)?.querySelector('.yp-bubble')?.classList.remove('is-on');
  };

  /* --- placement --------------------------------------------------------- */

  function place(root) {
    const size = SIZES[prefs.size] || SIZES.medium;
    const height = Math.round(ATLAS.cellHeight * (size / ATLAS.cellWidth));
    const spot = prefs.position;
    if (spot) {
      /* Clamped on read, not only on write: a position saved on a desktop is
         off-screen on a phone, and a pet you cannot reach cannot be moved
         back. */
      root.style.left = clamp(spot.x, 0, Math.max(0, innerWidth - size)) + 'px';
      root.style.top = clamp(spot.y, 0, Math.max(0, innerHeight - height)) + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    } else {
      root.style.left = 'auto';
      root.style.top = 'auto';
      root.style.right = '20px';
      /* Above the floating dock, which is 76px plus the safe area. */
      root.style.bottom = 'calc(104px + env(safe-area-inset-bottom))';
    }
  }

  /* --- mounting ---------------------------------------------------------- */

  function mount() {
    if (!prefs.enabled || !policy().visible) {
      document.getElementById(ROOT_ID)?.remove();
      players.delete(pet);
      pet.node = null;
      return;
    }
    if (document.getElementById(ROOT_ID)) return;

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'yp-root';
    root.dataset.size = prefs.size;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'yp-pet';
    button.setAttribute('aria-label', 'Mori, your reading companion');

    const sprite = makeSprite(SIZES[prefs.size] || SIZES.medium);
    button.appendChild(sprite);
    root.appendChild(button);

    const puck = document.createElement('button');
    puck.type = 'button';
    puck.className = 'yp-puck';
    puck.setAttribute('aria-label', prefs.minimized ? 'Show Mori' : 'Hide Mori');
    puck.textContent = prefs.minimized ? '+' : '–';
    puck.addEventListener('click', (event) => {
      event.stopPropagation();
      setPrefs({ minimized: !prefs.minimized });
      hush();
      refresh();
    });
    root.appendChild(puck);

    document.body.appendChild(root);
    pet.node = sprite;
    players.add(pet);

    root.classList.toggle('is-min', prefs.minimized);
    place(root);
    wireDrag(root, button);

    button.addEventListener('click', () => {
      if (dragged) return;
      setState('happy', 1600);
      const line = window.YomuGreetings?.line?.('tap');
      if (line) say(line);
    });

    start();
  }

  /* --- dragging ---------------------------------------------------------- *
   *
   * Pointer events, captured on the pet itself. No physics: a companion that
   * can be flung across a page you are reading is a toy, and the flag below
   * is where that would go if it is ever wanted.
   */

  const petPhysicsEnabled = false;
  let dragged = false;

  function wireDrag(root, handle) {
    let startX = 0, startY = 0, baseX = 0, baseY = 0, active = false;

    handle.addEventListener('pointerdown', (event) => {
      if (!policy().drag || prefs.minimized) return;
      active = true;
      dragged = false;
      const box = root.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      baseX = box.left;
      baseY = box.top;
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener('pointermove', (event) => {
      if (!active) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      /* A few pixels of slop, so a tap with a shaky thumb is still a tap. */
      if (!dragged && Math.hypot(dx, dy) < 5) return;
      if (!dragged) {
        dragged = true;
        setState('dragging');
        hush();
      }
      const size = SIZES[prefs.size] || SIZES.medium;
      const height = Math.round(ATLAS.cellHeight * (size / ATLAS.cellWidth));
      root.style.left = clamp(baseX + dx, 0, innerWidth - size) + 'px';
      root.style.top = clamp(baseY + dy, 0, innerHeight - height) + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    });

    const release = (event) => {
      if (!active) return;
      active = false;
      try { handle.releasePointerCapture(event.pointerId); } catch {}
      if (dragged) {
        const box = root.getBoundingClientRect();
        setPrefs({ position: { x: Math.round(box.left), y: Math.round(box.top) } });
        setState('idle');
        /* Cleared on the next frame, so the click that follows this pointerup
           is the one suppressed and the one after it is not. */
        setTimeout(() => { dragged = false; }, 0);
      }
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
  }

  /** Re-place and re-skin in situ rather than tearing the node down. */
  function refresh() {
    const root = document.getElementById(ROOT_ID);
    if (!root) { mount(); return; }
    root.dataset.size = prefs.size;
    root.classList.toggle('is-min', prefs.minimized);
    const puck = root.querySelector('.yp-puck');
    if (puck) {
      puck.textContent = prefs.minimized ? '+' : '–';
      puck.setAttribute('aria-label', prefs.minimized ? 'Show Mori' : 'Hide Mori');
    }
    if (pet.node) apply(pet.node, SIZES[prefs.size] || SIZES.medium);
    place(root);
    start();
  }

  on('resize', () => {
    const root = document.getElementById(ROOT_ID);
    if (root && prefs.position) place(root);
  });

  /* --- reactions --------------------------------------------------------- *
   *
   * The progression engine owns what happened; this only decides how Mori
   * shows it. Both events can arrive together when a chapter completes a
   * milestone -- the reward outranks the chapter, so one animation plays.
   */

  on('yomu:chapter-complete', (event) => {
    const count = event.detail?.count || 1;
    setState('celebrating', 2600);
    if (surface() === 'reader') {
      /* The one thing Mori is allowed to do in the reader, and then it packs
         itself away rather than sitting on the next chapter. */
      showOnce(() => {
        say(window.YomuGreetings?.line?.('chapter_complete') || 'Chapter down.', 3200);
      }, 3800);
      return;
    }
    const line = window.YomuGreetings?.line?.('chapter_complete', { count });
    if (line) say(line);
  });

  on('yomu:reward', (event) => {
    setState('celebrating', 3400);
    const title = event.detail?.title || '';
    const line = window.YomuGreetings?.line?.('milestone', { title })
      || (title ? title + '. That is a real number.' : null);
    toast(event.detail);
    if (surface() === 'reader') {
      showOnce(() => say(line, 4200));
      return;
    }
    say(line, 4200);
  });

  /**
   * The unlock toast.
   *
   * Outside the overlay root on purpose: the overlay is pointer-transparent
   * and is removed on surfaces that hide Mori, and a milestone earned in the
   * reader still deserves to be told. It also carries the badge itself when
   * one was earned, rendered live so it follows the theme.
   */
  let toastTimer = 0;

  function toast(detail) {
    if (!detail) return;
    const rewards = detail.rewards || [];
    let node = document.getElementById('yomu-pet-toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'yomu-pet-toast';
      node.className = 'yp-toast';
      node.setAttribute('role', 'status');
      document.body.appendChild(node);
    }
    node.textContent = '';

    const badge = rewards.find((r) => r.type === 'badge');
    if (badge && window.YomuBadges) {
      const [slug, tier] = String(badge.id).split(':');
      /* Only the affinity badges are families the renderer knows; the two
         roadmap badges are plain ids and simply have no art yet. */
      if (slug && tier && window.YomuBadges.list().some((f) => f.slug === slug)) {
        node.append(window.YomuBadges.el(slug, Number(tier), { variant: 'micro', size: 30 }));
      }
    }

    const copy = document.createElement('div');
    const kicker = document.createElement('span');
    kicker.className = 'yp-toast__kicker';
    kicker.textContent = rewards.some((r) => r.type === 'pet-unlock') ? 'Pet unlocked' : 'Unlocked';
    copy.append(kicker, document.createTextNode(detail.title || 'Milestone reached'));
    node.append(copy);

    requestAnimationFrame(() => node.classList.add('is-on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('is-on'), 4600);
  }

  /**
   * Put Mori on screen in a surface that normally hides it, just this once.
   *
   * The reprieve stays up for the whole celebration, including the bubble and
   * the collapse that follows, and is only dropped at the end -- otherwise
   * the MutationObserver sees a pet on a surface that says "not visible" and
   * removes it mid-sentence.
   */
  function showOnce(then, ms) {
    reprieve = true;
    mount();
    const root = document.getElementById(ROOT_ID);
    if (root) then();
    clearTimeout(showOnce.timer);
    showOnce.timer = setTimeout(() => {
      reprieve = false;
      if (!policy().visible) {
        document.getElementById(ROOT_ID)?.remove();
        players.delete(pet);
      }
    }, ms || 4200);
  }

  /* --- idle behaviour ---------------------------------------------------- */

  let lastActivity = Date.now();
  for (const type of ['pointerdown', 'keydown', 'scroll']) {
    on(type, () => {
      const was = Date.now() - lastActivity > 5 * 60000;
      lastActivity = Date.now();
      if (was && pet.state === 'sleeping') setState('idle');
    }, { passive: true });
  }

  every(30000, () => {
    if (!pet.node || revertTimer) return;
    if (Date.now() - lastActivity > 5 * 60000) {
      if (pet.state !== 'sleeping') setState('sleeping');
    }
  });

  /* --- public shape ------------------------------------------------------ */

  const api = {
    catalog: () => CATALOG.slice(),
    atlas: () => ATLAS,
    prefs: () => ({ ...prefs }),
    set: setPrefs,
    select(id) {
      if (!CATALOG.some((p) => p.id === id)) return false;
      setPrefs({ selectedPetId: id });
      refresh();
      return true;
    },
    say,
    state: () => pet.state,
    setState,
    surface,
    policy,
    /** A sprite the You page and the picker can own, sharing the one loop. */
    sprite(size, state) {
      const node = makeSprite(size || 98);
      const player = { node, state: state || 'idle', frame: 0, at: 0 };
      players.add(player);
      start();
      return {
        node,
        set: (next) => { player.state = next; player.frame = 0; },
        skin: (id) => {
          const found = CATALOG.find((p) => p.id === id);
          if (!found) return;
          const scale = (size || 98) / ATLAS.cellWidth;
          node.style.backgroundImage = `url("${found.src}")`;
          node.style.backgroundSize =
            `${ATLAS.columns * (size || 98)}px ${Math.round(ATLAS.rows * ATLAS.cellHeight * scale)}px`;
        },
        stop: () => players.delete(player),
      };
    },
    refresh,
    petPhysicsEnabled,
  };

  if (typeof window !== 'undefined') window.YomuPet = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ATLAS, CATALOG, STATES, PRIORITY, SIZES, POLICY };
  }

  /* --- boot -------------------------------------------------------------- */

  if (typeof document !== 'undefined') {
    const pass = () => { mount(); refresh(); };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', pass);
    else pass();

    /* React discards nodes it does not own, so the mount is re-asserted --
       but only the existence of the root, never its position, which the
       person may have dragged and another observer must not fight over. */
    const settle = () => {
      if (!prefs.enabled || !policy().visible) {
        document.getElementById(ROOT_ID)?.remove();
        players.delete(pet);
        return;
      }
      if (!document.getElementById(ROOT_ID)) mount();
    };

    new MutationObserver(settle)
      .observe(document.documentElement, { childList: true, subtree: true });

    /* The app navigates with pushState, which fires no event, and a static
       page does not mutate afterwards -- so without this the observer never
       runs and Mori stays on screen all the way into the reader. Leaving
       this to yomu-progress.js, which wraps the same two methods for its own
       reasons, would make the pet depend on another file's side effect. */
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        setTimeout(() => { pass(); settle(); }, 0);
        return result;
      };
    }

    for (const type of ['popstate', 'hashchange']) {
      addEventListener(type, () => { pass(); settle(); });
    }
  }
})();
