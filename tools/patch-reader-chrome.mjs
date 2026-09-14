/**
 * Reader chrome fixes, applied to the built web bundle.
 *
 * These belong in apps/client/app/read/[chapterId].web.tsx. That source is not
 * in this repository -- dist-app/ is Expo build output and the Expo project it
 * came from was never handed over -- so they are applied to the bundle instead.
 *
 * Every edit is anchored to an exact string that must appear exactly once. If a
 * future `expo export` changes the minified names, this fails loudly with the
 * anchor that moved rather than silently doing nothing. Re-run it after any
 * rebuild:
 *
 *   node tools/patch-reader-chrome.mjs            # apply
 *   node tools/patch-reader-chrome.mjs --check    # verify, change nothing
 *
 * Idempotent: applying twice is a no-op, and --check is what CI would run.
 */
import fs from 'node:fs';
import path from 'node:path';

const BUNDLE_DIR = 'dist-app/_expo/static/js/web';
const check = process.argv.includes('--check');

const EDITS = [
  {
    name: 'idle timeout 3s -> 2s',
    why:
      'The reader hid its chrome after 3 seconds. Two reads better on a phone, ' +
      'where the bars cover the page you are trying to read.',
    from: 'x=768,j=3e3,b=e=>',
    to:   'x=768,j=2e3,b=e=>',
  },
  {
    name: 'scrolling no longer wakes the chrome',
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
    name: 'double tap to bring the chrome back',
    why:
      'A single tap toggled the bars, so any tap while reading flashed them up. ' +
      'Two taps within 320ms toggle instead -- the same window the native reader ' +
      'already uses for its own double-tap -- and a single tap does nothing.',
    from: 'onTap:()=>Z?F(!1):Y()',
    to:
      'onTap:()=>{const t=Date.now();' +
      'if(t-(globalThis.__yomuTap??0)<320){globalThis.__yomuTap=0;Z?F(!1):Y()}' +
      'else globalThis.__yomuTap=t}',
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

if (failed) process.exit(1);
if (changed) {
  fs.writeFileSync(file, source);
  console.log(`\n${changed} edit(s) written to ${file}`);
} else {
  console.log('\nnothing to do');
}
