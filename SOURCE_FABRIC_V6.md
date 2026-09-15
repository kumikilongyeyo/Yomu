# Source Fabric v6 — Store Federation + Runtime Broker

The product rule remains intentionally boring:

> Paste URL → Add source → test → add → browse/read.

Store Federation is infrastructure behind that button. It is not another setup screen.

## What v6 adds

When a URL is pasted, Yomu now searches several maintained source ecosystems in parallel before relying on generic HTML discovery:

- Aidoku: Yomu Aidoku Sources (`Smexhy/yomu-aidoku-sources`)
- Aidoku Community
- Mangayomi Community (`m2k3a/mangayomi-extensions`)
- Mihon: Keiyoushi
- Mihon: Yuzono

Results are matched by the source's real base hostname, de-duplicated, ranked, and attached to the existing Source Fabric resolve response.

The highest-ranked implementation also gets a runtime hint:

- `aidoku-wasm`
- `mangayomi-script`
- `mihon-android`

This lets the UI know the difference between "no implementation exists" and "a maintained implementation exists but needs a runtime Yomu has not connected yet."

## Why this matters

Comix is a good example. Its maintained Aidoku store entry publishes a versioned `.aix` package and declares `https://comix.to` as the base URL. Instead of reverse-engineering Comix again, Yomu can find that package and prefer it.

Kagane is another example. Store Federation can identify maintained implementations even when the Cloudflare Worker itself gets a 403 challenge. That is a runtime problem, not a discovery problem.

## Runtime broker hook

v6 includes an optional server-side broker without changing the Sources UI.

Configure these Worker environment variables when a remote source runtime is deployed:

- `SOURCE_RUNTIME_URL`
- `SOURCE_RUNTIME_TOKEN` (optional)

Yomu will POST to:

`{SOURCE_RUNTIME_URL}/v1/resolve`

with:

```json
{
  "targetUrl": "https://example.org/",
  "implementations": [
    {
      "ecosystem": "aidoku",
      "store": "Yomu Aidoku Sources",
      "name": "Example",
      "baseUrl": "https://example.org",
      "runtimeHint": "aidoku-wasm"
    }
  ]
}
```

A runner can return:

```json
{
  "ready": true,
  "confidence": "high",
  "score": 96,
  "runtime": "aidoku-wasm",
  "adapter": {
    "id": "fabric-example",
    "name": "Example",
    "api": "https://runtime.example/v1/source/example/",
    "capabilities": {
      "search": true,
      "popular": true,
      "latest": true,
      "details": true,
      "chapters": true,
      "pages": true
    }
  }
}
```

The existing Add Source UI will then perform its normal reader gauntlet and save the adapter. No new user-facing engine selector is required.

## Useful endpoints

`GET /api/fabric/stores/status`

Shows the enabled federated stores and whether a remote runtime broker is configured.

`GET /api/fabric/stores/lookup?url=https://comix.to`

Shows which maintained implementations match a site.

`POST /api/fabric/resolve`

Still powers the normal Add Source button. Store Federation now runs inside this existing endpoint.

## Runtime references

Do not copy third-party GPL code into the Yomu Worker blindly. Treat these as architecture/runtime references or run them as separate compatible services with their licenses preserved.

Useful projects discovered during v6 design:

- `hajisensai/Fushi` — contains an Aidoku `.aix` runtime using Wasmer and consumes published source indexes/packages.
- `Skittyblock/aidoku-runner` — another Wasmer-based Aidoku source runner.
- `browserless/browserless` — remote Chromium/Playwright sessions for sources that genuinely need a normal browser session.

The long-term router is:

```text
Paste URL
  ↓
Store Federation
  ├─ Aidoku implementation → remote Aidoku WASM runner
  ├─ Mangayomi implementation → remote script runner
  ├─ Mihon implementation → remote Mihon/Suwayomi runtime
  └─ nothing maintained → Yomu generic/native Forge
  ↓
Gauntlet
  ↓
Add source
  ↓
Browse / search / read
```

Protected sources may still require normal user-authorized browser verification. Yomu should surface that honestly rather than attempting to bypass site protections.
