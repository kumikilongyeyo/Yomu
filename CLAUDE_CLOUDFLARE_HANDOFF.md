# Claude handoff — deploy Yomu, do not redesign it

The Yomu app is already built. Do not replace the UI, do not rewrite the source system, and do not remove MangaDex.

## Goal
Deploy this exact project to the existing Cloudflare Worker/site for Yomu.

## Project entry points
- `worker/index.ts` — Cloudflare Worker
- `dist-app/` — static Yomu build
- `wrangler.jsonc` — deployment config
- `suwayomi/` — separate source-engine Docker stack; this does NOT run on Cloudflare Workers

## Required Worker secrets
Set these before deploying:

1. `SUWAYOMI_URL`
   - The public HTTPS base URL of the user's running Suwayomi instance.
2. `SUWAYOMI_AUTH_HEADER`
   - Exact Basic auth header for that Suwayomi server.
   - Example shape: `Basic eW9tdTpwYXNzd29yZA==`

Never put either value into `dist-app` JavaScript.

## Deploy
```bash
npm install
npx wrangler secret put SUWAYOMI_URL
npx wrangler secret put SUWAYOMI_AUTH_HEADER
npx wrangler deploy
```

Or run `./scripts/deploy-cloudflare.sh`.

## Verification after deploy
- `/` loads Yomu.
- `/api/suwayomi/status` returns `configured: true` and `reachable: true`.
- `/suwayomi-setup.html` lists installed Suwayomi sources.
- Select 6–20 sources and press **Install into Yomu**.
- `/sources` shows them under `Mihon / Suwayomi`.
- Search and chapter reading still work for MangaDex.

Do not claim the Mihon sources work unless `/api/suwayomi/status` says the Suwayomi instance is reachable.
