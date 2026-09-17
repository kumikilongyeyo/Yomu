(() => {
  'use strict';

  const onSeries = location.pathname.startsWith('/series/');
  const onReader = location.pathname.startsWith('/read/');
  if (!onSeries && !onReader) return;

  const COLLECTION_KEY = 'yomu.v1.collection';
  const LINKS_KEY = 'yomu.v1.ledgerLinks';
  const GUARD_KEY = 'yomu.v1.autoSourceSwitch';
  const GUARD_MS = 15_000;
  const UI_ID = 'yomu-source-picker';
  let running = false;
  let timer = null;
  let ledgerPromise = null;

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

  function enabledSourceIds() {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    return new Set((Array.isArray(collection.sources) ? collection.sources : [])
      .filter((source) => source && source.enabled !== false)
      .map((source) => String(source.id || '')).filter(Boolean));
  }

  function pageTitle() {
    const selectors = onReader
      ? ['.rd-head__copy h1', '[data-series-title]', 'h1']
      : ['[data-series-title]', '.series-title', '.series-hero-copy h1', 'h1'];
    for (const selector of selectors) {
      const value = String(document.querySelector(selector)?.textContent || '').trim();
      if (value && !/^loading/i.test(value)) return value;
    }
    return '';
  }

  function currentChapterNumber() {
    if (!onReader) return null;
    const text = String(document.querySelector('.rd-head__copy p')?.textContent || '');
    const match = text.match(/(?:chapter|ch\.?|episode|ep\.?)\s*([0-9]+(?:\.[0-9]+)?)/i)
      || text.match(/([0-9]+(?:\.[0-9]+)?)/);
    return match ? Number(match[1]) : null;
  }

  function pageSaysActiveSourceIsEmpty() {
    if (!onSeries) return false;
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

  function ledgerParams(ctx) {
    const params = new URLSearchParams();
    const saved = readJSON(LINKS_KEY, {})?.[ctx.key];
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

  async function getLedger(force = false) {
    if (ledgerPromise && !force) return ledgerPromise;
    ledgerPromise = (async () => {
      const ctx = routeContext();
      if (!ctx) return null;
      const params = ledgerParams(ctx);
      if (!params) return null;
      const response = await fetch('/api/catalog/chapters?' + params.toString(), { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !Array.isArray(data.rows) || !Array.isArray(data.sources)) return null;
      rememberLedgerLinks(data);
      return data;
    })().catch(() => null);
    return ledgerPromise;
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

  function enabledRelease(release, enabled) {
    return release && enabled.has(toAppSource(String(release.providerId || '')));
  }

  function goToRelease(release) {
    if (!release?.chapterId || !release?.providerId) return;
    const target = new URL('/read/' + encodeURIComponent(String(release.chapterId)), location.origin);
    target.searchParams.set('source', toAppSource(String(release.providerId)));
    location.assign(target.toString());
  }

  function closePicker() { document.getElementById(UI_ID)?.remove(); }

  function openPicker(row, anchor) {
    closePicker();
    const enabled = enabledSourceIds();
    const releases = (row?.releases || []).filter((release) => enabledRelease(release, enabled));
    if (!releases.length) return;
    const active = toProviderId(routeContext()?.sourceId || '');
    const panel = document.createElement('div'); panel.id = UI_ID;
    Object.assign(panel.style, {
      position: 'fixed', zIndex: '10001', left: '50%', bottom: onReader ? 'calc(118px + env(safe-area-inset-bottom, 0px))' : '24px', transform: 'translateX(-50%)',
      width: 'min(92vw, 430px)', maxHeight: '56vh', overflow: 'auto', padding: '10px', borderRadius: '18px',
      background: 'rgba(17,27,37,.98)', border: '1px solid rgba(145,168,187,.25)', boxShadow: '0 20px 60px rgba(0,0,0,.45)',
      color: '#f7f8fa', font: '500 13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    });
    const head = document.createElement('div'); head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 6px 9px;gap:12px';
    const title = document.createElement('strong'); title.textContent = `Chapter ${row.label || row.number} · choose source`;
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Close source picker'); x.style.cssText = 'border:0;background:transparent;color:#f7f8fa;font-size:24px;line-height:1;cursor:pointer'; x.onclick = closePicker;
    head.append(title, x); panel.append(head);
    for (const release of releases) {
      const button = document.createElement('button'); button.type = 'button';
      const isActive = String(release.providerId) === active;
      button.style.cssText = 'width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;padding:11px 12px;margin:0 0 6px;border-radius:12px;border:1px solid rgba(145,168,187,.18);background:rgba(7,17,26,.72);color:#f7f8fa;cursor:pointer';
      const left = document.createElement('span'); left.innerHTML = `<b style="display:block">${escapeHtml(release.providerName || release.providerId)}</b><small style="color:#91a8bb">${escapeHtml(release.scanlator || (release.pageCount ? release.pageCount + ' pages' : release.kind || 'source'))}</small>`;
      const state = document.createElement('span'); state.textContent = isActive ? 'Current' : 'Open →'; state.style.cssText = `font-weight:800;color:${isActive ? '#91e4ad' : '#ffc45f'};white-space:nowrap`;
      button.append(left, state); if (!isActive) button.onclick = () => goToRelease(release); else button.disabled = true;
      panel.append(button);
    }
    document.body.append(panel);
    setTimeout(() => document.addEventListener('pointerdown', (event) => { if (!panel.contains(event.target) && event.target !== anchor) closePicker(); }, { once: true }), 0);
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  async function decorateSeriesRows() {
    if (!onSeries) return;
    const data = await getLedger(); if (!data) return;
    const enabled = enabledSourceIds();
    const rowsByNumber = new Map(data.rows.filter((row) => Number.isFinite(Number(row.number))).map((row) => [Number(row.number), row]));
    for (const line of document.querySelectorAll('.chapter-line[data-chn]')) {
      if (line.querySelector('.yomu-chapter-sources')) continue;
      const raw = line.getAttribute('data-chn') || line.textContent || '';
      const match = String(raw).match(/([0-9]+(?:\.[0-9]+)?)/); if (!match) continue;
      const row = rowsByNumber.get(Number(match[1])); if (!row) continue;
      const releases = row.releases.filter((release) => enabledRelease(release, enabled)); if (releases.length < 2) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'yomu-chapter-sources'; button.textContent = `${releases.length} sources`;
      button.title = 'Choose a different source for this chapter';
      button.style.cssText = 'margin-left:auto;flex:0 0 auto;border:1px solid rgba(145,168,187,.24);border-radius:999px;padding:5px 8px;background:rgba(17,27,37,.72);color:#ffc45f;font:800 10.5px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer';
      button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openPicker(row, button); });
      line.append(button);
    }
  }

  async function decorateReaderSource() {
    if (!onReader || document.getElementById('yomu-reader-source')) return;
    const dock = document.querySelector('.rd-dock'); if (!dock) return;
    const data = await getLedger(); if (!data) return;
    const ctx = routeContext(), enabled = enabledSourceIds(), activeProvider = toProviderId(ctx?.sourceId || '');
    const number = currentChapterNumber();
    let row = data.rows.find((candidate) => candidate.releases?.some((release) => String(release.providerId) === activeProvider && String(release.chapterId) === String(ctx?.chapterId)));
    if (!row && Number.isFinite(number)) row = data.rows.find((candidate) => Number(candidate.number) === Number(number));
    if (!row) return;
    const releases = row.releases.filter((release) => enabledRelease(release, enabled));
    if (releases.length < 2) return;

    const button = document.createElement('button'); button.id = 'yomu-reader-source'; button.type = 'button'; button.className = 'rd-tool';
    button.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h14M7 12h10M9 17h6"></path></svg><span>Source</span>';
    button.setAttribute('aria-label', `Change source for chapter ${row.label || row.number}. ${releases.length} sources available.`);
    button.addEventListener('click', (event) => { event.stopPropagation(); openPicker(row, button); });
    const chaptersTool = [...dock.querySelectorAll('.rd-tool')].find((item) => /chapters/i.test(item.textContent || ''));
    if (chaptersTool) chaptersTool.after(button); else dock.append(button);
  }

  async function pass() {
    if (onSeries) { tryAutoSwitch(); decorateSeriesRows(); }
    if (onReader) decorateReaderSource();
  }

  const observer = new MutationObserver(() => { if (timer) clearTimeout(timer); timer = setTimeout(pass, 180); });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setTimeout(pass, 300);
})();