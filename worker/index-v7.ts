import v5 from './index-v5';
import type { Env } from './index';
import { handleFabric } from './source-fabric-v7';
import { handleFederatedResolve } from './store-federation';
import { handleStoreNameSearch } from './store-name-resolver';
import {
  handleRecipeAwareResolve,
  handleRecipeRuntime,
  recipeStatus,
} from './recipe-adaptive';

/**
 * Yomu production entrypoint v7.4 — Recipe Adaptive.
 *
 * v6 remains the adaptive rollback floor. v7.4 adds a maintained-recipe layer
 * before browser fallback: Keiyoushi source recipes are classified, compiled
 * into bounded Worker-native hints, gauntleted, and exposed only when Yomu can
 * prove catalog -> issues/chapters -> reader pages.
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
  headers.set('x-yomu-entrypoint', 'v7.4');
  return new Response(html, { status: response.status, headers });
}

async function normalizeFederationResponse(response: Response): Promise<Response> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return response;
  const payload: any = await response.clone().json().catch(() => null);
  if (!payload || typeof payload !== 'object') return response;

  if (payload.route === 'store-federation' && payload.federation?.runtimeBrokerConfigured) {
    payload.message = payload.federation?.best?.name
      ? `${payload.federation.best.name} has a maintained implementation and the remote runtime broker is connected, but that implementation did not pass the full reader gauntlet. Recipe Adaptive will keep using safe Worker fallbacks when available.`
      : 'The remote runtime broker is connected, but no federated implementation passed the full reader gauntlet. Recipe Adaptive will keep using safe Worker fallbacks when available.';
    payload.runtimeBroker = 'connected-source-not-ready';
  } else if (payload.route === 'store-federation') {
    payload.runtimeBroker = 'not-configured';
  }

  payload.fabric = {
    ...(payload.fabric ?? {}),
    version: '7.4',
    generation: 'Recipe Adaptive',
  };

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-yomu-entrypoint', 'v7.4');
  headers.set('x-yomu-source-fabric', '7.4');
  return new Response(JSON.stringify(payload), { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Maintained-name lookup lets Source Pack accept names such as
    // "Read Comics Online" without pretending those names are hostnames.
    if (url.pathname === '/api/fabric/stores/search') {
      return handleStoreNameSearch(request, env, url);
    }

    if (url.pathname === '/api/fabric/recipes/status') {
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Use GET.' }), {
          status: 405,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      return new Response(JSON.stringify({ ok: true, ...recipeStatus() }), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname.startsWith('/api/fabric/recipe/')) {
      return handleRecipeRuntime(request, env, url);
    }

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

      const federated = handleFederatedResolve(
        bodyText,
        env,
        url,
        handleFabric(fabricRequest, env, url),
      );

      return normalizeFederationResponse(await handleRecipeAwareResolve(
        bodyText,
        env,
        url,
        federated,
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
