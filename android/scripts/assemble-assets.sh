#!/usr/bin/env bash
# Copies the web UIs and Node services from tv/ into the Android app's assets.
#   assets/www/<app>/...            UI (no service/, build/, node_modules)
#   assets/nodejs-project/...       main.js + <app>/service/*.js (torrent engine must be built first)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ASSETS="$ROOT/android/app/src/main/assets"
rm -rf "$ASSETS" && mkdir -p "$ASSETS/www" "$ASSETS/nodejs-project"
node "$ROOT/tv/tools/sync-common.js" >/dev/null
for app in homeapp torrentapp serverapp; do
  mkdir -p "$ASSETS/www/$app" && cp -R "$ROOT/tv/$app/." "$ASSETS/www/$app/"
  rm -rf "$ASSETS/www/$app/service" "$ASSETS/www/$app/build" "$ASSETS/www/$app/node_modules" "$ASSETS/www/$app"/package*.json
  mkdir -p "$ASSETS/nodejs-project/$app/service"
  cp "$ROOT/tv/$app/service/service.js" "$ASSETS/nodejs-project/$app/service/"
done
[ -f "$ROOT/tv/torrentapp/service/engine.js" ] || { echo "tv/torrentapp/service/engine.js missing: run npm ci && npm run build in tv/torrentapp"; exit 1; }
cp "$ROOT/tv/torrentapp/service/engine.js" "$ASSETS/nodejs-project/torrentapp/service/"
cp "$ROOT/android/node/main.js" "$ASSETS/nodejs-project/main.js"
du -sh "$ASSETS/www" "$ASSETS/nodejs-project"
