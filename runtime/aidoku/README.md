# Yomu Aidoku Runtime

Remote execution service for Source Fabric v7.

It runs maintained Aidoku `.aix` packages in a server-side Wasmer sandbox, then exposes the normal Yomu source API (`series`, `search`, details, chapters, page manifests).

## Why this exists

Cloudflare Workers can discover Aidoku sources but are not a good place to host the full Aidoku WASM host environment. This service supplies that missing runtime so the user-facing flow stays:

`paste URL -> Add source -> test -> add -> read`

## Supported stores

The first release intentionally allowlists only the Aidoku stores already trusted by Yomu Store Federation:

- `aidoku-yomu-community`
- `aidoku-community`

Arbitrary package URLs are rejected. This prevents Source Fabric input from turning the runtime into an SSRF/download proxy.

## Environment

- `PORT` — HTTP port, default `8080`
- `YOMU_RUNTIME_TOKEN` — optional bearer token used by the Worker when calling `/v1/resolve`. Set this in production.

## HTTP

- `GET /healthz`
- `POST /v1/resolve`
- `GET /v1/source/:source_id/series`
- `GET /v1/source/:source_id/latest`
- `GET /v1/source/:source_id/search?q=...&page=1`
- `GET /v1/source/:source_id/series/:manga_id`
- `GET /v1/source/:source_id/chapters/:chapter_id/manifest`

`/v1/resolve` runs a real gauntlet before returning `ready: true`: catalog/search -> manga details -> chapters -> reader pages.

## Container deployment

Build from this directory:

```bash
docker build -t yomu-aidoku-runtime .
docker run --rm -p 8080:8080 -e YOMU_RUNTIME_TOKEN=change-me yomu-aidoku-runtime
```

Then configure the Cloudflare Worker:

```bash
npx wrangler secret put SOURCE_RUNTIME_URL
npx wrangler secret put SOURCE_RUNTIME_TOKEN
npx wrangler deploy
```

`SOURCE_RUNTIME_URL` should be the public HTTPS base URL of this service. `SOURCE_RUNTIME_TOKEN` must match `YOMU_RUNTIME_TOKEN`.

## Current limits

The first runtime intentionally supports normal Aidoku network/HTML/JS-context sources. Aidoku sources that require a real interactive WebView still fail the gauntlet instead of being falsely installed. A future browser runtime can handle those as a second escalation tier.
