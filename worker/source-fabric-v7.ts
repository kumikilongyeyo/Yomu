import type { Env } from './index';
import {
  fabricSourceCards,
  handleFabric as handleFabricV6,
} from './source-fabric-v6';

/**
 * Yomu Source Fabric v7.5 — Recipe Engine public surface.
 *
 * v6 remains the proven adaptive engine underneath. v7.5 keeps the v7.4
 * Worker-native recipe compiler and adds direct source-repository discovery
 * plus a remote compiled-recipe execution tier for sites Cloudflare cannot
 * execute reliably itself.
 */
const VERSION = '7.5';
const GENERATION = 'Recipe Engine';

export { fabricSourceCards };

async function rewriteJson(response: Response, mutate: (payload: any) => any): Promise<Response> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return response;
  const payload = await response.clone().json().catch(() => null);
  if (!payload || typeof payload !== 'object') return response;
  const next = mutate(payload);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-yomu-source-fabric', VERSION);
  return new Response(JSON.stringify(next), { status: response.status, headers });
}

export async function handleFabric(request: Request, env: Env, url: URL): Promise<Response> {
  const response = await handleFabricV6(request, env, url);

  if (url.pathname === '/api/fabric/status') {
    return rewriteJson(response, (payload) => ({
      ...payload,
      version: VERSION,
      generation: GENERATION,
      core: { engine: 'adaptive-v6', version: payload.version ?? '6.0' },
      entrypoint: 'index-v7',
      engines: [...new Set([...(Array.isArray(payload.engines) ? payload.engines : []), 'recipe-adaptive', 'remote-recipe-runtime', 'store-federation', 'aidoku-wasm'])],
      capabilities: {
        adaptiveFallbacks: true,
        federation: true,
        maintainedNameResolution: true,
        sourceRepositoryNameFallback: true,
        smartSourcePackInputs: true,
        maintainedRecipeCompilation: true,
        recipeFamilyClassification: true,
        workerRecipeGauntlet: true,
        remoteCompiledRecipeRuntime: true,
        realCssSelectorExecution: true,
        browserDependencyDetection: true,
        explicitBrowserOutcome: true,
        remoteRuntime: true,
        diagnostics: true,
        liveSmoke: true,
      },
    }));
  }

  if (url.pathname === '/api/fabric/resolve') {
    return rewriteJson(response, (payload) => ({
      ...payload,
      fabric: {
        ...(payload.fabric ?? {}),
        version: VERSION,
        generation: GENERATION,
        coreVersion: payload.fabric?.version ?? '6.0',
      },
    }));
  }

  return response;
}
