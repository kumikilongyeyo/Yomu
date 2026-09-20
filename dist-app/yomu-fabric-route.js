/**
 * Source Fabric, reachable without a reload.
 *
 * Yomu is a single-page app, but the Source Fabric surface was not. Its ten
 * scripts are listed in `/sources.html` and nowhere else, and each one opens
 * with a guard of the shape
 *
 *     if (!location.pathname.startsWith('/sources')) return;
 *
 * evaluated once, at load. Both halves of that are only true on a hard load of
 * `/sources`. Tapping Sources inside the app is a history change: React swaps
 * the route, `/sources.html` is never fetched, the scripts are never even
 * downloaded, and the whole Add-source surface is simply absent. A manual
 * reload was the only way to get it -- and an installed Home Screen app has no
 * reload button, so on iOS it could not be reached at all.
 *
 * This file is the missing bridge, and it lives on every page:
 *
 *   - it watches for route changes (pushState, replaceState, popstate);
 *   - entering /sources, it loads the Source Fabric scripts once, in the order
 *     /sources.html lists them, because later ones anchor onto earlier ones;
 *   - it announces every change as `yomu:route`, so a surface that is already
 *     loaded can mount or unmount immediately instead of waiting for whatever
 *     DOM mutation happens to come next.
 *
 * Loading is deliberately on demand rather than on every page. These scripts
 * run observers that scan `#root` on each mutation; carrying that everywhere
 * to save one fetch is the trade that made /sources unresponsive before.
 */
(() => {
  'use strict';

  const ROUTE = /^\/sources(?:\.html)?\/?$/;

  /* Order matters. source-fabric-panel.js creates #yomu-source-fabric-command
     and #yomu-source-pack; everything after it anchors onto one of those. This
     is the same order /sources.html carries. */
  const SCRIPTS = [
    '/source-fabric-panel.js',
    '/source-fabric-bulk.js',
    '/source-pack-json.js',
    '/source-pack-live.js',
    '/community-pack-compact.js',
    '/source-fabric-layout.js',
    '/source-fabric-diagnostics.js',
    '/source-fabric-v7-ui.js',
    '/source-fabric-v8-ui.js',
  ];

  const onRoute = () => ROUTE.test(location.pathname);

  /** Already in the page, whether from /sources.html or from a previous visit. */
  const alreadyLoaded = (src) =>
    !!document.querySelector(`script[src="${src}"], script[data-yomu-fabric="${src}"]`);

  let loading = null;

  function load(src) {
    return new Promise((resolve) => {
      const tag = document.createElement('script');
      tag.src = src;
      tag.async = false;
      tag.dataset.yomuFabric = src;
      /* Resolve either way. A missing helper should cost this page one dead
         script tag, not the rest of the Source Fabric surface. */
      tag.addEventListener('load', () => resolve(), { once: true });
      tag.addEventListener('error', () => resolve(), { once: true });
      document.head.append(tag);
    });
  }

  function ensureLoaded() {
    if (loading) return loading;
    const missing = SCRIPTS.filter((src) => !alreadyLoaded(src));
    if (!missing.length) {
      loading = Promise.resolve();
      return loading;
    }
    // Sequential, not parallel: each one expects the surfaces the previous
    // one built. `async = false` alone does not order dynamically inserted
    // scripts across separate appends in every engine.
    loading = missing.reduce((chain, src) => chain.then(() => load(src)), Promise.resolve());
    return loading;
  }

  let last = location.pathname;

  function routeChanged() {
    const now = location.pathname;
    const changed = now !== last;
    last = now;
    if (onRoute()) ensureLoaded();
    if (changed) {
      window.dispatchEvent(new CustomEvent('yomu:route', {
        detail: { pathname: now, sources: onRoute() },
      }));
    }
  }

  /* Expo Router navigates with the history API, which fires no event of its
     own. Wrapping is the only way to hear a pushState. */
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    if (typeof original !== 'function') continue;
    history[name] = function patched(...args) {
      const result = original.apply(this, args);
      // After the call, so listeners read the new location.
      queueMicrotask(routeChanged);
      return result;
    };
  }

  window.addEventListener('popstate', routeChanged);
  window.addEventListener('hashchange', routeChanged);
  window.addEventListener('pageshow', routeChanged);

  routeChanged();
})();
