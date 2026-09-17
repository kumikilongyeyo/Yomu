(() => {
  'use strict';

  const COLLECTION_KEY = 'yomu.v1.collection';
  const LINKS_KEY = 'yomu.v1.ledgerLinks';
  const GUARD_KEY = 'yomu.v1.autoSourceSwitch';
  const GUARD_MS = 15_000;
  const UI_ID = 'yomu-source-picker';
  const READER_BUTTON_ID = 'yomu-reader-source';
  const VERIFY_CONCURRENCY = 3;
  const VERIFY_LIMIT = 8;

  let running = false;
  let timer = null;
  let ledgerPromise = null;
  let discoveryPromise = null;

  const isSeries = () => location.pathname.startsWith('/series/');
  const isReader = () => location.pathname.startsWith('/read/');

  const readJSON = (key, fallback) => {
    try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value ?? fallback; }
    catch { return fallback; }
  };
  const writeJSON = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

  const toProviderId = (sourceId) => {
    if (sourceId.startsWith('yomuext-')) return 'ext:' + sourceId.slice(8);
    if (sourceId.startsWith('mihon-')) return 'suwayomi:' + sourceId.slice(6);
    return sourceId;
  };
  const toAppSource = (providerId) => {
    if (providerId.startsWith('ext:')) return 'yomuext-' + providerId.slice(4);
    if (providerId.startsWith('suwayomi:')) return 'mihon-' + providerId.slice(9);
    return providerId;
  };

  function routeContext() {
    const onReader = isReader();
    const onSeries = isSeries();
    if (!onReader && !onSeries) return null;
    const prefix = onReader ? '/read/' : '/series/';
    const raw = location.pathname.slice(prefix.length);
    if (!raw) return null;
    let id = raw;
    try { id = decodeURIComponent(raw); } catch {}
    const sourceId = new URLSearchParams(location.search).get('source') || '';
    if (!sourceId) return null;
    const seriesId = onReader ? id.split(':')[0] : id;
    return { sourceId, seriesId, chapterId: onReader ? id : '', key: sourceId + ':' + seriesId };
  }

  function collectionSources() {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    return Array.isArray(collection.sources) ? collection.sources : [];
  }

  function enabledSourceIds() {
    return new Set(collectionSources()
      .filter((source) => source && source.enabled !== false)
      .map((source) => String(source.id || '')).filter(Boolean));
  }

  function savedSourceIds() {
    return new Set(collectionSources().map((source) => String(source?.id || '')).filter(Boolean));
  }

  function sourceEntry(appSourceId) {
    return collectionSources().find((source) => String(source?.id || '') === appSourceId) || null;
  }

  function sourceLabel(appSourceId) {
    const source = sourceEntry(appSourceId);
    return String(source?.label || source?.name || appSourceId || 'Current source');
  }

  function ensureSourceEnabled(appSourceId) {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    if (!Array.isArray(collection.sources)) return false;
    let changed = false;
    const sources = collection.sources.map((source) => {
      if (String(source?.id || '') !== appSourceId || source.enabled !== false) return source;
      changed = true;
      return { ...source, enabled: true };
    });
    if (!changed) return !!collection.sources.find((source) => String(source?.id || '') === appSourceId);
    writeJSON(COLLECTION_KEY, {
      ...collection,
      revision: (Number.isInteger(collection.revision) ? collection.revision : 0) + 1,
      sources,
    });
    return true;
  }

  function pageTitle() {
    const selectors = isReader()
      ? ['.rd-head__copy h1', '[data-series-title]', 'h1']
      : ['[data-series-title]', '.series-title', '.series-hero-copy h1', 'h1'];
    for (const selector of selectors) {
      const value = String(document.querySelector(selector)?.textContent || '').trim();
      if (value && !/^loading/i.test(value)) return value;
    }
    return '';
  }

  function currentChapterNumber() {
    if (!isReader()) return null;
    const text = String(document.querySelector('.rd-head__copy p')?.textContent || '');
    const match = text.match(/(?:chapter|ch\.?|episode|ep\.?)\s*([0-9]+(?:\.[0-9]+)?)/i)
      || text.match(/([0-9]+(?:\.[0-9]+)?)/);
    return match ? Number(match[1]) : null;
  }

  function pageSaysActiveSourceIsEmpty() {
    if (!isSeries()) return false;
    const list = document.querySelector('.chapter-list');
    if (!list || list.querySelector('.chapter-line[data-chn]')) return false;
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
    return /hosts no chapters for it/i.test(text) || /(?:^|[·\s])0\s+chapters(?:[·\s]|$)/i.test(text);
  }

  function recentlyRedirectedTo(signature) {
    try {
      const value = JSON.parse(sessionStorage.getItem(GUARD_KEY) || 'null');
      return value && value.signature === signature && Date.now() - Number(value.at || 0) < GUARD_MS;
    } catch { return false; }
  }
  function setRedirectGuard(signature) {
    try { sessionStorage.setItem(GUARD_KEY, JSON.stringify({ signature, at: Date.now() })); } catch {}
  }

  function showSwitchNotice(name) {
    document.getElementById('yomu-auto-source-note')?.remove();
    const note = document.createElement('div');
    note.id = 'yomu-auto-source-note';
    note.textContent = `No chapters here. Switching to ${name}…`;
    Object.assign(note.style, {
      position: 'fixed', left: '50%', bottom: 'calc(94px + env(safe-area-inset-bottom, 0px))', transform: 'translateX(-50%)', zIndex: '9999',
      maxWidth: 'min(88vw, 520px)', padding: '10px 14px', borderRadius: '999px', border: '1px solid rgba(255,196,95,.45)',
      background: 'rgba(20,33,43,.96)', color: '#f4f6fa', font: '600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      boxShadow: '0 10px 34px rgba(0,0,0,.3)', textAlign: 'center',
    });
    document.body.append(note);
  }

  function ledgerParams(ctx, discover = false) {
    const params = new URLSearchParams();
    const saved = !discover ? readJSON(LINKS_KEY, {})?.[ctx.key] : null;
    if (Array.isArray(saved) && saved.length) {
      for (const link of saved) params.append('link', String(link));
    } else {
      const title = pageTitle();
      if (!title) return null;
      params.set('title', title);
    }
    params.set('prefer', toProviderId(ctx.sourceId));
    return params;
  }

  function rememberLedgerLinks(data) {
    if (!data || !Array.isArray(data.sources)) return;
    const links = data.sources
      .filter((source) => source?.providerId && source?.seriesId)
      .map((source) => `${source.providerId}:${source.seriesId}`);
    if (!links.length) return;
    const all = readJSON(LINKS_KEY, {}) || {};
    for (const source of data.sources) {
      if (!source?.providerId || !source?.seriesId) continue;
      all[toAppSource(String(source.providerId)) + ':' + String(source.seriesId)] = links;
    }
    writeJSON(LINKS_KEY, all);
  }

  async function getLedger(force = false, discover = false) {
    const slot = discover ? 'discovery' : 'normal';
    const existing = discover ? discoveryPromise : ledgerPromise;
    if (existing && !force) return existing;
    const request = (async () => {
      const ctx = routeContext();
      if (!ctx) return null;
      const params = ledgerParams(ctx, discover);
      if (!params) return null;
      const response = await fetch('/api/catalog/chapters?' + params.toString(), {
        cache: 'no-store', signal: AbortSignal.timeout(discover ? 30_000 : 20_000),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !Array.isArray(data.rows) || !Array.isArray(data.sources)) return null;
      rememberLedgerLinks(data);
      return data;
    })().catch(() => null);
    if (slot === 'discovery') discoveryPromise = request;
    else ledgerPromise = request;
    return request;
  }

  const kindRank = (kind) => ({ extension: 0, native: 1, suwayomi: 2 }[kind] ?? 3);

  async function tryAutoSwitch() {
    if (running || !pageSaysActiveSourceIsEmpty()) return;
    const ctx = routeContext();
    if (!ctx || recentlyRedirectedTo(ctx.key)) return;
    const enabled = enabledSourceIds();
    if (!enabled.size) return;
    running = true;
    try {
      const data = await getLedger();
      if (!data) return;
      const activeProvider = toProviderId(ctx.sourceId);
      const candidates = data.sources
        .filter((source) => source && source.ok !== false)
        .filter((source) => source.providerId !== activeProvider)
        .filter((source) => enabled.has(toAppSource(String(source.providerId || ''))))
        .filter((source) => String(source.seriesId || '') && Number(source.chapterCount || 0) > 0)
        .sort((a, b) => Number(b.chapterCount || 0) - Number(a.chapterCount || 0) || kindRank(a.kind) - kindRank(b.kind) || String(a.providerName || '').localeCompare(String(b.providerName || '')));
      const best = candidates[0];
      if (!best) return;
      const sourceId = toAppSource(String(best.providerId)), seriesId = String(best.seriesId), signature = sourceId + ':' + seriesId;
      if (signature === ctx.key) return;
      setRedirectGuard(signature); showSwitchNotice(best.providerName || 'a source with chapters');
      const target = new URL('/series/' + encodeURIComponent(seriesId), location.origin); target.searchParams.set('source', sourceId);
      setTimeout(() => location.replace(target.toString()), 350);
    } finally { running = false; }
  }

  function releaseIsSaved(release, saved) {
    return release && saved.has(toAppSource(String(release.providerId || '')));
  }

  function releaseIsEnabled(release, enabled) {
    return release && enabled.has(toAppSource(String(release.providerId || '')));
  }

  function goToRelease(release) {
    if (!release?.chapterId || !release?.providerId) return;
    const appSourceId = toAppSource(String(release.providerId));
    ensureSourceEnabled(appSourceId);
    const target = new URL('/read/' + encodeURIComponent(String(release.chapterId)), location.origin);
    target.searchParams.set('source', appSourceId);
    location.assign(target.toString());
  }

  function currentRow(data) {
    if (!data || !Array.isArray(data.rows)) return null;
    const ctx = routeContext();
    if (!ctx) return null;
    const activeProvider = toProviderId(ctx.sourceId);
    let row = data.rows.find((candidate) => candidate.releases?.some((release) =>
      String(release.providerId) === activeProvider && String(release.chapterId) === String(ctx.chapterId)));
    const number = currentChapterNumber();
    if (!row && Number.isFinite(number)) row = data.rows.find((candidate) => Number(candidate.number) === Number(number));
    return row || null;
  }

  function manifestUrl(release) {
    if (!release?.providerId || !release?.chapterId) return null;
    const providerId = String(release.providerId);
    const chapterId = encodeURIComponent(String(release.chapterId));
    if (providerId.startsWith('ext:')) {
      return `/api/ext/source/${encodeURIComponent(providerId.slice(4))}/chapters/${chapterId}/manifest`;
    }
    if (providerId.startsWith('suwayomi:')) {
      return `/api/suwayomi/source/${encodeURIComponent(providerId.slice(9))}/chapters/${chapterId}/manifest`;
    }
    const source = sourceEntry(toAppSource(providerId));
    const api = String(source?.url || '').trim();
    if (source?.kind === 'api' && api) {
      return api.replace(/\/?$/, '/') + 'chapters/' + chapterId + '/manifest';
    }
    return null;
  }

  async function verifyRelease(release) {
    const ctx = routeContext();
    const activeProvider = toProviderId(ctx?.sourceId || '');
    if (String(release?.providerId || '') === activeProvider && String(release?.chapterId || '') === String(ctx?.chapterId || '')) {
      return { release, ready: true, pageCount: Number(release?.pageCount || 0), current: true };
    }

    const url = manifestUrl(release);
    if (!url) {
      // MangaDex is the built-in native provider. Its reader path is not a
      // generic /manifest URL, so the chapter ledger itself is the strongest
      // cheap proof available without opening the chapter. Other unknown
      // provider kinds stay conservative and are not offered as repaired hits.
      const trustedNative = String(release?.providerId || '') === 'mangadex' || release?.kind === 'native';
      return { release, ready: trustedNative, pageCount: Number(release?.pageCount || 0), trustedNative };
    }

    try {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
      const body = await response.json().catch(() => null);
      const pages = Array.isArray(body?.pages) ? body.pages : [];
      return { release, ready: response.ok && pages.length > 0, pageCount: pages.length, status: response.status };
    } catch (error) {
      return { release, ready: false, error: String(error?.message || error || 'reader check failed') };
    }
  }

  async function verifyReleases(releases) {
    const queue = releases.slice(0, VERIFY_LIMIT);
    const out = new Array(queue.length);
    let cursor = 0;
    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= queue.length) return;
        out[index] = await verifyRelease(queue[index]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, queue.length) }, () => worker()));
    return out.filter(Boolean);
  }

  function closePicker() { document.getElementById(UI_ID)?.remove(); }

  function createPicker(anchor, row) {
    closePicker();
    const panel = document.createElement('div');
    panel.id = UI_ID;
    Object.assign(panel.style, {
      position: 'fixed', zIndex: '10001', left: '50%', bottom: isReader() ? 'calc(118px + env(safe-area-inset-bottom, 0px))' : '24px', transform: 'translateX(-50%)',
      width: 'min(92vw, 440px)', maxHeight: '62vh', overflow: 'auto', padding: '10px', borderRadius: '18px',
      background: 'rgba(17,27,37,.985)', border: '1px solid rgba(145,168,187,.25)', boxShadow: '0 20px 60px rgba(0,0,0,.45)',
      color: '#f7f8fa', font: '500 13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    });

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 6px 9px;gap:12px;position:sticky;top:0;background:rgba(17,27,37,.985);z-index:1';
    const title = document.createElement('strong');
    const label = row ? (row.label || row.number) : currentChapterNumber();
    title.textContent = label ? `Chapter ${label} · source` : 'Chapter source';
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Close source picker');
    x.style.cssText = 'border:0;background:transparent;color:#f7f8fa;font-size:24px;line-height:1;cursor:pointer';
    x.onclick = closePicker;
    head.append(title, x);

    const body = document.createElement('div'); body.className = 'yomu-source-picker__body';
    panel.append(head, body);
    document.body.append(panel);
    setTimeout(() => document.addEventListener('pointerdown', (event) => {
      if (!panel.contains(event.target) && event.target !== anchor) closePicker();
    }, { once: true }), 0);
    return panel;
  }

  function releaseButton(release, activeProvider, verified) {
    const button = document.createElement('button'); button.type = 'button';
    const appSourceId = toAppSource(String(release.providerId || ''));
    const isActive = String(release.providerId || '') === activeProvider;
    const isEnabled = sourceEntry(appSourceId)?.enabled !== false;
    button.style.cssText = 'width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;padding:11px 12px;margin:0 0 6px;border-radius:12px;border:1px solid rgba(145,168,187,.18);background:rgba(7,17,26,.72);color:#f7f8fa;cursor:pointer';

    const left = document.createElement('span');
    const meta = release.scanlator
      || (verified?.pageCount ? verified.pageCount + ' pages' : release.pageCount ? release.pageCount + ' pages' : release.kind || 'source');
    left.innerHTML = `<b style="display:block">${escapeHtml(release.providerName || sourceLabel(appSourceId) || release.providerId)}</b><small style="color:#91a8bb">${escapeHtml(meta)}</small>`;

    const state = document.createElement('span');
    state.textContent = isActive ? 'Current' : isEnabled ? 'Open →' : 'Enable & open →';
    state.style.cssText = `font-weight:800;color:${isActive ? '#91e4ad' : '#ffc45f'};white-space:nowrap`;
    button.append(left, state);
    if (!isActive) button.onclick = () => goToRelease(release);
    else { button.disabled = true; button.style.cursor = 'default'; }
    return button;
  }

  function currentSourceCard(activeProvider) {
    const ctx = routeContext();
    const appSourceId = ctx?.sourceId || toAppSource(activeProvider || '');
    const card = document.createElement('div');
    card.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 12px;margin:0 0 6px;border-radius:12px;border:1px solid rgba(145,228,173,.24);background:rgba(7,17,26,.72)';
    const left = document.createElement('span');
    left.innerHTML = `<b style="display:block">${escapeHtml(sourceLabel(appSourceId))}</b><small style="color:#91a8bb">Current chapter source</small>`;
    const state = document.createElement('span'); state.textContent = 'Current'; state.style.cssText = 'font-weight:800;color:#91e4ad;white-space:nowrap';
    card.append(left, state);
    return card;
  }

  function finderButton(panel, anchor) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Find another source';
    button.style.cssText = 'width:100%;margin-top:4px;padding:11px 12px;border-radius:12px;border:1px solid rgba(255,196,95,.38);background:rgba(255,196,95,.11);color:#ffc45f;font-weight:850;cursor:pointer';
    button.addEventListener('click', () => discoverAlternatives(panel, anchor, button));
    return button;
  }

  function statusLine(text, tone = 'muted') {
    const line = document.createElement('div');
    const color = tone === 'good' ? '#91e4ad' : tone === 'bad' ? '#ff8a81' : '#91a8bb';
    line.style.cssText = `padding:8px 8px 10px;color:${color};font-size:11.5px`;
    line.textContent = text;
    return line;
  }

  async function renderKnownPicker(panel, anchor, row) {
    if (!panel?.isConnected) return;
    const body = panel.querySelector('.yomu-source-picker__body');
    if (!body) return;
    const ctx = routeContext();
    const activeProvider = toProviderId(ctx?.sourceId || '');
    body.textContent = '';

    const saved = savedSourceIds();
    const known = (row?.releases || []).filter((release) => releaseIsSaved(release, saved));
    const activeRelease = known.find((release) => String(release.providerId) === activeProvider)
      || (row?.releases || []).find((release) => String(release.providerId) === activeProvider);

    if (activeRelease) body.append(releaseButton(activeRelease, activeProvider, { pageCount: activeRelease.pageCount || 0 }));
    else body.append(currentSourceCard(activeProvider));

    const alternates = known.filter((release) => String(release.providerId) !== activeProvider);
    if (alternates.length) {
      body.append(statusLine(`Checking ${alternates.length} known alternative${alternates.length === 1 ? '' : 's'}…`));
      const checked = await verifyReleases(alternates);
      if (!panel.isConnected) return;
      body.querySelectorAll('div').forEach((node) => {
        if (/^Checking /.test(node.textContent || '')) node.remove();
      });
      const ready = checked.filter((item) => item.ready);
      for (const item of ready) body.append(releaseButton(item.release, activeProvider, item));
      if (!ready.length) body.append(statusLine('Known alternatives did not pass the reader check.'));
    } else {
      body.append(statusLine('No other source is known for this exact chapter yet.'));
    }

    body.append(finderButton(panel, anchor));
  }

  async function discoverAlternatives(panel, anchor, button) {
    if (!panel?.isConnected || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Searching all Yomu sources…';
    const body = panel.querySelector('.yomu-source-picker__body');
    const progress = statusLine('Matching the title, exact chapter number, then testing reader pages…');
    body?.append(progress);

    const data = await getLedger(true, true);
    const row = currentRow(data);
    progress.remove();
    if (!panel.isConnected) return;
    if (!data || !row) {
      button.textContent = 'Search again'; button.disabled = false;
      body?.insertBefore(statusLine('No exact chapter match was found on another source.', 'bad'), button);
      return;
    }

    const ctx = routeContext();
    const activeProvider = toProviderId(ctx?.sourceId || '');
    const saved = savedSourceIds();
    const candidates = (row.releases || [])
      .filter((release) => String(release.providerId || '') !== activeProvider)
      .filter((release) => releaseIsSaved(release, saved));

    if (!candidates.length) {
      button.textContent = 'Search again'; button.disabled = false;
      body?.insertBefore(statusLine('The title was found, but none of your saved sources has this exact chapter.', 'bad'), button);
      return;
    }

    button.textContent = `Testing ${Math.min(candidates.length, VERIFY_LIMIT)} reader path${candidates.length === 1 ? '' : 's'}…`;
    const checked = await verifyReleases(candidates);
    if (!panel.isConnected) return;
    const ready = checked.filter((item) => item.ready);

    // Remove old alternate buttons, but keep the current card/button and replace
    // the status with the freshly verified list.
    for (const child of [...(body?.children || [])]) {
      if (child === button) continue;
      if (child.tagName === 'BUTTON' && !/Current/.test(child.textContent || '')) child.remove();
      if (child.tagName === 'DIV' && !/Current chapter source/.test(child.textContent || '')) child.remove();
    }

    if (ready.length) {
      body?.insertBefore(statusLine(`${ready.length} reader-ready source${ready.length === 1 ? '' : 's'} found.`, 'good'), button);
      for (const item of ready) body?.insertBefore(releaseButton(item.release, activeProvider, item), button);
      button.textContent = 'Refresh source search';
    } else {
      body?.insertBefore(statusLine(`Checked ${checked.length} candidate${checked.length === 1 ? '' : 's'}; none returned reader pages.`, 'bad'), button);
      button.textContent = 'Search again';
    }
    button.disabled = false;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  async function openReaderPicker(anchor) {
    const panel = createPicker(anchor, null);
    const body = panel.querySelector('.yomu-source-picker__body');
    body?.append(currentSourceCard(toProviderId(routeContext()?.sourceId || '')));
    body?.append(statusLine('Checking known sources…'));

    const data = await getLedger();
    const row = currentRow(data);
    if (!panel.isConnected) return;
    const label = row ? (row.label || row.number) : currentChapterNumber();
    const heading = panel.querySelector('strong');
    if (heading) heading.textContent = label ? `Chapter ${label} · source` : 'Chapter source';
    await renderKnownPicker(panel, anchor, row);
  }

  function openPicker(row, anchor) {
    const panel = createPicker(anchor, row);
    renderKnownPicker(panel, anchor, row);
  }

  async function decorateSeriesRows() {
    if (!isSeries()) return;
    const data = await getLedger(); if (!data) return;
    const saved = savedSourceIds();
    const rowsByNumber = new Map(data.rows.filter((row) => Number.isFinite(Number(row.number))).map((row) => [Number(row.number), row]));
    for (const line of document.querySelectorAll('.chapter-line[data-chn]')) {
      if (line.querySelector('.yomu-chapter-sources')) continue;
      const raw = line.getAttribute('data-chn') || line.textContent || '';
      const match = String(raw).match(/([0-9]+(?:\.[0-9]+)?)/); if (!match) continue;
      const row = rowsByNumber.get(Number(match[1])); if (!row) continue;
      const releases = row.releases.filter((release) => releaseIsSaved(release, saved)); if (releases.length < 2) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'yomu-chapter-sources'; button.textContent = `${releases.length} sources`;
      button.title = 'Choose a different source for this chapter';
      button.style.cssText = 'margin-left:auto;flex:0 0 auto;border:1px solid rgba(145,168,187,.24);border-radius:999px;padding:5px 8px;background:rgba(17,27,37,.72);color:#ffc45f;font:800 10.5px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer';
      button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openPicker(row, button); });
      line.append(button);
    }
  }

  function decorateReaderSource() {
    const existing = document.getElementById(READER_BUTTON_ID);
    if (!isReader()) { existing?.remove(); closePicker(); return; }
    if (existing) return;
    const dock = document.querySelector('.rd-dock'); if (!dock) return;

    const button = document.createElement('button');
    button.id = READER_BUTTON_ID; button.type = 'button'; button.className = 'rd-tool';
    button.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h14M7 12h10M9 17h6"></path></svg><span>Source</span>';
    button.setAttribute('aria-label', 'Change or find a source for this chapter');
    button.addEventListener('click', (event) => { event.stopPropagation(); openReaderPicker(button); });
    const chaptersTool = [...dock.querySelectorAll('.rd-tool')].find((item) => /chapters/i.test(item.textContent || ''));
    if (chaptersTool) chaptersTool.after(button); else dock.append(button);
  }

  function resetRouteCaches() {
    ledgerPromise = null;
    discoveryPromise = null;
  }

  let lastRoute = location.pathname + location.search;
  async function pass() {
    const route = location.pathname + location.search;
    if (route !== lastRoute) {
      lastRoute = route;
      resetRouteCaches();
      closePicker();
    }
    if (isSeries()) { tryAutoSwitch(); decorateSeriesRows(); }
    if (isReader()) decorateReaderSource();
    else document.getElementById(READER_BUTTON_ID)?.remove();
  }

  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(pass, 180);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  for (const type of ['popstate', 'hashchange']) addEventListener(type, () => { resetRouteCaches(); pass(); });
  setTimeout(pass, 300);
})();
