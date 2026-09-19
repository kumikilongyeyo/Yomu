# Yomu Universal Source Fabric v8

Implementation landing for the **Universal Source Fabric v8** product spec.

## What shipped in this patch

- Production entrypoint `worker/index-v8.ts`, with v7.5 retained as the compatibility/execution floor.
- Universal repository detector for normal GitHub repository URLs and supported raw manifests.
- Schema/filename detection for Aidoku, Mangayomi, Mihon-family, Paperback, Synthetiq and Yomu-style repositories.
- Normalized repository preview: ecosystem, source count when available, freshness, trust, compatibility, runtime class, manifest and update fingerprint.
- Runtime Broker 2.0 capability/status surface without exposing runtime choice in normal setup.
- Health/quality scoring endpoint using the v8 weights: reader success, freshness, image quality, chapter/details success, latency, error trend, repo recency and runtime reliability.
- Canonical-title comparison endpoint with confidence bands for future fallback graph decisions.
- Sources UX repository manager with Add Repository, recommended repositories, update checks, pause/resume, last-known-good metadata rollback, history and progressive-disclosure Advanced diagnostics.
- Mobile bottom-sheet-style repository dialog and compact repository cards.
- Normal-facing copy now leads with **Source system ready** rather than engine/version jargon; exact v8/v7.5 details remain in Advanced.

## Existing Yomu behavior intentionally preserved

v8 is an expansion, not a rewrite. The existing v7.5 Recipe Engine, v6 adaptive HTML/API discovery, maintained-name resolution, store federation, Aidoku runtime integration, Suwayomi/Mihon bridge, Source Forge fallback, source auto-switch support, internal title routing, pre-paint appearance boot, chapter-end progress UI and Mori companion surfaces remain intact.

## Public v8 endpoints

### `GET /api/fabric/status`

Returns the normal Fabric status upgraded to `8.0 / Universal Source Fabric`, while identifying v7.5 as the compatibility/execution floor.

### `GET /api/fabric/v8/status`

Returns the v8 architecture, registry adapters, Runtime Broker 2.0 classes and security guardrails.

### `POST /api/fabric/repositories/detect`

Body:

```json
{ "input": "https://github.com/Aidoku-Community/sources" }
```

Returns a normalized repository preview. Adding a repository registers the feed; it does **not** bulk-enable every source.

### `GET /api/fabric/repositories/catalog`

Returns trusted starting repositories and lightweight source-pack groupings.

### `POST /api/fabric/v8/health-score`

Accepts normalized `0..1` signal values and returns `score` plus `healthy | degraded | needs-action`.

### `POST /api/fabric/v8/canonical-match`

Compares two logical title records and returns a match score plus `high | medium | low | none` confidence.

## Update safety model

Repository Manager stores the active repository metadata and fingerprint in the browser profile. An update check stages a newly detected candidate. If the candidate is no longer a verified/recognized format, Yomu records a rollback event and preserves the last known good record. Recognized candidates can replace the active metadata record. Source/adapter activation still belongs behind the existing Source Fabric gauntlet and runtime boundary; repository metadata success alone is not treated as proof that reader pages work.

## Runtime and security boundary

v8 deliberately does **not** execute arbitrary JavaScript/Kotlin/WASM copied from a pasted repository in the Cloudflare Worker. Repository probing is metadata-only. Executable ecosystems remain behind constrained compatibility runtimes or the existing Yomu execution paths. There is no CAPTCHA bypass, DRM circumvention or unauthorized session automation in this patch.

## Delivery / rollback

`wrangler.jsonc` now points production at `worker/index-v8.ts`. Reverting the entrypoint to `worker/index-v7.ts` restores the previous execution surface without deleting v8 data or assets.
