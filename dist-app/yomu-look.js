/**
 * Customize look -- the reader's own colours, on this device.
 *
 * Aurora and Paper are the modes, the accent is a tone, a skin is a look
 * earned by reading. This is the fourth thing: knobs. Which mode, which
 * accent, which skin, and how the glass tags on the tiles are drawn -- their
 * gradient, one for every tag or one per tag, how filled, how frosted, how
 * blurred, whether they cast a shadow, at what angle -- and how deep the
 * shade under a cover's copy goes. Every knob ends as a custom property or
 * an attribute on <html>, so the stylesheets do the drawing (yomu-tags.css
 * has the hooks) and this file never paints a pixel of its own.
 *
 * Nothing here is a mode of its own. The mode and the accent are written to
 * the keys the app and yomu-shell.js already read ('yomu.appearance',
 * 'yomu.v1.accent'), the skin goes through yomu-skins.js, and only the tag
 * and cover knobs are this file's to keep, in 'yomu.v1.look'.
 *
 * The gradient editor is grapick (MIT, vendored under /vendor/grapick),
 * loaded the first time the custom gradient is opened and never before: a
 * reader who never draws a gradient never downloads it.
 *
 * Opened from Mori's tap menu (yomu-mori.js) and from Your Yomu (#yomu-look).
 */
(() => {
  'use strict';

  const KEY = 'yomu.v1.look';
  const SHEET_ID = 'yomu-look-sheet';
  const SCRIM_ID = 'yomu-look-scrim';
  const HOST_ID = 'yomu-look';
  const MODE_KEY = 'yomu.appearance';
  const ACCENT_KEY = 'yomu.v1.accent';
  const GRAPICK = { js: '/vendor/grapick/grapick.min.js', css: '/vendor/grapick/grapick.min.css' };

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
  const readText = (key, fallback) => {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  };
  const writeText = (key, value) => {
    try { localStorage.setItem(key, value); } catch {}
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

  /* --- the knobs ----------------------------------------------------------- *
   *
   * The values are the pack's own (yomu-tags.css), so "default" means "as
   * shipped" and an untouched look sets nothing at all.
   */

  const DEFAULTS = Object.freeze({
    palette: '',          // '' per tag, as shipped · a preset for every tag · 'custom'
    kinds: Object.freeze({}), // per-tag overrides: { hot: 'sunset' }
    custom: Object.freeze(['#ffb02e', '#ff2d9a', '#8b2bf2', '#17b6ff']), // glow, start, middle, end
    angle: 100,           // degrees
    fill: 62,             // percent: 0 clear, 100 solid paint
    frost: 10,            // percent: the flat veil that lifts text off busy art
    blur: 0,              // px of backdrop blur; the pack ships without any
    lift: false,          // the cast shadow; chips on tiles are flat as shipped
    shade: 100,           // percent: the shade under a cover's copy
  });

  const PRESETS = ['aurora', 'sunset', 'ocean', 'ember', 'matcha', 'sakura', 'ink'];
  const PALETTES = ['', ...PRESETS, 'custom'];
  /** Every tag kind yomu-tags.js knows, with the word the sheet shows for it. */
  const KINDS = [
    ['fresh', 'New chapter'], ['updated', 'Updated'], ['completed', 'Completed'],
    ['progress', 'Chapter'], ['circle', 'Circle'], ['rating', 'Rating'], ['hot', 'Hot'],
    ['trending', 'Trending'], ['gem', 'Gem'], ['new', 'New'],
  ];
  const MODES = [['dark', 'Aurora', 'Dark'], ['light', 'Paper', 'Light'], ['system', 'System', 'Follows the device']];

  /* Mirrors the table at the top of yomu-shell.js, which applies the chosen
     accent on every page load; this applies it on the spot. Keep the two in
     step: each tone is an Aurora pair and a Paper pair, and the stylesheet
     picks by ground. */
  const ACCENTS = [
    { id: '', name: 'Amber', hex: '#ffc45f' },
    { id: 'blue', name: 'Periwinkle', hex: '#9db8ff', tone: [['#9db8ff', '#111a2e'], ['#5681f1', '#fff8ec']] },
    { id: 'green', name: 'Jade', hex: '#7fd6b0', tone: [['#7fd6b0', '#0d241c'], ['#179960', '#fff8ec']] },
    { id: 'coral', name: 'Coral', hex: '#ff968c', tone: [['#ff968c', '#2c1110'], ['#ef4d3e', '#fff8ec']] },
    { id: 'violet', name: 'Violet', hex: '#d3a2ff', tone: [['#d3a2ff', '#231133'], ['#ae61f2', '#fff8ec']] },
  ];
  const ACCENT_PROPS = ['--ua-d', '--ua-d-ink', '--ua-d-soft', '--ua-d-line', '--ua-l', '--ua-l-ink', '--ua-l-soft', '--ua-l-line'];

  const HEX = /^#[0-9a-f]{6}$/i;
  const clamp = (n, lo, hi, fallback) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };

  /** Pure: whatever was stored -> a look with every knob valid. */
  function normalize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const kinds = {};
    if (r.kinds && typeof r.kinds === 'object') {
      for (const [k, v] of Object.entries(r.kinds)) {
        if (v && KINDS.some(([id]) => id === k) && PALETTES.includes(v)) kinds[k] = v;
      }
    }
    const custom = Array.isArray(r.custom) && r.custom.length === 4 && r.custom.every((c) => HEX.test(String(c)))
      ? r.custom.map((c) => String(c).toLowerCase())
      : DEFAULTS.custom.slice();
    return {
      palette: PALETTES.includes(r.palette) ? r.palette : '',
      kinds,
      custom,
      angle: clamp(r.angle, 0, 360, DEFAULTS.angle),
      fill: clamp(r.fill, 0, 100, DEFAULTS.fill),
      frost: clamp(r.frost, 0, 60, DEFAULTS.frost),
      blur: clamp(r.blur, 0, 16, DEFAULTS.blur),
      lift: typeof r.lift === 'boolean' ? r.lift : DEFAULTS.lift,
      shade: clamp(r.shade, 30, 100, DEFAULTS.shade),
    };
  }

  /** Pure: the preset a chip of this kind wears under this look, or '' for its own. */
  function paletteFor(kind, look) {
    return (look.kinds && look.kinds[kind]) || look.palette || '';
  }

  /** Pure: does any knob sit off the default? */
  function isDefault(look) {
    return JSON.stringify(normalize(look)) === JSON.stringify(normalize(DEFAULTS));
  }

  /** Pure: does the look draw the custom gradient anywhere? */
  const usesCustom = (look) => look.palette === 'custom' || Object.values(look.kinds || {}).includes('custom');

  /**
   * Pure: grapick's stops -> the chip's three colours.
   *
   * Sorted by position; the first is the start, the last the end, and the
   * middle is whichever inner stop sits nearest the centre -- or the start
   * again when there are only two, which draws the pack's `c1, c2 50%, c3`
   * as a plain two-colour sweep. Anything that is not a six-digit hex is
   * dropped rather than guessed at.
   */
  function stopsToColours(stops) {
    const rows = (stops || [])
      .map((s) => ({ color: String(s && s.color || '').toLowerCase(), position: Number(s && s.position) }))
      .filter((s) => HEX.test(s.color) && Number.isFinite(s.position))
      .sort((a, b) => a.position - b.position);
    if (rows.length < 2) return null;
    const first = rows[0];
    const last = rows[rows.length - 1];
    let mid = first;
    if (rows.length > 2) {
      mid = rows.slice(1, -1).reduce((best, s) => (Math.abs(s.position - 50) < Math.abs(best.position - 50) ? s : best));
    }
    return [first.color, mid.color, last.color];
  }

  /* --- state ----------------------------------------------------------------- */

  let look = normalize(readJSON(KEY, null));
  const save = () => writeJSON(KEY, look);

  const root = () => document.documentElement;

  /**
   * Every knob becomes an attribute-plus-property pair on <html>, and only
   * when it is off the default: yomu-tags.css keys each override on its own
   * attribute, so an untouched knob leaves the pack's own cascade alone.
   */
  function applyLook() {
    if (!browser) return;
    const html = root();
    const knob = (attr, on, prop, value) => {
      if (on) { html.setAttribute(attr, ''); html.style.setProperty(prop, value); }
      else { html.removeAttribute(attr); html.style.removeProperty(prop); }
    };
    knob('data-yl-fill', look.fill !== DEFAULTS.fill, '--yl-fill', String(look.fill / 100));
    knob('data-yl-frost', look.frost !== DEFAULTS.frost, '--yl-frost', String(look.frost / 100));
    knob('data-yl-blur', look.blur > 0, '--yl-blur', look.blur + 'px');
    knob('data-yl-lift', look.lift !== DEFAULTS.lift, '--yl-lift', look.lift ? '1' : '0');
    knob('data-yl-shade', look.shade !== DEFAULTS.shade, '--yl-shade', String(look.shade / 100));
    /* The angle is defined on :root by the stylesheet, so an inline value on
       <html> beats it outright and needs no hook of its own. */
    if (look.angle !== DEFAULTS.angle) html.style.setProperty('--ytg-angle', look.angle + 'deg');
    else html.style.removeProperty('--ytg-angle');
    const custom = usesCustom(look);
    ['c0', 'c1', 'c2', 'c3'].forEach((name, i) => {
      if (custom) html.style.setProperty('--yl-' + name, look.custom[i]);
      else html.style.removeProperty('--yl-' + name);
    });
    repaintChips();
  }

  /**
   * The chips already on the page wear the preset yomu-tags.js gave them.
   * This walks them and swaps the preset where the look says otherwise, and
   * back to their own when it stops saying so. An attribute write does not
   * wake the childList observers the other files run, so this cannot start
   * a loop with them.
   */
  function repaintChips() {
    const WEAR = (window.YomuTags && window.YomuTags.WEAR) || {};
    for (const chip of document.querySelectorAll('.ytg[data-ytg-kind]')) {
      const kind = chip.dataset.ytgKind;
      const want = paletteFor(kind, look) || (WEAR[kind] && WEAR[kind].palette) || chip.getAttribute('data-ytg');
      if (want && chip.getAttribute('data-ytg') !== want) chip.setAttribute('data-ytg', want);
    }
  }

  function set(patch, opts) {
    const quiet = !!(opts && opts.quiet);
    look = normalize({ ...look, ...patch });
    save();
    applyLook();
    if (!quiet && patch && 'custom' in patch) seedEditor();
    if (patch && 'angle' in patch && editor) editor.setDirection(look.angle + 'deg');
    paintSheet();
    paintHost();
    if (browser) dispatchEvent(new CustomEvent('yomu:look', { detail: { look: { ...look } } }));
  }

  function resetLook() {
    look = normalize({});
    save();
    applyLook();
    seedEditor();
    if (editor) editor.setDirection(look.angle + 'deg');
    paintSheet();
    paintHost();
    if (browser) dispatchEvent(new CustomEvent('yomu:look', { detail: { look: { ...look } } }));
  }

  /* --- mode ------------------------------------------------------------------ */

  /** The mode on screen now, resolved: 'light' or 'dark'. No attribute is
   *  Paper: yomu-skin.css maps :root:not([data-mode='dark']) to the Paper
   *  tokens, and the hand-written pages leave it off until storage says. */
  function mode() {
    const m = root().dataset.mode;
    if (m === 'dark') return 'dark';
    if (m === 'system') return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    return 'light';
  }

  /** The stored preference: 'dark', 'light' or 'system'. Nothing stored means
   *  whatever the app resolved for this page, which is what the reader sees. */
  const modePref = () => {
    const v = readText(MODE_KEY, '');
    return v === 'light' || v === 'dark' || v === 'system' ? v : mode();
  };

  /**
   * Set the mode the way the app's own header button does, and through that
   * button when it is on the page, so React's sun-or-moon follows. The button
   * only knows light and dark; System is written directly, as the value
   * yomu-skin.css resolves against the OS on its own.
   */
  function setMode(next) {
    const html = root();
    if (next === 'system') {
      html.dataset.mode = 'system';
      writeText(MODE_KEY, 'system');
    } else {
      const button = document.querySelector('.header-tools .icon-button[aria-label^="Switch to"]');
      const current = html.dataset.mode === 'light' ? 'light' : 'dark';
      if (button && html.dataset.mode !== 'system' && current !== next) button.click();
      else {
        html.dataset.mode = next;
        writeText(MODE_KEY, next);
      }
    }
    dispatchEvent(new CustomEvent('yomu:mode', { detail: { mode: next } }));
    paintSheet();
    paintHost();
  }

  const toggleMode = () => setMode(mode() === 'light' ? 'dark' : 'light');

  /* --- accent ---------------------------------------------------------------- */

  const accent = () => {
    const id = readText(ACCENT_KEY, '');
    return ACCENTS.some((a) => a.id === id) ? id : '';
  };

  function applyAccent(id) {
    const html = root();
    const tone = (ACCENTS.find((a) => a.id === id) || {}).tone;
    /* Your Yomu's own picker pins --accent itself on that page; lifted here
       so the by-ground mapping in yomu-skin.css is what decides, on every
       page alike. */
    for (const prop of ['--accent', '--accentText', '--accentSoft', '--accentLine']) html.style.removeProperty(prop);
    if (!tone) { ACCENT_PROPS.forEach((prop) => html.style.removeProperty(prop)); return; }
    const [[dark, darkInk], [light, lightInk]] = tone;
    html.style.setProperty('--ua-d', dark);
    html.style.setProperty('--ua-d-ink', darkInk);
    html.style.setProperty('--ua-d-soft', dark + '1f');
    html.style.setProperty('--ua-d-line', dark + '66');
    html.style.setProperty('--ua-l', light);
    html.style.setProperty('--ua-l-ink', lightInk);
    html.style.setProperty('--ua-l-soft', light + '1f');
    html.style.setProperty('--ua-l-line', light + '66');
  }

  function setAccent(id) {
    if (!ACCENTS.some((a) => a.id === id)) return;
    writeText(ACCENT_KEY, id);
    applyAccent(id);
    dispatchEvent(new CustomEvent('yomu:accent', { detail: { id } }));
    paintSheet();
    paintHost();
  }

  /* --- grapick, on demand ---------------------------------------------------- */

  let grapickLoading = null;
  let editor = null;
  let mounting = false;
  let seeding = false;

  function loadGrapick() {
    if (window.Grapick) return Promise.resolve(window.Grapick);
    if (grapickLoading) return grapickLoading;
    grapickLoading = new Promise((resolve, reject) => {
      if (!document.querySelector('link[href="' + GRAPICK.css + '"]')) {
        const link = el('link');
        link.rel = 'stylesheet';
        link.href = GRAPICK.css;
        document.head.append(link);
      }
      const script = el('script');
      script.src = GRAPICK.js;
      script.onload = () => (window.Grapick ? resolve(window.Grapick) : reject(new Error('grapick did not define itself')));
      script.onerror = () => reject(new Error('grapick did not load'));
      document.head.append(script);
    });
    return grapickLoading;
  }

  /** The editor's stops from the look: start, middle, end. */
  function seedEditor() {
    if (!editor) return;
    seeding = true;
    try {
      editor.clear();
      const [, c1, c2, c3] = look.custom;
      editor.addHandler(0, c1);
      editor.addHandler(50, c2);
      editor.addHandler(100, c3);
    } finally { seeding = false; }
  }

  async function mountGradient() {
    if (editor || mounting || !ui.grapick) return;
    mounting = true;
    try {
      const mod = await loadGrapick();
      const G = mod.default || mod;
      ui.grapick.textContent = '';
      const target = el('div', 'ylk__grpel');
      ui.grapick.append(target);
      editor = new G({ el: target, direction: look.angle + 'deg', height: '28px', pfx: 'grp' });
      seedEditor();
      editor.on('change', () => {
        if (seeding) return;
        const stops = editor.getHandlers().map((h) => ({ color: h.getColor(), position: h.getPosition() }));
        const colours = stopsToColours(stops);
        if (!colours) return;
        const next = [look.custom[0], ...colours];
        if (next.join() !== look.custom.join()) set({ custom: next }, { quiet: true });
      });
    } catch {
      if (ui.grapick) {
        ui.grapick.textContent = '';
        ui.grapick.append(el('span', 'ylk__hint', 'The gradient editor could not load. The preset gradients still work.'));
      }
    } finally { mounting = false; }
  }

  /* --- the sheet -------------------------------------------------------------- */

  const ui = {};

  function section(title, hint) {
    const sec = el('section', 'ylk__sec');
    const head = el('div', 'ylk__sechead');
    head.append(el('h3', null, title));
    if (hint) head.append(el('span', 'ylk__hint', hint));
    sec.append(head);
    return sec;
  }

  function segmented(name, options, onPick) {
    const row = el('div', 'ylk__seg');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', name);
    for (const [id, label, hint] of options) {
      const b = el('button', 'ylk__segbtn');
      b.type = 'button';
      b.dataset.id = id;
      b.setAttribute('role', 'radio');
      b.append(el('span', null, label));
      if (hint) b.title = hint;
      b.addEventListener('click', () => onPick(id));
      row.append(b);
    }
    return row;
  }
  const markSeg = (row, id) => {
    for (const b of row.children) b.setAttribute('aria-checked', String(b.dataset.id === id));
  };

  function range(label, min, max, step, unit, get, put) {
    const row = el('label', 'ylk__range');
    row.append(el('span', 'ylk__label', label));
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const out = el('output');
    input.addEventListener('input', () => put(Number(input.value)));
    row.append(input, out);
    row.sync = () => {
      const v = get();
      if (Number(input.value) !== v) input.value = String(v);
      const text = v + unit;
      if (out.textContent !== text) out.textContent = text;
    };
    return row;
  }

  function select(options, onChange) {
    const s = el('select', 'ylk__select');
    for (const [value, text] of options) {
      const o = el('option', null, text);
      o.value = value;
      s.append(o);
    }
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  const CHEVRON_X = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  function buildSheet() {
    const scrim = el('div', 'ylk-scrim');
    scrim.id = SCRIM_ID;
    scrim.addEventListener('click', close);

    const sheet = el('aside', 'ylk');
    sheet.id = SHEET_ID;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Customize look');

    const head = el('header', 'ylk__head');
    const copy = el('div');
    copy.append(el('strong', null, 'Customize look'), el('small', null, 'Kept on this device'));
    const x = el('button', 'ylk__close');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.innerHTML = CHEVRON_X;
    x.addEventListener('click', close);
    head.append(copy, x);

    const body = el('div', 'ylk__body');

    /* Mode */
    const modeSec = section('Mode');
    ui.mode = segmented('Mode', MODES, setMode);
    modeSec.append(ui.mode);
    body.append(modeSec);

    /* Accent */
    const accentSec = section('Accent', 'Buttons, links, the chosen thing');
    ui.accent = el('div', 'ylk__swatches');
    ui.accent.setAttribute('role', 'radiogroup');
    ui.accent.setAttribute('aria-label', 'Accent colour');
    for (const a of ACCENTS) {
      const b = el('button', 'ylk__sw');
      b.type = 'button';
      b.dataset.id = a.id;
      b.style.background = a.hex;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', a.name);
      b.title = a.name;
      b.addEventListener('click', () => setAccent(a.id));
      ui.accent.append(b);
    }
    accentSec.append(ui.accent);
    body.append(accentSec);

    /* Skin */
    const skinSec = section('Skin', 'A look earned by reading');
    ui.skins = el('div', 'ysk');
    ui.skins.setAttribute('role', 'radiogroup');
    ui.skins.setAttribute('aria-label', 'Skin');
    ui.skinNote = el('p', 'ylk__note');
    skinSec.append(ui.skins, ui.skinNote);
    body.append(skinSec);

    /* Tags */
    const tagSec = section('Tags', 'The glass chips on every tile');
    ui.preview = el('div', 'ylk__preview');
    ui.preview.setAttribute('aria-hidden', 'true');
    tagSec.append(ui.preview);

    const gradRow = el('label', 'ylk__field');
    gradRow.append(el('span', 'ylk__label', 'Gradient'));
    ui.palette = select(
      [['', 'Per tag, as shipped'], ...PRESETS.map((p) => [p, cap(p)]), ['custom', 'Custom, drawn by you']],
      (value) => set({ palette: value }),
    );
    gradRow.append(ui.palette);
    tagSec.append(gradRow);

    ui.custom = el('div', 'ylk__custom');
    ui.custom.hidden = true;
    ui.grapick = el('div', 'ylk__grp');
    ui.grapick.append(el('span', 'ylk__hint', 'Loading the gradient editor…'));
    ui.custom.append(ui.grapick);
    ui.custom.append(el('p', 'ylk__hint', 'Drag a stop to move it, click the bar to add one, its × to remove it. The first, middle and last stops are the chip.'));
    const glowRow = el('label', 'ylk__field ylk__field--inline');
    glowRow.append(el('span', 'ylk__label', 'Glow'));
    ui.glow = el('input');
    ui.glow.type = 'color';
    ui.glow.addEventListener('input', () => set({ custom: [ui.glow.value, ...look.custom.slice(1)] }, { quiet: true }));
    glowRow.append(ui.glow, el('span', 'ylk__hint', 'the colour leaking in at the corner'));
    ui.custom.append(glowRow);
    tagSec.append(ui.custom);

    ui.angle = range('Angle', 0, 360, 5, '°', () => look.angle, (v) => set({ angle: v }));
    ui.fill = range('Fill', 0, 100, 2, '%', () => look.fill, (v) => set({ fill: v }));
    ui.frost = range('Frost', 0, 60, 2, '%', () => look.frost, (v) => set({ frost: v }));
    ui.blur = range('Blur', 0, 16, 1, 'px', () => look.blur, (v) => set({ blur: v }));
    tagSec.append(ui.angle, ui.fill, ui.frost, ui.blur);

    const liftRow = el('label', 'ylk__check');
    ui.lift = el('input');
    ui.lift.type = 'checkbox';
    ui.lift.addEventListener('change', () => set({ lift: ui.lift.checked }));
    liftRow.append(ui.lift, el('span', null, 'Cast a shadow'));
    tagSec.append(liftRow);

    const kinds = el('details', 'ylk__kinds');
    kinds.append(el('summary', null, 'Per tag'));
    ui.kinds = {};
    for (const [id, label] of KINDS) {
      const row = el('label', 'ylk__field');
      row.append(el('span', 'ylk__label', label));
      const s = select(
        [['', 'Default'], ...PRESETS.map((p) => [p, cap(p)]), ['custom', 'Custom']],
        (value) => {
          const next = { ...look.kinds };
          if (value) next[id] = value; else delete next[id];
          set({ kinds: next });
        },
      );
      ui.kinds[id] = s;
      row.append(s);
      kinds.append(row);
    }
    tagSec.append(kinds);
    body.append(tagSec);

    /* Covers */
    const coverSec = section('Covers', 'The shade the title sits on');
    ui.shade = range('Shade', 30, 100, 5, '%', () => look.shade, (v) => set({ shade: v }));
    coverSec.append(ui.shade);
    body.append(coverSec);

    const foot = el('footer', 'ylk__foot');
    const reset = el('button', 'ylk__btn', 'Reset tags and covers');
    reset.type = 'button';
    reset.addEventListener('click', resetLook);
    const done = el('button', 'ylk__btn ylk__btn--primary', 'Done');
    done.type = 'button';
    done.addEventListener('click', close);
    foot.append(reset, done);

    sheet.append(head, body, foot);
    document.body.append(scrim, sheet);
    buildPreview();
    return sheet;
  }

  /** A few chips of every shape, on a dark ground standing in for a cover. */
  function buildPreview() {
    const T = window.YomuTags;
    ui.preview.textContent = '';
    if (!T || !T.chip) {
      ui.preview.append(el('span', 'ylk__hint', 'Tag chips are not loaded on this page.'));
      return;
    }
    const samples = [
      ['fresh', 'New chapter', 'sm'], ['completed', 'Completed', 'sm'], ['progress', 'Ch. 41', 'sm'],
      ['hot', 'Hot', 'xs'], ['rating', '8.7', 'xs'], ['gem', 'Gem', 'xs'], ['trending', 'Trending', 'xs'],
    ];
    for (const [kind, text, size] of samples) ui.preview.append(T.chip(kind, text, { size }));
  }

  function paintSkins() {
    const S = window.YomuSkins;
    const P = window.YomuProgress;
    ui.skins.textContent = '';
    if (!S) { ui.skinNote.textContent = 'Skins are not loaded on this page.'; return; }
    const state = P && P.get ? P.get() : null;
    const level = P && P.stageOf ? (P.stageOf().level || 0) : 0;
    const chosen = S.current();
    for (const skin of S.SKINS) {
      const open = S.unlocked(skin, state, level);
      const b = el('button', 'ysk__chip' + (open ? '' : ' is-locked') + (skin.id === chosen ? ' is-on' : ''));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(skin.id === chosen));
      b.setAttribute('aria-label', skin.name + (open ? '' : ', locked: ' + skin.how));
      const sw = el('span', 'ysk__swatch');
      sw.style.background = 'linear-gradient(135deg, ' + skin.swatch[0] + ' 0 50%, ' + skin.swatch[1] + ' 50% 100%)';
      const dot = el('i');
      dot.style.background = skin.swatch[2];
      sw.append(dot);
      b.append(sw, el('span', 'ysk__name', skin.name));
      b.addEventListener('click', () => {
        if (!open) { ui.skinNote.textContent = skin.name + ' unlocks when ' + lower(skin.how) + '.'; return; }
        ui.skinNote.textContent = skin.id ? skin.name + ' is on.' : 'Back to Aurora and Paper.';
        S.choose(skin.id);
        paintSkins();
        paintHost();
      });
      ui.skins.append(b);
    }
    if (!ui.skinNote.textContent) ui.skinNote.textContent = 'A skin wins over the mode while it is on. Your accent still applies.';
  }

  function paintSheet() {
    if (!document.getElementById(SHEET_ID)) return;
    markSeg(ui.mode, modePref());
    const a = accent();
    for (const b of ui.accent.children) b.setAttribute('aria-checked', String(b.dataset.id === a));
    paintSkins();
    if (ui.palette.value !== look.palette) ui.palette.value = look.palette;
    const custom = usesCustom(look);
    ui.custom.hidden = !custom;
    if (custom) mountGradient();
    if (ui.glow.value !== look.custom[0]) ui.glow.value = look.custom[0];
    for (const r of [ui.angle, ui.fill, ui.frost, ui.blur, ui.shade]) r.sync();
    if (ui.lift.checked !== look.lift) ui.lift.checked = look.lift;
    for (const [id] of KINDS) {
      const want = look.kinds[id] || '';
      if (ui.kinds[id].value !== want) ui.kinds[id].value = want;
    }
  }

  function open() {
    if (!browser) return;
    let sheet = document.getElementById(SHEET_ID);
    if (!sheet) sheet = buildSheet();
    paintSheet();
    sheet.classList.add('is-on');
    document.getElementById(SCRIM_ID)?.classList.add('is-on');
    const first = sheet.querySelector('.ylk__close');
    if (first) first.focus();
  }

  function close() {
    if (!browser) return;
    document.getElementById(SHEET_ID)?.classList.remove('is-on');
    document.getElementById(SCRIM_ID)?.classList.remove('is-on');
  }

  const isOpen = () => !!document.getElementById(SHEET_ID)?.classList.contains('is-on');

  /* --- Your Yomu: the door on the page --------------------------------------- */

  function paintHost() {
    if (!browser) return;
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    if (!host.dataset.built) {
      host.dataset.built = '1';
      const card = el('div', 'ylk-host');
      const line = el('p', 'ylk-host__line');
      const btn = el('button', 'ylk-host__btn', 'Open customizer');
      btn.type = 'button';
      btn.addEventListener('click', open);
      card.append(line, btn);
      host.append(card);
      ui.hostLine = line;
    }
    const S = window.YomuSkins;
    const skinName = S ? ((S.SKINS.find((s) => s.id === S.current()) || {}).name || 'Yomu') : null;
    const parts = [
      (MODES.find((m) => m[0] === modePref()) || MODES[0])[1],
      (ACCENTS.find((a) => a.id === accent()) || ACCENTS[0]).name + ' accent',
      skinName ? skinName + ' skin' : null,
      isDefault(look) ? 'tags as shipped' : 'tags your way',
    ].filter(Boolean);
    const text = parts.join(' · ') + '. Mode, accent, skin, the tag chips and the cover shade, in one sheet.';
    if (ui.hostLine && ui.hostLine.textContent !== text) ui.hostLine.textContent = text;
  }

  /* --- boot ------------------------------------------------------------------- */

  const api = {
    DEFAULTS, PRESETS, KINDS, normalize, paletteFor, stopsToColours, isDefault,
    get: () => ({ ...look, kinds: { ...look.kinds }, custom: look.custom.slice() }),
    set, reset: resetLook, repaint: applyLook,
    mode, modePref, setMode, toggleMode,
    accent, setAccent,
    open, close, isOpen,
  };

  if (typeof window !== 'undefined') window.YomuLook = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULTS, PRESETS, normalize, paletteFor, stopsToColours, isDefault };
  }

  if (browser) {
    /* Applied at once, before anything paints, so the first frame already
       wears the look; the chips are re-palettes as they arrive. */
    applyLook();
    const boot = () => { applyLook(); paintHost(); };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
    else boot();

    /* Coalesced into a frame, like yomu-shell.js: React discards and redraws
       whole subtrees, and a pass per mutation would run during hydration. */
    let frame = 0;
    new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; repaintChips(); paintHost(); });
    }).observe(document.documentElement, { childList: true, subtree: true });

    addEventListener('yomu:skin', paintSheet);
    addEventListener('yomu:progress', paintSheet);
    addEventListener('keydown', (event) => { if (event.key === 'Escape' && isOpen()) close(); });
  }
})();
