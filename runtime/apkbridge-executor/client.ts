export type ApkBridgeMethod =
  | 'headersManga'
  | 'filtersManga'
  | 'supportLatestManga'
  | 'getPopularManga'
  | 'getLatestManga'
  | 'getSearchManga'
  | 'getDetailsManga'
  | 'getChapterList'
  | 'getPageList'
  | 'preferencesManga'
  | 'headersAnime'
  | 'filtersAnime'
  | 'supportLatestAnime'
  | 'getPopularAnime'
  | 'getLatestAnime'
  | 'getSearchAnime'
  | 'getDetailsAnime'
  | 'getEpisodeList'
  | 'getVideoList'
  | 'preferencesAnime';

export interface MangaPayload {
  url: string;
  title?: string;
  artist?: string | null;
  author?: string | null;
  description?: string | null;
  genre?: string | null;
  status?: number;
  thumbnailUrl?: string | null;
  thumbnail_url?: string | null;
  initialized?: boolean;
}

export interface ChapterPayload {
  url: string;
  name?: string;
  dateUpload?: number;
  date_upload?: number;
  chapterNumber?: number;
  chapter_number?: number;
  scanlator?: string | null;
}

export interface ApkBridgeRequest {
  data: string;
  method: ApkBridgeMethod;
  page?: number;
  search?: string;
  mangaData?: MangaPayload;
  chapterData?: ChapterPayload;
  animeData?: unknown;
  episodeData?: unknown;
  filterList?: unknown[];
  preferences?: unknown[];
}

export interface ApkBridgeExecutorOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported APKBridge protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('Do not embed APKBridge credentials in the URL.');
  }
  return url.toString().replace(/\/+$/, '');
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export class ApkBridgeExecutor {
  readonly baseUrl: string;
  readonly token?: string;
  readonly timeoutMs: number;

  constructor(options: ApkBridgeExecutorOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token?.trim() || undefined;
    this.timeoutMs = Math.max(2_000, options.timeoutMs ?? 45_000);
  }

  async downloadApk(apkUrl: string): Promise<Uint8Array> {
    const url = new URL(apkUrl);
    if (url.protocol !== 'https:') {
      throw new Error('Executable extensions must be downloaded over HTTPS.');
    }
    const response = await fetch(url, {
      headers: { 'user-agent': 'Yomu-Universal-APK-Executor/1.0' },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`APK download failed with HTTP ${response.status}.`);
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 32 * 1024 * 1024) {
      throw new Error(`APK is too large for the bridge (${length} bytes).`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 32 * 1024 * 1024) {
      throw new Error(`Invalid APK payload size: ${bytes.length}.`);
    }
    // ZIP/APK magic: PK\x03\x04
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      throw new Error('Downloaded extension is not an APK/ZIP payload.');
    }
    return bytes;
  }

  async invoke<T>(apkBytes: Uint8Array, request: Omit<ApkBridgeRequest, 'data'>): Promise<T> {
    const payload: ApkBridgeRequest = {
      ...request,
      page: Math.max(1, Number(request.page || 1)),
      data: bytesToBase64(apkBytes),
    };

    const response = await fetch(`${this.baseUrl}/dalvik`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'Yomu-Universal-APK-Executor/1.0',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`APKBridge ${request.method} failed with HTTP ${response.status}${text ? `: ${text.slice(0, 240)}` : ''}`);
    }

    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      const text = await response.text().catch(() => '');
      throw new Error(`APKBridge returned non-JSON for ${request.method}: ${text.slice(0, 240)}`);
    }
    return response.json() as Promise<T>;
  }

  async popular<T>(apkBytes: Uint8Array, page = 1): Promise<T> {
    return this.invoke<T>(apkBytes, { method: 'getPopularManga', page });
  }

  async latest<T>(apkBytes: Uint8Array, page = 1): Promise<T> {
    return this.invoke<T>(apkBytes, { method: 'getLatestManga', page });
  }

  async search<T>(apkBytes: Uint8Array, query: string, page = 1, filterList?: unknown[]): Promise<T> {
    return this.invoke<T>(apkBytes, { method: 'getSearchManga', page, search: query, filterList });
  }

  async details<T>(apkBytes: Uint8Array, mangaData: MangaPayload): Promise<T> {
    return this.invoke<T>(apkBytes, { method: 'getDetailsManga', mangaData });
  }

  async chapters<T>(apkBytes: Uint8Array, mangaData: MangaPayload): Promise<T> {
    return this.invoke<T>(apkBytes, { method: 'getChapterList', mangaData });
  }

  async pages<T>(apkBytes: Uint8Array, chapterData: ChapterPayload): Promise<T> {
    return this.invoke<T>(apkBytes, { method: 'getPageList', chapterData });
  }
}
