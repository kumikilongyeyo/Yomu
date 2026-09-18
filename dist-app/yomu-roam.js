/**
 * Mori roams Home.
 *
 * Home is where readers spend their time, and the pet was mounted there in
 * a corner like a widget. Now it wanders the cover grid: it naps on the
 * cover of the last-read series, wanders to a random tile now and then, and
 * hops over to a saved title the moment Home shows it has a new chapter,
 * with a word about it.
 *
 * Three rules, each the answer to a way this goes wrong:
 *
 * **The reader's hand wins.** A pet the reader has dragged somewhere stays
 * there (prefs.position is set), and a drag in progress cancels a walk. The
 * corner is only ever left from the corner.
 *
 * **Never over a control.** Targets are the covers of visible tiles, and the
 * pet stands on a cover's lower edge -- covers are pictures, not buttons,
 * and the save button is at the top of the tile. The dock and the masthead
 * are never targets.
 *
 * **Stillness is a setting.** Under reduced motion Mori does not roam at all;
 * a pet that teleports around the page is worse than one that stays put.
 *
 * Positioning is the overlay's own fixed left/top, animated with a CSS
 * transition that is only on while walking, so dragging stays immediate.
 * The pet's walking rows face the way it is going.
 */
(() => {
  'use strict';

  const READING_KEY = 'yomu.v1.reading';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const WALK_MS = 1900;
  const MIN_WAIT = 16000;
  const MAX_WAIT = 32000;

  const browser = typeof document !== 'undefined';
  const reduced = () => browser && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };

  /* --- what is on the page ------------------------------------------------- */

  /** The series read most recently, off the shell's reading index. */
  function lastRead() {
    const index = readJSON(READING_KEY, {}) || {};
    let best = null;
    for (const record of Object.values(index)) {
      if (!record || !record.seriesId) continue;
      if (!best || (record.at || 0) > (best.at || 0)) best = record;
    }
    return best ? { seriesId: best.seriesId, title: best.title || '' } : null;
  }

  function savedIds() {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    const rows = Array.isArray(collection.library) ? collection.library : [];
    return new Set(rows.filter((r) => r && r.id && !r.hidden).map((r) => r.id));
  }

  /** Tiles whose cover is wholly on screen and clear of the dock. */
  function visibleTiles() {
    const out = [];
    const floor = innerHeight - 120;
    for (const tile of document.querySelectorAll('.tile-card[data-series]')) {
      const cover = tile.querySelector('.tile-card__cover') || tile;
      const box = cover.getBoundingClientRect();
      if (box.width < 60 || box.height < 60) continue;
      if (box.top < 60 || box.bottom > floor) continue;
      out.push({
        tile, box,
        seriesId: tile.getAttribute('data-series'),
        fresh: !!tile.querySelector('.freshness--new, .freshness--updated'),
        title: tile.querySelector('.tile-card__title')?.textContent?.trim() || '',
      });
    }
    return out;
  }

  /**
   * Where to go next. Pure, so it can be tested: given the visible tiles,
   * the last-read series and the saved set, plus which fresh titles have
   * already been remarked on this session.
   */
  function chooseTarget(tiles, last, saved, remarked, random) {
    if (!tiles.length) return null;
    const fresh = tiles.find((t) => t.fresh && saved.has(t.seriesId) && !remarked.has(t.seriesId));
    if (fresh) return { kind: 'fresh', tile: fresh };
    const nap = last && tiles.find((t) => t.seriesId === last.seriesId);
    const roll = typeof random === 'number' ? random : Math.random();
    if (nap && roll < 0.55) return { kind: 'nap', tile: nap };
    if (roll < 0.85) return { kind: 'wander', tile: tiles[Math.floor(((roll * 1000) % 1) * tiles.length) % tiles.length] };
    return { kind: 'home' };
  }

  /* --- walking ------------------------------------------------------------- */

  const remarked = new Set();
  let timer = 0;
  let walking = false;
  let parkedOn = '';

  const pet = () => window.YomuPet;

  function allowed() {
    const p = pet();
    if (!p || !p.root || !p.root()) return false;
    if (reduced() || document.hidden) return false;
    const prefs = p.prefs();
    if (!prefs.enabled || prefs.minimized || prefs.position) return false;
    if (p.surface() !== 'home' || !p.policy().roam) return false;
    return true;
  }

  const restful = () => ['idle', 'sleeping', 'walkingLeft', 'walkingRight'].includes(pet().state());

  function petSize() {
    const root = pet().root();
    const box = root.getBoundingClientRect();
    return { w: box.width || 98, h: box.height || 106 };
  }

  function moveTo(x, y, then) {
    const root = pet().root();
    if (!root) return;
    const size = petSize();
    const left = Math.max(0, Math.min(innerWidth - size.w, x));
    const top = Math.max(0, Math.min(innerHeight - size.h - 90, y));
    const from = root.getBoundingClientRect();
    /* Face the way it is going. The two running rows are the only sideways
       art the sheet has. */
    if (restful()) pet().setState(left < from.left ? 'walkingLeft' : 'walkingRight');
    walking = true;
    root.classList.add('is-roaming');
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    /* Pin the current place in left/top before transitioning, or a corner
       anchored by right/bottom jumps instead of walking. */
    root.style.left = from.left + 'px';
    root.style.top = from.top + 'px';
    requestAnimationFrame(() => {
      root.style.left = left + 'px';
      root.style.top = top + 'px';
    });
    dispatchEvent(new CustomEvent('yomu:pet-moved'));
    setTimeout(() => {
      walking = false;
      root.classList.remove('is-roaming');
      if (restful()) pet().setState('idle');
      then?.();
    }, WALK_MS);
  }

  function goHome() {
    const root = pet().root();
    if (!root) return;
    parkedOn = '';
    const size = petSize();
    moveTo(innerWidth - size.w - 20, innerHeight - size.h - 104, () => {
      /* Back on the corner, hand the position back to the pet's own place()
         so a later resize or size change does what it always did. */
      root.style.left = 'auto';
      root.style.top = 'auto';
      root.style.right = '20px';
      root.style.bottom = 'calc(104px + env(safe-area-inset-bottom))';
    });
  }

  /** Stand on the lower edge of a cover, a little in from its left. */
  function standOn(target, kind) {
    const size = petSize();
    const box = target.box;
    const x = box.left + Math.min(12, box.width * 0.1);
    const y = box.bottom - size.h * 0.86;
    parkedOn = target.seriesId;
    moveTo(x, y, () => {
      const p = pet();
      if (!restful()) return;
      if (kind === 'nap') { p.setState('sleeping'); return; }
      if (kind === 'fresh') {
        remarked.add(target.seriesId);
        p.setState('happy', 2400);
        const line = window.YomuGreetings?.line?.('fresh', { title: target.title || 'a saved title' });
        if (line) p.say(line, 4200);
      }
    });
  }

  function tick() {
    schedule();
    if (!allowed() || walking || !restful()) return;
    const p = pet();
    if (p.state() !== 'idle' && p.state() !== 'sleeping') return;
    const tiles = visibleTiles();
    const target = chooseTarget(tiles, lastRead(), savedIds(), remarked);
    if (!target) { if (parkedOn) goHome(); return; }
    if (target.kind === 'home') { if (parkedOn) goHome(); return; }
    if (target.tile.seriesId === parkedOn && target.kind !== 'fresh') return;
    standOn(target.tile, target.kind);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(tick, MIN_WAIT + Math.random() * (MAX_WAIT - MIN_WAIT));
  }

  /* A parked pet whose cover scrolled away is a pet standing on nothing. */
  let scrollTimer = 0;
  function onScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (!parkedOn || walking || !allowed()) return;
      const still = visibleTiles().some((t) => t.seriesId === parkedOn);
      if (!still) goHome();
    }, 350);
  }

  /* Leaving Home: the pet's own refresh() re-places it, but a walk in
     flight would land on the new page. */
  function onSurface() {
    clearTimeout(timer);
    walking = false;
    parkedOn = '';
    const root = pet()?.root?.();
    root?.classList.remove('is-roaming');
    /* First wander comes sooner on arrival, so Home is not a static shelf for
       half a minute after you open it. */
    if (allowed()) timer = setTimeout(tick, 5000);
  }

  /* --- public shape ------------------------------------------------------ */

  const api = {
    chooseTarget, tick, goHome,
    /* Debug seam, like the store's __set: walk to a tile now, whatever the
       clock and the visibility say. Not reachable from the UI. */
    __walk(seriesId, kind) {
      const target = visibleTiles().find((t) => t.seriesId === seriesId);
      if (!target || !pet()?.root?.()) return false;
      standOn(target, kind || 'nap');
      return true;
    },
  };
  if (typeof window !== 'undefined') window.YomuRoam = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { chooseTarget };

  /* --- boot -------------------------------------------------------------- */

  if (browser) {
    const boot = () => { if (allowed()) timer = setTimeout(tick, 6000); };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
    else boot();
    addEventListener('yomu:pet-surface', onSurface);
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
    /* A drag beginning on the pet ends any walk at once. */
    document.addEventListener('pointerdown', (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('#yomu-pet')) return;
      const root = pet()?.root?.();
      if (root) root.classList.remove('is-roaming');
      walking = false;
      parkedOn = '';
    }, true);
    /* Placed by hand: roaming stands down until the pet is reset. */
    addEventListener('yomu:pet-prefs', (event) => {
      if (event.detail?.position) { clearTimeout(timer); parkedOn = ''; }
      else schedule();
    });
  }
})();
