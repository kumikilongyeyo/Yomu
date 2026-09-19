(() => {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const DEADLINE_MS = 90_000;

  function status(message) {
    const node = document.querySelector('#yomu-source-fabric-command .sf-status');
    if (!node) return;
    node.innerHTML = `<span class="sf-spin"></span>${String(message).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}`;
  }

  async function readCapacity() {
    const response = await nativeFetch('/api/source-beast/capacity', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  }

  function retryDelayMs(capacity) {
    const raw = Number(capacity?.timeUntilNextAllowedBrowserAcquisition || 0);
    if (!Number.isFinite(raw) || raw <= 0) return 1_250;
    // Browser Run has historically surfaced this value as a wait interval.
    // Accept either milliseconds or seconds so the guard remains version-safe.
    const normalized = raw >= 1_000 ? raw : raw * 1_000;
    return Math.min(Math.max(normalized + 750, 1_250), 20_000);
  }

  function hasRoom(capacity) {
    if (!capacity?.ok) return true;
    const allowed = Number(capacity.allowedBrowserAcquisitions || 0) > 0;
    const active = Number(capacity.activeSessionCount || 0);
    const max = Number(capacity.maxConcurrentSessions || 0);
    const concurrencyOkay = !max || active < max;
    return allowed && concurrencyOkay;
  }

  async function waitForCapacity() {
    const deadline = Date.now() + DEADLINE_MS;
    let last = null;
    while (Date.now() < deadline) {
      const capacity = await readCapacity().catch(() => null);
      if (!capacity) return last;
      last = capacity;
      if (hasRoom(capacity)) return capacity;
      const wait = retryDelayMs(capacity);
      const active = Number(capacity.activeSessionCount || 0);
      const max = Number(capacity.maxConcurrentSessions || 0);
      status(max && active >= max
        ? `Cloud browser pool is busy (${active}/${max}). Waiting for a slot…`
        : `Cloudflare is pacing new browser launches. Waiting for the real Browser Run slot…`);
      await sleep(wait);
    }
    return last;
  }

  function requestPath(input) {
    try {
      if (input instanceof Request) return new URL(input.url, location.href).pathname;
      return new URL(String(input), location.href).pathname;
    } catch {
      return '';
    }
  }

  function requestMethod(input, init) {
    return String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  }

  async function isTransientLaunchLimit(response) {
    if (!response) return false;
    const body = await response.clone().json().catch(() => null);
    const text = String(body?.message || body?.error || '');
    if (/browser time limit exceeded for today/i.test(text)) return false;
    return /unable to create new browser.*429|rate limit exceeded/i.test(text);
  }

  window.fetch = async function guardedFetch(input, init) {
    const path = requestPath(input);
    const method = requestMethod(input, init);
    if (path !== '/api/source-beast/test' || method !== 'POST') {
      return nativeFetch(input, init);
    }

    await waitForCapacity();
    let response = await nativeFetch(input, init);

    for (let attempt = 0; attempt < 3 && await isTransientLaunchLimit(response); attempt += 1) {
      status('Browser Run changed its launch window. Re-checking live capacity and retrying automatically…');
      await waitForCapacity();
      await sleep(900);
      response = await nativeFetch(input, init);
    }

    return response;
  };
})();
