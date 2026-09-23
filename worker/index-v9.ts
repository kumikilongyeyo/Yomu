import puppeteer from '@cloudflare/puppeteer';
import v8 from './index-v8';
import type { Env } from './index';

type BrowserEnv = Env & { BROWSER: Fetcher };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    'x-yomu-entrypoint': 'v9',
  },
});

async function browserCapacity(env: BrowserEnv): Promise<Response> {
  try {
    const [limits, sessions] = await Promise.all([
      puppeteer.limits(env.BROWSER),
      puppeteer.sessions(env.BROWSER),
    ]);
    return json({
      ok: true,
      provider: 'cloudflare-browser-run',
      allowedBrowserAcquisitions: Number(limits.allowedBrowserAcquisitions ?? 0),
      maxConcurrentSessions: Number(limits.maxConcurrentSessions ?? 0),
      activeSessionCount: Array.isArray(limits.activeSessions) ? limits.activeSessions.length : 0,
      timeUntilNextAllowedBrowserAcquisition: Number(limits.timeUntilNextAllowedBrowserAcquisition ?? 0),
      sessions: (sessions ?? []).map((session: any) => ({
        sessionId: String(session.sessionId || ''),
        startTime: Number(session.startTime || 0),
        connected: !!session.connectionId,
      })),
    });
  } catch (error: any) {
    return json({
      ok: false,
      error: String(error?.message || error || 'Unable to read Browser Run capacity.'),
    }, 502);
  }
}

async function injectScripts(response: Response, scripts: string[]): Promise<Response> {
  if (!response.ok) return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;
  let html = await response.text();
  const tags = scripts
    .filter((script) => !html.includes(script))
    .map((script) => `<script src="${script}" defer></script>`)
    .join('');
  if (tags) html = html.includes('</body>') ? html.replace('</body>', `${tags}</body>`) : html + tags;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-yomu-entrypoint', 'v9');
  return new Response(html, { status: response.status, headers });
}

async function repairManifest(url: URL, response: Response): Promise<Response> {
  if (!response.ok || !/\/chapters\/[^/]+\/manifest$/.test(url.pathname)) return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return response;
  const body: any = await response.clone().json().catch(() => null);
  if (!body || !Array.isArray(body.pages) || String(body.sourceSeriesId ?? '').trim()) return response;

  const match = url.pathname.match(/\/chapters\/([^/]+)\/manifest$/);
  let chapterId = String(body.chapterId ?? '');
  if (!chapterId && match) {
    try { chapterId = decodeURIComponent(match[1]); } catch { chapterId = match[1]; }
  }
  // The reader contract requires a stable, non-empty sourceSeriesId. Some
  // Source Fabric adapters only know the opaque chapter id at this point; using
  // it as the stable fallback is strictly better than making the chapter
  // unreadable, and mirrors worker/extensions/runtime.ts.
  const sourceSeriesId = String(
    url.searchParams.get('series')
      || url.searchParams.get('sourceSeriesId')
      || chapterId
      || 'unknown-series',
  );
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-yomu-manifest-repaired', '1');
  headers.set('x-yomu-entrypoint', 'v9');
  return new Response(JSON.stringify({ ...body, sourceSeriesId }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/* The browse grids fan out to every provider, so the first visitor to ask waits
 * seconds for an answer that is identical for everyone else. A Workers response
 * is never edge-cached on its own -- Cloudflare only stores what the Cache API is
 * explicitly told to store -- so popular and latest go through caches.default,
 * keyed on the full URL (page and adult already live in the query string).
 *
 * Search is excluded on purpose: it is keyed on what one person typed.
 */
const EDGE_CACHED = /^\/api\/catalog\/(popular|latest)$/;

async function catalogFromEdge(
  request: Request,
  ctx: ExecutionContext | undefined,
  serve: () => Promise<Response>,
): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(request).catch(() => undefined);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('x-yomu-edge-cache', 'hit');
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
  }

  const response = await serve();
  if (!response.ok) return response;

  const headers = new Headers(response.headers);
  headers.set('x-yomu-edge-cache', 'miss');
  const body = await response.arrayBuffer();
  const stored = new Response(body, { status: response.status, statusText: response.statusText, headers });

  /* Storing must never delay the answer, and a cache that refuses the write is
     a slow page, not a broken one. */
  const write = cache.put(request, stored.clone()).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(write);
  return stored;
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/source-beast/capacity') {
      return browserCapacity(env as BrowserEnv);
    }

    if (request.method === 'GET' && EDGE_CACHED.test(url.pathname)) {
      return catalogFromEdge(request, ctx, () => v8.fetch(request, env));
    }

    let response = await v8.fetch(request, env);

    if (request.method === 'GET' && /\/chapters\/[^/]+\/manifest$/.test(url.pathname)) {
      response = await repairManifest(url, response);
    }

    if (request.method === 'GET') {
      const type = response.headers.get('content-type') ?? '';
      if (response.ok && type.includes('text/html')) {
        const scripts = ['/yomu-source-reliability.js'];

        // /read/:chapter is an SPA fallback route. Sending it Worker-first lets
        // us keep index.html lean while restoring only the reader helpers that
        // dynamic chapter pages actually need.
        if (url.pathname.startsWith('/read/') || url.pathname.startsWith('/series/')) {
          scripts.push('/yomu-source-ux-v2.js', '/source-auto-switch.js');
        }

        if (url.pathname === '/sources' || url.pathname === '/sources/' || url.pathname === '/sources.html') {
          scripts.push('/source-beast-capacity-guard.js');
        }
        return injectScripts(response, scripts);
      }
    }
    return response;
  },
};
