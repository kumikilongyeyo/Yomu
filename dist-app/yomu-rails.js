/**
 * Discovery rails, on Home and on Discover.
 *
 * The engine in yomu-rank.js decides what goes in them. This decides where
 * they sit, what they are called, and how they survive React.
 *
 * Placement follows the pattern yomu-shell.js already uses for the Continue
 * row, because it is the pattern that works on this app: find an anchor, build
 * the section, give it a signature so an unchanged rail is never rebuilt, and
 * re-assert its position on every tick -- React re-renders `.g-main` and
 * discards anything it does not own, wherever it likes.
 *
 * Two rules the rails keep:
 *
 *   **Never block the page.** Rails render empty and fill in. A rail whose
 *   data never arrives removes itself rather than leaving a spinner, and the
 *   page underneath was never waiting on it.
 *
 *   **Say why.** Every rail carries a reason -- "Because you read Solo
 *   Leveling", "Loved, and not yet everywhere". A recommendation with no
 *   stated reason is indistinguishable from an advert, and the reason is
 *   usually the most useful thing on the card.
 */
(() => {
  'use strict';

  const HOME_ID = 'yomu-rails';
  const browser = typeof document !== 'undefined';
  const on = (type, fn, opts) => { if (browser) addEventListener(type, fn, opts); };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  /* --- a card ---------------------------------------------------------------- *
   *
   * Deliberately not the app's own tile component: that one is React's and
   * wants a source-bound series id, which a ranked title does not have yet.
   * A rail card is a cover, a name, and a route into search, which is the
   * screen that already knows how to turn a title into a source.
   */

  function card(item, badge) {
    const node = el('a', 'yr-card');
    node.href = '/search?q=' + encodeURIComponent(item.title);
    node.setAttribute('aria-label', item.title);

    const art = el('div', 'yr-card__art');
    if (item.cover) {
      const img = el('img');
      img.src = item.cover;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      art.append(img);
    } else {
      /* No cover is common on a fresh title and must not leave a hole. */
      art.append(el('span', 'yr-card__initials', initials(item.title)));
    }

    if (badge) art.append(el('span', 'yr-badge', badge));
    node.append(art);
    node.append(el('span', 'yr-card__title', item.title));

    /* One line of evidence, and only when there is real evidence. A score of
       null or a vote count of zero says nothing and is left off. */
    const note = item.votes ? item.votes.toLocaleString() + ' readers'
      : item.score ? item.score + '%'
      : '';
    if (note) node.append(el('span', 'yr-card__note', note));

    node.addEventListener('click', () => {
      window.YomuRank?.note?.('RECOMMENDATION_CLICK', item.title);
    });
    return node;
  }

  const initials = (title) =>
    String(title || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();

  /** Which badge, if any, a rail's cards wear. One word, never two. */
  const BADGE = {
    trending: 'Trending',
    gems: 'Gem',
    fresh: 'New',
    top: null,
    popular: null,
  };

  function rail({ label, why, items, badge }) {
    if (!items || !items.length) return null;
    const section = el('section', 'yr-rail');

    const head = el('div', 'yr-rail__head');
    head.append(el('h2', 'yr-rail__title', label));
    if (why) head.append(el('span', 'yr-rail__why', why));
    section.append(head);

    const strip = el('div', 'yr-strip');
    for (const item of items) strip.append(card(item, badge));
    section.append(strip);
    return section;
  }

  /* --- home ------------------------------------------------------------------- *
   *
   * Under the Continue row, above the grid. The grid is the app's own and is
   * left exactly as it is -- these are additions, not a replacement, and the
   * page still works with every one of them missing.
   */

  const isHome = () => location.pathname === '/' || location.pathname === '/index.html';

  /**
   * Where the rails live, but never *when* in the running order.
   *
   * yomu-shell.js owns the home feed's sequence: `orderFeed()` walks
   * FEED_ORDER and chains the sections after the hero on every pass, and
   * `yomu-rails` is a member of that list. Two observers each positioning
   * against the other's neighbour is how a page rewrites itself at frame
   * rate, so the ordering has exactly one owner and it is not this file.
   *
   * What is here is the decision not to mount too early. The first attempt
   * anchored to whatever existed at the time, and on a cold load that is
   * nothing -- the shell's sections mount when their fetches land -- so the
   * rails were appended into an empty `.g-main` and React rendered the
   * carousel *after* them. "Popular right now" ended up above the hero.
   * Waiting for the feed to exist costs a second and removes the whole class
   * of bug.
   */
  function feedParent() {
    for (const id of ['yomu-continue', 'yomu-fresh', 'yomu-because']) {
      const node = document.getElementById(id);
      if (node?.parentNode) return node.parentNode;
    }
    const hero = document.querySelector('.hero-pagination') || document.querySelector('.hero-carousel');
    return hero?.parentNode || null;
  }

  let built = null;
  let building = false;

  async function build() {
    if (building || built) return;
    /* No feed yet means no idea where these belong. The next mutation pass
       will try again, and there are many. */
    if (!feedParent()) return;
    building = true;
    try {
      const wrap = el('div', 'yr-wrap');
      wrap.id = HOME_ID;

      /* Only what the shell does not already do. It owns "Because you read"
         (#yomu-because) and "New chapters" (#yomu-fresh), and its New
         chapters is the better one -- it reads Yomu's own source activity,
         where AniList only knows when a series started. Adding a second of
         either would be two rails disagreeing on the same screen. */
      const [forYou, global] = await Promise.all([
        window.YomuRank.forYou(14),
        window.YomuRank.rails(['trending', 'gems'], 'all', 14),
      ]);

      if (forYou) wrap.append(rail(forYou) || document.createComment(''));
      if (global?.trending) {
        wrap.append(rail({ ...window.YomuRank.RAILS.trending, items: global.trending, badge: BADGE.trending })
          || document.createComment(''));
      }
      if (global?.gems) {
        wrap.append(rail({ ...window.YomuRank.RAILS.gems, items: global.gems, badge: BADGE.gems })
          || document.createComment(''));
      }

      /* Nothing loaded: leave the page exactly as it was. An empty container
         still takes vertical space and still looks broken. */
      if (!wrap.querySelector('.yr-rail')) return;
      built = wrap;
      place();
    } catch (error) {
      console.warn('[rails] home:', error.message);
    } finally {
      building = false;
    }
  }

  /**
   * Put the rails in the feed. Their position in it is the shell's business.
   *
   * Only ever appended, never inserted at an index: `orderFeed()` moves the
   * section into place on the pass that follows, and doing it here as well
   * means two files deciding the same thing.
   */
  function place() {
    if (!built || !isHome() || built.isConnected) return;
    const parent = feedParent();
    if (!parent) return;
    parent.append(built);
  }

  /* --- discover ---------------------------------------------------------------- *
   *
   * find.html is hand-written and already has search, genres and two feeds.
   * The rails go above those, behind a type switch, and nothing existing is
   * moved or removed.
   */

  const RAIL_ORDER = ['trending', 'popular', 'top', 'gems', 'fresh'];

  async function mountDiscover(host) {
    const tabs = el('div', 'yr-tabs');
    tabs.setAttribute('role', 'tablist');
    const body = el('div', 'yr-tabbody');

    let current = 'all';

    const render = async () => {
      body.textContent = '';
      const loading = el('p', 'yr-loading', 'Looking at what is doing well…');
      body.append(loading);

      const data = await window.YomuRank.rails(RAIL_ORDER, current, 14);
      body.textContent = '';
      if (!data) {
        body.append(el('p', 'yr-loading', 'Rankings are unavailable right now. Search still works.'));
        return;
      }
      for (const name of RAIL_ORDER) {
        const items = data[name];
        if (!items?.length) continue;
        const built = rail({ ...window.YomuRank.RAILS[name], items, badge: BADGE[name] });
        if (built) body.append(built);
      }
    };

    for (const type of window.YomuRank.TYPES) {
      const tab = el('button', 'yr-tab', type.label);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(type.id === current));
      tab.addEventListener('click', () => {
        current = type.id;
        for (const other of tabs.children) {
          other.setAttribute('aria-selected', String(other === tab));
        }
        render();
      });
      tabs.append(tab);
    }

    host.append(tabs, body);
    render();
  }

  /* --- boot --------------------------------------------------------------------- */

  function pass() {
    if (!window.YomuRank) return;

    const discoverHost = document.getElementById('yomu-rails-here');
    if (discoverHost && !discoverHost.dataset.mounted) {
      discoverHost.dataset.mounted = '1';
      mountDiscover(discoverHost);
    }

    if (!isHome()) { built?.remove(); built = null; return; }
    if (!built) build();
    else place();
  }

  if (browser) {
    const start = () => {
      pass();
      /* React discards unmanaged nodes on re-render, so placement is
         re-asserted -- but only placement. The rails themselves are rebuilt
         only when their data changes, which is every six hours at most. */
      new MutationObserver(pass).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') on('DOMContentLoaded', start);
    else start();

    for (const type of ['popstate', 'hashchange']) on(type, pass);
    /* A finished chapter changes the taste profile, so For You is stale. */
    on('yomu:chapter-complete', () => { built?.remove(); built = null; pass(); });
  }

  if (typeof window !== 'undefined') window.YomuRails = { rail, card, mountDiscover, BADGE };
  if (typeof module !== 'undefined' && module.exports) module.exports = { BADGE, RAIL_ORDER };
})();
