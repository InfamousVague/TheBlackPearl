#!/usr/bin/env bash
# Provision the bundled ffmpeg/ffprobe sidecar binaries for the Tauri build.
#
# These are GPL static builds (full codec coverage incl. libx264) bundled via
# src-tauri/tauri.macos.conf.json's `externalBin`, so a clean machine with no system ffmpeg can
# still transcode MKV/HEVC/AC-3. They're large (~50MB each) and gitignored — run this to fetch
# them into src-tauri/binaries/ with Tauri's required <name>-<target-triple> naming.
#
# Source offer (GPL §3): see FFMPEG-NOTICE.md. macOS arm64 builds from osxexperts.net.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../src-tauri/binaries" && pwd 2>/dev/null || (mkdir -p "$(dirname "$0")/../src-tauri/binaries" && cd "$(dirname "$0")/../src-tauri/binaries" && pwd))"
cd "$DIR"

fetch_mac_arm64() {
  echo "==> macOS arm64 ffmpeg + ffprobe (8.1, GPL)"
  curl -sL --fail -o /tmp/_ff.zip  "https://www.osxexperts.net/ffmpeg81arm.zip"
  curl -sL --fail -o /tmp/_fp.zip  "https://www.osxexperts.net/ffprobe81arm.zip"
  unzip -o -q /tmp/_ff.zip -d /tmp/_ff && unzip -o -q /tmp/_fp.zip -d /tmp/_fp
  mv /tmp/_ff/ffmpeg  ./ffmpeg-aarch64-apple-darwin
  mv /tmp/_fp/ffprobe ./ffprobe-aarch64-apple-darwin
  chmod +x ffmpeg-aarch64-apple-darwin ffprobe-aarch64-apple-darwin
  rm -rf /tmp/_ff /tmp/_fp /tmp/_ff.zip /tmp/_fp.zip
  file ./ffmpeg-aarch64-apple-darwin | grep -q arm64 || { echo "ERROR: not arm64"; exit 1; }
  ./ffmpeg-aarch64-apple-darwin -version | head -1
}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) fetch_mac_arm64 ;;
  *)
    echo "No automated fetch for $(uname -s)-$(uname -m) yet."
    echo "Windows (CI): use BtbN ffmpeg-master-latest-win64-gpl → ffmpeg-x86_64-pc-windows-msvc.exe + ffprobe-...exe"
    echo "Linux   (CI): use johnvansickle amd64-static → ffmpeg-x86_64-unknown-linux-gnu + ffprobe-..."
    exit 1
    ;;
esac

echo "✓ Sidecar binaries ready in $DIR"
