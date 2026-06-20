# GhostWire — "Legal Modern LimeWire" Roadmap

Living plan for closing feature gaps and reaching the north-star: a beautiful,
cross-platform P2P app where people **discover, stream, download, AND share**
freely-licensed media (music-first), with trust/safety so you don't get malware,
and a path for creators to publish their own content.

> **How to use this doc:** Each phase has a checklist. Mark `[x]` as items land,
> add a dated note under **Progress Log** at the bottom. If a session is cut off,
> read the Progress Log first, then resume the first unchecked item in the lowest
> open phase.

---

## Legal posture (DECIDED — do not revisit without sign-off)

- **Torrent creation is 100% local.** The app hashes local files and writes a
  `.torrent`/magnet on the user's machine. Their machine is the seed. We never
  receive, store, list, or index user-created content.
- **We do NOT run our own index/list of user uploads** (no "Model C"). That would
  make us a host/indexer with DMCA-agent, moderation, and *Grokster* inducement
  liability.
- **Discovery comes from curated legal third-party catalogs** (Internet Archive,
  Jamendo, Free Music Archive, ccMixter, Bandcamp, public-domain film). They host
  and license the content; we just link/stream. They carry the liability.
- **Optional later:** "Share to *your* account on a third-party tracker/Archive"
  (Model B) — user publishes under their identity to a third party, never to us.

---

## Validation commands

- Backend: `cargo check --manifest-path src-tauri/Cargo.toml` (16 pre-existing
  unused-`tidal` warnings are expected/OK).
- Frontend: rely on editor diagnostics (`get_errors`) on touched files. Full
  `npm run typecheck` fails on pre-existing `@mattmattmattmatt/base/*` TS2307
  module-resolution errors — those are NOT regressions.
- Frontend build smoke: `npm run build` (Vite warnings about chunking are OK).

## Key files / contracts

- Torrent engine bridge (Rust): `src-tauri/src/engine.rs` (librqbit, 1Hz snapshot
  via `ghosty://downloads`, queue scheduler `schedule_queue`).
- Command registry: `src-tauri/src/lib.rs` (`generate_handler!` ~L5665).
- Frontend engine IPC: `src/ipc/engine.ts`. Library IPC: `src/ipc/library.ts`.
- Downloads UI: `src/views/Downloads.tsx`. Sources UI: `src/views/Sources.tsx`.
- Settings panels: `src/views/Settings.tsx` + `src/lib/settingsTabs.ts`.
- Source adapters: `src-tauri/src/indexer.rs`. Discover: `src-tauri/src/trending.rs`.

---

## Phase 0 — Foundations: the "share" + "legal" core (HIGHEST IMPACT)

The trio below is what separates a "legal modern LimeWire" from both a generic
torrent client and a piracy tool. Ship these together.

### P0.1 — Local torrent creation + seed (the LimeWire soul)
- [x] Backend `create_torrent` command in `lib.rs`: source path + optional save
      path + trackers + start_seeding; returns `CreatedTorrent` (infohash, magnet,
      name, size, file count, torrent path, seeding). Uses librqbit
      `create_torrent` (engine.rs `Engine::create_torrent`).
- [x] Backend `seed_torrent` command: re-seed a `.torrent` from a content dir
      (engine.rs `Engine::seed_torrent`).
- [x] IPC in `src/ipc/engine.ts`: `createTorrent(sourcePath, opts)`,
      `seedTorrent(torrentPath, contentDir)`, `CreatedTorrent` type.
- [x] UI: `src/components/CreateTorrentDialog.tsx` — pick file/folder, optional
      trackers, writes `.torrent` (save dialog), starts seeding, shows magnet +
      copy. Wired into `src/views/Downloads.tsx` header ("Create torrent") and the
      empty state. "Stays on your machine / nothing uploaded" copy is explicit.
- [x] Validated: `cargo check` passes (16 pre-existing tidal warnings only);
      `npm run build` succeeds. Live magnet round-trip test still TODO (manual).

### P0.2 — Curated legal catalogs (make "legal" the default)
> **NOTE:** P0.2 was DEFERRED at the user's request (jumped to P0.3, then P1).

- [ ] Jamendo adapter (free/CC music) in `indexer.rs` (+ Discover wiring).
- [ ] Free Music Archive + ccMixter adapters.
- [ ] License metadata surfaced on cards (CC-BY / public domain / etc.) — add
      `license` field to catalog item type; render a badge in poster/search cards.
- [ ] Seed these as default sources (extend `seed_default_sources` in lib.rs).

### P0.3 — Trust & safety layer (what actually killed LimeWire)
- [x] **Risky-file detection** (the headline anti-fakes defense): backend
      `src-tauri/src/safety.rs` flags disguised double-extensions (`song.mp3.exe`)
      and executables/scripts; filename-only, instant, private (5 unit tests).
      `scan_safety(id)` command in `lib.rs`; `scanSafety` + `SafetyReport`/`RiskyFile`
      in `src/ipc/library.ts`; `src/components/SafetyReportDialog.tsx` shows a
      safe/caution/danger verdict, wired as a "Check for risky files" context-menu
      action on disk items + groups in `src/views/Downloads.tsx`.
- [ ] Verified-source badge for curated-catalog items — DEFERRED (depends on P0.2).
- [ ] Optional ClamAV scan hook on completed files (off by default) — not started.
- [ ] File preview before commit — partially possible via stream; not formalized.
- [ ] Community signal (ratings/report) — DEFERRED (needs a liability-safe store;
      design alongside P1.2 social infra).

---

## Phase 1 — Client parity + social discovery + casting

### P1.1 — Torrent client power features (vs qBittorrent/Transmission)
- [ ] Global + per-torrent **speed limits** (down/up) — engine fields + commands
      `set_rate_limits` / `get_rate_limits`; Settings + per-row UI.
- [ ] **Bandwidth scheduler** (time-of-day caps).
- [ ] **Selective file download** within a multi-file torrent (file priority).
- [ ] **Sequential / streaming piece priority** toggle.
- [ ] **RSS auto-download rules** (subscribe to a feed + match rules → auto-add).
- [ ] **SOCKS5/HTTP proxy** support + **IP blocklist** import.
- [ ] **Labels/categories** + ratio/seed-goal management; tracker edit/reannounce.

### P1.2 — Soulseek-style social P2P (decentralized, liability-safe)
- [x] **Coordination server built** (`server/`, Node/TS): identity (Ed25519
      challenge/response, no passwords), follows, presence, and live
      friend-to-friend `search`/`browse` routing over WebSocket. Stores ONLY
      handles + social graph + reports/bans — never content/magnets (pure
      signaling, Soulseek model). REST + WS API, `better-sqlite3` store. Local
      `tsc` build + boot/health + Ed25519 register round-trip validated.
- [x] **Deploy tooling**: `server/deploy/` — `provision.sh` (idempotent VPS
      bootstrap: Node, `ghostwire` user, runtime `.env`, systemd unit, reverse
      proxy) + `deploy.sh` (build → rsync → `npm ci --omit=dev` → restart;
      sshpass/password auth via repo-root `.env.apple`). `server/README.md` has
      the full flow.
- [x] **DEPLOYED LIVE & VERIFIED** on `ghostwire.tv` (Caddy auto-TLS, systemd
      `ghostwire-social` on `127.0.0.1:8791`). Exposed path-based on the existing
      cert: `handle_path /social/*` → 8791. Public base `https://ghostwire.tv/social`.
      Verified end-to-end over HTTPS+WSS: health, register/challenge/verify/me,
      and the WS `ready` frame. (Port 8787 = artwork relay `bp-relay`; box is
      Caddy-fronted, not nginx.)
- [x] **Decision (transport):** central signaling relay chosen over DHT — server
      routes messages only, transfers stay P2P; keeps us out of hosting/indexing.
- [x] Client wiring: Rust IPC (Ed25519 keypair persisted 0600 in app data dir,
      REST + persistent WebSocket client in `src-tauri/src/social.rs`) + frontend
      social UI (`src/views/Social.tsx`: handle setup, follow/unfollow, friends
      with live presence, friend search/browse, "Get" into the engine). Server URL
      configurable (default `https://ghostwire.tv/social`).
- [x] User-to-user search + browseable shared folders — server + client done; the
      WS reader answers `search-req`/`browse-req` from the user's seeding torrents
      (`Engine::seeding_shares`). _Manual two-machine smoke test still pending._

### P1.3 — Casting + external playback
- [ ] Chromecast + AirPlay + DLNA "cast to TV".
- [ ] External player handoff (VLC / IINA).
- [ ] PiP / floating video mini-player.

---

## Phase 2 — Music depth + reach

### P2.1 — Music polish (vs Soulseek/navidrome/Spotify)
- [ ] Scrobbling (Last.fm / ListenBrainz).
- [ ] Lyrics.
- [ ] Gapless playback + crossfade.
- [ ] ReplayGain / loudness normalization.
- [ ] Smart playlists + radio/auto-DJ.
- [ ] Podcast support.
- [ ] In-app tag editor UI (backend tag engine already exists — `automation`).

### P2.2 — Reach
- [ ] Web UI / headless daemon mode for remote control.
- [ ] Native mobile apps (beyond the current iOS companion mirror).
- [ ] i18n/localization + accessibility pass.

---

## Phase 3 — Personalization + media-server niceties

- [ ] "Continue Watching" + cross-device resume + watch history.
- [ ] Multi-user profiles + parental controls.
- [ ] Recommendations / personalization engine.
- [ ] Hardware-accelerated transcode toggle.

---

## Progress Log

> Append dated entries here as work lands so a cut-off session can resume cleanly.

- 2026-06-18 — Plan created. Legal posture decided (local-only creation, no hosted
  list, curated legal catalogs for discovery). Next action: begin **P0.1 — Local
  torrent creation + seed**, starting with the `create_torrent` backend command in
  `src-tauri/src/lib.rs` using librqbit's create support.
- 2026-06-18 — **P0.1 DONE.** Backend `create_torrent`/`seed_torrent` (engine.rs +
  lib.rs, registered in `generate_handler!`), magnet builder + percent-encode
  helper in engine.rs. Frontend `createTorrent`/`seedTorrent` IPC + `CreatedTorrent`
  type in `src/ipc/engine.ts`. New `src/components/CreateTorrentDialog.tsx` wired
  into Downloads header + empty state (hidden on iOS). `cargo check` + `npm run
  build` both pass. Remaining: manual magnet round-trip test in a 2nd client.
  Next: **P0.2 — curated legal catalog adapters** (Internet Archive audio/video,
  Jamendo, FMA, ccMixter) + license-badge metadata field.
- 2026-06-18 — **P0.2 DEFERRED** (user request) and **P0.3 core DONE.** New
  `src-tauri/src/safety.rs` (risky-file heuristics: disguised double-extensions +
  executables, 5 unit tests passing). `scan_safety` command registered. Frontend
  `scanSafety`/`SafetyReport` IPC + `SafetyReportDialog.tsx` + "Check for risky
  files" context-menu actions in Downloads. `cargo test --lib safety` (5/5) and
  `npm run build` pass. Deferred within P0.3: verified-source badge (needs P0.2),
  optional ClamAV hook, community ratings (needs P1.2 infra).
  Next: **P1** — start with P1.1 (client power features, no server) and/or P1.3
  (casting, no server). P1.2 (social P2P) needs server/decentralized infra.
- 2026-06-18 — **P1.2 SERVER + DEPLOY DONE** (user opted in to infra). New `server/`
  Node/TS coordination service: Ed25519 challenge/response auth (no passwords),
  follows, presence, and live mutual-friend `search`/`browse` routing over WS. It
  is a pure signaling server — stores only identities + social graph + reports/
  bans, never content or magnet lists (transfers stay P2P). Files: `src/config.ts`,
  `protocol.ts`, `db.ts` (better-sqlite3), `auth.ts`, `hub.ts`, `routes.ts` (REST
  router), `ws.ts` (WebSocket hub), `index.ts`. Deploy: `deploy/deploy.sh` +
  `ghostwire-social.service` (systemd) + `nginx-social.conf.example` (WS reverse
  proxy, `social.ghostwire.tv`) + `.env.example` (runtime) + `deploy/.env.example`
  (VPS target; user fills in). `server/README.md` documents full VPS bring-up.
  Validated: `npm run build` (tsc) clean, server boots, `/v1/health` OK, Ed25519
  `/v1/register` round-trip returns 201 + token. Transport decision: central
  signaling relay (not DHT). NEXT: client wiring — Rust IPC (keypair in keychain,
  REST + WS client) then frontend social UI (handle/profile, follow, friends,
  search/browse) advertising the user's own created/seeded torrents.
- 2026-06-18 — **P1.2 SERVER DEPLOYED LIVE.** Provisioned `ghostwire.tv` VPS
  (Ubuntu 26.04, root) via new `server/deploy/provision.sh` + `deploy.sh`
  (password auth from repo-root `.env.apple` via sshpass). Service runs under
  systemd as `ghostwire-social` (user `ghostwire`, `127.0.0.1:8791`; 8787 was the
  `bp-relay` artwork relay). The box is fronted by **Caddy** (auto-TLS), not
  nginx — added `handle_path /social/*` → 8791 to the apex Caddy block (backup +
  `caddy validate` + reload). Public endpoint **`https://ghostwire.tv/social`**.
  Verified from the dev machine over HTTPS + WSS: `/v1/health`, full Ed25519
  register/challenge/verify/me, and the WebSocket `ready` frame. provision.sh +
  README updated to Caddy reality. NEXT: client wiring (Rust IPC keypair/keychain
  + REST/WS client, then frontend social UI).
- 2026-06-18 — **P1.2 CLIENT DONE.** Wired the Tauri app to the live coordination
  server. Backend: added `ed25519-dalek`, `tokio-tungstenite` (rustls), and
  `futures-util`; new `src-tauri/src/social.rs` holds a persistent Ed25519 identity
  (0600 file in the app data dir — no passwords), a reqwest REST client
  (register/login via challenge→signed-nonce→bearer token, follow graph, reports),
  and a persistent WebSocket that emits `social://*` events to the UI and answers
  friend `search-req`/`browse-req` from the user's OWN seeding torrents (new
  `Engine::seeding_shares`). Twelve `social_*` commands registered; identity loads
  + auto-reconnects on launch. Frontend: `src/ipc/social.ts` (typed wrappers +
  event listeners + `shareMagnet`), `src/views/Social.tsx` + `.css` (handle setup →
  reconnect → friends w/ live presence, follow/unfollow, streaming friend search,
  browse a friend, "Get" pulls a share into the engine peer-to-peer), a **Friends**
  rail entry, and a configurable server URL (default `https://ghostwire.tv/social`,
  persisted as the `social_server_url` setting). The server NEVER sees content or
  magnets — transfers stay pure BitTorrent. `cargo check` + `npm run build` clean.
  NEXT: two-machine end-to-end smoke test (mutual follow, seed on A, Get from B).
