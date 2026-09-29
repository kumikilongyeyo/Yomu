import v9 from './index-v9';
import type { Env } from './index';

/**
 * v10: reader continuity hardening + production source truth.
 */

const READER_SCRIPTS = [
  '/yomu-integrity.js',
  '/yomu-page-rescue.js',
  '/yomu-chapter-switch.js',
  '/yomu-reader-focus.js',
];

const SOURCE_TRUTH_SCRIPTS = [
  '/yomu-source-pack-truth.js',
  '/yomu-source-truth.js',
];

function injectScripts(html: string, scripts: string[]): string {
  const missing = scripts.filter((script) => !html.includes(script));
  if (!missing.length) return html;
  const tags = missing.map((script) => `<script src="${script}" defer></script>`).join('');
  return html.includes('</body>') ? html.replace('</body>', `${tags}</body>`) : html + tags;
}

async function ensureHtmlScripts(
  response: Response,
  scripts: string[],
  markerName: string,
  markerValue: string,
): Promise<Response> {
  if (!response.ok) return response;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;

  const html = injectScripts(await response.text(), scripts);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set(markerName, markerValue);
  headers.set('x-yomu-entrypoint', 'v10');
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
      return ensureHtmlScripts(response, READER_SCRIPTS, 'x-yomu-reader-continuity', 'v10-focus');
    }

    if (
      request.method === 'GET' &&
      (url.pathname === '/sources' || url.pathname === '/sources/' || url.pathname === '/sources.html')
    ) {
      return ensureHtmlScripts(response, SOURCE_TRUTH_SCRIPTS, 'x-yomu-source-ui', 'registry-truth');
    }

    return response;
  },
};
