/**
 * Year in Yomu, and the monthly wrap.
 *
 * A shareable card, drawn to a canvas on this device and saved as a PNG:
 * chapters read, hours (estimated, and said so), days, the top three genres,
 * the three covers that defined the month, the badge earned, and Mori's
 * stage. A monthly card for any of the last fourteen months and a year card.
 *
 * Nothing leaves the device. That is the promise the app makes on screen, and
 * this is the feature most tempted to break it -- so there is no render
 * endpoint, no upload, no analytics ping. The covers are drawn through the
 * app's own same-origin image relay, which is what keeps the canvas
 * exportable; a cover that will not load becomes a plate with initials, and
 * a canvas that turns out tainted anyway is redrawn without pictures rather
 * than failing to save.
 *
 * Every number comes from YomuProgress.monthly() and year(). Nothing here
 * counts anything.
 */
(() => {
  'use strict';

  const HOST_ID = 'yomu-wrap';
  const NUDGE_ID = 'yomu-wrap-nudge';
  const SEEN_KEY = 'yomu.v1.wrap.seen';
  const COLLECTION_KEY = 'yomu.v1.collection';
  const READING_KEY = 'yomu.v1.reading';
  const MINUTES_PER_CHAPTER = 7;
  const W = 1080, H = 1350;

  const browser = typeof document !== 'undefined';

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };

  /* --- pure ------------------------------------------------------------------ */

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthLabel = (key) => MONTHS[Number(String(key).slice(5, 7)) - 1] || key;

  /** "~4 h", "45 min", "~1 h". Estimated, at seven minutes a chapter. */
  function hours(chapters) {
    const minutes = chapters * MINUTES_PER_CHAPTER;
    if (minutes < 60) return minutes + ' min';
    const h = Math.round(minutes / 60);
    return '~' + h + ' h';
  }

  /* Ratings AniList files as genres. Not a taste, and not for a card that
     is about to be posted. */
  const SKIP = new Set(['Hentai', 'Ecchi']);

  /** Genres weighted by chapters read of each title, top `n`. */
  function rankGenres(series, genresOf, n = 3) {
    const weight = new Map();
    for (const s of series) {
      for (const g of genresOf(s) || []) {
        if (SKIP.has(g)) continue;
        weight.set(g, (weight.get(g) || 0) + s.chapters);
      }
    }
    return [...weight].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([g]) => g);
  }

  /** The three titles that defined the period: most chapters, with a title. */
  function pickCovers(series, infoOf, n = 3) {
    const out = [];
    for (const s of series) {
      const info = infoOf(s.seriesId);
      if (!info || !info.title) continue;
      out.push({ ...info, chapters: s.chapters });
      if (out.length >= n) break;
    }
    return out;
  }

  /** Same origin stays; anything else goes through the app's image relay. */
  function relay(src) {
    if (!src) return '';
    if (/^data:/i.test(src)) return '';
    try {
      const url = new URL(src, location.origin);
      if (url.origin === location.origin) return url.href;
      return location.origin + '/api/img?u=' + encodeURIComponent(url.href);
    } catch { return ''; }
  }

  const initials = (title) => String(title || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();

  /* --- what we know about titles --------------------------------------------- */

  function infoOf(seriesId) {
    const collection = readJSON(COLLECTION_KEY, {}) || {};
    for (const row of Array.isArray(collection.library) ? collection.library : []) {
      if (row && row.id === seriesId) return { seriesId, title: row.title || '', cover: row.cover || '' };
    }
    for (const record of Object.values(readJSON(READING_KEY, {}) || {})) {
      if (record && record.seriesId === seriesId) return { seriesId, title: record.title || '', cover: record.cover || '' };
    }
    return null;
  }

  const genresOf = (s) => {
    const info = infoOf(s.seriesId);
    return info?.title ? window.YomuAniList?.cached?.(info.title)?.genres || [] : [];
  };

  /* --- drawing --------------------------------------------------------------- */

  function palette() {
    const cs = getComputedStyle(document.documentElement);
    const get = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
    const bg = get('--bg', '#f5f2ec');
    return {
      bg,
      surface: get('--raised', '#efeade'),
      text: get('--text', '#1e1b16'),
      muted: get('--muted', '#4a443a'),
      faint: get('--faint', '#9b9184'),
      accent: get('--accent', '#b8791c'),
      accentText: get('--accentText', '#18212a'),
      dark: /^#0|^rgba?\(\s*[0-3]?\d,/.test(bg),
    };
  }

  const FONT = "'Archivo', ui-sans-serif, system-ui, -apple-system, sans-serif";

  function loadImage(src, ms = 4500) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const done = (value) => { clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => done(null), ms);
      img.onload = () => done(img);
      img.onerror = () => done(null);
      img.src = src;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitText(ctx, text, maxWidth) {
    let out = String(text);
    while (out.length > 3 && ctx.measureText(out).width > maxWidth) out = out.slice(0, -2).trimEnd() + '…';
    return out;
  }

  /** The card, for a month or a year. `covers` is [{title, img|null}]. */
  function draw(canvas, data, covers, options) {
    const p = palette();
    const ctx = canvas.getContext('2d');
    canvas.width = W; canvas.height = H;

    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, W, H);
    /* A soft accent wash top-right, so the card is not a flat rectangle. */
    const glow = ctx.createRadialGradient(W - 120, 120, 40, W - 120, 120, 620);
    glow.addColorStop(0, p.accent + (p.dark ? '55' : '33'));
    glow.addColorStop(1, p.accent + '00');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    const pad = 72;
    ctx.textBaseline = 'alphabetic';

    /* Kicker */
    ctx.fillStyle = p.accent;
    ctx.font = `800 26px ${FONT}`;
    ctx.letterSpacing = '4px';
    ctx.fillText((data.kind === 'year' ? 'YOUR ' + data.year : 'YOUR ' + monthLabel(data.month).toUpperCase()) + ' IN YOMU', pad, pad + 26);
    ctx.letterSpacing = '0px';

    /* The number */
    ctx.fillStyle = p.text;
    ctx.font = `800 168px ${FONT}`;
    const big = String(data.chapters);
    ctx.fillText(big, pad - 8, pad + 210);
    const bigW = ctx.measureText(big).width;
    ctx.font = `700 40px ${FONT}`;
    ctx.fillStyle = p.muted;
    ctx.fillText(data.chapters === 1 ? 'chapter' : 'chapters', pad + bigW + 8, pad + 210);

    /* Stats line */
    ctx.font = `600 30px ${FONT}`;
    ctx.fillStyle = p.muted;
    const stats = [hours(data.chapters) + ' reading', data.days + (data.days === 1 ? ' day' : ' days')];
    if (data.titlesCompleted) stats.push(data.titlesCompleted + (data.titlesCompleted === 1 ? ' title finished' : ' titles finished'));
    ctx.fillText(stats.join('   ·   '), pad, pad + 272);

    /* Covers */
    let y = pad + 320;
    const coverW = 280, coverH = 400, gap = 28;
    const slots = covers.slice(0, 3);
    if (slots.length) {
      slots.forEach((c, i) => {
        const x = pad + i * (coverW + gap);
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,.28)';
        ctx.shadowBlur = 30;
        ctx.shadowOffsetY = 12;
        roundRect(ctx, x, y, coverW, coverH, 22);
        ctx.fillStyle = p.surface;
        ctx.fill();
        ctx.restore();
        ctx.save();
        roundRect(ctx, x, y, coverW, coverH, 22);
        ctx.clip();
        if (c.img && !options.noCovers) {
          const scale = Math.max(coverW / c.img.width, coverH / c.img.height);
          const dw = c.img.width * scale, dh = c.img.height * scale;
          ctx.drawImage(c.img, x + (coverW - dw) / 2, y + (coverH - dh) / 2, dw, dh);
        } else {
          ctx.fillStyle = p.surface;
          ctx.fillRect(x, y, coverW, coverH);
          ctx.fillStyle = p.faint;
          ctx.font = `800 72px ${FONT}`;
          ctx.textAlign = 'center';
          ctx.fillText(initials(c.title), x + coverW / 2, y + coverH / 2 + 26);
          ctx.textAlign = 'left';
        }
        ctx.restore();
        /* Chapter count pill on the cover */
        const label = c.chapters + ' ch';
        ctx.font = `800 22px ${FONT}`;
        const lw = ctx.measureText(label).width + 28;
        roundRect(ctx, x + 14, y + coverH - 52, lw, 38, 19);
        ctx.fillStyle = p.accent;
        ctx.fill();
        ctx.fillStyle = p.accentText;
        ctx.fillText(label, x + 28, y + coverH - 25);
      });
      y += coverH + 26;
      ctx.font = `600 26px ${FONT}`;
      ctx.fillStyle = p.muted;
      ctx.fillText(fitText(ctx, slots.map((c) => c.title).join('  ·  '), W - pad * 2), pad, y + 26);
      y += 70;
    } else {
      ctx.font = `600 30px ${FONT}`;
      ctx.fillStyle = p.faint;
      ctx.fillText(data.kind === 'year' ? 'No chapters this year yet.' : 'No chapters this month yet.', pad, y + 30);
      y += 90;
    }

    /* Year bars */
    if (data.kind === 'year' && data.months) {
      const max = Math.max(1, ...data.months.map((m) => m.chapters));
      const barW = (W - pad * 2 - 11 * 10) / 12;
      const baseY = y + 120;
      data.months.forEach((m, i) => {
        const h = Math.max(6, Math.round((m.chapters / max) * 100));
        const x = pad + i * (barW + 10);
        roundRect(ctx, x, baseY - h, barW, h, 6);
        ctx.fillStyle = m.chapters ? p.accent : p.surface;
        ctx.fill();
        ctx.fillStyle = p.faint;
        ctx.font = `700 18px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(monthLabel(m.month)[0], x + barW / 2, baseY + 28);
        ctx.textAlign = 'left';
      });
      y = baseY + 70;
    }

    /* Genres */
    if (data.genres.length) {
      ctx.font = `800 22px ${FONT}`;
      ctx.fillStyle = p.faint;
      ctx.letterSpacing = '3px';
      ctx.fillText('MOST READ', pad, y + 22);
      ctx.letterSpacing = '0px';
      let x = pad;
      ctx.font = `700 28px ${FONT}`;
      for (const g of data.genres) {
        const w = ctx.measureText(g).width + 44;
        roundRect(ctx, x, y + 44, w, 54, 27);
        ctx.fillStyle = p.accent + (p.dark ? '33' : '22');
        ctx.fill();
        ctx.fillStyle = p.text;
        ctx.fillText(g, x + 22, y + 81);
        x += w + 14;
      }
      y += 130;
    }

    /* Badge and Mori */
    ctx.font = `600 28px ${FONT}`;
    ctx.fillStyle = p.muted;
    const bits = [];
    if (data.badges.length) bits.push('Badge earned: ' + data.badges[0].title + (data.badges.length > 1 ? ' +' + (data.badges.length - 1) : ''));
    bits.push('Mori · ' + data.stage);
    ctx.fillText(fitText(ctx, bits.join('   ·   '), W - pad * 2), pad, Math.min(y + 28, H - 150));

    /* Footer */
    ctx.fillStyle = p.text;
    ctx.font = `800 40px ${FONT}`;
    ctx.fillText('Yomu', pad, H - pad);
    ctx.font = `500 22px ${FONT}`;
    ctx.fillStyle = p.faint;
    ctx.textAlign = 'right';
    ctx.fillText('Made on this device. Nothing left it.', W - pad, H - pad);
    ctx.textAlign = 'left';
  }

  /* --- assembling ------------------------------------------------------------ */

  function dataFor(kind, key) {
    const P = window.YomuProgress;
    const base = kind === 'year' ? P.year(key) : P.monthly(key);
    return {
      ...base,
      kind,
      genres: rankGenres(base.series, genresOf),
      covers: pickCovers(base.series, infoOf),
    };
  }

  async function render(canvas, kind, key, options = {}) {
    try { await document.fonts?.load?.(`800 100px ${FONT}`); } catch {}
    const data = dataFor(kind, key);
    const covers = await Promise.all(data.covers.map(async (c) => ({ ...c, img: options.noCovers ? null : await loadImage(relay(c.cover)) })));
    draw(canvas, data, covers, options);
    return data;
  }

  async function toBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  /* --- the You page ----------------------------------------------------------- */

  let pick = { kind: 'month', key: '' };
  let note = '';
  let rendering = false;

  const prevMonth = () => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  };
  const thisMonth = () => new Date().toISOString().slice(0, 7);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  async function paint() {
    const host = document.getElementById(HOST_ID);
    if (!host || !window.YomuProgress) return;
    if (!pick.key) pick.key = thisMonth();
    host.textContent = '';

    const tabs = el('div', 'ywr__tabs');
    tabs.setAttribute('role', 'tablist');
    const choices = [
      ['month', thisMonth(), 'This month'],
      ['month', prevMonth(), monthLabel(prevMonth())],
      ['year', thisMonth().slice(0, 4), 'This year'],
    ];
    for (const [kind, key, label] of choices) {
      const tab = el('button', 'ywr__tab', label);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      const on = pick.kind === kind && pick.key === key;
      tab.setAttribute('aria-selected', String(on));
      tab.addEventListener('click', () => { pick = { kind, key }; note = ''; paint(); });
      tabs.append(tab);
    }
    host.append(tabs);

    const frame = el('div', 'ywr__frame');
    const canvas = document.createElement('canvas');
    canvas.className = 'ywr__canvas';
    canvas.setAttribute('role', 'img');
    frame.append(canvas);
    host.append(frame);

    const acts = el('div', 'ywr__acts');
    const save = el('button', 'ywr__go', 'Save image');
    save.type = 'button';
    const share = el('button', 'ywr__quiet', 'Share');
    share.type = 'button';
    acts.append(save);
    if (navigator.share) acts.append(share);
    host.append(acts);
    const small = el('p', 'ysh-note', note || 'Drawn on this device from what you read. Hours are an estimate at seven minutes a chapter. Nothing is uploaded.');
    host.append(small);

    rendering = true;
    let data;
    try {
      data = await render(canvas, pick.kind, pick.key);
      canvas.setAttribute('aria-label', `${data.chapters} chapters, ${hours(data.chapters)}, ${data.days} days` + (data.genres.length ? ', mostly ' + data.genres.join(', ') : ''));
    } catch (error) {
      console.warn('[yomu] wrap:', error);
      small.textContent = 'The card could not be drawn here.';
    }
    rendering = false;

    const exportBlob = async () => {
      try { return await toBlob(canvas); }
      catch {
        /* Tainted: a cover came from somewhere the relay did not cover.
           Redraw with plates and export that. */
        await render(canvas, pick.kind, pick.key, { noCovers: true });
        return toBlob(canvas);
      }
    };
    const filename = () => 'yomu-' + (pick.kind === 'year' ? pick.key : pick.key) + '.png';

    save.addEventListener('click', async () => {
      const blob = await exportBlob();
      if (!blob) { note = 'Could not make the image.'; paint(); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename();
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      small.textContent = 'Saved. It is yours to post, or not.';
    });
    share.addEventListener('click', async () => {
      const blob = await exportBlob();
      if (!blob) return;
      const file = new File([blob], filename(), { type: 'image/png' });
      try {
        if (navigator.canShare && !navigator.canShare({ files: [file] })) throw new Error('files');
        await navigator.share({ files: [file], title: 'My ' + (pick.kind === 'year' ? pick.key : monthLabel(pick.key)) + ' in Yomu' });
      } catch {
        small.textContent = 'Sharing is not available here. Save the image instead.';
      }
    });
  }

  /* --- the monthly nudge ------------------------------------------------------ */

  function nudge() {
    const P = window.YomuProgress;
    if (!P || document.getElementById(HOST_ID)) return;
    const last = prevMonth();
    if (localStorage.getItem(SEEN_KEY) === last) return;
    const data = P.monthly(last);
    if (!data.chapters) { try { localStorage.setItem(SEEN_KEY, last); } catch {} return; }
    if (window.YomuPet?.surface?.() === 'reader' || document.hidden) return;
    try { localStorage.setItem(SEEN_KEY, last); } catch {}
    const root = el('div', 'ycap');
    root.id = NUDGE_ID;
    root.setAttribute('role', 'status');
    const head = el('div', 'ycap__head');
    head.append(el('span', 'ycap__kicker', 'Your ' + monthLabel(last) + ' wrap is ready'));
    head.append(el('strong', null, data.chapters + (data.chapters === 1 ? ' chapter' : ' chapters') + ' over ' + data.days + (data.days === 1 ? ' day' : ' days')));
    root.append(head);
    const acts = el('div', 'ycap__acts');
    const later = el('button', 'ycap__skip', 'Later');
    later.type = 'button';
    const go = el('a', 'ycap__keep', 'See it');
    go.href = '/you#wrap';
    acts.append(later, go);
    root.append(acts);
    const close = () => { root.classList.remove('is-on'); setTimeout(() => root.remove(), 200); };
    later.addEventListener('click', close);
    document.body.append(root);
    setTimeout(() => root.classList.add('is-on'), 20);
    setTimeout(close, 14000);
  }

  /* --- public shape ------------------------------------------------------ */

  const api = { hours, rankGenres, pickCovers, monthLabel, relay, render, dataFor, repaint: paint, MINUTES_PER_CHAPTER };
  if (typeof window !== 'undefined') window.YomuWrap = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { hours, rankGenres, pickCovers, monthLabel, MINUTES_PER_CHAPTER };

  if (browser) {
    const boot = () => {
      if (document.getElementById(HOST_ID)) {
        paint().then(() => {
          if (location.hash === '#wrap') document.getElementById('wrap')?.scrollIntoView({ block: 'start' });
        });
      } else setTimeout(nudge, 2500);
    };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
    else boot();
    addEventListener('yomu:progress', () => { if (document.getElementById(HOST_ID) && !rendering) paint(); });
    addEventListener('yomu:pet-surface', () => setTimeout(nudge, 1500));
  }
})();
