(() => {
  'use strict';

  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/add-sources' && path !== '/add-sources.html') return;

  const loadController = (restoreUrl = null, restoreState = null) => {
    const script = document.createElement('script');
    script.src = '/source-beast-yomu.js';
    script.async = false;
    const restore = () => {
      if (!restoreUrl) return;
      try { history.replaceState(restoreState, '', restoreUrl); } catch {}
    };
    script.addEventListener('load', restore, { once: true });
    script.addEventListener('error', restore, { once: true });
    document.head.appendChild(script);
  };

  if (path === '/add-sources.html') {
    loadController();
    return;
  }

  // source-beast-yomu.js historically guarded on /add-sources.html. Yomu's
  // Cloudflare asset router canonicalizes that page to /add-sources, so expose
  // the canonical file pathname only for the synchronous controller startup,
  // then restore the clean URL immediately after the script executes.
  const state = history.state;
  const restoreUrl = `${location.pathname}${location.search}${location.hash}`;
  const shimUrl = `/add-sources.html${location.search}${location.hash}`;
  try {
    history.replaceState(state, '', shimUrl);
    loadController(restoreUrl, state);
  } catch {
    // Very old/restricted browsers can simply use the file route. Preserve the
    // query string because Source Beast uses it for the post-publish enable step.
    location.replace(shimUrl);
  }
})();
