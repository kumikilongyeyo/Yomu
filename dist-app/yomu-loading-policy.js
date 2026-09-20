/**
 * Yomu loading visibility policy.
 *
 * Network activity is not a UI state. Source refreshes, chapter image fetches,
 * recommendation lookups and background prefetches must stay silent while
 * usable content is already on screen. The global Yomu loader is allowed only
 * when the current document is genuinely blank.
 */
(() => {
  'use strict';
  if (window.__YomuLoadingPolicy) return;
  window.__YomuLoadingPolicy = true;

  const STYLE_ID = 'yomu-loading-policy-css';
  const ROOT_FLAG = 'yomuBlankLoading';

  function installCss() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
/* Background work is silent. This intentionally beats the old search-v3
   bottom-right activity badge, including its !important declarations. */
#yomu-load{display:none!important;opacity:0!important;pointer-events:none!important}

/* Only a truly blank surface may show the global loader. It is a centered
   blank-page state, never a persistent corner badge. */
html[data-yomu-blank-loading='1'] #yomu-load.on{
  display:grid!important;position:fixed!important;inset:0!important;
  width:100vw!important;height:100dvh!important;padding:0!important;
  border:0!important;border-radius:0!important;background:var(--bg,#080d14)!important;
  box-shadow:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;
  place-items:center!important;opacity:1!important;transform:none!important;
  transition:none!important;pointer-events:none!important;z-index:2147483600!important
}
html[data-yomu-blank-loading='1'] #yomu-load .yl-card{display:none!important}
html[data-yomu-blank-loading='1'] #yomu-load::after{width:30px!important;height:30px!important}

/* Search/source placeholders use one quiet card-sized skeleton language. */
.yv3-wait{min-width:0!important;min-height:0!important;aspect-ratio:2/3!important;
  border-radius:13px!important;overflow:hidden!important;background:var(--raised,#25333e)!important;
  border:1px solid var(--line,#263747)!important;display:block!important;position:relative!important}
.yv3-wait::before{content:'';position:absolute;inset:0;transform:translateX(-100%);
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.07),transparent);
  animation:yomuUnifiedShimmer 1.05s ease-in-out infinite}
.yv3-wait .yv3-wait__in{position:absolute!important;inset:0!important;display:grid!important;place-items:center!important;padding:0!important}
.yv3-wait .yv3-wait__in img{width:24px!important;height:24px!important;margin:0!important;opacity:.58!important}
.yv3-wait .yv3-wait__in b,.yv3-wait .yv3-wait__in small{display:none!important}
@keyframes yomuUnifiedShimmer{to{transform:translateX(100%)}}
@media(prefers-reduced-motion:reduce){.yv3-wait::before{animation:none!important}}
`;
    document.head.append(style);
  }

  function visible(node) {
    if (!node || !(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const r = node.getBoundingClientRect();
    return r.width >= 24 && r.height >= 24;
  }

  function hasUsableContent() {
    // Real reading/content surfaces first. Once any of these exist, every
    // subsequent fetch is background work and the global loader stays gone.
    const strongSelectors = [
      '.yl-card', '.yr-card', '.tile-card', '#results .tile:not([disabled])',
      '.hero-carousel img', '.hero-pagination', '.home-grid .tile',
      '[data-chapter-page] img', '[data-reader-page] img', '.chapter-page img',
      '.reader img', '.reader-page img', '.webtoon-reader img',
      'main article', 'main section', '.g-main section'
    ];
    for (const selector of strongSelectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) if (visible(node)) return true;
    }

    // Skeletons/placeholders count as usable paint too: if the reader can see
    // a stable layout, covering it with another loader is worse than helpful.
    for (const node of document.querySelectorAll('.yl-skeleton,.yv3-wait,[data-yomu-skeleton]')) {
      if (visible(node)) return true;
    }

    // Generic fallback for routes whose React markup has no stable class.
    const root = document.querySelector('.g-main,main,[role="main"]');
    if (!root || !visible(root)) return false;
    const text = String(root.innerText || '').replace(/\s+/g, ' ').trim();
    const media = root.querySelector('img,canvas,video,svg');
    return !!media || text.length >= 80;
  }

  let loader = null;
  let raf = 0;
  function sync() {
    raf = 0;
    loader ||= document.getElementById('yomu-load');
    if (!loader) {
      document.documentElement.removeAttribute('data-yomu-blank-loading');
      return;
    }
    const requested = loader.classList.contains('on');
    const blank = requested && !hasUsableContent();
    if (blank) document.documentElement.setAttribute('data-yomu-blank-loading', '1');
    else document.documentElement.removeAttribute('data-yomu-blank-loading');
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(sync);
  }

  installCss();
  const start = () => {
    loader = document.getElementById('yomu-load');
    schedule();
    new MutationObserver(schedule).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'style', 'src']
    });
    addEventListener('pageshow', schedule);
    addEventListener('popstate', schedule);
    addEventListener('hashchange', schedule);
    addEventListener('yomu:chapter-complete', schedule);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
