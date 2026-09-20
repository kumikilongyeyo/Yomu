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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/source-beast/capacity') {
      return browserCapacity(env as BrowserEnv);
    }

    let response = await v8.fetch(request, env);

    if (request.method === 'GET' && /\/chapters\/[^/]+\/manifest$/.test(url.pathname)) {
      response = await repairManifest(url, response);
    }

    if (request.method === 'GET') {
      const type = response.headers.get('content-type') ?? '';
      if (response.ok && type.includes('text/html')) {
        const scripts = ['/yomu-source-reliability.js'];
        if (url.pathname === '/sources' || url.pathname === '/sources/' || url.pathname === '/sources.html') {
          scripts.push('/source-beast-capacity-guard.js');
        }
        return injectScripts(response, scripts);
      }
    }
    return response;
  },
};
