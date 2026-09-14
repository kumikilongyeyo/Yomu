#!/usr/bin/env bash
# Starts the Suwayomi source engine without Docker.
# Same configuration as docker-compose.yml; config lives in ./data/server.conf.
set -euo pipefail
cd "$(dirname "$0")"
RUNTIME="$HOME/.local/yomu-runtime"
JAVA="$RUNTIME/jdk-21.0.12.1+1-jre/Contents/Home/bin/java"
JAR="$RUNTIME/Suwayomi-Server.jar"

if pgrep -f "Suwayomi-Server.jar" >/dev/null 2>&1; then
  echo "Suwayomi is already running (pid $(pgrep -f Suwayomi-Server.jar | head -1))."
  exit 0
fi

nohup "$JAVA" -Xmx2g -Djava.awt.headless=true \
  -Dsuwayomi.tachidesk.config.server.rootDir="$(pwd)/data" \
  -jar "$JAR" >> suwayomi.log 2>&1 &
echo "Suwayomi starting (pid $!). Log: $(pwd)/suwayomi.log"
