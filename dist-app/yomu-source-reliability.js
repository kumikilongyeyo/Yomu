/**
 * Yomu Source Reliability Layer
 *
 * The app has several source systems (shared extensions, Source Fabric,
 * device-added API sources and Suwayomi). This layer makes them behave like
 * one pool instead of letting a dead provider strand Search, Series or Reader.
 */
(() => {
  'use strict';
  if (window.__YomuSourceReliability) return;
  window.__YomuSourceReliability = true;

  const COLLECTION_KEY = 'yomu.v1.collection';
  const TITLE_MAP_KEY = 'yomu.v1.sourceTitleMap';
  const READ_MAP_KEY = 'yomu.v1.readerContext';
  const RECOVERY_GUARD_KEY = 'yomu.v1.sourceRecoveryGuard';
  const SEARCH_CONCURRENCY = 6;
  const DETAIL_CONCURRENCY = 4;
  const VERIFY_CONCURRENCY = 4;
  const previousFetch = window.fetch.bind(window);

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch {
      return fallback;
    }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  const normalize = (value) => String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|of|and|manga|manhwa|manhua|webtoon|comic|official|colou?red?|color|season|part|vol(?:ume)?|novel|remake|fan\s?colou?red)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const toProviderId = (sourceId) => {
    const id = String(sourceId || '');
    if (id.startsWith('yomuext-')) return `ext:${id.slice(8)}`;
    if (id.startsWith('mihon-')) return `suwayomi:${id.slice(6)}`;
    return id;
  };
  const toAppSource = (providerId) => {
    const id = String(providerId || '');
    if (id.startsWith('ext:')) return `yomuext-${id.slice(4)}`;
    if (id.startsWith('suwayomi:')) return `mihon-${id.slice(9)}`;
    return id;
  };

  function canonicalApi(value) {
    try {
      const url = new URL(String(value || ''), location.origin);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.hash = '';
      url.search = '';
      let out = url.toString();
      if (!out.endsWith('/')) out += '/';
      return out;
    } catch {
      return null;
    }
  }

  function collectionSources() {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    return Array.isArray(collection.sources) ? collection.sources : [];
  }

  function enabledApiSources() {
    const seen = new Set();
    const out = [];
    for (const source of collectionSources()) {
      if (!source || source.enabled === false) continue;
      const id = String(source.id || '').trim();
      if (!id || id === 'mangadex') continue;
      // API is the contract Search/Series/Manifest can fan out to. Some older
      // saved Source Fabric rows predate `kind: api`, so a usable /api URL is
      // accepted as well instead of silently dropping those sources forever.
      const api = canonicalApi(source.url || source.api);
      if (!api) continue;
      const looksLikeApi = source.kind === 'api'
        || /\/api\//i.test(new URL(api).pathname)
        || /\/api\/fabric\//i.test(api)
        || /\/api\/ext\/source\//i.test(api);
      if (!looksLikeApi || seen.has(api)) continue;
      seen.add(api);
      out.push({
        id,
        providerId: toProviderId(id),
        label: String(source.label || source.name || id),
        api,
      });
    }
    return out;
  }

  async function pool(items, limit, worker) {
    const out = new Array(items.length);
    let cursor = 0;
    const runner = async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        try { out[index] = await worker(items[index], index); }
        catch (error) { out[index] = { ok: false, error: String(error?.message || error || 'failed') }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => runner()));
    return out;
  }

  async function sourceSearch(source, query) {
    try {
      const endpoint = new URL('search', source.api);
      endpoint.searchParams.set('q', query);
      endpoint.searchParams.set('page', '1');
      const response = await previousFetch(endpoint.toString(), {
        cache: 'no-store', signal: AbortSignal.timeout(12000),
      });
      const body = response.ok ? await response.json().catch(() => null) : null;
      return { source, ok: !!(response.ok && Array.isArray(body?.series)), series: body?.series || [], status: response.status };
    } catch (error) {
      return { source, ok: false, series: [], error: String(error?.message || error || 'search failed') };
    }
  }

  function titleScore(item, query) {
    const q = normalize(query);
    if (!q) return 0;
    const names = [item?.title, ...(Array.isArray(item?.altTitles) ? item.altTitles : [])]
      .map(normalize).filter(Boolean);
    if (names.some((name) => name === q)) return 1;
    if (names.some((name) => name.includes(q) || q.includes(name))) return 0.86;
    const qWords = new Set(q.split(' '));
    let best = 0;
    for (const name of names) {
      const words = new Set(name.split(' '));
      const hit = [...qWords].filter((word) => words.has(word)).length;
      best = Math.max(best, hit / Math.max(qWords.size, words.size, 1));
    }
    return best;
  }

  function rememberTitle(title, providerId, seriesId) {
    if (!title || !providerId || !seriesId) return;
    const store = readJSON(TITLE_MAP_KEY, {}) || {};
    const key = `${toAppSource(providerId)}:${seriesId}`;
    store[key] = { title: String(title), providerId: String(providerId), seriesId: String(seriesId), at: Date.now() };
    const entries = Object.entries(store).sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0)).slice(0, 500);
    writeJSON(TITLE_MAP_KEY, Object.fromEntries(entries));
  }

  function mergeSearchPayload(payload, batches, query) {
    if (!payload || !Array.isArray(payload.series)) return payload;
    const rows = payload.series.map((row) => ({ ...row, providers: Array.isArray(row?.providers) ? [...row.providers] : [] }));
    const byTitle = new Map();
    for (const row of rows) {
      const key = normalize(row?.title);
      if (key && !byTitle.has(key)) byTitle.set(key, row);
      for (const provider of row.providers || []) rememberTitle(row.title, provider?.id, provider?.seriesId);
    }

    let responded = 0;
    for (const batch of batches) {
      if (!batch?.source) continue;
      if (batch.ok) responded += 1;
      for (const item of batch.series || []) {
        if (!item?.id || !item?.title || titleScore(item, query) < 0.35) continue;
        const provider = {
          id: batch.source.providerId,
          name: batch.source.label,
          kind: 'extension',
          seriesId: String(item.id),
        };
        const key = normalize(item.title);
        const existing = byTitle.get(key);
        if (existing) {
          const providers = Array.isArray(existing.providers) ? existing.providers : [];
          if (!providers.some((p) => String(p?.id || '') === provider.id && String(p?.seriesId || '') === provider.seriesId)) {
            existing.providers = [...providers, provider];
          }
          existing.cover ||= item.cover;
          existing.author ||= item.author;
          existing.synopsis ||= item.synopsis;
          existing.category ||= item.category;
          existing.status ||= item.status;
          existing.year ||= item.year;
          if (!existing.altTitles?.length && Array.isArray(item.altTitles)) existing.altTitles = item.altTitles;
        } else {
          const fresh = { ...item, providers: [provider] };
          rows.push(fresh);
          byTitle.set(key, fresh);
        }
        rememberTitle(item.title, provider.id, provider.seriesId);
      }
    }

    rows.sort((a, b) => titleScore(b, query) - titleScore(a, query));
    return {
      ...payload,
      series: rows,
      allEnabledSourcesSearched: batches.length,
      allEnabledSourcesResponded: responded,
    };
  }

  async function sourceDetail(source, seriesId) {
    try {
      const endpoint = new URL(`series/${encodeURIComponent(seriesId)}`, source.api);
      const response = await previousFetch(endpoint.toString(), {
        cache: 'no-store', signal: AbortSignal.timeout(14000),
      });
      const body = response.ok ? await response.json().catch(() => null) : null;
      const chapters = Array.isArray(body?.chapters) ? body.chapters : [];
      return { source, seriesId, ok: response.ok && !!body, body, chapters, status: response.status };
    } catch (error) {
      return { source, seriesId, ok: false, body: null, chapters: [], error: String(error?.message || error || 'detail failed') };
    }
  }

  async function resolveLocalLedgerSources(target) {
    const sources = enabledApiSources();
    if (!sources.length) return [];
    const links = target.searchParams.getAll('link').filter(Boolean);
    const title = String(target.searchParams.get('title') || '').trim();

    if (links.length) {
      const jobs = [];
      for (const source of sources) {
        const prefix = `${source.providerId}:`;
        const link = links.find((value) => value.startsWith(prefix));
        if (!link) continue;
        const seriesId = link.slice(prefix.length);
        if (seriesId) jobs.push({ source, seriesId });
      }
      return pool(jobs, DETAIL_CONCURRENCY, (job) => sourceDetail(job.source, job.seriesId));
    }

    if (!title) return [];
    const searches = await pool(sources, SEARCH_CONCURRENCY, (source) => sourceSearch(source, title));
    const jobs = [];
    for (const batch of searches) {
      if (!batch?.ok || !batch.source) continue;
      const ranked = [...(batch.series || [])]
        .map((item) => ({ item, score: titleScore(item, title) }))
        .sort((a, b) => b.score - a.score);
      if (!ranked[0] || ranked[0].score < 0.58) continue;
      jobs.push({ source: batch.source, seriesId: String(ranked[0].item.id) });
      rememberTitle(ranked[0].item.title || title, batch.source.providerId, ranked[0].item.id);
    }
    return pool(jobs, DETAIL_CONCURRENCY, (job) => sourceDetail(job.source, job.seriesId));
  }

  function chapterNumber(chapter, fallback) {
    const direct = Number(chapter?.number);
    if (Number.isFinite(direct)) return direct;
    const text = String(chapter?.name || chapter?.title || '');
    const match = text.match(/(?:chapter|ch\.?|episode|ep\.?)\s*([0-9]+(?:\.[0-9]+)?)/i)
      || text.match(/\b([0-9]+(?:\.[0-9]+)?)\b/);
    return match ? Number(match[1]) : fallback;
  }

  function rememberReaderContext(title, number, release, allLinks) {
    if (!release?.chapterId || !release?.providerId) return;
    const store = readJSON(READ_MAP_KEY, {}) || {};
    const key = `${toAppSource(release.providerId)}:${release.chapterId}`;
    store[key] = {
      title: String(title || ''),
      number: Number(number),
      providerId: String(release.providerId),
      chapterId: String(release.chapterId),
      links: allLinks,
      at: Date.now(),
    };
    const entries = Object.entries(store).sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0)).slice(0, 1600);
    writeJSON(READ_MAP_KEY, Object.fromEntries(entries));
  }

  function mergeLedgerPayload(payload, details, title) {
    if (!payload || !Array.isArray(payload.rows) || !Array.isArray(payload.sources)) return payload;
    const out = {
      ...payload,
      sources: payload.sources.map((source) => ({ ...source })),
      rows: payload.rows.map((row) => ({ ...row, releases: Array.isArray(row?.releases) ? [...row.releases] : [] })),
    };
    const sourceKeys = new Set(out.sources.map((s) => `${s.providerId}:${s.seriesId}`));
    const rowsByNumber = new Map();
    for (const row of out.rows) {
      const n = Number(row?.number);
      if (Number.isFinite(n)) rowsByNumber.set(n, row);
    }

    for (const detail of details || []) {
      if (!detail?.source || !detail.seriesId) continue;
      const providerId = detail.source.providerId;
      const providerName = detail.source.label;
      const key = `${providerId}:${detail.seriesId}`;
      if (!sourceKeys.has(key)) {
        out.sources.push({
          providerId,
          providerName,
          kind: 'extension',
          seriesId: detail.seriesId,
          chapterCount: detail.chapters?.length || 0,
          ok: !!detail.ok,
          ...(detail.ok ? {} : { error: detail.error || (detail.status ? `HTTP ${detail.status}` : 'source failed') }),
        });
        sourceKeys.add(key);
      }
      if (!detail.ok) continue;
      const total = detail.chapters.length;
      for (let i = 0; i < total; i += 1) {
        const chapter = detail.chapters[i];
        if (!chapter?.id) continue;
        const n = chapterNumber(chapter, i + 1);
        if (!Number.isFinite(n)) continue;
        let row = rowsByNumber.get(n);
        if (!row) {
          row = { number: n, label: String(n), name: chapter.name || `Chapter ${n}`, releases: [] };
          rowsByNumber.set(n, row);
          out.rows.push(row);
        }
        const release = {
          providerId,
          providerName,
          kind: 'extension',
          seriesId: detail.seriesId,
          chapterId: String(chapter.id),
          pageCount: Number(chapter.pageCount || 0) || undefined,
          scanlator: chapter.scanlator || undefined,
        };
        if (!row.releases.some((r) => String(r?.providerId) === providerId && String(r?.chapterId) === release.chapterId)) {
          row.releases.push(release);
        }
      }
      rememberTitle(detail.body?.title || title, providerId, detail.seriesId);
    }

    out.rows.sort((a, b) => Number(b.number || 0) - Number(a.number || 0));
    const links = out.sources
      .filter((source) => source?.providerId && source?.seriesId)
      .map((source) => `${source.providerId}:${source.seriesId}`);
    for (const row of out.rows) {
      for (const release of row.releases || []) rememberReaderContext(title, row.number, release, links);
    }
    out.deviceSourcesMerged = details.filter((detail) => detail?.ok).length;
    return out;
  }

  async function rememberSeriesApiResponse(target, response) {
    if (!response.ok) return;
    const source = enabledApiSources().find((item) => target.toString().startsWith(item.api));
    if (!source) return;
    const body = await response.clone().json().catch(() => null);
    if (!body || !Array.isArray(body.chapters)) return;
    const match = target.pathname.match(/\/series\/([^/]+)$/);
    let seriesId = String(body.id || '');
    if (!seriesId && match) {
      try { seriesId = decodeURIComponent(match[1]); } catch { seriesId = match[1]; }
    }
    const title = String(body.title || '').trim();
    rememberTitle(title, source.providerId, seriesId);
    const links = [`${source.providerId}:${seriesId}`];
    for (let i = 0; i < body.chapters.length; i += 1) {
      const chapter = body.chapters[i];
      if (!chapter?.id) continue;
      const n = chapterNumber(chapter, i + 1);
      rememberReaderContext(title, n, {
        providerId: source.providerId,
        chapterId: String(chapter.id),
      }, links);
    }
  }

  function jsonResponse(base, body, extraHeaders = {}) {
    const headers = new Headers(base.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store, max-age=0');
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, String(value));
    return new Response(JSON.stringify(body), {
      status: base.status,
      statusText: base.statusText,
      headers,
    });
  }

  async function repairManifest(response, target) {
    if (!response.ok) return response;
    const body = await response.clone().json().catch(() => null);
    if (!body || !Array.isArray(body.pages)) return response;
    if (String(body.sourceSeriesId || '').trim()) return response;

    const match = target.pathname.match(/\/chapters\/([^/]+)\/manifest$/);
    let chapterId = String(body.chapterId || '');
    if (!chapterId && match) {
      try { chapterId = decodeURIComponent(match[1]); } catch { chapterId = match[1]; }
    }
    const explicit = target.searchParams.get('series') || target.searchParams.get('sourceSeriesId') || '';
    const sourceSeriesId = String(explicit || chapterId || `chapter-${Date.now()}`);
    return jsonResponse(response, { ...body, sourceSeriesId }, { 'x-yomu-manifest-repaired': '1' });
  }

  function requestTarget(input) {
    try {
      const raw = typeof input === 'string' || input instanceof URL
        ? input
        : (input && typeof input.url === 'string' ? input.url : '');
      return new URL(String(raw || ''), location.href);
    } catch {
      return null;
    }
  }

  function requestMethod(input, init) {
    return String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
  }

  window.fetch = async (input, init) => {
    const target = requestTarget(input);
    const method = requestMethod(input, init);
    const response = await previousFetch(input, init);
    if (!target || method !== 'GET') return response;

    if (/\/chapters\/[^/]+\/manifest$/.test(target.pathname)) {
      if (!response.ok) queueRecovery(`manifest HTTP ${response.status}`);
      return repairManifest(response, target);
    }

    if (/\/series\/[^/]+$/.test(target.pathname)) {
      if (response.ok) rememberSeriesApiResponse(target, response).catch(() => {});
      else if (response.status >= 500) queueRecovery(`series HTTP ${response.status}`);
    }

    if (target.origin !== location.origin) return response;

    if (target.pathname === '/api/catalog/search' && response.ok) {
      const query = String(target.searchParams.get('q') || '').trim();
      if (!query) return response;
      const sources = enabledApiSources();
      if (!sources.length) return response;
      const batches = await pool(sources, SEARCH_CONCURRENCY, (source) => sourceSearch(source, query));
      const payload = await response.clone().json().catch(() => null);
      const merged = mergeSearchPayload(payload, batches, query);
      return merged ? jsonResponse(response, merged, {
        'x-yomu-all-sources-searched': sources.length,
        'x-yomu-all-sources-responded': merged.allEnabledSourcesResponded || 0,
      }) : response;
    }

    if (target.pathname === '/api/catalog/chapters') {
      const details = await resolveLocalLedgerSources(target);
      if (!details.length) return response;
      const payload = response.ok
        ? await response.clone().json().catch(() => null)
        : { sources: [], rows: [], gaps: [], partial: false };
      const title = String(target.searchParams.get('title') || payload?.title || '').trim();
      const merged = mergeLedgerPayload(payload, details, title);
      if (!merged || (!response.ok && !merged.deviceSourcesMerged)) return response;
      const headers = new Headers(response.headers);
      headers.delete('content-length'); headers.delete('content-encoding');
      headers.set('content-type', 'application/json; charset=utf-8');
      headers.set('cache-control', 'no-store, max-age=0');
      headers.set('x-yomu-device-ledger-sources', String(merged.deviceSourcesMerged || 0));
      return new Response(JSON.stringify(merged), { status: 200, headers });
    }

    return response;
  };

  function currentRoute() {
    const params = new URLSearchParams(location.search);
    const sourceId = params.get('source') || '';
    if (location.pathname.startsWith('/series/')) {
      let seriesId = location.pathname.slice('/series/'.length);
      try { seriesId = decodeURIComponent(seriesId); } catch {}
      return sourceId && seriesId ? { kind: 'series', sourceId, providerId: toProviderId(sourceId), seriesId } : null;
    }
    if (location.pathname.startsWith('/read/')) {
      let chapterId = location.pathname.slice('/read/'.length);
      try { chapterId = decodeURIComponent(chapterId); } catch {}
      return sourceId && chapterId ? { kind: 'reader', sourceId, providerId: toProviderId(sourceId), chapterId } : null;
    }
    return null;
  }

  function pageTitle() {
    const values = [
      document.querySelector('[data-series-title]')?.textContent,
      document.querySelector('.series-title')?.textContent,
      document.querySelector('.series-hero-copy h1')?.textContent,
      document.querySelector('.rd-head__copy h1')?.textContent,
      document.querySelector('h1')?.textContent,
      document.title,
    ];
    return values.map((value) => String(value || '').trim())
      .find((value) => value && !/^loading/i.test(value) && !/^http\s+\d/i.test(value)) || '';
  }

  function storedSeriesTitle(ctx) {
    if (!ctx) return '';
    if (ctx.kind === 'series') {
      const row = readJSON(TITLE_MAP_KEY, {})?.[`${ctx.sourceId}:${ctx.seriesId}`];
      return String(row?.title || '');
    }
    const read = readJSON(READ_MAP_KEY, {})?.[`${ctx.sourceId}:${ctx.chapterId}`];
    return String(read?.title || '');
  }

  function currentChapterNumber(ctx) {
    const text = String(document.querySelector('.rd-head__copy p')?.textContent || '');
    const hit = text.match(/(?:chapter|ch\.?|episode|ep\.?)\s*([0-9]+(?:\.[0-9]+)?)/i)
      || text.match(/\b([0-9]+(?:\.[0-9]+)?)\b/);
    if (hit) return Number(hit[1]);
    const read = ctx?.kind === 'reader' ? readJSON(READ_MAP_KEY, {})?.[`${ctx.sourceId}:${ctx.chapterId}`] : null;
    const n = Number(read?.number);
    return Number.isFinite(n) ? n : null;
  }

  function pageLooksBroken() {
    const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 12000);
    return /HTTP\s+[45]\d\d\s+for\s+series\//i.test(text)
      || /manifest\s+we\s+cannot\s+use/i.test(text)
      || /missing\s+sourceSeriesId/i.test(text)
      || /source\s+(?:is\s+)?(?:unavailable|failed|offline)/i.test(text)
      || /returned\s+no\s+readable\s+pages/i.test(text);
  }

  let recoveryTimer = null;
  let recoveryRunning = false;
  let recoveryReason = '';
  function queueRecovery(reason = 'source failure') {
    recoveryReason = reason;
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => recoverFromFailure().catch(() => {}), 120);
  }

  function guardSignature(ctx) {
    return ctx ? `${ctx.kind}:${ctx.sourceId}:${ctx.seriesId || ctx.chapterId || ''}` : '';
  }
  function recentlyTried(signature) {
    try {
      const guard = JSON.parse(sessionStorage.getItem(RECOVERY_GUARD_KEY) || 'null');
      return guard?.signature === signature && Date.now() - Number(guard?.at || 0) < 20000;
    } catch { return false; }
  }
  function setGuard(signature) {
    try { sessionStorage.setItem(RECOVERY_GUARD_KEY, JSON.stringify({ signature, at: Date.now() })); } catch {}
  }

  function recoveryOverlay(text) {
    let node = document.getElementById('yomu-source-recovery');
    if (!node) {
      node = document.createElement('div');
      node.id = 'yomu-source-recovery';
      Object.assign(node.style, {
        position: 'fixed', inset: '0', zIndex: '2147483646', display: 'grid', placeItems: 'center',
        padding: '24px', background: '#070b10', color: '#f4f6f8',
        font: '700 15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', textAlign: 'center',
      });
      document.body.append(node);
    }
    node.innerHTML = `<div style="max-width:420px"><div style="font-size:24px;margin-bottom:10px">↻</div><div>${String(text || 'Finding another source…').replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</div></div>`;
    return node;
  }

  async function fetchLedgerForRecovery(title, ctx) {
    const params = new URLSearchParams();
    const read = ctx?.kind === 'reader' ? readJSON(READ_MAP_KEY, {})?.[`${ctx.sourceId}:${ctx.chapterId}`] : null;
    if (Array.isArray(read?.links) && read.links.length) {
      for (const link of read.links) params.append('link', String(link));
    } else if (title) {
      params.set('title', title);
    } else {
      return null;
    }
    params.set('prefer', ctx.providerId);
    const response = await window.fetch(`/api/catalog/chapters?${params.toString()}`, {
      cache: 'no-store', signal: AbortSignal.timeout(32000),
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return body && Array.isArray(body.sources) && Array.isArray(body.rows) ? body : null;
  }

  async function verifyRelease(release) {
    if (!release?.providerId || !release?.chapterId) return null;
    const appSource = toAppSource(release.providerId);
    const source = collectionSources().find((item) => String(item?.id || '') === appSource);
    let url = '';
    if (String(release.providerId).startsWith('ext:')) {
      url = `/api/ext/source/${encodeURIComponent(String(release.providerId).slice(4))}/chapters/${encodeURIComponent(release.chapterId)}/manifest`;
    } else if (String(release.providerId).startsWith('suwayomi:')) {
      url = `/api/suwayomi/source/${encodeURIComponent(String(release.providerId).slice(9))}/chapters/${encodeURIComponent(release.chapterId)}/manifest`;
    } else if (source && (source.kind === 'api' || source.url || source.api)) {
      const api = canonicalApi(source.url || source.api);
      if (api) url = new URL(`chapters/${encodeURIComponent(release.chapterId)}/manifest`, api).toString();
    }
    if (!url) {
      return String(release.providerId) === 'mangadex' || release.kind === 'native'
        ? { release, ready: true }
        : null;
    }
    try {
      const response = await window.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(14000) });
      const body = response.ok ? await response.json().catch(() => null) : null;
      return { release, ready: !!(response.ok && Array.isArray(body?.pages) && body.pages.length), pageCount: body?.pages?.length || 0 };
    } catch {
      return { release, ready: false };
    }
  }

  async function recoverFromFailure() {
    if (recoveryRunning) return;
    const ctx = currentRoute();
    if (!ctx) return;
    if (!pageLooksBroken() && !recoveryReason) return;
    const signature = guardSignature(ctx);
    if (recentlyTried(signature)) return;
    setGuard(signature);
    recoveryRunning = true;
    const overlay = recoveryOverlay('That source failed. Searching the rest of your sources…');
    try {
      const title = pageTitle() || storedSeriesTitle(ctx);
      const ledger = await fetchLedgerForRecovery(title, ctx);
      if (!ledger) {
        overlay.querySelector('div > div:last-child').textContent = 'That source is down and no alternate title match answered yet.';
        setTimeout(() => overlay.remove(), 2600);
        return;
      }

      if (ctx.kind === 'series') {
        const candidates = ledger.sources
          .filter((source) => source && source.ok !== false)
          .filter((source) => String(source.providerId || '') !== ctx.providerId)
          .filter((source) => String(source.seriesId || '') && Number(source.chapterCount || 0) > 0)
          .sort((a, b) => Number(b.chapterCount || 0) - Number(a.chapterCount || 0));
        const best = candidates[0];
        if (best) {
          overlay.querySelector('div > div:last-child').textContent = `Switching to ${best.providerName || 'a working source'}…`;
          const target = new URL(`/series/${encodeURIComponent(best.seriesId)}`, location.origin);
          target.searchParams.set('source', toAppSource(best.providerId));
          setTimeout(() => location.replace(target.toString()), 180);
          return;
        }
      } else {
        const number = currentChapterNumber(ctx);
        let row = Number.isFinite(number) ? ledger.rows.find((item) => Number(item.number) === Number(number)) : null;
        if (!row) row = ledger.rows.find((item) => (item.releases || []).some((release) => String(release.chapterId) === ctx.chapterId));
        const candidates = (row?.releases || []).filter((release) => String(release.providerId || '') !== ctx.providerId);
        const checked = await pool(candidates.slice(0, 12), VERIFY_CONCURRENCY, verifyRelease);
        const best = checked.find((item) => item?.ready)?.release;
        if (best) {
          overlay.querySelector('div > div:last-child').textContent = `Opening this chapter from ${best.providerName || 'another source'}…`;
          const target = new URL(`/read/${encodeURIComponent(best.chapterId)}`, location.origin);
          target.searchParams.set('source', toAppSource(best.providerId));
          setTimeout(() => location.replace(target.toString()), 180);
          return;
        }
      }

      overlay.querySelector('div > div:last-child').textContent = 'No other enabled source returned a readable copy right now.';
      setTimeout(() => overlay.remove(), 3000);
    } finally {
      recoveryRunning = false;
      recoveryReason = '';
    }
  }

  const observer = new MutationObserver(() => {
    if (pageLooksBroken()) queueRecovery('visible source failure');
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  addEventListener('popstate', () => { recoveryReason = ''; setTimeout(() => pageLooksBroken() && queueRecovery('route failure'), 250); });
  addEventListener('hashchange', () => { recoveryReason = ''; setTimeout(() => pageLooksBroken() && queueRecovery('route failure'), 250); });
  setTimeout(() => { if (pageLooksBroken()) queueRecovery('initial source failure'); }, 450);
})();
