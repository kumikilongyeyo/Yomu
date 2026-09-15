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
    return [...document.querySelectorAll('#root *')]
      .filter((el) => directText(el).toUpperCase() === wanted)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      })[0] || null;
  }

  function renameDirectText(el, value) {
    const node = [...el.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
    if (node && node.textContent.trim() !== value) node.textContent = value;
  }

  function arrange() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return false;

    // The main flow belongs immediately before Built In. That leaves the page
    // title and source count visible, then puts Paste → Add → Read ahead of
    // every source-management detail.
    const builtIn = label('BUILT IN');
    if (builtIn?.parentElement && panel.parentElement !== builtIn.parentElement) {
      builtIn.parentElement.insertBefore(panel, builtIn);
    } else if (builtIn?.parentElement && panel.nextElementSibling !== builtIn) {
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
