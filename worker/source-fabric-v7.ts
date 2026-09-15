import type { Env } from './index';
import {
  fabricSourceCards,
  handleFabric as handleFabricV6,
} from './source-fabric-v6';

/**
 * Yomu Source Fabric v7.2 — Beast Adaptive public surface.
 *
 * v6 remains the proven adaptive engine underneath. v7.2 makes the generation
 * explicit at the public API boundary, keeps the UI/version contract stable,
 * and leaves the v6 implementation available as a rollback floor.
 */
const VERSION = '7.2';
const GENERATION = 'Beast Adaptive';

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
      engines: [...new Set([...(Array.isArray(payload.engines) ? payload.engines : []), 'store-federation', 'aidoku-wasm'])],
      capabilities: {
        adaptiveFallbacks: true,
        federation: true,
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
