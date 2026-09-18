/**
 * The evolution ceremony — Mori's stage change, made visible.
 *
 * STAGES in yomu-progress.js has five stops and the pet has a celebrating
 * state, and until now a stage change ticked over silently: the number on
 * the You page went up and nothing else happened. The evolution is the
 * emotional core of the pet, so it gets its five seconds.
 *
 * What it does, and the three rules it keeps:
 *
 * **It never replays.** The last stage this device has celebrated is written
 * down before the card is shown. A reader who already has a Sage when this
 * file first loads gets no ceremony for stages that happened last month --
 * the record is seeded from the current stage and only a *change* from
 * there is an occasion.
 *
 * **Not in the reader.** A stage change lands on the pulse that runs when a
 * chapter finishes, which is usually still in the reader. The card waits
 * for the surface to change rather than sitting on top of the next page.
 *
 * **It repaints on the way back.** Under reduced motion the shared sprite
 * loop stops after one pass, so a sprite told to go idle stays posed as
 * whatever it was until something calls start() again. The sprite here is
 * stopped and removed, and the floating pet's own hold does its own revert
 * -- but the You page's companion is repainted explicitly, because that
 * exact bug bit once already.
 */
(() => {
  'use strict';

  const KEY = 'yomu.v1.pet.ceremony';
  const ROOT_ID = 'yomu-ceremony';
  const HOLD_MS = 5600;

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

  const reduced = () => browser && matchMedia('(prefers-reduced-motion: reduce)').matches;

  let pending = null;
  let showing = false;
  let timer = 0;
  let sprite = null;

  /* --- deciding ------------------------------------------------------------ */

  /**
   * Compare the store's stage with the last one celebrated here.
   *
   * Pure apart from the seed write, and exported for the tests: given the
   * store and the record, what is the occasion, if any.
   */
  function decide(state, stage, seen) {
    if (!seen) return { seed: { level: state.petUnlocked ? stage.level : 0, unlocked: !!state.petUnlocked } };
    if (!state.petUnlocked) return null;
    if (!seen.unlocked) return { kind: 'hatch', stage };
    if (stage.level > (Number(seen.level) || 0)) return { kind: 'evolve', stage, from: Number(seen.level) || 0 };
    return null;
  }

  function check() {
    const P = window.YomuProgress;
    if (!P || showing) return;
    const state = P.get();
    const stage = P.stageOf();
    const verdict = decide(state, stage, readJSON(KEY, null));
    if (!verdict) return;
    if (verdict.seed) { writeJSON(KEY, verdict.seed); return; }
    pending = verdict;
    maybeShow();
  }

  function maybeShow() {
    if (!pending || showing) return;
    if (document.hidden) return;
    if (window.YomuPet?.surface?.() === 'reader') return;
    const occasion = pending;
    pending = null;
    /* Written before the card is drawn: a reload mid-ceremony must not
       replay it, and a card that fails to draw must not queue forever. */
    writeJSON(KEY, { level: occasion.stage.level, unlocked: true });
    show(occasion);
  }

  /* --- drawing ------------------------------------------------------------- */

  function show(occasion) {
    showing = true;
    document.getElementById(ROOT_ID)?.remove();

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'yc' + (reduced() ? ' yc--still' : '');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', ROOT_ID + '-title');

    const scrim = document.createElement('button');
    scrim.type = 'button';
    scrim.className = 'yc__scrim';
    scrim.setAttribute('aria-label', 'Close');
    scrim.addEventListener('click', dismiss);

    const card = document.createElement('div');
    card.className = 'yc__card';

    const stagePane = document.createElement('div');
    stagePane.className = 'yc__stage';

    if (occasion.kind === 'hatch') {
      /* The egg the You page has been drawing since chapter one, cracking. */
      const egg = document.createElement('div');
      egg.className = 'yc__egg';
      egg.setAttribute('aria-hidden', 'true');
      const left = document.createElement('span'); left.className = 'yc__shell yc__shell--l'; left.textContent = '🥚';
      const right = document.createElement('span'); right.className = 'yc__shell yc__shell--r'; right.textContent = '🥚';
      egg.append(left, right);
      stagePane.append(egg);
    } else {
      const was = document.createElement('div');
      was.className = 'yc__was';
      was.setAttribute('aria-hidden', 'true');
      stagePane.append(was);
    }

    if (window.YomuPet?.sprite) {
      sprite = window.YomuPet.sprite(132, 'celebrating');
      sprite.node.classList.add('yc__new');
      stagePane.append(sprite.node);
    }
    card.append(stagePane);

    const kicker = document.createElement('p');
    kicker.className = 'yc__kicker';
    kicker.textContent = occasion.kind === 'hatch' ? 'Mori hatched' : 'Mori evolved';
    card.append(kicker);

    const heading = document.createElement('h2');
    heading.className = 'yc__title';
    heading.id = ROOT_ID + '-title';
    heading.textContent = occasion.kind === 'hatch'
      ? 'Say hello to Mori'
      : 'Mori is now a ' + occasion.stage.name;
    card.append(heading);

    /* The badge drop: Book Goblin for the hatch, the stage badge after. */
    const badgeId = occasion.kind === 'hatch' ? 'book-goblin' : 'stage-' + String(occasion.stage.name).toLowerCase();
    const badge = window.YomuShelf?.el?.(badgeId, { size: 44 });
    if (badge) {
      const drop = document.createElement('div');
      drop.className = 'yc__badge';
      drop.append(badge);
      const says = document.createElement('span');
      says.textContent = (window.YomuShelf.title(badgeId) || badgeId) + ' badge';
      drop.append(says);
      card.append(drop);
    }

    /* One line in Mori's voice. Null is a real answer -- muted -- and the
       card simply has no speech. */
    const line = window.YomuGreetings?.line?.(
      occasion.kind === 'hatch' ? 'hatch' : 'evolve',
      { stage: occasion.stage.name },
    );
    if (line) {
      const quote = document.createElement('p');
      quote.className = 'yc__line';
      quote.textContent = line;
      card.append(quote);
    }

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'yc__ok';
    ok.textContent = 'Keep reading';
    ok.addEventListener('click', dismiss);
    card.append(ok);

    root.append(scrim, card);
    document.body.append(root);

    /* The floating pet joins in where it is allowed to be. Its own hold
       reverts it; nothing here has to remember to. */
    window.YomuPet?.setState?.('celebrating', 3600);

    requestAnimationFrame(() => root.classList.add('is-on'));
    ok.focus({ preventScroll: true });
    clearTimeout(timer);
    timer = setTimeout(dismiss, HOLD_MS);
    addEventListener('keydown', onKey);
  }

  function onKey(event) {
    if (event.key === 'Escape') dismiss();
  }

  function dismiss() {
    clearTimeout(timer);
    timer = 0;
    removeEventListener('keydown', onKey);
    const root = document.getElementById(ROOT_ID);
    if (sprite) { sprite.stop(); sprite = null; }
    if (root) {
      root.classList.remove('is-on');
      const gone = () => root.remove();
      if (reduced()) gone(); else setTimeout(gone, 260);
    }
    showing = false;
    /* The You page's companion sprite shares the loop and may be sitting on
       whatever frame the loop last painted. Asking the pet to refresh runs
       pose(), which repaints every player -- the way back to idle, not just
       the way in. */
    window.YomuPet?.refresh?.();
    /* Another change may have queued while this was up. */
    maybeShow();
  }

  /* --- public shape ------------------------------------------------------ */

  const api = { check, decide, dismiss, __show: show };
  if (typeof window !== 'undefined') window.YomuCeremony = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { decide, KEY, HOLD_MS };

  /* --- boot -------------------------------------------------------------- */

  if (browser) {
    const boot = () => check();
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
    else boot();
    addEventListener('yomu:progress', check);
    addEventListener('yomu:pet-surface', maybeShow);
    addEventListener('visibilitychange', () => { if (!document.hidden) maybeShow(); });
  }
})();
