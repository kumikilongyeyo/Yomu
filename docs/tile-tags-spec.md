# Yomu tile tags — spec

A tag is any small mark a tile carries besides its cover, title and source: a
freshness tab, a rating, a reading position, a circle dot, a rail badge, a
seal. This document fixes what the tags **mean**, where their **data** comes
from, which **slot** each one occupies, how they **stack** when several land
on one tile, and how they must behave for **accessibility** and **motion**.

It does not fix how they look. Shape, colour, iconography, type, corner
radius, whether a tag is a pill, a tab, a ribbon or a dot, whether it uses an
image asset or CSS: all of that is open. The one visual rule is the theming
one already in force across the app, stated in section 7.

Prepared 18 September 2026 against `kumikilongyeyo/Yomu` at `382bda2`.


## 1. The tiles

Three tile shapes exist and every tag must know all three, because the same
title appears in all of them.

| Shape | Where | Root | Title | Footer (text block over the cover) | Owner |
|---|---|---|---|---|---|
| Grid tile | Home (Your library, the popular grid), the app's Search results | `.tile-card[data-series]` | `.tile-card__title` | `.tile-card__footer` | React bundle (do not edit); shell decorates |
| Discover tile | `/find` results | `.tile` | `.tile-copy .t` | `.tile-copy` | `find.html` (hand-written, editable) |
| Rail card | Discover rails, Home rails, the roulette landing | `.yr-card` | `.yr-card__title` | the card body under the art (`.yr-card__art` holds the cover) | `yomu-rails.js` (editable) |

The grid and Discover tiles are 2:3 covers with the copy laid **over** the
bottom of the artwork on a dark gradient. The rail card is a cover with the
copy **under** it on the page ground. This difference decides a tag's colour
rules (section 7) and is the main reason the spec speaks in slots, not
pixels.

The hero carousel and the list rows on the Library screen are not tiles and
carry no tags. The chapter rows on a series page carry their own marks
(circle talk counts, race ticks); they are out of scope here.


## 2. The slot model

Every tag declares exactly one slot. A slot is a region of the tile with an
owner order, so two tags never fight for the same pixels.

```
 ┌──────────────────────────────┐
 │ [A] top-left stack   [B] ctl │   A: stacks downward, first-come order below
 │  A1                          │   B: one control (the save bookmark), reserved
 │  A2                          │
 │                              │
 │                              │
 │                              │
 │  ── gradient begins ~60% ──  │   the lower third is the copy's; no tag sits
 │ [C] footer                   │   on the artwork below this line except in C
 │  title                       │
 │  source · chapter            │
 │  C-lines (tags as lines)     │
 └──────────────────────────────┘
```

**Slot A — top-left stack.** Tags that describe the *title's state on the
source or in your reading*: freshness, completed, progress, circle dot. They
stack downward in the fixed order of section 4; a tag that is absent frees
its row and the ones below move up. The stack is capped at three rows. If a
fourth tag qualifies, the lowest-priority one yields (it is dropped, not
squeezed). Each row is 22px tall today with 8px between the top and the first
row; the designer may change these values, but every tag in slot A must use
the same row metric so the stack stays a stack.

**Slot B — top-right control.** The save bookmark. It is a button, not a tag,
and the slot is reserved for it: no tag may be placed within 44px of the
top-right corner, because that is the touch target on a phone. A tag that
would land there moves to the left of it (the circle dot already does this).

**Slot C — footer lines.** Tags that describe the *title itself*: the rating,
and the app's own "Hot". They are lines or chips inside the footer block,
after the source line, never over the artwork above the gradient. A footer
tag must not push the title off the tile: the title keeps its two-line clamp,
and footer tags are the first thing to give way on a short tile.

**Slot D — rail badge.** Rail cards have one top-left badge (`.yr-badge`)
naming the rail's reason: Trending, Gem, New. A rail card has no slot A
stack; its rating and reader count are body lines under the title.

**Slot E — full-cover state.** Not a tag but a state of the whole tile: the
18+ blur from the adult gate. When it is on, slots A and C still render, over
the blur, so a blurred tile still says it has a new chapter.


## 3. Stacking and priority

When several tags qualify for slot A, this is the order from the top, and it
is fixed:

1. Freshness (New chapter / Updated) — time-sensitive, changes daily
2. Completed seal — a fact about the title
3. Progress (Ch. N) — a fact about you
4. Circle dot — a fact about your friends

Rationale: the thing that changed most recently goes first; a title's
permanent facts next; your position next; what others did last. The circle
dot is the smallest mark and is the one that yields when the stack is full.

Slot C order, top to bottom under the source line: Hot, then rating. Hot is
the app's own and sits where it always did.

Two tags may **never** overlap. The current rule set does this with
`:has()` selectors that move the lower tag down or right when the upper one
is present (progress drops to 38px under a freshness tab; the circle dot
moves right of both). A restyle may replace the mechanism but must keep the
guarantee, and must keep it when the tile is 120px wide.


## 4. The tag inventory

| Tag | Means | Slot | Shown when | Data | Refresh | Hook today | Owner |
|---|---|---|---|---|---|---|---|
| New chapter | The source published a chapter since you last saw the title | A1 | Source says so | App's own feed state | Every source poll | `.freshness--new` | React bundle |
| Updated | The source changed something other than a chapter | A1 | Source says so | App's own feed state | Every source poll | `.freshness--updated` | React bundle |
| Completed | The title's status is complete | A (after freshness) | `.tile-card__status` text reads "Completed" | Source status | On render | `.tile-card[data-yomu-tag='completed']` (seal drawn on the cover's `::before`) | `yomu-shell.js` |
| Progress | The chapter you are on | A (after completed) | A reading position exists for the series | Reading index `yomu.v1.reading` | Every shell pass | `.yomu-tile__progress` text "Ch. 41" | `yomu-shell.js` |
| Circle dot | Your circle has comments you may read and have not opened | A (last, or right of the stack) | Joined a circle; count > 0 | `/api/circle/unread`, one call per grid, 5-min cache | On pass, invalidated when a thread is opened | `.yomu-tile__circle` | `yomu-circle.js` |
| Hot | The source lists the title as hot | C | Source says so | App's own feed state | On render | `.tile-card__hot` (flame icon + "Hot") | React bundle |
| Rating | AniList community score, out of ten | C (last) | AniList knows the title and has a score | `yomu.v1.anilist` cache; lookups one per 2.6s, 20 per page, visible tab only | On pass; a miss is remembered a week | `.yomu-tile__rating` (grid, Discover) · `.yr-card__rating` (rails) | `yomu-ratings.js`, `yomu-rails.js` |
| Rail badge | Why this card is in this rail | D | Always on rails that declare one | Rail definition | On rail build | `.yr-badge` | `yomu-rails.js` |
| Status | Ongoing / Completed / Hiatus, as text | — | Never as text | Source status | — | `.tile-card__status` (hidden; it feeds the seal) | React bundle |
| Adult | The title is 18+ and not unlocked | E | The gate says so | `yomu.v1.adultTitles`, the gate | On pass | The gate's own classes | `yomu-gate.js` |

Image assets already in the repo for tab-style tags: `dist-app/tags/`
holds `new-chapter.svg`, `completed.svg`, `hottest.svg`, `most-popular.svg`,
`newest.svg` and `mature.svg` at a 152×32 or 132×32 ratio. Freshness and the
completed seal use two of them today. Hottest, Most Popular and Newest have
no signal the app currently emits and are unused.


## 5. States

Every tag must be drawn and checked in each of these; a restyle that only
checks the first is not done.

- **Alone** on a tile.
- **Stacked** with every other slot-A tag present at once, on a tile with a
  freshness tab, a completed seal, a progress chip and a circle dot, plus a
  rating and Hot in the footer. This is the worst case and it occurs.
- **Narrow**: a grid tile at 120px wide (a phone at two columns) and a rail
  card at 132px. Text tags truncate with an ellipsis; they do not wrap into
  a second row and do not clip.
- **Both modes**: Aurora and Paper, and at least one skin (Autumn or
  Midnight), because a skin forces its own palette over both.
- **Any accent**: the reader picks the accent; a tag that reads only in
  amber is broken.
- **Reduced motion**: no tag animates; the tile is the same tile.
- **Locked** (rails and shelf only): a greyed card must still show its
  badge readable.


## 6. Data and timing

A tag appears when its data is known and not before. Nothing shows a
placeholder, a spinner or a guess.

- Freshness, Hot, Status: the app's own render; instant.
- Completed, Progress: derived on every shell pass from what is already on
  the device; instant, re-asserted after every React render.
- Circle dot: one request for the whole grid, behind the spoiler gate on
  the server, cached five minutes, invalidated the moment a thread is
  opened. Never more than one request in flight.
- Rating: from the AniList cache when known; otherwise one lookup every
  2.6 seconds while the tab is visible, twenty per page, and a title AniList
  does not know is not asked again for seven days. Tiles therefore fill in
  over the first half minute of a page. That is accepted; a burst would hit
  AniList's per-address limit and take every other AniList surface down
  with it.

All decorated tags are re-asserted from a `MutationObserver` because React
discards nodes it does not own. A tag's node carries a signature
(`data-score`, `data-sig`) so an unchanged tag is left alone rather than
rebuilt at frame rate. A restyle must not introduce a rule that measures
one tag against another tag's position from a different observer; that is
how a page rewrites itself at frame rate.


## 7. The one visual rule

Text over artwork is not a theme colour. Anything in slots A and C on a grid
or Discover tile sits on a picture with a dark gradient under it; its text is
pinned light with a shadow in both modes, because the theme's ink on Paper
is dark and vanishes on the scrim, and because the gradient alone does not
cover a cover that is bright exactly where the tag lands.

Anything on a rail card sits on the page ground and takes the theme's tokens
(`--accent`, `--accentSoft`, `--accentLine`, `--raised`, `--text`), so it
follows mode, skin and accent for free. Do not hardcode a colour there.

Image-asset tags (the `/tags/*.svg` tabs) are drawn as-is and do not follow
the theme; that is a property of the asset, not a bug, and any new asset tag
must be legible on a bright cover and a dark one.

Everything else is open: shape, size within the row metric, icon, type,
whether the rating is a pill or a bare glyph, whether the circle dot is a dot
or a ring, whether freshness is a tab or a corner fold.


## 8. Accessibility

- Every tag has an accessible name that says what it means, not what it
  looks like: "Rated 8.7 out of 10 on AniList", "3 new circle comments",
  "Completed", "Chapter 41", "New chapter".
- Image tags keep their text in the accessibility tree; only the rendering
  is replaced (the freshness tab already does this with `font-size: 0` and
  a background image).
- Tags are not focusable and do not intercept taps; the tile is the target.
  The one exception is the save control in slot B.
- A tooltip (`title`) repeats the accessible name for pointer users.
- Reading order follows the visual order: slot A top to bottom, then the
  title, then slot C lines.


## 9. Adding a tag

1. Declare its slot and its position in the slot's order (section 3), and
   name the tag it yields to when the stack is full.
2. Name its data and its refresh rule (section 6). If it needs a request,
   it is one request per grid, cached, never per tile.
3. Class name `yomu-tile__<name>` on grid and Discover tiles, `yr-card__<name>`
   on rail cards. Milestone-style state classes go on the tile root as
   `data-yomu-tag`.
4. Mount into the slot's host (`.tile-card__cover` for A, `.tile-card__footer`
   or `.tile-copy` for C) from an observer pass, signed, re-asserted only
   when the signature changes.
5. Write the collision rules for every existing tag in the same slot.
6. Check the eight states in section 5.


## 10. Acceptance

- [ ] A tile with every slot-A tag shows all of them, none overlapping, the
      save control untouched, at 120px wide.
- [ ] A tile with only a rating shows it under the source line and the title
      still has two lines.
- [ ] Switching Aurora to Paper, and to a skin, changes no tag over artwork
      and recolours every tag on a rail card, with no reload.
- [ ] Changing the accent recolours rail tags and nothing over artwork.
- [ ] A screen reader reads each tag's meaning, in visual order.
- [ ] Reduced motion changes nothing on a tile.
- [ ] Opening Home with forty library titles makes at most one circle
      request and at most twenty AniList requests, spaced.
- [ ] Rebuilding the grid (React re-render) restores every decorated tag
      without a flash and without the page redrawing continuously.
