#!/usr/bin/env node
/// Build (or refresh) the `latest.json` file the Tauri OTA updater pulls from a
/// release. Walks the release's assets via `gh`, pairs each updater bundle
/// (`.app.tar.gz` / `.AppImage.tar.gz` / `-setup.exe` / `.nsis.zip` / `.msi`)
/// with its sibling `.sig`, and emits the manifest Tauri expects:
///
///   {
///     "version": "v0.1.1",
///     "notes": "…",
///     "pub_date": "2026-…Z",
///     "platforms": {
///       "darwin-aarch64":  { "signature": "...", "url": "..." },
///       "linux-x86_64":    { "signature": "...", "url": "..." },
///       "windows-x86_64":  { "signature": "...", "url": "..." }
///     }
///   }
///
/// Then uploads it to the release as `latest.json`. tauri.conf.json's
/// plugins.updater endpoint is
///   https://github.com/InfamousVague/GhostWire.tv/releases/latest/download/latest.json
/// and the `/latest/download/<filename>` redirect resolves to the most recent
/// release's `latest.json`.
///
/// Why not let tauri-action generate this in CI? It does, but PER-PLATFORM with
/// the same filename — so the matrix overwrites itself and the final latest.json
/// only carries the LAST platform. This runs once at the end (CI's `manifest`
/// job and the local `make deploy` both invoke it) and produces a complete
/// manifest, MERGING with any existing one so local-macOS + CI-Win/Linux uploads
/// reconcile in either order.
///
/// Usage:  node scripts/build-updater-manifest.mjs <tag>
/// Auth:   relies on `gh` being authenticated (CI uses GITHUB_TOKEN).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: build-updater-manifest.mjs <tag>");
  process.exit(1);
}

const REPO = "InfamousVague/GhostWire.tv";

/// Map a Tauri updater asset filename → platform key.
/// See https://v2.tauri.app/plugin/updater/#platform-keys
function classify(name) {
  if (name.endsWith(".app.tar.gz")) {
    if (/x86_64|x64/.test(name)) return "darwin-x86_64";
    if (/aarch64|arm64/.test(name)) return "darwin-aarch64";
    // Universal binary handles arch selection internally — default to aarch64.
    return "darwin-aarch64";
  }
  if (name.endsWith(".AppImage.tar.gz")) return "linux-x86_64";
  if (name.endsWith(".AppImage")) return "linux-x86_64";
  if (name.endsWith(".deb")) return "linux-x86_64";
  if (name.endsWith(".rpm")) return "linux-x86_64";
  if (name.endsWith("-setup.exe") || name.endsWith(".nsis.zip")) {
    if (/aarch64|arm64/.test(name)) return "windows-aarch64";
    return "windows-x86_64";
  }
  if (name.endsWith(".msi")) {
    if (/aarch64|arm64/.test(name)) return "windows-aarch64";
    return "windows-x86_64";
  }
  return null;
}

/// Lower = preferred. Sorted so the preferred installer for each platform wins
/// the last-write in the platforms map.
function priority(name) {
  if (name.endsWith(".app.tar.gz")) return 0;
  if (name.endsWith(".AppImage.tar.gz")) return 1;
  if (name.endsWith("-setup.exe")) return 2;
  if (name.endsWith(".nsis.zip")) return 3;
  if (name.endsWith(".AppImage")) return 4;
  if (name.endsWith(".deb")) return 5;
  if (name.endsWith(".rpm")) return 6;
  if (name.endsWith(".msi")) return 7;
  return 99;
}

const releaseJson = execSync(
  `gh release view "${tag}" --repo "${REPO}" --json tagName,publishedAt,assets,body`,
  { encoding: "utf8" },
);
const release = JSON.parse(releaseJson);

const platforms = {};
const sigByName = new Map();
for (const a of release.assets) {
  if (a.name.endsWith(".sig")) sigByName.set(a.name.replace(/\.sig$/, ""), a);
}
const orderedAssets = [...release.assets].sort(
  (a, b) => priority(b.name) - priority(a.name),
);
for (const a of orderedAssets) {
  const key = classify(a.name);
  if (!key) continue;
  const sigAsset = sigByName.get(a.name);
  if (!sigAsset) {
    console.warn(`[updater] no .sig found for ${a.name} — skipping`);
    continue;
  }
  // The .sig content isn't in the asset metadata — download it (it's tiny).
  const sigPath = join(tmpdir(), `bpsig-${tag}-${a.name}.sig`);
  try {
    execSync(
      `gh release download "${tag}" --repo "${REPO}" --pattern "${a.name}.sig" --output "${sigPath}" --clobber`,
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const signature = readFileSync(sigPath, "utf8").trim();
    platforms[key] = {
      signature,
      url: a.url || `https://github.com/${REPO}/releases/download/${tag}/${a.name}`,
    };
    console.log(`[updater] ${key} ← ${a.name}`);
  } catch (e) {
    console.warn(`[updater] couldn't read sig for ${a.name}: ${e.message}`);
  } finally {
    try {
      unlinkSync(sigPath);
    } catch {
      /* ignore */
    }
  }
}

// Fold in the per-platform torrent magnets (from make-release-torrents.mjs's magnets.json) so the
// app's opt-in P2P updater + seeder can pull each bundle over BitTorrent. The HTTP `url` stays the
// guaranteed fallback; a missing magnet just means that platform is HTTP-only.
const magnetsAsset = release.assets.find((a) => a.name === "magnets.json");
if (magnetsAsset) {
  const mPath = join(tmpdir(), `gw-magnets-${tag}.json`);
  try {
    execSync(
      `gh release download "${tag}" --repo "${REPO}" --pattern "magnets.json" --output "${mPath}" --clobber`,
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    let n = 0;
    for (const [key, info] of Object.entries(m.platforms || {})) {
      if (platforms[key] && info?.magnet) { platforms[key].magnet = info.magnet; n++; }
    }
    console.log(`[updater] merged torrent magnets for ${n} platform(s)`);
  } catch (e) {
    console.warn(`[updater] couldn't read magnets.json: ${e.message}`);
  } finally {
    try { unlinkSync(mPath); } catch { /* ignore */ }
  }
}

if (Object.keys(platforms).length === 0) {
  console.error(
    `[updater] no signed updater assets found on ${tag}.\n` +
      `Run a build with TAURI_SIGNING_PRIVATE_KEY set so .sig files are produced.`,
  );
  process.exit(1);
}

/// Merge with the existing manifest on this release (if any) so local-macOS and
/// CI-Win/Linux uploads don't wipe each other — overlay only the keys we found.
let mergedPlatforms = platforms;
const existing = release.assets.find((a) => a.name === "latest.json");
if (existing) {
  const existingPath = join(tmpdir(), `bp-existing-manifest-${tag}.json`);
  try {
    execSync(
      `gh release download "${tag}" --repo "${REPO}" --pattern "latest.json" --output "${existingPath}" --clobber`,
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const prior = JSON.parse(readFileSync(existingPath, "utf8"));
    if (prior && typeof prior === "object" && prior.platforms) {
      mergedPlatforms = { ...prior.platforms, ...platforms };
      const merged = Object.keys(platforms);
      const preserved = Object.keys(prior.platforms).filter((k) => !platforms[k]);
      console.log(
        `[updater] merged with existing manifest — overwriting ${merged.length} key(s) (${merged.join(", ")}), preserving ${preserved.length} (${preserved.join(", ") || "none"})`,
      );
    }
  } catch (e) {
    console.warn(`[updater] couldn't merge existing manifest (${e.message}); writing fresh`);
  } finally {
    try {
      unlinkSync(existingPath);
    } catch {
      /* ignore */
    }
  }
}

const manifest = {
  version: release.tagName,
  notes: (release.body || "").trim() || `GhostWire ${release.tagName}`,
  pub_date: release.publishedAt,
  platforms: mergedPlatforms,
};

// The file MUST be named exactly `latest.json` on disk — the updater endpoint
// resolves on filename match, so a misnamed asset breaks OTA silently.
const stagingDir = mkdtempSync(join(tmpdir(), "bp-manifest-"));
const manifestPath = join(stagingDir, "latest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`\n[updater] manifest:\n${JSON.stringify(manifest, null, 2)}`);

execSync(`gh release upload "${tag}" "${manifestPath}" --repo "${REPO}" --clobber`, {
  stdio: "inherit",
});
console.log(`\n[updater] uploaded to ${tag} as latest.json`);
unlinkSync(manifestPath);
