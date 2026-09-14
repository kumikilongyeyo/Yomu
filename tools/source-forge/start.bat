@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo [Yomu Forge] Installing dependencies...
  call npm install || exit /b 1
)
if not exist .chromium-ready (
  echo [Yomu Forge] Installing Playwright Chromium...
  call npx playwright install chromium || exit /b 1
  type nul > .chromium-ready
)
call npm start
