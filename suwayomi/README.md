# Yomu source engine — Suwayomi + Keiyoushi

This is the source engine for Yomu. It runs separately from the Cloudflare Worker.

## Already configured

- Stable Suwayomi Docker image
- Keiyoushi extension store:
  `https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb`
- Automatic library checks every 6 hours
- Manga metadata refresh during library updates
- Basic authentication
- Persistent data under `./data`

## Start it

```bash
cp .env.example .env
# edit .env and replace the password
docker compose up -d
```

Open `http://YOUR_SERVER_IP:4567` and sign in with the values from `.env`.

In Suwayomi, open **Extensions**, refresh the store, and install the 6–20 sources you actually want to use. The Keiyoushi store is already registered by Docker; you do not need to paste the repo URL manually.

## Give Yomu access

Yomu's Cloudflare Worker needs an HTTP(S) address that Cloudflare can reach. Prefer putting Suwayomi behind an HTTPS reverse proxy or tunnel.

Set these Cloudflare Worker secrets from the Yomu project folder:

```bash
npx wrangler secret put SUWAYOMI_URL
npx wrangler secret put SUWAYOMI_AUTH_HEADER
```

`SUWAYOMI_AUTH_HEADER` is a Basic auth header. Generate it with:

```bash
../scripts/make-suwayomi-auth.sh yomu 'YOUR_PASSWORD'
```

Then deploy Yomu and visit `/suwayomi-setup.html` to import 6–20 installed Suwayomi sources into Yomu.

## Important

Cloudflare Workers cannot run Suwayomi itself. Suwayomi is a persistent JVM service, so it must run on a computer/server/NAS/VPS that stays reachable. Yomu on Cloudflare only talks to it through the bridge.
