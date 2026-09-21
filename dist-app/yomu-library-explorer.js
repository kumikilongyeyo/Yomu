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
  /* The chip row is intentionally short: eight genres is a row a reader can
     read, and the rest are one press away rather than a wall. Revealing them
     changes nothing that is loaded -- it is a disclosure, not a filter. */
  const GENRES = ['Action', 'Fantasy', 'Romance', 'Martial arts', 'Reincarnation', 'Isekai', 'Historical', 'Comedy'];
  const MORE_GENRES = [
    'Adventure', 'Drama', 'Slice of life', 'Mystery', 'Horror', 'Psychological',
    'Sci-fi', 'Supernatural', 'Sports', 'School life', 'Villainess', 'Regression',
    'Cultivation', 'Tragedy', 'Josei', 'Seinen',
  ];
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
  /* Titles already on screen for this view, so a prefetched segment and a
     progressive row can never draw the same card twice. */
  const painted = new Set();

  function routeName() {
    return isHome() ? 'home' : isDiscover() ? 'discover' : '';
  }

  /* The library used to draw its own card -- cover-filled, title over the
     artwork, source pill top-left, no rating at all. Next to Home's rail cards
     that read as a different product, which is Figure 3 of the recovery spec.
     There is one renderer now (yomu-titlecard.js) and this file passes it a
     row. */
  const card = (item) => window.YomuTitleCard.create(item, { source: true });
  const skeleton = () => window.YomuTitleCard.skeleton();

  function showSkeletons(count = 5) {
    for (let i = 0; i < count; i += 1) grid.append(skeleton());
  }

  function clearSkeletons() {
    for (const node of grid.querySelectorAll('[data-yomu-skeleton]')) node.remove();
  }

  function updateFoot(message) {
    if (status) status.textContent = message;
  }

  /**
   * The counter, and only what is true.
   *
   * `responding` is the union of what the engine can prove answered (including
   * the warm rows this render came from) and what this page has heard on the
   * health channel. A card on screen carrying a source's name is itself proof
   * that the source responded, so the two can never disagree in the direction
   * that produced Figure 3.
   */
  function updateSourceCount(total) {
    if (!sourceCount) return;
    const engine = window.YomuLibraryEngine;
    const live = new Set(responding);
    try { for (const id of engine?.respondingIds?.() || []) live.add(id); } catch {}
    const count = Math.min(live.size, Number(total) || live.size);
    sourceCount.replaceChildren();
    sourceCount.append(
      el('strong', null, String(total || 0)),
      document.createTextNode(` enabled source${total === 1 ? '' : 's'} · ${count} responding`),
    );
    sourceCount.dataset.responding = String(count);
  }

  function params(extra) {
    return { ...current, count: SEGMENT, ...extra };
  }

  /**
   * Paint a row the moment the engine has it.
   *
   * The segment used to arrive as one array when the last source in the wave
   * finished, so ten ready covers waited on one slow provider. The engine
   * hands rows over as they land now; each one replaces a skeleton in place,
   * which keeps the grid the same height throughout and means nothing on
   * screen moves when the next one arrives.
   */
  function paintRow(item) {
    if (!grid) return;
    const key = String(item?.title || '').trim().toLowerCase();
    if (!key || painted.has(key)) return;
    painted.add(key);
    const ghost = grid.querySelector('[data-yomu-skeleton]');
    const node = card(item);
    if (ghost) ghost.replaceWith(node);
    else grid.append(node);
  }

  async function loadMore({ reset = false } = {}) {
    const engine = window.YomuLibraryEngine;
    if (!engine || loading || (!hasMore && !reset)) return;
    loading = true;
    if (reset) {
      engine.resetView(current);
      grid.textContent = '';
      painted.clear();
      hasMore = true;
    }
    showSkeletons(reset ? SEGMENT : Math.min(5, SEGMENT));
    updateFoot('Loading the next titles from your enabled sources…');

    try {
      const result = await engine.next(params({ onRow: paintRow }));
      hasMore = result.hasMore !== false;
      for (const id of result.responding || []) responding.add(String(id));
      updateSourceCount(result.sourceCount || result.sources?.length || 0);
      /* Most rows are already on screen from paintRow; this catches a prefetched
         segment, which was resolved before this call could hand over a painter. */
      for (const item of result.items || []) paintRow(item);
      clearSkeletons();

      if (!(result.items || []).length && !grid.querySelector('.yt-card')) {
        grid.append(el('div', 'yl-empty', 'No matching titles answered yet. Try another category or load again while slower sources catch up.'));
      }
      const count = grid.querySelectorAll('.yt-card:not(.yt-card--skeleton)').length;
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
      /* The auto-load and the first segment do not go through the pager's
         click path, so the control is told where the view ended up. */
      if (!hasMore) more?.end();
      else if (!more?.busy()) more?.reset(more.page);
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
    const genreChip = (genre) => {
      const button = el('button', 'yl-filter', genre);
      button.type = 'button';
      button.dataset.ylGenre = genre;
      button.setAttribute('aria-pressed', String(current.genre === genre));
      button.addEventListener('click', () => setGenre(genre));
      return button;
    };
    for (const genre of GENRES) row.append(genreChip(genre));

    /* The disclosure. Pressing it reveals the rest of the genres in place and
       loads nothing: whatever is on screen stays on screen, and the active
       type and genre stay active. Only choosing a genre changes results. */
    const disclose = el('button', 'yl-filter yl-filter--more', 'More genres');
    disclose.type = 'button';
    disclose.dataset.ylGenresMore = '1';
    disclose.setAttribute('aria-expanded', 'false');
    disclose.setAttribute('aria-label', `Show ${MORE_GENRES.length} more genres`);
    disclose.addEventListener('click', () => {
      const expanded = disclose.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        for (const node of row.querySelectorAll('[data-yl-genre-extra]')) node.remove();
        disclose.setAttribute('aria-expanded', 'false');
        disclose.textContent = 'More genres';
        return;
      }
      for (const genre of MORE_GENRES) {
        const chip = genreChip(genre);
        chip.dataset.ylGenreExtra = '1';
        row.append(chip);
      }
      disclose.setAttribute('aria-expanded', 'true');
      disclose.textContent = 'Fewer genres';
      row.append(disclose);
    });
    row.append(disclose);
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

    grid = el('div', 'yl-grid yt-grid');
    grid.setAttribute('aria-live', 'polite');
    grid.setAttribute('aria-busy', 'false');
    root.append(grid);

    const foot = el('div', 'yl-foot');
    status = el('span', 'yl-status', 'Preparing your source library…');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    foot.append(status);
    /* One owner for this surface's pagination, the same module the rails and
       search use. The near-viewport auto-load below presses this very control
       rather than running a second loader beside it. */
    more = window.YomuPager?.claim(foot, {
      key: 'library',
      scope: 'library',
      label: 'Load 10 more',
      aria: 'Load ten more titles from your enabled sources',
      onMore: async () => {
        await loadMore();
        return hasMore;
      },
    }) || null;
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

  /* Is the node inside the visual viewport right now? */
  function onScreen(node) {
    if (!node?.getBoundingClientRect) return false;
    const rect = node.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < (window.innerHeight || document.documentElement.clientHeight || 0);
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
      painted.clear();
      hasMore = true;
      section = build(kind);
      at.parentNode.insertBefore(section, at);
      if (kind === 'home') {
        document.documentElement.dataset.yomuFullLibrary = '1';
        attachHomeControls();
      }

      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || !hasMore || loading) return;
        /* Prefetching ahead of the reader is the point of the sentinel, and
           rootMargin fires it a screen or so early -- while the button is
           still well off-screen. Once the button is actually in view it is
           the reader's to press, and auto-loading under it appends ten cards
           above it, which moves it out from under the tap. Press, chase,
           repeat: at CI's speed the click never lands and the 90s timeout
           wins. Two pagination owners, one surface -- so the sentinel yields
           to the visible control. */
        if (more?.button && onScreen(more.button)) return;
        /* Press the one control rather than starting a parallel load: the
           label, the in-flight guard and the retry state stay in one place. */
        if (more?.button && !more.busy()) more.button.click();
        else loadMore();
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
