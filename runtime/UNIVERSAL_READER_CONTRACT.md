# Yomu Universal Reader Contract v1

The Universal Reader Contract is the stable HTTP boundary between a reading app and an executable source runtime.

A reader does **not** need to understand Android APKs, DEX bytecode, Tachiyomi internals, or a specific extension repository. The runtime executes those details and returns normalized JSON.

Yomu currently implements this contract through its Source Runtime broker. Other readers may call the same broker or implement the same contract against another backend.

## Goals

- Reader-agnostic: web, iOS, Android, desktop, and server clients can consume the same operations.
- Runtime-agnostic: the backend may be miwayomi, Suwayomi, a native provider, or another compatible executor.
- Read-only at the public boundary: extension installation and arbitrary code administration are outside this contract.
- Stable IDs: opaque IDs returned by one operation are passed unchanged into the next operation.

## Base route

Yomu exposes executable sources under:

```text
/api/fabric/runtime/source/{runtimeSourceId}
```

The Hatchable broker exposes the equivalent route internally as:

```text
/api/v1/source/{runtimeSourceId}
```

A reader should treat `runtimeSourceId`, `seriesId`, and `chapterId` as opaque strings.

## Source adapter

A resolver returns a source adapter with the minimum shape:

```json
{
  "id": "fabric-miwayomi-123",
  "name": "Example Source",
  "language": "en",
  "content": ["manga", "manhwa", "manhua", "webtoon", "comic"],
  "capabilities": {
    "search": true,
    "popular": true,
    "latest": true,
    "details": true,
    "chapters": true,
    "pages": true
  },
  "api": "/api/fabric/runtime/source/miwayomi-123/",
  "runtime": "miwayomi-apk"
}
```

Readers must feature-detect from `capabilities` instead of assuming every source implements every operation.

## Operations

### Popular catalog

```http
GET {base}/series?page=1
```

### Latest updates

```http
GET {base}/latest?page=1
```

### Search

```http
GET {base}/search?q=solo+leveling&page=1
```

Catalog/search response:

```json
{
  "series": [
    {
      "id": "opaque-series-id",
      "title": "Example Title",
      "author": "Optional Author",
      "synopsis": "Optional summary",
      "genres": ["Action"],
      "status": "ongoing",
      "cover": "/api/fabric/runtime/source/miwayomi-123/image?url=...",
      "category": "manhwa",
      "updatedAt": 1789948800000
    }
  ],
  "hasNextPage": true,
  "runtime": "miwayomi-apk"
}
```

### Series details and chapters

```http
GET {base}/series/{seriesId}
```

Response:

```json
{
  "id": "opaque-series-id",
  "title": "Example Title",
  "synopsis": "...",
  "cover": "...",
  "category": "manga",
  "chapters": [
    {
      "id": "opaque-chapter-id",
      "number": 42,
      "name": "Chapter 42",
      "publishedAt": 1789948800000,
      "scanlator": "Optional"
    }
  ],
  "runtime": "miwayomi-apk"
}
```

### Chapter page manifest

```http
GET {base}/chapters/{chapterId}/manifest
```

Response:

```json
{
  "schema": "yomu.chapter-manifest/1",
  "chapterId": "opaque-chapter-id",
  "manifestVersion": "miwayomi-123-18",
  "pageListVersion": 18,
  "expiresAt": 1789949400000,
  "pages": [
    {
      "key": "chapter-0",
      "index": 0,
      "url": "/api/fabric/runtime/source/miwayomi-123/image?url=..."
    }
  ],
  "delivery": "proxy",
  "runtime": "miwayomi-apk"
}
```

The reader must display pages in ascending `index` order.

### Image delivery

```http
GET {base}/image?url={encodedSourceImageUrl}
```

The runtime proxy preserves the source-specific request headers required by the installed extension. Readers should use the manifest-provided URL rather than trying to reconstruct source headers themselves.

## Error behavior

- `400` — malformed request or missing required parameter.
- `404` — unknown runtime source / series operation.
- `429` — runtime or hosting quota/rate limit.
- `502` — upstream source runtime or extension failed.

Clients should present source-level failures without crashing the library or discovery UI.

## Executable extension boundary

Mihon/Aniyomi extensions are third-party executable code. They are loaded only by the isolated JVM runtime. The public reader contract intentionally does not provide:

- extension install/uninstall,
- arbitrary repository mutation,
- shell/process execution,
- credential extraction,
- bypass APIs for paywalls, CAPTCHA, DRM, or access controls.

Operator-side extension administration is separate from reader traffic.

## Compatibility

### Yomu

Uses this contract directly through `/api/fabric/runtime/source/...`.

### Web / iOS / desktop reader

Use the HTTP contract; no Android runtime is required on the client.

### Android reader with APKBridge support

May execute compatible extensions locally instead. It can still use this HTTP contract as a remote-runtime fallback.

### Other server runtimes

A different executor can implement the same response shapes. The reader should not depend on `miwayomi-apk` beyond displaying runtime/debug metadata.

## Versioning

This document defines `yomu-universal-reader/1`. Breaking response changes require a new major contract version. Additive optional fields do not.
