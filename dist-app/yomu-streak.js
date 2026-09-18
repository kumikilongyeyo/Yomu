/**
 * Reading streaks, and what they do to Mori.
 *
 * The store has counted consecutive reading days since it shipped; nothing
 * showed the number and nothing reacted to it. This does both, and keeps the
 * one rule that makes a streak worth having in a reading app: it is never
 * punitive. A missed day resets the count, keeps the best, and Mori looks
 * sleepy rather than disappointed.
 *
 *   - a Streak card on Your Yomu: today, the best, the last seven days
 *   - moods: after two days away Mori dozes on Home; after four it is out
 *     cold, and it says one soft line about it, once per session
 *   - a confetti burst when a streak milestone pays (7, 30, 100 days)
 *
 * The streak itself comes from YomuProgress.streak(), which is the live
 * value -- the store's counter is only written on a read, so this file
 * never reads it directly.
 */
(() => {
  'use strict';

  const CARD_ID = 'yomu-streak';
  const browser = typeof document !== 'undefined';
  const reduced = () => browser && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  /** The last seven calendar days, oldest first, each with whether it had a chapter. */
  function week(readDays, todayIso) {
    const have = new Set(readDays || []);
    const out = [];
    const base = Date.parse((todayIso || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
    for (let back = 6; back >= 0; back--) {
      const d = new Date(base - back * 86400000);
      const iso = d.toISOString().slice(0, 10);
      out.push({ iso, letter: DAY_LETTERS[d.getUTCDay()], read: have.has(iso), today: back === 0 });
    }
    return out;
  }

  /** How sleepy Mori is for a given gap. 0 awake, 1 dozing, 2 out cold. */
  function mood(daysSince) {
    if (daysSince === null || daysSince === undefined) return 0;
    if (daysSince >= 4) return 2;
    if (daysSince >= 2) return 1;
    return 0;
  }

  /* --- the card ------------------------------------------------------------ */

  function paintCard() {
    const host = document.getElementById(CARD_ID);
    const P = window.YomuProgress;
    if (!host || !P || !P.streak) return;
    const s = P.streak();
    host.textContent = '';

    const card = document.createElement('div');
    card.className = 'ystk';

    const top = document.createElement('div');
    top.className = 'ystk__top';
    const big = document.createElement('div');
    big.className = 'ystk__big';
    const n = document.createElement('b');
    n.textContent = String(s.current);
    const label = document.createElement('span');
    label.textContent = s.current === 1 ? 'day streak' : 'day streak';
    big.append(n, label);
    const best = document.createElement('div');
    best.className = 'ystk__best';
    best.textContent = s.longest ? 'Best ' + s.longest : 'No streak yet';
    top.append(big, best);
    card.append(top);

    const strip = document.createElement('div');
    strip.className = 'ystk__week';
    strip.setAttribute('role', 'img');
    const days = week(s.readDays);
    strip.setAttribute('aria-label', 'Last seven days: ' + days.filter((d) => d.read).length + ' with a chapter');
    for (const day of days) {
      const dot = document.createElement('span');
      dot.className = 'ystk__day' + (day.read ? ' is-read' : '') + (day.today ? ' is-today' : '');
      dot.textContent = day.letter;
      dot.title = day.iso;
      strip.append(dot);
    }
    card.append(strip);

    const note = document.createElement('p');
    note.className = 'ystk__note';
    if (s.daysSince === null) note.textContent = 'Finish a chapter and the streak starts. One a day keeps it going.';
    else if (s.today) note.textContent = 'Today is in. Mori is pleased.';
    else if (s.daysSince === 1) note.textContent = 'Yesterday counts. Read something today to keep it.';
    else note.textContent = `${s.daysSince} days since the last chapter. The best stays; the count starts again with the next one.`;
    card.append(note);

    host.append(card);
  }

  /* --- moods --------------------------------------------------------------- *
   *
   * Sleeping and idle share a priority in the pet, so asking for sleep
   * replaces idle and is itself replaced by a tap or a celebration -- and
   * comes back afterwards, because the check runs on a slow tick. A hold
   * (celebrating, thinking) is left alone: the pet refuses lower states
   * during one, which is right.
   */

  let saidMissed = false;

  function applyMood() {
    const P = window.YomuProgress;
    const pet = window.YomuPet;
    if (!P || !pet || !pet.root) return;
    const root = pet.root();
    const level = mood(P.streak().daysSince);
    if (root) root.classList.toggle('is-drowsy', level === 2);
    if (!root || !level) return;
    const state = pet.state();
    if (state === 'idle') pet.setState('sleeping');
    if (!saidMissed && pet.policy().bubbles && pet.surface() !== 'reader') {
      const line = window.YomuGreetings?.line?.('missed', { days: P.streak().daysSince });
      if (line && pet.say(line, 4200)) saidMissed = true;
    }
  }

  /* --- confetti ------------------------------------------------------------ */

  function confetti(anchor) {
    if (reduced()) return;
    const root = document.createElement('div');
    root.className = 'ystk-confetti';
    root.setAttribute('aria-hidden', 'true');
    const box = anchor?.getBoundingClientRect?.();
    const x = box ? box.left + box.width / 2 : innerWidth / 2;
    const y = box ? box.top + box.height / 2 : innerHeight / 2;
    root.style.left = x + 'px';
    root.style.top = y + 'px';
    for (let i = 0; i < 26; i++) {
      const bit = document.createElement('i');
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

  /* --- public shape ------------------------------------------------------ */

  const api = { week, mood, confetti, repaint: paintCard };
  if (typeof window !== 'undefined') window.YomuStreak = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { week, mood };

  /* --- boot -------------------------------------------------------------- */

  if (browser) {
    const boot = () => { paintCard(); applyMood(); };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
    else boot();
    addEventListener('yomu:progress', boot);
    addEventListener('yomu:pet-surface', () => setTimeout(applyMood, 400));
    /* Slow: a mood is a standing condition, not an animation. */
    setInterval(applyMood, 20000);

    addEventListener('yomu:reward', (event) => {
      if (!/^streak-/.test(event.detail?.milestoneId || '')) return;
      confetti(document.getElementById('yomu-pet') || document.getElementById('yomu-pet-toast'));
    });
  }
})();
