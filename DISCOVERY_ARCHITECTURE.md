# Discovery and recommendations — what exists, what was built, what is blocked

Written 2026-09-18, against `main` at the discovery-engine commit. Every
`file:line` in here was read, not recalled; they drift, so treat them as
starting points rather than coordinates.

The short version: **Yomu already had more discovery machinery than it looks
like**, a canonical-title merge good enough to build on, and no database at
all. The rankings were the missing piece, and they turned out not to need
building.

---

## A. What already existed

### On the home screen

The app bundle owns the hero carousel, "Your library", the cover grid, the
genre chips, and — this is the one that surprised me — **a working
Manga / Manhwa / Manhua filter**. It is the `.m-seg` tablist under "Find your
next obsession", and it filters by MangaDex `originalLanguage`:
`ja` / `ko` / `zh,zh-hk`, plus a Completed segment on `status`.

`yomu-shell.js` adds, and re-asserts against React on every pass:

| Section | id | Where |
|---|---|---|
| Continue reading | `#yomu-continue` | `mountContinue()`, yomu-shell.js:659 |
| New chapters | `#yomu-fresh` | `mountFresh()`, yomu-shell.js:3381 |
| Because you read … | `#yomu-because` | `mountBecause()`, yomu-shell.js:3408 |
| Masthead greeting | `#yomu-greet` | yomu-shell.js:3520 |
| Grid order and junk filter | — | `globalThis.__yomuGrid`, yomu-shell.js:750 |

So **"Continue Reading", "Because You Read…" and "New & Updated" from the
brief already existed.** Building them again would have put two disagreeing
rails on one screen.

### On Discover

The dock's Discover button goes to **`/find.html`**, not `/discover` —
patched in `tools/patch-bundle.mjs` ("nav: Discover tab opens the merged
search page"). `/discover` is a different screen entirely: it finds *sources
to add*, not titles to read.

`find.html` is hand-written, 789 lines, and already has cross-source search,
search history, browse-by-genre (MangaDex tags), and two chart tabs backed by
`/api/catalog/popular` and `/api/catalog/latest`. It had no type split and no
trending.

### What did not exist anywhere

**Any Yomu-computed ranking.** Not popularity, not trending, not rating, not
score. Every ordering signal in the codebase is either borrowed from an
upstream API (`order[followedCount]=desc`) or is relevance/health ordering.

This was deliberate and documented. `find.html:294`:

> Hottest, Newest and Most Popular are in the asset set and deliberately
> unused: no source here publishes a ranking or an added-date, and the app
> already refuses to invent one.

`dist-app/tags/hottest.svg`, `most-popular.svg` and `newest.svg` have zero
references in the repo. They were drawn and then left alone on principle.
**That principle is why this work is possible now** — there is finally a real
ranking signal to hang them on, and it still is not invented here.

---

## B. The files that matter

| Concern | File |
|---|---|
| Canonical title merge | `worker/catalog.ts` — `CatalogEntry:204`, `dedupe():227`, `attach():248` |
| Catalog HTTP surface | `worker/routes-extensions.ts` — `handleCatalog():327` |
| Home injection | `dist-app/yomu-shell.js` — `pass():3793` drives 22 mounts |
| Discover | `dist-app/find.html` |
| Reading history | `localStorage` — see D below |
| Adult gate | `dist-app/yomu-gate.js`, `routes-extensions.ts:129` |
| Bindings | `wrangler.jsonc` |

> **`grep` silently fails on `dist-app/yomu-shell.js`.** It reports zero
> matches where a dozen exist. Search that file with python. This cost a whole
> duplicate greeting implementation before it was noticed.

---

## C. What was reused

**The canonical-title merge, unchanged.** `worker/catalog.ts` already
collapses one series across sources, in three layers: hard keys
(`al:<anilistId>`, `md:<mangadexId>`), exact normalised title, then a Dice
bigram fuzzy match at 0.87 with an author-similarity veto. `normalizeTitle()`
(catalog.ts:143) already strips "manga|manhwa|manhua|webtoon|colored|season|
part|vol". This is good work and the brief's `CanonicalTitle` /
`SourceTitleMapping` entities already exist as `CatalogEntry.providers`.

**The shell's mount pattern**, for placement: anchor, signature, re-assert.
It is the pattern that survives React on this app.

**The adult gate**, end to end. `yomu.v1.adult` client-side, an `adult` flag
that drops nsfw providers in the Worker (`routes-extensions.ts:129`), and
`isAdult: false` on every AniList query. The rails inherit it rather than
reimplementing it.

**The reading history already on the device.** No new tracking was needed for
a taste profile — `yomu.v1.resume.local-account.<id>.read` is a list of
finished chapters per series, and that is the strongest implicit signal there
is.

---

## D. What had to be added

**Rankings**, which is the whole of the gap. Also: a taste profile, a
diversity pass, a type split that is actually true, and an interaction log
shaped for later use.

### The data Yomu keeps about a reader

All client-side. Nothing is uploaded unless Sync is paired, and Sync carries
library and progress only.

| Key | Shape |
|---|---|
| `yomu.v1.collection` | `{ revision, sources[], library[], progress{} }` |
| `yomu.v1.resume.local-account.<seriesId>` | `{ sourceSeriesId, anchor:{chapterId,pageIndex} }` |
| `…<seriesId>.read` | `string[]` of finished chapter ids |
| `yomu.v1.reading` | shell's index, keyed `sourceId:seriesId`, capped at 30 |

**There is no reading-status model.** No favourite, no dropped, no completed,
no rating. Only saved/not-saved, `hidden`, and a free-text `folder`. The
brief's signal table assumes all of these; the event weights are defined for
them and currently only some can fire.

### One thing worth fixing separately

Three keyings of the same concept coexist: the bundle uses
`` `${sourceId}::${id}` `` (double colon) for library identity, while
`worker/sync.ts:150`, `yomu-sync.js:67` and `yomu-shell.js:285` all use a
single colon. The shell dodges it by matching on `id` rather than a key. Not
touched here, but whether `yomu-sync.js` translates correctly when pushing
`collection.library` deserves its own look.

---

## E. The architecture, and the two constraints that chose it

### Constraint 1 — there is no database

`wrangler.jsonc` binds `ASSETS`, one KV namespace (`SYNC`), and env vars.
**No D1, no Durable Objects, no R2, no Analytics Engine, no Queues.** KV's
free tier is 1,000 writes/day and Sync, Circle and Mori already share it —
`mori.ts:138` sizes its own budget around exactly that.

D1 *is* available on the account and unused. Adding it is possible. It is a
decision, not a detail.

### Constraint 2 — AniList blocks the server

```
403  "You have been manually blocked. Please come to the principal's office."
```

AniList refuses datacentre egress, and every Cloudflare Worker shares one
address. No amount of caching or backoff changes a manual block. The reader's
own browser is not blocked and AniList sends
`access-control-allow-origin: *`.

### What those two force, and why it is the right answer anyway

**Local-first.** Global rankings are fetched browser-side and cached per
device; the taste profile is computed on-device from history that is already
there.

That is not a compromise. Yomu has never uploaded reading behaviour — the
Circle feature is built around not leaking even a commenter's *name* past a
spoiler gate, and Sync refuses to store an avatar photo. A cross-user
recommendation engine would mean uploading what everybody reads, which is a
product decision this codebase has repeatedly declined to make.

```
  browser                                  worker
  ───────────────────────────────────      ──────────────────────────────
  yomu-rank.js     taste, scoring,         /api/catalog/similar
                   diversity, rails          AniList → MangaDex floor
       │                                     (AniList 403s here; the
       ▼                                      route survives as the floor)
  yomu-anilist.js  per-title metadata
       │           localStorage, 7d        /api/catalog/{popular,latest,
       ▼                                    search,related,tag,chapters}
  graphql.anilist.co                         canonical merge, per request
                                             worker/catalog.ts
  yomu-rails.js    Home + Discover UI
```

### Weights are data

`WEIGHT` in `yomu-rank.js`: taste .30, similarity .20, community .15,
behaviour .15, quality .10, freshness .10. A test asserts they sum to 1 so no
dimension is silently doubled. Changing the balance is editing an object.

---

## F. Schema changes

**None, and that is the finding.** The brief proposes `UserTasteProfile`,
`UserInteraction`, `RankingSnapshot`, `TrendingScore`, `RecommendationCache`
and others. With no database, they live as versioned localStorage keys:

| Key | Holds | TTL |
|---|---|---|
| `yomu.v1.rails` | global rankings per type | 6h |
| `yomu.v1.anilist` | per-title metadata, 120 max, LRU | 7d |
| `yomu.v1.taste` | the derived profile | 1h, dropped on a finished chapter |
| `yomu.v1.events` | interaction log, 400 max | decays, never expires |

`yomu.v1.events` is the one shaped for a future that does not exist yet. It
records typed events with timestamps rather than a running score, so
collaborative filtering or a learned ranker could be trained on it later
without the history having been thrown away.

**If D1 is ever added**, the natural first table is a persisted
`CatalogEntry` — the canonical merge is recomputed on every single request
today and discarded (`routes-extensions.ts:443`). That is the cheapest real
win available, and it is not a recommendation feature.

---

## G. Backend changes

One new route, one new module, nothing removed.

| Route | Purpose |
|---|---|
| `GET /api/catalog/similar?title=` | AniList first, MangaDex floor, Cache API 24h |

Matched **before** the `/api/catalog/` prefix in `worker/index.ts` so the
prefix does not swallow it. `/api/catalog/related` is untouched —
`yomu-shell.js` renders the series page's related row from it.

`worker/similar.ts` logs its failures by kind: an HTTP status, a GraphQL
error and an unindexed title have different fixes, and one "had nothing" line
could not tell them apart. That distinction is what found the 403 in a single
deploy.

---

## H. Landing page

Three rails, added below everything the shell owns, above nothing:
**For you**, **Trending now**, **Hidden gems**.

Not added: Because you read, New chapters, Continue reading — the shell has
all three, and its New chapters is the better one because it reads Yomu's own
source activity where AniList only knows when a series *started*.

### The placement rule, which is load-bearing

`orderFeed()` (yomu-shell.js:3446) re-asserts the chain
continue → fresh → because after the hero on every mutation pass. Anchoring
new rails to `#yomu-continue` puts them *between* two sections another
observer is actively ordering: it moves one up, the other moves back down,
and the page rewrites itself at frame rate. The same trap once locked a
browser tab when two injected Settings groups each positioned against the
other's neighbour.

The rails anchor below the **last** element of that chain and settle once
(`if (built.isConnected) return`). Verified: 0 DOM moves in 3 seconds.

---

## I. Discovery page

`find.html` gets a `#yomu-rails-here` mount point above Browse-by-genre, and
five rails behind four type tabs (All / Manga / Manhwa / Manhua). Search,
history, genres and the existing charts are untouched.

Each rail is a different question and therefore a different sort — a test
asserts no two rails are the same query, because ranking everything by one
number is how a directory ends up showing the same ten titles in six places.

| Rail | Sort | Extra |
|---|---|---|
| Trending now | `TRENDING_DESC` | momentum, not lifetime popularity |
| Most read | `POPULARITY_DESC` | |
| Highest rated | `SCORE_DESC` | AniList weights by rating count already |
| Hidden gems | `SCORE_DESC` | `averageScore_greater: 75, popularity_lesser: 20000` |
| New series | `START_DATE_DESC` | `status: RELEASING` |

### Why `countryOfOrigin` and not the source's category

Source metadata cannot do this split. `yomu-shell.js:697` says why, from
having tried:

> Weeb Central — the largest source here — sets no category at all, and
> Webtoons.com sets "webtoon". Filtering to the three named kinds would
> delete both.

KR, JP and CN are stated facts about a work. The home screen's existing
`.m-seg` reaches the same answer by a different route (MangaDex
`originalLanguage`), which is a reasonable second opinion rather than a
conflict.

---

## J. Refresh strategy

Nothing is scheduled, because nothing needs to be. The rankings are
maintained continuously by AniList; Yomu reads them on a TTL.

| What | When | How |
|---|---|---|
| Global rankings | 6h TTL, per device | `yomu.v1.rails`, refetched on next view |
| Title metadata | 7d TTL | a title does not change what it is like |
| Taste profile | dropped on `yomu:chapter-complete` | rebuilt lazily |
| Counters | route change, tab visible, reader exit | `yomu-progress.js` |
| Chapter freshness | whatever the sources say | unchanged, shell-owned |
| Worker AniList cache | 24h, Cache API | not KV — the write budget is Sync's |

Stale beats empty: a failed refresh returns the last good answer rather than
nothing.

---

## What is not built, and what would unblock it

| Wanted | Status |
|---|---|
| Trending among *Yomu* readers | **Blocked.** Needs cross-user aggregation → a database and uploading reading behaviour. |
| Collaborative filtering | **Blocked**, same reason. `yomu.v1.events` is shaped to feed it later. |
| Server-side ranking snapshots / cron | **Not needed.** Nothing to precompute when upstream maintains it. |
| Favourite / dropped / completed | **Blocked on a product decision.** No reading-status model exists; the weights are defined and waiting. |
| `RECOMMENDATION_IMPRESSION` | Not wired. Cheap, but it is the one event that is noise until something reads it. |
| Persisted canonical catalog | Wants D1. Best available win, unrelated to recommendations. |

### Honest weaknesses in what did ship

- **The chat tool gets the weaker recommendations.** `find_similar` runs
  server-side mid-request and cannot borrow the reader's IP, so it falls
  through to MangaDex. The tap menu, which runs in the browser, is better.
- **The taste profile warms from at most 5 titles.** A reader with sixty
  saved series is profiled from their five most-read. Bounded on purpose;
  raising it costs requests.
- **`similar` needs a reasonably full title.** "Omniscient Reader" resolves;
  "Omniscient Reader's Viewpoint" resolves; "solo levelling" does not.
- **None of it has met a real library.** Production reported 0 chapters read
  at the time of writing, so the personalised half is verified against seeded
  data only.

---

## Verifying any of this

```bash
npx wrangler dev --port 8822 --local
node --test "tools/progression/*.test.js"
npm run typecheck
```

> The Claude browser pane keeps its tab `hidden`, where
> `requestAnimationFrame` never fires. `yomu-shell.js` schedules `pass()`
> through rAF, so anything it mounts on a MutationObserver never appears and
> the masthead greeting looks broken when it is not. Force a pass with a
> dummy DOM mutation, or measure layout by building the node yourself.
