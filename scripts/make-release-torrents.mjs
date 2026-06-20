#!/usr/bin/env node
/// Create a BitTorrent `.torrent` + magnet for each GhostWire updater bundle, so the app can
/// distribute its own builds peer-to-peer (opt-in P2P self-update + seeding). The magnet is folded
/// into `latest.json` by `build-updater-manifest.mjs`; the VPS bootstrap seeder (infra/seeder) and
/// opt-in users seed the same content. HTTP-from-GitHub always remains the fallback.
///
/// Self-contained — no npm deps: a minimal bencode encoder + Node's `crypto` sha1 build a standard
/// single-file torrent, so the infohash matches any client.
///
/// Modes:
///   node make-release-torrents.mjs --file <bundle> [--out <bundle>.torrent]   # one file (local / dry-run)
///   node make-release-torrents.mjs --tag <vX.Y.Z>                              # all release updater bundles
///
/// `--tag` lists the release's updater bundles, builds a `.torrent` for each (reusing a local copy
/// from src-tauri/target if present, else downloading), uploads the `.torrent`s, and writes
/// `magnets.json` (per-platform magnet/infohash) to the release. Requires an authenticated `gh`.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

const REPO = "InfamousVague/GhostWire.tv";

// Public trackers for discovery; librqbit + the seeder also use DHT, so the swarm works even if a
// tracker is down. The bootstrap seeder (always-on) is what guarantees a fresh release has a peer.
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
];

// ---- bencode (returns a Buffer; handles ints, byte-strings/Buffers, lists, dicts) ----
function bencode(value) {
  if (typeof value === "number") return Buffer.from(`i${Math.trunc(value)}e`);
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === "string") return bencode(Buffer.from(value, "utf8"));
  if (Array.isArray(value)) return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")]);
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = [Buffer.from("d")];
    for (const k of keys) { parts.push(bencode(k), bencode(value[k])); }
    parts.push(Buffer.from("e"));
    return Buffer.concat(parts);
  }
  throw new Error(`cannot bencode ${typeof value}`);
}

/// Pick a power-of-two piece length aiming for ~1000–2000 pieces.
function pieceLengthFor(size) {
  let pl = 1 << 18; // 256 KiB
  while (size / pl > 2000 && pl < (1 << 24)) pl <<= 1; // cap at 16 MiB
  return pl;
}

/// Build a standard single-file `.torrent` for `filePath`. Returns { name, infohash, magnet, buffer }.
function createTorrent(filePath) {
  const data = readFileSync(filePath);
  const name = basename(filePath);
  const pieceLength = pieceLengthFor(data.length);
  const hashes = [];
  for (let off = 0; off < data.length; off += pieceLength) {
    hashes.push(createHash("sha1").update(data.subarray(off, Math.min(off + pieceLength, data.length))).digest());
  }
  const info = {
    name,
    "piece length": pieceLength,
    length: data.length,
    pieces: Buffer.concat(hashes),
  };
  const infohash = createHash("sha1").update(bencode(info)).digest("hex");
  const torrent = {
    announce: TRACKERS[0],
    "announce-list": TRACKERS.map((t) => [t]),
    "created by": "GhostWire release pipeline",
    info,
  };
  const trParams = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  const magnet = `magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(name)}${trParams}`;
  return { name, infohash, magnet, buffer: bencode(torrent) };
}

/// Same platform-key mapping as build-updater-manifest.mjs (Tauri updater platform keys).
function classify(name) {
  if (name.endsWith(".app.tar.gz")) return /x86_64|x64/.test(name) ? "darwin-x86_64" : "darwin-aarch64";
  if (name.endsWith(".AppImage.tar.gz") || name.endsWith(".AppImage")) return "linux-x86_64";
  if (name.endsWith("-setup.exe") || name.endsWith(".nsis.zip")) return /aarch64|arm64/.test(name) ? "windows-aarch64" : "windows-x86_64";
  if (name.endsWith(".msi")) return /aarch64|arm64/.test(name) ? "windows-aarch64" : "windows-x86_64";
  return null;
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---- --file: one bundle (local build / dry-run) ----
const file = arg("--file");
if (file) {
  if (!existsSync(file)) { console.error(`no such file: ${file}`); process.exit(1); }
  const t = createTorrent(file);
  const out = arg("--out") || `${file}.torrent`;
  writeFileSync(out, t.buffer);
  console.error(`✓ ${t.name}  (${(statSync(file).size / 1e6).toFixed(1)} MB)  infohash=${t.infohash}`);
  console.error(`  wrote ${out}`);
  console.log(t.magnet);
  process.exit(0);
}

// ---- --tag: every updater bundle on a release ----
const tag = arg("--tag");
if (!tag) {
  console.error("usage: make-release-torrents.mjs --file <bundle> | --tag <vX.Y.Z>");
  process.exit(1);
}

const assets = JSON.parse(execSync(`gh release view ${tag} --repo ${REPO} --json assets`, { encoding: "utf8" })).assets || [];
const bundles = assets.filter((a) => classify(a.name));
if (bundles.length === 0) { console.error(`no updater bundles on ${tag} yet`); process.exit(0); }

const localDirs = ["src-tauri/target/release/bundle/macos", "src-tauri/target/release/bundle/appimage", "src-tauri/target/release/bundle/nsis", "src-tauri/target/release/bundle/msi"];
const tmp = mkdtempSync(join(tmpdir(), "gw-torrents-"));
const magnets = {};
for (const a of bundles) {
  const platform = classify(a.name);
  let path = localDirs.map((d) => join(d, a.name)).find((p) => existsSync(p));
  if (!path) {
    path = join(tmp, a.name);
    console.error(`↓ downloading ${a.name} …`);
    execSync(`gh release download ${tag} --repo ${REPO} --pattern ${JSON.stringify(a.name)} --dir ${tmp} --clobber`, { stdio: "inherit" });
  }
  const t = createTorrent(path);
  const torrentPath = join(tmp, `${a.name}.torrent`);
  writeFileSync(torrentPath, t.buffer);
  execSync(`gh release upload ${tag} ${JSON.stringify(torrentPath)} --repo ${REPO} --clobber`, { stdio: "inherit" });
  magnets[platform] = { magnet: t.magnet, infohash: t.infohash, name: a.name };
  console.error(`✓ ${platform}: ${a.name} (${t.infohash})`);
}

// Publish the magnet map for build-updater-manifest.mjs (and the website) to consume.
const magnetsPath = join(tmp, "magnets.json");
writeFileSync(magnetsPath, JSON.stringify({ version: tag, platforms: magnets }, null, 2));
execSync(`gh release upload ${tag} ${JSON.stringify(magnetsPath)} --repo ${REPO} --clobber`, { stdio: "inherit" });
console.error(`✓ uploaded magnets.json (${Object.keys(magnets).length} platform(s))`);
