/**
 * Streak and mileage on Your Yomu — the UI half.
 *
 * Reads the two engines in yomu-streak.js and writes DOM: the heat bar block
 * that replaced the seven pills, the mileage block with "close to earning",
 * two detail sheets, the toast queue, and the two small things the old
 * card owned -- Mori's sleepiness after days away, and confetti on a streak
 * milestone.
 *
 * The bar: the fill carries the whole ramp, sized against the track and
 * clipped to the reader's position, so the colours they have not reached
 * are not on screen. The flame at its head is the stage's own art, in the
 * mode's own colours, grown a little with every stage.
 */
(() => {
  'use strict';

  const STREAK_ID = 'yomu-streak';
  const MILEAGE_ID = 'yomu-mileage';
  const SHEET_ID = 'yomu-streak-sheet';
  const browser = typeof document !== 'undefined';
  const reduced = () => browser && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const S = () => window.YomuStreak;
  const M = () => window.YomuMileage;

  /* --- "it just went up" ---------------------------------------------------- *
   *
   * The bar's resting motion is CSS; the one-pass sheen and the brighter
   * leading edge are not, because they are about a change rather than a
   * state. Each bar remembers the width it was last painted at, and a repaint
   * that is wider wears .is-gain for the length of the pass.
   *
   * Keyed by a name rather than by node, because the card is rebuilt from
   * scratch on every paint -- the node that knew the old value is already
   * gone by the time the new one needs it.
   */
  const lastPct = new Map();

  function markGain(bar, key, pct) {
    const before = lastPct.get(key);
    lastPct.set(key, pct);
    if (before === undefined || pct <= before + 0.01 || reduced()) return;
    bar.classList.add('is-gain');
    setTimeout(() => bar.classList.remove('is-gain'), 1100);
  }
  const flameSrc = (stage, mode) => '/brand/flame/s' + (Math.min(6, Math.max(1, stage + 1))) + '-' + (mode === 'aurora' ? 'aurora' : 'paper') + '.svg';
  const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

  /* --- the streak block --------------------------------------------------------- */

  function paintStreak() {
    const host = document.getElementById(STREAK_ID);
    if (!host || !S()) return;
    const snap = S().get();
    host.textContent = '';

    const card = el('button', 'stk');
    card.type = 'button';
    card.setAttribute('aria-label', `${snap.current} day streak, ${snap.stageName}. ${snap.nextLabel}. Open details`);
    card.style.setProperty('--stk-ink', snap.ink);
    card.style.setProperty('--stk-chip', snap.chip);
    card.style.setProperty('--stk-pocket', snap.pocket);

    const top = el('div', 'stk__top');
    const flame = el('div', 'stk__flame' + (snap.current ? '' : ' is-out'));
    const img = el('img');
    img.alt = '';
    img.src = flameSrc(snap.stage, snap.mode);
    img.style.transform = `scale(${(0.7 + snap.stage * 0.06).toFixed(2)})`;
    flame.append(img);
    const num = el('div', 'stk__num');
    num.append(el('b', null, String(snap.current)), el('span', null, snap.current === 1 ? 'day streak' : 'day streak'));
    const pill = el('span', 'stk__pill', snap.stageName);
    top.append(flame, num, pill);
    card.append(top);

    const bar = el('div', 'stk__bar');
    const fill = el('div', 'stk__fill');
    const pct = Math.max(0, Math.min(100, snap.pct));
    if (pct >= 0.5) {
      fill.style.setProperty('--p', pct + '%');
      fill.style.setProperty('--ramp-size', (10000 / pct) + '%');
      bar.append(fill);
    }
    markGain(bar, 'streak', pct);
    for (let i = 1; i < 6; i++) {
      const tick = el('span', 'stk__tick');
      tick.style.left = ((i / 6) * 100) + '%';
      bar.append(tick);
    }
    if (pct >= 0.5) {
      const head = el('span', 'stk__head');
      head.style.setProperty('--p', pct + '%');
      const small = el('img');
      small.alt = '';
      small.src = flameSrc(snap.stage, snap.mode);
      head.append(small);
      bar.append(head);
    }
    card.append(bar);
    card.append(el('p', 'stk__next', snap.nextLabel));

    const week = el('div', 'stk__week');
    for (const day of snap.week) {
      const cell = el('div', 'stk__day is-' + day.state + (day.today ? ' is-today' : ''));
      cell.title = day.date + ' · ' + day.state;
      cell.append(el('span', 'stk__cell'), el('small', null, day.letter));
      week.append(cell);
    }
    card.append(week);

    const foot = el('div', 'stk__foot');
    foot.append(el('span', null, snap.best ? 'Best ' + snap.best : 'No streak yet'));
    const rest = el('span', 'stk__rest');
    rest.textContent = snap.restNights
      ? snap.restNights + (snap.restNights === 1 ? ' rest night held' : ' rest nights held')
      : 'A rest night every 7 days';
    foot.append(rest);
    card.append(foot);

    card.addEventListener('click', () => openStreakSheet(snap));
    host.append(card);
  }

  /* --- the mileage block -------------------------------------------------------- */

  function familyTitle(slug) {
    return window.YomuBadges?.families?.[slug]?.title || slug;
  }

  function paintMileage() {
    const host = document.getElementById(MILEAGE_ID);
    if (!host || !M() || !window.YomuBadges) return;
    const snap = M().get();
    host.textContent = '';
    const card = el('button', 'mlg');
    card.type = 'button';
    card.setAttribute('aria-label', 'Chapters by family. Open details');

    const leaders = Object.entries(snap.leading || {});
    if (leaders.length) {
      const lead = el('div', 'mlg__lead');
      for (const [cat, row] of leaders.sort()) {
        const chip = el('div', 'mlg__leader');
        chip.append(window.YomuBadges.el(row.family, Math.max(1, row.tier), { variant: row.tier ? 'micro' : 'locked', size: 28 }));
        const copy = el('div');
        copy.append(el('b', null, familyTitle(row.family)));
        copy.append(el('small', null, cat + ' · ' + row.count + ' ch' + (row.tier ? ' · Tier ' + ROMAN[row.tier - 1] : '')));
        chip.append(copy);
        lead.append(chip);
      }
      card.append(lead);
    }

    const close = M().closeToEarning(3);
    card.append(el('p', 'mlg__label', close.length ? 'Close to earning' : 'Mileage'));
    if (!close.length) {
      card.append(el('small', null, snap.total
        ? snap.total + ' chapters counted. Families appear once a title is known to AniList.'
        : 'Chapters read count toward a family badge. The first tier is ten.'));
    }
    for (const row of close) {
      const line = el('div', 'mlg__row');
      line.append((window.YomuShelf?.el || ((s, t, o) => window.YomuBadges.el(s, t, o)))(row.family + ':' + (row.tier + 1), { variant: 'locked', size: 40 }) || window.YomuBadges.el(row.family, row.tier + 1, { variant: 'locked', size: 40 }));
      const copy = el('div');
      copy.append(el('b', null, familyTitle(row.family) + ' ' + ROMAN[row.tier]));
      copy.append(el('small', null, row.count + ' of ' + row.nextAt + ' chapters'));
      const bar = el('div', 'mlg__bar');
      const fill = el('i');
      fill.style.setProperty('--p', row.pct + '%');
      bar.append(fill);
      markGain(bar, 'mlg:' + row.family, row.pct);
      copy.append(bar);
      line.append(copy, el('span', 'mlg__left', row.remaining + ' to go'));
      card.append(line);
    }
    card.addEventListener('click', openMileageSheet);
    host.append(card);
  }

  /* --- detail sheets -------------------------------------------------------------- */

  function sheet(title, sub) {
    closeSheet();
    const root = el('div', 'stk-sheet');
    root.id = SHEET_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    const scrim = el('button', 'stk-sheet__scrim');
    scrim.type = 'button';
    scrim.setAttribute('aria-label', 'Close');
    scrim.addEventListener('click', closeSheet);
    const panel = el('section', 'stk-sheet__panel');
    const head = el('div', 'stk-sheet__head');
    head.append(el('h2', null, title));
    if (sub) head.append(el('small', null, sub));
    const done = el('button', null, 'Done');
    done.type = 'button';
    done.addEventListener('click', closeSheet);
    head.append(done);
    panel.append(head);
    root.append(scrim, panel);
    document.body.append(root);
    setTimeout(() => root.classList.add('is-on'), 20);
    addEventListener('keydown', onKey);
    done.focus({ preventScroll: true });
    return panel;
  }
  function onKey(event) { if (event.key === 'Escape') closeSheet(); }
  function closeSheet() {
    removeEventListener('keydown', onKey);
    const root = document.getElementById(SHEET_ID);
    if (!root) return;
    root.classList.remove('is-on');
    setTimeout(() => root.remove(), 200);
  }

  function openStreakSheet(snap) {
    const panel = sheet('Your streak', snap.current + (snap.current === 1 ? ' day' : ' days') + ' · best ' + snap.best);
    panel.style.setProperty('--stk-ink', snap.ink);

    panel.append(el('p', 'mlg__label', 'Last four weeks'));
    const cal = el('div', 'stk-cal');
    const read = new Set(snap.days);
    const rest = new Set(snap.restUsed);
    const todayKey = S().dayKey();
    const dow = new Date(Date.parse(todayKey + 'T00:00:00Z')).getUTCDay();
    const start = new Date(Date.parse(todayKey + 'T00:00:00Z') - (dow + 21) * 86400000);
    for (let i = 0; i < 28; i++) {
      const key = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
      const cell = el('span', (read.has(key) ? 'is-read' : rest.has(key) ? 'is-rest' : '') + (key === todayKey ? ' is-today' : ''), String(Number(key.slice(8))));
      cell.title = key;
      cal.append(cell);
    }
    panel.append(cal);

    panel.append(el('p', 'mlg__label', 'Heat'));
    const stages = el('div', 'stk-stages');
    S().STAGES.forEach((stage, i) => {
      const row = el('div', i === snap.stage && snap.current ? 'is-here' : '');
      const dot = el('i');
      dot.style.background = stage[snap.mode];
      row.append(dot, el('span', null, stage.name), el('small', null, stage.to ? stage.from + '–' + stage.to + ' days' : stage.from + '+ days'));
      stages.append(row);
    });
    panel.append(stages);

    panel.append(el('p', 'stk-sheet__note',
      `A day ends at ${String(snap.dayStartHour).padStart(2, '0')}:00, so a chapter at 01:30 still counts for the evening before. `
      + 'Every seven days in a row earns a rest night, three held at most, spent for you on a missed day. Two never cover consecutive days: a token covers a gap, it does not replace the habit. '
      + `You hold ${snap.restNights}.`));
  }

  function openMileageSheet() {
    const snap = M().get();
    const panel = sheet('Mileage', snap.total + ' chapters counted');
    const rows = Object.entries(snap.byFamily || {}).sort((a, b) => b[1] - a[1]);
    if (!rows.length) panel.append(el('p', 'stk-sheet__note', 'Nothing attributed yet. A title AniList knows counts toward the family its tags name; the rest count toward the total.'));
    for (const [slug, count] of rows) {
      const p = M().progressIn(count);
      const line = el('div', 'mlg__row');
      line.append((window.YomuShelf?.el?.(slug + ':' + Math.max(1, p.tier), { variant: p.tier ? '' : 'locked', size: 40 })) || window.YomuBadges.el(slug, Math.max(1, p.tier), { variant: p.tier ? '' : 'locked', size: 40 }));
      const copy = el('div');
      copy.append(el('b', null, familyTitle(slug) + (p.tier ? ' ' + ROMAN[p.tier - 1] : '')));
      copy.append(el('small', null, count + ' chapters' + (p.nextAt ? ' · ' + p.remaining + ' to Tier ' + ROMAN[p.tier] : ' · top tier')));
      const bar = el('div', 'mlg__bar');
      const fill = el('i');
      fill.style.setProperty('--p', p.pct + '%');
      bar.append(fill);
      copy.append(bar);
      line.append(copy, el('span', 'mlg__left', p.nextAt ? String(p.nextAt) : '★'));
      panel.append(line);
    }
    const cats = Object.entries(snap.byCategory || {}).filter(([, n]) => n).map(([c, n]) => c + ' ' + n).join(' · ');
    if (cats) panel.append(el('p', 'stk-sheet__note', cats));
    panel.append(el('p', 'stk-sheet__note', 'Tiers at 10, 40, 100, 250 and 500 chapters in a family. Counted from what you have finished, and rebuilt from scratch any time, so it is always right.'));
  }

  /* --- toasts ---------------------------------------------------------------------- *
   * One at a time, four seconds each, badge tier before streak stage when both
   * arrive together. Nothing on a merge: a paired device catching up is not
   * an achievement. */

  const queue = [];
  let showing = false;
  let quietUntil = 0;

  function toast(item) {
    if (Date.now() < quietUntil) return;
    queue.push(item);
    queue.sort((a, b) => (a.kind === 'badge' ? 0 : 1) - (b.kind === 'badge' ? 0 : 1));
    drain();
  }

  function drain() {
    if (showing || !queue.length) return;
    const item = queue.shift();
    showing = true;
    const node = el('div', 'stk-toast');
    node.setAttribute('role', 'status');
    if (item.kind === 'badge' && window.YomuBadges) node.append(window.YomuShelf?.el?.(item.family + ':' + item.to, { size: 48 }) || window.YomuBadges.el(item.family, item.to, { size: 48 }));
    else if (item.kind === 'stage') { const img = el('img'); img.alt = ''; img.src = flameSrc(item.to, S().get().mode); node.append(img); }
    const copy = el('div');
    copy.append(el('span', 'stk-toast__kicker', item.kind === 'badge' ? 'Tier ' + ROMAN[item.to - 1] : 'Streak'));
    copy.append(document.createTextNode(item.kind === 'badge'
      ? familyTitle(item.family) + ' · ' + item.count + ' chapters'
      : item.name + ' · ' + item.days + (item.days === 1 ? ' day' : ' days')));
    node.append(copy);
    const close = () => { node.classList.remove('is-on'); setTimeout(() => { node.remove(); showing = false; drain(); }, reduced() ? 130 : 320); };
    node.addEventListener('click', close);
    document.body.append(node);
    setTimeout(() => node.classList.add('is-on'), 20);
    setTimeout(close, 4000);
  }

  /* --- Mori's mood and the confetti ------------------------------------------------ */

  let saidMissed = false;
  function applyMood() {
    const pet = window.YomuPet;
    if (!S() || !pet || !pet.root) return;
    const since = S().get().daysSince;
    const level = since === null ? 0 : since >= 4 ? 2 : since >= 2 ? 1 : 0;
    const root = pet.root();
    if (root) root.classList.toggle('is-drowsy', level === 2);
    if (!root || !level) return;
    if (pet.state() === 'idle') pet.setState('sleeping');
    if (!saidMissed && pet.policy().bubbles && pet.surface() !== 'reader') {
      const line = window.YomuGreetings?.line?.('missed', { days: since });
      if (line && pet.say(line, 4200)) saidMissed = true;
    }
  }

  function confetti(anchor) {
    if (reduced()) return;
    const root = el('div', 'ystk-confetti');
    root.setAttribute('aria-hidden', 'true');
    const box = anchor?.getBoundingClientRect?.();
    root.style.left = (box ? box.left + box.width / 2 : innerWidth / 2) + 'px';
    root.style.top = (box ? box.top + box.height / 2 : innerHeight / 2) + 'px';
    for (let i = 0; i < 26; i++) {
      const bit = el('i');
      const angle = (Math.PI * 2 * i) / 26 + (Math.random() - 0.5) * 0.4;
      const distance = 70 + Math.random() * 90;
      bit.style.setProperty('--dx', Math.cos(angle) * distance + 'px');
      bit.style.setProperty('--dy', Math.sin(angle) * distance - 40 + 'px');
      bit.style.setProperty('--r', Math.round(Math.random() * 720 - 360) + 'deg');
      bit.style.setProperty('--d', (900 + Math.random() * 500) + 'ms');
      bit.style.setProperty('--h', Math.round(Math.random() * 360));
      root.append(bit);
    }
    document.body.append(root);
    setTimeout(() => root.remove(), 1700);
  }

  /* --- boot --------------------------------------------------------------------------- */

  /* `confetti` is public so the chapter-end card can use the one burst this
     app already draws rather than shipping a second particle library for
     the same half second. */
  const api = { repaint() { paintStreak(); paintMileage(); }, toast, confetti, openStreakSheet: () => openStreakSheet(S().get()), openMileageSheet };
  if (typeof window !== 'undefined') window.YomuStreakUI = api;

  if (browser) {
    const paint = () => { paintStreak(); paintMileage(); };
    const boot = () => { paint(); applyMood(); if (S()) S().subscribe(paint); if (M()) M().subscribe(paint); };
    /* A looping animation on a tab nobody is looking at is pure battery. The
       browser throttles it, but not reliably on every engine, and the flag is
       one attribute the stylesheet can switch the whole set off with. */
    const away = () => document.documentElement.toggleAttribute('data-yomu-away', document.hidden);
    away();
    addEventListener('visibilitychange', away);

    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
    else boot();
    addEventListener('yomu:progress', paint);
    addEventListener('yomu:streak-merged', () => { quietUntil = Date.now() + 5000; paint(); });
    addEventListener('yomu:streak-stage', (e) => { toast({ kind: 'stage', ...e.detail }); paint(); });
    addEventListener('yomu:badge-tier', (e) => { toast({ kind: 'badge', ...e.detail }); paint(); });
    addEventListener('yomu:reward', (e) => {
      if (/^streak-/.test(e.detail?.milestoneId || '')) confetti(document.getElementById('yomu-pet') || document.getElementById('yomu-pet-toast'));
    });
    addEventListener('yomu:pet-surface', () => setTimeout(applyMood, 400));
    setInterval(applyMood, 20000);
    /* Mode switch: the flame art and colours change with it. */
    new MutationObserver((records) => {
      if (records.some((r) => r.attributeName === 'data-mode')) paint();
    }).observe(document.documentElement, { attributes: true });
  }
})();
