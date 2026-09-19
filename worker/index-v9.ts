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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/source-beast/capacity') {
      return browserCapacity(env as BrowserEnv);
    }
    return v8.fetch(request, env);
  },
};
