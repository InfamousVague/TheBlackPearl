#!/usr/bin/env node

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = resolve(__dirname, "..");
const downloadsDir = resolve(rootDir, process.argv[2] ?? "site/downloads");
const outputFile = resolve(rootDir, process.argv[3] ?? "site/downloads/downloads.json");

const BUILD_TARGETS = [
  {
    id: "mac-arm64",
    label: "macOS Apple Silicon (.dmg)",
    match: (name, file) => {
      const hasMac = includesAny(name, ["mac", "darwin", "osx"]);
      const hasArm = includesAny(name, ["arm64", "aarch64", "apple-silicon", "apple_silicon"]);
      const validExt = hasExtension(file, [".dmg", ".pkg", ".zip"]);
      return hasMac && hasArm && validExt;
    },
  },
  {
    id: "mac-x64",
    label: "macOS Intel (.dmg)",
    match: (name, file) => {
      const hasMac = includesAny(name, ["mac", "darwin", "osx"]);
      const hasX64 = includesAny(name, ["x64", "x86_64", "amd64", "intel"]);
      const validExt = hasExtension(file, [".dmg", ".pkg", ".zip"]);
      return hasMac && hasX64 && validExt;
    },
  },
  {
    id: "windows-x64",
    label: "Windows x64 (.zip)",
    match: (name, file) => {
      const hasWindows = includesAny(name, ["win", "windows", "nsis"]);
      const hasX64 = includesAny(name, ["x64", "x86_64", "amd64"]);
      const validExt = hasExtension(file, [".zip", ".exe", ".msi"]);
      return hasWindows && hasX64 && validExt;
    },
  },
  {
    id: "linux-x64",
    label: "Linux x86_64 (.AppImage)",
    match: (name, file) => {
      const hasLinux = includesAny(name, ["linux", "appimage", "ubuntu", "debian", "fedora"]);
      const hasX64 = includesAny(name, ["x64", "x86_64", "amd64"]) || file.toLowerCase().endsWith(".appimage");
      const validExt = hasExtension(file, [".appimage", ".tar.gz", ".deb", ".rpm", ".zip"]);
      return hasLinux && hasX64 && validExt;
    },
  },
];

if (!existsSync(downloadsDir)) {
  console.error(`[site manifest] downloads directory not found: ${downloadsDir}`);
  process.exit(1);
}

const files = readdirSync(downloadsDir)
  .filter((file) => {
    const lower = file.toLowerCase();
    if (lower === ".ds_store") return false;
    if (lower.endsWith(".txt")) return false;
    if (lower.endsWith(".json")) return false;
    return true;
  })
  .map((file) => {
    const fullPath = join(downloadsDir, file);
    const stats = statSync(fullPath);
    return {
      file,
      lower: file.toLowerCase(),
      fullPath,
      stats,
    };
  })
  .filter((entry) => entry.stats.isFile());

const builds = [];

for (const target of BUILD_TARGETS) {
  const matches = files
    .filter((entry) => target.match(entry.lower, entry.file))
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);

  if (!matches.length) continue;

  const chosen = matches[0];
  builds.push({
    id: target.id,
    label: target.label,
    href: `/downloads/${encodeURIComponent(chosen.file)}`,
    fileName: chosen.file,
    sizeBytes: chosen.stats.size,
    updatedAt: new Date(chosen.stats.mtimeMs).toISOString(),
  });
}

if (!builds.length) {
  console.error(
    `[site manifest] no release assets found in ${downloadsDir}. ` +
      "Add binaries first, then run this script again.",
  );
  process.exit(1);
}

const manifest = {
  generatedAt: new Date().toISOString(),
  builds,
};

writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`[site manifest] wrote ${builds.length} build entries to ${outputFile}`);

function includesAny(text, values) {
  return values.some((value) => text.includes(value));
}

function hasExtension(fileName, extensions) {
  const lower = fileName.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}
