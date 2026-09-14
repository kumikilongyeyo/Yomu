/**
 * The 18+ gate, for the screens Yomu compiles.
 *
 * find.html and suwayomi-setup.html are hand-written and handle this themselves.
 * Settings, the series page and the reader are Expo output, and the Expo project
 * was never handed over, so the toggle and the veil are added from outside.
 *
 * Two jobs:
 *   1. A "Show 18+" row in Settings, so the switch lives where a switch belongs
 *      rather than only on the pages that happen to be hand-written.
 *   2. Blur covers and pages of a title known to be adult, until tapped.
 *
 * What counts as adult is never guessed from the picture. It comes from the
 * provider: a MangaDex erotica/pornographic rating, a Comick content_rating, or
 * a source the extension registry marks nsfw. find.html records the titles it
 * knows about as you open them, so the series page and reader can act on the
 * same fact without asking again.
 *
 * When the Expo source turns up this belongs in its Settings screen and its
 * image components; delete this file then.
 */
(() => {
  'use strict';

  const ADULT_KEY = 'yomu.v1.adult';
  const TITLES_KEY = 'yomu.v1.adultTitles';
  const BLUR_KEY = 'yomu.v1.adultBlur';
  const VEIL = 'data-yomu-veil';
  const BADGE = 'data-yomu-veil-badge';

  const read = (key, fallback) => {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  };
  const adultAllowed = () => read(ADULT_KEY, 'off') === 'on';
  // Blur is on until turned off: the safer default, and reversible in Settings.
  const blurAdult = () => read(BLUR_KEY, 'on') !== 'off';

  /** Titles a provider rated adult, recorded by find.html as "<sourceId>:<seriesId>". */
  function adultTitles() {
    try {
      const raw = JSON.parse(localStorage.getItem(TITLES_KEY) || '[]');
      return new Set(Array.isArray(raw) ? raw.map(String) : []);
    } catch { return new Set(); }
  }

  /* ------------------------------------------------------------------ *
   * Settings: a switch where a switch belongs
   * ------------------------------------------------------------------ */

  const SETTINGS_ROW_ID = 'yomu-adult-setting';

  function buildSettingsRow() {
    const label = document.createElement('div');
    label.className = 'group-label';
    label.id = SETTINGS_ROW_ID + '-label';
    label.textContent = 'Content';

    const group = document.createElement('section');
    group.className = 'settings-group glass';
    group.id = SETTINGS_ROW_ID;

    // A link, not a switch. Adult titles are kept out of Home, Search,
    // Library and Continue Reading entirely, so there is nothing here for a
    // toggle to reveal -- 18+ has its own page, and the switch lives on it
    // next to the thing it governs.
    const row = document.createElement('a');
    row.className = 'setting-link';
    row.href = '/adult.html';
    row.style.textDecoration = 'none';

    const copy = document.createElement('div');
    copy.className = 'row-copy';
    const h3 = document.createElement('h3');
    h3.textContent = '18+ content';
    const small = document.createElement('small');
    small.textContent = adultAllowed()
      ? 'On. Adult titles appear only on the 18+ page.'
      : 'Off. Adult titles are hidden everywhere.';
    copy.append(h3, small);

    const chevron = document.createElement('span');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    chevron.style.cssText = 'color:var(--dim);font-size:20px;flex:none';

    row.append(copy, chevron);
    group.append(row);
    return { label, group };
  }

  function mountSettingsRow() {
    if (!location.pathname.startsWith('/settings')) return;
    if (document.getElementById(SETTINGS_ROW_ID)) return;

    // Sit above Storage, so content sits with the other "what you see" settings
    // rather than among the destructive ones.
    const labels = [...document.querySelectorAll('.group-label')];
    const storage = labels.find((l) => /storage/i.test(l.textContent || ''));
    const anchor = storage ?? labels[labels.length - 1];
    if (!anchor?.parentNode) return;

    const { label, group } = buildSettingsRow();
    anchor.parentNode.insertBefore(label, anchor);
    anchor.parentNode.insertBefore(group, anchor);
  }

  /* ------------------------------------------------------------------ *
   * The veil
   * ------------------------------------------------------------------ */

  /** The title this screen is showing, as the key find.html recorded. */
  function currentTitleKey() {
    const source = new URLSearchParams(location.search).get('source');
    if (!source) return null;

    const series = location.pathname.match(/^\/series\/([^/?#]+)/);
    if (series) return `${source}:${decodeURIComponent(series[1])}`;

    // A chapter id usually carries its series as a leading segment or as the
    // reader's own prefix, which is what the worker derives sourceSeriesId from.
    const read = location.pathname.match(/^\/read\/([^/?#]+)/);
    if (read) {
      const chapterId = decodeURIComponent(read[1]);
      const head = chapterId.split(/[:/]/)[0];
      return head ? `${source}:${head}` : null;
    }
    return null;
  }

  let veilThisScreen = false;
  let revealed = false;

  /**
   * Whether a parent is a wrapper around this image or just the row it sits in.
   *
   * The badge has to go on the parent -- a filter blurs an element's own
   * pseudo-elements, so a badge on the blurred thing would be unreadable -- but
   * only when the parent actually hugs the image. A chapter row is mostly text
   * with a thumbnail at one end, and a badge pinned to its far corner points at
   * nothing.
   */
  function wrapsTightly(parent, el) {
    if (!parent) return false;
    const p = parent.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    if (!e.width || !e.height) return false;
    return p.width * p.height < e.width * e.height * 2;
  }

  function applyVeil() {
    const key = currentTitleKey();
    veilThisScreen = !!key && adultTitles().has(key) && blurAdult();
    const on = veilThisScreen && !revealed;

    // Two shapes to cover: the reader wraps each page in a div around an <img>,
    // while the series page and the grids paint .cover elements with a CSS
    // background-image and no <img> at all.
    const media = new Set([...document.images, ...document.querySelectorAll('.cover')]);

    for (const el of document.querySelectorAll(`[${VEIL}]`)) if (!media.has(el)) el.removeAttribute(VEIL);
    for (const el of document.querySelectorAll(`[${BADGE}]`)) el.removeAttribute(BADGE);

    for (const el of media) {
      if (!on) { el.removeAttribute(VEIL); continue; }
      el.setAttribute(VEIL, 'on');
      if (wrapsTightly(el.parentElement, el)) el.parentElement.setAttribute(BADGE, '');
    }
  }

  // One tap anywhere on a veiled screen clears it for this visit. Capture phase
  // so the tap is spent on revealing rather than on whatever is underneath.
  document.addEventListener(
    'click',
    (event) => {
      if (!veilThisScreen || revealed) return;
      const holder = event.target instanceof Element
        ? event.target.closest(`[${BADGE}]`) ?? event.target.closest(`[${VEIL}="on"]`)
        : null;
      if (!holder) return;
      event.stopPropagation();
      event.preventDefault();
      revealed = true;
      applyVeil();
    },
    true,
  );

  /* ------------------------------------------------------------------ *
   * Keeping up with the app
   *
   * These screens are React, so the settings row can be removed by a re-render
   * and the reader mounts pages as you scroll. One observer covers both, and a
   * URL check resets the veil when the route changes under a client-side
   * navigation.
   * ------------------------------------------------------------------ */

  let lastUrl = location.href;

  function tick() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      revealed = false;
    }
    mountSettingsRow();
    applyVeil();
  }

  const start = () => {
    tick();
    new MutationObserver(() => {
      // Cheap: both jobs are idempotent and bail early when there is nothing to do.
      tick();
    }).observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
