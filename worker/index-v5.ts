import legacy, { type Env } from './index';
import { fabricSourceCards, handleFabric } from './source-fabric';

/**
 * Source Fabric wrapper.
 *
 * Keeping v5 as a thin wrapper lets the existing Yomu Worker remain battle-
 * tested while new remote source machinery is added independently. Every old
 * route is delegated unchanged except /api/ext/sources, where remote Fabric
 * sources are exposed alongside normal Yomu extensions so the existing client
 * source model can install either one.
 */
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

    return legacy.fetch(request, env);
  },
};
