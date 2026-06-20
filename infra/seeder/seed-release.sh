#!/usr/bin/env bash
# Fetch the latest GhostWire release's update bundles + their .torrents and add them to the local
# rqbit seeder. Idempotent: re-running just re-verifies and keeps seeding. Bundles are downloaded so
# they verify straight to "seeding" instead of leeching. HTTP-from-GitHub is unaffected.
set -euo pipefail

REPO="${REPO:-InfamousVague/GhostWire.tv}"
SEED_DIR="${SEED_DIR:-/var/lib/ghostwire-seeder/data}"
RQBIT_API="${RQBIT_API:-http://127.0.0.1:3030}"   # rqbit server HTTP API

mkdir -p "$SEED_DIR"
cd "$SEED_DIR"

echo "[seed] fetching latest release assets from $REPO"
# The signed update bundles the .torrents describe (download so seeding verifies immediately).
gh release download --repo "$REPO" \
  --pattern '*.app.tar.gz' \
  --pattern '*.AppImage.tar.gz' \
  --pattern '*-setup.exe' \
  --pattern '*.nsis.zip' \
  --pattern '*.msi' \
  --dir "$SEED_DIR" --clobber || true
# The .torrents themselves.
gh release download --repo "$REPO" --pattern '*.torrent' --dir "$SEED_DIR" --clobber || true

shopt -s nullglob
added=0
for t in "$SEED_DIR"/*.torrent; do
  echo "[seed] adding $(basename "$t")"
  # rqbit add: with the content already in --output-folder, it verifies + seeds. Idempotent.
  curl -fsS -X POST "$RQBIT_API/torrents" \
    --data-binary "@$t" \
    --header 'Content-Type: application/octet-stream' \
    --get --data-urlencode "overwrite=true" --data-urlencode "output_folder=$SEED_DIR" \
    >/dev/null 2>&1 || rqbit add "$t" --overwrite -o "$SEED_DIR" >/dev/null 2>&1 || true
  added=$((added + 1))
done

echo "[seed] done — $added torrent(s) seeding from $SEED_DIR"
