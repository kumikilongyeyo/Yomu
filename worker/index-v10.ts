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

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const response = await v9.fetch(request as any, env, ctx);
    if (request.method === 'GET' && url.pathname.startsWith('/read/')) {
      return ensureReaderContinuity(response);
    }
    return response;
  },
};
