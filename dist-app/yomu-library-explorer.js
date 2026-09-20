/**
 * Full-source browsing surface for Home and Discover.
 *
 * Ten titles are exposed at a time, the next segment is prefetched near the
 * viewport, and an explicit button remains for keyboard/screen-reader users.
 * There is no finite title ceiling: pagination stops only when the enabled
 * sources themselves are exhausted.
 */
(() => {
  'use strict';

  const ID = 'yomu-library-explorer';
  const SEGMENT = 10;
  const TYPES = [
    ['all', 'All'],
    ['manga', 'Manga'],
    ['manhwa', 'Manhwa'],
    ['manhua', 'Manhua'],
    ['completed', 'Completed'],
  ];
  const GENRES = ['Action', 'Fantasy', 'Romance', 'Martial arts', 'Reincarnation', 'Isekai', 'Historical', 'Comedy'];
  const browser = typeof document !== 'undefined';
  if (!browser) return;

  const isHome = () => location.pathname === '/' || location.pathname === '/index.html';
  const isDiscover = () => /\/(?:find|search)(?:\.html)?\/?$/.test(location.pathname);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  let section = null;
  let grid = null;
  let status = null;
  let sourceCount = null;
  let more = null;
  let sentinel = null;
  let observer = null;
  let loading = false;
  let hasMore = true;
  let mountedFor = '';
  let current = { mode: 'popular', type: 'all', genre: '' };
  const responding = new Set();

  function routeName() {
    return isHome() ? 'home' : isDiscover() ? 'discover' : '';
  }

  function canonicalHref(item) {
    if (window.YomuOpenTitle?.canonicalHref) return window.YomuOpenTitle.canonicalHref(item);
    return '/search?q=' + encodeURIComponent(item.title || '');
  }

  function card(item) {
    const node = el('a', 'yl-card');
    node.href = canonicalHref(item);
    node.setAttribute('aria-label', item.title || 'Open title');

    if (item.cover) {
      const img = el('img', 'yl-card__art');
      img.src = item.cover;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      node.append(img);
    }

    const providers = Array.isArray(item.providers) ? item.providers : [];
    const primary = providers[0]?.name || item.__firstSource || 'Yomu';
    const badge = el('span', 'yl-card__source');
    badge.append(el('b', null, primary));
    if (providers.length > 1) badge.append(el('span', null, `+${providers.length - 1}`));
    node.append(badge);

    const copy = el('span', 'yl-card__copy');
    copy.append(el('span', 'yl-card__title', item.title || 'Untitled'));
    const metadata = [item.category, item.status].filter(Boolean).slice(0, 2);
    if (metadata.length) {
      const meta = el('span', 'yl-card__meta');
      meta.append(el('span', null, metadata.join(' · ')));
      copy.append(meta);
    }
    node.append(copy);

    const target = {
      ...item,
      title: item.title,
      providers,
      anilistId: item.anilistId,
    };
    if (window.YomuOpenTitle?.bind) window.YomuOpenTitle.bind(node, target);
    return node;
  }

  function skeleton() {
    const node = el('div', 'yl-skeleton');
    node.setAttribute('aria-hidden', 'true');
    node.dataset.yomuSkeleton = '1';
    return node;
  }

  function showSkeletons(count = 5) {
    for (let i = 0; i < count; i += 1) grid.append(skeleton());
  }

  function clearSkeletons() {
    for (const node of grid.querySelectorAll('[data-yomu-skeleton]')) node.remove();
  }

  function updateFoot(message) {
    if (status) status.textContent = message;
    if (more) {
      more.disabled = loading;
      more.hidden = !hasMore && !loading;
      more.textContent = loading ? 'Loading…' : 'Load 10 more';
    }
  }

  function updateSourceCount(total) {
    if (!sourceCount) return;
    sourceCount.replaceChildren();
    const strong = el('strong', null, String(total || 0));
    sourceCount.append(strong, document.createTextNode(` enabled source${total === 1 ? '' : 's'} · ${responding.size} responding`));
  }

  function params() {
    return { ...current, count: SEGMENT };
  }

  async function loadMore({ reset = false } = {}) {
    const engine = window.YomuLibraryEngine;
    if (!engine || loading || (!hasMore && !reset)) return;
    loading = true;
    if (reset) {
      engine.resetView(current);
      grid.textContent = '';
      hasMore = true;
    }
    showSkeletons(reset ? SEGMENT : Math.min(5, SEGMENT));
    updateFoot('Loading the next titles from your enabled sources…');

    try {
      const result = await engine.next(params());
      clearSkeletons();
      hasMore = result.hasMore !== false;
      updateSourceCount(result.sourceCount || result.sources?.length || 0);
      for (const item of result.items || []) grid.append(card(item));

      if (!(result.items || []).length && !grid.querySelector('.yl-card')) {
        grid.append(el('div', 'yl-empty', 'No matching titles answered yet. Try another category or load again while slower sources catch up.'));
      }
      const count = grid.querySelectorAll('.yl-card').length;
      updateFoot(hasMore
        ? `${count} titles loaded · more are ready as you scroll`
        : `${count} titles loaded · every responding source is exhausted`);

      // Prepare one segment without painting it. The IntersectionObserver or
      // button consumes this exact promise, so prefetching never duplicates a page.
      if (hasMore) {
        const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 120));
        idle(() => engine.prefetch(params()));
      }
    } catch (error) {
      clearSkeletons();
      updateFoot(`Could not load this segment: ${String(error?.message || error)}`);
    } finally {
      loading = false;
      updateFoot(status?.textContent || 'Ready');
    }
  }

  function setType(type) {
    if (current.type === type) return;
    current.type = type;
    for (const button of section.querySelectorAll('[data-yl-type]')) {
      button.setAttribute('aria-pressed', String(button.dataset.ylType === type));
    }
    loadMore({ reset: true });
  }

  function setGenre(genre) {
    const next = current.genre === genre ? '' : genre;
    if (next === current.genre) return;
    current.genre = next;
    for (const button of section.querySelectorAll('[data-yl-genre]')) {
      button.setAttribute('aria-pressed', String(button.dataset.ylGenre === next));
    }
    loadMore({ reset: true });
  }

  function controls() {
    const row = el('div', 'yl-controls');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Filter full library');
    for (const [id, label] of TYPES) {
      const button = el('button', 'yl-filter', label);
      button.type = 'button';
      button.dataset.ylType = id;
      button.setAttribute('aria-pressed', String(id === current.type));
      button.addEventListener('click', () => setType(id));
      row.append(button);
    }
    for (const genre of GENRES) {
      const button = el('button', 'yl-filter', genre);
      button.type = 'button';
      button.dataset.ylGenre = genre;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => setGenre(genre));
      row.append(button);
    }
    return row;
  }

  function build(kind) {
    const root = el('section', `yl-library yl-library--${kind}`);
    root.id = ID;
    root.setAttribute('aria-label', 'Full source library');

    const head = el('div', 'yl-head');
    const copy = el('div', 'yl-head__copy');
    copy.append(el('div', 'yl-kicker', 'Your enabled sources'));
    copy.append(el('h2', 'yl-title', kind === 'home' ? 'Explore the full library' : 'Keep exploring'));
    copy.append(el('p', 'yl-sub', 'Titles are paged directly from the sources you added, merged when the same series exists in more than one place, and loaded in small segments so the page stays fast.'));
    sourceCount = el('span', 'yl-source-count');
    sourceCount.innerHTML = '<strong>…</strong> enabled sources';
    head.append(copy, sourceCount);
    root.append(head);

    if (kind === 'discover') root.append(controls());

    grid = el('div', 'yl-grid');
    grid.setAttribute('aria-live', 'polite');
    grid.setAttribute('aria-busy', 'false');
    root.append(grid);

    const foot = el('div', 'yl-foot');
    status = el('span', 'yl-status', 'Preparing your source library…');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    more = el('button', 'yl-more', 'Load 10 more');
    more.type = 'button';
    more.addEventListener('click', () => loadMore());
    foot.append(status, more);
    root.append(foot);

    sentinel = el('div', 'yl-sentinel');
    sentinel.setAttribute('aria-hidden', 'true');
    root.append(sentinel);
    return root;
  }

  function attachHomeControls() {
    const tabs = document.querySelector('.m-seg');
    if (tabs && !tabs.dataset.yomuLibraryBound) {
      tabs.dataset.yomuLibraryBound = '1';
      tabs.addEventListener('click', (event) => {
        const button = event.target.closest?.('button');
        if (!button) return;
        const label = String(button.textContent || '').trim().toLowerCase();
        const type = label === 'manga' ? 'manga'
          : label === 'manhwa' ? 'manhwa'
            : label === 'manhua' ? 'manhua'
              : label === 'completed' ? 'completed' : 'all';
        setType(type);
      });
    }

    const genres = document.querySelector('.genre-row');
    if (genres && !genres.dataset.yomuLibraryBound) {
      genres.dataset.yomuLibraryBound = '1';
      genres.addEventListener('click', (event) => {
        const button = event.target.closest?.('button');
        if (!button) return;
        const label = String(button.textContent || '').trim();
        if (!label || /more tags/i.test(label)) return;
        setGenre(label);
      });
    }
  }

  function anchor(kind) {
    if (kind === 'home') return document.querySelector('.home-grid');
    if (kind === 'discover') {
      return document.querySelector('.feed') || document.querySelector('.charts') || document.querySelector('.genres');
    }
    return null;
  }

  function place() {
    const kind = routeName();
    if (!kind) return;
    const at = anchor(kind);
    if (!at?.parentNode) return;

    if (!section || mountedFor !== kind) {
      observer?.disconnect();
      section?.remove();
      mountedFor = kind;
      current = { mode: 'popular', type: 'all', genre: '' };
      responding.clear();
      hasMore = true;
      section = build(kind);
      at.parentNode.insertBefore(section, at);
      if (kind === 'home') {
        document.documentElement.dataset.yomuFullLibrary = '1';
        attachHomeControls();
      }

      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting) && hasMore && !loading) loadMore();
      }, { rootMargin: '700px 0px 700px 0px', threshold: 0.01 });
      observer.observe(sentinel);
      loadMore({ reset: true });
      return;
    }

    if (!section.isConnected) at.parentNode.insertBefore(section, at);
    if (kind === 'home') attachHomeControls();
  }

  addEventListener('yomu:library-source-health', (event) => {
    if (event.detail?.ok && event.detail?.id) responding.add(String(event.detail.id));
    if (section && window.YomuLibraryEngine) {
      window.YomuLibraryEngine.sources().then((list) => updateSourceCount(list.length)).catch(() => {});
    }
  });

  // Search results get the whole canvas. The full-library explorer is the
  // resting/browse state and steps aside while an explicit query is active.
  function syncSearchVisibility() {
    if (!isDiscover() || !section) return;
    const input = document.querySelector('input[type="search"]');
    const active = !!String(input?.value || new URLSearchParams(location.search).get('q') || '').trim();
    section.hidden = active;
  }

  const boot = () => {
    place();
    syncSearchVisibility();
    const input = document.querySelector('input[type="search"]');
    if (input && !input.dataset.yomuLibraryVisibility) {
      input.dataset.yomuLibraryVisibility = '1';
      input.addEventListener('input', syncSearchVisibility);
    }
    new MutationObserver(() => {
      place();
      syncSearchVisibility();
    }).observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  addEventListener('popstate', place);
  addEventListener('hashchange', place);
})();
