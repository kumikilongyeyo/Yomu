import v7 from './index-v7';
import type { Env } from './index';
import { handleV8Route, v8Status } from './source-fabric-v8';
import {
  forgeEligibility,
  handleForgeRoute,
  queueResolvedSource,
} from './source-forge-v8';

const VERSION = '8.1';
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

async function testForgeSite(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Use POST with {url}.' }), {
      status: 405,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const body = await request.json().catch(() => ({} as any));
  const input = String((body as any)?.url ?? (body as any)?.input ?? '').trim();
  if (!input) {
    return new Response(JSON.stringify({ error: 'Missing website URL.' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const target = new URL('/api/fabric/resolve', url.origin);
  const probeRequest = new Request(target.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ url: input }),
  });
  const response = await v7.fetch(probeRequest, env);
  const payload: any = await response.clone().json().catch(() => ({ ready: false, error: `Probe returned HTTP ${response.status}.` }));
  const eligibility = forgeEligibility(payload);
  return new Response(JSON.stringify({
    ok: response.ok,
    input,
    ready: payload?.ready === true,
    forgeable: eligibility.eligible,
    forgeReason: eligibility.reason,
    route: payload?.route ?? null,
    score: Number(payload?.score ?? payload?.adapter?.score ?? 0),
    confidence: payload?.confidence ?? null,
    failureKind: payload?.failureKind ?? null,
    message: payload?.message ?? payload?.error ?? null,
    strategy: payload?.probe?.strategy ?? payload?.adapter?.strategy ?? null,
    catalogCount: Number(payload?.probe?.catalogCount ?? 0),
    chapterCount: Number(payload?.probe?.chapterCount ?? 0),
    pages: Number(payload?.probe?.pages ?? 0),
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-yomu-source-forge': '1',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/fabric/forge/test') {
      return testForgeSite(request, env, url);
    }

    const forgeRoute = await handleForgeRoute(request, env, url);
    if (forgeRoute) return forgeRoute;

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
        sourceForge: {
          version: 1,
          automaticPromotion: true,
          liveSourcePack: '/api/fabric/forge/sourcepack.json',
          gitMirror: (env as any).FORGE_SOURCEPACK_URL || 'https://raw.githubusercontent.com/kumikilongyeyo/yomu-extensions/main/sourcepack.json',
          uiChanged: false,
          testBeforeTrust: true,
        },
        version: VERSION,
        generation: GENERATION,
      }));
    }

    if (url.pathname === '/api/fabric/resolve') {
      const requestCopy = request.clone();
      const body: any = request.method === 'POST' ? await requestCopy.json().catch(() => ({})) : {};
      const rawInput = String(body?.url ?? body?.input ?? '').trim();
      const response = await v7.fetch(request, env);

      let forge: any = { queued: false, reason: 'resolver-did-not-return-json' };
      if (response.headers.get('content-type')?.includes('application/json')) {
        const payload: any = await response.clone().json().catch(() => null);
        if (payload && rawInput) {
          try {
            forge = await queueResolvedSource(env, rawInput, payload);
          } catch (error: any) {
            forge = { queued: false, reason: `queue-error: ${String(error?.message ?? error).slice(0, 240)}` };
          }
        }
      }

      return rewriteJson(response, (payload) => ({
        ...payload,
        forge,
        fabric: {
          ...(payload.fabric ?? {}),
          coreVersion: payload.fabric?.version ?? '7.5',
          version: VERSION,
          generation: GENERATION,
          normalizedContract: true,
          sourceForge: true,
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
