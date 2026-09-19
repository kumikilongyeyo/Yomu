/**
 * Customize Look, the controlled half — presets, and the knobs the sheet grew.
 *
 * yomu-look.js owns mode, accent, skin, the tag chips and the cover shade,
 * and writes them to the keys the app already reads. This file owns everything
 * that is a *shape* rather than a colour: how round a tile is, how a secondary
 * button is finished, how a call to action is weighted. It folds the whole
 * sheet into accordions on the way through, and it adds the five presets at
 * the top that make the panel usable without touching a single row.
 *
 * Three things were wrong with the first version, and all three are the same
 * mistake in different clothes:
 *
 *   **The accordions were as tall as the sheet.** The host was a plain CSS
 *   grid, so its rows shared the panel's free height between them and five
 *   closed rows became five empty cards two hundred pixels tall. A closed
 *   accordion should be its own summary and nothing else -- rows sized to
 *   content, and a closed body that is `display:none` rather than merely
 *   empty.
 *
 *   **Every knob was a <select>.** Nine dropdowns is a settings screen, not a
 *   look. Anything with a natural order -- blur, opacity, weight, a gap -- is
 *   a slider with its value printed, and anything with three or four choices
 *   that can be *drawn* is a segmented control.
 *
 *   **There was no way to just pick a look.** Five presets do the job of
 *   twenty rows for most people, and the rows are still there for the rest.
 *   Applying one writes every token it names in a single save; changing any
 *   row afterwards keeps the values and renames the state to Custom, because
 *   claiming a reader is still on "Ember" after they have rebuilt half of it
 *   is a lie the panel would be telling itself.
 *
 * Storage is `yomu.v1.controls`, the same key the first version wrote. A
 * stored look from before this file grew is read back without complaint: every
 * key it does not carry falls to the default, which is what the old build
 * rendered anyway.
 */
(() => {
  'use strict';

  const KEY = 'yomu.v1.controls';
  const browser = typeof document !== 'undefined';

  /* --- the knobs ----------------------------------------------------------- *
   *
   * Two kinds. A CHOICE is one of a fixed list and ends as an attribute on
   * <html>, so a stylesheet can select on it. A NUMBER is a range and ends as
   * a custom property, so a stylesheet can compute with it. Nothing here
   * paints; the two stylesheets do all of it.
   */

  const CHOICES = {
    siteGradient: [['default', 'Yomu original'], ['aurora', 'Aurora'], ['ocean', 'Midnight ocean'], ['ember', 'Ember dusk'], ['violet', 'Violet haze'], ['forest', 'Forest ink']],

    tileShape: [['soft', 'Soft'], ['round', 'Rounder'], ['compact', 'Compact']],
    tileTone: [['neutral', 'Neutral'], ['accent', 'Accent glow'], ['cool', 'Cool glass'], ['warm', 'Warm glass']],
    tileLift: [['none', 'Flat'], ['soft', 'Soft'], ['high', 'Lifted']],
    ratingStyle: [['glass', 'Glass'], ['solid', 'Solid'], ['bare', 'Bare']],

    buttonShape: [['round', 'Rounded'], ['pill', 'Pill'], ['compact', 'Compact']],
    buttonTone: [['accent', 'Accent'], ['ocean', 'Ocean'], ['violet', 'Violet'], ['jade', 'Jade'], ['coral', 'Coral'], ['neutral', 'Neutral']],
    buttonFinish: [['soft', 'Soft'], ['glass', 'Glass'], ['outline', 'Outline']],
    buttonAlign: [['start', 'Left'], ['center', 'Centre'], ['end', 'Right']],
    buttonCase: [['none', 'As written'], ['upper', 'UPPER'], ['caps', 'Small caps']],
    buttonIcon: [['left', 'Icon left'], ['right', 'Icon right'], ['only', 'Icon only']],

    ctaShape: [['pill', 'Pill'], ['round', 'Rounded'], ['square', 'Compact']],
    ctaTone: [['accent', 'Accent'], ['sunset', 'Sunset'], ['ocean', 'Ocean'], ['violet', 'Violet'], ['jade', 'Jade']],
    ctaFinish: [['gradient', 'Gradient'], ['solid', 'Solid'], ['glass', 'Glass']],
    ctaWidth: [['auto', 'Hug'], ['wide', 'Wide'], ['full', 'Full width']],
    ctaAlign: [['start', 'Left'], ['center', 'Centre'], ['end', 'Right']],
    ctaIcon: [['left', 'Icon left'], ['right', 'Icon right'], ['none', 'No icon']],
  };

  /* name: [min, max, step, unit, default] */
  const NUMBERS = {
    surfaceOpacity: [40, 100, 2, '%', 100],
    surfaceBlur: [0, 24, 1, 'px', 0],
    radius: [60, 160, 5, '%', 100],
    shadow: [0, 160, 5, '%', 100],
    density: [85, 115, 1, '%', 100],

    tileDim: [0, 60, 2, '%', 0],
    tileClamp: [1, 3, 1, ' lines', 2],

    buttonBlur: [0, 20, 1, 'px', 0],
    buttonOpacity: [30, 100, 2, '%', 100],
    buttonBorder: [0, 200, 5, '%', 100],
    buttonShadow: [0, 200, 5, '%', 0],
    buttonHeight: [30, 48, 1, 'px', 38],
    buttonWeight: [500, 900, 100, '', 800],
    buttonIconGap: [0, 16, 1, 'px', 8],

    ctaBlur: [0, 20, 1, 'px', 0],
    ctaEmphasis: [60, 160, 5, '%', 100],
    ctaAngle: [0, 360, 5, '°', 120],
    ctaShadow: [0, 200, 5, '%', 100],
    ctaHover: [0, 200, 5, '%', 100],
  };

  /* The first version's defaults, which are not all first-in-list. Kept
     explicit so a reader who never opened the sheet sees no change. */
  const SHIPPED = {
    tileLift: 'soft', buttonShape: 'round', ctaShape: 'pill', ctaFinish: 'gradient',
    /* Centred, because that is what the app's own buttons do. Left as the
       first list entry these would make the shipped look fail to match Yomu
       Core, and the panel would open saying "Custom" to someone who has
       never touched it. */
    buttonAlign: 'center', ctaAlign: 'center',
  };

  const DEFAULTS = Object.freeze({
    preset: 'core',
    ...Object.fromEntries(Object.entries(CHOICES).map(([k, v]) => [k, v[0][0]])),
    ...Object.fromEntries(Object.entries(NUMBERS).map(([k, v]) => [k, v[4]])),
    ...SHIPPED,
  });

  /* --- the five looks -------------------------------------------------------- *
   *
   * A preset is a patch, not a state: it names the tokens it has an opinion
   * about and leaves the rest alone, so applying Ink over a reader's chosen
   * accent does not throw the accent away. Mode and skin are yomu-look.js's,
   * and a preset that silently flipped someone into dark would be the panel
   * overreaching -- so `mode` is a suggestion the reader confirms by using the
   * Mode row, and is deliberately not written here.
   */
  const PRESETS = [
    {
      /* `short` is what the 52px card shows at 320px, where "Yomu Core"
         truncated to "Yomu C..." and the other four names fit. The full
         name stays the accessible one. */
      id: 'core', name: 'Yomu Core', short: 'Core', hint: 'The house look',
      swatch: ['#ffc45f', '#1b2836'],
      patch: {
        siteGradient: 'default', tileShape: 'soft', tileTone: 'neutral', tileLift: 'soft',
        tileDim: 0, ratingStyle: 'glass',
        buttonShape: 'round', buttonTone: 'accent', buttonFinish: 'soft',
        buttonBlur: 0, buttonOpacity: 100, buttonBorder: 100, buttonShadow: 0,
        buttonHeight: 38, buttonWeight: 800, buttonAlign: 'center', buttonCase: 'none',
        buttonIcon: 'left', buttonIconGap: 8,
        ctaShape: 'pill', ctaTone: 'accent', ctaFinish: 'gradient',
        ctaBlur: 0, ctaWidth: 'auto', ctaEmphasis: 100, ctaAngle: 120, ctaShadow: 100,
        ctaAlign: 'center', ctaIcon: 'left', ctaHover: 100,
        surfaceOpacity: 100, surfaceBlur: 0, radius: 100, shadow: 100, density: 100,
      },
    },
    {
      id: 'ember', name: 'Ember', hint: 'Warm, streak-forward',
      swatch: ['#ff9d65', '#2a1a18'],
      patch: {
        siteGradient: 'ember', tileShape: 'soft', tileTone: 'warm', tileLift: 'high',
        tileDim: 10, ratingStyle: 'glass',
        buttonShape: 'pill', buttonTone: 'coral', buttonFinish: 'glass',
        buttonBlur: 12, buttonOpacity: 92, buttonBorder: 120, buttonShadow: 90,
        buttonHeight: 40, buttonWeight: 800, buttonAlign: 'center', buttonCase: 'none',
        buttonIcon: 'left', buttonIconGap: 9,
        ctaShape: 'pill', ctaTone: 'sunset', ctaFinish: 'gradient',
        ctaBlur: 0, ctaWidth: 'wide', ctaEmphasis: 135, ctaAngle: 110, ctaShadow: 150,
        ctaAlign: 'center', ctaIcon: 'left', ctaHover: 140,
        surfaceOpacity: 96, surfaceBlur: 10, radius: 115, shadow: 130, density: 100,
      },
    },
    {
      id: 'aurora', name: 'Aurora', hint: 'Cool luminous glass',
      swatch: ['#9db8ff', '#141d30'],
      patch: {
        siteGradient: 'aurora', tileShape: 'round', tileTone: 'cool', tileLift: 'soft',
        tileDim: 6, ratingStyle: 'glass',
        buttonShape: 'pill', buttonTone: 'ocean', buttonFinish: 'glass',
        buttonBlur: 16, buttonOpacity: 86, buttonBorder: 90, buttonShadow: 40,
        buttonHeight: 38, buttonWeight: 700, buttonAlign: 'center', buttonCase: 'none',
        buttonIcon: 'left', buttonIconGap: 10,
        ctaShape: 'pill', ctaTone: 'ocean', ctaFinish: 'gradient',
        ctaBlur: 8, ctaWidth: 'auto', ctaEmphasis: 110, ctaAngle: 140, ctaShadow: 110,
        ctaAlign: 'center', ctaIcon: 'left', ctaHover: 110,
        surfaceOpacity: 88, surfaceBlur: 18, radius: 130, shadow: 110, density: 100,
      },
    },
    {
      id: 'ink', name: 'Ink', hint: 'Editorial, flat, precise',
      swatch: ['#e8e4dc', '#101114'],
      patch: {
        siteGradient: 'forest', tileShape: 'compact', tileTone: 'neutral', tileLift: 'none',
        tileDim: 0, ratingStyle: 'bare',
        buttonShape: 'compact', buttonTone: 'neutral', buttonFinish: 'outline',
        buttonBlur: 0, buttonOpacity: 100, buttonBorder: 150, buttonShadow: 0,
        buttonHeight: 34, buttonWeight: 600, buttonAlign: 'start', buttonCase: 'upper',
        buttonIcon: 'left', buttonIconGap: 6,
        ctaShape: 'square', ctaTone: 'accent', ctaFinish: 'solid',
        ctaBlur: 0, ctaWidth: 'auto', ctaEmphasis: 90, ctaAngle: 90, ctaShadow: 0,
        ctaAlign: 'start', ctaIcon: 'none', ctaHover: 70,
        surfaceOpacity: 100, surfaceBlur: 0, radius: 70, shadow: 40, density: 92,
      },
    },
    {
      id: 'paper', name: 'Paper', hint: 'Warm reading room',
      swatch: ['#b8791c', '#f5f2ec'],
      patch: {
        siteGradient: 'default', tileShape: 'soft', tileTone: 'warm', tileLift: 'soft',
        tileDim: 0, ratingStyle: 'solid',
        buttonShape: 'round', buttonTone: 'accent', buttonFinish: 'soft',
        buttonBlur: 0, buttonOpacity: 100, buttonBorder: 80, buttonShadow: 60,
        buttonHeight: 40, buttonWeight: 700, buttonAlign: 'center', buttonCase: 'none',
        buttonIcon: 'left', buttonIconGap: 9,
        ctaShape: 'round', ctaTone: 'accent', ctaFinish: 'solid',
        ctaBlur: 0, ctaWidth: 'auto', ctaEmphasis: 100, ctaAngle: 120, ctaShadow: 70,
        ctaAlign: 'center', ctaIcon: 'left', ctaHover: 90,
        surfaceOpacity: 100, surfaceBlur: 0, radius: 105, shadow: 80, density: 104,
      },
    },
  ];
  const PRESET_IDS = PRESETS.map((p) => p.id);

  /* --- state ----------------------------------------------------------------- */

  const clamp = (n, lo, hi, fallback) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, v));
  };

  /**
   * Pure: whatever is in storage -> a look with every knob valid.
   *
   * Anything unrecognised falls to its default rather than being dropped, so
   * a look stored by an older build (which knew nine keys) reads back as the
   * look that build actually rendered.
   */
  function normalize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const out = { preset: PRESET_IDS.includes(r.preset) ? r.preset : (r.preset === 'custom' ? 'custom' : DEFAULTS.preset) };
    for (const [name, list] of Object.entries(CHOICES)) {
      out[name] = list.some(([id]) => id === r[name]) ? r[name] : DEFAULTS[name];
    }
    for (const [name, [lo, hi, step, , fallback]] of Object.entries(NUMBERS)) {
      const v = clamp(r[name], lo, hi, fallback);
      /* Snapped to the step so a hand-edited or migrated value cannot leave a
         slider sitting between two stops. */
      out[name] = Math.round(v / step) * step;
    }
    return out;
  }

  /** Does this look still match the preset it claims? */
  function matches(state, preset) {
    if (!preset) return false;
    return Object.entries(preset.patch).every(([k, v]) => state[k] === v);
  }

  /** Which preset a look *is*, if any. Used when reading storage back. */
  function presetOf(state) {
    const found = PRESETS.find((p) => matches(state, p));
    return found ? found.id : 'custom';
  }

  let state = (() => {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch {}
    const normalized = normalize(raw);
    /* The label is derived, never trusted: a look edited by hand in devtools,
       or migrated from a build with fewer knobs, should say what it is. */
    normalized.preset = presetOf(normalized);
    return normalized;
  })();

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

  const dashed = (name) => name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

  function apply() {
    if (!browser) return;
    const html = document.documentElement;
    for (const name of Object.keys(CHOICES)) html.setAttribute('data-yui-' + dashed(name), state[name]);
    for (const [name, [, , , unit]] of Object.entries(NUMBERS)) {
      const raw = state[name];
      html.style.setProperty('--yui-' + dashed(name), unit === 'px' ? raw + 'px' : String(raw));
      if (unit === '%') html.style.setProperty('--yui-' + dashed(name) + '-f', String(raw / 100));
    }
    html.setAttribute('data-yui-preset', state.preset);

    /* The two appearance knobs that override the app's own surfaces are only
       switched on when the reader has actually moved one of them. At their
       defaults the rules they enable are no-ops on paper and were not in
       practice: the opacity rule rewrote --surface for every panel, and the
       blur rule replaced whatever blur the app had chosen. An untouched Yomu
       should be exactly the Yomu it was. */
    const tunedSurface = state.surfaceOpacity !== DEFAULTS.surfaceOpacity
      || state.surfaceBlur !== DEFAULTS.surfaceBlur;
    if (tunedSurface) html.setAttribute('data-yui-surface', 'tuned');
    else html.removeAttribute('data-yui-surface');

    sync();
    dispatchEvent(new CustomEvent('yomu:controls', { detail: { ...state } }));
  }

  /**
   * One knob moved.
   *
   * The preset label follows the values rather than leading them: land back
   * on a preset exactly and it is named again, which is the behaviour someone
   * undoing a change expects.
   */
  function set(name, value) {
    if (name in CHOICES) {
      if (!CHOICES[name].some(([id]) => id === value)) return false;
      state = { ...state, [name]: value };
    } else if (name in NUMBERS) {
      const [lo, hi] = NUMBERS[name];
      state = { ...state, [name]: clamp(value, lo, hi, DEFAULTS[name]) };
    } else return false;
    state.preset = presetOf(state);
    save(); apply();
    return true;
  }

  /** Every token a preset names, in one write. */
  function applyPreset(id) {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return false;
    state = normalize({ ...state, ...preset.patch });
    state.preset = preset.id;
    save(); apply();
    return true;
  }

  function reset() { applyPreset('core'); }

  /* --- the controls ------------------------------------------------------------ */

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const syncers = new Set();
  const sync = () => { for (const fn of syncers) { try { fn(); } catch {} } };

  /** A row of buttons, for a choice with few enough options to show at once. */
  function segmented(name, label) {
    const row = el('div', 'yui-row');
    row.append(el('span', 'yui-row__label', label));
    const group = el('div', 'yui-seg');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    for (const [id, text] of CHOICES[name]) {
      const b = el('button', 'yui-seg__b', text);
      b.type = 'button';
      b.dataset.id = id;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => set(name, id));
      group.append(b);
    }
    row.append(group);
    syncers.add(() => {
      for (const b of group.children) b.setAttribute('aria-checked', String(b.dataset.id === state[name]));
    });
    return row;
  }

  /** A dropdown, for a choice with too many options to draw. */
  function select(name, label) {
    const row = el('label', 'yui-row');
    row.append(el('span', 'yui-row__label', label));
    const input = el('select', 'ylk__select yui-select');
    for (const [id, text] of CHOICES[name]) {
      const option = el('option', null, text);
      option.value = id;
      input.append(option);
    }
    input.addEventListener('change', () => set(name, input.value));
    row.append(input);
    syncers.add(() => { if (input.value !== state[name]) input.value = state[name]; });
    return row;
  }

  /** A slider with its value printed, for anything with a natural order. */
  function range(name, label) {
    const [lo, hi, step, unit] = NUMBERS[name];
    const row = el('label', 'yui-row yui-row--range');
    row.append(el('span', 'yui-row__label', label));
    const input = el('input', 'yui-range');
    input.type = 'range';
    input.min = String(lo);
    input.max = String(hi);
    input.step = String(step);
    input.setAttribute('aria-label', label);
    const out = el('output', 'yui-out');
    input.addEventListener('input', () => set(name, Number(input.value)));
    row.append(input, out);
    syncers.add(() => {
      const v = state[name];
      if (Number(input.value) !== v) input.value = String(v);
      const text = v + unit;
      if (out.textContent !== text) out.textContent = text;
    });
    return row;
  }

  /* --- previews ----------------------------------------------------------------- *
   *
   * Every preview is built from the same classes the real controls wear, so a
   * knob that moves the preview and not the page is a bug you can see rather
   * than one you have to be told about.
   */

  const STAR = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">'
    + '<path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.8 6.7 19.6l1.1-6L3.4 9.4l6-.8z"/></svg>';

  function labelled(node, word) {
    const icon = el('i', 'yui-ico');
    icon.innerHTML = STAR;
    const text = el('span', 'yui-word', word);
    node.append(icon, text);
    return node;
  }

  function preview(kind) {
    const box = el('div', 'yui-preview yui-preview--' + kind);
    box.setAttribute('aria-hidden', 'true');
    if (kind === 'appearance') box.append(el('div', 'yui-site-sample', 'Yomu'));
    if (kind === 'tile') {
      const card = el('div', 'yui-tile-sample');
      const chip = window.YomuTags?.chip
        ? window.YomuTags.chip('rating', '8.7', { size: 'xs' })
        : el('span', 'yui-fallback-chip', '★ 8.7');
      chip.classList.add('yui-tile-sample__rating');
      const copy = el('div', 'yui-tile-sample__copy');
      copy.append(el('strong', null, 'The Fox Club'), el('small', null, 'Chapter 41'));
      card.append(chip, copy);
      box.append(card);
    }
    if (kind === 'button') {
      box.append(labelled(el('button', 'yui-button-sample'), 'Library'));
      const icon = el('button', 'yui-button-sample yui-button-sample--icon');
      icon.innerHTML = STAR;
      box.append(icon);
    }
    if (kind === 'cta') box.append(labelled(el('button', 'yui-cta-sample'), 'Start reading'));
    return box;
  }

  /* --- the preset row ------------------------------------------------------------ */

  function presetRow() {
    const wrap = el('div', 'yui-presets');
    const head = el('div', 'yui-presets__head');
    head.append(el('strong', null, 'Presets'));
    const tag = el('span', 'yui-presets__state');
    head.append(tag);
    wrap.append(head);

    const strip = el('div', 'yui-presets__strip');
    strip.setAttribute('role', 'radiogroup');
    strip.setAttribute('aria-label', 'Look preset');
    for (const p of PRESETS) {
      const card = el('button', 'yui-preset');
      card.type = 'button';
      card.dataset.id = p.id;
      card.setAttribute('role', 'radio');
      card.title = p.hint;
      const chip = el('span', 'yui-preset__chip');
      chip.style.setProperty('--a', p.swatch[0]);
      chip.style.setProperty('--b', p.swatch[1]);
      card.setAttribute('aria-label', p.name);
      card.append(chip, el('span', 'yui-preset__name', p.short || p.name));
      card.addEventListener('click', () => applyPreset(p.id));
      strip.append(card);
    }
    wrap.append(strip);

    syncers.add(() => {
      for (const c of strip.children) c.setAttribute('aria-checked', String(c.dataset.id === state.preset));
      const custom = state.preset === 'custom';
      tag.textContent = custom ? 'Custom' : (PRESETS.find((p) => p.id === state.preset)?.hint || '');
      tag.classList.toggle('is-custom', custom);
    });
    return wrap;
  }

  /* --- the panels ----------------------------------------------------------------- */

  function panel(kind) {
    const node = el('div', 'yui-controls-panel');
    node.append(preview(kind));
    if (kind === 'appearance') {
      node.append(
        select('siteGradient', 'Gradient'),
        range('surfaceOpacity', 'Surface'),
        range('surfaceBlur', 'Blur'),
        range('radius', 'Radius'),
        range('shadow', 'Shadow'),
        range('density', 'Density'),
      );
    }
    if (kind === 'tile') {
      node.append(
        segmented('tileShape', 'Shape'),
        select('tileTone', 'Frame'),
        segmented('tileLift', 'Lift'),
        range('tileDim', 'Image dim'),
        range('tileClamp', 'Title'),
        segmented('ratingStyle', 'Rating'),
      );
    }
    if (kind === 'button') {
      node.append(
        segmented('buttonShape', 'Shape'),
        select('buttonTone', 'Colour'),
        segmented('buttonFinish', 'Finish'),
        range('buttonBlur', 'Blur'),
        range('buttonOpacity', 'Opacity'),
        range('buttonBorder', 'Border'),
        range('buttonShadow', 'Shadow'),
        range('buttonHeight', 'Height'),
        range('buttonWeight', 'Weight'),
        segmented('buttonAlign', 'Align'),
        segmented('buttonCase', 'Case'),
        segmented('buttonIcon', 'Icon'),
        range('buttonIconGap', 'Icon gap'),
      );
    }
    if (kind === 'cta') {
      node.append(
        segmented('ctaShape', 'Shape'),
        select('ctaTone', 'Colour'),
        segmented('ctaFinish', 'Finish'),
        range('ctaBlur', 'Blur'),
        segmented('ctaWidth', 'Width'),
        range('ctaEmphasis', 'Emphasis'),
        range('ctaAngle', 'Angle'),
        range('ctaShadow', 'Shadow'),
        segmented('ctaAlign', 'Align'),
        segmented('ctaIcon', 'Icon'),
        range('ctaHover', 'Hover'),
      );
    }
    return node;
  }

  function accordion(title, hint, content, kind) {
    const details = el('details', 'yui-acc yui-acc--' + kind);
    const summary = el('summary', 'yui-acc__summary');
    const words = el('span', 'yui-acc__words');
    words.append(el('strong', null, title), el('small', null, hint));
    summary.append(words, el('i', 'yui-acc__chev'));
    const body = el('div', 'yui-acc__body');
    body.append(content);
    details.append(summary, body);
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      for (const other of details.parentElement.querySelectorAll(':scope > .yui-acc[open]')) {
        if (other !== details) other.open = false;
      }
      /* The one that just opened is often below the fold, because the four
         above it are still in the scroller. Bring its heading up rather than
         leaving the reader to find it. */
      requestAnimationFrame(() => {
        try { summary.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
      });
    });
    return details;
  }

  /* --- folding the existing sheet --------------------------------------------- */

  function curateTags(section) {
    if (!section || section.dataset.yuiCurated) return;
    section.dataset.yuiCurated = '1';
    for (const input of section.querySelectorAll('select')) {
      const option = [...input.options].find((item) => item.value === 'custom');
      if (option) option.remove();
      if (input.value === 'custom') { input.value = ''; input.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    const custom = section.querySelector('.ylk__custom');
    if (custom) custom.hidden = true;
    const note = el('p', 'yui-curated-note', 'Curated palettes only, so tags stay readable together.');
    (section.querySelector('.ylk__preview') || section.querySelector('.ylk__sechead'))?.after(note);
  }

  function mount() {
    const sheet = document.getElementById('yomu-look-sheet');
    const body = sheet?.querySelector('.ylk__body');
    if (!sheet || !body || body.dataset.yuiAccordions) return false;
    const sections = [...body.querySelectorAll(':scope > .ylk__sec')];
    if (!sections.length) return false;
    const find = (name) => sections.find((s) =>
      s.querySelector(':scope > .ylk__sechead h3')?.textContent?.trim().toLowerCase() === name.toLowerCase());
    const mode = find('Mode'), accent = find('Accent'), skin = find('Skin'), tags = find('Tags'), covers = find('Covers');
    if (!tags || !covers) return false;

    body.dataset.yuiAccordions = '1';
    body.classList.add('yui-accordion-host');
    curateTags(tags);

    const appearance = el('div', 'yui-stack');
    for (const section of [mode, accent, skin]) if (section) { section.classList.add('yui-inner-sec'); appearance.append(section); }
    appearance.append(panel('appearance'));

    const tile = el('div', 'yui-stack');
    covers.classList.add('yui-inner-sec');
    const coverTitle = covers.querySelector(':scope > .ylk__sechead h3');
    if (coverTitle) coverTitle.textContent = 'Cover shade';
    tile.append(panel('tile'), covers);
    tags.classList.add('yui-inner-sec');

    const frag = document.createDocumentFragment();
    frag.append(
      presetRow(),
      accordion('Appearance', 'Mode, accent, skin & surfaces', appearance, 'appearance'),
      accordion('Tiles', 'Shape, tone, dim & rating', tile, 'tile'),
      accordion('Tags', 'Glass chips & per-tag styling', tags, 'tag'),
      accordion('Buttons', 'Secondary controls across Yomu', panel('button'), 'button'),
      accordion('CTA', 'Primary reading actions', panel('cta'), 'cta'),
    );
    body.prepend(frag);

    const resetButton = sheet.querySelector('.ylk__foot .ylk__btn:not(.ylk__btn--primary)');
    if (resetButton && !resetButton.dataset.yuiReset) {
      resetButton.dataset.yuiReset = '1';
      resetButton.textContent = 'Reset look';
      resetButton.addEventListener('click', reset);
    }
    apply();
    return true;
  }

  const pass = () => { mount(); };

  const api = {
    DEFAULTS, CHOICES, NUMBERS, PRESETS,
    /* Kept for anything still reading the first version's shape. */
    OPTIONS: CHOICES,
    get: () => ({ ...state }),
    set, applyPreset, reset, normalize, presetOf,
    repaint: pass,
  };
  if (typeof window !== 'undefined') window.YomuControls = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULTS, CHOICES, NUMBERS, PRESETS, normalize, presetOf, matches };
  }

  if (browser) {
    apply();
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', pass);
    else pass();
    let frame = 0;
    new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; pass(); });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
