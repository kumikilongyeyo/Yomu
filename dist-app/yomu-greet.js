/**
 * What Mori says.
 *
 * This file used to pick greetings itself, and that was a mistake worth
 * recording: `yomu-shell.js` has done it since the corpus shipped. It owns
 * `timeBucket` (with the wrap past midnight, so 02:00 is late night and not
 * morning), `readerGenres` (which gates the 293 cultivation/system/tower/
 * regression lines on what is actually in the library), a cold-start rule
 * that keeps a sarcastic line off somebody's first morning, and a blend of
 * pack lines with personal ones that remember what you were reading. A
 * second picker beside that one does not make Mori more talkative, it makes
 * the masthead and the pet disagree in front of the reader.
 *
 * So the greeting comes from the shell, through `window.YomuShell.greeting`.
 * What is left here is the part the shell has no reason to own:
 *
 *   - the lines for events the corpus has none of: a tap, a finished
 *     chapter, a milestone, a source going bad
 *   - addressing the reader by an earned badge title now and then
 *   - the rate limit and the "do not say it twice" rule
 *   - deciding when Mori speaks at all
 *
 * The corpus itself is greetings only -- it has no chapter or milestone line,
 * and it does not contain the one line the design asks for by name -- which
 * is why POOLS exists and is deliberately small.
 */
(() => {
  'use strict';

  const AT_KEY = 'yomu.v1.pet.lastGreetingAt';
  const TEXT_KEY = 'yomu.v1.pet.lastGreetingText';
  const SETTINGS_KEY = 'yomu.v1.pet.voice';
  const CIRCLE_KEY = 'yomu.v1.circle';

  const COOLDOWN = 30 * 60000;
  /* Away this long and coming back is an event worth acknowledging. Below
     it, a tab switch is not a return. */
  const AWAY = 30 * 60000;

  const readJSON = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  const settings = () => ({
    nicknames: true,
    /** rare | normal | often -- how often a badge title is used as a name. */
    frequency: 'normal',
    ...(readJSON(SETTINGS_KEY, {}) || {}),
  });

  const FREQUENCY = { rare: 0.15, normal: 0.4, often: 0.75 };

  /* --- the address ------------------------------------------------------- *
   *
   * The corpus bakes a name into each line ("Good morning, Junior."), 34
   * different ones. Some are genre nicknames, some are generic, and eight
   * are generation artifacts where the address slot got a UI noun --
   * "Moonlit hours, Your queue." is not a sentence. The address is parsed
   * back out so it can be replaced by the reader's own name or their earned
   * title. The shell shows these lines as written; Mori, which is addressing
   * someone directly, does not have to.
   */

  const GENERIC = new Set([
    'Reader', 'Friend', 'Bookworm', 'Bestie', 'Night owl', 'Chapter buddy',
    'Reading pal', 'Panel enjoyer', 'Tiny legend', 'Chapter goblin', 'You',
    'There', 'Hey', 'Welcome', 'Welcome back', 'Arc traveler',
  ]);

  const ARTIFACT = new Set([
    'Library', 'Browse', 'Your queue', 'Recent reads', 'Saved titles',
    'Reading list', 'Next chapter', 'Reading time',
  ]);

  /** Two shapes: "Good morning, Junior. ..." and "Junior: ...". */
  function parse(text) {
    let match = /^([^,:]+,\s*)([A-Z][a-z]+(?: [a-z]+)?)(\.\s*)/.exec(text);
    if (match) {
      return { head: match[1], address: match[2], tail: text.slice(match[0].length), join: match[3] };
    }
    match = /^([A-Z][a-z]+(?: [a-z]+)?)(:\s*)/.exec(text);
    if (match) {
      return { head: '', address: match[1], tail: text.slice(match[0].length), join: match[2] };
    }
    return null;
  }

  function render(text, name) {
    const parts = parse(text);
    if (!parts || !name) return text;
    /* Keep the line's own punctuation: "Morning, X." and "X: ..." are
       different rhythms and swapping one for the other reads as a bug. */
    return parts.head + name + parts.join + parts.tail;
  }

  /* --- who the reader is -------------------------------------------------- */

  /** Shared with the circle rather than stored twice. */
  const displayName = () => {
    const raw = readJSON(CIRCLE_KEY, {})?.name;
    return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 24) : '';
  };

  /** The equipped badge's reader-facing title, e.g. "Tower Climber". */
  function badgeTitle() {
    const equipped = window.YomuProgress?.get?.().equippedBadgeId || '';
    const slug = equipped.split(':')[0];
    if (!slug) return '';
    return window.YomuBadges?.list?.().find((f) => f.slug === slug)?.title || '';
  }

  /**
   * The name to address the reader by, or '' to leave the line as written.
   *
   * A title is recognition and stops being recognition if it is used every
   * time, so it appears at the configured frequency and the reader's own
   * name the rest of the time.
   */
  function chooseName() {
    const config = settings();
    const own = displayName();
    if (!config.nicknames) return own;
    const title = badgeTitle();
    if (title && Math.random() < (FREQUENCY[config.frequency] ?? 0.4)) return title;
    return own;
  }

  /* --- the pools the corpus does not cover -------------------------------- */

  const POOLS = {
    welcome_back: [
      'You came back. I kept your page.',
      'Back already? Your page is where you left it.',
      'There you are. Nothing moved.',
    ],
    tap: [
      'Still here.',
      'Reading or browsing?',
      'Go on, one more chapter.',
      'I was watching the shelf.',
    ],
    chapter_complete: [
      'Chapter down.',
      'That is one more.',
      'Onwards.',
    ],
    milestone: [
      '{title}. That is a real number.',
      '{title} — earned, not handed over.',
      'Look at that. {title}.',
    ],
    source_warning: [
      'That source is being slow. I can try another.',
      'This one is struggling. There are others.',
    ],
    /* The egg opening at fifty chapters. Said once, ever. */
    hatch: [
      'Oh. Hello. Was that me in there?',
      'Fifty chapters and here I am. Good shelf.',
      'Hatched. Now show me what you were reading.',
    ],
    /* Days without a chapter. {days} is how many. Never a scold. */
    missed: [
      '{days} days. I kept your page warm.',
      'You were gone {days} days. Nothing moved.',
      '{days} days off. The shelf is patient.',
    ],
    /* A saved title on Home just grew a chapter. {title} is its name. */
    fresh: [
      '{title} has a new one.',
      'New chapter of {title}. Just saying.',
      '{title} moved. Thought you would want to know.',
    ],
    /* Chapters in one sitting. {count} is how many. */
    binge: [
      'Chapter {count} in a row. Mori suggests water.',
      '{count} in a row. The cliffhangers are winning.',
      'That is {count} straight. Blink occasionally.',
      '{count} chapters this sitting. Respect.',
    ],
    binge_late: [
      'Chapter {count} in a row, and it is late. Mori is not judging. Much.',
      '{count} straight, past everyone\'s bedtime. Bold.',
      '{count} in a row at this hour. One more is fine. Probably.',
    ],
    /* The reader is within a few chapters of a milestone and has just
       finished one. {left} is how many are left, {title} is what is waiting.
       Said in the reader, under the mileage bar, so it never repeats the
       number the bar is already showing. */
    near_milestone: [
      'Close now. {left} to go.',
      '{left} more and {title} is yours.',
      'Almost. {title} is {left} away.',
      'That is nearly it. {left} left.',
    ],
    /* The same, for a family tier rather than a chapter count. {family} is
       the family's name, {left} how many chapters short it is. */
    near_tier: [
      '{left} more of these and {family} moves up.',
      'You are {left} off {family}.',
      '{family} is watching. {left} to go.',
    ],
    /* A stage change. {stage} is the new stage's name. */
    evolve: [
      'I feel taller. New form, same shelf.',
      '{stage} now. Keep turning pages.',
      'That is a new me. You did that.',
      'Look at me. A {stage}. Do not stop now.',
    ],
  };

  const fromPool = (type, vars) => {
    const pool = POOLS[type];
    if (!pool || !pool.length) return null;
    let text = pool[Math.floor(Math.random() * pool.length)];
    for (const [key, value] of Object.entries(vars || {})) {
      text = text.replaceAll('{' + key + '}', String(value));
    }
    return text;
  };

  /* --- the public call ---------------------------------------------------- */

  /**
   * @returns the line, or null when Mori should stay quiet. Null is a real
   *   answer -- muted, on cooldown, or in the reader -- and callers must not
   *   fall back to a hardcoded string when they get it.
   */
  function line(type, options) {
    const opts = options || {};
    if (window.YomuPet?.prefs?.().muted) return null;

    if (type === 'greeting' || type === 'welcome_back') {
      /* The reader is not a place to be greeted. Nothing about arriving at a
         chapter is worth a sentence over the top of it. */
      if (window.YomuPet?.surface?.() === 'reader') return null;
      if (!window.YomuPet?.policy?.().greet) return null;

      if (Date.now() - Number(localStorage.getItem(AT_KEY) || 0) < COOLDOWN) return null;

      /* A welcome-back is Mori's own line; a cold open borrows the shell's,
         so the pet and the masthead agree. If the shell is not there --
         a page that loads the pet without it -- there is simply no greeting,
         rather than a second picker kept alive for that case. */
      const base = type === 'welcome_back'
        ? fromPool('welcome_back')
        : (window.YomuShell?.greeting?.() || null);
      if (!base) return null;

      const text = render(base, chooseName());
      /* Not the same sentence twice running, whichever surface said it. */
      if (text === localStorage.getItem(TEXT_KEY)) return null;

      /* The cooldown is NOT spent here. Choosing a line and showing one are
         different events, and on a cold open they were half a second apart:
         the greeting was picked before the pet had mounted, the bubble was
         dropped for want of somewhere to put it, and the next half hour was
         already gone. Whoever gets it on screen calls commit. */
      if (opts.commit !== false) commit(text);
      return text;
    }

    return fromPool(type, opts);
  }

  /** Spend the cooldown. Only correct once the line has been displayed. */
  function commit(text) {
    try {
      localStorage.setItem(AT_KEY, String(Date.now()));
      localStorage.setItem(TEXT_KEY, text);
    } catch {}
  }

  const api = {
    line,
    commit,
    settings,
    setSettings: (patch) => writeJSON(SETTINGS_KEY, { ...settings(), ...patch }),
    /** Test seams: the deterministic parts, exposed rather than reimplemented. */
    __parse: parse,
    __render: render,
  };

  if (typeof window !== 'undefined') window.YomuGreetings = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parse, render, GENERIC, ARTIFACT, POOLS, FREQUENCY };
  }

  /* --- when to speak ------------------------------------------------------ */

  if (typeof document !== 'undefined') {
    let hiddenAt = 0;

    /**
     * Choose, show, and only then spend the cooldown.
     *
     * Waits for the pet, because on a cold open the greeting is ready before
     * the overlay is. Bounded: if Mori never mounts -- switched off, or this
     * is the reader -- it gives up without having spent anything.
     */
    const speak = (type, tries = 0) => {
      if (!document.getElementById('yomu-pet')) {
        if (tries >= 12) return;
        setTimeout(() => speak(type, tries + 1), 250);
        return;
      }
      const text = line(type, { commit: false });
      if (!text) return;
      window.YomuPet?.setState?.('greeting', 2200);

      /* The masthead is already showing the shell's greeting on Home, and
         two greetings on one screen is one too many. Mori still waves --
         that is the companion noticing you -- but says it out loud only
         where the header is not already saying it. */
      if (type === 'greeting' && window.YomuShell?.greetingOnScreen?.()) {
        commit(text);
        return;
      }
      if (window.YomuPet?.say?.(text, 4600)) commit(text);
    };

    addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt >= AWAY) speak('welcome_back');
      hiddenAt = 0;
    });

    /* Deferred a beat so the pet has mounted, the shell has chosen its line
       and the progression store has answered which gates are open. */
    const open = () => setTimeout(() => speak('greeting'), 900);
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', open);
    else open();
  }
})();
