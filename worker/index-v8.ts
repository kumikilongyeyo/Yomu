import v7 from './index-v7';
import type { Env } from './index';
import { handleV8Route, v8Status } from './source-fabric-v8';
import {
  forgeEligibility,
  handleForgeRoute,
  queueResolvedSource,
} from './source-forge-v8';
import {
  handleWebsiteAdaptiveRuntime,
  tryWebsiteAdaptiveResolve,
  websiteAdaptiveStatus,
} from './website-adaptive-v82';
import { handleSourceBeastCloud } from './source-beast-cloud';

const VERSION = '8.2';
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

async function injectSourceBeastUi(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;
  let html = await response.text();
  const js = '<script src="/source-beast-loader.js" defer></script>';
  if (!html.includes('/source-beast-loader.js')) {
    html = html.includes('</body>') ? html.replace('</body>', `${js}</body>`) : html + js;
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-yomu-entrypoint', 'v8');
  headers.set('x-yomu-source-fabric', VERSION);
  headers.set('x-yomu-source-beast', 'web-source');
  return new Response(html, { status: response.status, headers });
}

function jsonResponse(payload: any, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-yomu-entrypoint': 'v8',
      'x-yomu-source-fabric': VERSION,
      ...extraHeaders,
    },
  });
}

async function resolveCore(request: Request, env: Env, url: URL): Promise<{ response: Response; rawInput: string; payload: any }> {
  if (request.method !== 'POST') {
    const response = await v7.fetch(request, env);
    const payload = response.headers.get('content-type')?.includes('application/json')
      ? await response.clone().json().catch(() => null)
      : null;
    return { response, rawInput: '', payload };
  }

  const bodyText = await request.text();
  let body: any = {};
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch {}
  const rawInput = String(body?.url ?? body?.input ?? '').trim();

  const coreRequest = new Request(url.toString(), {
    method: 'POST',
    headers: request.headers,
    body: bodyText,
  });
  const coreResponse = await v7.fetch(coreRequest, env);
  const corePayload: any = coreResponse.headers.get('content-type')?.includes('application/json')
    ? await coreResponse.clone().json().catch(() => null)
    : null;

  if (corePayload?.ready === true && corePayload?.adapter) {
    return { response: coreResponse, rawInput, payload: corePayload };
  }
  if (!rawInput) return { response: coreResponse, rawInput, payload: corePayload };

  const adaptive = await tryWebsiteAdaptiveResolve(rawInput, url.origin).catch(() => null);
  if (adaptive?.ready === true && adaptive?.adapter) {
    const evidence = Array.isArray(corePayload?.evidence) ? corePayload.evidence : [];
    const merged = {
      ...(corePayload && typeof corePayload === 'object' ? corePayload : {}),
      ...adaptive,
      evidence: [
        ...evidence,
        {
          ecosystem: 'website-adaptive',
          framework: adaptive?.plan?.framework,
          baseUrl: adaptive?.plan?.baseUrl,
          learnedSeriesSegments: adaptive?.plan?.seriesSegments?.slice?.(0, 8),
        },
      ],
      fabric: {
        ...(corePayload?.fabric ?? {}),
        version: VERSION,
        generation: GENERATION,
        websiteAdaptive: true,
      },
    };
    const response = jsonResponse(merged, 200, { 'x-yomu-website-adaptive': VERSION });
    return { response, rawInput, payload: merged };
  }

  if (adaptive && corePayload && typeof corePayload === 'object') {
    const merged = {
      ...corePayload,
      websiteAdaptive: {
        route: adaptive.route ?? null,
        failureKind: adaptive.failureKind ?? null,
        framework: adaptive?.plan?.framework ?? adaptive?.probe?.framework ?? null,
        message: adaptive.message ?? null,
        probe: adaptive.probe ?? null,
      },
    };
    return { response: jsonResponse(merged, coreResponse.status || 200), rawInput, payload: merged };
  }

  return { response: coreResponse, rawInput, payload: corePayload };
}

async function testForgeSite(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Use POST with {url}.' }, 405, { 'x-yomu-source-forge': '1' });
  }
  const bodyText = await request.text();
  let body: any = {};
  try { body = bodyText ? JSON.parse(bodyText) : {}; } catch {}
  const input = String(body?.url ?? body?.input ?? '').trim();
  if (!input) return jsonResponse({ error: 'Missing website URL.' }, 400, { 'x-yomu-source-forge': '1' });

  const probeRequest = new Request(new URL('/api/fabric/resolve', url.origin).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ url: input }),
  });
  const resolved = await resolveCore(probeRequest, env, new URL(probeRequest.url));
  const payload: any = resolved.payload ?? { ready: false, error: `Probe returned HTTP ${resolved.response.status}.` };
  const eligibility = forgeEligibility(payload);

  return jsonResponse({
    ok: resolved.response.ok,
    input,
    ready: payload?.ready === true,
    forgeable: eligibility.eligible,
    forgeReason: eligibility.reason,
    route: payload?.route ?? null,
    score: Number(payload?.score ?? payload?.adapter?.score ?? 0),
    confidence: payload?.confidence ?? null,
    failureKind: payload?.failureKind ?? payload?.websiteAdaptive?.failureKind ?? null,
    message: payload?.message ?? payload?.error ?? payload?.websiteAdaptive?.message ?? null,
    strategy: payload?.probe?.strategy ?? payload?.adapter?.strategy ?? null,
    framework: payload?.plan?.framework ?? payload?.websiteAdaptive?.framework ?? null,
    catalogCount: Number(payload?.probe?.catalogCount ?? payload?.websiteAdaptive?.probe?.catalogCount ?? 0),
    chapterCount: Number(payload?.probe?.chapterCount ?? payload?.websiteAdaptive?.probe?.chapterCount ?? 0),
    pages: Number(payload?.probe?.pages ?? payload?.probe?.pageCount ?? payload?.websiteAdaptive?.probe?.pages ?? 0),
  }, 200, { 'x-yomu-source-forge': '1' });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const sourceBeast = await handleSourceBeastCloud(request, env, url);
    if (sourceBeast) return sourceBeast;

    const adaptiveRuntime = await handleWebsiteAdaptiveRuntime(request, env, url);
    if (adaptiveRuntime) return adaptiveRuntime;

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
          version: 2,
          automaticPromotion: true,
          liveSourcePack: '/api/fabric/forge/sourcepack.json',
          gitMirror: (env as any).FORGE_SOURCEPACK_URL || 'https://raw.githubusercontent.com/kumikilongyeyo/yomu-extensions/main/sourcepack.json',
          uiChanged: false,
          testBeforeTrust: true,
        },
        sourceBeast: {
          mode: 'cloud',
          provider: 'cloudflare-browser-run',
          localHelper: false,
          humanInTheLoop: true,
        },
        websiteAdaptive: websiteAdaptiveStatus(),
        version: VERSION,
        generation: GENERATION,
      }));
    }

    if (url.pathname === '/api/fabric/resolve') {
      const resolved = await resolveCore(request, env, url);
      let forge: any = { queued: false, reason: 'resolver-did-not-return-json' };
      if (resolved.payload && resolved.rawInput) {
        try {
          forge = await queueResolvedSource(env, resolved.rawInput, resolved.payload);
        } catch (error: any) {
          forge = { queued: false, reason: `queue-error: ${String(error?.message ?? error).slice(0, 240)}` };
        }
      }

      return rewriteJson(resolved.response, (payload) => ({
        ...payload,
        forge,
        fabric: {
          ...(payload.fabric ?? {}),
          coreVersion: payload.fabric?.version ?? '7.5',
          version: VERSION,
          generation: GENERATION,
          normalizedContract: true,
          sourceForge: true,
          sourceBeastCloud: true,
          websiteAdaptive: true,
        },
      }));
    }

    if (
      request.method === 'GET' &&
      (url.pathname === '/add-sources' || url.pathname === '/add-sources/' || url.pathname === '/add-sources.html')
    ) {
      return injectSourceBeastUi(await v7.fetch(request, env));
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
