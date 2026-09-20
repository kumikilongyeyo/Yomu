#!/usr/bin/env node
/** Strict UI/UX release gate for the expanded library and Mori. 10/10 only. */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const BASE = (process.argv.slice(2).find((x) => /^https?:\/\//.test(x)) || '').replace(/\/+$/, '');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const explorer = read('dist-app/yomu-library-explorer.js');
const libraryCss = read('dist-app/yomu-library.css');
const chat = read('dist-app/yomu-mori-chat.js');
const chatCss = read('dist-app/yomu-mori-chat.css');
const drag = read('dist-app/yomu-mori-drag.js');
const optimizer = read('scripts/optimize-export.py');
const results = [];
const gate = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

async function live(pathname) {
  if (!BASE) return null;
  try {
    const response = await fetch(BASE + pathname, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, text: '', error: String(error?.message || error) };
  }
}
const home = await live('/');
const liveCss = await live('/yomu-library.css');
const liveChat = await live('/yomu-mori-chat.js');

// U1 — loading reserves card geometry rather than flashing empty space.
gate('U1 loading has stable tile skeletons and status',
  /yl-skeleton/.test(explorer) && /showSkeletons/.test(explorer)
  && /role', 'status'/.test(explorer) && /aria-live/.test(explorer)
  && /aspect-ratio:2\/3/.test(libraryCss));

// U2 — auto-load is enhancement, not the only control.
gate('U2 infinite loading has an explicit accessible fallback',
  /IntersectionObserver/.test(explorer)
  && /Load 10 more/.test(explorer)
  && /more\.type = 'button'/.test(explorer)
  && /more\.addEventListener\('click'/.test(explorer));

// U3 — controls and cards have keyboard semantics/focus treatment.
gate('U3 keyboard navigation remains first-class',
  /button\.type = 'button'/.test(explorer)
  && /aria-pressed/.test(explorer)
  && /aria-label/.test(explorer)
  && /:focus-visible/.test(libraryCss));

// U4 — responsive density changes instead of squeezing desktop cards onto phones.
gate('U4 responsive card density covers desktop tablet mobile',
  /repeat\(5,minmax\(0,1fr\)\)/.test(libraryCss)
  && /max-width:1180px/.test(libraryCss)
  && /max-width:820px/.test(libraryCss)
  && /max-width:620px/.test(libraryCss)
  && /repeat\(2,minmax\(0,1fr\)\)/.test(libraryCss));

// U5 — motion is optional and expensive off-screen card work is deferred.
gate('U5 motion and paint cost respect the device',
  /prefers-reduced-motion:reduce/.test(libraryCss)
  && /content-visibility:auto/.test(libraryCss)
  && /loading = 'lazy'/.test(explorer)
  && /decoding = 'async'/.test(explorer));

// U6 — Mori is a proper dialog with Escape, focus management and quick actions.
gate('U6 Mori chat has dialog and focus discipline',
  /role', 'dialog'/.test(chat)
  && /aria-label', 'Mori library chat'/.test(chat)
  && /event\.key === 'Escape'/.test(chat)
  && /function trapTab/.test(chat)
  && /input\?\.focus\(\)/.test(chat));

// U7 — free mode must stay genuinely free and grounded, never silently revive
// the deleted paid model endpoint.
gate('U7 Mori recommendations are free and grounded',
  /No paid model/.test(chat)
  && /YomuRank/.test(chat)
  && /YomuAniList/.test(chat)
  && /YomuLibraryEngine/.test(chat)
  && !/openai|anthropic|api[_-]?key|bearer\s+\$\{/i.test(chat));

// U8 — user asked specifically for the collapsed + to move too. It must use
// pointer capture, slop, viewport clamp, persistence and click suppression.
gate('U8 Mori plus puck is genuinely draggable',
  /\.yp-puck/.test(drag)
  && /setPointerCapture/.test(drag)
  && /Math\.hypot\(dx, dy\) < 5/.test(drag)
  && /clamp\(/.test(drag)
  && /position: \{ x: Math\.round\(x\), y: Math\.round\(y\) \}/.test(drag)
  && /stopImmediatePropagation/.test(drag));

// U9 — floating helpers may not create an invisible click-eating viewport.
gate('U9 overlays do not swallow the page',
  /#yomu-mori-chat\{position:fixed/.test(chatCss)
  && !/width:100vw[^}]*height:100vh|inset:0[^}]*pointer-events:auto/i.test(chatCss)
  && /pointer-events:none/.test(read('dist-app/yomu-pet.css')));

// U10 — release injection, theme tokens, and mobile touch targets must survive
// production optimization, not only exist as orphan files in git.
gate('U10 production UI wiring and theme integrity',
  /yomu-mori-chat\.css/.test(optimizer)
  && /yomu-mori-drag\.js/.test(optimizer)
  && /yomu-mori-chat\.js/.test(optimizer)
  && /var\(--accent/.test(libraryCss)
  && /min-height:44px/.test(libraryCss)
  && (!BASE || (home?.ok && liveCss?.ok && liveChat?.ok && /yomu-mori-chat\.js/.test(home.text))),
  BASE ? `home=${home?.status}; css=${liveCss?.status}; chat=${liveChat?.status}` : 'offline');

const passed = results.filter((r) => r.ok).length;
for (const [i, row] of results.entries()) {
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${String(i + 1).padStart(2, '0')}/10  ${row.name}${row.ok || !row.detail ? '' : `\n             ${row.detail}`}`);
}
console.log(`\nUI/UX Gauntlet: ${passed}/10 ${passed === 10 ? 'PASS' : 'FAIL — RELEASE BLOCKED'}`);
if (passed !== 10) process.exit(1);
