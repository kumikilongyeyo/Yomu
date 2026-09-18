/**
 * The reading race — where everyone in the circle is, on the chapter list.
 *
 * Built entirely from data the gate already holds. The server sends how
 * many members stand at each chapter (numbers, never who), the names of
 * members at or below your own mark, and -- when the owner has switched
 * the race on -- the week's leader, named only if you have reached where
 * they are. Nothing here can say more than that, because it was never
 * given more than that.
 *
 * Two lists get ticks: the series page's chapter rows and the reader's
 * chapters sheet. Both are React's and re-render freely, so ticks are
 * re-asserted from an observer and signed so an unchanged tick is left
 * alone rather than rebuilt at frame rate.
 */
(() => {
  'use strict';

  const TICK = 'yomu-race-tick';
  const BADGE_ID = 'yomu-race-badge';
  const LEADER_ID = 'yomu-race-leader';

  const browser = typeof document !== 'undefined';

  /* --- pure ------------------------------------------------------------------ */

  /** chapter -> how many members stand exactly there. */
  function countsOf(race) {
    const out = new Map();
    for (const mark of race?.marks || []) out.set(Number(mark.chapter), Number(mark.count) || 0);
    return out;
  }

  /** The words on a tick. `you` when the viewer stands here. */
  function tickText(count, isYou) {
    if (isYou) return count > 1 ? 'you +' + (count - 1) : 'you';
    return count === 1 ? '1 here' : count + ' here';
  }

  /** The one-line summary for the series page. */
  function summary(race) {
    if (!race) return '';
    const parts = [];
    if (race.ahead) parts.push(race.ahead + ' ahead');
    if (race.alongside) parts.push(race.alongside + ' with you');
    if (race.behind) parts.push(race.behind + ' behind');
    let text = parts.length ? parts.join(' · ') : (race.mine ? 'Only you so far' : '');
    if (race.on && race.leader) {
      const who = race.leader.isYou ? 'you' : (race.leader.name || 'someone ahead');
      text += (text ? ' · ' : '') + 'Leader this week: ' + who;
    }
    return text;
  }

  /* --- painting -------------------------------------------------------------- */

  function seriesKey() {
    if (!location.pathname.startsWith('/series/')) return '';
    let id = location.pathname.slice('/series/'.length);
    try { id = decodeURIComponent(id); } catch {}
    const source = new URLSearchParams(location.search).get('source') || '';
    return source && id ? source + ':' + id : '';
  }

  function readerKey() {
    if (!location.pathname.startsWith('/read/')) return '';
    let raw = location.pathname.slice('/read/'.length);
    try { raw = decodeURIComponent(raw); } catch {}
    const source = new URLSearchParams(location.search).get('source') || '';
    return source && raw ? source + ':' + raw.split(':')[0] : '';
  }

  function dataFor(key) {
    const C = window.YomuCircle;
    if (!C || !key) return null;
    const series = C.series?.();
    if (series && series.key === key) return series;
    const thread = C.thread?.();
    if (thread && thread.key && thread.key.startsWith(key + ':')) return thread;
    return null;
  }

  function paintRows(rows, numberOf, race) {
    const counts = countsOf(race);
    const known = new Map();
    for (const k of race?.known || []) {
      if (!known.has(k.chapter)) known.set(k.chapter, []);
      known.get(k.chapter).push(k.name);
    }
    for (const row of rows) {
      const n = numberOf(row);
      const count = counts.get(n) || 0;
      let tick = row.querySelector('.' + TICK);
      if (!count) { tick?.remove(); continue; }
      const isYou = n === race.mine;
      const text = tickText(count, isYou);
      const names = known.get(n) || [];
      const title = names.length ? names.join(', ') + (isYou ? ' and you' : '') : (isYou ? 'You are here' : count + ' of your circle');
      const sig = text + '|' + title;
      if (tick && tick.dataset.sig === sig) continue;
      if (!tick) {
        tick = document.createElement('span');
        tick.className = TICK;
        row.append(tick);
      }
      tick.classList.toggle('is-you', isYou);
      tick.textContent = text;
      tick.title = title;
      tick.setAttribute('aria-label', title);
      tick.dataset.sig = sig;
    }
  }

  function paintSeries() {
    const key = seriesKey();
    const data = key && dataFor(key);
    const rows = document.querySelectorAll('.chapter-line[data-chn]');
    if (!data || !data.race) {
      for (const t of document.querySelectorAll('.chapter-line .' + TICK)) t.remove();
      document.getElementById(BADGE_ID)?.remove();
      return;
    }
    paintRows(rows, (row) => Number(row.getAttribute('data-chn')), data.race);

    const line = document.querySelector('.section-line');
    const text = summary(data.race);
    let badge = document.getElementById(BADGE_ID);
    if (!line || !text) { badge?.remove(); return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.id = BADGE_ID;
      badge.className = 'yomu-race-badge';
    }
    if (badge.textContent !== text) badge.textContent = text;
    badge.classList.toggle('is-race', !!data.race.on);
    /* After the circle's own "N new" badge when it is there, else last. */
    const talk = document.getElementById('yomu-circle-badge');
    if (talk && talk.parentElement === line) { if (badge.previousElementSibling !== talk) talk.after(badge); }
    else if (badge.parentElement !== line) line.append(badge);
  }

  function paintReader() {
    const key = readerKey();
    const data = key && dataFor(key);
    const sheet = document.querySelector('.rd-sheet');
    if (!sheet || !data || !data.race) {
      for (const t of document.querySelectorAll('.rd-chapters .' + TICK)) t.remove();
      document.getElementById(LEADER_ID)?.remove();
      return;
    }
    const rows = sheet.querySelectorAll('.rd-chapters li');
    paintRows(rows, (row) => Number(row.querySelector('[data-n]')?.getAttribute('data-n')), data.race);

    const head = sheet.querySelector('.rd-sheet__head');
    let chip = document.getElementById(LEADER_ID);
    if (!head || !data.race.on || !data.race.leader) { chip?.remove(); return; }
    const who = data.race.leader.isYou ? 'You lead this week' : 'Leader this week: ' + (data.race.leader.name || 'someone ahead');
    if (!chip) {
      chip = document.createElement('span');
      chip.id = LEADER_ID;
      chip.className = 'yomu-race-leader';
    }
    if (chip.textContent !== who) chip.textContent = who;
    if (chip.parentElement !== head) head.append(chip);
  }

  const pass = () => { paintSeries(); paintReader(); };

  const api = { countsOf, tickText, summary, repaint: pass };
  if (typeof window !== 'undefined') window.YomuRace = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { countsOf, tickText, summary };

  if (browser) {
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', pass);
    else pass();
    new MutationObserver(pass).observe(document.documentElement, { childList: true, subtree: true });
    addEventListener('yomu:circle-series', pass);
    addEventListener('yomu:circle-thread', pass);
    for (const type of ['popstate', 'hashchange']) addEventListener(type, pass);
  }
})();
