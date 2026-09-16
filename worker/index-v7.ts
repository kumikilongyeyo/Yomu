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
import { upgradeWithRemoteRecipe } from './recipe-runtime-broker-v75';

/**
 * Yomu production entrypoint v7.5 — Recipe Engine.
 *
 * v6 remains the adaptive rollback floor and v7.4 remains the Worker-native
 * recipe compiler. v7.5 adds the missing execution tier: maintained recipes
 * can be compiled and gauntleted through Yomu Source Runtime when Cloudflare
 * egress cannot execute the site directly. Upstream recipes that explicitly
 * require WebView/browser state are reported as Browser instead of Skipped.
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
  headers.set('x-yomu-entrypoint', 'v7.5');
  return new Response(html, { status: response.status, headers });
}

/**
 * Library Hub is deliberately one reversible HTML hook.
 * The CSS/JS stay isolated and yhub-prefixed, so removing this hook restores
 * the production UI without touching Hunter, Source Fabric or the app bundle.
 */
async function injectLibraryHubUi(request: Request, response: Response): Promise<Response> {
  if (!response.ok || request.method !== 'GET') return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;

  let html = await response.text();
  // v3 forces Safari/PWA/browser caches to fetch the corrected shell after
  // the v2 icon-sizing regression rather than reusing stale assets.
  const css = '/yomu-library-hub.css?v=3';
  const safetyCss = '/yomu-library-hub-fix.css?v=3';
  const script = '/yomu-library-hub.js?v=3';

  if (!html.includes(css)) {
    const tag = `<link rel="stylesheet" href="${css}">`;
    html = html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html;
  }
  if (!html.includes(safetyCss)) {
    const tag = `<link rel="stylesheet" href="${safetyCss}">`;
    html = html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html;
  }
  if (!html.includes(script)) {
    const tag = `<script src="${script}" defer></script>`;
    html = html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag;
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, max-age=0, must-revalidate');
  headers.set('x-yomu-ui', 'library-hub-v2.1');
  return new Response(html, { status: response.status, headers });
}

async function normalizeFederationResponse(response: Response): Promise<Response> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return response;
  const payload: any = await response.clone().json().catch(() => null);
  if (!payload || typeof payload !== 'object') return response;

  if (payload.route === 'store-federation' && payload.federation?.runtimeBrokerConfigured) {
    payload.message = payload.federation?.best?.name
      ? `${payload.federation.best.name} has a maintained implementation. Recipe Engine will try the Worker first and the remote compiled-recipe runtime when the Worker cannot execute it.`
      : 'The remote compiled-recipe runtime is connected; Recipe Engine will use it when Worker execution is not sufficient.';
    payload.runtimeBroker = 'connected';
  } else if (payload.route === 'store-federation') {
    payload.runtimeBroker = 'not-configured';
  }

  payload.fabric = {
    ...(payload.fabric ?? {}),
    version: '7.5',
    generation: 'Recipe Engine',
  };

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-yomu-entrypoint', 'v7.5');
  headers.set('x-yomu-source-fabric', '7.5');
  return new Response(JSON.stringify(payload), { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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
      return new Response(JSON.stringify({
        ok: true,
        ...recipeStatus(),
        publicVersion: '7.5',
        generation: 'Recipe Engine',
        sourceRepositoryFallback: true,
        remoteCompiledRecipeRuntime: true,
        browserOutcomeDetection: true,
      }), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname.startsWith('/api/fabric/recipe/')) {
      return handleRecipeRuntime(request, env, url);
    }

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

      const workerRecipe = handleRecipeAwareResolve(
        bodyText,
        env,
        url,
        federated,
      );

      return normalizeFederationResponse(await upgradeWithRemoteRecipe(
        bodyText,
        env,
        workerRecipe,
      ));
    }

    if (url.pathname.startsWith('/api/fabric/')) {
      return handleFabric(request, env, url);
    }

    if (request.method === 'GET' && (url.pathname === '/sources' || url.pathname === '/sources/' || url.pathname === '/sources.html')) {
      return injectLibraryHubUi(request, await injectV7Ui(await v5.fetch(request, env)));
    }

    return injectLibraryHubUi(request, await v5.fetch(request, env));
  },
};