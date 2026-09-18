/**
 * HTTP surface for shared shelves.
 *
 *   POST /api/shelf/publish     {name, items}               -> new shelf + token
 *   POST /api/shelf/publish     {code, token, name, items}  -> update in place
 *   POST /api/shelf/unpublish   {code, token}               -> gone
 *   GET  /api/shelf/<code>                                  -> the public shelf
 *
 * One key, `shelf:<code>`, in the SYNC namespace beside `lib:` and `circle:`.
 * The code is minted the way theirs are and refused if it names any of them,
 * so a shelf link can never be a library code or a circle code by accident.
 * The token is what lets the publisher update or remove it; the code alone
 * only reads.
 */
import type { Env } from './index';
import { SHELF_SCHEMA, publicShelf, sanitiseItems, sanitiseName } from './shelf';
import type { ShelfDoc } from './shelf';
import { formatCode, generateCode, normalizeCode } from './sync';

const json = (body: unknown, status = 200, cache = 'no-store, private') =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  });

const bad = (message: string, status = 400) => json({ error: message }, status);
const key = (code: string) => `shelf:${code}`;

async function body(request: Request): Promise<Record<string, any>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

async function read(env: Env, code: string): Promise<ShelfDoc | null> {
  const raw = await env.SYNC.get(key(code), 'json');
  return raw && typeof raw === 'object' && Array.isArray((raw as any).items) ? (raw as ShelfDoc) : null;
}

async function freshCode(env: Env): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const taken = await Promise.all([
      env.SYNC.get(`lib:${code}`), env.SYNC.get(`circle:${code}`), env.SYNC.get(key(code)),
    ]);
    if (taken.every((v) => !v)) return code;
  }
  return null;
}

export async function handleShelf(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.SYNC) return bad('Shelves are not configured on this deployment.', 503);
  const route = url.pathname.slice('/api/shelf/'.length).replace(/\/$/, '');

  /* Anyone with the link. Cached briefly at the edge: a shelf changes when
     its owner presses Update, which is rarely, and the link may be posted
     somewhere busy. */
  if (request.method === 'GET') {
    const code = normalizeCode(route);
    if (!code) return bad('That does not look like a shelf link.', 404);
    const doc = await read(env, code);
    if (!doc) return bad('This shelf is gone, or the link is wrong.', 404);
    return json(publicShelf(doc, code), 200, 'public, max-age=300');
  }

  if (request.method !== 'POST') return bad('Use POST.', 405);
  const payload = await body(request);
  const now = Date.now();

  if (route === 'publish') {
    const items = sanitiseItems(payload.items);
    if (!items.length) return bad('A shelf needs at least one title.');
    const name = sanitiseName(payload.name);

    const code = normalizeCode(payload.code);
    if (code) {
      const existing = await read(env, code);
      if (!existing) return bad('That shelf is gone. Publish it again.', 404);
      if (typeof payload.token !== 'string' || payload.token !== existing.token) {
        return bad('That is not your shelf to change.', 403);
      }
      const next: ShelfDoc = { ...existing, name, items, at: now, revision: existing.revision + 1 };
      await env.SYNC.put(key(code), JSON.stringify(next));
      return json({ code, display: formatCode(code), url: `/shelf/${code}`, token: existing.token, at: now, count: items.length, revision: next.revision });
    }

    const fresh = await freshCode(env);
    if (!fresh) return bad('Please try again.', 503);
    const token = crypto.randomUUID();
    const doc: ShelfDoc = { schema: SHELF_SCHEMA, revision: 1, name, items, at: now, token };
    await env.SYNC.put(key(fresh), JSON.stringify(doc));
    return json({ code: fresh, display: formatCode(fresh), url: `/shelf/${fresh}`, token, at: now, count: items.length, revision: 1 });
  }

  if (route === 'unpublish') {
    const code = normalizeCode(payload.code);
    if (!code) return bad('That does not look like a shelf link.');
    const existing = await read(env, code);
    if (!existing) return json({ ok: true });
    if (typeof payload.token !== 'string' || payload.token !== existing.token) {
      return bad('That is not your shelf to remove.', 403);
    }
    await env.SYNC.delete(key(code));
    return json({ ok: true });
  }

  return bad('Unknown shelf route.', 404);
}
