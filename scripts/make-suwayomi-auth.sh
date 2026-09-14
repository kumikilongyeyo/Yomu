#!/usr/bin/env bash
set -euo pipefail
USER_NAME="${1:-}"
PASSWORD="${2:-}"
if [[ -z "$USER_NAME" || -z "$PASSWORD" ]]; then
  echo "Usage: $0 <username> <password>" >&2
  exit 1
fi
printf 'Basic %s\n' "$(printf '%s:%s' "$USER_NAME" "$PASSWORD" | base64 | tr -d '\n')"
