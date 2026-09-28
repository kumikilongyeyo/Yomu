/** Reader Reliability Pass: preferences and bounded, true paged rendering. */
(() => {
  'use strict';
  const KEY = 'yomu.v2.reader.settings';
  const defaults = { width: 900, gap: 0, rtl: false, quality: 'original', continuous: false };
  let prefs;
  try { prefs = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { prefs = { ...defaults }; }
  const listeners = new Set();
  function save(values) {
    Object.assign(prefs, values);
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
    listeners.forEach(fn => fn());
    dispatchEvent(new Event('resize'));
    dispatchEvent(new Event('yomu:reader-settings'));
  }
  function uri(adapter, page) {
    // Only select a lower quality variant when the adapter actually supplies it.
    const variant = prefs.quality === 'saver' && page.dataSaverUrl;
    return variant || adapter.resolveImageUri(page);
  }
  function windowRange(index, count, connection = navigator.connection) {
    const ahead = prefs.quality === 'saver' || connection?.saveData || /2g/.test(connection?.effectiveType || '') ? 1 : connection?.effectiveType === '3g' ? 3 : 4;
    return { start: Math.max(0, index - 2), end: Math.min(count - 1, index + ahead) };
  }
  function Paged({ React: R, adapter, pages, chapterId, initialIndex = 0, onPositionChange, onCountChange, onTap, spread }) {
    const [index, setIndex] = R.useState(initialIndex);
    const [, refresh] = R.useState(0);
    R.useEffect(() => { const fn = () => refresh(n => n + 1); listeners.add(fn); addEventListener('resize', fn); return () => { listeners.delete(fn); removeEventListener('resize', fn); }; }, []);
    const step = spread && innerWidth >= 768 ? 2 : 1;
    const go = R.useCallback(n => setIndex(Math.max(0, Math.min(pages.length - 1, n))), [pages.length]);
    R.useEffect(() => { setIndex(Math.min(initialIndex, pages.length - 1)); }, [chapterId]);
    R.useEffect(() => { onPositionChange(index, 0); onCountChange?.(index); }, [index, onPositionChange, onCountChange]);
    R.useEffect(() => {
      const key = event => {
        if (event.target.closest?.('input,select,textarea,button,[contenteditable],.rd-sheet') || globalThis.__yomuReader?.sheet) return;
        let delta = 0;
        if (event.key === 'ArrowRight') delta = prefs.rtl ? -step : step;
        if (event.key === 'ArrowLeft') delta = prefs.rtl ? step : -step;
        if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') delta = step;
        if (event.key === 'ArrowUp' || event.key === 'PageUp') delta = -step;
        if (delta) { event.preventDefault(); event.stopImmediatePropagation(); go(index + delta); }
      };
      const seek = event => go(event.detail);
      addEventListener('keydown', key, true); addEventListener('yomu:seek-page', seek);
      return () => { removeEventListener('keydown', key, true); removeEventListener('yomu:seek-page', seek); };
    }, [index, step, go]);
    const visible = pages.slice(index, index + step);
    const hidden = pages[index + step];
    const h = R.createElement;
    return h('div', { className: 'yomu-paged', 'data-testid': 'reader-paged', onClick: event => {
      if (event.target.closest('button')) return;
      const rect = event.currentTarget.getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width;
      if (x > .3 && x < .7) onTap(); else go(index + (x < .3 ? -1 : 1) * (prefs.rtl ? -1 : 1) * step);
    } }, h('div', { className: 'yomu-paged-pages', style: { flexDirection: prefs.rtl ? 'row-reverse' : 'row', maxWidth: prefs.width } },
      ...visible.map((page, offset) => h('div', { key: page.key, 'data-page-index': index + offset, className: 'yomu-paged-page' },
        h(Page, { React: R, page, adapter })))),
      hidden ? h('img', { key: 'warm:' + hidden.key, src: uri(adapter, hidden), alt: '', 'aria-hidden': true, style: { display: 'none' } }) : null,
      h('button', { className: 'yomu-page-prev', 'aria-label': 'Previous page', disabled: index === 0, onClick: () => go(index - step) }, '‹'),
      h('button', { className: 'yomu-page-next', 'aria-label': 'Next page', disabled: index + step >= pages.length, onClick: () => go(index + step) }, '›'));
  }
  function Page({ React: R, page, adapter }) {
    const [failed, fail] = R.useState(false);
    const [attempt, retry] = R.useState(0);
    return R.createElement(R.Fragment, null,
      R.createElement('img', { key: attempt, src: uri(adapter, page), alt: `Page ${page.index + 1}`, decoding: 'async', onLoad: () => fail(false), onError: () => fail(true) }),
      failed ? R.createElement('button', { className: 'yomu-page-retry', onClick: () => { fail(false); retry(n => n + 1); } }, 'Retry page') : null);
  }
  function mount() {
    const sheet = document.querySelector('.rd-sheet[aria-label="Reading settings"]');
    if (!sheet || sheet.querySelector('[data-reader-comfort]')) return;
    const group = document.createElement('div'); group.dataset.readerComfort = '1';
    const items = [ ['continuous', 'Continuous chapters', 'checkbox'], ['rtl', 'Read right to left', 'checkbox'], ['width', 'Maximum page width', 'range'], ['gap', 'Page gap', 'range'], ['quality', 'Image quality', 'select'] ];
    for (const [key, text, type] of items) {
      const label = document.createElement('label'); label.textContent = text;
      const control = document.createElement(type === 'select' ? 'select' : 'input'); control.setAttribute('aria-label', text);
      if (type === 'select') for (const [value, title] of [['original', 'Original'], ['saver', 'Data saver']]) { const option = document.createElement('option'); option.value = value; option.textContent = title; control.append(option); }
      else control.type = type;
      if (type === 'checkbox') control.checked = !!prefs[key]; else control.value = prefs[key];
      if (type === 'range') { control.min = key === 'width' ? 320 : 0; control.max = key === 'width' ? 1600 : 32; control.step = key === 'width' ? 20 : 2; }
      control.addEventListener('change', () => save({ [key]: type === 'checkbox' ? control.checked : type === 'range' ? Number(control.value) : control.value }));
      label.append(control); group.append(label);
    }
    const note = document.createElement('small'); note.textContent = 'Data saver limits preloading and uses smaller images when the source provides them. Arrow keys turn pages; center tap shows controls.';
    group.append(note); sheet.append(group);
  }
  new MutationObserver(mount).observe(document.documentElement, { subtree: true, childList: true });
  window.YomuReaderSettings = { prefs, save, uri, windowRange, Paged };
})();
