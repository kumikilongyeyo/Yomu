/**
 * Yomu pagination ownership.
 *
 * Figure 1 of the recovery spec is two More buttons on one rail, and the
 * cause was not styling: two modules each believed they owned that rail's
 * action. One of them appended a real pager into `.yr-rail__head`; the other
 * matched the same heading, resolved `closest('section,div')` to the head
 * *div* rather than the rail section, decided the rail was therefore an
 * unowned React shelf, and appended a second pill that navigated to
 * /find?browse=. Two controls, two different meanings of "More", on the same
 * row.
 *
 * So ownership is a thing a module claims, exactly once, from here.
 *
 *   YomuPager.claim(host, { key, scope, label, onMore })
 *
 * The contract, which the runtime gauntlet asserts on every viewport:
 *
 *   - One control per host. `claim()` is idempotent, and it *removes* any
 *     other pager already inside that host rather than hiding it, so a stale
 *     control from an older bundle cannot survive a deploy.
 *   - The label is deterministic: More -> Loading… -> More | End, or Retry
 *     after a failure. There is no third state and no second button.
 *   - A request in flight disables the control, so a triple click is one page.
 *   - A failure keeps whatever is already on screen. `onMore` returning
 *     `false` (or throwing) means "nothing was appended"; the same button
 *     becomes Retry and the next click tries the same page again.
 *   - It is a <button>. More appends; it never navigates. A control that
 *     navigates is a link and is not this.
 */
(() => {
  'use strict';
  if (typeof document === 'undefined' || window.YomuPager) return;

  const ATTR = 'data-yomu-pager';
  const STATE = 'data-yomu-pager-state';
  const LABELS = { idle: 'More', busy: 'Loading…', end: 'End', error: 'Retry' };
  const registry = new WeakMap();

  function setState(entry, state) {
    const button = entry.button;
    entry.state = state;
    button.setAttribute(STATE, state);
    button.textContent = state === 'idle' ? entry.label : LABELS[state];
    button.disabled = state === 'busy' || state === 'end';
    button.setAttribute('aria-busy', String(state === 'busy'));
  }

  async function run(entry) {
    if (entry.state === 'busy' || entry.state === 'end') return;
    setState(entry, 'busy');
    try {
      const result = await entry.onMore({ page: entry.page, pager: entry });
      if (result === false) { setState(entry, 'end'); return; }
      entry.page += 1;
      setState(entry, 'idle');
    } catch (error) {
      /* Content already on screen is never removed by a failed next page. */
      console.warn('[pager] %s: %s', entry.key, error?.message || error);
      setState(entry, 'error');
    }
  }

  /**
   * Claim the single pagination control inside `host`.
   *
   * @param {Element} host       the node the control lives in
   * @param {object}  options
   * @param {string}  options.key     stable identity for this surface
   * @param {string}  options.scope   'rail' | 'library' | 'search'
   * @param {string} [options.label]  idle label, default 'More'
   * @param {string} [options.aria]   accessible name
   * @param {(ctx: {page: number}) => Promise<boolean|void>} options.onMore
   * @returns {{button: HTMLButtonElement, reset(): void, end(): void}}
   */
  function claim(host, options) {
    if (!host || !options?.key || typeof options.onMore !== 'function') return null;

    let entry = registry.get(host);
    /* Every pager inside this host, whoever built it and whatever it calls
       itself. One of them survives; the rest are deleted. */
    const existing = [...host.querySelectorAll(`[${ATTR}], .yomu-generic-more, .yomu-rail-more`)];

    if (entry?.button?.isConnected && entry.button.parentElement === host) {
      /* Someone else's control, or a duplicate from an older pass, is removed
         rather than styled away: "delete the competing path". */
      for (const node of existing) if (node !== entry.button) node.remove();
      entry.onMore = options.onMore;
      if (options.label && options.label !== entry.label) {
        entry.label = options.label;
        if (entry.state === 'idle') entry.button.textContent = entry.label;
      }
      return entry.api;
    }

    for (const node of existing) node.remove();

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'yt-more';
    button.setAttribute(ATTR, options.scope || 'rail');
    button.dataset.yomuPagerKey = options.key;
    button.setAttribute('aria-label', options.aria || `Load more ${options.key}`);

    entry = {
      key: options.key,
      label: options.label || LABELS.idle,
      onMore: options.onMore,
      page: 2,
      state: 'idle',
      button,
      api: null,
    };
    button.addEventListener('click', (event) => {
      /* Belt and braces against a click that arrives while disabled -- a
         forced click in a test, a stray synthetic event in the bundle. */
      event.preventDefault();
      run(entry);
    });
    setState(entry, 'idle');
    host.setAttribute(`${ATTR}-host`, options.scope || 'rail');
    host.append(button);

    entry.api = {
      button,
      get page() { return entry.page; },
      reset(page = 2) { entry.page = page; setState(entry, 'idle'); },
      end() { setState(entry, 'end'); },
      busy() { return entry.state === 'busy'; },
    };
    registry.set(host, entry);
    return entry.api;
  }

  /** Drop the claim so the next pass rebuilds it (used when a view resets). */
  function release(host) {
    const entry = registry.get(host);
    entry?.button?.remove();
    registry.delete(host);
    host?.removeAttribute?.(`${ATTR}-host`);
  }

  window.YomuPager = { claim, release, LABELS, ATTR };
  if (typeof module !== 'undefined' && module.exports) module.exports = { LABELS, ATTR };
})();
