import v7 from './index-v7';
import type { Env } from './index';
import { handleV8Route, v8Status } from './source-fabric-v8';

const VERSION = '8.0';
const GENERATION = 'Universal Source Fabric';

async function rewriteJson(response: Response, mutate: (payload: any) => any): Promise<Response> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return response;
  const payload = await response.clone().json().catch(() => null);
  if (!payload || typeof payload !== 'object') return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-yomu-entrypoint', 'v8');
  headers.set('x-yomu-source-fabric', VERSION);
  return new Response(JSON.stringify(mutate(payload)), { status: response.status, headers });
}

async function injectV8Ui(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;
  let html = await response.text();
  const css = '<link rel="stylesheet" href="/source-fabric-v8.css">';
  const js = '<script src="/source-fabric-v8-ui.js" defer></script>';
  if (!html.includes('/source-fabric-v8.css')) {
    html = html.includes('</head>') ? html.replace('</head>', `${css}</head>`) : css + html;
  }
  if (!html.includes('/source-fabric-v8-ui.js')) {
    html = html.includes('</body>') ? html.replace('</body>', `${js}</body>`) : html + js;
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-yomu-entrypoint', 'v8');
  headers.set('x-yomu-source-fabric', VERSION);
  return new Response(html, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const v8 = await handleV8Route(request, url);
    if (v8) return v8;

    if (url.pathname === '/api/fabric/status') {
      const response = await v7.fetch(request, env);
      return rewriteJson(response, (payload) => ({
        ...payload,
        ...v8Status(),
        core: {
          version: payload.version ?? '7.5',
          generation: payload.generation ?? 'Recipe Engine',
          role: 'compatibility-and-execution-floor',
        },
        version: VERSION,
        generation: GENERATION,
      }));
    }

    if (url.pathname === '/api/fabric/resolve') {
      const response = await v7.fetch(request, env);
      return rewriteJson(response, (payload) => ({
        ...payload,
        fabric: {
          ...(payload.fabric ?? {}),
          coreVersion: payload.fabric?.version ?? '7.5',
          version: VERSION,
          generation: GENERATION,
          normalizedContract: true,
        },
      }));
    }

    if (
      request.method === 'GET' &&
      (url.pathname === '/sources' || url.pathname === '/sources/' || url.pathname === '/sources.html')
    ) {
      return injectV8Ui(await v7.fetch(request, env));
    }

    return v7.fetch(request, env);
  },
};
