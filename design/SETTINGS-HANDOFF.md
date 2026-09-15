# Settings and first run — decided shape

Two documents sit beside this one. Open them in a browser; the prototype is
interactive.

| File | What it is |
|---|---|
| `settings-layout-study.html` | Three layouts for Settings, phone and desktop, measured against the live screen |
| `first-run-prototype.html` | The chosen shape, working: real switches, real counts |

## What was decided

**Option A + Option C.** A is the Settings diet: seven groups to four, with
sources behind one row that carries its own state. C is the first run: a
guided setup that ends with a home page that has something on it.

Not option B, the status board. Its diagnosis was right and its presentation
was wrong for this owner: latency figures are noise. What survives from it is
the plain working / not working state, and nothing finer.

## The rules the shape has to keep

**Source Fabric stays where it is, and stays prominent.** Measured on
2026-09-15: it sits 146px from the top of `/sources`, above the source list,
injected by `worker/index-v5.ts`. Option A moves *Settings rows* behind one
door; it must not move Fabric, bury it under a fold, or put it behind a
second tap. If the Sources destination is ever rebuilt, Fabric goes at the
top of it. This is the owner's explicit requirement, not a preference to be
traded off.

**The profile step is skippable. The sources step is not.** The whole reason
the flow exists is that a new install otherwise lands on an empty home page.
Continue stays disabled until at least one source is on.

**Counts are measured or absent, never estimated.** MangaDex is the only
source that publishes a catalogue size, and it publishes one per original
language — ja 75,579, ko 8,809, zh + zh-hk 6,378, 94,626 all told, each read
off its API on 2026-09-15. That is why the tally moves when you tick a kind
and why it carries a `+`. No other source reports a total; Weeb Central still
returns results on page 60 and never says how deep it goes. Do not sum a
first page and call it a catalogue.

**No latency anywhere.** A source is working or it is not reachable. Comick
is a third state — it finds titles and serves no chapters by design, and
saying "unreachable" about it is what made a working source look broken.

**The flow shows once.** Only when there is no library, no reading history
and no sync code. Everyone else lands on Home as before and reaches the same
screens from Settings → Sources.

## Not yet decided

- Whether preset profiles get drawn symbols instead of letters. Letters for
  now, by decision.
- Whether "Set up" on the Mihon bridge opens `/suwayomi-setup.html` inside
  the flow or navigates out to it.
