#!/bin/bash
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "[Yomu Forge] Installing dependencies..."
  npm install
fi
if [ ! -f .chromium-ready ]; then
  echo "[Yomu Forge] Installing Playwright Chromium..."
  npx playwright install chromium
  touch .chromium-ready
fi
npm start
