/**
 * Changes to the built web app that belong in its Expo source.
 *
 * dist-app/ is Expo build output and the Expo project that produced it was
 * never handed over, so these are applied to the bundle. Every edit is anchored
 * to an exact string that must appear exactly once; if a future `expo export`
 * changes the minified names, this fails loudly naming the anchor that moved
 * rather than silently doing nothing. Re-run it after any rebuild:
 *
 *   node tools/patch-bundle.mjs            # apply
 *   node tools/patch-bundle.mjs --check    # verify, change nothing (exit 1 if not applied)
 *
 * Idempotent: applying twice is a no-op.
 *
 * It also links dist-app/yomu-overrides.css into every page. That cannot be done
 * from the Worker: Wrangler's asset server answers a matching path itself and
 * never invokes the Worker, so an HTMLRewriter there would never run.
 *
 * When the Expo source turns up, every edit here should move into it and this
 * script should be deleted. Each one records where it belongs.
 */
import fs from 'node:fs';
import path from 'node:path';

const BUNDLE_DIR = 'dist-app/_expo/static/js/web';
const check = process.argv.includes('--check');

const EDITS = [
  /* --- reader chrome — app/read/[chapterId].web.tsx -------------------- */
  {
    name: 'reader: idle timeout 3s -> 2s',
    why:
      'The reader hid its chrome after 3 seconds. Two reads better on a phone, ' +
      'where the bars cover the page you are trying to read.',
    from: 'x=768,j=3e3,b=e=>',
    to:   'x=768,j=2e3,b=e=>',
  },
  {
    name: 'reader: scrolling no longer wakes the chrome',
    why:
      'The reader root had onPointerMove and onPointerDown both calling show(). ' +
      'On a touch screen a scroll is a stream of pointermove events, so the bars ' +
      'reappeared the moment you started reading. Pointer movement still wakes ' +
      'them for a mouse, where there is no other idle signal; touch is left to ' +
      'the tap handler, which already toggles them deliberately.',
    from: 'onPointerMove:Y,onPointerDown:Y',
    to:   "onPointerMove:e=>{e.pointerType==='mouse'&&Y()}",
  },
  {
    name: 'reader: double tap toggles the chrome, and leaves immersive first',
    why:
      'Originally `onTap:()=>Z?F(!1):Y()` -- a single tap toggled the bars, so ' +
      'any tap while reading flashed them up. An earlier pass made it two taps ' +
      'within 320ms, the same window the native reader uses, and that form is ' +
      'what the shipped bundle contains; it is the anchor below.\n' +
      'Now that the shell can also take the reader fullscreen, the same double ' +
      'tap has to be the way back out, or the only exit is a gesture the OS ' +
      'owns. The shell installs __yomuExit and returns true when it actually ' +
      'left something; the bar toggle is what happens when there was nothing to ' +
      'leave. Kept as one edit rather than two so that re-running the script ' +
      'sees exactly one anchor, applied or not.',
    from:
      'onTap:()=>{const t=Date.now();' +
      'if(t-(globalThis.__yomuTap??0)<320){globalThis.__yomuTap=0;Z?F(!1):Y()}' +
      'else globalThis.__yomuTap=t}',
    to:
      'onTap:()=>{const t=Date.now();' +
      'if(t-(globalThis.__yomuTap??0)<320){globalThis.__yomuTap=0;' +
      'globalThis.__yomuExit?.()?Y():Z?F(!1):Y()}' +
      'else globalThis.__yomuTap=t}',
  },

  {
    name: 'reader: pages sit flush in scroll mode',
    why:
      'buildLayout was given an 8px gap between every page. The scroll surface ' +
      'behind it is #0b0b0e, so on a webtoon -- where consecutive pages are ' +
      'slices of one continuous drawing -- that gap reads as a black bar cutting ' +
      'through the art. Page mode keeps the gap, because there the pages really ' +
      'are separate sheets and the seam is what tells them apart.',
    from: '(0,n.buildLayout)(h,j,P,s),[h,j,P])',
    to:   "(0,n.buildLayout)(h,j,P,'page'===w?s:0),[h,j,P,w])",
  },
  {
    name: 'reader: chapter rows carry their chapter id',
    why:
      'The chapter sheet lists rows whose id only exists inside the closure, so ' +
      'nothing outside React can tell which row is read and which is the one ' +
      'you are on. Exposing the id and number as attributes is the whole edit; ' +
      'the thumbnail and the read state are drawn by the shell, which is where ' +
      'the progress keys are already understood.',
    from:
      '(0,o.jsxs)("button",{"aria-current":e.id===v,onClick:()=>{se(e.id)},' +
      'children:[(0,o.jsxs)("strong",{children:["Chapter ",e.number]})',
    to:
      '(0,o.jsxs)("button",{"aria-current":e.id===v,"data-ch":e.id,"data-n":e.number,' +
      'onClick:()=>{se(e.id)},' +
      'children:[(0,o.jsxs)("strong",{children:["Chapter ",e.number]})',
  },

  {
    name: 'tiles: cover tiles carry their series id',
    why:
      'A tile prints a title and a source label and nothing a lookup can key ' +
      'on, so nothing outside React can tell that the title under the cursor is ' +
      'one you are part-way through. This is the same one-attribute edit as the ' +
      'chapter rows, and it is what lets the shell put "Chapter 41" back on a ' +
      'title you find again through search.',
    from: 'return(0,t.jsxs)("div",{className:"tile-card",children:[',
    to:   'return(0,t.jsxs)("div",{className:"tile-card","data-series":n.id,children:[',
  },

  {
    name: 'series: chapter rows carry their chapter number',
    why:
      'Same one-attribute edit as the reader\'s chapter sheet and the cover ' +
      'tiles. The circle keys its comments by chapter number, and the series ' +
      'list prints that number only inside a string ("Chapter 41") that would ' +
      'have to be parsed back out -- and parsed wrongly the moment a source ' +
      'names a chapter something else.',
    from: 'return(0,x.jsxs)("div",{className:"chapter-line"+(t?\' is-read\':\'\'),children:[',
    to:   'return(0,x.jsxs)("div",{className:"chapter-line"+(t?\' is-read\':\'\'),"data-chn":e.number,children:[',
  },

  {
    name: 'reader: the chrome can be held open from outside',
    why:
      'The bars fade after two seconds, which is right while you are reading ' +
      'and wrong the moment you reach the foot of a chapter -- that is exactly ' +
      'when you want the next-chapter control, and double tapping to summon it ' +
      'is a step for something the reader already knows you need.\n' +
      'Y() shows them and re-arms the hide; this exposes a variant that shows ' +
      'them and cancels it, so the shell can hold the bar open at the end of a ' +
      'chapter until you do something.',
    // Anchored through the effect that follows, so the patched text no longer
    // matches -- see the guard below for why that matters.
    from:
      'const X=(0,e.useRef)(null),Y=(0,e.useCallback)(()=>{F(!0),' +
      'X.current&&clearTimeout(X.current),X.current=setTimeout(()=>F(!1),j)},[]);' +
      '(0,e.useEffect)(()=>(Y(),',
    to:
      'const X=(0,e.useRef)(null),Y=(0,e.useCallback)(()=>{F(!0),' +
      'X.current&&clearTimeout(X.current),X.current=setTimeout(()=>F(!1),j)},[]);' +
      '(0,e.useEffect)(()=>{globalThis.__yomuHoldChrome=()=>{' +
      'X.current&&clearTimeout(X.current),F(!0)};' +
      'return()=>{delete globalThis.__yomuHoldChrome}});' +
      '(0,e.useEffect)(()=>(Y(),',
  },

  /* --- home — app/index.web.tsx --------------------------------------- */
  {
    name: 'home: the app\'s own Continue card yields to the shell\'s row',
    why:
      'The built-in card reads its resume state only for titles in the ' +
      'discovery feed -- readResume is mapped over the feed, never over ' +
      'listSeriesWithProgress -- so the title you were actually reading shows ' +
      'up only if a source happens to return it in its first 18. That is why ' +
      'Continue Reading kept vanishing. The shell builds the row from stored ' +
      'progress instead, and this guard stops the two stacking. Left as a ' +
      'fallback rather than deleted: if the shell fails to load, the old card ' +
      'still appears on the days it can.',
    from: 'Se&&Ce?(0,p.jsxs)(p.Fragment,',
    to:   'Se&&Ce&&!globalThis.__yomuContinue?(0,p.jsxs)(p.Fragment,',
  },
  {
    name: 'home: drop the duplicated genre chips',
    why:
      'The genre row printed Reincarnation and Martial arts twice -- once as a ' +
      'MangaDex genre and again as an AniList tag, identical labels, different ' +
      'filters. Eleven chips over three wrapped rows, two of them decoys. The ' +
      'MangaDex six stay (nothing else reaches them; More tags only offers ' +
      'AniList tags); the two duplicates go.',
    from:
      "N=[{tag:'Cultivation',label:'Cultivation'},{tag:'Wuxia',label:'Wuxia'}," +
      "{tag:'Reincarnation',label:'Reincarnation'},{tag:'Martial Arts',label:'Martial arts'}]",
    to: "N=[{tag:'Cultivation',label:'Cultivation'},{tag:'Wuxia',label:'Wuxia'}]",
  },

  {
    name: 'home: the grid is filtered and ordered by the shell',
    why:
      'Two problems in one expression. The default view leads with M, the ' +
      'most recently updated titles across every source -- which is a ' +
      'firehose, so the first thing on the page was whatever some site ' +
      'touched in the last hour rather than anything worth reading. And ' +
      'nothing filtered the feed at all, so one-chapter entries with no ' +
      'cover sat beside real series.\n' +
      'Both are judgement calls about what to show, which is the kind of ' +
      'thing that should be readable. So the array is handed to the shell, ' +
      'which decides; with the shell absent the old behaviour is exactly ' +
      'what happens.',
    from:
      'return[...M.map(({summary:e,sourceId:s,sourceLabel:a})=>' +
      '({summary:e,sourceId:s,sourceLabel:a})),' +
      '...e.filter(e=>!s.has(`${e.sourceId}:${e.summary.id}`))]},[ce,M,E,z,U,W])',
    to:
      'const _g=[...M.map(({summary:e,sourceId:s,sourceLabel:a})=>' +
      '({summary:e,sourceId:s,sourceLabel:a})),' +
      '...e.filter(e=>!s.has(`${e.sourceId}:${e.summary.id}`))];' +
      'return globalThis.__yomuGrid?globalThis.__yomuGrid(_g,e):_g},[ce,M,E,z,U,W])',
  },
  {
    name: 'home: a refresh control, and a handle for pull to refresh',
    why:
      'There was no way to ask for a different set of recommendations short ' +
      'of reloading the page. The reset-and-refetch the mount effect already ' +
      'runs is exactly the right action; it just had no button. Exposed as a ' +
      'global as well, so the shell can drive it from a pull gesture without ' +
      'needing a second copy of the sequence.',
    // Anchored through to the next statement so the patched form no longer
    // matches: a `to` that starts with its own `from` reapplies for ever.
    from:
      '(0,e.useEffect)(()=>{oe([]),he(0),fe(0,!0).catch(e=>F(e.message))},[pe]);' +
      'const xe=(0,e.useMemo)',
    to:
      '(0,e.useEffect)(()=>{oe([]),he(0),fe(0,!0).catch(e=>F(e.message))},[pe]);' +
      '(0,e.useEffect)(()=>{globalThis.__yomuReload=()=>{oe([]),he(0),' +
      'fe(0,!0).catch(e=>F(e.message))};return()=>{delete globalThis.__yomuReload}});' +
      'const xe=(0,e.useMemo)',
  },
  {
    name: 'home: the refresh button itself',
    why:
      'Beside the heading it belongs to, so it reads as "another of these" ' +
      'rather than as a page-level control.',
    // Same trap, same fix: the anchor runs into the segment row that follows,
    // so the button cannot be inserted twice.
    from:
      '(0,p.jsx)("h2",{children:"Find your next obsession"}),' +
      '(0,p.jsx)("div",{className:"m-seg"',
    to:
      '(0,p.jsx)("h2",{children:"Find your next obsession"}),' +
      '(0,p.jsx)("button",{className:"home-reload","aria-label":"Show different titles",' +
      'title:"Show different titles",onClick:()=>{oe([]),he(0),' +
      'fe(0,!0).catch(e=>F(e.message))},children:"\\u21bb"}),' +
      '(0,p.jsx)("div",{className:"m-seg"',
  },

  /* --- search entry points — app/_layout.tsx, index.web.tsx, library.web.tsx ---
   *
   * The compiled search screen groups results by source, so one work carried by
   * six sites reads as six results. /find.html renders one row per title with
   * its sources underneath, using the catalog's already-merged answer. These
   * three edits are every route into the old screen; they are separate because
   * each screen navigates its own way.
   */
  {
    name: 'nav: Discover tab opens the merged search page',
    why: 'The dock replaced the route client-side, which would never load a static page.',
    from: "[['/','Home','home'],['/search','Discover','search']",
    to:   "[['/','Home','home'],['/find.html','Discover','search']",
  },
  {
    name: 'nav: dock does a real navigation for static pages',
    why:
      'router.replace() only moves between Expo routes. A target ending in .html ' +
      'is a page of its own and needs a document load.',
    from: 'onClick:()=>c.replace(t)',
    to:   "onClick:()=>{t.endsWith('.html')?location.assign(t):c.replace(t)}",
  },
  {
    name: 'home: search field opens the merged search page',
    why:
      'Tapping the search field on Home pushed the old grouped-by-source screen. ' +
      'This is index.tsx, the native variant -- index.web.tsx renders no search ' +
      'field, so on web this code is not reached. Guarded on location existing so ' +
      'it stays correct rather than crashing if a native build ever runs it.',
    from: "onPress:()=>I.push('/search')",
    to:   "onPress:()=>{typeof location!=='undefined'?location.assign('/find.html'):I.push('/search')}",
  },
  {
    name: 'library: "Search sources" opens the merged search page',
    why: 'The empty-library button pushed the old screen; the other branch is unchanged.',
    from: "onClick:()=>b.push(w?'/search':'/')",
    to:   "onClick:()=>{w?location.assign('/find.html'):b.push('/')}",
  },
];

const entries = fs.readdirSync(BUNDLE_DIR).filter((f) => /^entry-.*\.js$/.test(f));
if (entries.length !== 1) {
  console.error(`Expected exactly one entry bundle in ${BUNDLE_DIR}, found ${entries.length}.`);
  process.exit(1);
}
const file = path.join(BUNDLE_DIR, entries[0]);
let source = fs.readFileSync(file, 'utf8');

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

/* An edit whose replacement still contains its own anchor can never be seen as
 * applied: `from` is found again afterwards, so --check reports NOT APPLIED and
 * a second run applies it a second time. That has happened three times in this
 * file -- once it would have added a duplicate refresh button on every run --
 * and it is entirely mechanical to catch, so it is caught here rather than
 * remembered. Extend `from` through whatever follows it until this passes. */
for (const edit of EDITS) {
  if (!edit.to.includes(edit.from)) continue;
  console.error(`UNSAFE EDIT  ${edit.name}`);
  console.error('             its replacement still contains its own anchor, so it');
  console.error('             would re-apply on every run. Extend `from` through the');
  console.error('             text that follows it.');
  process.exit(1);
}

let changed = 0;
let bundleChanged = 0;
let failed = 0;

for (const edit of EDITS) {
  const already = occurrences(source, edit.to);
  const pending = occurrences(source, edit.from);

  if (pending === 1) {
    if (check) {
      console.log(`NOT APPLIED  ${edit.name}`);
      failed++;
    } else {
      source = source.replace(edit.from, edit.to);
      console.log(`applied      ${edit.name}`);
      changed++;
      bundleChanged++;
    }
    continue;
  }
  if (pending === 0 && already >= 1) {
    console.log(`already      ${edit.name}`);
    continue;
  }
  console.error(`ANCHOR LOST  ${edit.name}`);
  console.error(`             looked for: ${edit.from}`);
  console.error(`             found ${pending} times; the bundle was rebuilt and the`);
  console.error(`             minified names moved. Re-derive this anchor.`);
  failed++;
}

/* --- every page links Yomu's own stylesheet ---------------------------- *
 *
 * The overrides are presentation-only and keyed on the app's own semantic class
 * names, so unlike the edits above they survive a rebuild's minifier. They just
 * need a <link>, and the built HTML is where it has to go.
 */
const PAGES_DIR = 'dist-app';

// Each is matched by its own filename, so adding one later tops up pages that
// already carry the other rather than being mistaken for done.
const ASSETS = [
  /* Archivo is one variable family covering both roles -- width 62..125 gives
     the expanded display cut, so display and UI are a single request. No
     `file`, so the local-existence check skips it; `probe` is what marks a
     page as already carrying it. */
  {
    probe: 'family=Archivo',
    label: 'Archivo (Google Fonts)',
    tag:
      '<link rel="preconnect" href="https://fonts.googleapis.com">' +
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&display=swap">',
  },
  { file: 'yomu-overrides.css', tag: '<link rel="stylesheet" href="/yomu-overrides.css">' },
  { file: 'yomu-gate.js', tag: '<script src="/yomu-gate.js" defer></scr' + 'ipt>' },
  { file: 'yomu-shell.js', tag: '<script src="/yomu-shell.js" defer></scr' + 'ipt>' },
  { file: 'yomu-sync.js', tag: '<script src="/yomu-sync.js" defer></scr' + 'ipt>' },
  { file: 'yomu-circle.js', tag: '<script src="/yomu-circle.js" defer></scr' + 'ipt>' },
  { file: 'yomu-ledger.js', tag: '<script src="/yomu-ledger.js" defer></scr' + 'ipt>' },
  /* Last, so it overrides both the compiled palette and yomu-overrides.css on
     equal specificity. Moving it earlier silently un-skins the app. */
  { file: 'yomu-skin.css', tag: '<link rel="stylesheet" href="/yomu-skin.css">' },
];

// /start is the first-run flow and must not carry the shell: the shell is
// what redirects to /start, and a page that redirects to itself is a loop.
// That applies to the scripts, not the stylesheets -- skipping the page
// wholesale left the first screen a new reader ever sees as the only
// unskinned one in the app. These pages get the CSS and the fonts, no JS.
const SCRIPT_FREE_PAGES = new Set(['start.html']);
const isScript = (a) => a.tag.includes('<script');

for (const { file: assetFile } of ASSETS) {
  if (!assetFile) continue;
  if (fs.existsSync(path.join(PAGES_DIR, assetFile))) continue;
  console.error(`\nMissing ${path.join(PAGES_DIR, assetFile)} — nothing to link.`);
  failed++;
}

if (!failed) {
  for (const page of fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith('.html'))) {
    const pagePath = path.join(PAGES_DIR, page);
    let html = fs.readFileSync(pagePath, 'utf8');

    /* Edits to the prerendered markup itself.
     *
     * Expo writes each route's first paint into the HTML and React hydrates
     * onto it, so a bundle edit that changes what a route renders has to be
     * made here as well or the two disagree and React throws #418 and redraws.
     * Unlike the bundle anchors these are stable, readable markup; they are
     * matched exactly and skipped when a page does not contain them. */
    const HTML_EDITS = [
      /* The status bar tint iOS paints behind a standalone web app. A value
         that is not the page's own ground shows as a seam above the content
         on a phone. Four have been in circulation -- Expo's #070708 and
         #0b0d12, a hand-written #141414, and the previous kit's #0c131b --
         so each is mapped straight to Aurora's ground rather than chained,
         which would need two passes after a fresh export.

         One value, not a light/dark pair: the app's mode is a stored setting
         rather than an OS preference, so a media-switched meta would be right
         for System viewers and wrong for anyone who forced the other mode.
         Aurora is the default, so Aurora is the tint. */
      ...['#070708', '#0b0d12', '#141414', '#0c131b'].flatMap((old) =>
        // Expo writes the tag as `"/>`; the hand-written pages write `" />`.
        // Both spellings are in the tree, so both are matched.
        ['/>', ' />'].map((close) => ({
          name: `theme-color ${old}${close === ' />' ? ' (hand-written)' : ''}`,
          from: `<meta name="theme-color" content="${old}"${close}`,
          to:   `<meta name="theme-color" content="#080d14"${close}`,
        })),
      ),
      {
        name: 'duplicate genre chips',
        // Pairs with the bundle edit of the same name. Reincarnation and
        // Martial arts were printed twice -- once as a MangaDex genre and
        // again as an AniList tag -- and the AniList pair is the one dropped.
        from:
          '<button class="genre-chip genre-chip--ani" aria-pressed="false">Reincarnation</button>' +
          '<button class="genre-chip genre-chip--ani" aria-pressed="false">Martial arts</button>',
        to: '',
      },
    ];

    for (const edit of HTML_EDITS) {
      if (!html.includes(edit.from)) continue;
      if (check) { console.log(`NOT APPLIED  ${edit.name}: ${page}`); failed++; continue; }
      html = html.split(edit.from).join(edit.to);
      fs.writeFileSync(pagePath, html);
      console.log(`applied      ${edit.name}: ${page}`);
      changed++;
    }

    // Matched on the href/src, not the bare filename: a page that merely
    // mentions an asset in a comment must not be mistaken for one that links it.
    const wanted = SCRIPT_FREE_PAGES.has(page) ? ASSETS.filter((a) => !isScript(a)) : ASSETS;
    const probeOf = (a) => a.probe ?? ('"/' + a.file + '"');
    const nameOf = (a) => a.file ?? a.label;
    const missing = wanted.filter((a) => !html.includes(probeOf(a)));
    if (!missing.length) { console.log(`already      assets: ${page}`); continue; }
    if (!html.includes('</head>')) { console.log(`skipped      assets: ${page} (no <head>)`); continue; }
    if (check) { console.log(`NOT APPLIED  assets: ${page} (${missing.map(nameOf).join(', ')})`); failed++; continue; }

    html = html.replace('</head>', missing.map((a) => a.tag).join('') + '</head>');
    fs.writeFileSync(pagePath, html);
    console.log(`applied      assets: ${page} (${missing.map(nameOf).join(', ')})`);
    changed++;
  }
}

// The bundle is written only if a bundle edit changed it; the HTML pass
// writes its own files as it goes.
if (bundleChanged) fs.writeFileSync(file, source);
if (failed) process.exit(1);
console.log(changed ? `\n${changed} edit(s) applied` : '\nnothing to do');
