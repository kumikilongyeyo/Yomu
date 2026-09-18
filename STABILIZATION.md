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
| 7 | P1 consolidate Continue Reading on one ReadingHistory | — | **not done — see below** |
| 8 | P1 version + clean service-worker caches | `f252b7e` | done |
| 9 | P1 per-series metadata / canonical URL | `b856132` | done |
| 10 | P1 automated smoke tests | `686559a` | done |

### Verification

- Unit suite: **243 pass, 0 fail**, and the same under `TZ=Asia/Manila`,
  `TZ=UTC` and `TZ=America/New_York` — the progression tests were silently
  asking a timezone question and now pin one.
- `npm run typecheck`: clean.
- `npm run gauntlet`: **31 passed, 0 failed** (G1, G2, G3, G8, G11).

---

## Not done, and why

### Item 7 — one canonical `ReadingHistory`

Deliberately deferred. This is the audit's own Phase 2, not Phase 1: it is a
storage refactor with a migration, and the audit's rule is *do not silently
change storage schema without versioning and migration tests*. Doing it in the
same pass as six correctness fixes would mean a release where a progress bug
and a storage migration cannot be reverted independently — which is the exact
failure the branch strategy exists to prevent.

It should be its own branch (`refactor/reading-history-store`), with the
IndexedDB move, so that a migration failure is revertible on its own.

### Phases 2–7

Untouched, as scoped: storage durability (IndexedDB), frontend consolidation
off the compiled-bundle patch layer, reader/series/discover polish, Source
Continuity (CanonicalTitle graph, chapter normalization, provider health and
failover), and the release candidate.

One note toward Phase 5: `/title/<slug>` shipped here is the shape a real
CanonicalTitle id slots into without changing a caller. The path stays
`/title/<id>`; only what resolves it changes.

### P2 items

Adult-gate DOM observation, route-level code splitting for Discover/Search,
mixed `.html` + extensionless route conventions, and first-run setup friction
are all still open. The route-convention one is now partly documented: the
asset server answers `/find.html` with a 307 to `/find`, which the gauntlet
relies on.

---

## Gauntlet coverage

Automated (`npm run gauntlet`), so they run on every change:

| Gate | What it holds |
|---|---|
| G1 | typecheck, unit suite, `patch-bundle --check` |
| G2 | canonical title routing, including modified clicks |
| G3 | prepaint theme bootstrap on every primary route, one owner |
| G8 | shell cache versioned, bounded, scoped cleanup, API never cached |
| G11 | image proxy refuses link-local and `file:`, metadata is escaped |

Still manual, and required before a merge to `main`:

- **G4** capability API timeout / malformed / provider failure against a live
  bridge. The unit tests cover the decision; the network shapes are not faked.
- **G5** reader: vertical and paged, chapter transitions, chrome, resume.
- **G6** progress across a real local midnight on a device.
- **G7** storage: fresh user, established user, malformed values, quota.
- **G9** source switching with a dead preferred source.
- **G10** performance against a baseline with realistic title counts.
- **G12** regression sweep across all primary routes.
- The whole **UI/UX gauntlet** (U0–U15) and the browser/device matrix.

---

## Merge blocker check

Per the audit's release matrix, this branch is **not ready to merge**:

- P0s: three found, three fixed, each with tests. ✅
- Rollback: drilled. ✅
- Progress integrity: timezone fixed and tested; storage durability is not,
  because item 7 and Phase 2 are deferred. ⚠️
- UI/UX gauntlet: not run. ❌
- Browser/device matrix: not run. ❌

The remaining blockers are the ones that need a person on a device, not more
code.
