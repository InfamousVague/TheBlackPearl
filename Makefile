# GhostWire — Build, Sign, Notarize, Install (mirrors Libre.academy)
# Usage:
#   make            — full pipeline: build → notarize → install to /Applications
#   make deploy     — build → notarize → OTA bundle → install → publish + OTA feed
#   make build      — tauri release build (signs the .app + .dmg + OTA artifacts)
#   make notarize   — notarize + staple the .dmg with Apple
#   make ota        — re-tar + re-sign the OTA updater bundle from the .app
#   make publish    — upload Mac artifacts to the GitHub release + write latest.json
#   make site-manifest — refresh site/downloads/downloads.json from files in site/downloads/
#   make install    — copy the notarized app into /Applications
#   make dmg        — print the path of the built DMG (the file you send people)
#   make dev        — run in dev mode
#   make clean      — remove build artifacts
#
# OTA: `make deploy` ships the Mac build + a signed latest.json feed. Pushing the
# matching tag (git tag vX.Y.Z && git push --tags) has CI add Windows + Linux to
# the same release and merge them into latest.json.
#
# Credentials live in .env.apple (gitignored). Copy your existing ones:
#   cp ../Libre.academy/.env.apple .env.apple

SHELL := /bin/bash
ROOT  := $(shell pwd)
TAURI := $(ROOT)/src-tauri
DMGDIR := $(TAURI)/target/release/bundle/dmg
MACDIR := $(TAURI)/target/release/bundle/macos

# OTA auto-update: the build signs the updater bundle with this minisign key
# (the matching pubkey is committed in tauri.conf.json). The key has no password.
OTA_KEY ?= $(HOME)/.tauri/blackpearl-updater.key
OTA_KEY_PASSWORD ?=
REPO ?= InfamousVague/GhostWire.tv

# Load credentials from .env.apple (gitignored). Only the signing identity is
# exported into the build env — APPLE_ID/PASSWORD/TEAM_ID stay Make-local so a
# plain `make build` signs but does NOT trigger Tauri's slow auto-notarize.
-include $(ROOT)/.env.apple
export APPLE_SIGNING_IDENTITY

APPLE_ID ?= InfamousVagueRat@gmail.com
TEAM_ID  := $(APPLE_TEAM_ID)
TEAM_ID  ?= F6ZAL7ANAD

.PHONY: all deploy build notarize staple ota publish site-manifest install dmg dev clean help verify

## Default: full pipeline
all: build notarize install
	@echo ""
	@echo "✓ Done — notarized DMG ready to send. Path:"
	@$(MAKE) --no-print-directory dmg

## Build the signed Tauri release (.app + .dmg). The .app is signed with
## hardened runtime + Entitlements.plist using APPLE_SIGNING_IDENTITY.
build:
	@echo "=== Pre-build: detaching any leftover DMG mounts ==="
	@for v in /Volumes/The\ Black\ Pearl* /Volumes/dmg.*; do \
		[ -e "$$v" ] || continue; \
		hdiutil detach "$$v" -force >/dev/null 2>&1 || true; \
	done
	@rm -f $(MACDIR)/rw.*.dmg 2>/dev/null || true
	@if [ -z "$(APPLE_SIGNING_IDENTITY)" ]; then \
		echo "WARN: APPLE_SIGNING_IDENTITY not set — the build won't be signed."; \
		echo "      Create .env.apple (see .env.apple.example) first."; \
	fi
	@echo "=== Building signed Tauri release (+ OTA updater artifacts) ==="
	cd $(ROOT) && \
		env -u TAURI_SIGNING_PRIVATE_KEY_PATH -u TAURI_SIGNING_KEY_PATH \
		TAURI_SIGNING_PRIVATE_KEY="$$(cat $(OTA_KEY) 2>/dev/null)" \
		TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(OTA_KEY_PASSWORD)" \
		npm run tauri build -- --bundles app,dmg

## Notarize + staple the DMG (the artifact you actually distribute).
notarize:
	@DMG=$$(ls -t "$(DMGDIR)"/*.dmg 2>/dev/null | head -1); \
	if [ -z "$$DMG" ]; then echo "ERROR: no DMG in $(DMGDIR) — run 'make build' first"; exit 1; fi; \
	if [ -z "$(APPLE_PASSWORD)" ]; then echo "ERROR: APPLE_PASSWORD not set — check .env.apple"; exit 1; fi; \
	echo "=== Notarizing: $$DMG ==="; \
	xcrun notarytool submit "$$DMG" \
		--apple-id "$(APPLE_ID)" \
		--team-id "$(TEAM_ID)" \
		--password "$(APPLE_PASSWORD)" \
		--wait; \
	echo "=== Stapling ==="; \
	xcrun stapler staple "$$DMG"; \
	echo "✓ Notarized + stapled: $$DMG"

## Staple only (if a notarization already succeeded).
staple:
	@DMG=$$(ls -t "$(DMGDIR)"/*.dmg 2>/dev/null | head -1); \
	xcrun stapler staple "$$DMG"

## Install the notarized app into /Applications.
install:
	@DMG=$$(ls -t "$(DMGDIR)"/*.dmg 2>/dev/null | head -1); \
	if [ -z "$$DMG" ]; then echo "ERROR: no DMG to install"; exit 1; fi; \
	echo "=== Installing from $$DMG ==="; \
	hdiutil attach "$$DMG" -quiet -nobrowse -mountpoint /tmp/bp-dmg; \
	APP=$$(ls -d /tmp/bp-dmg/*.app | head -1); \
	rm -rf "/Applications/$$(basename "$$APP")"; \
	ditto "$$APP" "/Applications/$$(basename "$$APP")"; \
	hdiutil detach /tmp/bp-dmg -quiet; \
	echo "✓ Installed $$(basename "$$APP") to /Applications"

## Print the DMG path (the file to send to friends/family).
dmg:
	@ls -t "$(DMGDIR)"/*.dmg 2>/dev/null | head -1 || echo "(no DMG built yet — run 'make build')"

## Verify signature + Gatekeeper acceptance of the built app.
verify:
	@APP=$$(ls -d "$(MACDIR)"/*.app 2>/dev/null | head -1); \
	echo "App: $$APP"; \
	codesign --verify --deep --strict --verbose=2 "$$APP" && echo "✓ signature valid"; \
	spctl --assess --type execute --verbose "$$APP" || true

## Regenerate + re-sign the OTA updater bundle from the notarized .app.
ota:
	@TAURI_SIGNING_KEY_PATH="$(OTA_KEY)" TAURI_SIGNING_KEY_PASSWORD="$(OTA_KEY_PASSWORD)" \
		bash scripts/mac-ota.sh

## Publish the built Mac artifacts to the GitHub release + refresh latest.json.
## Tag/name derive from tauri.conf.json's version (vX.Y.Z); creates the release
## if absent, uploads the DMG + signed .app.tar.gz(.sig), then rebuilds the
## merged OTA manifest.
publish:
	@VERSION=$$(node -e "console.log(require('./src-tauri/tauri.conf.json').version)"); \
	TAG="v$$VERSION"; \
	DMG=$$(ls -t "$(DMGDIR)"/*.dmg 2>/dev/null | head -1); \
	TARBALL=$$(ls -t "$(MACDIR)"/*.app.tar.gz 2>/dev/null | head -1); \
	SIG="$$TARBALL.sig"; \
	if [ -z "$$DMG" ] || [ -z "$$TARBALL" ] || [ ! -f "$$SIG" ]; then \
		echo "ERROR: missing DMG / .app.tar.gz / .sig — run 'make build notarize ota' first"; exit 1; \
	fi; \
	echo "=== Publishing $$TAG to $(REPO) ==="; \
	if ! gh release view "$$TAG" --repo "$(REPO)" >/dev/null 2>&1; then \
		gh release create "$$TAG" --repo "$(REPO)" --title "GhostWire $$VERSION" --notes "GhostWire $$VERSION"; \
	fi; \
	gh release upload "$$TAG" "$$DMG" "$$TARBALL" "$$SIG" --repo "$(REPO)" --clobber; \
	node scripts/make-release-torrents.mjs --tag "$$TAG"; \
	node scripts/build-updater-manifest.mjs "$$TAG"

## Build static site download manifest from binaries in site/downloads/.
site-manifest:
	@node scripts/build-site-download-manifest.mjs

## Full local macOS release: build → notarize → OTA bundle → install → publish.
## Mirrors Libre's `make deploy`. CI (tag push) adds Windows + Linux to the same
## release and merges them into latest.json.
deploy: build notarize ota install publish
	@echo ""
	@echo "✓ Deployed local macOS build + published to $(REPO); OTA feed refreshed."

dev:
	cd $(ROOT) && npm run tauri dev

clean:
	rm -rf $(TAURI)/target/release/bundle

help:
	@grep -E '^##' Makefile | sed 's/## //'
