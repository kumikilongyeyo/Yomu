# Yomu Source Forge v3

Local adapter-forging companion for this Yomu project.

Yomu's production extension system is **declarative JSON**, not downloaded JavaScript. Forge v3 therefore generates the same descriptor shape used by `extensions/sources/*.json` and validates it before installation.

## Flow

`paste site or series URL → discover catalog → verify a series → sample first/middle/last chapters → discover reader images → expert gauntlet → generate Yomu descriptor → install/publish`

The Forge is intentionally local because Cloudflare Workers cannot run Playwright/Chromium to inspect arbitrary client-rendered reader sites.

## Run

From the Yomu project root:

```bash
npm run source:forge:install
npm run source:forge
```

Or open `tools/source-forge/` and use `start.bat` / `start.command`.

Forge opens at:

```text
http://localhost:8790
```

The Yomu Worker can keep using its normal local port (commonly `8787`).

## What Install does

**Install into project** writes the generated extension into the real Yomu extension system:

- `extensions/sources/<id>.json`
- `extensions/index.json`
- regenerates `worker/extensions/bundled.ts`
- if `../yomu-extensions-repo/` exists, syncs the same source and index there too

It bumps an existing source version automatically.

## Optional one-click GitHub publish

Set these only in your local shell / environment. The token is never sent to the browser:

```bash
YOMU_GITHUB_TOKEN=github_pat_...
YOMU_EXTENSIONS_REPO=kumikilongyeyo/yomu-extensions
YOMU_EXTENSIONS_BRANCH=main
YOMU_APP_URL=https://your-yomu.example
```

Use a fine-grained token with **Contents: Read and write** on the extension repository.

Then **Publish + refresh Yomu** creates one Git commit containing both the source descriptor and matching `index.json`, calls Yomu's `/api/ext/refresh`, and gives you the add-source link.

## Runtime upgrades included with Forge v3

Generated adapters use a few safe declarative features added to Yomu's existing engine:

- endpoint variable transforms (`split`, `urldecode`, etc.)
- `urlencode` / `urldecode` field transforms
- `srcset` normalization
- fallback HTML attributes via `attrs: []` for lazy-loaded images
- `pageMax` so a non-paginated catalog does not repeat page 1 forever
- HTML relative URLs resolve against the actual response URL, not only the site root

No generated descriptor executes code.

## Confidence

Forge samples multiple chapters and runs two checks:

1. extraction gauntlet — title/chapter/page reliability, duplicate traps, selector brittleness, cross-chapter image overlap
2. native Yomu gauntlet — catalog presence, source ID round-trip, chapter routing, host allowlist, generated endpoint completeness

The displayed combined score is the lower of both scores.

`95–100 BEAST`, `88–94 STRONG`, `75–87 USABLE`.

This is a confidence score, not a promise that a third-party website will never change.

## Boundaries

Forge uses normal browser access and extraction. It does not bypass logins, paywalls, CAPTCHAs, DRM, anti-bot challenges, or other access controls. Sources that require custom signing/private APIs may still need a native provider or Suwayomi bridge.
