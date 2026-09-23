/**
 * Yomu canonical TitleCard.
 *
 * One renderer for every title Yomu draws outside the React bundle: the
 * discovery rails, the full-source library, Discover's results and everything
 * a More button appends. Before this file there were four hand-built card
 * paths and they drifted apart every time one of them was touched -- different
 * geometry, the rating in a different corner or missing, a cover-less title
 * rendering as a large dark slab instead of the same compact fallback. That is
 * the regression in Figure 3 of the recovery spec, and restyling four
 * renderers to agree is how it comes back. So there is one.
 *
 * ## The contract
 *
 *   .yt-card            root, an <a> when the title can be opened
 *     .yt-card__art     2:3 cover box, fixed radius, `position: relative`
 *       .yt-card__img | .yt-card__fallback
 *       .yt-card__badge     status tag, top-left, one chip component
 *       .yt-card__source    provenance, bottom-left, optional slot
 *       .yt-card__rating    ★ chip, bottom-right -- the corner every Yomu
 *                           tile shape already uses
 *     .yt-card__body    FIXED height, so a card with no note, no rating and
 *                       no cover is exactly as tall as one with all three,
 *                       and so a skeleton can match it to the pixel
 *       .yt-card__title   2-line clamp
 *       .yt-card__note    one line of evidence, optional
 *
 * Every element also carries the older `.yr-card*` class it replaces. Not
 * nostalgia: the customizer (yomu-controls-components.css), the skins and the
 * chip layer in yomu-tags.css all address `.yr-card`, and aliasing means every
 * one of those reaches the library and search surfaces for free instead of
 * being re-implemented against a new name. One renderer, one look, and the
 * theme layers did not have to move.
 *
 * ## Never fabricate
 *
 * A missing score omits the chip. It does not become a zero, a dash, or a
 * placeholder star, and the card does not change shape because a number was
 * absent -- `--yt-body` guarantees that.
 */
(() => {
  'use strict';
  if (typeof document === 'undefined' || window.YomuTitleCard) return;

  const BADGES = {
    Trending: 'trending',
    Gem: 'gem',
    New: 'new',
    'New chapter': 'updated',
    Completed: 'completed',
    Surprise: 'trending',
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const initials = (title) => String(title || '?')
    .split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase();

  const formatScore = (score) => (window.YomuRatings?.formatScore
    ? window.YomuRatings.formatScore(score)
    : (Number(score) > 0 ? (Math.round(Number(score)) / 10).toFixed(1) : null));

  function chip(kind, text, extraClasses) {
    const node = window.YomuTags?.chip
      ? window.YomuTags.chip(kind, text, { size: 'xs' })
      : el('span', null, text);
    for (const cls of extraClasses) node.classList.add(cls);
    return node;
  }

  /**
   * The providers a row can be read from, one that can actually serve a
   * chapter first.
   *
   * Some sources are discovery-only and say so: Comick declares
   * `chapters: false, pages: false`. A work it shares with a real source must
   * name the real one on the card and open there, or the reader taps a title
   * and arrives nowhere. `readable !== false` rather than `=== true`, so a
   * source that never declared anything keeps its place.
   */
  function providersOf(item) {
    const rows = Array.isArray(item?.providers) ? item.providers.filter(Boolean) : [];
    if (rows.length) {
      return [...rows].sort((a, b) => Number(b?.readable !== false) - Number(a?.readable !== false));
    }
    if (item?.__firstSource) return [{ name: item.__firstSource, id: item.__sourceIds?.[0] }];
    if (item?.sourceLabel) return [{ name: item.sourceLabel, id: item.sourceId }];
    return [];
  }

  /**
   * One line under the title, in reader's words.
   *
   * Sources and AniList both answer with their own vocabulary -- RELEASING,
   * FINISHED, ongoing, Completed - and printing it raw is how a card ends up
   * saying "RELEASING" under a title. Anything this does not recognise is left
   * out rather than guessed at.
   */
  const STATUS_WORDS = {
    releasing: 'Ongoing', ongoing: 'Ongoing', continuing: 'Ongoing',
    finished: 'Completed', completed: 'Completed', complete: 'Completed',
    hiatus: 'On hiatus', not_yet_released: 'Upcoming', cancelled: 'Cancelled', canceled: 'Cancelled',
  };
  const CATEGORY_WORDS = { manga: 'Manga', manhwa: 'Manhwa', manhua: 'Manhua', webtoon: 'Webtoon', comic: 'Comic' };

  function derivedNote(row) {
    if (row.votes) return `${Number(row.votes).toLocaleString()} readers`;
    const parts = [
      CATEGORY_WORDS[String(row.category || '').toLowerCase()] || '',
      STATUS_WORDS[String(row.status || '').toLowerCase()] || '',
    ].filter(Boolean);
    return parts.join(' · ');
  }

  function canonicalHref(item) {
    if (window.YomuOpenTitle?.canonicalHref) {
      try { return window.YomuOpenTitle.canonicalHref(item); } catch {}
    }
    return '/search?q=' + encodeURIComponent(item?.title || '');
  }

  /* MangaDex publishes every cover at several widths and the catalog always asks
     for the 512px one: 124KB where the 256px file is 40KB. Which is right depends
     on the screen -- a 190px card on a plain display wants 256, the same card on a
     phone at 3x genuinely needs 512 -- so both are offered and the browser picks
     against the `sizes` below. A blanket downgrade would be soft covers on exactly
     the devices that care most. The width lives in the filename, which survives
     percent-encoding inside the /api/img relay, so one substitution covers the
     direct and the proxied URL alike. */
  const coverSet = (url) => {
    const wide = String(url || '');
    if (!wide.includes('uploads.mangadex.org') || !wide.includes('.512.jpg')) return '';
    return wide.replace('.512.jpg', '.256.jpg') + ' 256w, ' + wide + ' 512w';
  };

  /**
   * @param {object} item                 title row (any surface's shape)
   * @param {object} [opts]
   * @param {string|null} [opts.badge]    'Trending' | 'Gem' | 'New' | 'Completed'
   * @param {string} [opts.href]          overrides the resolved href
   * @param {boolean} [opts.source]       show the provenance slot (default: auto)
   * @param {string} [opts.note]          one line under the title
   * @param {boolean} [opts.disabled]     no enabled source can open this title
   * @param {(event: Event) => void} [opts.onOpen]
   */
  function create(item, opts = {}) {
    const row = item || {};
    const providers = providersOf(row);
    const disabled = !!opts.disabled;

    const node = disabled ? el('button', 'yt-card yr-card yt-card--disabled') : el('a', 'yt-card yr-card');
    if (disabled) node.type = 'button';
    if (disabled) node.disabled = true;
    else node.href = opts.href || canonicalHref(row);
    node.setAttribute('aria-label', row.title || 'Open title');
    if (providers[0]?.id) node.dataset.ytSource = String(providers[0].id);
    if (row.id != null) node.dataset.ytId = String(row.id);

    const art = el('span', 'yt-card__art yr-card__art');
    if (row.cover) {
      const img = el('img', 'yt-card__img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      /* Small cards never need a full-size cover. Providers ignore an unknown
         attribute, so this costs nothing where it is not honoured.
         sizes and srcset are set before src: assigning src is what starts the
         download, and a candidate list that arrives afterwards is a second one. */
      img.setAttribute('sizes', '(max-width: 620px) 45vw, 190px');
      const candidates = coverSet(row.cover);
      if (candidates) img.srcset = candidates;
      img.src = row.cover;
      img.addEventListener('error', () => {
        img.remove();
        if (!art.querySelector('.yt-card__fallback')) {
          art.prepend(el('span', 'yt-card__fallback', initials(row.title)));
        }
      }, { once: true });
      art.append(img);
    } else {
      /* The same compact fallback everywhere. A cover-less title is a normal
         event, not a reason to draw a different card. */
      art.append(el('span', 'yt-card__fallback', initials(row.title)));
    }

    const badgeLabel = opts.badge || (/complete|finished/i.test(String(row.status || '')) ? 'Completed' : null);
    if (badgeLabel) {
      const badge = chip(BADGES[badgeLabel] || 'trending', badgeLabel, ['yt-card__badge', 'yr-badge']);
      badge.setAttribute('aria-hidden', 'true');
      art.append(badge);
    }

    const showSource = opts.source ?? providers.length > 0;
    const readable = providers.filter((p) => p?.readable !== false);
    if (showSource && providers[0]?.name) {
      const source = el('span', 'yt-card__source');
      source.append(el('b', null, String(providers[0].name)));
      if (providers.length > 1) source.append(el('span', null, `+${providers.length - 1}`));
      source.title = providers.map((p) => p?.name).filter(Boolean).join(' · ');
      art.append(source);
    }
    /* Every provider is discovery-only: this title can be found but not read.
       Saying so on the card beats letting the reader find out by tapping it. */
    if (providers.length && !readable.length) {
      node.dataset.ytUnreadable = '1';
      node.classList.add('yt-card--unread');
      const flag = chip('updated', 'Not readable yet', ['yt-card__badge']);
      flag.setAttribute('aria-hidden', 'true');
      flag.title = `Found on ${providers.map((p) => p?.name).filter(Boolean).join(' · ')}, which can list it but not serve its chapters`;
      art.append(flag);
    }

    /* The chip carries `yomu-tile__rating` as well, so yomu-ratings.js sees a
       rating already on the card instead of appending a second one, and
       `data-yt-owned` so that file leaves a score the row arrived with alone
       rather than removing it while its own AniList lookup is still pending. */
    const score = formatScore(row.score ?? row.averageScore);
    if (score) {
      const rating = chip('rating', score, ['yt-card__rating', 'yr-card__rating', 'yomu-tile__rating']);
      rating.dataset.score = score;
      rating.dataset.ytOwned = '1';
      rating.title = score + ' / 10 on AniList';
      rating.setAttribute('aria-label', 'Rated ' + score + ' out of 10 on AniList');
      art.append(rating);
    }

    node.append(art);

    const body = el('span', 'yt-card__body');
    body.append(el('span', 'yt-card__title yr-card__title', row.title || 'Untitled'));
    /* An explicit note wins, including an explicit empty one -- a rail that
       has nothing to say under a title says nothing rather than falling
       through to a status word. */
    const note = opts.note !== undefined ? opts.note : derivedNote(row);
    if (note) body.append(el('span', 'yt-card__note yr-card__note', note));
    node.append(body);

    if (!disabled) {
      const target = { ...row, title: row.title, providers, anilistId: row.anilistId ?? row.id };
      if (opts.onOpen) node.addEventListener('click', opts.onOpen);
      else if (window.YomuOpenTitle?.bind) window.YomuOpenTitle.bind(node, target, opts.onClick);
      else if (opts.onClick) node.addEventListener('click', opts.onClick);
    }
    return node;
  }

  /**
   * A card-shaped hole. Identical box to `create()` -- same grid rows, same
   * radius, same fixed body -- so nothing shifts when the real card lands.
   */
  function skeleton() {
    const node = el('div', 'yt-card yr-card yt-card--skeleton');
    node.setAttribute('aria-hidden', 'true');
    node.dataset.yomuSkeleton = '1';
    node.append(el('span', 'yt-card__art yr-card__art'));
    const body = el('span', 'yt-card__body');
    body.append(el('span', 'yt-card__line'));
    node.append(body);
    return node;
  }

  window.YomuTitleCard = { create, skeleton, canonicalHref, formatScore, providersOf, BADGES };
  if (typeof module !== 'undefined' && module.exports) module.exports = { BADGES };
})();
