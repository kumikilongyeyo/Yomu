(() => {
  'use strict';
  if (window.__YomuSourcePackTruth) return;
  window.__YomuSourcePackTruth = true;

  const nativeFetch = window.fetch.bind(window);
  const onPackScreen = () => location.pathname.startsWith('/sources') && document.getElementById('yomu-source-pack-mode')?.classList.contains('is-active');
  const explicitBrowser = (body) => {
    const state = String(body?.state || '').toLowerCase();
    return body?.browserRequired === true
      || body?.verificationRequired === true
      || state === 'verification-required'
      || state === 'verification-in-progress'
      || state === 'browser-required';
  };

  const neutralize = (message) => String(message || '')
    .replace(/cloudflare/ig, 'remote protection')
    .replace(/captcha/ig, 'site verification')
    .replace(/browser/ig, 'remote renderer')
    .replace(/interactive/ig, 'manual')
    .replace(/challenge/ig, 'verification step');

  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    if (!onPackScreen()) return response;

    let url = '';
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url || '', location.href).pathname; }
    catch { return response; }
    if (url !== '/api/fabric/resolve') return response;

    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) return response;
    const body = await response.clone().json().catch(() => null);
    if (!body || typeof body !== 'object' || body.ready === true || explicitBrowser(body)) return response;

    const next = { ...body };
    if (next.message) next.message = neutralize(next.message);
    if (next.error) next.error = neutralize(next.error);
    next.browserRequired = false;
    next.verificationRequired = false;

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('x-yomu-pack-classification', 'explicit-browser-state-only');
    return new Response(JSON.stringify(next), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
})();
