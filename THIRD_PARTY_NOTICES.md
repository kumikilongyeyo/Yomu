# Third-party notices

What Yomu actually ships from someone else, and under what terms. Sources
that were only read for ideas are listed at the bottom, separately, because
"we looked at it" and "we shipped it" are different obligations.

---

## Shipped

### Prototype companion artwork — ChatKit

| | |
|---|---|
| Project | [xpert-ai/chatkit-js](https://github.com/xpert-ai/chatkit-js) |
| Copyright | Copyright 2025 Xpert AI, Inc. |
| Licence | Apache License 2.0 — `LICENSE`, `NOTICE` |
| What we ship | Five sprite sheets, re-encoded, in `dist-app/pets/prototype/` |
| What we do not ship | Any ChatKit code |

Files, and where each came from in that repository:

```
dist-app/pets/prototype/boba.webp          packages/chatkit-ui/public/pets/boba/spritesheet.webp
dist-app/pets/prototype/bolt.webp          packages/chatkit-ui/public/pets/bolt/spritesheet.webp
dist-app/pets/prototype/miso.webp          packages/chatkit-ui/public/pets/miso/spritesheet.webp
dist-app/pets/prototype/nukey.webp         packages/chatkit-ui/public/pets/nukey/spritesheet.webp
dist-app/pets/prototype/noir-webling.webp  packages/chatkit-ui/public/pets/noir-webling/spritesheet.webp
```

The sheets are unmodified in content and geometry — 1536 × 1872, eight
columns by nine rows of 192 × 208 cells — and were re-encoded as WebP at
quality 80. That is a change of compression only, and it took the five files
from 9.0 MB to 2.2 MB; the originals were stored at a quality far above what
a sprite drawn at 98 px can show.

The 9-row animation contract (`idle`, `running-right`, `running-left`,
`waving`, `jumping`, `failed`, `waiting`, `running`, `review`) is documented
in that repository's `docs/guides/pet.md`. Yomu's renderer, state machine,
surface rules and dialogue are its own; no ChatKit source was copied.

**Five of ChatKit's ten included pets are deliberately not shipped.**
`batmeme`, `steve`, `lando-2`, `einstein` and `mini-sama` appear to depict
third-party characters or real people. ChatKit's `NOTICE` asserts Xpert AI's
copyright over the project and makes no statement about the provenance of
individual artwork, and Yomu is publicly deployed. The five that are shipped
are the ones with no apparent likeness.

**This artwork is temporary.** It stands in for Mori until Yomu's own
character art exists. Replacing it is a change to `CATALOG` in
`dist-app/yomu-pet.js` and the files it points at; no progression, surface or
dialogue behaviour depends on it.

### Badge artwork and renderer — Yomu's own

`dist-app/yomu-badges.js`, `dist-app/yomu-badges.css` and
`dist-app/brand/badge-manifest.json` are original Yomu work, generated from
`yomu-mark.svg` and the palettes in `yomu-skin.css`. No third-party licence
applies. Listed here only so the inventory is complete.

### Recommendations — AniList

| | |
|---|---|
| Service | [AniList](https://anilist.co) GraphQL API, `https://graphql.anilist.co` |
| Docs | [AniList/docs](https://github.com/AniList/docs) |
| What we use | Manga search, ranked tags, and community recommendations |
| What we ship | No code and no data. Answers are fetched at request time. |

`worker/similar.ts` queries AniList for what readers of a series recommend
next. The value is not an algorithm — it is that AniList's users have voted on
"if you liked X, read Y", so a recommendation arrives with a count behind it
(Solo Leveling → Omniscient Reader is 1,387 readers). That is a body of human
judgement Yomu does not have to build, which is the whole reason to use it
rather than write a recommender.

No API key, no account, and no data is stored: answers are cached for a day in
Cloudflare's edge cache and nothing is persisted. AniList allows 30 requests a
minute **per IP**, and a Worker egresses from one shared address for every
reader at once, which is why the cache is load-bearing rather than an
optimisation.

Titles and vote counts are displayed as AniList returns them, attributed on
screen as reader votes. If Yomu ever needs a stronger guarantee than "a public
API that is up today", the fallback path below is the floor.

**Fallback:** a miss or an outage falls through to the existing MangaDex
tag-overlap route, so the worst case is the recommendation quality Yomu had
before this.

**Considered and not used:** [jikan-me/jikan](https://github.com/jikan-me/jikan)
(MIT), the unofficial MyAnimeList API. It has the same kind of community
recommendation data, but it is a proxy in front of MAL and returned
`504 — MyAnimeList may be down` when tested on 2026-09-18. A recommendation
feature should not inherit two upstreams' uptime when one will do.

---

## Read, not shipped

No code or assets from any of the following are in this repository. They are
recorded because they shaped the design and someone will reasonably ask
where an idea came from.

| Project | Licence | What was taken |
|---|---|---|
| [xpert-ai/chatkit-js](https://github.com/xpert-ai/chatkit-js) | Apache-2.0 | The sprite-atlas contract, and the idea of a pointer-transparent host overlay with a persisted position. Implementation is Yomu's. |
| [tonybaloney/vscode-pets](https://github.com/tonybaloney/vscode-pets) | MIT (code) | Behaviour vocabulary only — idle, walk, run, speech-bubble placement. **Its artwork is credited to many separate creators and was not used.** |
| [welltilln/desksprite](https://github.com/welltilln/desksprite) | MIT | Grab/throw physics, considered and deliberately not built. `petPhysicsEnabled = false` in `yomu-pet.js` marks where it would go. |
| [opensourcepod/habitSync](https://github.com/opensourcepod/habitSync) | MIT | The shape of a simple XP progress card. Yomu measures progress across the current stage instead of from zero, so the arithmetic differs. |
| [Litrudy/DesktopPet](https://github.com/Litrudy/DesktopPet) | **none declared** | Time-of-day dialogue buckets, a short no-repeat history, and a click cooldown — as ideas. No licence is declared on that repository, so nothing was copied. Yomu's dialogue is its own, and most of it predates this work in `yomu-greetings.js`. |
| [LorisYounger/VPet](https://github.com/LorisYounger/VPet) | code MIT; **animation assets carry separate terms, including for commercial use** | Read for behavioural breadth. No assets used, and none may be. |
| [shimeji-ai/Shimeji-AI-Pets](https://github.com/shimeji-ai/Shimeji-AI-Pets) | **none declared** | Studied conceptually. Nothing copied, and nothing may be until licensing is explicit. |

### The patch handoff's shortlist (2026-09-19)

The Yomu patch handoff named six projects for the chapter-end moment, the
animated progress bar and the Customize Look rebuild. **None of them is in
this repository**, and each was declined for a stated reason rather than
overlooked — the brief's own rule was to ship only code that earns its weight.

| Project | Licence | Proposed for | Why it was not shipped |
|---|---|---|---|
| [catdad/canvas-confetti](https://github.com/catdad/canvas-confetti) | ISC | The milestone burst | Yomu already draws one: `confetti()` in `yomu-streak-ui.js`, twenty-six CSS particles, reduced-motion aware, about a kilobyte. The chapter-end card calls that. A second particle system for the same half second is the duplication the brief warns about. |
| [kimmobrunfeldt/progressbar.js](https://github.com/kimmobrunfeldt/progressbar.js) | MIT | The streak/mileage bar | The bar is a straight CSS fill whose gradient *is* data — its size and offset say which heat colours the reader has reached. A library that owns the drawing would have to be taught that, and the brief asked for the existing bar to be juiced first. Worth revisiting the day Yomu wants a non-linear path. |
| [9am/fire-flame](https://github.com/9am/fire-flame) | MIT | Ember preset particles | The flame is already vector art per streak stage (`brand/flame/s1-6`). Two CSS keyframes flicker it and two pseudo-elements throw the Ember sparks, at no runtime cost and no bytes. A canvas particle layer behind a preset flag is a lot of machinery for two dots. |
| [radix-ui/primitives](https://github.com/radix-ui/primitives) | MIT | Accordion, select, slider, tabs behaviour | Behaviour reference only. The accordion is `<details>`/`<summary>` with one-open-at-a-time and scroll-into-view; the segmented control is a `radiogroup` with `aria-checked`. Importing React for a settings sheet in a vanilla app was explicitly ruled out. |
| [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | MIT | Compact settings layout | Layout reference only — the density targets (42px summaries, 34px rows, an 88px label column) came from the brief itself. Rebuilt in Yomu's own CSS. |
| [shoelace-style/shoelace](https://github.com/shoelace-style/shoelace) | MIT | Web Component control patterns | Reference only, and the repository is archived. |

Gradients remain [grapick](https://github.com/artf/grapick), already vendored
under `dist-app/vendor/grapick`. No second gradient editor was added.


---

## If this artwork is ever published beyond the prototype

Before treating the companion as shipped product rather than a prototype
stand-in, confirm the provenance of the five sheets with Xpert AI. Apache-2.0
on the repository covers what the copyright holder owns; it cannot grant
rights in a third party's character, and a sprite sheet is exactly the kind
of asset where that distinction matters. The cleanest resolution is Yomu's
own art, which the catalog is built to accept.
