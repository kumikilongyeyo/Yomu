/** Capture Yomu fetch before the slow all-source search wrappers are installed. */
(() => {
  'use strict';
  if (window.__YomuSearchFastBaseFetch) return;
  window.__YomuSearchFastBaseFetch = window.fetch.bind(window);
})();
