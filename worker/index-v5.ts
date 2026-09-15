import legacy, { type Env } from './index';
import { fabricSourceCards, handleFabric } from './source-fabric-v6';
import { handleKaganeV53 } from './kagane-v53';
import { handleFederatedResolve, handleStoreFederation } from './store-federation';

/**
 * Source Fabric wrapper.
 *
 * Adaptive Source Fabric v6 keeps the existing Worker intact and layers a
 * bounded multi-strategy remote source runtime on top. Store Federation still
 * sits in front of the same Add Source button: maintained ecosystem runtimes
 * get first crack, then the adaptive Worker ladder tries safe public methods.
 * The UI stays paste -> Add -> read.
 */
async function withPageScripts(request: Request, env: Env, scripts: string[]): Promise<Response> {
  const response = await legacy.fetch(request, env);
  if (!response.ok || request.method !== 'GET') return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;

  let html = await response.text();
  const tags = scripts
    .filter((script) => !html.includes(script))
    .map((script) => `<script src="${script}" defer></script>`);
  if (tags.length) {
    const injected = tags.join('');
    html = html.includes('</body>') ? html.replace('</body>', `${injected}</body>`) : html + injected;
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, max-age=0');
  return new Response(html, { status: response.status, headers });
}

async function withSourcesCommandCenter(request: Request, env: Env): Promise<Response> {
  return withPageScripts(request, env, [
    '/source-fabric-panel.js',
    '/source-fabric-bulk.js',
    '/source-pack-json.js',
    '/source-pack-live.js',
    '/community-pack-compact.js',
    '/source-fabric-layout.js',
    '/source-fabric-diagnostics.js',
  ]);
}

async function withExpandedDiscover(request: Request, env: Env): Promise<Response> {
  return withPageScripts(request, env, ['/source-fabric-discover.js']);
}

async function withSeriesAutoSource(request: Request, env: Env): Promise<Response> {
  return withPageScripts(request, env, ['/source-auto-switch.js']);
}

async function proxyRuntime(request: Request, env: Env, url: URL): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response(JSON.stringify({ error: 'Runtime source routes use GET.' }), {
      status: 405,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const row = env as Env & { SOURCE_RUNTIME_URL?: string; SOURCE_RUNTIME_TOKEN?: string };
  const raw = String(row.SOURCE_RUNTIME_URL ?? '').trim();
  if (!raw) {
    return new Response(JSON.stringify({ error: 'Remote source runtime is not configured.' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  let runtimeBase: URL;
  try {
    runtimeBase = new URL(raw.endsWith('/') ? raw : `${raw}/`);
  } catch {
    return new Response(JSON.stringify({ error: 'Remote source runtime URL is invalid.' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const prefix = '/api/fabric/runtime/';
  const suffix = url.pathname.slice(prefix.length);
  if (!suffix || suffix.includes('..')) {
    return new Response(JSON.stringify({ error: 'Invalid runtime path.' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const target = new URL(`v1/${suffix}`, runtimeBase);
  target.search = url.search;
  const headers = new Headers();
  headers.set('accept', request.headers.get('accept') || 'application/json');
  headers.set('user-agent', 'Yomu-Source-Fabric/7.4');
  const token = String(row.SOURCE_RUNTIME_TOKEN ?? '').trim();
  if (token) headers.set('authorization', `Bearer ${token}`);

  try {
    const response = await fetch(target.toString(), {
      method: request.method,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const outHeaders = new Headers(response.headers);
    outHeaders.delete('set-cookie');
    outHeaders.delete('content-length');
    outHeaders.delete('content-encoding');
    outHeaders.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, headers: outHeaders });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: `Remote runtime fetch failed: ${error?.message ?? String(error)}` }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/fabric/source/kagane/')) return handleKaganeV53(request, url);
    if (url.pathname.startsWith('/api/fabric/runtime/')) return proxyRuntime(request, env, url);

    if (url.pathname === '/api/fabric/resolve') {
      if (request.method !== 'POST') return handleFabric(request, env, url);
      const bodyText = await request.text();
      const fabricRequest = new Request(url.toString(), {
        method: 'POST',
        headers: request.headers,
        body: bodyText,
      });
      return handleFederatedResolve(
        bodyText,
        env,
        url,
        handleFabric(fabricRequest, env, url),
      );
    }

    if (url.pathname.startsWith('/api/fabric/stores/')) return handleStoreFederation(request, env, url);
    if (url.pathname.startsWith('/api/fabric/')) return handleFabric(request, env, url);

    if (request.method === 'GET' && url.pathname === '/api/ext/sources') {
      const response = await legacy.fetch(request, env);
      if (!response.ok) return response;
      const payload: any = await response.json().catch(() => null);
      if (!payload || !Array.isArray(payload.extensions)) return response;
      const fixed = fabricSourceCards(url.origin);
      const seen = new Set(payload.extensions.map((x: any) => String(x?.id ?? '')));
      payload.extensions.push(...fixed.filter((x) => !seen.has(x.id)));
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }

    if (url.pathname === '/sources' || url.pathname === '/sources/' || url.pathname === '/sources.html') return withSourcesCommandCenter(request, env);
    if (url.pathname === '/discover' || url.pathname === '/discover/' || url.pathname === '/discover.html') return withExpandedDiscover(request, env);
    if (url.pathname.startsWith('/series/')) return withSeriesAutoSource(request, env);
    return legacy.fetch(request, env);
  },
};
