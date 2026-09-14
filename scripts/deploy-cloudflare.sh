#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

printf 'Suwayomi public HTTPS URL (example https://suwayomi.example.com): '
read -r SUWAYOMI_URL
if [[ -z "$SUWAYOMI_URL" ]]; then
  echo 'SUWAYOMI_URL is required.' >&2
  exit 1
fi

printf '%s' "$SUWAYOMI_URL" | npx wrangler secret put SUWAYOMI_URL

printf 'Suwayomi Basic-auth username [yomu]: '
read -r SUWAYOMI_USER
SUWAYOMI_USER="${SUWAYOMI_USER:-yomu}"
printf 'Suwayomi password: '
read -rs SUWAYOMI_PASSWORD
printf '\n'

if [[ -n "$SUWAYOMI_PASSWORD" ]]; then
  AUTH="Basic $(printf '%s:%s' "$SUWAYOMI_USER" "$SUWAYOMI_PASSWORD" | base64 | tr -d '\n')"
  printf '%s' "$AUTH" | npx wrangler secret put SUWAYOMI_AUTH_HEADER
fi

npx wrangler deploy

echo
echo 'Cloudflare deploy finished.'
echo 'Open: https://YOUR-YOMU-DOMAIN/suwayomi-setup.html'
