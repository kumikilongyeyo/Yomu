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

  /* --- the fused recommender ------------------------------------------------ *
   *
   * Four free signals, and they used to be a fallback chain: ask AniList's
   * reader recommendations, and only if that came back short ask the taste
   * engine, and only if *that* came back short ask the public charts. Whichever
   * one answered first decided the whole list, so a reader with one finished
   * title got six look-alikes of it and nothing else.
   *
   * They are asked together now and merged by weight. A title that several
   * signals agree on rises; one signal alone is still enough to be suggested,
   * with the reason that put it there. Nothing is invented and nothing is paid
   * for: reader-voted recommendations, this device's own reading history,
   * AniList's public charts, and the reader's own enabled sources.
   *
   * The last signal is also the tie-breaker that matters: a recommendation the
   * enabled sources can actually open beats one the reader would have to go
   * and find, so titles the library engine knows are lifted.
   */
  const SIGNAL_WEIGHT = { similar: 3.2, taste: 2.4, chart: 1.4, sources: 1.1 };

  function fuse(signals) {
    const byTitle = new Map();
    for (const { rows, kind, why } of signals) {
      const seenHere = new Set();
      for (const [index, row] of (rows || []).entries()) {
        const name = String(row?.title || '').trim();
        const key = name.toLowerCase();
        if (!name || seenHere.has(key)) continue;
        seenHere.add(key);
        /* Position matters inside a signal but must not swamp agreement
           between signals: the tenth pick of two lists beats the first of one. */
        const weight = SIGNAL_WEIGHT[kind] * (1 - Math.min(index, 20) / 28);
        const hit = byTitle.get(key);
        if (hit) {
          hit.score += weight;
          hit.reasons.add(why);
          /* Keep the richest copy of the row: one signal has the cover, another
             has the providers that make it openable. */
          hit.row = { ...row, ...hit.row };
          if (row.cover && !hit.row.cover) hit.row.cover = row.cover;
          if (row.providers?.length && !hit.row.providers?.length) hit.row.providers = row.providers;
        } else {
          byTitle.set(key, { row, score: weight, reasons: new Set([why]) });
        }
      }
    }
    return [...byTitle.values()]
      .sort((a, b) => b.score - a.score)
      .map((hit) => ({ ...hit.row, __why: [...hit.reasons].filter(Boolean)[0] || '', __agree: hit.reasons.size }));
  }

  async function recommend(type = 'all') {
    lastIntent = { kind: 'recommend', type };
    setBusy(true);
    try {
      const seed = seedTitle();
      const ask = async (kind, why, run) => {
        try { return { kind, why, rows: (await run()) || [] }; }
        catch { return { kind, why, rows: [] }; }
      };

      const signals = await Promise.all([
        // Reader-voted "if you liked X". The strongest free signal there is.
        ask('similar', seed ? `Because you read ${seed}` : '', async () => {
          if (!seed || !window.YomuAniList?.similar) return [];
          return (await window.YomuAniList.similar(seed))?.picks || [];
        }),
        // This device's own taste profile: saved titles, finished chapters,
        // recent interactions. Never uploaded.
        ask('taste', 'Matches what you have been reading', async () => {
          if (!window.YomuRank?.forYou) return [];
          const rail = await window.YomuRank.forYou(14);
          return rail?.items || [];
        }),
        // Public community charts, so a cold start still has an answer.
        ask('chart', 'Highly read right now', async () => {
          if (!window.YomuRank?.rails) return [];
          const global = await window.YomuRank.rails(['popular', 'trending', 'top'], type, 12);
          return [...(global?.trending || []), ...(global?.popular || []), ...(global?.top || [])];
        }),
        // Titles the reader's own enabled sources are carrying.
        ask('sources', 'Carried by your enabled sources', async () => {
          if (!window.YomuLibraryEngine) return [];
          const segment = await window.YomuLibraryEngine.next({ type, count: 12, mode: 'popular' });
          return segment.items || [];
        }),
      ]);

      const already = new Set([...library().map((row) => String(row.title || '').toLowerCase())]);
      const rows = fuse(signals)
        .filter((row) => typeMatches(row, type))
        .filter((row) => !already.has(String(row.title || '').toLowerCase()));

      setBusy(false);
      if (!rows.length) {
        bubble('mori', 'I could not get a clean recommendation set right now. Your sources may still be waking up — try “popular” or “surprise me”.');
        return;
      }
      const agreed = rows.filter((row) => row.__agree > 1).length;
      const reason = agreed
        ? `${agreed} of these came up in more than one signal · your reading + public data + your sources`
        : rows[0].__why || 'Your reading and public community data';
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

  /* --- what Mori knows about one title -------------------------------------- *
   *
   * Three questions a reader actually asks -- who made this, how many chapters
   * are there, when is the next one -- answered from two free sources that
   * already exist in this app, with the evidence named.
   *
   * AniList knows the staff, the declared chapter total and the publication
   * status. The reader's own enabled sources know what has actually been
   * released and when, which is the only honest basis for "next release":
   * manga has no published schedule, so the answer is the observed cadence of
   * the last releases and it is labelled as an estimate. A field neither
   * source gives is left out rather than guessed.
   */
  const FACTS_QUERY = `
query ($search: String) {
  Media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
    id
    title { english romaji native }
    chapters
    volumes
    status
    averageScore
    genres
    startDate { year }
    coverImage { large }
    description(asHtml: false)
    staff(perPage: 6, sort: RELEVANCE) { edges { role node { name { full } } } }
  }
}`;

  const factsCache = new Map();

  async function anilistFacts(title) {
    const key = String(title || '').trim().toLowerCase();
    if (!key) return null;
    if (factsCache.has(key)) return factsCache.get(key);
    const task = (async () => {
      try {
        const response = await fetch('https://graphql.anilist.co', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ query: FACTS_QUERY, variables: { search: title } }),
          signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(7000) : undefined,
        });
        if (!response.ok) return null;
        const body = await response.json();
        return body?.data?.Media || null;
      } catch { return null; }
    })();
    factsCache.set(key, task);
    return task;
  }

  /** What the reader's own sources have actually published. */
  async function releaseLedger(title) {
    try {
      const url = new URL('/api/catalog/chapters', location.origin);
      url.searchParams.set('title', title);
      const response = await fetch(url.toString(), {
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(9000) : undefined,
      });
      if (!response.ok) return null;
      const body = await response.json();
      return Array.isArray(body?.rows) ? body : null;
    } catch { return null; }
  }

  const DAY = 86400000;
  const when = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const ago = (ms) => {
    const days = Math.round((Date.now() - ms) / DAY);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 31) return `${days} days ago`;
    const months = Math.round(days / 30);
    return months < 24 ? `${months} month${months === 1 ? '' : 's'} ago` : `${Math.round(days / 365)} years ago`;
  };

  /**
   * The observed release cadence, as a median gap.
   *
   * Median rather than mean because one six-month hiatus in an otherwise
   * weekly series would otherwise say "the next chapter is due in July".
   */
  function cadence(rows) {
    const dates = rows.map((row) => Number(row.publishedAt)).filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => b - a).slice(0, 12);
    if (dates.length < 3) return null;
    const gaps = [];
    for (let i = 1; i < dates.length; i += 1) gaps.push(dates[i - 1] - dates[i]);
    gaps.sort((a, b) => a - b);
    const middle = gaps.length >> 1;
    const median = gaps.length % 2 ? gaps[middle] : Math.round((gaps[middle - 1] + gaps[middle]) / 2);
    return { latest: dates[0], median, samples: dates.length };
  }

  const staffOf = (media, roles) => (media?.staff?.edges || [])
    .filter((edge) => roles.test(String(edge?.role || '')))
    .map((edge) => edge?.node?.name?.full)
    .filter(Boolean);

  async function titleFacts(rawTitle, question) {
    const title = String(rawTitle || '').trim();
    lastIntent = { kind: 'facts', query: title, type: 'all', question };
    if (!title) {
      bubble('mori', 'Name the title and I will look it up — “who wrote Vinland Saga”, “how many chapters in Berserk”, “when is the next chapter of One Piece”.');
      return;
    }
    setBusy(true);
    const [media, ledger] = await Promise.all([anilistFacts(title), releaseLedger(title)]);
    setBusy(false);

    const name = media?.title?.english || media?.title?.romaji || media?.title?.native || title;
    const rows = ledger?.rows || [];
    const beat = cadence(rows);
    const lines = [];
    const evidence = [];

    if (question === 'author' || question === 'all') {
      const writers = staffOf(media, /story|writer|author|original/i);
      const artists = staffOf(media, /art|illustrat/i);
      if (writers.length || artists.length) {
        const same = writers.length && artists.length && writers[0] === artists[0];
        lines.push(same
          ? `${name} is written and drawn by ${writers[0]}.`
          : [writers.length ? `Story: ${writers.slice(0, 2).join(', ')}` : '', artists.length ? `Art: ${artists.slice(0, 2).join(', ')}` : '']
            .filter(Boolean).join(' · '));
        evidence.push('AniList staff credits');
      } else if (question === 'author') {
        lines.push(`AniList does not list a credited author for ${name}, and I will not guess one.`);
      }
    }

    if (question === 'chapters' || question === 'all') {
      const published = rows.length;
      const declared = Number(media?.chapters) || 0;
      if (published) {
        const highest = rows.map((row) => Number(row.number)).filter(Number.isFinite).sort((a, b) => b - a)[0];
        lines.push(`Your sources carry ${published} chapter${published === 1 ? '' : 's'}${highest ? `, up to chapter ${highest}` : ''}.`);
        evidence.push(`${(ledger.sources || []).filter((s) => s.ok).length} of your sources answered`);
      }
      if (declared) {
        lines.push(`AniList lists ${declared} chapter${declared === 1 ? '' : 's'} in total${media.status === 'RELEASING' ? ' so far' : ''}.`);
        evidence.push('AniList');
      }
      if (!published && !declared && question === 'chapters') {
        lines.push(`Neither your sources nor AniList gave me a chapter count for ${name}.`);
      }
    }

    if (question === 'next' || question === 'all') {
      if (beat) {
        const days = Math.max(1, Math.round(beat.median / DAY));
        const due = beat.latest + beat.median;
        const latestRow = rows.find((row) => Number(row.publishedAt) === beat.latest);
        lines.push(`Latest release: ${latestRow?.label ? `chapter ${latestRow.label}` : 'the newest chapter'}, ${ago(beat.latest)}.`);
        lines.push(due < Date.now()
          ? `Releases have been running about every ${days} day${days === 1 ? '' : 's'}, so the next one is already overdue.`
          : `Releases have been running about every ${days} day${days === 1 ? '' : 's'}, so the next is due around ${when(due)}.`);
        evidence.push(`estimated from the last ${beat.samples} releases · not a publisher schedule`);
      } else if (question === 'next') {
        lines.push(media?.status === 'FINISHED'
          ? `${name} is finished, so there is no next chapter.`
          : `I do not have enough dated releases for ${name} to estimate the next one, and manga has no published schedule to quote.`);
      }
    }

    if (question === 'all' && media?.description) {
      lines.push(String(media.description).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 320));
      evidence.push('AniList synopsis');
    }

    if (!lines.length) {
      bubble('mori', `I could not verify anything about “${title}” from AniList or your enabled sources. Try “find ${title}” to see what carries it.`);
      return;
    }

    bubble('mori', lines.join('\n'), [...new Set(evidence)].join(' · '));
    if (media) {
      showPicks([{
        title: name,
        cover: media.coverImage?.large || '',
        anilistId: media.id,
        score: media.averageScore ?? null,
        genres: media.genres || [],
        year: media.startDate?.year ?? null,
        status: media.status || '',
      }], 'Open this title');
    }
  }

  function customize() {
    const look = window.YomuLook;
    if (!look?.open) {
      bubble('mori', 'The look sheet is not loaded on this page. Open Yomu’s home screen and ask me again.');
      return;
    }
    bubble('mori', 'Opening the look sheet — colours, tags, tile shape and light/dark all live there.');
    close();
    look.open();
  }

  function help() {
    bubble('mori', [
      'Library: “show my library”, “continue reading”.',
      'Picks: “recommend manhwa”, “popular manga”, “trending”, “hidden gems”, “surprise me”.',
      'Titles: “find <title>”, “who wrote <title>”, “how many chapters in <title>”, “when is the next chapter of <title>”, “tell me about <title>”.',
      'Yomu: “customize” opens the look sheet.',
    ].join('\n'), 'Everything is answered from your reading, your enabled sources, or public community data — no paid model');
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
    if (/\b(customi[sz]e|look sheet|change the (?:colours?|colors?|theme|look)|appearance settings)\b/.test(lower)) return customize();
    if (/\b(my library|show.*library|my shelf|saved titles?)\b/.test(lower)) return showLibrary();
    if (/\b(continue|resume|keep reading|where was i)\b/.test(lower)) return continueReading();

    /* Title questions come before the chart intents, because "when is the next
       chapter of Most Read Manhwa" must not be answered with a chart. Each
       pattern names the title in its capture group; nothing is answered about
       a title Mori was not given. */
    const facts = [
      [/\bwho\s+(?:wrote|writes|drew|draws|made|makes|is\s+the\s+(?:author|artist|writer|mangaka)\s+(?:of|for))\s+(.+)/i, 'author'],
      [/\b(?:author|artist|mangaka|writer)\s+(?:of|for)\s+(.+)/i, 'author'],
      [/\bhow\s+many\s+chapters?\s+(?:are\s+there\s+)?(?:does\s+|in\s+|of\s+|for\s+|has\s+)?(.+?)\s*(?:have)?\??$/i, 'chapters'],
      [/\bchapter\s+count\s+(?:of|for)\s+(.+)/i, 'chapters'],
      [/\bwhen\s+(?:is|does|will)\s+(?:the\s+)?next\s+(?:chapter|release|update|episode)\s*(?:of|for|come\s+out\s+for)?\s*(.+?)\s*\??$/i, 'next'],
      [/\bnext\s+(?:chapter|release|update)\s+(?:of|for)\s+(.+)/i, 'next'],
      [/\b(?:tell me about|what\s+is|what's)\s+(.+?)\s*(?:about)?\s*\??$/i, 'all'],
    ];
    for (const [pattern, question] of facts) {
      const hit = text.match(pattern);
      if (hit?.[1]) {
        const name = hit[1].replace(/[?!.]+$/, '').trim();
        if (name && !/^(this|it|that|yomu)$/i.test(name)) return titleFacts(name, question);
      }
    }

    if (/\b(trending|hot right now|moving fastest)\b/.test(lower)) return publicChart('trending', type);
    if (/\b(popular|most read|top reads?)\b/.test(lower)) return publicChart('popular', type);
    if (/\b(hidden gems?|underrated|overlooked)\b/.test(lower)) return publicChart('gems', type);
    if (/\b(surprise|random|wild card)\b/.test(lower)) return surprise(type);
    const find = text.match(/\b(?:find|search(?: for)?|look up)\s+(.+)/i);
    if (find) return searchTitles(find[1].trim());
    if (/\b(recommend|suggest|what should i read|read next|give me.*(?:manga|manhwa|manhua))\b/.test(lower) || type !== 'all') return recommend(type);
    bubble('mori', 'I handle your library, your sources and the titles in them. Ask me what to read, what to continue, who wrote something, how many chapters it has, when the next one is due — or say “customize” to open the look sheet. “help” lists the lot.');
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
    /* The look sheet, one press away. It is the one thing in this panel that
       is not a question, so it goes at the end and says so. */
    const look = el('button', 'mc-chip mc-chip--action', 'Customize Yomu');
    look.type = 'button';
    look.setAttribute('aria-label', 'Open the Yomu look sheet');
    look.addEventListener('click', customize);
    quick.append(look);
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
    bubble('mori', 'Yo. I handle your library, your sources and the titles in them. Ask what to read, who wrote something, how many chapters it has, or when the next one is due.', 'No paid AI call · answers come from your reading, your enabled sources and public community data');
    /* Focus the field on a pointer device only. On a touch screen it opens the
       keyboard and -- with any field under 16px -- zooms the page in, for a
       tap whose whole intent was "show me the panel". The field is one tap
       away and the panel itself takes focus so Escape and Tab still work. */
    if (matchMedia('(pointer: fine)').matches) input?.focus();
    else {
      panel.tabIndex = -1;
      panel.focus({ preventScroll: true });
    }
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
