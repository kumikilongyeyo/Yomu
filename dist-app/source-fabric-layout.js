(() => {
  'use strict';
  if (!location.pathname.startsWith('/sources')) return;

  const PANEL_ID = 'yomu-source-fabric-command';

  function directText(el) {
    return [...el.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function label(name) {
    const wanted = name.toUpperCase();
    const matches = [...document.querySelectorAll('#root *')]
      .filter((el) => directText(el).toUpperCase() === wanted);
    if (matches.length < 2) return matches[0] || null;
    // Measure once each, then sort on the numbers. getBoundingClientRect
    // inside the comparator forces a synchronous layout on every comparison
    // -- O(n log n) reflows per call, twice per pass, on a tree that grew a
    // great deal when the v8 shell arrived.
    const area = new Map(matches.map((el) => {
      const box = el.getBoundingClientRect();
      return [el, box.width * box.height];
    }));
    return matches.sort((a, b) => area.get(a) - area.get(b))[0] || null;
  }

  function renameDirectText(el, value) {
    const node = [...el.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
    if (node && node.textContent.trim() !== value) node.textContent = value;
  }

  /** The Built In heading this panel was last parked in front of. */
  let anchor = null;

  function arrange() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return false;

    // Already where it belongs: say so without touching the document.
    //
    // `placed` was being set and never read, so every mutation on /sources
    // ran two full `#root` scans and a pile of forced layout -- for ever,
    // because this observer never disconnects. On a settled page that work
    // changes nothing, and it was enough to lock the tab once the v8 shell
    // enlarged the tree it walks.
    if (panel.dataset.placed === 'true'
        && anchor && anchor.isConnected
        && panel.isConnected
        && panel.nextElementSibling === anchor) {
      return true;
    }

    // The main flow belongs immediately before Built In. That leaves the page
    // title and source count visible, then puts Paste → Add → Read ahead of
    // every source-management detail.
    const builtIn = label('BUILT IN');
    anchor = builtIn || null;
    if (builtIn?.parentElement
        && (panel.parentElement !== builtIn.parentElement || panel.nextElementSibling !== builtIn)) {
      builtIn.parentElement.insertBefore(panel, builtIn);
    }

    // Keep the old arbitrary API field for power users, but stop presenting it
    // as the normal way to add a source.
    const manual = label('ADD A SOURCE');
    if (manual) {
      renameDirectText(manual, 'MANUAL API SOURCE');
      manual.style.marginTop = '28px';
      manual.title = 'Advanced: add a Yomu-compatible API endpoint directly';
    }

    panel.dataset.placed = 'true';
    return true;
  }

  let timer = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(arrange, 60);
  };

  arrange();
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('pageshow', schedule);
})();
