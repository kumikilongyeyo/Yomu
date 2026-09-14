# Yomu extensions

Declarative source adapters for Yomu. **This directory is the extension repository** — publish it as its own GitHub repo and point the Worker at it:

```bash
npx wrangler secret put EXTENSIONS_REPO
# https://raw.githubusercontent.com/<you>/yomu-extensions/main
```

## Why descriptors instead of `.js`

Cloudflare Workers disallow `eval()` and `new Function()`, so a Worker cannot execute adapter code fetched at runtime. Rather than reach for a separate product (Dynamic Workers), adapters are **data**: each one says which URLs to request and which JSON paths or CSS selectors to read out of the answer. The executor lives in the Worker.

The practical consequence is the one that matters: a site changes, you edit the adapter here and bump `version`, and Yomu picks it up on its next registry check. No Yomu deployment.

The security consequence is that a hostile descriptor can at worst produce a wrong string. It cannot run code, and it cannot reach a host it did not declare.

## Layout

```
index.json                    the registry
schema/extension.schema.json  what a descriptor may contain
sources/<id>.json             one adapter per file
```

## Publishing an update

1. Edit `sources/<id>.json`.
2. Increment `version` there **and** in the matching `index.json` entry — they must agree, or the descriptor is rejected.
3. Push. Yomu revalidates within its registry cache window (15 minutes), or immediately via `/api/ext/refresh`.

## What a descriptor may do

`GET`/`POST`, query parameters, headers, pagination arithmetic, JSON responses with path extraction (including `[0]` indices and `[key=value]` predicates), HTML responses with CSS selectors and attribute extraction, request chaining, filtering, and the transform list in the schema (regex, replace, trim, prefix/suffix, concat, numeric, date, pluck, map, default, URL resolution). Per-source timeouts, rate limits and cache lifetimes are declared here too.

## What it may not do

Run code. Contact a host outside its `hosts` allowlist — enforced on the request, on redirects, and on images. Defeat an anti-bot challenge, a login, a paywall or a CAPTCHA.

## When a source does not fit

Do not stretch the descriptor engine. Classify the source instead:

- **`native-required`** — needs real logic (request signing, unusual auth, client-rendered pages). Write a native adapter in `worker/providers/`, as MangaDex is.
- **`suwayomi-required`** — a Mihon extension already solves it. Let the Suwayomi bridge carry it.

A source may also be *partially* expressible. `comick` is listed with `details`, `chapters` and `pages` set to `false` because its reading endpoints sit behind a challenge; it contributes discovery only, and the catalog reads those titles from another provider.
