import v5 from './index-v5';
import type { Env } from './index';
import { handleFabric } from './source-fabric-v7';
import { handleFederatedResolve } from './store-federation';

/**
 * Yomu production entrypoint v7.2.
 *
 * Keep the proven v5 wrapper as the compatibility floor, but route the public
 * Source Fabric API through the Beast Adaptive v7.2 surface. This avoids a risky
 * rewrite while making the deployed entrypoint, API status, and Sources UI all
 * report the generation that is actually running.
 */
async function injectV7Ui(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;
  let html = await response.text();
  const script = '/source-fabric-v7-ui.js';
  if (!html.includes(script)) {
    const tag = `<script src="${script}" defer></script>`;
    html = html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag;
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-yomu-entrypoint', 'v7.2');
  return new Response(html, { status: response.status, headers });
}

async function normalizeFederationResponse(response: Response): Promise<Response> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return response;
  const payload: any = await response.clone().json().catch(() => null);
  if (!payload || typeof payload !== 'object') return response;

  if (payload.route === 'store-federation' && payload.federation?.runtimeBrokerConfigured) {
    payload.message = payload.federation?.best?.name
      ? `${payload.federation.best.name} has a maintained implementation and the remote runtime broker is connected, but that implementation did not pass the full reader gauntlet. Beast Adaptive will keep using safe Worker fallbacks when available.`
      : 'The remote runtime broker is connected, but no federated implementation passed the full reader gauntlet. Beast Adaptive will keep using safe Worker fallbacks when available.';
    payload.runtimeBroker = 'connected-source-not-ready';
  } else if (payload.route === 'store-federation') {
    payload.runtimeBroker = 'not-configured';
  }

  payload.fabric = {
    ...(payload.fabric ?? {}),
    version: '7.2',
    generation: 'Beast Adaptive',
  };

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-yomu-entrypoint', 'v7.2');
  headers.set('x-yomu-source-fabric', '7.2');
  return new Response(JSON.stringify(payload), { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Specialist/runtime/store routes remain owned by the compatibility layer.
    if (url.pathname.startsWith('/api/fabric/source/kagane/') ||
        url.pathname.startsWith('/api/fabric/runtime/') ||
        url.pathname.startsWith('/api/fabric/stores/')) {
      return v5.fetch(request, env);
    }

    if (url.pathname === '/api/fabric/resolve') {
      if (request.method !== 'POST') return handleFabric(request, env, url);
      const bodyText = await request.text();
      const fabricRequest = new Request(url.toString(), {
        method: 'POST',
        headers: request.headers,
        body: bodyText,
      });
      return normalizeFederationResponse(await handleFederatedResolve(
        bodyText,
        env,
        url,
        handleFabric(fabricRequest, env, url),
      ));
    }

    if (url.pathname.startsWith('/api/fabric/')) {
      return handleFabric(request, env, url);
    }

    if (request.method === 'GET' && (url.pathname === '/sources' || url.pathname === '/sources/' || url.pathname === '/sources.html')) {
      return injectV7Ui(await v5.fetch(request, env));
    }

    return v5.fetch(request, env);
  },
};
