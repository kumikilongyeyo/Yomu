# Reader Reliability Pass

The reading loop -- open a chapter, scroll, never think about loading, sources,
broken images or the next chapter. What each part does and where it lives.

## Where it lives

| File | Owns |
|---|---|
| `tools/patch-bundle.mjs` ("reader reliability" edits) | The Expo reader's hooks: the page window, relayout, the decode budget, rescue-aware page errors, the published reader state (`globalThis.__yomuReader`) |
| `dist-app/yomu-reader-settings.js` | Preferences, the byte-sized page window, Page mode (`Paged`), the settings group in the reader's sheet, keyboard shortcuts, the mode suggestion |
| `dist-app/yomu-reader-plus.js` | Chrome that follows the scroll, look-ahead, next-chapter prefetch, what sits below the last page (continuous preview or end card), the page counter |
| `dist-app/yomu-page-rescue.js` | The per-image retry ladder and the pending/exhausted signal |
| `dist-app/yomu-chapter-switch.js` | Whole-chapter recovery: dead pages, stalls, failed manifests, a copy that is short |
| `dist-app/yomu-integrity.js` | Completeness and reliability scoring, picker labels, same-slicing proof, per-source page-count history |
| `dist-app/yomu-reader.css` | Everything above that is drawn: Page mode, the tail below the last page, the settings rows, the counter, the one-line offers, the shortcuts panel |

All of them load on demand with the other reading helpers (`yomu-fabric-route.js`,
`READING_SCRIPTS`), never on every page: Home's warm-revisit budget has no room
for them. The stylesheet is linked at runtime by `yomu-reader-settings.js`, not
by `yomu-overrides.css`, which is render-blocking on every page; Page mode
carries its own inline layout so it is readable before the sheet arrives. A
reader or series page served as its own document gets all of them from
`scripts/optimize-export.py`'s `READER` list.

## What the reader gets

**Pages that heal.** A failed page is retried at once through the same door
(cache-busted), after 0.7s through the other proxy, then from another source's
copy if that source is *proven* to cut the chapter the same way (the same page
count here and on every chapter seen together, or matching content hashes), and
finally once more after 3.5s. While that runs the image is marked
`data-yomu-rescue="pending"` and the reader keeps its loading state, so a rescue
that works is invisible. Only when every door has refused does the page say it
is unavailable. Offline waits for the connection instead of burning attempts.

**Sources that fail over.** A chapter whose first page, or two pages, cannot be
loaded -- or that stalls, or whose manifest fails -- is swapped for the best
working copy another saved source has (ranked by `yomu-integrity.js`, and only a
copy whose own page decoded). A single dead page is left alone while it is
ahead and swapped away from the moment the reader reaches it. The place carries
over: the same page on the same slicing, the same fraction of the chapter
otherwise. One line says so: "Switched source · Vortex → Weeb Central".

**Memory-safe long chapters.** The mounted window is sized in decoded bytes
(width × height × 4, from measured or declared sizes): 110MB on a phone (64MB
on a 2GB one), 220MB on a desktop, never fewer than one page either side. Four
pages ahead on a fast line, three on a normal one, two on a slow one, one with
Data saver; two behind. Line speed is measured from the page loads themselves,
because iPhone Safari has no `navigator.connection`. A prefetch that does not
fit the decode budget waits; the page on screen always loads.

**The next chapter, already there.** At 70% the next manifest is fetched and
handed to the reader; at 85% its first pages are warmed. The hand-off is
refreshed when it ages, because the reader only trusts one younger than two
minutes. With Continuous chapters on (the default, in Scroll) the next
chapter's divider and first page sit below the last page, and the moment that
page reaches the top of the screen the reader moves into the chapter at exactly
that spot -- written as its resume anchor, so nothing jumps and the address bar
follows. With it off, an end card offers the next chapter.

**Exact resume.** The anchor is page key + offset within the page. A narrower
column (rotation, a resized window) clamped the scroll before the reader's
relayout and lost ~5 pages; the relayout now locates the offset read during
render, before the clamp. Synced positions from another device carry the offset
and no longer keep this device's stale page key, which used to reopen the old
page. Continue Reading shows one card per title, even after a source switch.

**A picker that ranks.** One Recommended, a Fast one if it earns it, the other
complete copies as Complete, the rest as Backup (with why, when known).

**Short copies caught.** A chapter far shorter than the same source's own
recent chapters of the series (4 after 45 and 47) is checked against the other
sources in the background; if one has the whole chapter, one line offers it.
Page counts are never compared raw across sources -- they slice differently.

**Controls that get out of the way.** One tap toggles the chrome; scrolling
down hides it and up brings it back; while it is away only a small page
counter remains. On a desktop the shell's side rail goes with it. Sheets are
bottom sheets on a phone and respect the safe areas.

**Page mode.** One page fitted to the screen, or a spread on a wide screen (the
first page alone -- switchable -- and a page already wider than tall alone).
Left-to-right or right-to-left, tap zones (edges turn, middle is the menu),
swipe, arrow keys, the next two screens decoded before the turn, an end panel
that goes on to the next chapter, and chapters marked read at the end.

**Comfort.** Continuous chapters, reading direction, spread offset, page gap,
page width and image quality in the reader's own settings sheet. Data saver
loads fewer pages ahead and uses smaller images where the source has them
(MangaDex). Desktop shortcuts: ← → pages, [ ] chapters, M mode, C chapters,
S settings, F full screen, ? the list.

**A mode suggestion, never a lock.** Page-shaped Japanese manga opened in Scroll
gets one offer of Page mode; a tall strip opened in Page gets one offer of
Scroll. Once per title.

## Verification

`npm test`, `npm run typecheck`, `node tools/patch-bundle.mjs --check`,
`node tools/gauntlet.mjs --offline`, and the runtime gauntlet
(`npx playwright test`). `tests/reader-reliability.spec.js` covers each
moment above end to end; `npx playwright test --config=playwright.reader-webkit.config.js`
runs it in WebKit with the iPhone 13 profile. The fixture gives reader pages
the shell's stylesheets, as production does; the slow rescue and switching
tests run at one desktop and one phone width.

What emulation cannot establish: real iPhone memory pressure, and how any
particular third-party source misbehaves. Cross-source position is exact on the
same slicing and proportional otherwise.
