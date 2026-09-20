#!/bin/sh
set -eu

YOMU_RUNTIME_USER="${YOMU_RUNTIME_USER:-yomu}"
MIWAYOMI_PORT="${MIWAYOMI_PORT:-4567}"
PORT="${PORT:-8080}"
FLARESOLVERR_URL="${FLARESOLVERR_URL:-}"

if [ -z "${YOMU_RUNTIME_PASSWORD:-}" ]; then
  echo "YOMU_RUNTIME_PASSWORD is required; refusing to expose an unauthenticated extension runtime." >&2
  exit 1
fi

export YOMU_RUNTIME_USER MIWAYOMI_PORT PORT
export YOMU_RUNTIME_PASSWORD_HASH
YOMU_RUNTIME_PASSWORD_HASH="$(caddy hash-password --plaintext "$YOMU_RUNTIME_PASSWORD")"

java $JAVA_OPTS -jar /app/miwayomi-all.jar \
  --host 127.0.0.1 \
  --port "$MIWAYOMI_PORT" \
  --data /data \
  --no-open \
  --flaresolverr "$FLARESOLVERR_URL" &
MIWAYOMI_PID=$!

cleanup() {
  kill "$MIWAYOMI_PID" 2>/dev/null || true
  wait "$MIWAYOMI_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

attempt=0
until curl -fsS "http://127.0.0.1:${MIWAYOMI_PORT}/api/v1/health" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if ! kill -0 "$MIWAYOMI_PID" 2>/dev/null; then
    echo "miwayomi exited before becoming healthy." >&2
    wait "$MIWAYOMI_PID" || true
    exit 1
  fi
  if [ "$attempt" -ge 60 ]; then
    echo "miwayomi did not become healthy within the startup window." >&2
    exit 1
  fi
  sleep 1
done

echo "Yomu Universal Extension Runtime is ready on :${PORT}; miwayomi is isolated on loopback:${MIWAYOMI_PORT}."
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
