/** Yomu merged-source loading + catalog UX. */
(() => {
  'use strict';
  if (window.__YomuSourceUX2) return;
  window.__YomuSourceUX2 = true;

  const KEY = 'yomu.v1.collection';
  const prev = window.fetch.bind(window);
  const memo = new Map();
  const norm = (v) => String(v || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|of|and|manga|manhwa|manhua|webtoon|comic|official|colou?red?|color|season|part|vol(?:ume)?|novel|remake|fan\s?colou?red)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const providerId = (id) => String(id || '').startsWith('yomuext-') ? `ext:${String(id).slice(8)}`
    : String(id || '').startsWith('mihon-') ? `suwayomi:${String(id).slice(6)}` : String(id || '');

  function sources() {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(KEY) || '{}').sources || []; } catch {}
    const seen = new Set(), out = [];
    for (const s of rows) {
      if (!s || s.enabled === false || !s.id || s.id === 'mangadex') continue;
      let api;
      try {
        const u = new URL(String(s.url || s.api || ''), location.origin);
        if (!/^https?:$/.test(u.protocol)) continue;
        u.hash = ''; u.search = '';
        api = u.toString().replace(/\/?$/, '/');
      } catch { continue; }
      const apiLike = s.kind === 'api' || /^yomuext-|^mihon-/.test(String(s.id))
        || /fabric/i.test(String(s.runtime || s.category || '')) || /\/api\//i.test(new URL(api).pathname);
      if (!apiLike || seen.has(api)) continue;
      seen.add(api);
      out.push({ id: String(s.id), providerId: providerId(s.id), label: String(s.label || s.name || s.id), api });
    }
    return out;
  }

  function score(item, query) {
    const q = norm(query); if (!q) return 0;
    const names = [item?.title, ...(Array.isArray(item?.altTitles) ? item.altTitles : [])].map(norm).filter(Boolean);
    if (names.includes(q)) return 1;
    if (names.some((n) => n.includes(q) || q.includes(n))) return .9;
    const qw = new Set(q.split(' '));
    return Math.max(0, ...names.map((n) => {
      const nw = new Set(n.split(' '));
      return [...qw].filter((w) => nw.has(w)).length / Math.max(qw.size, nw.size, 1);
    }));
  }

  function same(a, b, query = '') {
    const A = [a?.title, ...(a?.altTitles || [])].map(norm).filter(Boolean);
    const B = [b?.title, ...(b?.altTitles || [])].map(norm).filter(Boolean);
    if (A.some((x) => B.includes(x))) return true;
    if (A.some((x) => B.some((y) => x.length > 4 && y.length > 4 && (x.includes(y) || y.includes(x))))) return true;
    return !!query && score(a, query) >= .93 && score(b, query) >= .93;
  }

  async function pool(items, n, fn, progress) {
    const out = new Array(items.length); let i = 0, done = 0;
    async function run() {
      for (;;) {
        const k = i++; if (k >= items.length) return;
        try { out[k] = await fn(items[k], k); }
        catch (e) { out[k] = { source: items[k], ok: false, series: [], error: String(e?.message || e) }; }
        done++; progress?.(done, items.length, out[k]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(n, Math.max(1, items.length)) }, run));
    return out;
  }

  async function getSeries(source, kind, query) {
    const paths = query ? ['search'] : kind === 'latest' ? ['latest', 'series'] : ['series', 'popular'];
    let last = { source, ok: false, series: [] };
    for (const path of paths) {
      try {
        const u = new URL(path, source.api); u.searchParams.set('page', '1'); if (query) u.searchParams.set('q', query);
        const r = await prev(u.toString(), { cache: 'no-store', signal: AbortSignal.timeout(query ? 9000 : 7500) });
        const j = r.ok ? await r.json().catch(() => null) : null;
        last = { source, ok: r.ok && Array.isArray(j?.series), series: Array.isArray(j?.series) ? j.series : [], status: r.status };
        if (last.ok && (query || last.series.length)) break;
      } catch (e) { last = { source, ok: false, series: [], error: String(e?.message || e) }; }
    }
    return last;
  }

  function add(rows, item, source, query = '') {
    if (!item?.id || !item?.title) return;
    const p = { id: source.providerId, name: source.label, kind: 'extension', seriesId: String(item.id) };
    let row = rows.find((x) => same(x, item, query));
    if (!row) { rows.push({ ...item, providers: [p] }); return; }
    const ps = Array.isArray(row.providers) ? row.providers : [];
    if (!ps.some((x) => String(x?.id) === p.id && String(x?.seriesId) === p.seriesId)) row.providers = [...ps, p];
    row.cover ||= item.cover; row.author ||= item.author; row.synopsis ||= item.synopsis;
    row.category ||= item.category; row.status ||= item.status; row.year ||= item.year;
    if (!row.altTitles?.length && Array.isArray(item.altTitles)) row.altTitles = item.altTitles;
  }

  function balance(rows, preferred) {
    const buckets = new Map();
    const put = (k, r) => { if (!buckets.has(k)) buckets.set(k, []); if (!buckets.get(k).includes(r)) buckets.get(k).push(r); };
    for (const r of rows) {
      const ps = r.providers || []; if (!ps.length) put('catalog', r);
      for (const p of ps) put(String(p?.id || 'catalog'), r);
    }
    const keys = [...preferred.filter((k) => buckets.has(k)), ...[...buckets.keys()].filter((k) => !preferred.includes(k))];
    const cursor = new Map(keys.map((k) => [k, 0])), used = new Set(), out = [];
    let moved = true;
    while (moved && out.length < 100) {
      moved = false;
      for (const k of keys) {
        const b = buckets.get(k) || []; let x = cursor.get(k) || 0;
        while (x < b.length && used.has(b[x])) x++;
        cursor.set(k, x + 1); if (x >= b.length) continue;
        used.add(b[x]); out.push(b[x]); moved = true; if (out.length >= 100) break;
      }
    }
    for (const r of rows) if (!used.has(r) && out.length < 100) out.push(r);
    return out;
  }

  function json(r, body, headers = {}) {
    const h = new Headers(r.headers); h.delete('content-length'); h.delete('content-encoding');
    h.set('content-type', 'application/json; charset=utf-8'); h.set('cache-control', 'no-store, max-age=0');
    Object.entries(headers).forEach(([k, v]) => h.set(k, String(v)));
    return new Response(JSON.stringify(body), { status: r.status, statusText: r.statusText, headers: h });
  }

  function style() {
    if (document.getElementById('yomu-load-css')) return;
    const s = document.createElement('style'); s.id = 'yomu-load-css'; s.textContent = `
#yomu-load{position:fixed;inset:0;z-index:2147483600;display:grid;place-items:center;background:color-mix(in srgb,var(--bg,#070b10) 94%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);opacity:0;pointer-events:none;transition:opacity .15s;color:var(--text,#f5f7fa)}#yomu-load.on{opacity:1;pointer-events:auto}.yl-card{width:min(84vw,360px);display:grid;justify-items:center;gap:10px;text-align:center}.yl-book{position:relative;width:70px;height:52px;perspective:300px}.yl-book i,.yl-book b,.yl-book em{position:absolute;top:7px;width:30px;height:39px;background:var(--accent,#ffc45f);border-radius:5px 5px 9px 9px}.yl-book i{left:3px;transform:skewY(7deg)}.yl-book b{right:3px;transform:skewY(-7deg)}.yl-book em{right:4px;transform-origin:left center;animation:yf 1.05s cubic-bezier(.55,.08,.25,.95) infinite;backface-visibility:hidden}@keyframes yf{0%,16%{transform:rotateY(0) skewY(-7deg)}70%,100%{transform:rotateY(-180deg) skewY(-7deg)}}.yl-brand{font:900 25px/1 Archivo,-apple-system,sans-serif}.yl-title{font:800 14px/1.25 Archivo,-apple-system,sans-serif}.yl-detail{min-height:17px;color:var(--muted,#91a8bb);font:650 11px/1.35 Archivo,-apple-system,sans-serif}.yl-track{width:min(72vw,290px);height:5px;border-radius:9px;overflow:hidden;background:var(--line,#263747)}.yl-bar{height:100%;width:5%;border-radius:inherit;background:var(--accent,#ffc45f);transition:width .2s}.yl-count{font:800 10px/1 Archivo,-apple-system,sans-serif;color:var(--dim,#7890a4)}#yomu-source-status{margin:9px 0 2px;padding:8px 10px;border:1px solid var(--line,#263747);border-radius:11px;background:color-mix(in srgb,var(--surface,#111b25) 72%,transparent);color:var(--muted,#91a8bb);font:700 10.5px/1.3 Archivo,-apple-system,sans-serif}#yomu-source-status b{color:var(--text,#f5f7fa)}#yomu-source-status .good{color:#91e4ad}#yomu-reader-progress{position:fixed;left:50%;bottom:calc(102px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:2147483500;padding:8px 11px;border-radius:999px;border:1px solid var(--line,#263747);background:color-mix(in srgb,var(--bg,#070b10) 92%,transparent);color:var(--text,#f5f7fa);font:750 10.5px/1 Archivo,-apple-system,sans-serif;white-space:nowrap;pointer-events:none}@media(prefers-reduced-motion:reduce){.yl-book em{animation:none}}`;
    document.head.append(s);
  }

  let token = 0, pct = 0, tick, delay;
  function node() {
    let n = document.getElementById('yomu-load'); if (n) return n;
    n = document.createElement('div'); n.id = 'yomu-load'; n.innerHTML = '<div class="yl-card"><div class="yl-book"><i></i><b></b><em></em></div><div class="yl-brand">Yomu</div><div class="yl-title">Loading…</div><div class="yl-detail"></div><div class="yl-track"><div class="yl-bar"></div></div><div class="yl-count"></div></div>';
    document.body.append(n); return n;
  }
  function paint(p, title, detail, count) {
    const n = node(); pct = Math.max(pct, Math.min(100, Number(p) || 0)); n.querySelector('.yl-bar').style.width = pct + '%';
    if (title != null) n.querySelector('.yl-title').textContent = title; if (detail != null) n.querySelector('.yl-detail').textContent = detail; if (count != null) n.querySelector('.yl-count').textContent = count;
  }
  function start(title, detail, count, ceiling = 74, ms = 150) {
    const t = ++token; pct = 7; clearTimeout(delay); clearInterval(tick); paint(7, title, detail, count);
    delay = setTimeout(() => t === token && node().classList.add('on'), ms);
    tick = setInterval(() => { if (t === token && pct < ceiling) paint(pct + Math.max(.8, (ceiling - pct) * .065)); }, 420); return t;
  }
  function done(t, title, detail, count, linger = 170) {
    if (t !== token) return; clearTimeout(delay); clearInterval(tick); paint(100, title, detail, count); node().classList.add('on');
    setTimeout(() => t === token && node().classList.remove('on'), linger);
  }
  function trouble(t, title, detail) { if (t !== token) return; clearInterval(tick); paint(Math.max(pct, 90), title, detail, ''); node().classList.add('on'); setTimeout(() => t === token && node().classList.remove('on'), 2200); }

  function searchStatus(query, payload, total) {
    const top = [...(payload?.series || [])].sort((a, b) => score(b, query) - score(a, query))[0];
    const versions = top && score(top, query) >= .62 ? new Set((top.providers || []).map((p) => p?.id).filter(Boolean)).size : 0;
    return { versions, total, answered: Number(payload?.allEnabledSourcesResponded || payload?.deviceSourcesResponded || 0) };
  }
  function statusUI(q, m) {
    const mount = () => {
      const f = document.querySelector('main form,.g-main form,form'); if (!f?.parentElement) return false;
      let n = document.getElementById('yomu-source-status'); if (!n) { n = document.createElement('div'); n.id = 'yomu-source-status'; f.after(n); }
      n.innerHTML = `<b>${String(q).replace(/[&<>]/g, '')}</b> · <span class="good">${m.versions} source version${m.versions === 1 ? '' : 's'}</span> · ${m.answered}/${m.total} enabled sources answered`; return true;
    }; if (!mount()) setTimeout(mount, 250);
  }

  let expected = 0, loaded = 0, failed = 0;
  function readerPaint() {
    if (!expected || !location.pathname.startsWith('/read/')) return;
    let n = document.getElementById('yomu-reader-progress'); if (!n) { n = document.createElement('div'); n.id = 'yomu-reader-progress'; document.body.append(n); }
    const x = Math.min(expected, loaded + failed), p = Math.round(x / expected * 100);
    n.textContent = failed ? `Pages ${loaded}/${expected} · ${failed} retrying · ${p}%` : `Loading pages ${loaded}/${expected} · ${p}%`;
    if (x >= expected && !failed) setTimeout(() => n.remove(), 450);
  }
  function observeImages() {
    const states = new WeakMap();
    const scan = () => {
      if (!location.pathname.startsWith('/read/')) return;
      for (const img of document.querySelectorAll('img')) {
        const src = String(img.getAttribute('src') || img.currentSrc || '');
        if (!src || !/\/api\/|chapter|reader|page/i.test(src) || /brand|avatar|icon|badge|pet|logo/i.test(src) || states.has(img)) continue;
        const st = { loaded: false, failed: false }; states.set(img, st);
        const ok = () => { if (st.loaded) return; st.loaded = true; if (st.failed) { failed = Math.max(0, failed - 1); st.failed = false; } loaded++; readerPaint(); };
        const bad = () => { if (st.loaded || st.failed) return; st.failed = true; failed++; readerPaint(); };
        if (img.complete && img.naturalWidth > 0) ok(); else { img.addEventListener('load', ok, { once: true }); img.addEventListener('error', bad, { once: true }); }
      }
    };
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] }); scan();
  }

  const targetOf = (i) => { try { return new URL(typeof i === 'string' || i instanceof URL ? i : i?.url || '', location.href); } catch { return null; } };
  const methodOf = (i, init) => String(init?.method || (i instanceof Request ? i.method : 'GET') || 'GET').toUpperCase();

  window.fetch = async (input, init) => {
    const u = targetOf(input); if (!u || methodOf(input, init) !== 'GET') return prev(input, init);
    const local = u.origin === location.origin;

    if (local && u.pathname === '/api/catalog/search' && u.searchParams.get('q')?.trim()) {
      const q = u.searchParams.get('q').trim(), ss = sources();
      const t = start('Searching Yomu…', `Checking ${ss.length || 'your'} enabled sources`, ss.length ? `0 / ${ss.length} sources` : 'Merged search', 55, 100);
      const r = await prev(input, init); if (!r.ok) { trouble(t, 'Search source failed', `HTTP ${r.status} · checking recovery`); return r; }
      let body = await r.clone().json().catch(() => null); if (!Array.isArray(body?.series)) { done(t, 'Search ready', '', ''); return r; }
      paint(58, 'Matching source versions…', 'Grouping the same title across every provider', ss.length ? `${ss.length} enabled sources` : 'Merged source pool');
      const represented = new Set(body.series.filter((x) => score(x, q) >= .62).flatMap((x) => (x.providers || []).map((p) => String(p?.id || ''))));
      const top = [...body.series].sort((a, b) => score(b, q) - score(a, q))[0];
      const aliases = [top?.title, ...(top?.altTitles || [])].map(String).filter((x) => x && norm(x) !== norm(q)).slice(0, 2);
      const missing = ss.filter((s) => !represented.has(s.providerId));
      if (missing.length) {
        const batches = await pool(missing, 10, async (s) => {
          let best = await getSeries(s, 'search', q);
          if (!best.series.some((x) => score(x, q) >= .58)) for (const a of aliases) { const hit = await getSeries(s, 'search', a); if (hit.ok) best = hit; if (hit.series.some((x) => score(x, q) >= .58)) break; }
          return best;
        }, (d, n) => paint(58 + Math.round(d / Math.max(1, n) * 34), 'Matching source versions…', aliases.length ? 'Retrying alternate title spellings where needed' : 'Checking missing matches', `${d} / ${n} remaining sources checked`));
        const rows = body.series.map((x) => ({ ...x, providers: [...(x.providers || [])] }));
        for (const b of batches) if (b?.source) for (const item of b.series || []) if (score(item, q) >= .48) add(rows, item, b.source, q);
        body = { ...body, series: rows.sort((a, b) => score(b, q) - score(a, q) || (b.providers?.length || 0) - (a.providers?.length || 0)), allEnabledSourcesSearched: Math.max(Number(body.allEnabledSourcesSearched || 0), ss.length), aliasSourcesRetried: missing.length };
      }
      const m = searchStatus(q, body, ss.length); statusUI(q, m); done(t, 'Search ready', `${m.versions} source version${m.versions === 1 ? '' : 's'} found`, `${m.answered} / ${m.total} enabled sources answered`, 200);
      return json(r, body, { 'x-yomu-source-ux': '2', 'x-yomu-source-versions': m.versions });
    }

    if (local && (u.pathname === '/api/catalog/popular' || u.pathname === '/api/catalog/latest')) {
      const kind = u.pathname.endsWith('/latest') ? 'latest' : 'popular', ss = sources(); if (!ss.length) return prev(input, init);
      const t = start(kind === 'latest' ? 'Loading latest titles…' : 'Building your catalog…', `Mixing titles from ${ss.length} enabled sources`, `0 / ${ss.length} sources`, 38, 250);
      const baseP = prev(input, init), listP = pool(ss, 12, async (s) => {
        const k = `${kind}:${s.api}`, c = memo.get(k); if (c && c.at > Date.now() - 120000) return c.value;
        const v = await getSeries(s, kind); memo.set(k, { at: Date.now(), value: v }); return v;
      }, (d, n, x) => paint(30 + Math.round(d / Math.max(1, n) * 62), kind === 'latest' ? 'Loading latest titles…' : 'Building your catalog…', `${x?.source?.label || 'Source'} checked`, `${d} / ${n} sources`));
      const [r, batches] = await Promise.all([baseP, listP]); if (!r.ok) { trouble(t, 'Catalog source failed', `HTTP ${r.status}`); return r; }
      const body = await r.clone().json().catch(() => null); if (!Array.isArray(body?.series)) { done(t, 'Catalog ready', '', ''); return r; }
      const rows = body.series.map((x) => ({ ...x, providers: [...(x.providers || [])] })); let answered = 0;
      for (const b of batches) { if (b?.ok) answered++; if (b?.source) for (const item of b.series || []) add(rows, item, b.source); }
      const merged = { ...body, series: balance(rows, ss.map((s) => s.providerId)), sourceBalanced: true, deviceSourcesAttempted: ss.length, deviceSourcesResponded: answered, mergedSourceCount: new Set(rows.flatMap((x) => (x.providers || []).map((p) => p?.id).filter(Boolean))).size };
      done(t, 'Catalog ready', `${merged.mergedSourceCount} sources represented`, `${answered} / ${ss.length} added sources answered`, 150);
      return json(r, merged, { 'x-yomu-source-balanced': '1' });
    }

    if (/\/chapters\/[^/]+\/manifest$/.test(u.pathname) && location.pathname.startsWith('/read/')) {
      expected = loaded = failed = 0; const t = start('Opening chapter…', 'Getting the page manifest from this source', 'Reader check', 70, 210);
      const r = await prev(input, init); if (!r.ok) { trouble(t, 'This source did not answer', `HTTP ${r.status} · Yomu is checking alternatives`); return r; }
      const b = await r.clone().json().catch(() => null), pages = Array.isArray(b?.pages) ? b.pages.length : 0;
      if (!pages) { trouble(t, 'No reader pages returned', 'Yomu is checking another source'); return r; }
      expected = pages; paint(88, 'Pages found', `${pages} pages · starting images`, 'Reader ready'); done(t, 'Chapter ready', `${pages} pages found`, 'Loading images below', 210); setTimeout(readerPaint, 80); return r;
    }

    if (local && u.pathname === '/api/catalog/chapters' && (location.pathname.startsWith('/series/') || location.pathname.startsWith('/read/'))) {
      const t = start('Checking chapters…', 'Comparing your enabled sources', 'Merged chapter list', 84, 300), r = await prev(input, init);
      if (r.ok) { const b = await r.clone().json().catch(() => null), n = Array.isArray(b?.sources) ? b.sources.filter((x) => x?.ok !== false).length : 0; done(t, 'Chapters ready', n ? `${n} sources matched this title` : 'Chapter list loaded', '', 130); }
      else trouble(t, 'Chapter source failed', `HTTP ${r.status} · checking another source`); return r;
    }

    return prev(input, init);
  };

  style(); observeImages();
})();
