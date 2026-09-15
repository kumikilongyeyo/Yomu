/**
 * Yomu Sync — the client half.
 *
 * The Worker holds one document per library code (worker/sync.ts); this reads
 * and writes it, and puts a Devices group in Settings so the code has an
 * address you can always look up.
 *
 * Two facts shape everything here.
 *
 * KV allows a thousand writes a day and a hundred thousand reads. So pushing
 * is rationed -- batched locally, debounced, and sent when leaving the reader
 * or the page -- while pulling is free enough to do on every load.
 *
 * The app's collection store reads localStorage once at startup and has no
 * storage listener, so a pull that lands after React has mounted cannot reach
 * the screen. Rather than reload the page underneath someone, a changed
 * library is written to storage and announced in one line they can act on when
 * they like. Progress needs no such thing: the reader and the Continue row
 * both read storage on every tick, so a merged position appears on its own.
 *
 * What does not sync, deliberately:
 *   18+ allowed / blur   a shared laptop must not inherit the phone's answer
 *   theme, fullscreen    a phone and a 27" monitor want different answers
 *   downloads            actual files on actual disks
 *   the Mihon bridge URL a tunnel address is a secret and it changes
 *
 * When the Expo source turns up this belongs in a store beside the collection;
 * delete this file then.
 */
(() => {
  'use strict';

  const STATE_KEY = 'yomu.v1.sync';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const READING_KEY = 'yomu.v1.reading';
  const RESUME_PREFIX = 'yomu.v1.resume.local-account.';

  /** Never less than this between writes. KV's budget is a thousand a day. */
  const PUSH_INTERVAL_MS = 60_000;
  const SHEET_ID = 'yomu-pair';
  const GROUP_ID = 'yomu-devices';

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };
  const titleKey = (sourceId, id) => sourceId + ':' + id;

  /* --- local state ------------------------------------------------------ */

  const state = () => {
    const value = readJSON(STATE_KEY, null);
    return value && typeof value === 'object' ? value : {};
  };
  const setState = (patch) => writeJSON(STATE_KEY, { ...state(), ...patch });
  const linked = () => !!(state().code && state().deviceId);

  /** Enough to tell two of your own devices apart in a list, and no more. */
  function deviceName() {
    const ua = navigator.userAgent || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android phone';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows PC';
    if (/Linux/.test(ua)) return 'Linux PC';
    return 'A device';
  }

  const display = (code) =>
    code ? 'YOMU-' + code.slice(0, 5) + '-' + code.slice(5) : '';

  async function api(route, payload) {
    const response = await fetch('/api/sync/' + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Sync failed.');
    return data;
  }

  /* --- reading the device ----------------------------------------------- */

  const collection = () => readJSON(COLLECTION_KEY, null) || {};
  const libraryOf = (c) => (Array.isArray(c.library) ? c.library : []);
  const sourcesOf = (c) => (Array.isArray(c.sources) ? c.sources : []);

  const readingIndex = () => {
    const value = readJSON(READING_KEY, null);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  };

  /** "Chapter 41" -> 41. The anchor never stored a number; the reading index
   *  records the header's own words, and the number in them is what lets the
   *  merge compare two positions rather than two clocks. */
  function chapterNumberOf(label) {
    const match = /(\d+(?:\.\d+)?)/.exec(String(label || ''));
    return match ? Number(match[1]) : undefined;
  }

  function progressPatch() {
    const out = [];
    const index = readingIndex();
    let keys = [];
    try { keys = Object.keys(localStorage); } catch {}

    for (const key of keys) {
      if (!key.startsWith(RESUME_PREFIX) || key.endsWith('.read')) continue;
      const seriesId = key.slice(RESUME_PREFIX.length);
      const anchor = readJSON(key, null)?.anchor;
      if (!anchor || typeof anchor.chapterId !== 'string') continue;

      const record = Object.values(index).find((r) => r && r.seriesId === seriesId) || {};
      const read = readJSON(RESUME_PREFIX + seriesId + '.read', []);
      out.push({
        seriesId,
        sourceId: record.sourceId,
        chapterId: anchor.chapterId,
        chapterNumber: chapterNumberOf(record.chapterLabel),
        page: Number(record.page) || undefined,
        pages: Number(record.pages) || undefined,
        read: Array.isArray(read) ? read : [],
        updatedAt: Number(anchor.updatedAtLocal) || Date.now(),
      });
    }
    return out;
  }

  /**
   * When this device saved each title.
   *
   * The library rows carry no saved-at of their own, so it is kept here: a
   * title is stamped the first time this device sees it and the stamp is
   * dropped when it goes. That is exactly what the server's tombstone rule
   * needs -- re-pushing a stale library sends old stamps and a removal stands,
   * while saving something again gives it a fresh one and it comes back.
   */
  function stampLibrary(library) {
    const before = state().addedAt || {};
    const after = {};
    const now = Date.now();
    for (const entry of library) {
      if (!entry || !entry.id || !entry.sourceId) continue;
      const key = titleKey(entry.sourceId, entry.id);
      after[key] = before[key] || now;
    }
    // Written every pass, so a title deleted locally loses its stamp and a
    // later re-save cannot inherit the old one.
    if (JSON.stringify(after) !== JSON.stringify(before)) setState({ addedAt: after });
    return after;
  }

  /**
   * Titles this device has dropped since the last push.
   *
   * Noticed rather than announced: the app removes a title by rewriting the
   * collection, and nothing tells this file. So the set of keys seen last time
   * is kept, and anything missing from it now is a removal.
   */
  function noticeRemovals(library) {
    const current = new Set(library.map((e) => titleKey(e.sourceId, e.id)));
    const previous = state().seen || [];
    const gone = previous.filter((key) => !current.has(key));
    const pending = [...new Set([...(state().removed || []), ...gone])];
    if (gone.length || (state().seen || []).length !== current.size) {
      setState({ seen: [...current], removed: pending });
    }
    return pending;
  }

  function buildPatch() {
    const c = collection();
    const library = libraryOf(c);
    const stamps = stampLibrary(library);
    return {
      library: library.map((entry) => ({
        ...entry,
        addedAt: stamps[titleKey(entry.sourceId, entry.id)],
      })),
      removed: noticeRemovals(library),
      // The whole row, not just the id. A fresh install's source list holds
      // only the built-ins, so an id is something it can recognise but not
      // something it can create -- and the install where you have none of them
      // yet is exactly the one sync is for.
      sources: sourcesOf(c)
        .filter((s) => s && s.enabled && s.id)
        .map((s) => ({ id: s.id, label: s.label, category: s.category, kind: s.kind, url: s.url })),
      progress: progressPatch(),
    };
  }

  /* --- writing the device back ------------------------------------------ */

  /** True when something the app has already rendered changed underneath it. */
  function applyDoc(doc) {
    let structural = false;

    const c = collection();
    const library = libraryOf(c);
    const have = new Set(library.map((e) => titleKey(e.sourceId, e.id)));
    const wanted = new Map(
      (doc.library || []).map((e) => [titleKey(e.sourceId, e.id), e]),
    );

    const next = library.filter((e) => wanted.has(titleKey(e.sourceId, e.id)));
    if (next.length !== library.length) structural = true;
    for (const [key, entry] of wanted) {
      if (have.has(key)) continue;
      // `at` and `addedAt` are the merge's bookkeeping, not the app's.
      const { at, addedAt, ...rest } = entry;
      next.push(rest);
      structural = true;
    }

    // Two jobs: switch on the ones this device already lists, and create the
    // ones it has never heard of. The second is the one that matters on a new
    // install, where the list is just the built-ins.
    const incoming = (doc.sources || []).filter((s) => s && s.id);
    const known = new Set(sourcesOf(c).map((s) => s.id));
    const wantedSources = new Set(incoming.map((s) => s.id));

    const sources = sourcesOf(c).map((source) => {
      if (!wantedSources.has(source.id) || source.enabled) return source;
      structural = true;
      return { ...source, enabled: true };
    });
    for (const source of incoming) {
      if (known.has(source.id)) continue;
      // Only fields the app's own rows carry, and only when present, so a
      // sparse row from an older client does not write undefined into storage.
      const row = { id: source.id, enabled: true };
      for (const field of ['label', 'category', 'kind']) {
        if (source[field]) row[field] = source[field];
      }
      // The url is resolved rather than copied, and a row whose url will not
      // resolve is dropped entirely.
      //
      // The Sources screen calls new URL() on this, which throws on anything
      // that is not absolute, and a throw during render takes the whole screen
      // down. Without this check one bad row on one device would travel to
      // every paired device and break Sources on all of them -- the failure
      // sync is uniquely able to cause, and the one it must not.
      //
      // Resolving also repairs the ordinary case: the app writes these as
      // location.origin + '/api/ext/source/...', so a row that arrives as a
      // bare path is simply re-anchored to this origin.
      if (source.url) {
        try { row.url = new URL(source.url, location.origin).href; }
        catch { continue; }
      }
      sources.push(row);
      structural = true;
    }

    if (structural) {
      writeJSON(COLLECTION_KEY, {
        ...c,
        revision: Number(c.revision || 0) + 1,
        library: next,
        sources,
      });
    }

    // Positions are written whatever happens: the reader and the Continue row
    // read storage on every tick, so these show up without anyone reloading.
    for (const entry of doc.progress || []) {
      if (!entry || !entry.seriesId || !entry.chapterId) continue;
      const key = RESUME_PREFIX + entry.seriesId;
      const mine = readJSON(key, null)?.anchor;
      const ahead = !mine
        || mine.chapterId !== entry.chapterId
        || (Number(entry.page) || 0) > (Number(mine.pageIndex) || 0) + 1;
      if (ahead) {
        writeJSON(key, {
          sourceSeriesId: entry.seriesId,
          anchor: {
            schema: 'yomu.reading-anchor/1',
            chapterId: entry.chapterId,
            pageKey: mine?.pageKey ?? null,
            pageIndex: Math.max(0, (Number(entry.page) || 1) - 1),
            offsetInPage: 0,
            manifestVersion: mine?.manifestVersion ?? 'synced',
            pageListVersion: Number(entry.pages) || 0,
            updatedAtLocal: Number(entry.updatedAt) || Date.now(),
          },
        });
      }
      if (Array.isArray(entry.read) && entry.read.length) {
        const readKey = RESUME_PREFIX + entry.seriesId + '.read';
        const merged = [...new Set([...(readJSON(readKey, []) || []), ...entry.read])];
        writeJSON(readKey, merged);
      }
    }

    seedReadingIndex(doc);

    // `seen` is re-based on what was just written, so a title removed by
    // another device is not then reported by this one as a fresh local
    // removal. It would be, otherwise -- and a re-save on this device would
    // arrive carrying its own tombstone and delete itself.
    setState({
      code: doc.code,
      revision: doc.revision,
      lastPull: Date.now(),
      seen: next.map((e) => titleKey(e.sourceId, e.id)),
    });
    return structural;
  }

  /**
   * Give Continue Reading something to draw on a device that has never opened
   * the reader.
   *
   * A restored anchor is a position and nothing else -- no title, no cover --
   * which is the same hole that made the row vanish locally. Here the two
   * halves are both in the document: the position is in `progress` and the
   * name and cover are in `library`, so the index can be assembled without a
   * source being reachable. Existing rows win, because a local one was written
   * from the reader's own screen and knows the page count.
   */
  function seedReadingIndex(doc) {
    const byId = new Map();
    for (const entry of doc.library || []) byId.set(entry.id, entry);

    const index = readingIndex();
    let added = false;
    for (const entry of doc.progress || []) {
      if (!entry || !entry.seriesId || !entry.sourceId || !entry.chapterId) continue;
      const key = titleKey(entry.sourceId, entry.seriesId);
      if (index[key]) continue;
      const title = byId.get(entry.seriesId);
      index[key] = {
        seriesId: entry.seriesId,
        sourceId: entry.sourceId,
        chapterId: entry.chapterId,
        chapterLabel: entry.chapterNumber != null ? 'Chapter ' + entry.chapterNumber : '',
        title: title?.title || '',
        cover: title?.cover || '',
        page: entry.page,
        pages: entry.pages,
        at: Number(entry.updatedAt) || Date.now(),
      };
      added = true;
    }
    if (added) writeJSON(READING_KEY, index);
  }

  /* --- push and pull ----------------------------------------------------- */

  let pushTimer = null;
  let pushing = false;

  async function pushNow() {
    if (!linked() || pushing) return;
    pushing = true;
    try {
      const patch = buildPatch();
      const doc = await api('push', {
        code: state().code,
        deviceId: state().deviceId,
        deviceName: deviceName(),
        patch,
      });
      // Cleared only here, and only on the response: a removal the server has
      // not acknowledged has to be sent again, or closing the tab between
      // noticing it and pushing it loses the delete.
      const stillPending = (state().removed || []).filter((k) => !patch.removed.includes(k));
      setState({ lastPush: Date.now(), removed: stillPending });
      if (applyDoc(doc)) announce();
      renderGroup();
    } catch (error) {
      // A device that was unpaired elsewhere stops trying and says so, rather
      // than retrying a rejected push for the rest of the session.
      if (/no longer paired|No library/i.test(error.message)) {
        setState({ code: null, deviceId: null, error: error.message });
        renderGroup();
      }
    } finally { pushing = false; }
  }

  function schedulePush() {
    if (!linked() || pushTimer) return;
    const since = Date.now() - (state().lastPush || 0);
    pushTimer = setTimeout(() => { pushTimer = null; pushNow(); },
      Math.max(0, PUSH_INTERVAL_MS - since));
  }

  async function pullNow() {
    if (!linked()) return;
    try {
      const doc = await api('pull', { code: state().code });
      if (applyDoc(doc)) announce();
      renderGroup();
    } catch { /* offline is the normal case, not an error worth saying */ }
  }

  /* --- the one line it is allowed to interrupt with ---------------------- */

  function announce() {
    if (document.getElementById('yomu-sync-note')) return;
    const note = document.createElement('div');
    note.id = 'yomu-sync-note';
    note.className = 'yomu-sync-note';
    note.innerHTML = '<span></span><button type="button">Refresh</button>';
    note.querySelector('span').textContent = 'Your library changed on another device.';
    note.querySelector('button').addEventListener('click', () => location.reload());
    document.body.append(note);
    setTimeout(() => note.remove(), 12000);
  }

  /* ------------------------------------------------------------------ *
   * Settings: a Devices group, where Backup already sits
   *
   * Sync is the same job as "Back up everything", done continuously instead of
   * by hand, so it belongs beside it rather than on a screen of its own. The
   * device list is the part that earns its place: "MacBook Air -- last seen
   * Tuesday" is how anyone notices sync has quietly stopped.
   *
   * Re-asserted on every observer tick, because React owns this list.
   * ------------------------------------------------------------------ */

  let devices = [];

  const ago = (at) => {
    const seconds = Math.max(0, (Date.now() - at) / 1000);
    if (seconds < 90) return 'just now';
    if (seconds < 3600) return Math.round(seconds / 60) + ' minutes ago';
    if (seconds < 172800) return Math.round(seconds / 3600) + ' hours ago';
    return Math.round(seconds / 86400) + ' days ago';
  };

  function row(title, subtitle, onClick, extra) {
    const element = document.createElement(onClick ? 'button' : 'div');
    if (onClick) { element.type = 'button'; element.addEventListener('click', onClick); }
    element.className = 'settings-row' + (extra || '');
    const copy = document.createElement('div');
    copy.className = 'settings-row__copy';
    const strong = document.createElement('strong');
    strong.textContent = title;
    copy.append(strong);
    if (subtitle) {
      const small = document.createElement('small');
      small.textContent = subtitle;
      copy.append(small);
    }
    element.append(copy);
    return element;
  }

  function renderGroup() {
    const group = document.getElementById(GROUP_ID);
    if (!group) return;
    group.textContent = '';

    if (!linked()) {
      const start = row(
        'Turn on sync',
        'One library across every device. No email, no password.',
        async () => {
          start.disabled = true;
          try {
            const doc = await api('create', { deviceName: deviceName() });
            setState({ code: doc.code, deviceId: doc.deviceId, addedAt: {}, seen: [], removed: [] });
            devices = doc.devices || [];
            renderGroup();
            pushNow();
          } catch (error) {
            start.disabled = false;
            start.querySelector('small').textContent = error.message;
          }
        },
      );
      group.append(start);

      const join = row('I already have a code', 'Enter it, or scan from another device',
        () => openSheet('join'));
      group.append(join);
      if (state().error) {
        const note = row('Sync stopped', state().error);
        note.classList.add('is-warn');
        group.append(note);
      }
      return;
    }

    const code = row('Your Yomu code', display(state().code), () => openSheet('show'), ' is-accent');
    group.append(code);

    for (const device of devices) {
      const mine = device.id === state().deviceId;
      const entry = row(
        device.name + (mine ? ' (this device)' : ''),
        'Synced ' + ago(device.lastSeen),
        mine ? null : () => unpair(device),
      );
      const dot = document.createElement('span');
      dot.className = 'yomu-dot' + (Date.now() - device.lastSeen < 86400000 ? ' is-on' : '');
      entry.prepend(dot);
      group.append(entry);
    }

    group.append(row('Pair a device', 'Show a QR or a one-time code', () => openSheet('show')));
    group.append(row('Replace the code', 'Unpairs every other device at once', regenerate));
  }

  async function unpair(device) {
    if (!confirm('Unpair ' + device.name + '? It keeps its own copy and stops syncing.')) return;
    try {
      const doc = await api('unpair', { code: state().code, target: device.id });
      devices = doc.devices || [];
      renderGroup();
    } catch {}
  }

  async function regenerate() {
    if (!confirm('Replace your code? Every other device stops syncing until you pair it again.')) return;
    try {
      const doc = await api('regenerate', { code: state().code, deviceId: state().deviceId });
      setState({ code: doc.code });
      devices = doc.devices || [];
      renderGroup();
    } catch {}
  }

  function mountGroup() {
    if (!location.pathname.startsWith('/settings')) return;
    const labels = [...document.querySelectorAll('.group-label')];
    // Placed against Storage, which is where Back up everything lives: the two
    // are the same job and a person looking for either looks in one place.
    const anchor = labels.find((l) => /storage/i.test(l.textContent || '')) ?? labels[labels.length - 1];
    if (!anchor) return;

    let label = document.getElementById(GROUP_ID + '-label');
    let group = document.getElementById(GROUP_ID);
    if (!label || !group) {
      label = document.createElement('div');
      label.className = 'group-label';
      label.id = GROUP_ID + '-label';
      label.textContent = 'Devices';
      group = document.createElement('section');
      group.className = 'settings-group glass';
      group.id = GROUP_ID;
    }
    // Checked as a pair against the anchor, not merely as adjacent to each
    // other, so a group inserted before its neighbour had mounted corrects
    // itself on a later tick instead of staying where it landed.
    if (label.nextElementSibling !== group || anchor.previousElementSibling !== group) {
      anchor.before(label, group);
      renderGroup();
    }
  }

  /* ------------------------------------------------------------------ *
   * Pairing sheet
   *
   * Pairing is something you do three times ever, so it gets the screen while
   * it is happening rather than a row it has to share.
   *
   * The QR is the point: big enough to scan off a monitor from across a desk.
   * It encodes a link, not a code, so the phone's own camera app offers to
   * open it -- no scanner inside Yomu and no camera permission to grant. The
   * code underneath is for when a camera will not play.
   *
   * What it encodes is a pairing code, good for ten minutes and once only --
   * never the library code, which is permanent and is the whole credential.
   * ------------------------------------------------------------------ */

  let sheetTimer = null;

  function closeSheet() {
    if (sheetTimer) { clearInterval(sheetTimer); sheetTimer = null; }
    document.getElementById(SHEET_ID)?.remove();
  }

  function openSheet(mode) {
    closeSheet();
    const wrap = document.createElement('div');
    wrap.id = SHEET_ID;
    wrap.className = 'yomu-pair';
    wrap.innerHTML =
      '<button class="yomu-pair__scrim" type="button" aria-label="Close"></button>' +
      '<section class="yomu-pair__sheet glass" role="dialog" aria-label="Pair a device">' +
      '<div class="yomu-pair__grab"></div><div class="yomu-pair__body"></div></section>';
    wrap.querySelector('.yomu-pair__scrim').addEventListener('click', closeSheet);
    document.body.append(wrap);
    const body = wrap.querySelector('.yomu-pair__body');
    if (mode === 'join') renderJoin(body);
    else renderShow(body);
  }

  function heading(body, title, line) {
    const h = document.createElement('h2');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = line;
    body.append(h, p);
  }

  async function renderShow(body) {
    heading(body, 'Point your phone here',
      'Open the Camera app and aim it at this code. No scanner, no permission needed.');

    const holder = document.createElement('div');
    holder.className = 'yomu-pair__qr';
    const codeLine = document.createElement('p');
    codeLine.className = 'yomu-pair__code';
    const expiry = document.createElement('p');
    expiry.className = 'yomu-pair__expiry';
    body.append(holder, codeLine, expiry);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'yomu-pair__close';
    close.textContent = 'Done';
    close.addEventListener('click', closeSheet);
    body.append(close);

    let pairing;
    try {
      pairing = await api('pair', { code: state().code });
    } catch (error) {
      expiry.textContent = error.message;
      return;
    }

    // /join, not /join.html: the asset server 307s the second to the first,
    // and a QR should not spend a redirect -- fragments survive one only
    // because browsers choose to re-apply them, which is not a guarantee to
    // hang a one-time credential on.
    const link = location.origin + '/join#' + pairing.pairingCode;
    codeLine.textContent = display(pairing.pairingCode);
    await drawQR(holder, link);

    const tick = () => {
      const left = Math.max(0, pairing.expiresAt - Date.now());
      if (!left) {
        expiry.textContent = 'This code has expired. Close and show a new one.';
        clearInterval(sheetTimer);
        sheetTimer = null;
        return;
      }
      const m = Math.floor(left / 60000);
      const s = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
      expiry.textContent = `Expires in ${m}:${s} · one use only`;
    };
    tick();
    sheetTimer = setInterval(tick, 1000);

    // The other device pairing is a change to this library, so the device list
    // fills in on its own while the sheet is still open.
    const watch = setInterval(async () => {
      if (!document.getElementById(SHEET_ID)) return clearInterval(watch);
      try {
        const doc = await api('pull', { code: state().code });
        devices = doc.devices || [];
        renderGroup();
      } catch {}
    }, 5000);
  }

  function renderJoin(body) {
    heading(body, 'Enter your Yomu code',
      'It is in Settings → Devices on a device that already has your library.');

    const field = document.createElement('input');
    field.className = 'yomu-pair__field';
    field.placeholder = 'YOMU-XXXXX-XXXXX';
    field.autocapitalize = 'characters';
    field.spellcheck = false;
    field.setAttribute('aria-label', 'Your Yomu code');

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'yomu-pair__go';
    go.textContent = 'Join';

    const problem = document.createElement('p');
    problem.className = 'yomu-pair__expiry';

    go.addEventListener('click', async () => {
      go.disabled = true;
      problem.textContent = '';
      try {
        const doc = await api('join', { code: field.value, deviceName: deviceName() });
        setState({ code: doc.code, deviceId: doc.deviceId, addedAt: {}, seen: [], removed: [], error: null });
        devices = doc.devices || [];
        applyDoc(doc);
        closeSheet();
        renderGroup();
        location.reload();
      } catch (error) {
        go.disabled = false;
        problem.textContent = error.message;
      }
    });

    body.append(field, go, problem);
    field.focus();
  }

  /**
   * The QR itself.
   *
   * Drawn by qrcode-generator from a CDN rather than an encoder written here:
   * a correct one is a few hundred lines of Reed-Solomon and mask selection,
   * and this page cannot work offline anyway -- pairing is a network act. If
   * the script does not load, the sheet still shows the code to type, which is
   * the fallback it would have needed regardless.
   */
  function drawQR(holder, text) {
    return loadQRLibrary().then((qrcode) => {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      const quiet = 2;
      const size = n + quiet * 2;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f4f6fa';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#0c131b';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(c + quiet, r + quiet, 1, 1);
      }
      holder.textContent = '';
      holder.append(canvas);
    }).catch(() => {
      holder.textContent = 'Type the code below instead.';
      holder.classList.add('is-text');
    });
  }

  let qrLoading = null;
  function loadQRLibrary() {
    if (globalThis.qrcode) return Promise.resolve(globalThis.qrcode);
    if (qrLoading) return qrLoading;
    qrLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
      script.onload = () => globalThis.qrcode ? resolve(globalThis.qrcode) : reject(new Error('no qrcode'));
      script.onerror = () => reject(new Error('blocked'));
      document.head.append(script);
    });
    return qrLoading;
  }

  /* --- when to talk to the server --------------------------------------- */

  // Leaving the reader, closing the tab, or switching away: the three moments
  // where a position is worth a write even if the interval has not elapsed.
  for (const type of ['pagehide', 'visibilitychange']) {
    addEventListener(type, () => {
      if (type === 'visibilitychange' && document.visibilityState !== 'hidden') return;
      if (linked()) pushNow();
    });
  }

  const boot = () => {
    mountGroup();
    if (!linked()) return;
    pullNow();
    schedulePush();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  new MutationObserver(() => { mountGroup(); schedulePush(); }).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Read by /join.html, which finishes a redeem and then hands over.
  globalThis.__yomuSyncAdopt = (doc, deviceId) => {
    setState({ code: doc.code, deviceId, addedAt: {}, seen: [], removed: [], error: null });
    applyDoc(doc);
  };
})();
