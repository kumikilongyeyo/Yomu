/**
 * robots.txt and sitemap.xml.
 *
 * Both were missing, and missing here is worse than absent: with
 * `not_found_handling: "single-page-application"` an unmatched path is
 * answered with index.html and a 200, so a crawler asking for /robots.txt got
 * a page of HTML and was told it was fine. Google treats an HTML robots.txt
 * as unparseable and an HTML sitemap as an error, and neither failure is
 * visible from inside the app.
 *
 * What is listed is what a stranger can actually use: the reading surfaces.
 * Not /start (the first-run flow), not /bench or /ui-kit (development), not
 * /adult, and nothing under /api.
 *
 * Series URLs are deliberately not enumerated yet. A real series sitemap
 * means walking the catalog and committing to canonical ids, which is the
 * CanonicalTitle work; listing a few thousand provider-bound `/series/<id>`
 * URLs would publish exactly the addresses that change when a source dies.
 * `/title/<slug>` is the address that survives, and the sitemap will list
 * those once there is a title graph to enumerate. Until then this is honest
 * and small rather than large and wrong.
 */

const ORIGIN = 'https://yomu.yomuread.workers.dev';

/** Public reading surfaces, with how often they actually change. */
const ROUTES: Array<{ path: string; changefreq: string; priority: string }> = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/find', changefreq: 'daily', priority: '0.9' },
  { path: '/library', changefreq: 'weekly', priority: '0.6' },
  { path: '/you', changefreq: 'weekly', priority: '0.4' },
  { path: '/settings', changefreq: 'monthly', priority: '0.2' },
];

/** Surfaces a crawler should not spend its budget on, or should not index. */
const DISALLOW = [
  '/api/',
  '/read/',        // one page of artwork, behind a source, with no text
  '/__offline/',
  '/start',        // the first-run flow; a stranger landing here sees setup
  '/adult',
  '/bench',
  '/ui-kit',
  '/join',
  '/shelf/',       // someone's shared shelf is theirs, not an index entry
];

const text = (body: string, type: string) =>
  new Response(body, {
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=3600',
    },
  });

export function robots(): Response {
  const body = [
    'User-agent: *',
    ...DISALLOW.map((path) => `Disallow: ${path}`),
    'Allow: /',
    '',
    `Sitemap: ${ORIGIN}/sitemap.xml`,
    '',
  ].join('\n');
  return text(body, 'text/plain; charset=utf-8');
}

export function sitemap(): Response {
  const today = new Date().toISOString().slice(0, 10);
  const urls = ROUTES.map(({ path, changefreq, priority }) => [
    '  <url>',
    `    <loc>${ORIGIN}${path}</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>${changefreq}</changefreq>`,
    `    <priority>${priority}</priority>`,
    '  </url>',
  ].join('\n')).join('\n');

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    '</urlset>',
    '',
  ].join('\n');
  return text(body, 'application/xml; charset=utf-8');
}

export function handleSeo(url: URL): Response | null {
  if (url.pathname === '/robots.txt') return robots();
  if (url.pathname === '/sitemap.xml') return sitemap();
  return null;
}
