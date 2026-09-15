type AnyObject = Record<string, any>;

const BASE = 'https://kagane.to';
const API = `${BASE}/api/v2`;
const UA = 'Yomu-Source-Fabric/5.3';

const json = (body: unknown, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
    },
  });

function cleanText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

const commonHeaders = (jsonBody = false): Record<string, string> => ({
  'user-agent': UA,
  'accept': 'application/json',
  'accept-language': 'en-US,en;q=0.8',
  'referer': `${BASE}/`,
  'origin': BASE,
  ...(jsonBody ? { 'content-type': 'application/json' } : {}),
});

async function kaganeJson(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...commonHeaders(Boolean(init.body)),
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  if (!response.ok) {
    const detail = cleanText(text).slice(0, 300);
    const error = new Error(
      `Kagane API returned HTTP ${response.status}${detail ? ` · ${detail}` : ''}`,
    ) as Error & { upstreamStatus?: number };
    error.upstreamStatus = response.status;
    throw error;
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Kagane returned an invalid JSON response.');
  }
}

// Mirrors the current Keiyoushi Kagane search payload.
const searchBody = (query = '') => ({
  ...(query ? { title: query } : {}),
  source_type: ['Official', 'Unofficial', 'Mixed'],
  content_rating: ['Safe', 'Suggestive', 'Erotica', 'Pornographic'],
  content_lang: ['en'],
});

function summary(book: AnyObject) {
  return {
    id: String(book.series_id ?? book.id ?? ''),
    title: String(book.title ?? 'Untitled').trim(),
    ...(book.cover_image_id ? { cover: `${API}/image/${book.cover_image_id}` } : {}),
    ...(book.start_year ? { year: Number(book.start_year) } : {}),
  };
}

async function list(kind: 'popular' | 'latest' | 'search', q = '', page = 1) {
  const sort = kind === 'latest' ? 'updated_at,desc' : kind === 'popular' ? 'total_views,desc' : '';
  const params = new URLSearchParams({
    page: String(Math.max(0, page - 1)),
    size: '35',
  });
  if (sort) params.set('sort', sort);

  const dto = await kaganeJson(`/search/series?${params.toString()}`, {
    method: 'POST',
    body: JSON.stringify(searchBody(q)),
  });

  return {
    series: Array.isArray(dto.content) ? dto.content.map(summary) : [],
    hasNextPage: dto.last === false,
  };
}

function chapterNumber(ch: AnyObject, fallback: number): number {
  const n = Number.parseFloat(String(ch.chapter_no ?? ch.sort_no ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

async function detail(id: string) {
  const dto: AnyObject = await kaganeJson(`/series/${encodeURIComponent(id)}`);
  const books: AnyObject[] = Array.isArray(dto.series_books) ? dto.series_books : [];
  const genres = [
    dto.format,
    ...(Array.isArray(dto.genres) ? dto.genres.map((g: AnyObject) => g.genre_name) : []),
  ].filter(Boolean);
  const authors = (Array.isArray(dto.series_staff) ? dto.series_staff : [])
    .filter((s: AnyObject) => /author|story/i.test(String(s.role ?? '')))
    .map((s: AnyObject) => s.name)
    .filter(Boolean);
  const coverId = Array.isArray(dto.series_covers) ? dto.series_covers[0]?.image_id : undefined;

  return {
    id,
    title: String(dto.title ?? 'Untitled').trim(),
    author: authors.join(', ') || undefined,
    synopsis: cleanText(String(dto.description ?? '')),
    genres,
    status: String(dto.upload_status ?? '').toLowerCase() || undefined,
    ...(coverId ? { cover: `${API}/image/${coverId}` } : {}),
    chapters: books.map((ch: AnyObject, i: number) => ({
      id: String(ch.book_id ?? ch.id ?? ''),
      number: chapterNumber(ch, books.length - i),
      name: String(ch.title ?? '').trim() || (ch.chapter_no ? `Ch.${ch.chapter_no}` : `Chapter ${books.length - i}`),
      pageCount: Number(ch.page_count ?? 0) || undefined,
      ...(ch.created_at ? { publishedAt: Date.parse(ch.created_at) || undefined } : {}),
      ...((Array.isArray(ch.groups) && ch.groups.length)
        ? { scanlator: ch.groups.map((g: AnyObject) => g.title).filter(Boolean).join(', ') }
        : {}),
    })).reverse(),
  };
}

type Integrity = { token: string; exp: number; cookie: string };
let integrityCache: Integrity | null = null;

function responseCookie(response: Response): string {
  const headers = response.headers as any;
  const rows: string[] = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  if (!rows.length) {
    const one = response.headers.get('set-cookie');
    if (one) rows.push(one);
  }
  return rows.map((row) => row.split(';')[0]).filter(Boolean).join('; ');
}

async function integrity(force = false): Promise<Integrity> {
  if (!force && integrityCache && integrityCache.exp > Date.now() + 10_000) return integrityCache;

  const home = await fetch(`${BASE}/`, {
    headers: {
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.8',
      'referer': `${BASE}/`,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  });
  if (!home.ok) {
    throw Object.assign(new Error(`Kagane access check returned HTTP ${home.status}.`), {
      upstreamStatus: home.status,
    });
  }

  const cookie = responseCookie(home);
  const response = await fetch(`${BASE}/api/integrity`, {
    method: 'POST',
    headers: {
      ...commonHeaders(true),
      ...(cookie ? { cookie } : {}),
    },
    body: '',
    signal: AbortSignal.timeout(12_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(
      new Error(`Kagane integrity endpoint returned HTTP ${response.status}${text ? ` · ${cleanText(text).slice(0, 220)}` : ''}`),
      { upstreamStatus: response.status },
    );
  }

  const dto: AnyObject = text ? JSON.parse(text) : {};
  const next = {
    token: String(dto.token ?? ''),
    exp: Number(dto.exp ?? 0) * 1000 || Date.now() + 60_000,
    cookie,
  };
  if (!next.token) throw new Error('Kagane did not issue an integrity token.');
  integrityCache = next;
  return next;
}

async function challenge(chapterId: string, force = false): Promise<AnyObject> {
  const auth = await integrity(force);
  const response = await fetch(`${API}/books/${encodeURIComponent(chapterId)}?is_datasaver=false`, {
    method: 'POST',
    headers: {
      ...commonHeaders(true),
      'x-integrity-token': auth.token,
      ...(auth.cookie ? { cookie: auth.cookie } : {}),
    },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });

  if ((response.status === 401 || response.status === 403 || response.status === 507) && !force) {
    return challenge(chapterId, true);
  }

  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(
      new Error(`Kagane reader returned HTTP ${response.status}${text ? ` · ${cleanText(text).slice(0, 220)}` : ''}`),
      { upstreamStatus: response.status },
    );
  }
  return text ? JSON.parse(text) : {};
}

async function pages(chapterId: string) {
  const dto = await challenge(chapterId);
  const token = String(dto.access_token ?? '');
  const cacheUrl = String(dto.cache_url ?? '').replace(/\/$/, '');
  if (!token || !cacheUrl) throw new Error('Kagane reader did not return a usable page token.');

  const rows: AnyObject[] = Array.isArray(dto.manifest?.pages) ? dto.manifest.pages : [];
  return rows.map((page: AnyObject, index: number) => {
    const pageId = String(page.page_id ?? '');
    const ext = String(page.ext ?? 'jxl');
    return {
      key: `${chapterId}-${index}`,
      index,
      url: `${cacheUrl}/api/v2/books/page/${encodeURIComponent(chapterId)}/${encodeURIComponent(pageId)}.${encodeURIComponent(ext)}?token=${encodeURIComponent(token)}`,
    };
  });
}

export async function handleKaganeV53(request: Request, url: URL): Promise<Response> {
  if (!url.pathname.startsWith('/api/fabric/source/kagane/')) {
    return json({ error: 'Not a Kagane route.' }, 404);
  }
  if (request.method !== 'GET') {
    return json({ error: 'Kagane source endpoints are read-only.' }, 405);
  }

  const rest = url.pathname.slice('/api/fabric/source/kagane/'.length);
  try {
    if (rest === 'series') {
      return json(await list('popular', '', Number(url.searchParams.get('page') ?? '1') || 1), 200, 'private, max-age=120');
    }
    if (rest === 'latest') {
      return json(await list('latest', '', Number(url.searchParams.get('page') ?? '1') || 1), 200, 'private, max-age=90');
    }
    if (rest === 'search') {
      return json(await list('search', url.searchParams.get('q') ?? '', Number(url.searchParams.get('page') ?? '1') || 1), 200, 'private, max-age=60');
    }

    const series = rest.match(/^series\/([^/]+)$/);
    if (series) {
      return json(await detail(decodeURIComponent(series[1])), 200, 'private, max-age=120');
    }

    const manifest = rest.match(/^chapters\/([^/]+)\/manifest$/);
    if (manifest) {
      const chapterId = decodeURIComponent(manifest[1]);
      const pageRows = await pages(chapterId);
      return json({
        schema: 'yomu.chapter-manifest/1',
        chapterId,
        sourceSeriesId: '',
        manifestVersion: `kagane-v53-${chapterId}-${pageRows.length}`,
        pageListVersion: pageRows.length,
        expiresAt: Date.now() + 8 * 60 * 1000,
        pages: pageRows,
        delivery: 'direct',
      });
    }

    if (rest === 'health') {
      const result = await list('popular', '', 1);
      return json({ ok: true, provider: 'kagane-v5.3', sampled: result.series.length });
    }

    return json({ error: 'Unknown Kagane Source Fabric endpoint.' }, 404);
  } catch (error: any) {
    return json({
      error: error?.message ?? 'Kagane request failed.',
      upstreamStatus: error?.upstreamStatus,
      provider: 'kagane-v5.3',
    }, 502);
  }
}
