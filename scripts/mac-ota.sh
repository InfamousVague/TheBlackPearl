#!/bin/bash
# Regenerate the macOS OTA updater bundle from the freshly signed + notarized
# .app, then re-sign it with the Tauri updater key.
#
# Why this exists: `tauri build` creates `<App>.app.tar.gz` + `.sig` during the
# bundle step, from the signed .app — but BEFORE notarization stapled a ticket
# onto it. Shipping that build-time tarball means OTA-updated users get a .app
# with no stapled notarization ticket (works online, fails first-launch offline).
# We staple the .app (its cdhash was notarized as part of the DMG submission),
# then re-tar + re-sign so the OTA bundle matches the DMG's contents exactly.
#
# Run AFTER `make build` + `make notarize` (the DMG notarization registers the
# inner .app's cdhash with Apple, which is what lets `stapler staple` the .app).
#
# Env:
#   TAURI_SIGNING_KEY_PATH       updater private key (default ~/.tauri/blackpearl-updater.key)
#   TAURI_SIGNING_KEY_PASSWORD   its password (default empty)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
MACDIR="$ROOT/src-tauri/target/release/bundle/macos"

APP_BUNDLE="$(find "$MACDIR" -maxdepth 1 -name "*.app" 2>/dev/null | head -1)"
if [ -z "$APP_BUNDLE" ]; then
  echo "ERROR: no .app under $MACDIR — run 'make build' first" >&2
  exit 1
fi
echo "App: $APP_BUNDLE"

# Staple the notarization ticket onto the .app (best-effort: the ticket exists
# only after `make notarize` submitted the DMG containing this .app). If it
# isn't notarized yet, the OTA bundle is still signed + notarized (verified
# online at launch) — just not stapled for offline first-launch.
if xcrun stapler staple "$APP_BUNDLE" 2>/dev/null; then
  echo "Stapled notarization ticket onto the .app"
else
  echo "WARN: could not staple the .app (not notarized yet?) — OTA bundle will"
  echo "      be notarized-but-unstapled (works online; offline first-launch may stall)."
fi

UPDATER_KEY="${TAURI_SIGNING_KEY_PATH:-$HOME/.tauri/blackpearl-updater.key}"
UPDATER_TARBALL="${APP_BUNDLE}.tar.gz"

if [ ! -f "$UPDATER_KEY" ]; then
  echo "ERROR: updater key not found at $UPDATER_KEY" >&2
  echo "       generate it: npx @tauri-apps/cli signer generate -w $UPDATER_KEY" >&2
  exit 1
fi

echo "=== Regenerating OTA updater bundle ==="
rm -f "$UPDATER_TARBALL" "$UPDATER_TARBALL.sig"

# CRITICAL: COPYFILE_DISABLE=1 + --no-mac-metadata. macOS bsdtar otherwise embeds
# AppleDouble `._*` + PaxHeader entries for every file with xattrs (codesign adds
# com.apple.provenance to all of them). Rust's tar crate in tauri-plugin-updater
# doesn't filter those, so OTA installs die with "failed to unpack `._<App>.app`".
# Belt + braces — either flag alone is enough; both makes the intent explicit.
(cd "$(dirname "$APP_BUNDLE")" &&
  COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$UPDATER_TARBALL" "$(basename "$APP_BUNDLE")")
echo "Tarball: $UPDATER_TARBALL ($(ls -lh "$UPDATER_TARBALL" | awk '{print $5}'))"

# Sign with the updater key (matching pubkey is committed in tauri.conf.json).
# Run from the project root so npx finds the local @tauri-apps/cli.
# NOTE: unset TAURI_SIGNING_PRIVATE_KEY{,_PATH} from the environment first — if a
# stray key-path is exported (e.g. in your shell rc), the CLI errors out with
# "--private-key cannot be used with --private-key-path" and the OTA bundle ends
# up UNSIGNED, which silently drops macOS from the published release.
(cd "$ROOT" &&
  env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PATH \
      -u TAURI_SIGNING_KEY_PATH \
    npx --yes @tauri-apps/cli signer sign \
    --private-key "$(cat "$UPDATER_KEY")" \
    --password "${TAURI_SIGNING_KEY_PASSWORD:-}" \
    "$UPDATER_TARBALL")

if [ -f "$UPDATER_TARBALL.sig" ]; then
  echo "Signature: $UPDATER_TARBALL.sig"
  echo "✓ OTA updater bundle ready"
else
  echo "ERROR: OTA signature was not created — auto-update verification will fail" >&2
  exit 1
fi
