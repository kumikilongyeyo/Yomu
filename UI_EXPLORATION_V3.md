# Yomu UI/UX Exploration v3

This branch exists to explore the next Yomu interface without putting the current production UI at risk.

## Safety / rollback

- Production branch: `main`
- Frozen pre-exploration backup: `backup-ui-pre-exploration-2026-09-16`
- Exploration branch: `explore-ui-ux-v3`
- Production Cloudflare deploys are triggered by pushes to `main` only.
- Hunter, Source Fabric, Worker source routing, extension recipes, and source packs are intentionally out of scope for this branch.

If this direction does not feel right, discard `explore-ui-ux-v3`. Production and the backup branch remain unchanged.

## Direction

Use Paperback and Synthetiq Books as feature/organization benchmarks without copying either product.

Yomu's target combination:

- Paperback-level reader/source capability
- Synthetiq-level calm, personal reading experience
- Yomu Hunter + Source Fabric automation so the user does not babysit sources
- Preserve advanced capability through progressive disclosure instead of removing features

## Added in this exploration pass

### Yomu identity and loading

- Uses the existing Yomu mark, wordmark and loader assets under `dist-app/brand/`.
- Branded opening animation supports light/dark appearance.
- Existing loading/status spinners can be replaced by a small Yomu mark animation.
- Reduced-motion users do not get continuous animation.

### Reader profile

- Local display name.
- Five existing Yomu reader avatars.
- Greeting mood: Mixed, Dark, Wholesome, Neutral, Friendly.
- Appearance: System, Light, Dark.
- Home density preference: Calm, Balanced, Dense.
- Profile settings are local-only in this exploration pass.

### Greetings

- Uses the existing `window.YOMU_GREETINGS` pack rather than inventing a second greeting system.
- Respects time of day.
- Can filter the pack by the selected greeting mood when that tone exists.
- Profile name is shown separately so the original greeting lines do not need to be rewritten.

### Adaptive reader controls

Presets:

- Manga — paged intent, RTL, smart fit
- Manhwa — continuous intent, width fit, zero default gap
- Comic — paged intent, LTR, smart fit

Controls exposed in the exploration deck:

- Fit: smart / width / height / original
- Page gap
- Reader background
- Prefetch amount
- Border crop preference
- Remember settings for this series
- Fullscreen

The preferences are persisted locally and exposed as `yomu:reader-prefs` events so the final reader implementation can consume them without coupling the UI layer to the minified Expo bundle.

### Mobile orientation

- Portrait: reader controls behave as a bottom sheet near the thumb zone.
- Landscape phone/tablet: controls become a compact side rail.
- Safe-area insets are respected.
- Orientation changes dispatch `yomu:orientation` so the final reader layout can switch between long-strip and wide paged presentation cleanly.

## Files

- `dist-app/yomu-explore-v3.css` — isolated exploration styles.
- `dist-app/yomu-explore-v3.js` — profile, greeting, loading, theme and reader-deck behavior.
- `dist-app/yomu-gate.js` — branch-only bootstrap loads the two files above on compiled screens while retaining the existing adult-content gate responsibility.

All new UI selectors use `yx-` / `data-yx-` naming so the experiment is easy to identify and remove.

## Important limitation

This first pass intentionally starts on the compiled/Expo screens that already load `yomu-gate.js`. Hand-written pages such as some source-management surfaces should be brought into the same shell only after the core direction is approved. That prevents us from doing a wide rewrite before the interaction model is settled.

## Manual test checklist before merging anything

- Home: greeting appears once and does not cover Continue Reading.
- Profile: name and all five avatars persist after reload.
- Greeting moods use the existing greeting pack.
- System / Light / Dark remain readable.
- Loading animation disappears reliably and honors reduced motion.
- Reader portrait: controls are reachable with one thumb and do not cover the page permanently.
- Reader landscape: controls move to the side and respect safe areas.
- Rotate portrait → landscape → portrait while the reader is open.
- Manga / Manhwa / Comic presets persist.
- Per-series preference does not overwrite unrelated titles.
- Escape closes profile/reader sheets on desktop.
- Current 18+ gate still mounts in Settings and still veils provider-rated adult media.
- No changes appear in Hunter/Fabric/Worker/source-pack diffs.
