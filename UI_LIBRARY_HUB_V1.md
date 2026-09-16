# Yomu Library Hub v1 — exploration implementation

Branch: `feature/yomu-library-hub-v1`

Rollback snapshot: `backup-main-before-ui-v1-2026-09-16`

Base commit: `acc81ea4402a61423039091c9b8c7a06c22fe1a2`

## Purpose

Try the Library Hub + Reader Deck direction on the real Yomu application while keeping production and the source/runtime stack unchanged.

The design rule is **progressive disclosure, not feature removal**. The calm home surface is allowed to be simpler; downloads, tracking, sources, repositories, runtime bridges, diagnostics, migration, import/export and advanced reader settings remain reachable.

## What this branch changes

Only three runtime files are involved:

- `dist-app/yomu-library-hub.css` — adaptive presentation layer.
- `dist-app/yomu-library-hub.js` — greeting/profile/home additions and Reader Deck.
- `worker/index-v7.ts` — injects those two files into successful GET HTML responses.

The UI files own only `yhub-*` classes / `data-yhub-*` attributes.

The existing Yomu brand stays authoritative. The new mark + animated live `Yomu` letter lockup and the 12-frame page-turn loader are reused; the older static wordmark is not reintroduced.

## Existing systems deliberately left alone

- Source Fabric / Recipe Engine v7.5
- Hunter
- source providers and extension registry
- sync and Circle data model
- adult gate
- compiled Expo bundle
- onboarding source-selection and pairing logic

`/start` keeps its existing first-run state machine and source setup. Library Hub only lets the global brand/UI layer sit around it.

## Adaptive behavior

### Desktop / wide web

- Existing desktop navigation remains.
- Home gets a calmer greeting/resume panel and status cards.
- The feature deck keeps power surfaces one click away.
- Profile/customization opens as a centered sheet.

### Phone portrait

- Existing Yomu mobile dock remains primary navigation.
- Home collapses to one column.
- Feature cards become a horizontal rail.
- Profile is a bottom sheet.
- Reader Deck is a thumb-reachable bottom sheet.

### Phone / small tablet landscape

- Reader Deck changes from bottom sheet to a compact right-side rail.
- Artwork keeps the remaining horizontal space.
- Rotation is detected live through CSS media queries and the JS preference event.

## Reader presets

The top-level choices are intentionally simple:

- Manga — paged / RTL / smart fit intent
- Manhwa — continuous / width fit / seamless intent
- Comic — paged / LTR / smart fit intent

The deck also stores fit, page gap, background, crop, prefetch, fullscreen and per-series preference state.

When an existing compiled reader control with an obvious matching label is present, the deck clicks that real control instead of duplicating its behavior. It also emits `yomu:reader-ui-pref` so the compiled reader can later consume the complete preference object cleanly.

## Profile / identity

The layer reuses the app's existing keys where they already exist:

- name: `yomu.v1.circle`
- avatar: `yomu.v1.avatar`
- appearance: `yomu.appearance`

Library-Hub-only preferences use their own namespace:

- `yomu.ui.hub.greetingTone`
- `yomu.ui.hub.density`
- `yomu.ui.hub.reader`
- `yomu.ui.hub.readerSeries`

The five existing avatar assets are reused unchanged.

## Rollback

### Fastest rollback

Keep `main` unchanged and simply stop using this branch.

### If this branch were later merged and needed to be backed out

Revert the Library Hub merge commit, or remove:

1. `dist-app/yomu-library-hub.css`
2. `dist-app/yomu-library-hub.js`
3. the `injectLibraryHubUi(...)` wrapper/function from `worker/index-v7.ts`

No data migration is required. The `yomu.ui.hub.*` localStorage keys are optional and ignored by the old UI.

### Nuclear rollback floor

`backup-main-before-ui-v1-2026-09-16` points at the exact pre-experiment `main` state.

## Before merge to main

Do not merge based on screenshots alone. Verify at minimum:

- desktop wide viewport
- desktop narrow viewport
- 390 × 844 phone portrait
- phone landscape around 844 × 390
- light / dark / system appearance
- first run `/start?redo=1`
- Home with empty library
- Home with saved titles and reading progress
- Reader long-strip chapter
- Reader paged manga chapter
- Sources / Source Fabric command center
- Downloads, You, Settings, Library and Discover navigation
- reduced-motion preference

Production deploy remains main-only. This branch is an experiment until explicitly promoted.
