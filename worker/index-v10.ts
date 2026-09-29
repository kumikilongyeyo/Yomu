import v9 from './index-v9';
import type { Env } from './index';

/**
 * v10: reader continuity hardening.
 *
 * The continuity stack retries dead images, verifies alternate chapter copies,
 * switches sources, and carries reading position across. Reader Focus sits on
 * top of that proven stack and makes it proactive: warm alternate manifests,
 * faster visible-page recovery, short-session circuit breaking, and bounded
 * prefetch for the current and next chapter.
 *
 * Production source truth also lives here: older Source Fabric compatibility
 * layers append synthetic `fabric-*` cards to /api/ext/sources. Those cards are
 * useful experiments, but they are not validated registry extensions and must
 * not be advertised as active reader sources. A Fabric source only becomes
 * active after it is promoted into the normal extension registry and passes the
 * strict end-to-end source audit.
 */

const READER_SCRIPTS = [
  '/yomu-integrity.js',
  '/yomu-page-rescue.js',
  '/yomu-chapter-switch.js',
  '/yomu-reader-focus.js',
];

async function ensureReaderContinuity(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;

  let html = await response.text();
  const missing = READER_SCRIPTS.filter((script) => !html.includes(script));
  if (missing.length) {
    const tags = missing.map((script) => `<script src="${script}" defer></script>`).join('');
    html = html.includes('</body>') ? html.replace('</body>', `${tags}</body>`) : html + tags;
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-yomu-reader-continuity', 'v10-focus');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

async function registryOnlySources(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return response;

  const payload: any = await response.clone().json().catch(() => null);
  if (!payload || !Array.isArray(payload.extensions)) return response;

  const extensions = payload.extensions.filter((source: any) => {
    const id = String(source?.id ?? '');
    return id && !id.startsWith('fabric-');
  });

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-yomu-source-truth', 'registry-only');
  headers.set('x-yomu-entrypoint', 'v10');
  return new Response(JSON.stringify({ ...payload, extensions }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const response = await v9.fetch(request as any, env, ctx);

    if (request.method === 'GET' && url.pathname === '/api/ext/sources') {
      return registryOnlySources(response);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/read/')) {
      return ensureReaderContinuity(response);
    }
    return response;
  },
};
