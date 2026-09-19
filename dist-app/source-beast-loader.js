(() => {
  'use strict';

  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/add-sources' && path !== '/add-sources.html') return;

  const params = new URLSearchParams(location.search);

  // There is only one normal Add Source surface now. Keep the legacy page
  // solely for the Source Beast post-publish callback (?auto=1).
  if (params.get('auto') !== '1') {
    const seed = params.get('url') || params.get('source') || '';
    location.replace('/sources' + (seed ? `?url=${encodeURIComponent(seed)}` : '') + '#add-source');
    return;
  }

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

  const state = history.state;
  const restoreUrl = `${location.pathname}${location.search}${location.hash}`;
  const shimUrl = `/add-sources.html${location.search}${location.hash}`;
  try {
    history.replaceState(state, '', shimUrl);
    loadController(restoreUrl, state);
  } catch {
    location.replace(shimUrl);
  }
})();
