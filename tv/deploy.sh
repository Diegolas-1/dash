#!/usr/bin/env bash
# Package tv/homeapp as a signed .wgt and install it on the TV.
#   tv/deploy.sh <tv-ip> [security-profile]
# Needs: Tizen SDK CLI (tizen, sdb) on PATH, a Samsung certificate profile tied to the
# TV's DUID, TV in Developer Mode with this computer's IP, tv/homeapp/service/auth.js.
set -euo pipefail

TV_IP="${1:?usage: tv/deploy.sh <tv-ip> [security-profile]}"
PROFILE="${2:-${TIZEN_PROFILE:-dash}}"
APP_ID="DashHome01.home"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/homeapp"
STAGE="$HERE/state/build"
SERIAL="$TV_IP:26101"

command -v tizen >/dev/null || { echo "tizen CLI not on PATH (e.g. ~/tizen-studio/tools/ide/bin)"; exit 1; }
command -v sdb >/dev/null || { echo "sdb not on PATH (e.g. ~/tizen-studio/tools)"; exit 1; }
[ -f "$SRC/service/auth.js" ] || { echo "No upload password. Run: node tv/tools/set-password.js"; exit 1; }

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$SRC/." "$STAGE/"
find "$STAGE" -name '.DS_Store' -delete

echo "== package ($PROFILE)"
tizen package -t wgt -s "$PROFILE" -- "$STAGE"
WGT="$(ls -t "$STAGE"/*.wgt | head -1)"

echo "== connect $SERIAL"
sdb connect "$TV_IP"
sdb devices | grep -q "^$SERIAL" || { echo "TV not connected; check Developer Mode host IP"; exit 1; }

echo "== install $(basename "$WGT")"
tizen install -n "$(basename "$WGT")" -s "$SERIAL" -- "$STAGE"

echo "== run $APP_ID"
tizen run -p "$APP_ID" -s "$SERIAL"
