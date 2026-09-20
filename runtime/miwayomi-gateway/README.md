# Yomu Universal Extension Runtime

This container is the executable half of Yomu's universal source bridge.

It runs [miwayomi](https://github.com/miwayomi/miwayomi) on an internal loopback port so real Mihon/Aniyomi APK or JVM-JAR extension logic can execute outside Cloudflare Workers. Caddy exposes only an authenticated HTTP gateway.

## Architecture

```text
Yomu / another reader
        |
        | normalized HTTP reader contract
        v
Yomu Source Runtime (Hatchable)
        |
        | Basic Auth
        v
Caddy read-only gateway
        |
        | loopback only
        v
miwayomi JVM engine
        |
        v
installed Mihon / Aniyomi extensions
```

The Cloudflare Worker never executes APK bytecode. Third-party extensions run only in the isolated JVM container.

## Required environment variables

- `YOMU_RUNTIME_USER` — Basic Auth username; defaults to `yomu`.
- `YOMU_RUNTIME_PASSWORD` — required. Startup fails closed when missing.
- `PORT` — public gateway port; defaults to `8080` and Render supplies this automatically.
- `JAVA_OPTS` — optional JVM memory tuning.
- `FLARESOLVERR_URL` — optional external FlareSolverr URL; blank disables it.

## Local test

```bash
docker build -t yomu-miwayomi-runtime ./runtime/miwayomi-gateway

docker run --rm \
  -p 8080:8080 \
  -v yomu-miwayomi-data:/data \
  -e YOMU_RUNTIME_USER=yomu \
  -e YOMU_RUNTIME_PASSWORD='replace-me' \
  yomu-miwayomi-runtime

curl -u yomu:replace-me http://127.0.0.1:8080/api/v1/health
```

## Install stores and extensions

Extension installation is intentionally **not exposed by the public Caddy gateway**. It is executable-code administration, not reader traffic.

Use the container host's private shell/console to call miwayomi on `127.0.0.1:4567`, or manage `/data` from a trusted environment. The Wotaku-derived repository list lives in `kumikilongyeyo/yomu-extensions/runtime-stores.json`.

miwayomi's internal API supports repository indexes and extension installation; keep those operations on the trusted side of the container boundary.

## Connect Yomu Source Runtime

Once this container has a stable HTTPS URL, configure the Hatchable project `Yomu Source Runtime` with:

- `MIWAYOMI_URL=https://<your-runtime-host>`
- `MIWAYOMI_USER=<YOMU_RUNTIME_USER>`
- `MIWAYOMI_PASSWORD=<YOMU_RUNTIME_PASSWORD>`

The broker then automatically prefers a matching installed APK/JAR extension over Yomu's older recipe compiler and exposes it through the existing `/api/fabric/runtime/source/...` routes.

## Reader contract

The Yomu broker normalizes the runtime to these operations:

- popular / latest
- search
- title details
- chapters
- chapter page manifest
- authenticated image proxy

Any reader can consume the same normalized HTTP contract without needing to execute Android APK bytecode locally. Native APKBridge-capable Android readers can still use their own direct path.

## Hosting note

A persistent `/data` volume is strongly recommended. It stores installed extensions and miwayomi's SQLite state. A stateless free container may lose installed extensions on restart.

The initial attempt to provision this runtime in the connected Render workspace was blocked by Render because that workspace has no billing method attached. The container code is deploy-ready; no public JVM runtime should be considered active until a host is successfully provisioned and the health endpoint is tested.
