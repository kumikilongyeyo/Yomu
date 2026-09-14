Yomu — Keiyoushi + Mihon multi-source build
========================================

WHAT CHANGED
- Existing MangaDex relay is preserved.
- Existing Internet Archive relay is preserved.
- Added a Suwayomi/Mihon bridge to the Cloudflare Worker.
- Added a ready-to-run Suwayomi Docker stack with the Keiyoushi extension store preconfigured.
- Added /suwayomi-setup.html to install 6–20 installed Suwayomi sources into Yomu.
- Yomu generic API sources now keep covers/status/update timestamps.
- Generic API sources now support search + latest feeds.
- Added Webtoon as a first-class Yomu category.
- Added a “Mihon Bridge” button on the Sources screen.

WHY SUWAYOMI
Suwayomi runs Mihon-compatible extensions and exposes them through one server API.
That means Yomu does not need 20 separate brittle website scrapers inside the Worker.
Each selected Suwayomi source still appears in Yomu as its own source/fallback.

PROJECT LAYOUT
  dist-app/                    static Yomu web app
  worker/index.ts              MangaDex/Archive relay + Suwayomi bridge
  wrangler.jsonc               Cloudflare Worker config
  suwayomi/docker-compose.yml  source engine with Keiyoushi preconfigured
  scripts/                     setup/deploy helpers
  CLAUDE_CLOUDFLARE_HANDOFF.md exact Cloudflare deployment handoff
  README.txt                   this file


KEIYOUSHI IS ALREADY WIRED
The included Suwayomi Docker stack registers:
  https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb

Run it with:
  cd suwayomi
  cp .env.example .env
  # edit the password in .env
  docker compose up -d

Then open the Suwayomi WebUI and install the 6–20 extensions you want.

DEPLOY YOMU TO CLOUDFLARE
From this folder:

  npx wrangler deploy

MANGADEX ONLY
If you do nothing else, MangaDex continues to work exactly as before.

ENABLE MIHON / SUWAYOMI SOURCES
1. Run the included `suwayomi/docker-compose.yml` somewhere reachable from Cloudflare over HTTPS.
2. In Suwayomi, install the 6–20 Keiyoushi extensions/sources you want. The Keiyoushi store is already configured.
3. Configure this Worker:

     npx wrangler secret put SUWAYOMI_URL

   Paste the base URL, for example:
     https://your-suwayomi.example.com

4. If Suwayomi needs an Authorization header, also run:

     npx wrangler secret put SUWAYOMI_AUTH_HEADER

   Paste the exact header value, e.g. “Basic …” or “Bearer …”.

5. Deploy again:

     npx wrangler deploy

6. Open:

     https://YOUR-YOMU-DOMAIN/suwayomi-setup.html

7. Select at least 6 and up to 20 sources, then click “Install into Yomu”.

UPDATES
Yomu reads latest/search/chapter data live from the enabled source when the app is opened.
Suwayomi can run its own automatic library update schedule for saved titles, so new chapters
do not require rebuilding or redeploying Yomu.

SECURITY
- Do not put usernames/passwords/tokens into the app bundle.
- Put Authorization data in Cloudflare secrets only.
- The Suwayomi image relay only fetches from the configured Suwayomi origin; it is not an open proxy.
