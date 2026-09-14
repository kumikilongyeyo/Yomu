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
    name: 'reader: double tap to bring the chrome back',
    why:
      'A single tap toggled the bars, so any tap while reading flashed them up. ' +
      'Two taps within 320ms toggle instead -- the same window the native reader ' +
      'already uses -- and a single tap does nothing.',
    from: 'onTap:()=>Z?F(!1):Y()',
    to:
      'onTap:()=>{const t=Date.now();' +
      'if(t-(globalThis.__yomuTap??0)<320){globalThis.__yomuTap=0;Z?F(!1):Y()}' +
      'else globalThis.__yomuTap=t}',
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
  { file: 'yomu-overrides.css', tag: '<link rel="stylesheet" href="/yomu-overrides.css">' },
  { file: 'yomu-gate.js', tag: '<script src="/yomu-gate.js" defer></scr' + 'ipt>' },
  { file: 'yomu-shell.js', tag: '<script src="/yomu-shell.js" defer></scr' + 'ipt>' },
];

for (const { file: assetFile } of ASSETS) {
  if (fs.existsSync(path.join(PAGES_DIR, assetFile))) continue;
  console.error(`\nMissing ${path.join(PAGES_DIR, assetFile)} — nothing to link.`);
  failed++;
}

if (!failed) {
  for (const page of fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith('.html'))) {
    const pagePath = path.join(PAGES_DIR, page);
    let html = fs.readFileSync(pagePath, 'utf8');

    // The status bar tint iOS paints behind a standalone web app. Expo wrote
    // the old palette's #070708; the approved ground is #0c131b, and a
    // mismatch shows as a seam above the content on a phone.
    const OLD_THEME = '<meta name="theme-color" content="#070708"/>';
    const NEW_THEME = '<meta name="theme-color" content="#0c131b"/>';
    if (html.includes(OLD_THEME)) {
      if (check) { console.log(`NOT APPLIED  theme-color: ${page}`); failed++; }
      else {
        html = html.replace(OLD_THEME, NEW_THEME);
        fs.writeFileSync(pagePath, html);
        console.log(`applied      theme-color: ${page}`);
        changed++;
      }
    }

    const missing = ASSETS.filter((a) => !html.includes(a.file));
    if (!missing.length) { console.log(`already      assets: ${page}`); continue; }
    if (!html.includes('</head>')) { console.log(`skipped      assets: ${page} (no <head>)`); continue; }
    if (check) { console.log(`NOT APPLIED  assets: ${page} (${missing.map((a) => a.file).join(', ')})`); failed++; continue; }

    html = html.replace('</head>', missing.map((a) => a.tag).join('') + '</head>');
    fs.writeFileSync(pagePath, html);
    console.log(`applied      assets: ${page} (${missing.map((a) => a.file).join(', ')})`);
    changed++;
  }
}

// The bundle is written only if a bundle edit changed it; the HTML pass
// writes its own files as it goes.
if (bundleChanged) fs.writeFileSync(file, source);
if (failed) process.exit(1);
console.log(changed ? `\n${changed} edit(s) applied` : '\nnothing to do');
