# Yomu Source Forge v3 — handoff

## What changed

Yomu already had the right production architecture: declarative JSON extensions loaded by the Cloudflare Worker. The previous standalone Forge generated JavaScript adapters, which cannot be fetched/executed dynamically by Workers and therefore was not the correct final integration.

Forge v3 now targets Yomu's real extension contract.

## User flow

### From Yomu

1. Open **Add sources**.
2. Paste a known source URL → it is added normally.
3. Paste an unknown source URL → Yomu shows **Forge this website →**.
4. That opens local Source Forge at `http://localhost:8790` with the URL already filled.
5. Click **Forge + Gauntlet**.
6. If the combined score is strong, click **Install into project** or **Publish + refresh Yomu**.
7. Publishing can redirect back to `/add-sources.html?url=...&auto=1`, which re-checks the refreshed extension registry and adds the source to browser storage automatically.

### Directly from Forge

Run:

```bash
npm run source:forge:install
npm run source:forge
```

Then open `http://localhost:8790` and paste either a site root/catalog URL or a title/series URL.

## What the gauntlet checks

Forge probes:

- a repeatable catalog/title listing
- series title/cover/description candidates
- chapter links and labels
- first/middle/last chapter samples where available
- reader image selectors and lazy-image attributes
- duplicate page/chapter traps
- cross-chapter image overlap (logo/banner false positives)
- selector brittleness
- observed request/image hosts
- Yomu URL-safe series-ID round trips
- composite chapter-ID routing

The final displayed confidence is the lower of the extraction score and native-Yomu descriptor score.

## Install behavior

Install writes the descriptor into the project:

```text
extensions/sources/<id>.json
extensions/index.json
worker/extensions/bundled.ts   (regenerated)
```

If the ZIP's sibling `yomu-extensions-repo/` exists, the same source and index are synced there.

Existing source IDs are version-bumped automatically.

## Optional GitHub publish

The Forge can publish the descriptor + updated `index.json` in **one Git commit**, avoiding the temporary version mismatch that would happen if they were uploaded separately.

Local environment variables:

```bash
YOMU_GITHUB_TOKEN=github_pat_...
YOMU_EXTENSIONS_REPO=kumikilongyeyo/yomu-extensions
YOMU_EXTENSIONS_BRANCH=main
YOMU_APP_URL=https://your-yomu.example
```

Use a fine-grained token scoped only to the extension repo with **Contents: read/write**.

The token is read by the local Node process and is not exposed in the Forge webpage.

## Runtime additions

The extension runtime remains declarative/no-eval. Forge v3 adds bounded data transforms only:

- `urlencode`
- `urldecode`
- `srcset`
- `FieldSpec.attrs` ordered attribute fallback
- endpoint variable `transform`
- endpoint `pageMax`
- relative HTML links resolve against the final response URL

These are needed so generic generated adapters can safely represent:

```text
catalog href
  ↓ urlencode
series id
  ↓ urldecode for request
series page
  ↓
seriesId::https://real/chapter/url
  ↓ split
chapter request
  ↓
page images
```

## Boundaries

No login/paywall/CAPTCHA/DRM/anti-bot bypass is implemented. If a source blocks normal access, Forge reports it instead of trying to circumvent it.

Sites requiring request signing, encrypted private APIs, canvas-only pages, or unusual client-only logic can still require a native provider or Suwayomi extension.
