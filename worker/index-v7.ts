import v5 from './index-v5';
import type { Env } from './index';
import { handleFabric } from './source-fabric-v7';
import { resolveWithBeastIntelligence } from './beast-intelligence';
import { handleFederatedResolve } from './store-federation';

/**
 * Yomu production entrypoint v7.2.
 *
 * Keep the proven v5 wrapper as the compatibility floor, but route the public
 * Source Fabric API through the Beast Adaptive v7.2 surface. On the v7.3
 * intelligence branch, resolve requests pass through a planning layer first:
 * family fingerprinting, warm strategy memory, and executable Aidoku federation.
 * The proven v7.2 Worker engine and the old federation broker remain fallback
 * floors until the intelligence branch wins its regression gauntlet.
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
    if (payload.federation?.runtimeBrokerConnected === false) {
      payload.runtimeBroker = 'configured-unreachable';
    } else {
      payload.runtimeBroker = 'connected-source-not-ready';
    }
    if (!payload.message) {
      payload.message = payload.federation?.best?.name
        ? `${payload.federation.best.name} has a maintained implementation and the remote runtime broker is connected, but that implementation did not pass the full reader gauntlet.`
        : 'The remote runtime broker is connected, but no federated implementation passed the full reader gauntlet.';
    }
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

async function resolveIntelligently(request: Request, env: Env, url: URL, bodyText: string): Promise<Response> {
  const smart = await resolveWithBeastIntelligence(request, env, url, bodyText);
  const smartPayload: any = await smart.clone().json().catch(() => null);
  if (smartPayload?.ready && smartPayload?.adapter) return smart;

  // Compatibility shot: the existing broker has hand-written JS adapters such
  // as MangaBall and Comix. The intelligence layer is Aidoku-focused, so a
  // failed smart resolve still lets the old broker try all ecosystems. Keep the
  // smart diagnostics unless the compatibility path actually succeeds.
  const compatibility = await handleFederatedResolve(bodyText, env, url, Promise.resolve(smart.clone()));
  const compatibilityPayload: any = await compatibility.clone().json().catch(() => null);
  return compatibilityPayload?.ready && compatibilityPayload?.adapter ? compatibility : smart;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/fabric/source/kagane/') ||
        url.pathname.startsWith('/api/fabric/runtime/') ||
        url.pathname.startsWith('/api/fabric/stores/')) {
      return v5.fetch(request, env);
    }

    if (url.pathname === '/api/fabric/resolve') {
      if (request.method !== 'POST') return handleFabric(request, env, url);
      const bodyText = await request.text();
      return normalizeFederationResponse(await resolveIntelligently(request, env, url, bodyText));
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
