# Stabilization pass — `stabilize/yomu-core-gauntlet-v1`

Against the Product & Engineering Audit, 2026-09-19.

**Nothing here is on `main`, and nothing here is deployed.** The CI workflow
deploys on pushes to `main` only, so production is still running the tagged
pre-gauntlet state while this branch exists.

| | |
|---|---|
| Rollback target | `yomu-pre-gauntlet-2026-09-19` → `0ff6b24` |
| Branch cut from | that same commit |
| Production at time of writing | `0ff6b24`, unchanged |

---

## Phase 0 — safety, done

- Annotated tag `yomu-pre-gauntlet-2026-09-19` created and pushed.
- Branch `stabilize/yomu-core-gauntlet-v1` created from the deployed commit and
  pushed.
- **Rollback drill run** (G13): the tag resolves to exactly `origin/main`, a
  detached worktree at the tag restores the pre-gauntlet tree, and the `sw.js`
  in it matches what production serves byte for byte.

Rollback path A — undo one change: `git revert <commit>`. Every commit on this
branch is atomic and independently revertible; each commit message ends with
its own rollback note.

Rollback path B — abandon the pass: production is already the tag. Nothing to
undo. If this branch has been merged by then,
`git revert -m 1 <merge-commit>` or redeploy `yomu-pre-gauntlet-2026-09-19`.

---

## Phase 1 — core correctness, done

Suggested-first-batch items 1–6 and 8–10. One atomic commit each.

| # | Issue | Commit | Status |
|---|---|---|---|
| 1 | Pre-gauntlet tag + stabilization branch | — | done |
| 2 | P0 local-time progression day bucketing | `12d016d` | done |
| 3 | P0 canonical title href / modified-click routing | `a2fcc99` | done |
| 4 | P0 fail-safe source capability resolution | `1daad25` | done |
| 5 | P1 unify theme bootstrap, remove page-switch flash | `6d4c72d` | done (bootstrap itself shipped pre-audit) |
| 6 | P1 restore browser zoom | `472b003` | done |
| 7 | P1 consolidate Continue Reading on one ReadingHistory | `3e6413d` | **partly — the defect, not the refactor** |
| 8 | P1 version + clean service-worker caches | `f252b7e` | done |
| 9 | P1 per-series metadata / canonical URL | `b856132` | done |
| 10 | P1 automated smoke tests | `686559a` | done |

Found while running the gauntlets, and fixed here too:

| Finding | Commit |
|---|---|
| U14 `--faint` failed WCAG AA in 11 of 12 palette/mode pairs | `ad2724b` |
| U2 sidebar lit Home on every screen; `/discover` was unmapped | `03d77ed` |

### Verification

- Unit suite: **251 pass, 0 fail**, and the same under `TZ=Asia/Manila`,
  `TZ=UTC` and `TZ=America/New_York` — the progression tests were silently
  asking a timezone question and now pin one.
- `npm run typecheck`: clean.
- `npm run gauntlet`: **67 passed, 0 failed** (G1, G2, G3, G8, G11, U14).
- G12 sweep: all six primary routes serve 200, carry the prepaint bootstrap,
  allow zoom, and no longer re-interpret the mode.
- U13 at 320px: no horizontal overflow; the customiser's five presets and the
  chapter-end card both fit.

---

## Not done, and why

### Item 7 — one canonical `ReadingHistory`

**The confirmed defect is fixed; the refactor is not.**

The defect was a join, not a schema: `yomu.v1.reading` knows which source
served a title, the reader's resume anchor knows which chapter and page, and
the code joined them by asking the *library* for the source — so a title read
but never saved vanished from Continue Reading. `3e6413d` makes the reading
index the first answer and the library the fallback. No store changed.

The consolidation the audit describes — one ReadingHistory record on
IndexedDB, with a migration — is still Phase 2 and still wants
`refactor/reading-history-store`. Keeping it separate means a migration
failure is revertible without taking the Continue Reading fix with it.

### Phases 2–7

Untouched, as scoped: storage durability (IndexedDB), frontend consolidation
off the compiled-bundle patch layer, reader/series/discover polish, Source
Continuity (CanonicalTitle graph, chapter normalization, provider health and
failover), and the release candidate.

One note toward Phase 5: `/title/<slug>` shipped here is the shape a real
CanonicalTitle id slots into without changing a caller. The path stays
`/title/<id>`; only what resolves it changes.

### U0 — first-run friction

The welcome screen is "Step 1 of 6", and the way past it ("Or look around
without setting anything up") is a small underlined link beneath two buttons.
That is the audit's own P2 finding, and it is filed there as a *product
issue*, not a bug.

Deliberately not touched. The audit's rule for this pass is "do not add new
user-facing features during the stabilization pass unless they are required to
fix a core flow", and re-weighting onboarding is a product decision with an
opinion in it — it wants Klyde, not a stabilization branch.

### P2 items

Adult-gate DOM observation, route-level code splitting for Discover/Search,
mixed `.html` + extensionless route conventions, and first-run setup friction
are all still open. The route-convention one is now partly documented: the
asset server answers `/find.html` with a 307 to `/find`, which the gauntlet
relies on.

---

## Known issues, not introduced here

- **React hydration error #418** on every route, from the compiled Expo
  bundle. Present before this branch and on pages nothing rewrites — verified
  by loading a series page with no `?source=`, which no code here touches, and
  seeing the same errors. It belongs to the Expo source, which is the thing
  Phase 3 exists to recover.
- **`/api/md/*` 500s in local dev** are the sandbox's blocked outbound
  network, not the Worker.
- **A Continue Reading card can say "Untitled"** when the reading index has a
  source and a chapter but never captured a title. Pre-existing on that path,
  and preferred to dropping the card: the position is real and the card opens
  the right chapter.

## Gauntlet coverage

Automated (`npm run gauntlet`), so they run on every change:

| Gate | What it holds |
|---|---|
| G1 | typecheck, unit suite, `patch-bundle --check` |
| G2 | canonical title routing, including modified clicks |
| G3 | prepaint theme bootstrap on every primary route, one owner |
| G8 | shell cache versioned, bounded, scoped cleanup, API never cached |
| G11 | image proxy refuses link-local and `file:`, metadata is escaped |
| U14 | faint/dim/muted clear AA against every palette's own ground |

Run once, by hand, against this branch on a desktop browser:

| Gate | Result |
|---|---|
| G12 regression sweep, six primary routes | pass — 200, bootstrap present, zoom allowed, no late theme |
| U8 typography / zoom | pass — `user-scalable=no` gone from all 24 pages |
| U9 touch and keyboard targets | partial — no nav target under 40px; tab order and screen reader not checked |
| U10 motion | pass — 31 reduced-motion blocks cover 9 looping rules |
| U13 density at 320px | pass — no horizontal overflow, presets and chapter-end card fit |
| U14 contrast | pass, after `ad2724b` |
| U0 first five seconds | **noted, not fixed** — see below |
| U1 hierarchy | pass — Continue Reading sits above the promotional rows |
| U2 navigation | pass, after `03d77ed` |
| U4 series detail | pass — primary action dominant; metadata now per title |
| U11 error states | pass — "This source was removed. Add it again in Sources." names the cause and the next step |
| U12 brand consistency | pass — hand-built and app-derived pages share one token set and one lockup |

Still not run, and required before a merge to `main`:

- **G4** capability API timeout / malformed / provider failure against a live
  bridge. The unit tests cover the decision; the network shapes are not faked.
- **G5** reader: vertical and paged, chapter transitions, chrome, resume.
- **G6** progress across a real local midnight on a device.
- **G7** storage: fresh user, established user, malformed values, quota.
- **G9** source switching with a dead preferred source.
- **G10** performance against a baseline with realistic title counts.
- **U3, U5, U6, U15** — discovery behaviour with sources actually enabled,
  reader focus in both page modes, the chapter-end moment at a real milestone,
  and the polish sweep. These need a populated library and a real reading
  session, which a fresh local profile does not have.
- The **browser/device matrix** in full. Everything above was Chromium at
  1200px, 1100px, 375px and 320px. Safari, Firefox, a real iPhone and a real
  Android are untested, and the audit names Safari specifically for storage,
  PWA and theme behaviour.

---

## Merge blocker check

Per the audit's release matrix, this branch is **not ready to merge**:

- P0s: three found, three fixed, each with tests. ✅
- Rollback: drilled. ✅
- Progress integrity: timezone fixed and tested, Continue Reading no longer
  depends on library membership; storage durability is still not addressed,
  because Phase 2 is deferred. ⚠️
- Accessibility: zoom restored, contrast now passes AA in every palette,
  touch targets checked. Keyboard and screen-reader passes are not done. ⚠️
- UI/UX gauntlet: U1, U2, U4, U7–U14 pass; U3, U5, U6 and U15 need a
  populated library and a real reading session; U0 is a product decision left
  to Klyde. ⚠️
- Browser/device matrix: Chromium only, at three widths. ❌

The remaining blockers are the ones that need a person, a real device, or
both — not more code.
