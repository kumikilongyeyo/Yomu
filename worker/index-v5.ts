import legacy, { type Env } from './index';
import { fabricSourceCards, handleFabric } from './source-fabric';

/**
 * Source Fabric wrapper.
 *
 * v5 keeps the existing Worker intact and layers remote source execution on top.
 * The Sources screen also receives a tiny portal script at response time, which
 * lets the main UX evolve without rebuilding the exported Expo bundle.
 */
async function withSourcesCommandCenter(request: Request, env: Env, url: URL): Promise<Response> {
  const response = await legacy.fetch(request, env);
  if (!response.ok || request.method !== 'GET') return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;

  const html = await response.text();
  if (html.includes('/source-fabric-panel.js')) return new Response(html, response);
  const tag = '<script src="/source-fabric-panel.js" defer></script>';
  const body = html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store');
  return new Response(body, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/fabric/')) {
      return handleFabric(request, env, url);
    }

    if (request.method === 'GET' && url.pathname === '/api/ext/sources') {
      const response = await legacy.fetch(request, env);
      if (!response.ok) return response;

      const payload: any = await response.json().catch(() => null);
      if (!payload || !Array.isArray(payload.extensions)) return response;

      const fixed = fabricSourceCards(url.origin);
      const seen = new Set(payload.extensions.map((x: any) => String(x?.id ?? '')));
      payload.extensions.push(...fixed.filter((x) => !seen.has(x.id)));

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    if (url.pathname === '/sources' || url.pathname === '/sources/' || url.pathname === '/sources.html') {
      return withSourcesCommandCenter(request, env, url);
    }

    return legacy.fetch(request, env);
  },
};
