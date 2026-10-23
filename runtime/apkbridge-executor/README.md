# Exact Android APK executor

This lane exists because a JVM can only *translate* Android DEX bytecode. Some current Mihon/Keiyoushi extensions use R8 output that still fails JVM verification after DEX→JAR conversion. For those extensions, Yomu must execute the APK on Android ART/Dalvik instead of pretending JVM compatibility.

The reference executor is [Schnitzel5/ApkBridge](https://github.com/Schnitzel5/ApkBridge), which loads the real extension APK using Android `DexClassLoader` and invokes the Mihon/Aniyomi source interfaces directly.

## Executor priority

Yomu Universal Runtime v2 uses this order:

1. **Android APK executor (`apkbridge-android`)** — exact APK execution. Preferred for Mihon/Aniyomi extensions when an Android executor is online.
2. **JVM executor (`miwayomi-apk`)** — server/desktop fallback. Faster/easier to host, but not every modern DEX payload is convertible.
3. **Native Yomu provider** — source-specific first-party provider.
4. **Declarative recipe** — non-executable Worker-safe descriptor.

The reader never cares which executor won. All four return the same `yomu-universal-reader/1` operations.

## APKBridge wire mapping

`client.ts` maps the normalized reader calls to APKBridge methods:

| Universal reader operation | APKBridge method |
| --- | --- |
| popular | `getPopularManga` |
| latest | `getLatestManga` |
| search | `getSearchManga` |
| details | `getDetailsManga` |
| chapters | `getChapterList` |
| pages | `getPageList` |
| source filters | `filtersManga` |
| source preferences | `preferencesManga` |

Aniyomi anime operations use the matching `*Anime`, episode and video methods and can be normalized by the same broker later without changing the reader protocol.

## Security boundary

APK extensions are third-party executable code. They must **not** execute inside Cloudflare Workers, browser JavaScript, or the public Yomu process.

The Android executor should run on a dedicated Android device/emulator with:

- no personal account/data,
- a dedicated network identity,
- an authenticated private tunnel or HTTPS reverse proxy,
- request size/rate limits,
- an allowlist of extension repository origins,
- no public package-install endpoint,
- disposable app/runtime data where possible.

Yomu's public API remains read-only.

## Required bridge wrapper

The raw upstream APKBridge API accepts the APK payload on each `/dalvik` request. Production Yomu should put a small authenticated wrapper in front of it that caches verified APK bytes by SHA-256 and exposes source IDs rather than allowing arbitrary callers to submit executable blobs.

The wrapper contract should be:

```text
POST /v1/extensions/sync       operator only
GET  /v1/sources              private broker only
GET  /v1/source/:id/popular
GET  /v1/source/:id/latest
GET  /v1/source/:id/search?q=&page=
GET  /v1/source/:id/series/:opaqueId
GET  /v1/source/:id/chapters/:opaqueId/manifest
```

The wrapper then invokes local APKBridge `/dalvik` using the cached APK bytes. This lets Yomu, iOS, web, desktop, and other reading apps use exact Android source logic without each app embedding Android bytecode execution.

## Current status

- Universal reader HTTP contract: implemented on `main`.
- Wotaku/Mihon runtime stores: implemented in `kumikilongyeyo/yomu-extensions`.
- Authenticated miwayomi JVM executor: implemented and container startup/auth smoke tested.
- Real Keiyoushi MangaDex canary: exposes a JVM DEX→JAR `VerifyError`; therefore JVM execution is **not** labelled universal.
- Android APKBridge client: implemented on this feature branch.
- Remaining deployment requirement: a persistent Android device/emulator host for APKBridge plus the authenticated caching wrapper above.

Do not merge this branch as “fully live” until an Android executor endpoint is provisioned and the MangaDex canary passes popular → details → chapters → pages end-to-end.
