import legacy, { type Env } from './index';
import { fabricSourceCards, handleFabric } from './source-fabric';
import { handleKaganeV53 } from './kagane-v53';
import { handleFederatedResolve, handleStoreFederation } from './store-federation';

/**
 * Source Fabric wrapper.
 *
 * v5 keeps the existing Worker intact and layers remote source execution on top.
 * Store Federation v6 now sits in front of the same Add Source button: it finds
 * maintained Aidoku/Mihon/Mangayomi implementations before Yomu falls back to
 * generic remote probing. The UI stays paste -> Add -> read.
 */
async function withSourcesCommandCenter(request: Request, env: Env, url: URL): Promise<Response> {
  const response = await legacy.fetch(request, env);
  if (!response.ok || request.method !== 'GET') return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;

  let html = await response.text();
  const tags: string[] = [];
  if (!html.includes('/source-fabric-panel.js')) tags.push('<script src="/source-fabric-panel.js" defer></script>');
  if (!html.includes('/source-fabric-layout.js')) tags.push('<script src="/source-fabric-layout.js" defer></script>');
  if (!html.includes('/source-fabric-diagnostics.js')) tags.push('<script src="/source-fabric-diagnostics.js" defer></script>');
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/fabric/source/kagane/')) return handleKaganeV53(request, url);

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

    if (url.pathname === '/sources' || url.pathname === '/sources/' || url.pathname === '/sources.html') return withSourcesCommandCenter(request, env, url);
    return legacy.fetch(request, env);
  },
};
