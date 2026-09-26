/**
 * The Ledger — one row per chapter, every source that has it on the row.
 *
 * The failure this removes is ordinary and happens constantly: you are on
 * chapter 58, and your source is down, or dropped the series at 57, or the
 * chapter is a machine translation nobody can read. Today that costs five
 * screens -- out of the series, search again, pick a source, find the title,
 * find the chapter. With the ledger, chapter 58's row already says MangaDex
 * and Flame Comics have it. One tap.
 *
 * It is drawn over the app's own chapter list rather than replacing it. Each
 * row keeps its number, its name and its read state; what is added is the row
 * of source chips, and the gap rows for chapters the active source does not
 * have at all. The merge happens in the Worker (/api/catalog/chapters); this
 * file is the part you can see.
 *
 * Two rules are worth stating because they are what make the chips
 * trustworthy rather than decorative:
 *
 *   TAP READS ONCE. A chip opens that chapter from that source, now, and
 *   changes nothing. It is the recovery action, and it must not have a
 *   lasting consequence you did not ask for.
 *
 *   HOLD SETS THE DEFAULT. Holding a chip writes chapterSources -- the
 *   per-chapter override the app has been keeping all along and never showed
 *   anyone. The ledger is that record, drawn.
 *
 * And the one that is really a promise: a chapter you have not reached is
 * never marked differently from one you have. That is the circle's rule, not
 * this one, but both draw on the same list and it would be easy to leak here.
 * This file shows sources, never anything anyone said.
 */
(() => {
  'use strict';

  const LINKS_KEY = 'yomu.v1.ledgerLinks';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const BAR_ID = 'yomu-ledger-bar';
  const COMPLETE_ID = 'yomu-complete';
  const HOLD_MS = 550;

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  /* --- the two id spaces ------------------------------------------------ *
   *
   * The Worker names providers one way and the app names its sources another,
   * and the reader only understands the app's. Getting this wrong makes every
   * chip open a 404, so it is a single pair of functions rather than a
   * conversion scattered about.
   */
  const toAppSource = (providerId) => {
    if (providerId.startsWith('ext:')) return 'yomuext-' + providerId.slice(4);
    if (providerId.startsWith('suwayomi:')) return 'mihon-' + providerId.slice(9);
    return providerId;
  };
  const toProviderId = (sourceId) => {
    if (sourceId.startsWith('yomuext-')) return 'ext:' + sourceId.slice(8);
    if (sourceId.startsWith('mihon-')) return 'suwayomi:' + sourceId.slice(6);
    return sourceId;
  };

  const collection = () => readJSON(COLLECTION_KEY, null) || {};
  const enabledSourceIds = () =>
    new Set((collection().sources || []).filter((s) => s && s.enabled).map((s) => String(s.id)));

  function seriesContext() {
    if (!location.pathname.startsWith('/series/')) return null;
    const raw = location.pathname.slice('/series/'.length);
    if (!raw) return null;
    let seriesId = raw;
    try { seriesId = decodeURIComponent(raw); } catch {}
    const sourceId = new URLSearchParams(location.search).get('source') || '';
    return sourceId ? { sourceId, seriesId, key: sourceId + ':' + seriesId } : null;
  }

  /* --- chip labels ------------------------------------------------------ *
   *
   * Two or three uppercase letters: initials of the first two words, else the
   * first two letters. Computed once for the whole ledger and reused down the
   * list, so a source is the same two letters on every row -- which is the
   * only thing that makes them readable at 9px.
   */
  function labelsFor(sources) {
    const out = new Map();
    const taken = new Set();
    for (const source of sources) {
      const words = String(source.providerName || source.providerId).trim().split(/\s+/);
      let label = words.length > 1
        ? (words[0][0] + words[1][0])
        : String(source.providerName || '??').slice(0, 2);
      label = label.toUpperCase();
      if (taken.has(label)) {
        const longer = String(source.providerName || '???').replace(/\s+/g, '').slice(0, 3).toUpperCase();
        label = taken.has(longer) ? (label + (taken.size % 10)) : longer;
      }
      taken.add(label);
      out.set(source.providerId, label);
    }
    return out;
  }

  /* --- fetching --------------------------------------------------------- */

  let ledgerFor = '';
  let ledger = null;
  let labels = new Map();
  let loading = false;

  const linkStore = () => readJSON(LINKS_KEY, {}) || {};

  async function loadLedger(context, title) {
    if (loading) return;
    loading = true;
    try {
      const known = linkStore()[context.key];
      const params = new URLSearchParams();

      if (Array.isArray(known) && known.length) {
        // The fast, stable path: identity is already settled, so the Worker
        // matches nothing and simply asks the providers we named.
        for (const link of known) params.append('link', link);
      } else if (title) {
        params.set('title', title);
      } else {
        ledger = null;
        return;
      }
      // Ordering and gaps are both relative to the source you are reading
      // from, so the Worker has to be told which that is -- and told on the
      // first request, which is the only one that matters. Reading it back out
      // of the previous response meant it was never sent on a cold open, so
      // the Worker fell back to the highest-ranked provider and computed gaps
      // against a source the reader was not using.
      const mine = [...enabledSourceIds()];
      params.set('prefer', toProviderId(context.sourceId));

      const response = await fetch('/api/catalog/chapters?' + params.toString());
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !Array.isArray(data.rows)) { ledger = null; return; }

      // Only sources this device actually has enabled. The Worker answers for
      // everything it can reach, which is right for a merge and wrong for a
      // chip: a chip for a source you cannot open is a dead end.
      const usable = new Set(mine);
      // Everyone the Worker found, before the filter: that is what identity
      // is, and it is what the link store must remember (below).
      const carriers = data.sources.filter((s) => s && s.ok !== false && s.seriesId);
      // Carriers this device could turn on in one tap: an extension or the
      // built-in MangaDex with chapters, and not already on. Kept so an empty
      // list can say where the chapters are instead of saying nothing.
      data.offDevice = carriers.filter((s) => s.chapterCount > 0
        && !usable.has(toAppSource(s.providerId))
        && (s.providerId.startsWith('ext:') || s.providerId === 'mangadex'))
        .sort((a, b) => b.chapterCount - a.chapterCount);
      data.sources = data.sources.filter((s) => usable.has(toAppSource(s.providerId)));
      const keep = new Set(data.sources.map((s) => s.providerId));
      for (const row of data.rows) row.releases = row.releases.filter((r) => keep.has(r.providerId));
      data.rows = data.rows.filter((row) => row.releases.length);
      data.gaps = (data.gaps || []).filter((g) => g.availableFrom.some((p) => keep.has(p)));

      // Recomputed after that filter, not taken from the response. The Worker
      // sets partial across everything it tried, which includes sources this
      // device has not enabled -- so a circle of four healthy sources reported
      // "4 of 4 answered", which reads as a warning about nothing.
      data.partial = data.sources.some((s) => !s.ok);

      ledger = data;
      labels = labelsFor(data.sources);

      // Remember who carries this title, so the next open skips matching.
      // All of them, not just the ones enabled today: the fast path asks only
      // the providers named here, so storing the filtered set meant a source
      // turned on later was never asked about this title again.
      if (!known || !known.length) {
        const store = linkStore();
        store[context.key] = carriers.map((s) => `${s.providerId}:${s.seriesId}`);
        writeJSON(LINKS_KEY, store);
      }
    } catch {
      ledger = null;
    } finally {
      loading = false;
      paint();
    }
  }

  /* --- acting on a chip -------------------------------------------------- */

  function openFrom(release) {
    const source = toAppSource(release.providerId);
    location.assign('/read/' + encodeURIComponent(release.chapterId)
      + '?source=' + encodeURIComponent(source));
  }

  /**
   * Hold to make this source the default for this chapter.
   *
   * Written in the app's own shape, under its own key. chapterSources is
   * keyed by String(chapter.number) and read by the series screen as
   * entry?.chapterSources?.[String(n)] -- so this is not new storage, it is
   * the record the app has been keeping invisibly, finally being written by
   * something a person can see.
   */
  function setChapterSource(context, number, release) {
    const data = collection();
    const library = Array.isArray(data.library) ? data.library : [];
    const entry = library.find((t) => String(t.id) === context.seriesId);
    if (!entry) return false;   // not saved: nothing to hang an override on

    const sources = { ...(entry.chapterSources || {}) };
    if (release) {
      sources[String(number)] = {
        sourceId: toAppSource(release.providerId),
        chapterId: release.chapterId,
        label: release.providerName,
      };
    } else {
      delete sources[String(number)];
    }

    writeJSON(COLLECTION_KEY, {
      ...data,
      revision: Number(data.revision || 0) + 1,
      library: library.map((t) =>
        String(t.id) === context.seriesId ? { ...t, chapterSources: sources } : t),
    });
    return true;
  }

  const overrideFor = (context, number) => {
    const entry = (collection().library || []).find((t) => String(t.id) === context.seriesId);
    return entry?.chapterSources?.[String(number)];
  };

  /* --- drawing ----------------------------------------------------------- */

  function chipFor(context, row, release, state) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'release-chip' + (state ? ' ' + state : '');
    chip.textContent = labels.get(release.providerId) || '??';
    chip.title = release.providerName
      + (release.scanlator ? ' · ' + release.scanlator : '')
      + (state === 'is-absent' ? ' — does not have this chapter' : '');

    if (state === 'is-absent') {
      chip.disabled = true;
      chip.setAttribute('aria-hidden', 'true');
      return chip;
    }

    chip.setAttribute('aria-label',
      `Read chapter ${row.label} from ${release.providerName}. Hold to make it the default.`);

    let timer = null;
    let held = false;
    const start = () => {
      held = false;
      timer = setTimeout(() => {
        held = true;
        timer = null;
        if (setChapterSource(context, row.number, release)) {
          chip.classList.add('is-active');
          flash(`Chapter ${row.label} will open from ${release.providerName}.`);
        } else {
          flash('Save this title to your library first, then a source can be pinned to a chapter.');
        }
      }, HOLD_MS);
    };
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };

    chip.addEventListener('pointerdown', (event) => { event.stopPropagation(); start(); });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
      chip.addEventListener(type, stop);
    }
    chip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // A hold has already done its work; the click that ends it must not
      // then also navigate.
      if (held) { held = false; return; }
      openFrom(release);
    });
    return chip;
  }

  function flash(message) {
    const existing = document.getElementById('yomu-ledger-note');
    existing?.remove();
    const note = document.createElement('p');
    note.id = 'yomu-ledger-note';
    note.className = 'yomu-imm-note yomu-imm-note--wide';
    note.textContent = message;
    document.body.append(note);
    setTimeout(() => note.remove(), 3200);
  }

  /** Chips for one row: one per source, preferred first, capped. */
  function releasesRow(context, row, active, nearGap) {
    const box = document.createElement('div');
    box.className = 'chapter-releases';

    // One chip per provider. A provider can carry two releases of the same
    // chapter -- an official and a fan translation, say -- and two identical
    // chips side by side says nothing. The first is the one the merge ranked
    // highest; the rest stay reachable by opening it.
    const seen = new Set();
    const unique = [];
    for (const release of row.releases) {
      if (seen.has(release.providerId)) continue;
      seen.add(release.providerId);
      unique.push(release);
    }

    const shown = unique.slice(0, 3);
    for (const release of shown) {
      const isActive = toAppSource(release.providerId) === (active || context.sourceId);
      box.append(chipFor(context, row, release, isActive ? 'is-active' : ''));
    }
    if (unique.length > shown.length) {
      const more = document.createElement('span');
      more.className = 'release-chip is-more';
      more.textContent = '+' + (unique.length - shown.length);
      more.title = unique.slice(3).map((r) => r.providerName).join(', ');
      box.append(more);
    }

    // A dimmed chip for a source that does not have this chapter, and only
    // next to a gap. Dimming every absent source on every row turns the list
    // into noise; next to a hole it is the useful fact.
    if (nearGap) {
      for (const source of ledger.sources) {
        if (seen.has(source.providerId) || !source.ok) continue;
        box.append(chipFor(context, row, {
          providerId: source.providerId,
          providerName: source.providerName,
          chapterId: '',
        }, 'is-absent'));
      }
    }
    return box;
  }

  function gapNode(gap) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'chapter-gap';
    node.setAttribute('data-gap', gap.fromNumber + '-' + gap.toNumber);

    const glyph = document.createElement('span');
    glyph.textContent = '▵';
    glyph.setAttribute('aria-hidden', 'true');

    const says = document.createElement('span');
    const one = gap.fromNumber === gap.toNumber;
    const who = gap.availableFrom.length === 1
      ? (ledger.sources.find((s) => s.providerId === gap.availableFrom[0])?.providerName ?? 'another source')
      : `${gap.availableFrom.length} sources`;
    const strong = document.createElement('b');
    strong.textContent = one
      ? `Chapter ${gap.fromNumber} missing here`
      : `Chapters ${gap.fromNumber}–${gap.toNumber} missing here`;
    says.append(strong, document.createTextNode(
      ` — ${who} ${gap.availableFrom.length === 1 ? (one ? 'has it' : 'has them') : (one ? 'have it' : 'have them')}`));

    node.append(glyph, says);
    node.addEventListener('click', () => {
      // The lowest missing chapter, from the first source that has it: the
      // thing you were going to do next anyway.
      const row = ledger.rows.find((r) => r.number === gap.fromNumber);
      const release = row?.releases.find((r) => r.providerId === gap.availableFrom[0]) ?? row?.releases[0];
      if (release) openFrom(release);
    });
    return node;
  }

  /* --- can you finish it? ---------------------------------------------- *
   *
   * One line above the list: how many of the chapters there are you can
   * actually open, and which are missing. Across every source the ledger
   * merged, not just the one you are on -- "can I finish this?" is about
   * Yomu, not about a site.
   *
   * Counted on whole chapters from 1 to the highest whole chapter anyone has.
   * Decimals (12.5) and a chapter 0 are extras: counted when present, never
   * reported missing. When the numbering cannot be trusted -- one source
   * numbered by year, so "2024" is the highest -- it says nothing rather than
   * "12 / 2024".
   */
  function completeness(rows) {
    const whole = new Set();
    for (const row of rows || []) {
      const n = Number(row?.number);
      if (Number.isInteger(n) && n >= 1) whole.add(n);
    }
    if (whole.size < 2) return null;
    const highest = Math.max(...whole);
    const missing = [];
    for (let n = 1; n <= highest; n++) if (!whole.has(n)) missing.push(n);
    if (missing.length > whole.size) return null;
    const ranges = [];
    for (const n of missing) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === n - 1) last[1] = n; else ranges.push([n, n]);
    }
    return { available: highest - missing.length, total: highest, missing, ranges };
  }

  function describeRanges(ranges, limit = 4) {
    const parts = ranges.slice(0, limit).map(([a, b]) => (a === b ? String(a) : `${a}\u2013${b}`));
    const more = ranges.length - limit;
    return parts.join(', ') + (more > 0 ? ` +${more} more` : '');
  }

  function completenessNode(partial) {
    const c = completeness(ledger.rows);
    if (!c) return null;
    const node = document.createElement('div');
    node.id = COMPLETE_ID;
    const whole = c.missing.length === 0;
    node.className = 'yomu-complete' + (whole ? ' is-whole' : ' is-gappy') + (partial ? ' is-partial' : '');
    node.setAttribute('role', 'status');

    const line = document.createElement('div');
    const count = document.createElement('b');
    count.textContent = whole
      ? `All ${c.total} chapters available`
      : `${c.available} / ${c.total} chapters available`;
    line.append(count);
    if (partial) line.append(document.createTextNode(' so far'));

    const meter = document.createElement('span');
    meter.className = 'yomu-complete__meter';
    meter.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('i');
    fill.style.width = `${Math.round((c.available / c.total) * 1000) / 10}%`;
    meter.append(fill);

    node.append(line, meter);
    if (!whole) {
      const gaps = document.createElement('small');
      gaps.textContent = `Missing ${describeRanges(c.ranges)}`;
      node.append(gaps);
    }
    return node;
  }

  function bar(context) {
    const ok = ledger.sources.filter((s) => s.ok).length;
    const total = ledger.sources.length;
    // With one source there is nothing to merge and nothing to choose. The
    // ledger has to degrade to a plain chapter list, and that means the bar
    // is not drawn at all rather than drawn saying "1 source".
    if (total <= 1) return null;

    const node = document.createElement('div');
    node.id = BAR_ID;
    node.className = 'yomu-ledger-bar' + (ledger.partial ? ' is-partial' : '');

    const dot = document.createElement('i');
    const text = document.createElement('span');
    text.textContent = ledger.partial
      ? `${ok} of ${total} sources answered`
      : `${total} sources merged`;

    const detail = document.createElement('small');
    // The source's own words, not a blanket "unreachable" -- a timeout, a
    // dead host and a source that does not serve chapters are three different
    // facts, and only one of them means try again later.
    detail.textContent = ledger.sources
      .map((s) => s.ok
        ? `${s.providerName} ${s.chapterCount}`
        : `${s.providerName} — ${(s.error || 'did not answer').replace(/\.$/, '').toLowerCase()}`)
      .join(' · ');

    const copy = document.createElement('div');
    copy.append(text, detail);
    node.append(dot, copy);
    return node;
  }

  function paint() {
    const context = seriesContext();
    const list = document.querySelector('.chapter-list');
    if (!context || !list) return;

    if (!ledger) {
      document.getElementById(BAR_ID)?.remove();
      document.getElementById(COMPLETE_ID)?.remove();
      return;
    }

    // Can you finish it, above everything else. Replaced only when its text
    // changes: this runs from a mutation observer.
    const whole = completenessNode(ledger.partial);
    const had = document.getElementById(COMPLETE_ID);
    if (!whole) had?.remove();
    else if (!had) list.before(whole);
    else if (had.textContent !== whole.textContent) had.replaceWith(whole);

    // The bar, above the list.
    const built = bar(context);
    const existing = document.getElementById(BAR_ID);
    if (!built) existing?.remove();
    else if (!existing) list.before(built);
    else if (existing.textContent !== built.textContent) existing.replaceWith(built);

    const byNumber = new Map(ledger.rows.map((r) => [r.number, r]));
    const gapEdges = new Set();
    for (const gap of ledger.gaps) { gapEdges.add(gap.fromNumber); gapEdges.add(gap.toNumber); }

    for (const line of list.querySelectorAll('.chapter-line[data-chn]')) {
      const number = Number(line.getAttribute('data-chn'));
      const row = byNumber.get(number);
      let box = line.querySelector('.chapter-releases');
      if (!row || ledger.sources.length <= 1) { box?.remove(); continue; }

      const override = overrideFor(context, number);
      const nearGap = ledger.gaps.some((g) => number >= g.fromNumber - 1 && number <= g.toNumber + 1);

      // Signed, and skipped when the signature matches. This runs from a
      // mutation observer, so rebuilding unconditionally would be a mutation
      // that triggers the observer that rebuilds it: the page would redraw at
      // frame rate and never settle.
      const signature = [
        override?.sourceId ?? '',
        nearGap ? 'g' : '',
        row.releases.map((r) => r.providerId).join(','),
      ].join('|');
      if (box && box.getAttribute('data-sig') === signature) continue;

      const next = releasesRow(context, row, override?.sourceId, nearGap);
      next.setAttribute('data-sig', signature);
      if (box) box.replaceWith(next); else line.append(next);
    }

    paintGaps(list);
    paintElsewhere(context, list);
  }

  /**
   * When the source you are on has nothing, and others have everything.
   *
   * This is the ledger's whole reason for existing at its sharpest -- Solo
   * Leveling on MangaDex says "lists this title but hosts no chapters", while
   * three other enabled sources carry two hundred -- and it was the one case
   * that drew nothing at all, because there were no rows to hang chips on.
   *
   * So the ledger supplies the rows itself. Not a redesign of the chapter
   * list: a plain list of what exists elsewhere, which is the answer to the
   * question the empty screen leaves you with.
   */
  function paintElsewhere(context, list) {
    const ELSEWHERE_ID = 'yomu-ledger-elsewhere';
    const existing = document.getElementById(ELSEWHERE_ID);
    const native = list.querySelectorAll('.chapter-line[data-chn]').length;

    if (native) { existing?.remove(); return; }
    if (!ledger.rows.length) {
      if (ledger.offDevice?.length) paintOffer(context, list, existing);
      else existing?.remove();
      return;
    }

    const signature = 'e' + ledger.rows.length + ':' + ledger.rows[0]?.label;
    if (existing && existing.getAttribute('data-sig') === signature) return;

    const box = document.createElement('div');
    box.id = ELSEWHERE_ID;
    box.className = 'yomu-elsewhere';
    box.setAttribute('data-sig', signature);

    const head = document.createElement('p');
    const here = ledger.sources.find((s) => toAppSource(s.providerId) === context.sourceId);
    head.className = 'yomu-elsewhere__head';
    head.textContent = `${here ? here.providerName : 'This source'} has none of these. `
      + `${ledger.rows.length} chapter${ledger.rows.length === 1 ? '' : 's'} are on your other sources.`;
    box.append(head);

    for (const row of ledger.rows) {
      const line = document.createElement('div');
      line.className = 'yomu-elsewhere__row';
      const number = document.createElement('b');
      number.textContent = row.label || '—';
      const name = document.createElement('span');
      name.textContent = row.name || '';
      line.append(number, name, releasesRow(context, row, null, false));
      box.append(line);
    }

    if (existing) existing.replaceWith(box); else list.append(box);
  }

  /**
   * Nothing on the sources this device has on, and the chapters are elsewhere.
   *
   * The state a new visitor is in after "look around without setting anything
   * up" (MangaDex only), and an iOS Home Screen app is in on first launch (its
   * storage is not Safari's). Solo Leveling then read "0 chapters" while three
   * sources carried two hundred. One tap turns the fullest one on and opens
   * the title there; a full navigation, because the app's collection store
   * reads localStorage once and never hears a later write.
   */
  function paintOffer(context, list, existing) {
    const ELSEWHERE_ID = 'yomu-ledger-elsewhere';
    const offer = ledger.offDevice.slice(0, 4);
    const signature = 'o' + offer.map((s) => s.providerId + s.chapterCount).join(',');
    if (existing && existing.getAttribute('data-sig') === signature) return;

    const box = document.createElement('div');
    box.id = ELSEWHERE_ID;
    box.className = 'yomu-elsewhere yomu-elsewhere--offer';
    box.setAttribute('data-sig', signature);

    const head = document.createElement('p');
    head.className = 'yomu-elsewhere__head';
    head.textContent = `None of your sources have chapters for this title. `
      + `${offer.length === 1 ? 'One source you have not turned on has them' : `${offer.length} sources you have not turned on have them`}:`;
    box.append(head);

    for (const source of offer) {
      const line = document.createElement('div');
      line.className = 'yomu-elsewhere__row';
      const name = document.createElement('b');
      name.textContent = source.providerName || source.providerId;
      const count = document.createElement('span');
      count.textContent = `${source.chapterCount} chapter${source.chapterCount === 1 ? '' : 's'}`;
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'yomu-elsewhere__go';
      go.textContent = 'Turn on & open';
      go.setAttribute('aria-label', `Turn on ${source.providerName} and open this title there`);
      go.addEventListener('click', () => {
        if (!enableSource(source)) { go.textContent = 'Could not turn on'; return; }
        location.assign('/series/' + encodeURIComponent(source.seriesId)
          + '?source=' + encodeURIComponent(toAppSource(source.providerId)));
      });
      line.append(name, count, go);
      box.append(line);
    }

    if (existing) existing.replaceWith(box); else list.append(box);
  }

  /**
   * The same row the Add Source screen writes (source-import.js), so the app
   * cannot tell the difference. `kind: 'api'` for an extension -- a wrong kind
   * makes the app say "This source was removed."
   */
  function enableSource(source) {
    try {
      const raw = localStorage.getItem(COLLECTION_KEY);
      const col = raw === null ? { revision: 0, sources: [], library: [], progress: {} } : JSON.parse(raw);
      if (!col || typeof col !== 'object' || !Array.isArray(col.sources)) return false;
      const id = toAppSource(source.providerId);
      const existing = col.sources.find((s) => s && s.id === id);
      let row;
      if (source.providerId === 'mangadex') {
        if (!existing) return false;
        row = { ...existing, enabled: true };
      } else {
        const ext = source.providerId.slice(4);
        row = {
          ...existing,
          id,
          label: source.providerName || ext,
          category: 'Yomu Extensions',
          kind: 'api',
          url: location.origin + '/api/ext/source/' + encodeURIComponent(ext) + '/',
          enabled: true,
        };
      }
      localStorage.setItem(COLLECTION_KEY, JSON.stringify({
        ...col,
        revision: (Number.isInteger(col.revision) ? col.revision : 0) + 1,
        sources: [...col.sources.filter((s) => s && s.id !== id), row],
      }));
      return true;
    } catch { return false; }
  }

  /**
   * Gap rows, at their sorted position in whichever direction the list is in.
   *
   * A gap is chapters no row exists for -- the active source does not have
   * them -- so there is nothing to attach them to. They are placed between the
   * two rows they fall between, found by reading the numbers the list is
   * actually showing rather than by assuming its order.
   */
  function paintGaps(list) {
    const want = ledger.sources.length <= 1 ? [] : ledger.gaps;
    // Same reason as the chips: removing and re-adding on every observer tick
    // is a loop. The list is signed with what it is currently showing.
    const signature = want.map((g) => g.fromNumber + '-' + g.toNumber).join('|');
    if (list.getAttribute('data-gapsig') === signature) return;
    list.setAttribute('data-gapsig', signature);

    for (const stale of list.querySelectorAll('.chapter-gap')) stale.remove();
    if (!want.length) return;

    const lines = [...list.querySelectorAll('.chapter-line[data-chn]')];
    if (lines.length < 2) return;
    const descending = Number(lines[0].getAttribute('data-chn'))
      > Number(lines[lines.length - 1].getAttribute('data-chn'));

    for (const gap of ledger.gaps) {
      let before = null;
      for (const line of lines) {
        const n = Number(line.getAttribute('data-chn'));
        if (descending ? n < gap.fromNumber : n > gap.toNumber) { before = line; break; }
      }
      const node = gapNode(gap);
      if (before) list.insertBefore(node, before);
      else list.append(node);
    }
  }

  /* --- ticking ----------------------------------------------------------- */

  function tick() {
    const context = seriesContext();
    if (!context) { ledgerFor = ''; ledger = null; return; }

    // The title is needed only for the discovery path, and it is not on the
    // page until the hero resolves.
    const title = document.querySelector('.series-hero-copy h1')?.textContent?.trim() || '';
    const links = linkStore()[context.key];
    if (!title && !(Array.isArray(links) && links.length)) return;

    if (context.key !== ledgerFor) {
      ledgerFor = context.key;
      ledger = null;
      loadLedger(context, title);
      return;
    }
    if (ledger) paint();
  }

  /* An object literal: Node's CJS lexer reads named exports statically. */
  if (typeof module !== 'undefined' && module.exports) module.exports = { completeness, describeRanges };
  if (typeof document === 'undefined') return;

  const pass = () => tick();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pass);
  else pass();

  new MutationObserver(pass).observe(document.documentElement, { childList: true, subtree: true });
  for (const type of ['popstate', 'hashchange']) addEventListener(type, pass);
})();
