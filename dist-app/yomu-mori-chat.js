/**
 * Mori Chat — free/local library concierge.
 *
 * No paid model and no fabricated catalogue. Intent handling is deterministic;
 * recommendations come from the reader's own on-device history, YomuRank /
 * AniList's public community signals, and titles the enabled Yomu sources can
 * actually resolve. The transcript is bounded and stays in localStorage.
 */
(() => {
  'use strict';
  if (typeof document === 'undefined') return;

  const ID = 'yomu-mori-chat';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const HISTORY_KEY = 'yomu.v2.mori.chat';
  const RESUME_PREFIX = 'yomu.v1.resume.local-account.';
  const HISTORY_MAX = 20;
  let panel = null;
  let log = null;
  let input = null;
  let send = null;
  let busy = false;
  let lastIntent = { kind: 'recommend', type: 'all' };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const readJSON = (key, fallback) => {
    try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value ?? fallback; }
    catch { return fallback; }
  };

  function library() {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    return Array.isArray(collection.library) ? collection.library.filter((row) => row && !row.hidden) : [];
  }

  function readCounts() {
    const out = [];
    try {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(RESUME_PREFIX) || !key.endsWith('.read')) continue;
        const value = readJSON(key, []);
        if (Array.isArray(value) && value.length) {
          out.push({ id: key.slice(RESUME_PREFIX.length, -'.read'.length), chapters: value.length });
        }
      }
    } catch {}
    return out.sort((a, b) => b.chapters - a.chapters);
  }

  function nameForId(id) {
    const row = library().find((item) => String(item.id || item.seriesId || '') === String(id));
    return row?.title || '';
  }

  function seedTitle() {
    for (const row of readCounts()) {
      const name = nameForId(row.id);
      if (name) return name;
    }
    return library()[0]?.title || '';
  }

  function remember(role, text) {
    try {
      const history = readJSON(HISTORY_KEY, []);
      history.push({ role, text: String(text).slice(0, 600), at: Date.now() });
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_MAX)));
    } catch {}
  }

  function bubble(role, text, evidence = '') {
    if (!log) return null;
    const row = el('div', `mc-msg mc-msg--${role}`);
    const body = el('div', 'mc-bubble', text);
    if (evidence) body.append(el('div', 'mc-evidence', evidence));
    row.append(body);
    log.append(row);
    log.scrollTop = log.scrollHeight;
    remember(role, text);
    return row;
  }

  function thinking(on) {
    document.getElementById('mori-thinking')?.remove();
    if (!on || !log) return;
    const row = el('div', 'mc-msg mc-msg--mori');
    row.id = 'mori-thinking';
    const body = el('div', 'mc-bubble');
    const dots = el('span', 'mc-thinking');
    dots.innerHTML = '<i></i><i></i><i></i>';
    body.append(dots);
    row.append(body);
    log.append(row);
    log.scrollTop = log.scrollHeight;
  }

  function setBusy(next) {
    busy = !!next;
    if (send) send.disabled = busy;
    thinking(busy);
    if (busy) window.YomuPet?.setState?.('thinking', 15000);
    else window.YomuPet?.release?.();
  }

  function typeFromText(text) {
    if (/\bmanhwa\b/i.test(text)) return 'manhwa';
    if (/\bmanhua\b/i.test(text)) return 'manhua';
    if (/\bmanga\b/i.test(text)) return 'manga';
    return 'all';
  }

  function typeMatches(row, type) {
    if (type === 'all') return true;
    const category = String(row?.category || '').toLowerCase();
    const country = String(row?.country || '').toUpperCase();
    if (category === type) return true;
    return type === 'manga' ? country === 'JP' : type === 'manhwa' ? country === 'KR' : type === 'manhua' ? country === 'CN' : true;
  }

  function openTitle(row) {
    close();
    if (window.YomuOpenTitle?.open) {
      window.YomuOpenTitle.open(row);
      return;
    }
    location.href = '/search?q=' + encodeURIComponent(row.title || '');
  }

  function showPicks(rows, why) {
    const unique = [];
    const seen = new Set();
    for (const row of rows || []) {
      const key = String(row?.title || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(row);
      if (unique.length >= 6) break;
    }
    if (!unique.length) return false;

    const wrap = el('div', 'mc-picks');
    for (const row of unique) {
      const button = el('button', 'mc-pick');
      button.type = 'button';
      if (row.cover) {
        const img = el('img', 'mc-pick__art');
        img.src = row.cover;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        button.append(img);
      } else {
        button.append(el('span', 'mc-pick__art'));
      }
      const copy = el('span', 'mc-pick__text');
      copy.append(el('strong', null, row.title));
      const providers = Array.isArray(row.providers) ? row.providers : [];
      const meta = providers[0]?.name
        || [row.category, row.year, row.status].filter(Boolean).join(' · ')
        || why
        || 'Yomu recommendation';
      copy.append(el('span', null, providers.length > 1 ? `${meta} · +${providers.length - 1} sources` : meta));
      button.append(copy);
      button.addEventListener('click', () => openTitle(row));
      wrap.append(button);
    }
    log.append(wrap);
    log.scrollTop = log.scrollHeight;
    return true;
  }

  async function recommend(type = 'all') {
    lastIntent = { kind: 'recommend', type };
    setBusy(true);
    try {
      const seed = seedTitle();
      let rows = [];
      let reason = '';

      // Strongest free signal: a title this reader actually spent time with.
      if (seed && window.YomuAniList?.similar) {
        try {
          const similar = await window.YomuAniList.similar(seed);
          rows.push(...(similar?.picks || []).filter((row) => typeMatches(row, type)));
          reason = `Based on your reading of ${seed}`;
        } catch {}
      }

      // Then the local taste engine. It uses saved titles, finished chapters,
      // recent interactions and public AniList community data — no API key.
      if (rows.length < 6 && window.YomuRank?.forYou) {
        try {
          const rail = await window.YomuRank.forYou(12);
          rows.push(...(rail?.items || []).filter((row) => typeMatches(row, type)));
          reason ||= rail?.why || 'Based on your on-device reading taste';
        } catch {}
      }

      // Cold-start / type-specific floor: public popularity + trending, then
      // Yomu's enabled-source engine so the answer remains openable.
      if (rows.length < 6 && window.YomuRank?.rails) {
        try {
          const global = await window.YomuRank.rails(['popular', 'trending', 'top'], type, 12);
          rows.push(...(global?.trending || []), ...(global?.popular || []), ...(global?.top || []));
          reason ||= 'Public reader popularity and trending signals';
        } catch {}
      }
      if (rows.length < 6 && window.YomuLibraryEngine) {
        try {
          const segment = await window.YomuLibraryEngine.next({ type, count: 10, mode: 'popular' });
          rows.push(...(segment.items || []));
          reason ||= 'Popular titles from your enabled sources';
        } catch {}
      }

      setBusy(false);
      if (!rows.length) {
        bubble('mori', 'I could not get a clean recommendation set right now. Your sources may still be waking up — try “popular” or “surprise me”.');
        return;
      }
      bubble('mori', type === 'all' ? 'Here’s what I’d put in front of you next.' : `Here are ${type} picks I’d put in front of you next.`, reason);
      showPicks(rows, reason);
    } catch {
      setBusy(false);
      bubble('mori', 'Recommendation lookup failed without inventing anything. Try again in a moment.');
    }
  }

  function showLibrary() {
    lastIntent = { kind: 'library', type: 'all' };
    const shelf = library();
    if (!shelf.length) {
      bubble('mori', 'Your saved library is empty. I can still recommend from your enabled sources — ask “what should I read?”');
      return;
    }
    const counts = new Map(readCounts().map((row) => [String(row.id), row.chapters]));
    const rows = [...shelf].sort((a, b) => {
      const ac = counts.get(String(a.id || a.seriesId || '')) || 0;
      const bc = counts.get(String(b.id || b.seriesId || '')) || 0;
      return bc - ac;
    });
    bubble('mori', `You have ${shelf.length} saved title${shelf.length === 1 ? '' : 's'}. Here are the ones with the strongest reading signal.`);
    showPicks(rows.slice(0, 6), 'Saved in your library');
  }

  function continueReading() {
    lastIntent = { kind: 'continue', type: 'all' };
    const shelf = library();
    const counts = readCounts();
    const rows = counts.map((progress) => {
      const item = shelf.find((row) => String(row.id || row.seriesId || '') === String(progress.id));
      return item ? { ...item, __chapters: progress.chapters } : null;
    }).filter(Boolean);
    if (!rows.length) {
      bubble('mori', 'I don’t have a named in-progress title to resume yet. Open Library and I’ll learn from what you read next.');
      return;
    }
    bubble('mori', 'These are the titles with the most finished chapters on this device.', 'Your progress stays on-device');
    showPicks(rows.slice(0, 6), 'Continue reading');
  }

  async function publicChart(kind, type = 'all') {
    lastIntent = { kind, type };
    setBusy(true);
    try {
      let rows = [];
      if (window.YomuRank?.rails) {
        const data = await window.YomuRank.rails([kind], type, 14);
        rows = data?.[kind] || [];
      }
      if (!rows.length && window.YomuLibraryEngine) {
        const data = await window.YomuLibraryEngine.next({ type, count: 10, mode: kind === 'trending' ? 'latest' : 'popular' });
        rows = data.items || [];
      }
      setBusy(false);
      bubble('mori', kind === 'trending' ? 'These are moving fastest right now.' : 'These are the most-read / popular picks I can verify right now.', 'Public community signal · no paid model');
      if (!showPicks(rows, kind)) bubble('mori', 'Nothing clean came back from the public ranking sources.');
    } catch {
      setBusy(false);
      bubble('mori', 'That ranking source is unavailable right now.');
    }
  }

  async function surprise(type = 'all') {
    lastIntent = { kind: 'surprise', type };
    setBusy(true);
    try {
      const data = await window.YomuLibraryEngine?.next?.({ type, count: 10, mode: 'popular' });
      const rows = data?.items || [];
      setBusy(false);
      if (!rows.length) { bubble('mori', 'Your enabled sources did not return a surprise batch yet.'); return; }
      const pick = rows[Math.floor(Math.random() * rows.length)];
      bubble('mori', `Wild card: ${pick.title}.`, `Picked from ${data.sourceCount || 0} enabled-source pool`);
      showPicks([pick], 'Surprise pick');
    } catch {
      setBusy(false);
      bubble('mori', 'The source pool stalled on that one. Give me another shot.');
    }
  }

  async function searchTitles(query) {
    lastIntent = { kind: 'search', query, type: 'all' };
    if (!query) { bubble('mori', 'Tell me a title after “find”, like “find Nano Machine”.'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/catalog/search?q=' + encodeURIComponent(query));
      const body = response.ok ? await response.json() : null;
      const rows = Array.isArray(body?.series) ? body.series : [];
      setBusy(false);
      bubble('mori', rows.length ? `I found ${rows.length} merged result${rows.length === 1 ? '' : 's'} for “${query}”.` : `I couldn’t verify “${query}” in the enabled catalog.`);
      showPicks(rows.slice(0, 6), 'Search result');
    } catch {
      setBusy(false);
      bubble('mori', 'Search is unavailable right now.');
    }
  }

  function help() {
    bubble('mori', 'Try: “show my library”, “continue reading”, “recommend manhwa”, “popular manga”, “trending”, “surprise me”, or “find <title>”. I only recommend titles backed by your library, public community data, or Yomu sources.');
  }

  async function handle(raw) {
    const text = String(raw || '').trim();
    if (!text || busy) return;
    bubble('user', text);
    const lower = text.toLowerCase();
    const type = typeFromText(text);

    if (/^(more|another|again)\b/.test(lower)) {
      if (lastIntent.kind === 'popular' || lastIntent.kind === 'trending') return publicChart(lastIntent.kind, lastIntent.type);
      if (lastIntent.kind === 'surprise') return surprise(lastIntent.type);
      if (lastIntent.kind === 'search') return searchTitles(lastIntent.query);
      return recommend(lastIntent.type || type);
    }
    if (/\b(help|what can you do|commands?)\b/.test(lower)) return help();
    if (/\b(my library|show.*library|my shelf|saved titles?)\b/.test(lower)) return showLibrary();
    if (/\b(continue|resume|keep reading|where was i)\b/.test(lower)) return continueReading();
    if (/\b(trending|hot right now|moving fastest)\b/.test(lower)) return publicChart('trending', type);
    if (/\b(popular|most read|top reads?)\b/.test(lower)) return publicChart('popular', type);
    if (/\b(surprise|random|wild card)\b/.test(lower)) return surprise(type);
    const find = text.match(/\b(?:find|search(?: for)?|look up)\s+(.+)/i);
    if (find) return searchTitles(find[1].trim());
    if (/\b(recommend|suggest|what should i read|read next|give me.*(?:manga|manhwa|manhua))\b/.test(lower) || type !== 'all') return recommend(type);
    bubble('mori', 'I’m the library/recommendation side of Yomu, not a general chatbot. Ask me for your library, a title search, what to continue, or what to read next.');
  }

  function place() {
    if (!panel) return;
    const root = window.YomuPet?.root?.();
    if (!root) {
      panel.style.right = '12px';
      panel.style.bottom = '84px';
      panel.style.left = 'auto';
      panel.style.top = 'auto';
      return;
    }
    const box = root.getBoundingClientRect();
    const width = Math.min(360, innerWidth - 24);
    const height = Math.min(panel.offsetHeight || 460, innerHeight - 24);
    let left = box.left + box.width / 2 - width / 2;
    left = Math.max(12, Math.min(left, innerWidth - width - 12));
    const above = box.top > Math.min(460, height) + 20;
    panel.style.left = left + 'px';
    panel.style.right = 'auto';
    if (above) {
      panel.style.top = 'auto';
      panel.style.bottom = Math.max(12, innerHeight - box.top + 10) + 'px';
    } else {
      panel.style.bottom = 'auto';
      panel.style.top = Math.max(12, Math.min(box.bottom + 10, innerHeight - height - 12)) + 'px';
    }
  }

  function trapTab(event) {
    if (event.key !== 'Tab' || !panel) return;
    const focusable = [...panel.querySelectorAll('button:not([disabled]),input:not([disabled]),a[href]')]
      .filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function build() {
    const root = el('section');
    root.id = ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'false');
    root.setAttribute('aria-label', 'Mori library chat');

    const head = el('div', 'mc-head');
    head.append(el('span', 'mc-head__dot'));
    const copy = el('div', 'mc-head__copy');
    copy.append(el('strong', null, 'Mori'));
    copy.append(el('span', null, 'Free · your reading + public catalog signals'));
    const x = el('button', 'mc-close', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close Mori chat');
    x.addEventListener('click', close);
    head.append(copy, x);
    root.append(head);

    log = el('div', 'mc-log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    root.append(log);

    const quick = el('div', 'mc-quick');
    for (const [label, command] of [
      ['Library', 'show my library'],
      ['Recommend', 'what should I read'],
      ['Continue', 'continue reading'],
      ['Popular', 'popular'],
      ['Surprise', 'surprise me'],
    ]) {
      const button = el('button', 'mc-chip', label);
      button.type = 'button';
      button.addEventListener('click', () => handle(command));
      quick.append(button);
    }
    root.append(quick);

    const form = el('form', 'mc-form');
    input = el('input', 'mc-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = true;
    input.placeholder = 'Ask Mori what to read…';
    input.setAttribute('aria-label', 'Message Mori');
    send = el('button', 'mc-send', 'Send');
    send.type = 'submit';
    form.append(input, send);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value;
      input.value = '';
      handle(value);
    });
    root.append(form);
    root.addEventListener('keydown', trapTab);
    return root;
  }

  function openChat() {
    window.YomuMori?.close?.();
    if (panel) { close(); return true; }
    panel = build();
    document.body.append(panel);
    place();
    bubble('mori', 'Yo. I handle your library and recommendations now. Ask me what to read, what to continue, or search a title.', 'No paid AI call · recommendations are grounded in your data and public/source catalogs');
    input?.focus();
    return true;
  }

  function close() {
    if (!panel) return;
    setBusy(false);
    panel.remove();
    panel = null;
    log = input = send = null;
  }

  addEventListener('keydown', (event) => { if (event.key === 'Escape' && panel) close(); });
  addEventListener('resize', place);
  addEventListener('yomu:pet-moved', () => { if (panel) requestAnimationFrame(place); });
  addEventListener('yomu:pet-surface', close);
  for (const type of ['popstate', 'hashchange']) addEventListener(type, close);

  const claim = () => openChat();
  const attach = () => {
    if (window.YomuPet?.onTap) window.YomuPet.onTap(claim);
    else setTimeout(attach, 120);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', attach, { once: true });
  else attach();

  window.YomuMoriChat = { open: openChat, close, handle, recommend, library };
})();
