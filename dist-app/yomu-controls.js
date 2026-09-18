(() => {
  'use strict';
  if (typeof document === 'undefined') return;

  const KEY = 'yomu.v1.controls';
  const DEFAULTS = {
    siteGradient: 'default', tileShape: 'soft', tileTone: 'neutral',
    buttonShape: 'round', buttonTone: 'accent', buttonFinish: 'soft',
    ctaShape: 'pill', ctaTone: 'accent', ctaFinish: 'gradient',
  };
  const OPTIONS = {
    siteGradient: [['default','Yomu original'],['aurora','Aurora'],['ocean','Midnight ocean'],['ember','Ember dusk'],['violet','Violet haze'],['forest','Forest ink']],
    tileShape: [['soft','Soft corners'],['round','Rounder'],['compact','Compact']],
    tileTone: [['neutral','Neutral'],['accent','Accent glow'],['cool','Cool glass'],['warm','Warm glass']],
    buttonShape: [['round','Rounded'],['pill','Pill'],['compact','Compact']],
    buttonTone: [['accent','Accent'],['ocean','Ocean'],['violet','Violet'],['jade','Jade'],['coral','Coral'],['neutral','Neutral']],
    buttonFinish: [['soft','Soft'],['glass','Glass'],['outline','Outline']],
    ctaShape: [['pill','Pill'],['round','Rounded'],['square','Compact']],
    ctaTone: [['accent','Accent'],['sunset','Sunset'],['ocean','Ocean'],['violet','Violet'],['jade','Jade']],
    ctaFinish: [['gradient','Gradient'],['solid','Solid'],['glass','Glass']],
  };
  const SELECTS = new Map();
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  function read() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch {}
    const out = {};
    for (const [name, choices] of Object.entries(OPTIONS)) {
      const ids = choices.map(([id]) => id);
      out[name] = ids.includes(raw[name]) ? raw[name] : DEFAULTS[name];
    }
    return out;
  }
  let state = read();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

  function apply() {
    const html = document.documentElement;
    for (const key of Object.keys(DEFAULTS)) {
      html.dataset['yui' + key[0].toUpperCase() + key.slice(1)] = state[key];
    }
    for (const [name, select] of SELECTS) select.value = state[name];
    dispatchEvent(new CustomEvent('yomu:controls', { detail: { ...state } }));
  }
  function set(name, value) {
    if (!(OPTIONS[name] || []).some(([id]) => id === value)) return;
    state = { ...state, [name]: value };
    save(); apply();
  }
  function reset() { state = { ...DEFAULTS }; save(); apply(); }

  function select(name, label) {
    const row = el('label', 'yui-field');
    row.append(el('span', 'yui-field__label', label));
    const input = el('select', 'ylk__select yui-select');
    for (const [id, text] of OPTIONS[name]) {
      const option = el('option', null, text); option.value = id; input.append(option);
    }
    input.addEventListener('change', () => set(name, input.value));
    SELECTS.set(name, input); row.append(input); return row;
  }

  function preview(kind) {
    const box = el('div', 'yui-preview yui-preview--' + kind); box.setAttribute('aria-hidden', 'true');
    if (kind === 'appearance') box.append(el('div', 'yui-site-sample', 'Yomu'));
    if (kind === 'tile') {
      const card = el('div', 'yui-tile-sample');
      const chip = window.YomuTags?.chip ? window.YomuTags.chip('rating', '8.7', { size: 'xs' }) : el('span', 'yui-fallback-chip', '★ 8.7');
      const copy = el('div', 'yui-tile-sample__copy'); copy.append(el('strong', null, 'The Fox Club'), el('small', null, 'Chapter 41'));
      card.append(chip, copy); box.append(card);
    }
    if (kind === 'button') box.append(el('button', 'yui-button-sample', 'Library'), el('button', 'yui-button-sample yui-button-sample--icon', '☆'));
    if (kind === 'cta') box.append(el('button', 'yui-cta-sample', 'Start reading'));
    return box;
  }

  function panel(kind) {
    const node = el('div', 'yui-controls-panel'); node.append(preview(kind));
    if (kind === 'appearance') node.append(select('siteGradient', 'Website gradient'));
    if (kind === 'tile') node.append(select('tileShape', 'Shape'), select('tileTone', 'Frame tone'));
    if (kind === 'button') node.append(select('buttonShape', 'Shape'), select('buttonTone', 'Colour'), select('buttonFinish', 'Finish'));
    if (kind === 'cta') node.append(select('ctaShape', 'Shape'), select('ctaTone', 'Colour'), select('ctaFinish', 'Finish'));
    return node;
  }

  function accordion(title, hint, content, kind) {
    const details = el('details', 'yui-acc yui-acc--' + kind);
    const summary = el('summary', 'yui-acc__summary');
    const words = el('span', 'yui-acc__words'); words.append(el('strong', null, title), el('small', null, hint));
    summary.append(words, el('i', 'yui-acc__chev'));
    const body = el('div', 'yui-acc__body'); body.append(content); details.append(summary, body);
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      for (const other of details.parentElement.querySelectorAll(':scope > .yui-acc[open]')) if (other !== details) other.open = false;
    });
    return details;
  }

  function curateTags(section) {
    if (!section || section.dataset.yuiCurated) return;
    section.dataset.yuiCurated = '1';
    for (const input of section.querySelectorAll('select')) {
      const option = [...input.options].find((item) => item.value === 'custom');
      if (option) option.remove();
      if (input.value === 'custom') { input.value = ''; input.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    const custom = section.querySelector('.ylk__custom'); if (custom) custom.hidden = true;
    const note = el('p', 'yui-curated-note', 'Curated palettes only, so tags stay readable together.');
    (section.querySelector('.ylk__preview') || section.querySelector('.ylk__sechead'))?.after(note);
  }

  function mount() {
    const sheet = document.getElementById('yomu-look-sheet');
    const body = sheet?.querySelector('.ylk__body');
    if (!sheet || !body || body.dataset.yuiAccordions) return false;
    const sections = [...body.querySelectorAll(':scope > .ylk__sec')];
    if (!sections.length) return false;
    const find = (name) => sections.find((s) => s.querySelector(':scope > .ylk__sechead h3')?.textContent?.trim().toLowerCase() === name.toLowerCase());
    const mode = find('Mode'), accent = find('Accent'), skin = find('Skin'), tags = find('Tags'), covers = find('Covers');
    if (!tags || !covers) return false;

    body.dataset.yuiAccordions = '1'; body.classList.add('yui-accordion-host'); curateTags(tags);
    const appearance = el('div', 'yui-stack');
    for (const section of [mode, accent, skin]) if (section) { section.classList.add('yui-inner-sec'); appearance.append(section); }
    appearance.append(panel('appearance'));

    const tile = el('div', 'yui-stack'); covers.classList.add('yui-inner-sec');
    const coverTitle = covers.querySelector(':scope > .ylk__sechead h3'); if (coverTitle) coverTitle.textContent = 'Cover shade';
    tile.append(panel('tile'), covers); tags.classList.add('yui-inner-sec');

    const frag = document.createDocumentFragment();
    frag.append(
      accordion('Appearance', 'Mode, accent, skin & gradient', appearance, 'appearance'),
      accordion('Tiles', 'Shape, frame tone & cover shade', tile, 'tile'),
      accordion('Tags', 'Glass chips & per-tag styling', tags, 'tag'),
      accordion('Buttons', 'Secondary controls across Yomu', panel('button'), 'button'),
      accordion('CTA', 'Primary reading actions', panel('cta'), 'cta'),
    );
    body.prepend(frag);

    const resetButton = sheet.querySelector('.ylk__foot .ylk__btn:not(.ylk__btn--primary)');
    if (resetButton && !resetButton.dataset.yuiReset) {
      resetButton.dataset.yuiReset = '1'; resetButton.textContent = 'Reset look'; resetButton.addEventListener('click', reset);
    }
    apply(); return true;
  }

  function pass() { mount(); }
  window.YomuControls = { DEFAULTS, OPTIONS, get: () => ({ ...state }), set, reset, repaint: pass };
  apply();
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', pass); else pass();
  let frame = 0;
  new MutationObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; pass(); });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
