/**
 * Reader-first source + library navigation.
 *
 * Keeps Source Fabric's power-user controls, but puts the reading actions first
 * and pins Source Pack mode across SPA/iOS DOM remounts so Community Pack does
 * not flash open and immediately collapse.
 */
(() => {
  'use strict';

  if (window.__YomuReaderDiscovery) return;
  window.__YomuReaderDiscovery = true;

  const SOURCE_ROUTE = /^\/sources(?:\.html)?\/?$/;
  const LIBRARY_ROUTE = /^\/library(?:\.html)?\/?$/;
  const ROOT_ID = 'yomu-source-fabric-command';
  const PACK_ID = 'yomu-source-pack-mode';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const HUB_ID = 'yomu-reader-source-hub';
  const LIBRARY_HUB_ID = 'yomu-library-explore-hub';

  let packPinned = false;
  let packObserver = null;
  let mountTimer = null;

  const onSources = () => SOURCE_ROUTE.test(location.pathname);
  const onLibrary = () => LIBRARY_ROUTE.test(location.pathname);

  function readCollection() {
    try {
      const parsed = JSON.parse(localStorage.getItem(COLLECTION_KEY) || '{}');
      return parsed && Array.isArray(parsed.sources) ? parsed : { sources: [] };
    } catch {
      return { sources: [] };
    }
  }

  function enabledSourceCount() {
    return readCollection().sources.filter((source) => source && source.enabled !== false).length;
  }

  function ensureStyle() {
    if (document.getElementById('yomu-reader-discovery-style')) return;
    const style = document.createElement('style');
    style.id = 'yomu-reader-discovery-style';
    style.textContent = `
      #${HUB_ID},#${LIBRARY_HUB_ID}{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;box-sizing:border-box;color:var(--text,#f7f8fa)}
      #${HUB_ID} *,#${LIBRARY_HUB_ID} *{box-sizing:border-box}
      #${HUB_ID}{max-width:1180px;margin:14px auto;padding:14px;border:1px solid color-mix(in srgb,var(--line,#263747) 84%,var(--accent,#ffc15a) 16%);border-radius:18px;background:linear-gradient(145deg,color-mix(in srgb,var(--surface,#111b25) 93%,var(--accent,#ffc15a) 7%),var(--surface,#111b25));box-shadow:0 14px 42px rgba(0,0,0,.10)}
      .yrd-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.yrd-kicker{font-size:10px;font-weight:850;letter-spacing:.12em;text-transform:uppercase;color:var(--dim,#8297aa)}.yrd-title{margin:3px 0 0;font-size:18px;line-height:1.08;font-weight:850;letter-spacing:-.02em}.yrd-count{flex:none;padding:6px 9px;border:1px solid var(--line,#263747);border-radius:999px;color:var(--muted,#91a8bb);font-size:10.5px;font-weight:750;white-space:nowrap}.yrd-copy{margin:7px 0 0;max-width:680px;color:var(--muted,#91a8bb);font-size:11.5px;line-height:1.45}
      .yrd-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.yrd-action{min-height:42px;display:inline-flex;align-items:center;justify-content:center;padding:0 14px;border-radius:999px;border:1px solid var(--line,#263747);background:color-mix(in srgb,var(--surface,#111b25) 92%,transparent);color:var(--text,#f7f8fa);text-decoration:none;font:800 11.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}.yrd-action:hover{border-color:color-mix(in srgb,var(--accent,#ffc15a) 48%,var(--line,#263747))}.yrd-action--primary{border-color:transparent;background:var(--accent,#ffc15a);color:var(--accentText,#0c131b)}.yrd-action[disabled]{opacity:.58;cursor:wait}.yrd-status{min-height:15px;margin-top:8px;color:var(--dim,#8297aa);font-size:10.5px;line-height:1.35}
      #${LIBRARY_HUB_ID}{margin:16px 16px 18px;padding:14px;border:1px solid var(--line,#263747);border-radius:18px;background:color-mix(in srgb,var(--surface,#111b25) 95%,transparent)}#${LIBRARY_HUB_ID} .yrd-title{font-size:17px}#${LIBRARY_HUB_ID} .yrd-search{display:flex;gap:8px;margin-top:12px}#${LIBRARY_HUB_ID} .yrd-search input{min-width:0;flex:1;height:42px;padding:0 13px;border-radius:12px;border:1px solid var(--line,#263747);background:var(--bg,#09111a);color:var(--text,#f7f8fa);font:inherit;font-size:13px;outline:none}#${LIBRARY_HUB_ID} .yrd-search input:focus{border-color:color-mix(in srgb,var(--accent,#ffc15a) 65%,var(--line,#263747));box-shadow:0 0 0 3px color-mix(in srgb,var(--accent,#ffc15a) 10%,transparent)}
      @media(max-width:700px){#${HUB_ID}{margin:12px 12px;padding:13px;border-radius:16px}.yrd-head{align-items:center}.yrd-actions{display:grid;grid-template-columns:1fr 1fr}.yrd-action{width:100%;min-height:44px;padding:0 11px}.yrd-action--primary{grid-column:1/-1}#${LIBRARY_HUB_ID}{margin:12px 12px 16px;padding:13px;border-radius:16px}#${LIBRARY_HUB_ID} .yrd-search{display:grid;grid-template-columns:1fr}#${LIBRARY_HUB_ID} .yrd-search .yrd-action{width:100%}}
    `;
    document.head.append(style);
  }

  function forcePackMode(root) {
    if (!packPinned || !root?.isConnected || !onSources()) return;
    const pack = document.getElementById(PACK_ID);
    const switcher = root.querySelector('.sf-mode-switch');
    const singleButton = switcher?.querySelector('button[data-mode="single"]');
    const packButton = switcher?.querySelector('button[data-mode="pack"]');
    if (!pack || !packButton) return;

    if (singleButton?.classList.contains('is-active')) singleButton.classList.remove('is-active');
    if (singleButton?.getAttribute('aria-selected') !== 'false') singleButton?.setAttribute('aria-selected', 'false');
    if (!packButton.classList.contains('is-active')) packButton.classList.add('is-active');
    if (packButton.getAttribute('aria-selected') !== 'true') packButton.setAttribute('aria-selected', 'true');
    if (!pack.classList.contains('is-active')) pack.classList.add('is-active');

    const singleForm = root.querySelector('.sf-form');
    const pipeline = root.querySelector('.sf-pipe');
    const singleStatus = root.querySelector('.sf-status');
    const singleResult = root.querySelector('.sf-result');
    const details = root.querySelector('details');
    if (singleForm && singleForm.style.display !== 'none') singleForm.style.display = 'none';
    if (pipeline && pipeline.style.display !== 'none') pipeline.style.display = 'none';
    if (singleStatus && singleStatus.style.display !== 'none') singleStatus.style.display = 'none';
    if (singleResult && singleResult.style.display !== 'none') singleResult.style.display = 'none';
    if (details && details.style.display !== 'none') details.style.display = 'none';
  }

  function bindPackPersistence(root) {
    if (!root || root.dataset.yomuPackPersistence === '1') return;
    root.dataset.yomuPackPersistence = '1';

    root.addEventListener('click', (event) => {
      const button = event.target.closest?.('button');
      if (!button) return;
      if (button.matches('.sf-mode-switch button[data-mode="single"]')) {
        packPinned = false;
        return;
      }
      if (button.matches('.sf-mode-switch button[data-mode="pack"], .sp-json-community')) {
        packPinned = true;
        queueMicrotask(() => forcePackMode(root));
      }
    }, true);

    packObserver?.disconnect();
    packObserver = new MutationObserver(() => {
      if (!packPinned) return;
      requestAnimationFrame(() => forcePackMode(document.getElementById(ROOT_ID)));
    });
    packObserver.observe(root, { childList: true, subtree: true });
  }

  async function openCommunityPack(button, status) {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      status.textContent = 'Source tools are still loading. Try again in a moment.';
      return;
    }

    button.disabled = true;
    status.textContent = 'Opening Community Pack…';
    packPinned = true;

    const mode = root.querySelector('.sf-mode-switch button[data-mode="pack"]');
    if (mode && mode.getAttribute('aria-selected') !== 'true') mode.click();
    forcePackMode(root);

    let community = null;
    for (let i = 0; i < 20 && !community; i += 1) {
      community = document.querySelector(`#${PACK_ID} .sp-json-community`);
      if (!community) await new Promise((resolve) => setTimeout(resolve, 75));
    }

    if (!community) {
      status.textContent = 'Community Pack controls did not finish loading. Source Pack stays open so you can retry.';
      button.disabled = false;
      return;
    }

    community.click();
    forcePackMode(root);
    setTimeout(() => forcePackMode(document.getElementById(ROOT_ID)), 120);
    setTimeout(() => forcePackMode(document.getElementById(ROOT_ID)), 360);
    status.textContent = 'Community Pack loaded. Yomu will only queue sources that are new on this device.';
    button.disabled = false;
  }

  function mountSourceHub() {
    if (!onSources()) {
      document.getElementById(HUB_ID)?.remove();
      packObserver?.disconnect();
      packObserver = null;
      packPinned = false;
      return false;
    }

    const root = document.getElementById(ROOT_ID);
    if (!root?.parentNode) return false;
    bindPackPersistence(root);
    /* Source Fabric sits inside header.masthead, a no-wrap flex row. A sibling
       there becomes another column and pushes the Add form off a phone screen,
       so the hub goes above the masthead, full width, instead. */
    const masthead = root.closest('header.masthead');
    const anchor = masthead?.parentNode ? masthead : root;
    if (packPinned) forcePackMode(root);

    let hub = document.getElementById(HUB_ID);
    if (!hub) {
      hub = document.createElement('section');
      hub.id = HUB_ID;
      hub.setAttribute('aria-label', 'Reader source shortcuts');
      hub.innerHTML = `
        <div class="yrd-head">
          <div><div class="yrd-kicker">Reader sources</div><div class="yrd-title">Add sources, then get back to reading</div></div>
          <span class="yrd-count">… sources</span>
        </div>
        <p class="yrd-copy">Community Pack is the fast path. Manual websites and repositories stay below for power-user setup.</p>
        <div class="yrd-actions">
          <button type="button" class="yrd-action yrd-action--primary" data-yrd-community>Open Community Pack</button>
          <a class="yrd-action" href="/find">Browse titles</a>
          <a class="yrd-action" href="/library">My library</a>
        </div>
        <div class="yrd-status" role="status" aria-live="polite">Choose a reading action or manage sources below.</div>`;
      anchor.parentNode.insertBefore(hub, anchor);
      const communityButton = hub.querySelector('[data-yrd-community]');
      const status = hub.querySelector('.yrd-status');
      communityButton.addEventListener('click', () => openCommunityPack(communityButton, status));
    }

    if (hub.nextSibling !== anchor) anchor.parentNode.insertBefore(hub, anchor);
    paintCount(hub);
    return true;
  }

  /* Change-only: a textContent write replaces the text node even when the value
     is the same, which the document observer below sees as a mutation, which
     schedules another mount -- a rewrite every 80ms, forever. */
  function paintCount(hub) {
    const count = enabledSourceCount();
    const label = `${count} enabled source${count === 1 ? '' : 's'}`;
    const chip = hub.querySelector('.yrd-count');
    if (chip && chip.textContent !== label) chip.textContent = label;
  }

  function libraryMountTarget() {
    return document.querySelector('#root main')
      || document.querySelector('#root [role="main"]')
      || document.querySelector('.g-main')
      || document.querySelector('.g-app')
      || document.querySelector('main')
      || document.querySelector('#root > div');
  }

  function mountLibraryHub() {
    if (!onLibrary()) {
      document.getElementById(LIBRARY_HUB_ID)?.remove();
      return false;
    }
    const target = libraryMountTarget();
    if (!target) return false;

    let hub = document.getElementById(LIBRARY_HUB_ID);
    if (!hub) {
      hub = document.createElement('section');
      hub.id = LIBRARY_HUB_ID;
      hub.setAttribute('aria-label', 'Explore your reading library');
      hub.innerHTML = `
        <div class="yrd-head">
          <div><div class="yrd-kicker">Explore</div><div class="yrd-title">Find the next thing to read</div></div>
          <span class="yrd-count">… sources</span>
        </div>
        <p class="yrd-copy">Your shelf stays focused on saved titles. Use the full source catalog when you want to roam, search, or discover something new.</p>
        <form class="yrd-search" role="search">
          <input type="search" inputmode="search" autocomplete="off" placeholder="Search manga, manhwa, manhua…" aria-label="Search all enabled sources">
          <button type="submit" class="yrd-action yrd-action--primary">Search all sources</button>
        </form>
        <div class="yrd-actions">
          <a class="yrd-action" href="/find">Explore full catalog</a>
          <a class="yrd-action" href="/">Continue reading</a>
          <a class="yrd-action" href="/sources">Manage sources</a>
        </div>`;
      target.append(hub);
      hub.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        const q = hub.querySelector('input').value.trim();
        location.href = q ? `/find?q=${encodeURIComponent(q)}` : '/find';
      });
    }

    paintCount(hub);
    if (hub.parentNode !== target) target.append(hub);
    return true;
  }

  function mount() {
    ensureStyle();
    mountSourceHub();
    mountLibraryHub();
  }

  function schedule() {
    if (mountTimer) clearTimeout(mountTimer);
    mountTimer = setTimeout(mount, 80);
  }

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('pageshow', schedule);
  addEventListener('popstate', schedule);
  addEventListener('hashchange', schedule);
  addEventListener('yomu:route', schedule);
  addEventListener('storage', (event) => { if (event.key === COLLECTION_KEY) schedule(); });
})();
