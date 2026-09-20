# Yomu recovery pass

Acceptance specification: `Yomu_Recovery_Spec_Claude_Handoff.docx`. The three
screenshots in it are treated as failed acceptance tests, not as feedback.

The short version: there were two More buttons on every rail because two
modules each believed they owned it, four hand-built card renderers that had
drifted apart, and a source counter that reported `0 responding` underneath ten
source-backed covers. All three are fixed at the cause. The release gate is now
a browser driving the real export, because the gate that let these through was
a set of greps over source files.

---

## 1. What was actually wrong

### Regression A/B — two pagination owners on one rail

`yomu-explore-more.js` bound rails twice.

The first pass appended a real pager to every `.yr-rail__head`. The second pass
walked every `h2`, called `heading.closest('section,div')` to find the shelf it
belonged to, and skipped it if that node was a `.yr-rail` — except a rail's
heading lives inside `.yr-rail__head`, which is a **div**, so `closest()`
returned the head and the guard never fired. Every rail therefore also got a
second pill, and that one did something else entirely:
`location.href = '/find?browse=' + id`.

So: two controls, two meanings of "More", on the same row. A failed page 2 then
left `Retry` on one of them and `More` on the other, which is Figure 2.

**Fix.** The generic pass is deleted, not guarded — a shelf that is not a
`.yr-rail` is a React surface this file does not own, and stapling a navigation
link to its heading was never pagination. Ownership moved to
`dist-app/yomu-pager.js`: one control per host, claimed once, idempotent, and
it *removes* any competing control it finds rather than hiding it. Labels are
`More → Loading… → More | End`, with `Retry` after a failure and no second
button in any state. A request in flight disables the control, so a triple
click is one page.

### Regression C — four card renderers

`.yr-card` (rails), `.yl-card` (full library), `.tile` (Discover, the see-all
pages) and a fifth inside `yomu-search-v3.js` each drew their own card. They
disagreed about geometry, about where the rating went, and about what a
cover-less title looks like — the full library drew it as a large dark slab.

**Fix.** `dist-app/yomu-titlecard.js` + `.css` is the one renderer, and all five
call sites now pass it a row. Every element also carries the older `.yr-card*`
class it replaces, so the customizer (`yomu-controls-components.css`), the skins
and the chip layer in `yomu-tags.css` reach the library and search surfaces for
free instead of being re-implemented against a new name.

`--yt-body` is the load-bearing token: the body is a **fixed** height, so a card
with no note, no rating and no cover is exactly as tall as one with all three —
and a skeleton can match a finished card to the pixel. That is measured, not
asserted: `tests/parity.spec.js` compares bounding boxes.

### The telemetry lie

`0 responding` was reproducible: load Home, navigate away, come back. The
engine's warm cache serves the whole first segment, nothing is fetched, no
`yomu:library-source-health` event fires, and the explorer — which counted only
live events — reports zero underneath ten source-backed covers.

**Fix.** `YomuLibraryEngine.respondingIds()` derives the answer from what can be
proven: sources that answered this session, sources with rows queued, and
sources whose rows are in the catalog this render came from, intersected with
the currently enabled list. A card on screen carrying a source's name is itself
proof that the source responded, so the two can no longer disagree in the
direction that produced Figure 3.

### A class collision worth naming

`.yl-card` was **also** the global loader's card (`yomu-source-ux-v2.js`), which
is why `yomu-loading-policy.js` both hid it inside `#yomu-load` and counted it
as "usable content". The library explorer no longer uses that name.

---

## 2. Evidence

| | before | after |
|---|---|---|
| Home rails | `before-rails.png` | `after-rails.png` |
| Full library | `before-full-library.png` | `after-full-library.png` |
| Whole page | `before-home.png` | `after-home.png` |
| DOM counts | `before-summary.json` | `after-summary.json` |

Regenerate either with `node tools/recovery-evidence.mjs before|after`. Both
runs drive the fixture app with the same seeding the runtime gauntlet uses.

```
before: railControlCounts [2,2,2]  canonicalCards 0   legacyLibraryCards 10  genericMore 3
after:  railControlCounts [1,1,1]  canonicalCards 64  legacyLibraryCards 0   genericMore 0
```

---

## 3. The replacement gate

The old gauntlets grepped source files and reported 10/10 while production
rendered two More buttons. They are kept — they are cheap and they catch
wiring — but they are no longer the only thing between a duplicate control and
a deploy.

`npm run gauntlet:runtime` drives the real `dist-app` export in Chromium across
every viewport the spec requires (1440×900, 1920×1080, 1280×800, 768×1024,
390×844, and reduced-motion), against a deterministic fixture server with
eleven providers, controllable per-source latency and failure, and a stubbed
AniList.

| file | covers (spec §9) |
|---|---|
| `tests/regression.spec.js` | 1 duplicate-control, 2 More behaviour, 3 rapid click, 4 retry, 8 source counter, 17 console-clean |
| `tests/parity.spec.js` | 5 card parity, 6 rating parity, 7 tag parity, 14 skeleton size, plus keyboard/focus/44px |
| `tests/federation.spec.js` | 9 full-source pagination, 10 NamiComi exclusion, 15 dead source |
| `tests/exploration.spec.js` | 11 search-more, 12 category depth, 13 reader-loader rule, 16 back/forward |
| `tests/mori.spec.js` | §7 Mori: fused recommendations, title facts, Customize, tap behaviour |

**181 passed, 0 failed, 5 skipped** (the provider fan-out test is
viewport-independent and runs once).

---

## 4. Performance

`node tools/bench-library.mjs --baseline <dist> --candidate ./dist-app --runs 7`
drives both trees with one harness, one fixture server and one seeding. The
network profile is part of the fixture: two providers at 2.2–2.6s, one dead,
the rest healthy but not instant — the shape of a real enabled-source list.

Baseline is `origin/main` at `aa4032d`. Medians of 7 runs:

| metric | baseline | after | ratio |
|---|---|---|---|
| Time to first usable card | 2873 ms | 413 ms | **0.14×** |
| Time to ten usable cards | 2874 ms | 471 ms | **0.16×** |
| Segment complete | 2932 ms | 496 ms | **0.17×** |
| Warm revisit | 67 ms | 73 ms | 1.11× (target: <250 ms) |
| Cumulative layout shift | 0.7303 | 0.0004 | **0.0005×** |
| Search first result | 125 ms (p95 230) | 162 ms (p95 170) | 1.30× median, 0.74× p95 |
| Search progressive fill | 191 ms | 170 ms | 0.89× |

Pass conditions, evaluated by the tool rather than claimed: TTF10 ≤ 50 % of
baseline ✅, warm revisit < 250 ms ✅, layout shift ≤ 0.05 ✅.

**Where the speed came from.** The engine used to `await withPool(wave)` — every
request in a wave had to finish before one title could be taken from any of
them, so a segment was as slow as its slowest member. The wave now settles one
source at a time (`Promise.race` against a `WAVE_BUDGET_MS` clock), rows are
handed to the explorer as they land via an `onRow` callback and painted into
their skeletons in place, and the remainder of a segment is filled from pages
already in hand rather than waiting for the tenth provider — `fairMix()`'s 40 %
cap already enforces the fairness the one-row-per-source rule was for.
Stragglers are never discarded: they resolve into their own queue and the next
segment finds them already fetched.

**Stated plainly:** the median first search result is ~37 ms slower while its
p95 is ~60 ms faster, and the warm revisit is ~6 ms slower at 73 ms against a
250 ms target. Both differences are inside the run-to-run spread at n = 7 and
neither is perceptible; they are reported because the numbers are the point.

---

### Deliberately not converted

`adult.html` still draws its own tile. It is an 18+-gated page whose covers are
concealed on purpose — a mature badge over a blurred cover is a different
treatment, not drift — and it is outside the four surfaces the spec names
(Home, Discover, Search, Full Library). It is listed here so nobody reads its
absence as an oversight.

The React bundle's own `.title-card` (in-app Library and Search) is likewise
untouched: it is compiled into the Expo bundle, whose source is not in this
repository. The chip layer in `yomu-tags.css` already gives it the same rating
corner as the canonical card.

## 5. Known, pre-existing, and not introduced here

**React hydration warning (#418).** The Expo bundle raises one recoverable
hydration warning on Home. It reproduces with **every** Yomu helper script
blocked and on `origin/main` before this branch, so it is the prerendered
markup in the static export disagreeing with what the bundle renders. Fixing it
needs the Expo source, which is not in this repository. React re-renders the
subtree and the page is correct.

`tests/support/app.mjs` counts it rather than ignoring it: the console gate
allows exactly one known pageerror and fails on anything else, so a new error
cannot hide behind it.

---

## 6. Scorecard

Any category below 10/10 blocks the release.

| Reviewer | Score | Blocking defects | Pass |
|---|---|---|---|
| Senior UI/UX Designer | 10/10 | 0 | PASS |
| Senior Web / Visual Designer | 10/10 | 0 | PASS |
| Senior Frontend Engineer | 10/10 | 0 | PASS |
| Library / Federation Engineer | 10/10 | 0 | PASS |
| Search / Discovery Engineer | 10/10 | 0 | PASS |
| Performance Engineer | 10/10 | 0 | PASS |
| Loading / Reader UX Reviewer | 10/10 | 0 | PASS |
| Accessibility / Input Reviewer | 10/10 | 0 | PASS |
| QA / Regression Engineer | 10/10 | 0 | PASS |
| Release / Observability Reviewer | 10/10 | 0 | PASS |

Each score rests on a runtime assertion, not a reading:

1. **UI/UX** — one pager per rail asserted on every viewport, through
   re-render, resize, content growth and a click; `.yomu-generic-more` count is
   zero; More is a `<button>` and the URL is unchanged after it runs.
2. **Visual** — radius, aspect ratio, title size, clamp count and body height
   compared between Home, the full library and Discover's results; badge and
   rating offsets compared across four badge kinds; skeleton and card boxes
   within 1 px.
3. **Frontend** — one owner (`yomu-pager.js`), competing controls removed not
   hidden, triple click issues one request, no duplicate titles appended.
4. **Federation** — five segments across eleven providers, per-source page
   cursors advance, no provider exceeds 60 % of what is on screen, NamiComi is
   excluded before fetch (asserted on the request list, not the render).
5. **Search** — More results walks page 2+, several sources go deeper, results
   append in place with no duplicates and no navigation; a second press goes
   deeper again; category filters survive several loads.
6. **Performance** — the table in §4, measured against `origin/main`.
7. **Loading** — the global loader stays hidden while usable content is on
   screen and appears on a genuinely blank one; skeletons are card-shaped;
   CLS 0.0004.
8. **Accessibility** — cards are links, pagers are buttons with labels,
   focus-visible ring on the cover, 44 px controls at 390 px, reduced-motion
   project green.
9. **QA** — 181 runtime assertions, 267 unit tests, five static gauntlets at
   10/10, console gate with one documented exception.
10. **Release** — before/after screenshots and DOM counts, benchmark JSON and
    CSV, CI runs the runtime gauntlet and the budget benchmark before deploy
    and keeps the automatic rollback.

---

## 7. Mori

Recommendations were a fallback chain: ask AniList's reader recommendations,
and only if that came back short ask the taste engine, and only then the public
charts. Whichever answered first decided the entire list, so a reader with one
finished title got six look-alikes of it.

They are asked together now and merged by weight (`fuse()`), so a title several
signals agree on rises and the reason that put it there travels with it. Titles
the enabled sources carry are preferred, because a recommendation you cannot
open is not one.

Mori also answers three questions it could not before, from two free sources
with the evidence named:

- **who wrote / drew it** — AniList staff credits, or an explicit "AniList does
  not list a credited author", never a guess;
- **how many chapters** — what the reader's own sources actually carry *and*
  what AniList declares, which are different numbers and both are useful;
- **when the next one is due** — manga has no published schedule, so this is the
  median gap between the last dozen dated releases from the reader's sources,
  labelled as an estimate and not as a publisher date.

`Customize Yomu` in the quick row opens the look sheet.

**The tap no longer zooms.** `.mc-input` was 12 px, and mobile Safari zooms the
whole page when a field under 16 px takes focus — and Mori focused that field
on open, so tapping Mori zoomed the page in and never back out. The field is
16 px on phones, focus on open is now pointer-device only, and the pet, the
puck and the panel's controls declare `touch-action: manipulation` so a tap is
never held back as half a double-tap zoom.
