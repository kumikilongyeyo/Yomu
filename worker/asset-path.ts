/**
 * An id with a slash in it, kept in one piece on its way to the asset server.
 *
 * Asura's and Flame's chapter ids contain a slash, so their reader address is
 * /read/<series>:<a>%2F<b>. Cloudflare's asset server decodes each path
 * segment, re-encodes the result split on "/", and answers any difference with
 * a 307 to its own spelling -- in which the id's slash is now a real one:
 * /read/1%3A1/385fe46707bd150c. That is three segments, and Expo's router
 * answers it with "Unmatched Route". So every hard load of such a chapter (a
 * reload, a shared link, a location.assign) was a blank page, while tapping
 * through worked: the app's own router never asks the server.
 *
 * There is no file named after a chapter or a series; every /read/ and
 * /series/ address is the same SPA shell. So the shell is asked for under a
 * spelling the asset server has no reason to rewrite -- the id's slash
 * encoded once more -- and is served at the address the browser asked for.
 * The page then reads the id off location with one decode, as every helper
 * already does.
 */

type Assets = { fetch(request: Request): Promise<Response> };

const APP_ROUTE = /^\/(read|series)\//;

/**
 * The asset server's own spelling of `pathname`, with a slash inside a segment
 * kept inside it; null when there is nothing to change.
 * Mirrors the asset server's per-segment decode (a segment that does not
 * decode is left as it is, as there).
 */
export function slashSafeAssetPath(pathname: string): string | null {
  if (!APP_ROUTE.test(pathname) || !/%2f/i.test(pathname)) return null;
  const safe = pathname.split('/').map((part) => {
    let text: string;
    try { text = decodeURIComponent(part); } catch { return part; }
    return encodeURIComponent(text).replace(/%2F/g, '%252F');
  }).join('/');
  return safe === pathname ? null : safe;
}

/** env.ASSETS.fetch(request), for an address whose id may contain a slash. */
export async function fetchAsset(assets: Assets, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const safe = request.method === 'GET' || request.method === 'HEAD' ? slashSafeAssetPath(url.pathname) : null;
  if (!safe) return assets.fetch(request);
  const shell = await assets.fetch(new Request(new URL(safe + url.search, url.origin).href, request));
  /* A redirect from here would hand the browser the stand-in spelling. The
     asset server's own answer is no worse than it has always been. */
  if (shell.status >= 300 && shell.status < 400) return assets.fetch(request);
  return shell;
}
