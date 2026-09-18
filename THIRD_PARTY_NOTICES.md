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

---

## If this artwork is ever published beyond the prototype

Before treating the companion as shipped product rather than a prototype
stand-in, confirm the provenance of the five sheets with Xpert AI. Apache-2.0
on the repository covers what the copyright holder owns; it cannot grant
rights in a third party's character, and a sprite sheet is exactly the kind
of asset where that distinction matters. The cleanest resolution is Yomu's
own art, which the catalog is built to accept.
