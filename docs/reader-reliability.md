# Reader Reliability Pass

- Scroll mode mounts two pages behind and one to four ahead, depending on connection and data-saver preferences. Placeholder dimensions preserve layout when pages unmount.
- Removed the second speculative decode window. Next-chapter warming is limited to two images, with cancellation on chapter changes and a 12-second cleanup deadline. Manifest handoffs retain at most three entries.
- Continuous chapters is opt-in in Reading settings. A preview divider appears after the current chapter; scrolling into it opens the prefetched chapter through the existing router. The URL and progress move with the chapter.
- Page mode renders a single fitted page. Spread renders two pages on wide screens. Both support RTL tap zones, arrow keys and the page slider.
- Settings include maximum width, page gap, reading direction and image quality. Data saver limits preloads and selects MangaDex's smaller image variant when available; sources without smaller variants keep their originals.
- Direct chapter links load the same recovery and integrity helpers as in-app navigation.
- Page rescue uses same-source retries and an alternate proxy. Page-level cross-source substitution now requires matching content hashes; equal page counts alone are insufficient. Whole-chapter recovery retains the existing proportional page anchor when layouts differ.
- Two agreeing peer counts can flag an extreme short outlier as uncertain. Declared compact layouts and learned slicing ratios take precedence. Low confidence lowers ranking without blocking the only readable copy.
- Source picker labels use verified quality and response time. Mobile sheets respect safe areas, center taps toggle chrome, and a compact progress indicator remains visible.

## Verification

`npm test`, `npm run typecheck`, `node tools/patch-bundle.mjs --check`, and `node tools/gauntlet.mjs --offline`.

`npx playwright test tests/reader-reliability.spec.js` covers a 160-page chapter, bounded mounted images, panel resume after resize/reload, paged/RTL/spread controls, next-chapter navigation and image retry recovery.

`npx playwright test --config=playwright.reader-webkit.config.js` runs the same tests in WebKit with the iPhone 13 profile. Physical-device memory pressure and arbitrary third-party outages cannot be established by emulation. Cross-source position is approximate unless content correspondence is known. Continuous mode hands off between chapters rather than retaining every preceding chapter in memory.
