//! GhostWire torrent engine: a librqbit session + a loopback HTTP server that
//! serves any file from an active torrent with HTTP Range support, so a
//! `<video>` element can stream it while it's still downloading.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use axum::{
    body::Body,
    extract::{ConnectInfo, Path as AxPath, Query as AxQuery, State as AxState},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use librqbit::{AddTorrent, AddTorrentOptions, AddTorrentResponse, ManagedTorrent, Session, SessionOptions, SessionPersistenceConfig};

use crate::catalog::Catalog;
use crate::remote::{self, DeviceIdentity, Pairing};
use crate::AppInfo;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::RwLock;
use tokio_util::io::ReaderStream;

/// Fixed loopback port for the streaming server (kept stable so the CSP can name it).
pub const STREAM_PORT: u16 = 3030;

/// HLS segment length (seconds). Forced keyframes at this interval make every segment
/// exactly this long, so a generated VOD playlist's timing matches the real segments.
const HLS_SEG: f64 = 4.0;

/// Event channel name (mirrors `src/ipc/engine.ts`).
const DOWNLOADS_EVENT: &str = "ghosty://downloads";
/// How many downloads may transfer at once — the rest wait in the queue, oldest first, and
/// start automatically as slots free up. Two by default so one slow-but-alive torrent can't
/// stall the whole queue (the scheduler still hard-caps + rotates stalled ones); user-adjustable
/// up to the cap.
const DEFAULT_MAX_ACTIVE_DOWNLOADS: usize = 2;
const MAX_ACTIVE_DOWNLOADS_CAP: usize = 6;
/// A just-released download holds its slot this long even with no peers/bytes yet, so a
/// dead/stalled magnet at the head of the queue eventually yields to the next one. Kept short so
/// a dead magnet doesn't sit on a slot for long.
const QUEUE_STALL_GRACE: Duration = Duration::from_secs(30);

type Handle = Arc<ManagedTorrent>;
type Torrents = Arc<RwLock<HashMap<String, Entry>>>;
/// A queued download whose magnet metadata is still resolving (so there's no `Entry`/handle yet).
/// Surfaced in snapshots as a "queued" row so the download appears INSTANTLY on click, then is
/// replaced by the real `Entry` once `add_magnet` finishes resolving (which can take ~a minute).
struct Pending {
    title: String,
    added: std::time::Instant,
}
type PendingAdds = Arc<RwLock<HashMap<String, Pending>>>;
/// Downloads removed while their magnet was still resolving. When the async add task completes,
/// these ids are immediately torn down so cancelled rows do not "come back" later or on relaunch.
type CancelledAdds = Arc<RwLock<HashSet<String>>>;
/// Last ffmpeg failure per infohash (so transcode errors surface in media_info).
type TranscodeErrors = Arc<RwLock<HashMap<String, String>>>;

/// A running ffmpeg HLS transcode (playlist + segments on disk under hls_root).
struct HlsJob {
    dir: PathBuf,
    duration: f64, // source duration (s) → drives the VOD playlist; 0 if unknown
    _child: tokio::process::Child, // kill_on_drop terminates ffmpeg when dropped
}
type HlsJobs = Arc<RwLock<HashMap<String, HlsJob>>>;

struct Entry {
    handle: Handle,
    title: String,
    magnet: String,
    added: std::time::Instant,
    /// True for items the download queue manages (a "download"); false for ephemeral stream
    /// previews, which start immediately and never occupy a queue slot.
    queue_managed: bool,
    /// True while a queue-managed download is WAITING its turn (paused by the scheduler).
    queued: bool,
    /// When the scheduler last released this download to run — drives the stall grace below.
    released_at: Option<std::time::Instant>,
    /// Highest `progress_bytes` observed so far, sampled by the scheduler each tick. Compared
    /// against the current value to detect bytes actually arriving (a download "working now").
    last_progress_bytes: u64,
    /// When `progress_bytes` last increased — the activity signal that keeps a web-seeded
    /// archive.org download (0 BitTorrent peers, bursty speed) holding its slot.
    progressed_at: Option<std::time::Instant>,
    /// True for entries we added purely to SEED already-on-disk content (a share). The files
    /// exist, so librqbit briefly re-verifies (Initializing → Live) before settling into
    /// seeding — during that window a naive snapshot reports it as a 0%/connecting *download*,
    /// flashing the share under "Downloads" for a beat. We report seeds as seeding from the
    /// start (progress 1.0) so a freshly-shared item lands straight in the Seeding section.
    is_seed: bool,
}

/// Shared axum state for the loopback media server.
#[derive(Clone)]
struct ServerState {
    torrents: Torrents,
    /// Downloads whose magnets are still resolving (shown immediately in snapshots).
    pending: PendingAdds,
    ffmpeg: Option<PathBuf>,
    ffprobe: Option<PathBuf>,
    transcode_errors: TranscodeErrors,
    hls: HlsJobs,
    hls_root: PathBuf,
    /// On-disk poster cache served at /art/{id} for the local artwork library.
    art_dir: PathBuf,
    /// Shared HTTP client for the /img cache fetcher (connection reuse + sane timeouts).
    http: reqwest::Client,
    /// Download root — local finished files are served at /file/{relpath} for the Library.
    download_dir: PathBuf,
    // --- LAN device-linking (the Mac acts as host for a linked iPad) ---
    /// librqbit session, so `/api/add_torrent` can start downloads on this host.
    session: Arc<Session>,
    /// Runtime queue cap (set from Settings/Downloads dropdown).
    max_active_downloads: Arc<RwLock<usize>>,
    /// HMAC key for verifying bearer + stream tokens from LAN clients.
    secret: String,
    device_name: String,
    device_id: String,
    /// Current PIN pairing offer (set by the `pairing_pin` command).
    pairing: Pairing,
    // --- companion-mode mirroring (a linked iPad fully mirrors this desktop) ---
    /// Shared SQLite catalog handle, so the LAN API can serve Discover/catalog + Library.
    catalog: Catalog,
    /// App paths + ffmpeg flag, so the LAN API can run the same on-disk Library scan.
    app_info: AppInfo,
}

/// Mirrors the TS `DownloadStats` interface (camelCase over the wire).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStats {
    id: String,
    title: String,
    state: String,
    progress: f64,
    down_speed: u64,
    up_speed: u64,
    peers: u32,
    stream_url: Option<String>,
    /// True ONLY for content the user deliberately put up to share with their connections —
    /// a local seed created via "Share with network" / "Create torrent". False for downloaded
    /// torrents that are merely seeding back to the public swarm. Serialized as `shared` so the
    /// UI can cleanly separate "shared with my connections" from "seeding to random peers".
    #[serde(rename = "shared")]
    is_seed: bool,
}

/// One thing the user is seeding, offered to a friend over the social link. The transfer
/// itself is pure BitTorrent (the magnet built from this infohash) — the social server
/// only ever relays this lightweight pointer, never the bytes. The extra fields let the
/// receiving peer (a) connect DIRECTLY to this seeder instead of waiting on DHT, and
/// (b) know exactly what the content is, so it resolves the real cover art instead of
/// guessing from the file name.
#[derive(Serialize, Clone, Default)]
pub struct SeedShare {
    pub infohash: String,
    pub name: String,
    /// Candidate `ip:port` socket addresses where this host is seeding, so the friend's client
    /// can dial in directly. LAN address today; reachable across the internet when the engine's
    /// UPnP port-forward succeeds. Empty when the listen port / LAN IP can't be determined.
    pub peers: Vec<String>,
    /// Coarse bucket — video / audio / books / software / data / other.
    pub category: Option<String>,
    /// Finer media type — movie / show / music / book / game — when the file makes it obvious.
    pub media_type: Option<String>,
    pub size_bytes: Option<u64>,
    /// Music tags read from the file itself, so the peer resolves the album cover precisely.
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track_title: Option<String>,
}

/// Resolved metadata for one seeding torrent (what it is + its tags), attached to a share.
#[derive(Default)]
struct ShareMeta {
    category: Option<String>,
    media_type: Option<String>,
    size_bytes: Option<u64>,
    artist: Option<String>,
    album: Option<String>,
    track_title: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    index: usize,
    name: String,
    size: u64,
}

/// Rich per-torrent diagnostics for the player's "what's streaming" panel.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    state: String,
    peers: u32,
    has_meta: bool,
    progress: f64,
    total_bytes: u64,
    age_secs: u64,
    trackers: usize,
    webseed: bool,
    file_name: Option<String>,
    file_ext: Option<String>,
    file_size: u64,
    /// Path of the selected file relative to the download folder — lets the player look
    /// up subtitles (sidecar + embedded) for a torrent that's still streaming, not just
    /// already-downloaded local files.
    rel_path: Option<String>,
    files: Vec<FileEntry>,
    /// "video" | "audio" | "other" — drives how the UI plays it (and whether the
    /// encoder is allowed to touch it at all).
    media_kind: Option<String>,
    endpoint: Option<String>,
    endpoint_reason: Option<String>,
    container: Option<String>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    ffmpeg_available: bool,
    ffprobe_available: bool,
    transcode_error: Option<String>,
    detail: String,
}

/// A subtitle track offered to the player, served as WebVTT from the loopback server.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubTrack {
    pub label: String,
    pub lang: String,
    pub url: String,
}

/// Result of creating a torrent from local files — everything the UI needs to save the
/// `.torrent`, copy the magnet, and confirm seeding started. Nothing here leaves the user's
/// machine: creation is purely local hashing and the user's own client is the seed.
#[derive(serde::Serialize, Clone)]
pub struct CreatedTorrent {
    pub infohash: String,
    pub magnet: String,
    pub name: String,
    pub size_bytes: u64,
    pub file_count: usize,
    /// Absolute path the `.torrent` file was written to, if a save path was given.
    pub torrent_path: Option<String>,
    /// True if the engine started seeding the source files right away.
    pub seeding: bool,
}

/// Build a magnet URI from an infohash hex + display name + optional trackers. Trackerless
/// magnets still resolve via DHT; trackers are advertised only when the user supplies them.
fn build_magnet(infohash: &str, name: &str, trackers: &[String]) -> String {
    let mut m = format!("magnet:?xt=urn:btih:{infohash}");
    if !name.is_empty() {
        m.push_str("&dn=");
        m.push_str(&percent_encode(name));
    }
    for tr in trackers {
        let tr = tr.trim();
        if !tr.is_empty() {
            m.push_str("&tr=");
            m.push_str(&percent_encode(tr));
        }
    }
    m
}

/// Minimal RFC-3986 percent-encoding for magnet query values (keeps the dependency surface
/// small — no `url`/`urlencoding` crate needed just for two fields).
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub struct Engine {
    session: Arc<Session>,
    torrents: Torrents,
    /// Downloads whose magnets are still resolving — shown immediately, before they become Entries.
    pending: PendingAdds,
    /// Cancels for still-resolving magnets (prevents resurrection after remove/clear).
    cancelled: CancelledAdds,
    /// Runtime queue cap; defaults to 1 and can be changed from the Downloads view.
    max_active_downloads: Arc<RwLock<usize>>,
    ffmpeg: Option<PathBuf>,
    ffprobe: Option<PathBuf>,
    download_dir: PathBuf,
    transcode_errors: TranscodeErrors,
    hls: HlsJobs,
    /// Shared PIN pairing offer — the `pairing_pin` command writes here; `/api/pair` reads it.
    pairing: Pairing,
    /// VPN kill-switch: while true the queue scheduler is frozen so no paused download is
    /// resumed and no new traffic starts. Flipped by the VPN monitor / kill-switch commands.
    network_blocked: Arc<AtomicBool>,
}

impl Engine {
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        app: AppHandle,
        download_dir: PathBuf,
        art_dir: PathBuf,
        ffmpeg: Option<PathBuf>,
        ffprobe: Option<PathBuf>,
        identity: DeviceIdentity,
        catalog: Catalog,
        app_info: AppInfo,
    ) -> Result<Engine> {
        // Don't re-bind a *persisted* DHT port: librqbit otherwise re-uses a port saved
        // in the data dir, so a second instance sharing that dir (e.g. the dev build
        // running alongside the installed app) collides on it and the whole app aborts
        // during setup. A fresh ephemeral DHT port per launch lets instances coexist.
        // Persist the torrent set (+ fastresume) under the data dir so downloads resume
        // where they left off after a relaunch, instead of starting over. DHT persistence
        // stays off (see above) — only the torrent list/progress is restored.
        //
        // Raw downloads land in a `Downloads/` staging folder that sits BESIDE the organized
        // `Library/` (both under the storage root), so unsorted torrents never clutter the
        // root. This is only the *default* output folder: seeds/shares pass their own
        // `output_folder` (the on-disk content location), so only fresh downloads stage here.
        // `self.download_dir` stays the storage ROOT — it's the rel-path base for the scan,
        // which walks the whole root and so still finds both `Downloads/` and `Library/`.
        let downloads_dir = download_dir.join("Downloads");
        let _ = std::fs::create_dir_all(&downloads_dir);
        let session = Session::new_with_opts(
            downloads_dir.clone(),
            SessionOptions {
                disable_dht_persistence: true,
                persistence: Some(SessionPersistenceConfig::Json {
                    folder: Some(PathBuf::from(&app_info.data_dir).join("rqbit-session")),
                }),
                // Restore fastresume state so a resumed download doesn't re-hash every existing
                // piece on launch (the persistence comment above always claimed this, but the
                // flag was never set — relaunches were silently re-checking whole files).
                fastresume: true,
                // Make the node connectable instead of passive/firewalled, so peers can dial in
                // and swarms fill faster. Pointless on iOS (no LAN UPnP gateway in practice).
                enable_upnp_port_forwarding: !cfg!(target_os = "ios"),
                ..Default::default()
            },
        )
        .await
        .context("creating librqbit session")?;
        let torrents: Torrents = Arc::new(RwLock::new(HashMap::new()));

        // Adopt any torrents librqbit restored from the persistence store into our own
        // registry, so resumed downloads show up in the UI and stay streamable. Keyed by
        // the same lowercase-hex infohash everything else uses.
        let max_active = catalog
            .get_setting("download_concurrency")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(DEFAULT_MAX_ACTIVE_DOWNLOADS)
            .clamp(1, MAX_ACTIVE_DOWNLOADS_CAP);
        let max_active_downloads: Arc<RwLock<usize>> = Arc::new(RwLock::new(max_active));
        {
            let restored: Vec<(String, Handle)> = session.with_torrents(|it| {
                it.map(|(_tid, h)| (h.info_hash().as_string(), h.clone())).collect()
            });
            if !restored.is_empty() {
                let mut to_pause: Vec<Handle> = Vec::new();
                {
                    let mut map = torrents.write().await;
                    for (id, handle) in restored {
                        let title = handle.name().unwrap_or_else(|| id.clone());
                        let magnet = format!("magnet:?xt=urn:btih:{id}");
                        // An unfinished restored download goes back into the queue (paused) so a
                        // relaunch resumes ONE at a time too; finished torrents just keep seeding.
                        let unfinished = !handle.stats().finished;
                        if unfinished {
                            to_pause.push(handle.clone());
                        }
                        map.entry(id).or_insert(Entry {
                            handle,
                            title,
                            magnet,
                            added: std::time::Instant::now(),
                            queue_managed: unfinished,
                            queued: unfinished,
                            released_at: None,
                            last_progress_bytes: 0,
                            progressed_at: None,
                            is_seed: !unfinished,
                        });
                    }
                }
                for h in &to_pause {
                    let _ = session.pause(h).await;
                }
                schedule_queue(&session, &torrents, max_active).await;
            }
        }
        let transcode_errors: TranscodeErrors = Arc::new(RwLock::new(HashMap::new()));
        let hls: HlsJobs = Arc::new(RwLock::new(HashMap::new()));
        let pending: PendingAdds = Arc::new(RwLock::new(HashMap::new()));
        let cancelled: CancelledAdds = Arc::new(RwLock::new(HashSet::new()));
        let hls_root = std::env::temp_dir().join("ghosty-hls");
        let _ = std::fs::remove_dir_all(&hls_root);
        let _ = std::fs::create_dir_all(&hls_root);
        let _ = std::fs::create_dir_all(&art_dir);

        // Loopback media server. /stream serves raw bytes with Range (direct play);
        // /hls serves an ffmpeg HLS playlist + segments for formats WKWebView can't play
        // natively — HLS needs no byte-range, unlike a progressive <video src> MP4.
        let pairing = remote::new_pairing();
        let state = ServerState {
            torrents: torrents.clone(),
            pending: pending.clone(),
            ffmpeg: ffmpeg.clone(),
            ffprobe: ffprobe.clone(),
            transcode_errors: transcode_errors.clone(),
            hls: hls.clone(),
            hls_root: hls_root.clone(),
            art_dir: art_dir.clone(),
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(20))
                .user_agent("GhostWire")
                .build()
                .unwrap_or_default(),
            download_dir: download_dir.clone(),
            session: session.clone(),
            max_active_downloads: max_active_downloads.clone(),
            secret: identity.secret.clone(),
            device_name: identity.name.clone(),
            device_id: identity.id.clone(),
            pairing: pairing.clone(),
            catalog,
            app_info,
        };
        let router = Router::new()
            .route("/stream/{id}/{file}", get(stream_handler))
            .route("/remux/{id}/{file}", get(remux_handler))
            .route("/hls/{id}/{file}/index.m3u8", get(hls_playlist_handler))
            .route("/hls/{id}/{file}/{seg}", get(hls_segment_handler))
            .route("/localhls/{token}/index.m3u8", get(local_hls_playlist_handler))
            .route("/localhls/{token}/{seg}", get(local_hls_segment_handler))
            .route("/subs/file/{token}", get(subs_file_handler))
            .route("/subs/embed/{token}/{name}", get(subs_embed_handler))
            .route("/art/{id}", get(art_handler))
            .route("/img", get(img_handler))
            .route("/file/{*relpath}", get(file_handler))
            // LAN control API for a linked iPad (see remote.rs). `/api/pair` is open
            // (PIN-gated); the rest require a bearer token via the auth middleware below.
            .route("/api/pair", post(api_pair))
            .route("/api/device_info", get(api_device_info))
            .route("/api/list_downloads", get(api_list_downloads))
            .route("/api/add_torrent", post(api_add_torrent))
            .route("/api/stream_url", get(api_stream_url))
            // Companion mode: a linked iPad mirrors this desktop's Library / catalog / search.
            .route("/api/list_downloaded", get(api_list_downloaded))
            .route("/api/list_library", get(api_list_library))
            .route("/api/list_catalog", get(api_list_catalog))
            .route("/api/search", get(api_search))
            .route("/api/library_stream_url", get(api_library_stream_url))
            // One-shot index: catalog + library + downloaded in a single round-trip (+ a cheap
            // version probe) so a companion iPad can paint instantly and revalidate cheaply.
            .route("/api/snapshot", get(api_snapshot))
            .route("/api/snapshot_version", get(api_snapshot_version))
            // Auth runs INNER (after CORS) so even 401s carry CORS headers. Localhost (the
            // desktop app's own webview) is exempt; LAN requests must present a valid token.
            .layer(axum::middleware::from_fn_with_state(state.clone(), auth_middleware))
            // Allow the WKWebView page (a different origin) to read these responses with
            // CORS — required so a Web Audio AnalyserNode can tap the <audio> element for
            // the visualizer instead of getting silenced (zeroed) samples. Applied to ALL
            // responses, including 206 Partial Content range responses.
            .layer(axum::middleware::from_fn(cors_headers))
            .with_state(state);
        // The Mac (desktop) exposes the server on the LAN so a linked iPad can reach it;
        // the auth middleware gates non-localhost requests. iOS stays loopback-only — it's
        // a client, and its own WKWebView reaches 127.0.0.1 under the local-network exemption.
        let addr = if cfg!(target_os = "ios") {
            format!("127.0.0.1:{STREAM_PORT}")
        } else {
            format!("0.0.0.0:{STREAM_PORT}")
        };
        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .with_context(|| format!("binding stream server on {addr}"))?;
        tauri::async_runtime::spawn(async move {
            let svc = router.into_make_service_with_connect_info::<SocketAddr>();
            if let Err(e) = axum::serve(listener, svc).await {
                eprintln!("ghosty: stream server exited: {e}");
            }
        });

        // VPN kill-switch flag — shared with the snapshot loop so a dropped VPN freezes the
        // queue (no paused download is silently resumed) until the user resumes or quits.
        let network_blocked = Arc::new(AtomicBool::new(false));

        // Push a full snapshot of active downloads to the UI ~1/s, and advance the download
        // queue each tick — when the active download finishes (or stalls), the next starts.
        {
            let torrents = torrents.clone();
            let pending = pending.clone();
            let session = session.clone();
            let max_active_downloads = max_active_downloads.clone();
            let network_blocked = network_blocked.clone();
            let ffmpeg_on = ffmpeg.is_some();
            tauri::async_runtime::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(1));
                loop {
                    tick.tick().await;
                    // While the kill-switch is engaged, leave everything paused — don't let the
                    // scheduler release a queued download back onto the (now unprotected) network.
                    if !network_blocked.load(Ordering::SeqCst) {
                        let max_active = *max_active_downloads.read().await;
                        schedule_queue(&session, &torrents, max_active).await;
                    }
                    let snap = build_snapshot(&torrents, &pending, ffmpeg_on).await;
                    let _ = app.emit(DOWNLOADS_EVENT, &snap);
                }
            });
        }

        Ok(Engine {
            session,
            torrents,
            pending,
            cancelled,
            max_active_downloads,
            ffmpeg,
            ffprobe,
            download_dir,
            transcode_errors,
            hls,
            pairing,
            network_blocked,
        })
    }

    /// VPN kill-switch ON: freeze the queue and pause every torrent so no bytes move over the
    /// now-unprotected connection. Idempotent.
    pub async fn pause_all_network(&self) {
        self.network_blocked.store(true, Ordering::SeqCst);
        let handles: Vec<Handle> = {
            let t = self.torrents.read().await;
            t.values().map(|e| e.handle.clone()).collect()
        };
        for h in handles {
            let _ = self.session.pause(&h).await;
        }
    }

    /// VPN kill-switch OFF: unfreeze the queue and let downloads resume normally.
    pub async fn resume_all_network(&self) {
        self.network_blocked.store(false, Ordering::SeqCst);
        let max_active = *self.max_active_downloads.read().await;
        schedule_queue(&self.session, &self.torrents, max_active).await;
    }

    /// Add a magnet; returns its infohash (the id everything else is keyed by). `queue=true`
    /// enqueues it as a download (starts when a slot frees); `queue=false` starts it now (an
    /// ephemeral stream preview that bypasses the queue). `initial_peers` are socket addresses
    /// to dial immediately — a friend's share carries the seeder's address so the swarm
    /// negotiates right away instead of waiting on (often-fruitless) DHT discovery.
    pub async fn add(&self, magnet: &str, queue: bool, initial_peers: Vec<SocketAddr>) -> Result<String> {
        // Stream previews resolve synchronously — the caller opens the player right after and needs
        // the resolved handle. Downloads, by contrast, must appear INSTANTLY: resolving a magnet's
        // metadata (session.add_torrent) can take many seconds — sometimes ~a minute — and used to
        // block here, so the click hung and nothing showed on the Downloads page. Park a placeholder
        // and resolve in the background; the snapshot shows it as "queued" until the real Entry lands.
        if !queue {
            return add_magnet(&self.session, &self.torrents, magnet, false, DEFAULT_MAX_ACTIVE_DOWNLOADS, initial_peers).await;
        }
        // A non-magnet source (http `.torrent` URL) has no infohash until it's fetched and
        // parsed, so we can't park a placeholder keyed by id. These files are small and
        // resolve quickly, so just add synchronously.
        let Some(id) = infohash_from_magnet(magnet) else {
            let max_active = *self.max_active_downloads.read().await;
            return add_magnet(&self.session, &self.torrents, magnet, true, max_active, initial_peers).await;
        };
        // A fresh add of the same id should clear any stale "cancel while resolving" marker.
        self.cancelled.write().await.remove(&id);
        if self.torrents.read().await.contains_key(&id) || self.pending.read().await.contains_key(&id) {
            return Ok(id); // already managed or already resolving
        }
        let title = magnet_title(magnet).unwrap_or_else(|| id.clone());
        self.pending.write().await.insert(
            id.clone(),
            Pending { title, added: std::time::Instant::now() },
        );
        let session = self.session.clone();
        let torrents = self.torrents.clone();
        let pending = self.pending.clone();
        let cancelled = self.cancelled.clone();
        let max_active_downloads = self.max_active_downloads.clone();
        let magnet = magnet.to_string();
        let task_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let max_active = *max_active_downloads.read().await;
            let res = add_magnet(&session, &torrents, &magnet, true, max_active, initial_peers).await;
            pending.write().await.remove(&task_id);
            let was_cancelled = cancelled.write().await.remove(&task_id);
            if was_cancelled {
                let handle = torrents.write().await.remove(&task_id).map(|e| e.handle);
                if let Some(h) = handle {
                    let _ = session.delete(h.info_hash().into(), true).await;
                }
                let max_active = *max_active_downloads.read().await;
                schedule_queue(&session, &torrents, max_active).await;
                return;
            }
            if let Err(e) = res {
                eprintln!("ghosty: add_magnet({task_id}) failed: {e:#}");
            }
        });
        Ok(id)
    }

    /// Create a fresh PIN pairing offer for a LAN client to enter; returns it for the
    /// host UI to display.
    pub async fn offer_pairing_pin(&self) -> String {
        remote::offer_pin(&self.pairing).await
    }

    /// Wait for metadata, then hand back the loopback URL the player streams from.
    pub async fn stream_url(&self, id: &str, file_idx: Option<usize>) -> Result<String> {
        let handle = self
            .torrents
            .read()
            .await
            .get(id)
            .map(|e| e.handle.clone())
            .ok_or_else(|| anyhow!("unknown torrent {id}"))?;
        // Wait for the torrent to go Live (metadata resolved AND storage ready) —
        // stream() errors while still "initializing".
        let mut live = false;
        for _ in 0..300 {
            if matches!(handle.stats().state, librqbit::TorrentStatsState::Live) {
                live = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        // Never went Live (no peers found / metadata never resolved — common for a friend's
        // share that can't be reached). Returning the play URL anyway hands the UI a stream
        // that only 503s, so the user gets a black <video>. Fail loudly instead so the front
        // end can surface "couldn't connect to the source" rather than a silent black screen.
        if !live {
            return Err(anyhow!(
                "couldn't connect to any peers for this item — it may be offline or unreachable"
            ));
        }
        let file = file_idx.or_else(|| largest_file(&handle)).unwrap_or(0);
        let name = file_name(&handle, file);
        // Pre-warm the head of the playable file: open a stream seeked to byte 0 and hold it
        // briefly so librqbit prioritizes the first ~32MB during the gap before the player's own
        // /stream connection takes over. Without this, pieces download in natural order during the
        // peer-discovery window — often the WRONG file's front on a multi-file torrent — directly
        // delaying time-to-first-frame. The player's own stream drives priority once it connects.
        {
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncSeekExt};
                if let Ok(mut fs) = handle.stream(file) {
                    let _ = fs.seek(std::io::SeekFrom::Start(0)).await;
                    let mut buf = vec![0u8; 64 * 1024];
                    for _ in 0..16 {
                        // Pull ~1MB to pin the picker onto the head; piece-aware reads prioritize
                        // + wait for exactly the pieces first-frame needs.
                        if fs.read(&mut buf).await.unwrap_or(0) == 0 {
                            break;
                        }
                    }
                    // Hold the open stream so the 32MB lookahead stays prioritized through startup.
                    tokio::time::sleep(Duration::from_secs(45)).await;
                }
            });
        }
        Ok(play_url(self.ffmpeg.is_some(), id, file, name.as_deref()))
    }

    pub async fn snapshot(&self) -> Vec<DownloadStats> {
        build_snapshot(&self.torrents, &self.pending, self.ffmpeg.is_some()).await
    }

    /// The items this user has DELIBERATELY shared with their connections — the only things a
    /// friend may browse or grab over the social link. This is intentionally NOT every finished
    /// torrent: a download that's merely seeding back to the public swarm (`is_seed == false`)
    /// stays private to the swarm and is never advertised to friends. Sharing is opt-in via
    /// "Share with network" / "Create torrent", which add the content as a local seed
    /// (`is_seed == true`). An optional case-insensitive `query` filters by title for a friend's
    /// search. Returns just the infohash + name (and size when known); transfers still happen
    /// peer-to-peer via the magnet, never through any GhostWire server.
    pub async fn seeding_shares(&self, query: Option<&str>) -> Vec<SeedShare> {
        let q = query.map(|s| s.trim().to_lowercase());
        // Same for every share — this host's reachable BitTorrent address(es).
        let peers = self.seed_peer_addrs();
        // Snapshot the seeding/finished handles up front so we don't hold the lock across the
        // (blocking) tag reads below.
        let done: Vec<(String, String, Handle)> = {
            let t = self.torrents.read().await;
            t.iter()
                // Only deliberate shares (added via "Share with network" / "Create torrent"),
                // never plain downloaded torrents that happen to be seeding back to the swarm.
                .filter(|(_, e)| e.is_seed)
                .map(|(id, e)| (id.clone(), e.title.clone(), e.handle.clone()))
                .collect()
        };
        let mut out = Vec::new();
        for (infohash, name, handle) in done {
            if let Some(qq) = &q {
                if !qq.is_empty() && !name.to_lowercase().contains(qq.as_str()) {
                    continue;
                }
            }
            let meta = share_meta(&handle, &self.download_dir);
            out.push(SeedShare {
                infohash,
                name,
                peers: peers.clone(),
                category: meta.category,
                media_type: meta.media_type,
                size_bytes: meta.size_bytes,
                artist: meta.artist,
                album: meta.album,
                track_title: meta.track_title,
            });
        }
        out
    }

    /// This host's candidate BitTorrent socket address(es) for a friend to connect to directly.
    /// Direct dial-in is what makes a private friend-to-friend swarm actually negotiate: a
    /// trackerless magnet only has DHT to fall back on, which is slow and often never resolves
    /// for two NATed peers — so the seeder advertises where it is and the downloader injects
    /// that as an initial peer.
    fn seed_peer_addrs(&self) -> Vec<String> {
        match (remote::local_ip(), self.session.tcp_listen_port()) {
            (Some(ip), Some(port)) => vec![format!("{ip}:{port}")],
            _ => Vec::new(),
        }
    }


    /// Subtitle tracks for a local video at relative path `rel`: sidecar .srt/.vtt/.ass
    /// files in the same folder, plus text-based subtitle streams embedded in the
    /// container (extracted to WebVTT on demand by `/subs/embed`). Image-based subs
    /// (PGS/VOBSUB) can't become WebVTT, so they're skipped.
    pub async fn list_subtitles(&self, rel: &str) -> Vec<SubTrack> {
        let mut out = Vec::new();
        let abs = self.download_dir.join(rel);
        let stem = abs.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();

        // 1) Sidecar subtitle files in the same directory.
        if let Some(dir) = abs.parent() {
            let lone_video = video_count(dir) <= 1;
            if let Ok(entries) = std::fs::read_dir(dir) {
                let mut subs: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| matches!(file_ext(p).as_str(), "srt" | "vtt" | "ass" | "ssa"))
                    .collect();
                subs.sort();
                for p in subs {
                    let sub_stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
                    // Belongs to this video if it shares the name stem — or, in a folder with a
                    // single video, any subtitle ("Movie/Movie.mkv" + "Movie/sub.srt").
                    if !lone_video && !sub_stem.starts_with(&stem) {
                        continue;
                    }
                    let Ok(sub_rel) = p.strip_prefix(&self.download_dir) else { continue };
                    let sub_rel = sub_rel.to_string_lossy().replace('\\', "/");
                    let lang = sub_lang(&sub_stem);
                    out.push(SubTrack {
                        label: sub_label(&sub_stem, &lang),
                        lang,
                        url: format!("http://127.0.0.1:{STREAM_PORT}/subs/file/{}", hls_token(&sub_rel)),
                    });
                }
            }

            // 1b) A sibling Subs/ (or Subtitles/) folder — the common scene-release layout
            // (`Release/Release.mkv` + `Release/Subs/2_English.srt`). Take every track in it.
            if let Ok(entries) = std::fs::read_dir(dir) {
                for sub_dir in entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
                    let dn = sub_dir.file_name().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
                    if !matches!(dn.as_str(), "subs" | "subtitles" | "sub") {
                        continue;
                    }
                    let Ok(inner) = std::fs::read_dir(&sub_dir) else { continue };
                    let mut subs: Vec<PathBuf> = inner
                        .flatten()
                        .map(|e| e.path())
                        .filter(|p| matches!(file_ext(p).as_str(), "srt" | "vtt" | "ass" | "ssa"))
                        .collect();
                    subs.sort();
                    for p in subs {
                        let sub_stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
                        let Ok(sub_rel) = p.strip_prefix(&self.download_dir) else { continue };
                        let sub_rel = sub_rel.to_string_lossy().replace('\\', "/");
                        let lang = sub_lang(&sub_stem);
                        out.push(SubTrack {
                            label: sub_label(&sub_stem, &lang),
                            lang,
                            url: format!("http://127.0.0.1:{STREAM_PORT}/subs/file/{}", hls_token(&sub_rel)),
                        });
                    }
                }
            }
        }

        // 2) Embedded text subtitle streams (ffprobe enumerates; ffmpeg extracts on demand).
        if let Some(ffprobe) = &self.ffprobe {
            for (n, lang, title) in probe_subtitle_streams(ffprobe, &abs).await {
                let label = if !title.is_empty() {
                    title
                } else if !lang.is_empty() {
                    format!("{} (embedded)", lang_label(&lang))
                } else {
                    format!("Track {}", n + 1)
                };
                out.push(SubTrack {
                    label,
                    lang,
                    url: format!("http://127.0.0.1:{STREAM_PORT}/subs/embed/{}/{n}.vtt", hls_token(rel)),
                });
            }
        }
        out
    }

    /// Fetch a subtitle for `rel` from OpenSubtitles (free, keyless) when it has none,
    /// save it next to the video as `<stem>.<lang>.srt`, and return the refreshed track
    /// list. `title`/`season`/`episode` come from the player's already-parsed metadata.
    pub async fn fetch_subtitles(
        &self,
        rel: &str,
        title: &str,
        season: Option<i64>,
        episode: Option<i64>,
        lang: &str,
    ) -> Result<Vec<SubTrack>> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            .build()
            .context("subtitle http client")?;
        if let Some(found) = crate::subtitles::fetch_best(&client, title, season, episode, lang).await? {
            let abs = self.download_dir.join(rel);
            if let (Some(dir), Some(stem)) = (abs.parent(), abs.file_stem().and_then(|s| s.to_str())) {
                std::fs::create_dir_all(dir).ok();
                let dest = dir.join(format!("{stem}.{}.srt", found.lang));
                if !dest.exists() {
                    std::fs::write(&dest, found.srt).context("writing subtitle")?;
                }
            }
        }
        Ok(self.list_subtitles(rel).await)
    }

    pub async fn stats_for(&self, id: &str) -> Option<DownloadStats> {
        let on = self.ffmpeg.is_some();
        self.torrents.read().await.get(id).map(|e| stats_of(id, e, on))
    }

    pub async fn remove(&self, id: &str, delete_files: bool) -> Result<()> {
        // If the magnet is still resolving (no Entry yet), mark it as cancelled so the
        // async add task tears it down the moment it resolves instead of resurrecting it.
        let was_pending = self.pending.write().await.remove(id).is_some();
        if was_pending {
            self.cancelled.write().await.insert(id.to_string());
        }
        let handle = self.torrents.write().await.remove(id).map(|e| e.handle);
        if let Some(h) = handle {
            // Stop + drop from the librqbit session. delete_files=true wipes partial
            // data — used to tear down ephemeral stream previews so they don't linger.
            let _ = self.session.delete(h.info_hash().into(), delete_files).await;
        }
        if !was_pending {
            self.cancelled.write().await.remove(id);
        }
        // Tear down any HLS transcode jobs for this torrent (kills ffmpeg + clears segments).
        let prefix = format!("{id}/");
        {
            let mut jobs = self.hls.write().await;
            let keys: Vec<String> = jobs.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
            for k in keys {
                if let Some(job) = jobs.remove(&k) {
                    let _ = std::fs::remove_dir_all(&job.dir);
                }
            }
        }
        // Removing a download frees its slot — let the next queued one start.
        let max_active = *self.max_active_downloads.read().await;
        schedule_queue(&self.session, &self.torrents, max_active).await;
        Ok(())
    }

    /// Create a `.torrent` from a local file or folder, optionally write it to `save_path`, and
    /// (optionally) start seeding the existing files so peers can fetch them directly. Everything
    /// stays on the user's machine — the torrent is just a fingerprint and the user's own client
    /// is the seed; nothing is uploaded to any GhostWire server.
    pub async fn create_torrent(
        &self,
        source_path: &str,
        save_path: Option<&str>,
        trackers: Vec<String>,
        start_seeding: bool,
    ) -> Result<CreatedTorrent> {
        let src = PathBuf::from(source_path);
        if !src.exists() {
            return Err(anyhow!("source path does not exist: {source_path}"));
        }
        // The on-disk torrent name stays the source basename (CreateTorrentOptions::default)
        // so the seed maps cleanly back onto the existing files. Trackerless by default —
        // DHT makes the content discoverable; the magnet advertises any trackers the user adds.
        let result = librqbit::create_torrent(&src, librqbit::CreateTorrentOptions::default())
            .await
            .context("create_torrent")?;
        let infohash = result.info_hash().as_string();
        let size_bytes = {
            let info = result.as_info();
            info.info
                .length
                .or_else(|| {
                    info.info
                        .files
                        .as_ref()
                        .map(|fs| fs.iter().map(|f| f.length).sum())
                })
                .unwrap_or(0)
        };
        let file_count = result
            .as_info()
            .info
            .files
            .as_ref()
            .map(|f| f.len())
            .unwrap_or(1);
        let name = src
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| infohash.clone());

        // Serialize the .torrent once; reused for the optional file write and the seed add.
        let bytes = result.as_bytes().context("serialize .torrent")?;
        let torrent_path = if let Some(dest) = save_path {
            std::fs::write(dest, &bytes).with_context(|| format!("write {dest}"))?;
            Some(dest.to_string())
        } else {
            None
        };

        let magnet = build_magnet(&infohash, &name, &trackers);

        // Start seeding: add the freshly built torrent pointing at the existing files. Files
        // already on disk make librqbit verify and go straight to seeding (overwrite=true).
        let mut seeding = false;
        if start_seeding {
            let output_folder = src
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| self.download_dir.clone());
            let resp = self
                .session
                .add_torrent(
                    AddTorrent::from_bytes(bytes),
                    Some(AddTorrentOptions {
                        overwrite: true,
                        output_folder: Some(output_folder.to_string_lossy().into_owned()),
                        trackers: if trackers.is_empty() { None } else { Some(trackers.clone()) },
                        ..Default::default()
                    }),
                )
                .await
                .context("seed add_torrent")?;
            if let AddTorrentResponse::Added(_, handle)
            | AddTorrentResponse::AlreadyManaged(_, handle) = resp
            {
                let now = std::time::Instant::now();
                self.torrents.write().await.insert(
                    infohash.clone(),
                    Entry {
                        handle,
                        title: name.clone(),
                        magnet: magnet.clone(),
                        added: now,
                        queue_managed: false,
                        queued: false,
                        released_at: Some(now),
                        last_progress_bytes: size_bytes,
                        progressed_at: Some(now),
                        is_seed: true,
                    },
                );
                seeding = true;
            }
        }

        Ok(CreatedTorrent {
            infohash,
            magnet,
            name,
            size_bytes,
            file_count,
            torrent_path,
            seeding,
        })
    }

    /// Download a magnet into `out_dir`, OUTSIDE the user's Downloads queue/UI, wait for it to
    /// finish, and return the path to the downloaded file. Used by the P2P self-update path to pull
    /// the signed update bundle over BitTorrent; the caller verifies its signature before installing.
    pub async fn download_to_path(&self, magnet: &str, out_dir: &Path) -> Result<PathBuf> {
        std::fs::create_dir_all(out_dir).ok();
        let resp = self
            .session
            .add_torrent(
                AddTorrent::from_url(magnet),
                Some(AddTorrentOptions {
                    overwrite: true,
                    output_folder: Some(out_dir.to_string_lossy().into_owned()),
                    ..Default::default()
                }),
            )
            .await
            .context("add update torrent")?;
        let handle = match resp {
            AddTorrentResponse::Added(_, h) | AddTorrentResponse::AlreadyManaged(_, h) => h,
            AddTorrentResponse::ListOnly(_) => return Err(anyhow!("update torrent returned no handle")),
        };
        // Block until every piece is present + verified on disk.
        handle.wait_until_completed().await.context("await update download")?;
        // Single-file bundle: out_dir/<torrent name>. Fall back to the largest regular file found.
        if let Some(name) = handle.name() {
            let p = out_dir.join(&name);
            if p.is_file() {
                // Leave the session clean — this is a one-shot pull, not a managed download.
                let _ = self.session.delete(handle.info_hash().into(), false).await;
                return Ok(p);
            }
        }
        let mut best: Option<(PathBuf, u64)> = None;
        if let Ok(entries) = std::fs::read_dir(out_dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_file() {
                    let len = e.metadata().map(|m| m.len()).unwrap_or(0);
                    if best.as_ref().map(|(_, b)| len > *b).unwrap_or(true) {
                        best = Some((p, len));
                    }
                }
            }
        }
        let _ = self.session.delete(handle.info_hash().into(), false).await;
        best.map(|(p, _)| p).ok_or_else(|| anyhow!("downloaded update file not found in {out_dir:?}"))
    }

    /// Download a magnet into `out_dir` and KEEP it seeding (registered as a seed so it shows in the
    /// Downloads "seeding" section). Used for opt-in distribution of the app's own update bundle:
    /// the user helps share the latest GhostWire build with the swarm. Idempotent by infohash.
    pub async fn seed_from_magnet(&self, magnet: &str, out_dir: &Path) -> Result<String> {
        std::fs::create_dir_all(out_dir).ok();
        if let Some(id) = infohash_from_magnet(magnet) {
            if self.torrents.read().await.contains_key(&id) {
                return Ok(id); // already managed / seeding
            }
        }
        let resp = self
            .session
            .add_torrent(
                AddTorrent::from_url(magnet),
                Some(AddTorrentOptions {
                    overwrite: true,
                    output_folder: Some(out_dir.to_string_lossy().into_owned()),
                    ..Default::default()
                }),
            )
            .await
            .context("add app-seed torrent")?;
        let handle = match resp {
            AddTorrentResponse::Added(_, h) | AddTorrentResponse::AlreadyManaged(_, h) => h,
            AddTorrentResponse::ListOnly(_) => return Err(anyhow!("app-seed torrent returned no handle")),
        };
        let infohash = handle.info_hash().as_string();
        let name = handle.name().unwrap_or_else(|| infohash.clone());
        let now = std::time::Instant::now();
        self.torrents.write().await.insert(
            infohash.clone(),
            Entry {
                handle,
                title: name,
                magnet: magnet.to_string(),
                added: now,
                queue_managed: false,
                queued: false,
                released_at: Some(now),
                last_progress_bytes: 0,
                progressed_at: Some(now),
                is_seed: true,
            },
        );
        Ok(infohash)
    }

    /// Stop seeding a torrent (used when the user opts out of app distribution). Keeps the files.
    pub async fn stop_seeding(&self, infohash: &str) -> Result<()> {
        let handle = self.torrents.write().await.remove(infohash).map(|e| e.handle);
        if let Some(h) = handle {
            let _ = self.session.delete(h.info_hash().into(), false).await;
        }
        Ok(())
    }

    /// Re-seed a previously created `.torrent` after a restart: load the file and point it at the
    /// directory that holds the content. Files already on disk verify straight to seeding.
    pub async fn seed_torrent(&self, torrent_path: &str, content_dir: &str) -> Result<String> {
        let bytes = std::fs::read(torrent_path).with_context(|| format!("read {torrent_path}"))?;
        let resp = self
            .session
            .add_torrent(
                AddTorrent::from_bytes(bytes),
                Some(AddTorrentOptions {
                    overwrite: true,
                    output_folder: Some(content_dir.to_string()),
                    ..Default::default()
                }),
            )
            .await
            .context("seed_torrent")?;
        let handle = match resp {
            AddTorrentResponse::Added(_, h) | AddTorrentResponse::AlreadyManaged(_, h) => h,
            AddTorrentResponse::ListOnly(_) => return Err(anyhow!("list-only response")),
        };
        let id = handle.info_hash().as_string();
        let title = handle.name().unwrap_or_else(|| id.clone());
        let now = std::time::Instant::now();
        self.torrents.write().await.insert(
            id.clone(),
            Entry {
                handle,
                title,
                magnet: String::new(),
                added: now,
                queue_managed: false,
                queued: false,
                released_at: Some(now),
                last_progress_bytes: 0,
                progressed_at: Some(now),
                is_seed: true,
            },
        );
        Ok(id)
    }

    /// Remove every torrent from the session. Incomplete ones have their partial data
    /// wiped; finished ones keep their on-disk file (the caller decides whether to trash
    /// those, e.g. keeping Library items). Returns how many were removed.
    pub async fn clear(&self) -> usize {
        let targets: Vec<(String, bool)> = {
            let g = self.torrents.read().await;
            g.iter().map(|(id, e)| (id.clone(), e.handle.stats().finished)).collect()
        };
        let pending: Vec<String> = self.pending.read().await.keys().cloned().collect();
        let n = targets.len() + pending.len();
        for (id, finished) in targets {
            let _ = self.remove(&id, !finished).await;
        }
        for id in pending {
            let _ = self.remove(&id, true).await;
        }
        n
    }

    pub async fn set_paused(&self, id: &str, paused: bool) -> Result<()> {
        // A manual pause/resume takes the download out of the auto-queue — the user is in
        // control now (resuming a queued item is "start this one now").
        let now = std::time::Instant::now();
        let (handle, to_pause): (Option<Handle>, Vec<Handle>) = {
            let mut t = self.torrents.write().await;
            let mut to_pause = Vec::new();

            // Queue jump behavior: hitting ▶ on a queued item pauses any active queue slot first,
            // then starts this item immediately.
            if !paused && t.get(id).is_some_and(|e| e.queue_managed && e.queued) {
                let active_ids: Vec<String> = t
                    .iter()
                    .filter(|(other_id, e)| {
                        *other_id != id && e.queue_managed && !e.queued && is_active_slot(e, now)
                    })
                    .map(|(other_id, _)| other_id.clone())
                    .collect();
                for other_id in active_ids {
                    if let Some(e) = t.get_mut(&other_id) {
                        e.queued = true;
                        e.released_at = None;
                        to_pause.push(e.handle.clone());
                    }
                }
            }

            let handle = t.get_mut(id).map(|e| {
                e.queued = false;
                if !paused {
                    e.released_at = Some(now);
                }
                e.handle.clone()
            });
            (handle, to_pause)
        };
        for h in to_pause {
            let _ = self.session.pause(&h).await;
        }
        if let Some(h) = handle {
            if paused {
                self.session.pause(&h).await?;
            } else {
                self.session.unpause(&h).await?;
            }
        }
        // Pausing the active download frees its slot; advance the queue.
        let max_active = *self.max_active_downloads.read().await;
        schedule_queue(&self.session, &self.torrents, max_active).await;
        Ok(())
    }

    pub async fn max_active_downloads(&self) -> usize {
        *self.max_active_downloads.read().await
    }

    pub async fn set_max_active_downloads(&self, value: usize) {
        let value = value.clamp(1, MAX_ACTIVE_DOWNLOADS_CAP);
        {
            let mut w = self.max_active_downloads.write().await;
            *w = value;
        }
        schedule_queue(&self.session, &self.torrents, value).await;
    }

    /// Reveal the torrent's folder/file in the OS file manager.
    pub async fn reveal(&self, id: &str) -> Result<()> {
        let handle = self
            .torrents
            .read()
            .await
            .get(id)
            .map(|e| e.handle.clone())
            .ok_or_else(|| anyhow!("unknown torrent {id}"))?;
        // librqbit writes a multi-file torrent under <download_dir>/<torrent name>;
        // fall back to the download root if that folder isn't on disk yet.
        let name = handle.with_metadata(|m| m.name.clone()).ok().flatten();
        let downloads = self.download_dir.join("Downloads");
        let target = match name {
            // Fresh downloads stage under `Downloads/<name>`; older/seeded content (and
            // organized media) may still sit directly under the storage root.
            Some(n) if downloads.join(&n).exists() => downloads.join(&n),
            Some(n) if self.download_dir.join(&n).exists() => self.download_dir.join(&n),
            _ => self.download_dir.clone(),
        };
        #[cfg(target_os = "macos")]
        let _ = std::process::Command::new("open").arg("-R").arg(&target).spawn();
        #[cfg(not(target_os = "macos"))]
        let _ = std::process::Command::new("xdg-open").arg(&target).spawn();
        Ok(())
    }

    /// Everything the player's debug panel needs: state, peer/tracker/webseed health,
    /// the selected file + its container/codecs, and which endpoint will serve it.
    pub async fn media_info(&self, id: &str) -> Result<MediaInfo> {
        let (handle, magnet, age_secs) = {
            let g = self.torrents.read().await;
            let e = g.get(id).ok_or_else(|| anyhow!("unknown torrent {id}"))?;
            (e.handle.clone(), e.magnet.clone(), e.added.elapsed().as_secs())
        };
        let s = handle.stats();
        let has_meta = s.total_bytes > 0;
        let peers = s
            .live
            .as_ref()
            .map(|l| l.snapshot.peer_stats.live as u32)
            .unwrap_or(0);
        let progress = if has_meta {
            s.progress_bytes as f64 / s.total_bytes as f64
        } else {
            0.0
        };
        let state = {
            use librqbit::TorrentStatsState as St;
            match s.state {
                St::Initializing => "connecting",
                St::Paused => "paused",
                St::Error => "error",
                St::Live => {
                    if s.finished {
                        "ready"
                    } else {
                        "downloading"
                    }
                }
            }
        };
        let (trackers, webseed) = magnet_meta(&magnet);

        let mut info = MediaInfo {
            state: state.to_string(),
            peers,
            has_meta,
            progress,
            total_bytes: s.total_bytes,
            age_secs,
            trackers,
            webseed,
            file_name: None,
            file_ext: None,
            file_size: 0,
            rel_path: None,
            files: Vec::new(),
            media_kind: None,
            endpoint: None,
            endpoint_reason: None,
            container: None,
            video_codec: None,
            audio_codec: None,
            ffmpeg_available: self.ffmpeg.is_some(),
            ffprobe_available: self.ffprobe.is_some(),
            transcode_error: self.transcode_errors.read().await.get(id).cloned(),
            detail: String::new(),
        };

        if matches!(s.state, librqbit::TorrentStatsState::Live) {
            let file = largest_file(&handle).unwrap_or(0);
            let name = file_name(&handle, file);
            info.files = file_list(&handle);
            info.file_size = file_size(&handle, file);
            info.file_ext = name.as_deref().and_then(ext_of);
            let kind = name.as_deref().map_or("video", media_kind);
            info.media_kind = Some(kind.to_string());
            let web_native = name.as_deref().map_or(false, is_web_native);
            // Only non-web-native VIDEO is transcoded; audio plays direct; anything
            // else is a plain file download and must never reach the encoder.
            let transcode = self.ffmpeg.is_some() && kind == "video" && !web_native;
            info.endpoint = Some(
                match kind {
                    "other" => "download",
                    _ if transcode => "transcode",
                    _ => "direct",
                }
                .to_string(),
            );
            info.endpoint_reason = Some(match kind {
                "other" => format!("{} is a file, not media → download only", dot_ext(info.file_ext.as_deref())),
                "audio" => "audio → direct play".to_string(),
                _ if transcode => format!("{} is not web-native → ffmpeg", dot_ext(info.file_ext.as_deref())),
                _ if web_native => "web-native (MP4/WebM) → direct".to_string(),
                _ => "ffmpeg unavailable → direct".to_string(),
            });
            info.rel_path = name.clone();
            info.file_name = name;

            // Probe codecs only for actual media — never run ffprobe on a disk image / archive.
            if kind != "other" {
                let input = format!("http://127.0.0.1:{STREAM_PORT}/stream/{id}/{file}");
                let (container, vcodec, acodec) = tokio::time::timeout(
                    Duration::from_secs(20),
                    media_probe(self.ffprobe.as_deref(), &input),
                )
                .await
                .unwrap_or((None, None, None));
                info.container = container;
                info.video_codec = vcodec;
                info.audio_codec = acodec;
            }
        }

        info.detail = diagnose(&info);
        Ok(info)
    }
}

async fn build_snapshot(torrents: &Torrents, pending: &PendingAdds, ffmpeg_on: bool) -> Vec<DownloadStats> {
    let t = torrents.read().await;
    let mut out: Vec<DownloadStats> = t
        .iter()
        .map(|(id, e)| stats_of(id, e, ffmpeg_on))
        .filter(is_real_download)
        .collect();
    // Placeholders for downloads whose magnet is still resolving (no Entry yet) so they show as
    // "queued" the instant they're clicked. Skip ones that already resolved into a real Entry, and
    // stop showing a placeholder that's been stuck resolving for too long (a dead magnet).
    let now = std::time::Instant::now();
    for (id, p) in pending.read().await.iter() {
        if t.contains_key(id) || now.duration_since(p.added) > Duration::from_secs(300) {
            continue;
        }
        out.push(DownloadStats {
            id: id.clone(),
            title: p.title.clone(),
            state: "queued".to_string(),
            progress: 0.0,
            down_speed: 0,
            up_speed: 0,
            peers: 0,
            stream_url: None,
            is_seed: false,
        });
    }
    // Deterministic order. The snapshot is built by iterating a HashMap, whose iteration
    // order changes tick-to-tick — without a stable sort the UI's ~1Hz refresh reshuffles
    // every card (and remounts each poster <img>, which flashes). Sort by title then id so
    // the list is stable across snapshots and only changes when content actually changes.
    out.sort_by(|a, b| {
        a.title
            .to_lowercase()
            .cmp(&b.title.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

/// A download is "real" — worth reporting to the UI — once it's a genuine, resolved
/// transfer. This drops dead/stalled phantoms (magnets that were added but never resolved a
/// swarm — mock catalog items, dead torrents) that would otherwise inflate the Downloads
/// count, WITHOUT flapping a real download's card on/off every snapshot.
fn is_real_download(d: &DownloadStats) -> bool {
    // Queued downloads are intentional (waiting their turn), so always show them — even at
    // 0 bytes / 0 peers — so the user can see the queue.
    if d.state == "queued" {
        return true;
    }
    // Anything past metadata resolution (downloading / ready / seeding / paused / error) is a
    // real download and must stay visible even when its *instantaneous* peers + speed read 0
    // on a given tick. Notably, archive.org's HTTP web-seeded torrents report no BitTorrent
    // peers at all, so gating them on peers/speed made their card flash on and off every
    // ~1s snapshot. Only a still-"connecting" item can be an unresolved phantom.
    if d.state != "connecting" {
        return true;
    }
    // Still resolving metadata: show it only once it's actually pulling data or has found
    // peers, so dead magnets that never resolve a swarm don't linger in the list.
    d.progress > 0.0 || d.peers > 0 || d.down_speed > 0 || d.up_speed > 0
}

fn stats_of(id: &str, e: &Entry, ffmpeg_on: bool) -> DownloadStats {
    let s = e.handle.stats();
    let has_meta = s.total_bytes > 0;
    // A share (is_seed) points at content already on disk, so it's complete by definition.
    // Report it at 100% even while librqbit re-verifies on add, so the UI files it under
    // Seeding immediately instead of flashing it as a 0% "download" for a beat.
    let progress = if e.is_seed {
        1.0
    } else if has_meta {
        s.progress_bytes as f64 / s.total_bytes as f64
    } else {
        0.0
    };
    let (down, up, peers) = match &s.live {
        Some(live) => (
            mbps_to_bps(live.download_speed.mbps),
            mbps_to_bps(live.upload_speed.mbps),
            live.snapshot.peer_stats.live as u32,
        ),
        None => (0, 0, 0),
    };
    let file = largest_file(&e.handle).unwrap_or(0);
    let name = file_name(&e.handle, file);
    let state = if e.queued {
        // Waiting its turn in the download queue (librqbit-paused, but distinct from a
        // user-initiated pause so the UI can show "Queued").
        "queued"
    } else if e.is_seed {
        // A share: report it as seeding from the start (except a real pause/error), so the
        // brief Initializing re-verify on add doesn't flash it as "connecting"/"downloading".
        use librqbit::TorrentStatsState as St;
        match s.state {
            St::Error => "error",
            St::Paused => "paused",
            _ => "seeding",
        }
    } else {
        use librqbit::TorrentStatsState as St;
        match s.state {
            St::Initializing => "connecting",
            St::Paused => "paused",
            St::Error => "error",
            St::Live => {
                if s.finished {
                    // Finished + Live = seeding (connected to the swarm, available to share),
                    // reported consistently. It used to flip to "ready" on any tick where
                    // instantaneous upload + peers both read 0, which made the card's status
                    // chip flicker Ready↔Seeding ~1×/sec and defeated the snapshot's
                    // change-detection (forcing a re-render every tick for idle seeders).
                    "seeding"
                } else {
                    "downloading"
                }
            }
        }
    };
    DownloadStats {
        id: id.to_string(),
        title: e.title.clone(),
        state: state.to_string(),
        progress,
        down_speed: down,
        up_speed: up,
        peers,
        stream_url: matches!(s.state, librqbit::TorrentStatsState::Live)
            .then(|| play_url(ffmpeg_on, id, file, name.as_deref())),
        is_seed: e.is_seed,
    }
}

/// The webview can play MP4/WebM/MOV (H.264/AAC/VP9) directly; other VIDEO formats
/// (.mkv, HEVC, AC-3, XviD…) route through the ffmpeg transcode endpoint.
fn is_web_native(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".mp4") || n.ends_with(".m4v") || n.ends_with(".webm") || n.ends_with(".mov")
}

/// Coarse media class by extension. Only `video` may be sent to the encoder;
/// `audio` streams directly; `other` (disk images, archives, installers, docs…)
/// is download-only and must never touch ffmpeg.
fn media_kind(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    const VIDEO: &[&str] = &[
        "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg", "m2ts", "mts",
        "ts", "ogv", "3gp", "vob", "divx", "rmvb", "asf",
    ];
    const AUDIO: &[&str] = &[
        "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "wma", "alac", "aiff", "aif",
        "ape", "mka",
    ];
    if VIDEO.contains(&ext.as_str()) {
        "video"
    } else if AUDIO.contains(&ext.as_str()) {
        "audio"
    } else {
        "other"
    }
}

/// The server-relative playback path for a file (no host). Non-web-native VIDEO needs help
/// to play in WKWebView: with ffmpeg (desktop) we transcode to HLS; without it (iOS),
/// Matroska whose codecs are already web-compatible (H.264/HEVC + AAC) is repackaged to
/// fragmented MP4 in-process — no re-encode. Audio and everything else streams raw.
fn play_path(ffmpeg_on: bool, id: &str, file: usize, name: Option<&str>) -> String {
    let kind = name.map_or("video", media_kind);
    let non_native = name.map_or(true, |n| !is_web_native(n));
    if kind == "video" && non_native {
        if ffmpeg_on {
            return format!("/hls/{id}/{file}/index.m3u8");
        }
        if name.is_some_and(is_matroska) {
            return format!("/remux/{id}/{file}");
        }
    }
    format!("/stream/{id}/{file}")
}

/// Full loopback URL the local (same-device) player streams from.
fn play_url(ffmpeg_on: bool, id: &str, file: usize, name: Option<&str>) -> String {
    format!("http://127.0.0.1:{STREAM_PORT}{}", play_path(ffmpeg_on, id, file, name))
}

/// Decides iPad-native playback from the **probed** container + codecs (not the filename).
/// The companion iPad plays via WKWebView's HTML5 `<video>` — which, unlike native AVPlayer,
/// only decodes an MP4/MOV-family container carrying H.264/HEVC video and AAC/MP3 (or no)
/// audio. Everything else must be transcoded by the Mac even when the extension says
/// `.mp4`/`.mov`: AC-3/E-AC-3/DTS/Opus audio (the #1 real-world failure — a `.mp4` with a
/// Dolby track plays on the desktop but silently dies in `<video>`), and VP9/AV1/VP8/XviD
/// video (the A16 iPad has no AV1 or VP9 hardware decoder and WebKit has no software
/// fallback). ffprobe's `format_name` is a comma-joined demuxer list — MP4/MOV/M4V all probe
/// as `mov,mp4,m4a,3gp,3g2,mj2`, while MKV and WebM are indistinguishable (`matroska,webm`) —
/// so containers are matched by substring. Unknown/None container or video codec returns
/// `false` (conservative: transcode), so a failed/timed-out probe never hands the iPad a
/// direct URL it can't play.
fn ios_native(container: Option<&str>, vcodec: Option<&str>, acodec: Option<&str>) -> bool {
    // Container must be the MP4/QuickTime family; bar MKV/WebM/AVI/TS even if codecs are fine.
    let Some(c) = container.map(|s| s.to_lowercase()) else { return false };
    let container_ok = (c.contains("mp4") || c.contains("mov") || c.contains("m4a")
        || c.contains("m4v") || c.contains("3gp") || c.contains("mj2") || c.contains("quicktime"))
        && !c.contains("matroska") && !c.contains("webm") && !c.contains("avi") && !c.contains("mpegts");
    if !container_ok {
        return false;
    }
    // Video must be H.264 or HEVC (accept the MP4 sample-entry aliases). None ⇒ transcode.
    let Some(v) = vcodec.map(|s| s.to_lowercase()) else { return false };
    if !matches!(v.as_str(), "h264" | "avc1" | "hevc" | "h265" | "hvc1") {
        return false; // vp9, av1, vp8, mpeg4, msmpeg4v3, vc1, wmv3, …
    }
    // Audio: a video-only file (None) is fine; otherwise the default track must be AAC/MP3.
    // flac/alac/vorbis can play in MP4 but are unreliable on the `<video>` audio path, and
    // ac3/eac3/dts/opus never play — transcode all of them.
    match acodec.map(|s| s.to_lowercase()) {
        None => true,
        Some(a) => matches!(a.as_str(), "aac" | "mp4a" | "mp3"),
    }
}

/// Desktop-webview variant of [`ios_native`] — stricter on video. The paired iPad (A16) has a
/// reliable HEVC hardware decoder, so `ios_native` lets HEVC stream raw; but macOS WKWebView's
/// HTML5 `<video>` only plays HEVC inconsistently (the `hev1` sample-entry tag and 10-bit
/// Main-10 commonly fail silently — exactly the real-world case of an HEVC Main-10 `.mp4`), so
/// here only **H.264** video is treated as native and everything else is transcoded. Audio
/// rules match: AAC/MP3 (or none) plays; AC-3/E-AC-3/DTS/Opus/FLAC is transcoded.
fn webview_native(container: Option<&str>, vcodec: Option<&str>, acodec: Option<&str>) -> bool {
    let Some(c) = container.map(|s| s.to_lowercase()) else { return false };
    let container_ok = (c.contains("mp4") || c.contains("mov") || c.contains("m4a")
        || c.contains("m4v") || c.contains("3gp") || c.contains("mj2") || c.contains("quicktime"))
        && !c.contains("matroska") && !c.contains("webm") && !c.contains("avi") && !c.contains("mpegts");
    if !container_ok {
        return false;
    }
    let Some(v) = vcodec.map(|s| s.to_lowercase()) else { return false };
    if !matches!(v.as_str(), "h264" | "avc1") {
        return false; // hevc/h265, vp9, av1, mpeg4, vc1, … → transcode
    }
    match acodec.map(|s| s.to_lowercase()) {
        None => true,
        Some(a) => matches!(a.as_str(), "aac" | "mp4a" | "mp3"),
    }
}

/// Shared add path used by both `Engine::add` and the `/api/add_torrent` handler. `queue`
/// enqueues it as a download (added paused, started when a slot frees); otherwise it streams
/// immediately and bypasses the queue. `initial_peers` are seeded directly into the swarm so a
/// friend's share connects to the host that offered it without waiting on DHT discovery.
async fn add_magnet(
    session: &Arc<Session>,
    torrents: &Torrents,
    magnet: &str,
    queue: bool,
    max_active_downloads: usize,
    initial_peers: Vec<SocketAddr>,
) -> Result<String> {
    // Accepts both `magnet:` links and http(s) `.torrent` URLs (e.g. archive.org's
    // per-item torrent). For magnets we know the infohash up front; for .torrent URLs
    // we learn it from the resolved handle.
    let resp = session
        .add_torrent(
            AddTorrent::from_url(magnet),
            Some(AddTorrentOptions {
                overwrite: true, // allow resuming an already-downloaded torrent
                initial_peers: if initial_peers.is_empty() { None } else { Some(initial_peers) },
                // Always announce to a set of reliable public trackers so a DHT-only or pasted
                // magnet (which carries no `tr=`) still finds a swarm instead of relying on DHT
                // alone — librqbit merges these with any trackers already in the magnet.
                trackers: Some(crate::indexer::APIBAY_TRACKERS.iter().map(|t| t.to_string()).collect()),
                ..Default::default()
            }),
        )
        .await
        .context("add_torrent")?;
    let handle = match resp {
        AddTorrentResponse::Added(_, h) | AddTorrentResponse::AlreadyManaged(_, h) => h,
        AddTorrentResponse::ListOnly(_) => return Err(anyhow!("list-only response")),
    };
    let id = handle.info_hash().as_string();
    let title = magnet_title(magnet)
        .or_else(|| handle.name())
        .unwrap_or_else(|| id.clone());
    let now = std::time::Instant::now();
    // A download is parked PAUSED until the scheduler gives it a slot; a stream starts now.
    if queue {
        let _ = session.pause(&handle).await;
    }
    torrents.write().await.insert(
        id.clone(),
        Entry {
            handle,
            title,
            magnet: magnet.to_string(),
            added: now,
            queue_managed: queue,
            queued: queue,
            released_at: if queue { None } else { Some(now) },
            last_progress_bytes: 0,
            progressed_at: None,
            is_seed: false,
        },
    );
    if queue {
        schedule_queue(session, torrents, max_active_downloads).await;
    }
    Ok(id)
}

/// True if a queue-managed download currently occupies an active slot — running (or just
/// released and still within the stall grace), not finished, not paused/errored.
fn is_active_slot(e: &Entry, now: std::time::Instant) -> bool {
    if !e.queue_managed || e.queued {
        return false; // streams + not-yet-started queued downloads don't hold a slot
    }
    let s = e.handle.stats();
    if s.finished {
        return false; // done downloading — seeding, not consuming a slot
    }
    use librqbit::TorrentStatsState as St;
    if !matches!(s.state, St::Live | St::Initializing) {
        return false; // user-paused or errored
    }
    // Bytes actually arriving is the most reliable "working now" signal — and the only one
    // that works for archive.org's HTTP web-seeded torrents, which report 0 BitTorrent peers
    // and bursty/zero instantaneous speed (so peers/speed alone wrongly flagged them stalled,
    // causing pause/resume churn). This is a recent DELTA, not cumulative progress: a restored
    // partial that isn't downloading stops increasing, so `progressed_at` goes stale and it
    // still yields its slot (the original reason cumulative progress_bytes was rejected here).
    if let Some(t0) = e.progressed_at {
        if now.duration_since(t0) < QUEUE_STALL_GRACE {
            return true;
        }
    }
    // CURRENT connectivity as a secondary signal: a swarm torrent connected to peers (or
    // transferring this instant) is active even before the first delta sample lands.
    let live = s.live.as_ref();
    let peers = live.map(|l| l.snapshot.peer_stats.live).unwrap_or(0);
    let speed = live.map(|l| l.download_speed.mbps).unwrap_or(0.0);
    if peers > 0 || speed > 0.0 {
        return true; // genuinely transferring / connected right now
    }
    // Connecting with nothing yet: hold the slot only during the grace window after release, so a
    // dead magnet at the head of the queue eventually yields. No release timestamp ⇒ expired.
    e.released_at.map(|t| now.duration_since(t) < QUEUE_STALL_GRACE).unwrap_or(false)
}

/// Choose which queued downloads to release, oldest-added first, given how many slots are
/// already taken. Pure (no librqbit) so the one-at-a-time invariant is unit-testable.
fn pick_queue_releases(active: usize, max: usize, mut queued: Vec<(String, std::time::Instant)>) -> Vec<String> {
    let slots = max.saturating_sub(active);
    if slots == 0 {
        return Vec::new();
    }
    queued.sort_by_key(|(_, t)| *t); // oldest first
    queued.into_iter().take(slots).map(|(id, _)| id).collect()
}

/// Enforce the queue invariant: at most `max_active_downloads` queue-managed downloads are
/// unpaused, the rest wait paused. Idempotent — safe to call every tick and after add/pause/remove.
///
/// Previously this only *released* the next queued item and never *paused* anything, so a stalled
/// head (no peers) stayed unpaused while the next one started → two downloading at once, and a
/// dead old item blocked the queue. Now each tick: (1) rotate a stalled, released download to the
/// back and re-pause it if anything is waiting; (2) pause any excess beyond the cap; (3) release
/// the oldest queued to fill free slots.
async fn schedule_queue(session: &Arc<Session>, torrents: &Torrents, max_active_downloads: usize) {
    let now = std::time::Instant::now();
    let (to_pause, to_release): (Vec<Handle>, Vec<Handle>) = {
        let mut t = torrents.write().await;
        let mut to_pause: Vec<Handle> = Vec::new();
        let mut to_release: Vec<Handle> = Vec::new();

        // (0) Sample download progress so is_active_slot can tell a web-seeded archive.org
        //     download (0 peers, bursty speed) that's actually pulling bytes apart from a truly
        //     stalled one. Record the timestamp whenever progress_bytes grows.
        for e in t.values_mut() {
            if !e.queue_managed || e.queued {
                continue;
            }
            let pb = e.handle.stats().progress_bytes;
            if pb > e.last_progress_bytes {
                e.last_progress_bytes = pb;
                e.progressed_at = Some(now);
            }
        }

        // (0.5) A queue-managed download that has FINISHED is now a seed: it shares from disk and
        //     must leave queue management entirely. `is_active_slot` returns false for a finished
        //     torrent (it consumes no download slot), so step (1) below would otherwise mistake it
        //     for a "stalled" download and re-queue/pause it — which stops us seeding (peers can no
        //     longer pull our shared files) and flaps the row between "seeding" and "queued" every
        //     tick. Promote it to a steady seed so it stays unpaused and available to the swarm.
        let finished_ids: Vec<String> = t
            .iter()
            .filter(|(_, e)| e.queue_managed && e.handle.stats().finished)
            .map(|(id, _)| id.clone())
            .collect();
        for id in finished_ids {
            if let Some(e) = t.get_mut(&id) {
                if e.queued {
                    // The scheduler had paused it while it waited — resume so it actually seeds.
                    to_release.push(e.handle.clone());
                }
                e.queue_managed = false;
                e.queued = false;
                e.is_seed = true;
                e.released_at = Some(now);
            }
        }

        // (1) A released download that has stalled out of its slot (no peers past the grace) must be
        //     re-paused — otherwise it keeps transferring alongside whatever starts next. Rotate it
        //     to the back (added=now) so a waiting download gets the next turn. Skip if nothing else
        //     is waiting, so a lone stalled download isn't pause/unpause-thrashed every tick.
        let others_waiting = t.values().any(|e| e.queue_managed && e.queued);
        if others_waiting {
            let stalled: Vec<String> = t
                .iter()
                .filter(|(_, e)| e.queue_managed && !e.queued && !is_active_slot(e, now))
                .map(|(id, _)| id.clone())
                .collect();
            for id in stalled {
                if let Some(e) = t.get_mut(&id) {
                    e.queued = true;
                    e.released_at = None;
                    e.added = now;
                    to_pause.push(e.handle.clone());
                }
            }
        }

        // (2) Hard-cap concurrency: if more than the configured cap are somehow active (an earlier bug left two
        //     running, or two connected during the grace), pause the excess, keeping the oldest.
        let mut active: Vec<(String, std::time::Instant)> = t
            .iter()
            .filter(|(_, e)| e.queue_managed && !e.queued && is_active_slot(e, now))
            .map(|(id, e)| (id.clone(), e.released_at.unwrap_or(e.added)))
            .collect();
        if active.len() > max_active_downloads {
            active.sort_by_key(|(_, ts)| *ts); // oldest-released first = keep running
            for (id, _) in active.iter().skip(max_active_downloads) {
                if let Some(e) = t.get_mut(id) {
                    e.queued = true;
                    e.released_at = None;
                    to_pause.push(e.handle.clone());
                }
            }
        }

        // (3) Fill any free slots with the oldest queued downloads.
        let active_now = t
            .values()
            .filter(|e| e.queue_managed && !e.queued && is_active_slot(e, now))
            .count();
        let waiting: Vec<(String, std::time::Instant)> = t
            .iter()
            .filter(|(_, e)| e.queue_managed && e.queued)
            .map(|(id, e)| (id.clone(), e.added))
            .collect();
        let ids = pick_queue_releases(active_now, max_active_downloads, waiting);
        for id in ids {
            if let Some(e) = t.get_mut(&id) {
                e.queued = false;
                e.released_at = Some(now);
                to_release.push(e.handle.clone());
            }
        }
        (to_pause, to_release)
    };
    for h in to_pause {
        let _ = session.pause(&h).await;
    }
    for h in to_release {
        let _ = session.unpause(&h).await;
    }
}

// ===================== LAN control API (linked iPad → Mac host) =====================

/// Gate non-localhost requests. Localhost (the desktop app's own webview) passes through.
/// On the LAN: `/api/pair` is open (PIN-gated), other `/api/*` need a Bearer token, and the
/// streaming endpoints need a `?tk=` token (a <video> can't send Authorization headers).
async fn auth_middleware(
    AxState(state): AxState<ServerState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let is_local = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip().is_loopback())
        .unwrap_or(true);
    let path = req.uri().path();
    // `/api/pair` is PIN-gated; `/art/` is just cached poster images (non-sensitive, and an
    // <img> can't carry a token) so it's open on the LAN too.
    if is_local || path == "/api/pair" || path.starts_with("/art/") || req.method() == Method::OPTIONS {
        return next.run(req).await;
    }
    let authorized = if path.starts_with("/api/") {
        req.headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .is_some_and(|t| remote::verify_token(&state.secret, t))
    } else {
        // /stream /remux /hls /file /art /subs … : token in the query string (?tk=…)
        req.uri()
            .query()
            .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("tk=")))
            .is_some_and(|t| remote::verify_token(&state.secret, t))
    };
    if authorized {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
    }
}

#[derive(serde::Deserialize)]
struct PairReq {
    pin: String,
}
#[derive(Serialize)]
struct PairResp {
    token: String,
    device_id: String,
    name: String,
}
/// PIN handshake → long-lived bearer token. Open endpoint (the PIN is the gate).
async fn api_pair(AxState(state): AxState<ServerState>, Json(body): Json<PairReq>) -> Response {
    if remote::consume_pin(&state.pairing, &body.pin).await {
        let token = remote::mint_token(&state.secret, remote::BEARER_TTL_SECS);
        Json(PairResp {
            token,
            device_id: state.device_id.clone(),
            name: state.device_name.clone(),
        })
        .into_response()
    } else {
        (StatusCode::UNAUTHORIZED, "bad or expired pin").into_response()
    }
}

#[derive(Serialize)]
struct DeviceInfoResp {
    device_id: String,
    name: String,
    version: String,
}
async fn api_device_info(AxState(state): AxState<ServerState>) -> Response {
    Json(DeviceInfoResp {
        device_id: state.device_id.clone(),
        name: state.device_name.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
    .into_response()
}

async fn api_list_downloads(AxState(state): AxState<ServerState>) -> Response {
    Json(build_snapshot(&state.torrents, &state.pending, state.ffmpeg.is_some()).await).into_response()
}

#[derive(serde::Deserialize)]
struct AddReq {
    magnet: String,
}
#[derive(Serialize)]
struct AddResp {
    id: String,
}
async fn api_add_torrent(AxState(state): AxState<ServerState>, Json(body): Json<AddReq>) -> Response {
    // A LAN client (linked iPad) "add" is a download request → enqueue it.
    let max_active = *state.max_active_downloads.read().await;
    match add_magnet(&state.session, &state.torrents, &body.magnet, true, max_active, Vec::new()).await {
        Ok(id) => Json(AddResp { id }).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, format!("{e:#}")).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct StreamUrlReq {
    id: String,
    file: Option<usize>,
}
#[derive(Serialize)]
struct StreamUrlResp {
    url: String,
}
/// Returns a server-RELATIVE playback path + a short-lived stream token; the client prepends
/// the Mac's base URL. The Mac has ffmpeg, so non-web-native video routes through /hls and
/// plays on the iPad regardless of codec.
async fn api_stream_url(
    AxState(state): AxState<ServerState>,
    AxQuery(q): AxQuery<StreamUrlReq>,
) -> Response {
    let handle = match state.torrents.read().await.get(&q.id).map(|e| e.handle.clone()) {
        Some(h) => h,
        None => return (StatusCode::NOT_FOUND, "unknown torrent").into_response(),
    };
    for _ in 0..300 {
        if matches!(handle.stats().state, librqbit::TorrentStatsState::Live) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let file = q.file.or_else(|| largest_file(&handle)).unwrap_or(0);
    let name = file_name(&handle, file);
    let kind = name.as_deref().map_or("video", media_kind);
    let mut path = play_path(state.ffmpeg.is_some(), &q.id, file, name.as_deref());
    // Codec-aware override for the paired iPad: the extension may say `.mp4`/`.mov` while the
    // bytes carry AC-3/DTS audio or VP9/AV1 video that WKWebView's `<video>` can't decode — so
    // the Mac (which has ffmpeg) probes the real codecs and transcodes on the iPad's behalf
    // instead of handing it a direct URL that just fails. Only probe video that wasn't already
    // routed to /hls by extension; on probe timeout/failure ios_native() is false → transcode.
    if kind == "video" && state.ffmpeg.is_some() && !path.starts_with("/hls/") {
        let input = format!("http://127.0.0.1:{STREAM_PORT}/stream/{}/{}", q.id, file);
        let (container, vcodec, acodec) = tokio::time::timeout(
            Duration::from_secs(20),
            media_probe(state.ffprobe.as_deref(), &input),
        )
        .await
        .unwrap_or((None, None, None));
        if !ios_native(container.as_deref(), vcodec.as_deref(), acodec.as_deref()) {
            path = format!("/hls/{}/{}/index.m3u8", q.id, file);
        }
    }
    let tk = remote::mint_token(&state.secret, remote::STREAM_TTL_SECS);
    let sep = if path.contains('?') { '&' } else { '?' };
    Json(StreamUrlResp {
        url: format!("{path}{sep}tk={tk}"),
    })
    .into_response()
}

// ===================== Companion mode (linked iPad mirrors this desktop) =====================
// These serve this desktop's own data — the on-disk Library scan, the curated Library, the
// indexed catalog (Discover), and a live source search — so a paired iPad shows EXACTLY what
// the desktop shows. The iPad streams/plays from this host and never downloads or stores
// anything itself. All sit behind the bearer-token auth middleware.

/// The desktop's on-disk Library scan (movies / shows / music). Each item's `url` carries a
/// loopback `127.0.0.1` URL the iPad ignores — it plays via `/api/library_stream_url` instead.
async fn api_list_downloaded(AxState(state): AxState<ServerState>) -> Response {
    let info = state.app_info.clone();
    let catalog = state.catalog.clone();
    // The scan is a synchronous disk walk + tag read; keep it off the async runtime.
    match tokio::task::spawn_blocking(move || crate::scan_downloaded(&info, &catalog)).await {
        Ok(items) => Json(items).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "scan failed").into_response(),
    }
}

#[derive(serde::Deserialize)]
struct LimitReq {
    limit: Option<i64>,
}
/// The desktop's curated Library (scanned + AI-enriched items).
async fn api_list_library(
    AxState(state): AxState<ServerState>,
    AxQuery(q): AxQuery<LimitReq>,
) -> Response {
    match state.catalog.list_library(q.limit.unwrap_or(1000)) {
        Ok(items) => Json(items).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct CatalogReq {
    query: Option<String>,
    category: Option<String>,
    sort: Option<String>,
}
/// The desktop's indexed catalog (Discover) — same filtering/sorting as the local command.
async fn api_list_catalog(
    AxState(state): AxState<ServerState>,
    AxQuery(q): AxQuery<CatalogReq>,
) -> Response {
    match state.catalog.list_items(
        q.query.as_deref(),
        q.category.as_deref(),
        q.sort.as_deref().unwrap_or("popularity"),
        1000,
    ) {
        Ok(items) => Json(items).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotResp {
    version: i64,
    catalog_count: usize,
    library_count: usize,
    downloaded_count: usize,
    catalog: Vec<crate::catalog::CatalogItem>,
    library: Vec<crate::catalog::LibraryItem>,
    downloaded: Vec<crate::DownloadedItem>,
}
/// The whole companion index in one round-trip — catalog (Discover) + curated library +
/// on-disk downloaded — so the iPad hydrates every view from a single request and can
/// persist it for an instant cold-start paint. The disk scan runs off the async runtime.
async fn api_snapshot(AxState(state): AxState<ServerState>) -> Response {
    let info = state.app_info.clone();
    let cat = state.catalog.clone();
    let downloaded = match tokio::task::spawn_blocking(move || crate::scan_downloaded(&info, &cat)).await {
        Ok(d) => d,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "scan failed").into_response(),
    };
    // Capped to keep the JSON small: a companion iPad's WKWebView OOMs (black screen) holding +
    // rendering the full multi-thousand-item set with posters. Discover/curated only need enough
    // to browse — the rest is a search away — while the on-disk `downloaded` (the user's actual
    // Library) is returned in full below.
    let catalog = match state.catalog.list_items(None, None, "popularity", 800) {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    let library = match state.catalog.list_library(600) {
        Ok(l) => l,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    let version = state.catalog.snapshot_version().unwrap_or(0);
    Json(SnapshotResp {
        version,
        catalog_count: catalog.len(),
        library_count: library.len(),
        downloaded_count: downloaded.len(),
        catalog,
        library,
        downloaded,
    })
    .into_response()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotVersionResp {
    version: i64,
    catalog_count: usize,
}
/// Cheap "did anything change?" probe — the iPad polls this before pulling the full snapshot,
/// skipping the (potentially multi-MB) transfer when its persisted copy is already current.
async fn api_snapshot_version(AxState(state): AxState<ServerState>) -> Response {
    let version = state.catalog.snapshot_version().unwrap_or(0);
    let catalog_count = state.catalog.count_items().unwrap_or(0) as usize;
    Json(SnapshotVersionResp { version, catalog_count }).into_response()
}

#[derive(serde::Deserialize)]
struct SearchReq {
    q: String,
}
/// Live source search on the desktop (its sources + ffmpeg), returned to the iPad.
async fn api_search(
    AxState(state): AxState<ServerState>,
    AxQuery(q): AxQuery<SearchReq>,
) -> Response {
    match crate::search_sources_core(&state.catalog, &q.q).await {
        Ok(items) => Json(items).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct LibraryStreamReq {
    relpath: String,
}
/// A token-bearing, server-RELATIVE playback path for a FINISHED Library file (by its path
/// relative to the download root). Mirrors how `scan_downloaded` builds local `/file` URLs:
/// non-web-native video the desktop can transcode goes via `/localhls` (the desktop has
/// ffmpeg), everything else streams raw from `/file`. The iPad prepends the Mac base URL.
async fn api_library_stream_url(
    AxState(state): AxState<ServerState>,
    AxQuery(q): AxQuery<LibraryStreamReq>,
) -> Response {
    let rel = q.relpath.trim_start_matches('/');
    if rel.is_empty() || rel.contains("..") {
        return (StatusCode::BAD_REQUEST, "bad relpath").into_response();
    }
    let abs = PathBuf::from(&state.app_info.download_dir).join(rel);
    if !tokio::fs::metadata(&abs).await.map(|m| m.is_file()).unwrap_or(false) {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let tk = remote::mint_token(&state.secret, remote::STREAM_TTL_SECS);
    // Codec-aware route for the paired iPad. `local_transcodes` already catches extensions
    // WKWebView can't decode (mkv/avi/ts/wmv…) — those skip the probe. Video whose extension
    // *looks* native (.mp4/.mov/.m4v/.webm) is probed on disk so a mislabeled file (e.g. an
    // .mp4 with an AC-3 track) is transcoded via /localhls instead of failing on the iPad.
    let path = if state.app_info.ffmpeg_available && media_kind(rel) == "video" {
        let needs_transcode = if local_transcodes(rel) {
            true
        } else {
            let (container, vcodec, acodec) = tokio::time::timeout(
                Duration::from_secs(20),
                media_probe(state.ffprobe.as_deref(), &abs.to_string_lossy()),
            )
            .await
            .unwrap_or((None, None, None));
            !ios_native(container.as_deref(), vcodec.as_deref(), acodec.as_deref())
        };
        if needs_transcode {
            format!("/localhls/{}/index.m3u8", hls_token(rel))
        } else {
            format!("/file/{}", enc_path_rel(rel))
        }
    } else {
        format!("/file/{}", enc_path_rel(rel))
    };
    let sep = if path.contains('?') { '&' } else { '?' };
    Json(StreamUrlResp {
        url: format!("{path}{sep}tk={tk}"),
    })
    .into_response()
}

/// Percent-encode each path segment so spaces / unicode survive the `/file/{*relpath}` URL.
/// Local equivalent of `lib::enc_path` (kept here so the engine has no cross-module dep).
fn enc_path_rel(rel: &str) -> String {
    rel.split('/')
        .map(|seg| {
            seg.chars()
                .flat_map(|c| match c {
                    'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => vec![c.to_string()],
                    _ => c.to_string().bytes().map(|b| format!("%{b:02X}")).collect(),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Codec-aware loopback playback URL for a local file on the desktop. The extension alone
/// lies — a `.mp4` can carry HEVC video or AC-3/E-AC-3/DTS audio that WKWebView's HTML5
/// `<video>` can't decode (it plays fine in QuickTime but dies silently in the webview) — so
/// for MP4-family video we probe the actual streams and route anything not HTML5-playable
/// through the HLS transcoder. Non-MP4 video (mkv/avi/ts/wmv…) is caught by extension; audio
/// and everything else streams raw. Mirrors `api_library_stream_url` but for same-device play.
/// Memoizes the "does this file need transcoding?" verdict per (relpath, size) so repeated
/// plays of the same file skip the ffprobe subprocess. Cleared on process restart (fine — a
/// downloaded file's codec doesn't change, and size guards against a file being replaced).
fn probe_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, bool>> {
    static C: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, bool>>> =
        std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub async fn local_play_url_for(
    download_dir: &str,
    ffmpeg_available: bool,
    ffprobe: Option<&Path>,
    rel: &str,
) -> String {
    let needs_transcode = ffmpeg_available
        && media_kind(rel) == "video"
        && if local_transcodes(rel) {
            true // mkv/avi/ts/… — non-web-native extension, never raw
        } else {
            // .mp4/.mov/.m4v/.webm: extension looks native, but the bytes may not be.
            let abs = PathBuf::from(download_dir).join(rel);
            let size = tokio::fs::metadata(&abs).await.map(|m| m.len()).unwrap_or(0);
            // Cache the verdict per file (path+size) — without this, ffprobe (a subprocess,
            // 0.5–2s) ran on every play/replay/seek of the same file.
            let cache_key = format!("{rel}:{size}");
            let cached = probe_cache().lock().unwrap_or_else(|e| e.into_inner()).get(&cache_key).copied();
            match cached {
                Some(v) => v,
                None => {
                    let (container, vcodec, acodec) = tokio::time::timeout(
                        Duration::from_secs(20),
                        media_probe(ffprobe, &abs.to_string_lossy()),
                    )
                    .await
                    .unwrap_or((None, None, None));
                    let v = !webview_native(container.as_deref(), vcodec.as_deref(), acodec.as_deref());
                    probe_cache().lock().unwrap_or_else(|e| e.into_inner()).insert(cache_key, v);
                    v
                }
            }
        };
    let path = if needs_transcode {
        format!("/localhls/{}/index.m3u8", hls_token(rel))
    } else {
        format!("/file/{}", enc_path_rel(rel))
    };
    format!("http://127.0.0.1:{STREAM_PORT}{path}")
}

/// Matroska family — the containers our in-process remux can read.
fn is_matroska(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".mkv") || n.ends_with(".webm")
}

fn file_name(handle: &Arc<ManagedTorrent>, idx: usize) -> Option<String> {
    handle
        .with_metadata(|m| {
            m.file_infos
                .get(idx)
                .map(|fi| fi.relative_filename.to_string_lossy().to_string())
        })
        .ok()
        .flatten()
}

/// Locate ffmpeg + ffprobe (PATH, then common macOS dirs — GUI apps launch with a
/// minimal PATH that usually omits Homebrew).
pub fn resolve_ffmpeg() -> (Option<PathBuf>, Option<PathBuf>) {
    // Prefer the bundled sidecar (Tauri places externalBin next to the app executable as plain
    // `ffmpeg`/`ffprobe`, with a `.exe` suffix on Windows), so a clean machine with no system
    // ffmpeg can still transcode MKV/HEVC/AC-3 out of the box. Fall back to a system install on
    // PATH (dev builds, or platforms where the sidecar isn't bundled yet).
    let exe = std::env::consts::EXE_SUFFIX; // "" on unix, ".exe" on Windows
    let bundled = |name: &str| -> Option<PathBuf> {
        let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
        let p = dir.join(format!("{name}{exe}"));
        p.is_file().then_some(p)
    };
    let pick = |name: &str| bundled(name).or_else(|| find_bin(name));
    (pick("ffmpeg"), pick("ffprobe"))
}

fn find_bin(name: &str) -> Option<PathBuf> {
    let exe = std::env::consts::EXE_SUFFIX; // ".exe" on Windows
    let file = format!("{name}{exe}");
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join(&file);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let p = Path::new(d).join(&file);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn mbps_to_bps(mbps: f64) -> u64 {
    (mbps * 1_048_576.0) as u64
}

fn magnet_meta(magnet: &str) -> (usize, bool) {
    let query = magnet.split_once('?').map(|x| x.1).unwrap_or("");
    let trackers = query.split('&').filter(|kv| kv.starts_with("tr=")).count();
    let webseed = query.split('&').any(|kv| kv.starts_with("ws=") || kv.starts_with("xs="));
    (trackers, webseed)
}

fn file_list(handle: &Arc<ManagedTorrent>) -> Vec<FileEntry> {
    handle
        .with_metadata(|m| {
            m.file_infos
                .iter()
                .enumerate()
                .map(|(index, fi)| FileEntry {
                    index,
                    name: fi.relative_filename.to_string_lossy().to_string(),
                    size: fi.len,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn file_size(handle: &Arc<ManagedTorrent>, idx: usize) -> u64 {
    handle
        .with_metadata(|m| m.file_infos.get(idx).map(|fi| fi.len))
        .ok()
        .flatten()
        .unwrap_or(0)
}

/// Resolve what a seeding torrent actually is (category / media type / total size) and, for
/// music, its real embedded tags — so the share we hand a friend carries enough for their
/// client to render the correct cover instead of guessing from the bare file name.
/// `download_root` is the engine's storage root; content lives under it (newer downloads in
/// `Downloads/`, older ones directly under the root), so we try both when reading tags.
fn share_meta(handle: &Handle, download_root: &Path) -> ShareMeta {
    let files: Vec<(PathBuf, u64)> = handle
        .with_metadata(|m| {
            m.file_infos
                .iter()
                .map(|fi| (fi.relative_filename.clone(), fi.len))
                .collect()
        })
        .unwrap_or_default();
    let mut meta = ShareMeta::default();
    let total: u64 = files.iter().map(|(_, l)| *l).sum();
    if total > 0 {
        meta.size_bytes = Some(total);
    }
    // The biggest file is the "main" content (the feature/track, not a sample or sidecar).
    let Some((rel, _)) = files.iter().max_by_key(|(_, l)| *l) else {
        return meta;
    };
    let ext = rel
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = crate::export::kind_of_ext(&ext);
    meta.category = Some(category_for_kind(kind).to_string());
    meta.media_type = media_type_for_kind(kind).map(|s| s.to_string());
    // Music: read the file's own tags so the peer matches album art by artist + album.
    if kind == Some("audio") {
        let candidates = [download_root.join("Downloads").join(rel), download_root.join(rel)];
        if let Some(abs) = candidates.into_iter().find(|p| p.exists()) {
            let (title, artist, album) = crate::metadata::read_tags(&abs);
            meta.track_title = title.filter(|s| !s.trim().is_empty());
            meta.artist = artist.filter(|s| !s.trim().is_empty());
            meta.album = album.filter(|s| !s.trim().is_empty());
        }
    }
    meta
}

/// Map an on-disk media kind to the coarse share category the browse UI buckets on.
fn category_for_kind(kind: Option<&str>) -> &'static str {
    match kind {
        Some("video") => "video",
        Some("audio") => "audio",
        Some("book") => "books",
        Some("game") => "software",
        _ => "other",
    }
}

/// Finer media type, only when the kind is unambiguous. Video stays None (movie vs. show
/// can't be told from the extension), so the peer infers that from the name.
fn media_type_for_kind(kind: Option<&str>) -> Option<&'static str> {
    match kind {
        Some("audio") => Some("music"),
        Some("book") => Some("book"),
        Some("game") => Some("game"),
        _ => None,
    }
}


fn ext_of(name: &str) -> Option<String> {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 5)
}

fn dot_ext(ext: Option<&str>) -> String {
    ext.map(|e| format!(".{e}")).unwrap_or_else(|| "this file".to_string())
}

fn is_video_ext(e: &str) -> bool {
    matches!(
        e,
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "m4v" | "wmv" | "flv" | "ts" | "m2ts" | "mpg" | "mpeg" | "ogv" | "3gp"
    )
}

fn up_container(c: &str) -> String {
    let c = c.to_lowercase();
    if c.contains("matroska") {
        "MKV".into()
    } else if c.contains("mp4") || c.contains("mov") {
        "MP4".into()
    } else if c.contains("webm") {
        "WebM".into()
    } else if c.contains("avi") {
        "AVI".into()
    } else {
        c.split(',').next().unwrap_or(&c).to_uppercase()
    }
}

/// Human-readable status — the line the panel shows to explain what's (not) happening.
fn diagnose(i: &MediaInfo) -> String {
    if i.state == "error" {
        return "Torrent error — librqbit reported a failure for this infohash; it can't be streamed.".to_string();
    }
    if !i.has_meta {
        if i.peers == 0 && i.trackers == 0 && !i.webseed && i.age_secs >= 8 {
            return format!(
                "No peers, and this magnet has no trackers or web seed (DHT-only) after {}s — likely an unreachable or placeholder infohash. It won't stream.",
                i.age_secs
            );
        }
        if i.age_secs >= 60 {
            return format!("Still no metadata after {}s — no reachable peers for this infohash yet.", i.age_secs);
        }
        return format!(
            "Connecting… {} peers, {} tracker{}{}. Fetching metadata.",
            i.peers,
            i.trackers,
            if i.trackers == 1 { "" } else { "s" },
            if i.webseed { " + web seed" } else { "" }
        );
    }
    let is_video = i.file_ext.as_deref().map_or(true, is_video_ext);
    if !is_video {
        return format!(
            "Auto-selected the largest file{} — not a playable video. Pick another file below.",
            i.file_ext.as_deref().map(|e| format!(" (.{e})")).unwrap_or_default()
        );
    }
    let fmt = format!(
        "{}{}{}",
        i.container.as_deref().map(up_container).unwrap_or_else(|| "Unknown".into()),
        i.video_codec.as_deref().map(|v| format!(" · {v}")).unwrap_or_default(),
        i.audio_codec.as_deref().map(|a| format!(" / {a}")).unwrap_or_default()
    );
    if let Some(err) = &i.transcode_error {
        return format!("{fmt}: transcode failed — {err}");
    }
    match i.endpoint.as_deref() {
        Some("transcode") if !i.ffmpeg_available => {
            format!("{fmt}: not web-native and ffmpeg isn't installed — install ffmpeg to play it.")
        }
        Some("transcode") => format!("{fmt} → converting to H.264 (seekable)."),
        _ => format!("{fmt} → direct play."),
    }
}

async fn media_probe(ffprobe: Option<&Path>, input: &str) -> (Option<String>, Option<String>, Option<String>) {
    let Some(p) = ffprobe else {
        return (None, None, None);
    };
    let out = tokio::process::Command::new(p)
        .args([
            "-v", "error",
            "-show_entries", "format=format_name:stream=codec_type,codec_name",
            "-of", "json",
            input,
        ])
        .output()
        .await;
    let Ok(o) = out else {
        return (None, None, None);
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&o.stdout) else {
        return (None, None, None);
    };
    let container = v["format"]["format_name"].as_str().map(|s| s.to_string());
    let (mut vc, mut ac) = (None, None);
    if let Some(streams) = v["streams"].as_array() {
        for st in streams {
            match st["codec_type"].as_str() {
                Some("video") if vc.is_none() => vc = st["codec_name"].as_str().map(|s| s.to_string()),
                Some("audio") if ac.is_none() => ac = st["codec_name"].as_str().map(|s| s.to_string()),
                _ => {}
            }
        }
    }
    (container, vc, ac)
}

/// Index of the largest file in a resolved torrent (the video, vs. samples/subs).
fn largest_file(handle: &Arc<ManagedTorrent>) -> Option<usize> {
    handle
        .with_metadata(|m| {
            m.file_infos
                .iter()
                .enumerate()
                .max_by_key(|(_, fi)| fi.len)
                .map(|(i, _)| i)
        })
        .ok()
        .flatten()
}

/// Adds permissive CORS headers to every response so the cross-origin WKWebView page can
/// read media bytes (un-taints audio for the Web Audio analyser) AND call the `/api/*`
/// control endpoints from a linked iPad. A CORS preflight (OPTIONS) is answered here with
/// 204 — otherwise it would route to a POST-only handler and 405, blocking the real request.
async fn cors_headers(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    use axum::http::HeaderValue;
    let mut res = if req.method() == Method::OPTIONS {
        Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(Body::empty())
            .unwrap()
    } else {
        next.run(req).await
    };
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, HEAD, OPTIONS"));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("range, content-type, authorization"));
    h.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static("content-range, content-length, accept-ranges"));
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    res
}

async fn stream_handler(
    AxPath((id, file)): AxPath<(String, usize)>,
    headers: HeaderMap,
    AxState(state): AxState<ServerState>,
) -> Response {
    let handle = match state.torrents.read().await.get(&id).map(|e| e.handle.clone()) {
        Some(h) => h,
        None => return (StatusCode::NOT_FOUND, "unknown torrent").into_response(),
    };
    // The torrent may still be initializing when the <video> first requests;
    // briefly retry until storage is ready.
    let mut fs = {
        let mut opened = None;
        let mut last_err = String::new();
        for _ in 0..25 {
            match handle.clone().stream(file) {
                Ok(f) => {
                    opened = Some(f);
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
        match opened {
            Some(f) => f,
            None => {
                return (StatusCode::SERVICE_UNAVAILABLE, format!("not ready: {last_err}"))
                    .into_response()
            }
        }
    };
    let total = fs.len();
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|r| parse_range(r, total));
    let (start, end) = range.unwrap_or((0, total.saturating_sub(1)));
    if total == 0 || start > end || start >= total {
        return (
            StatusCode::RANGE_NOT_SATISFIABLE,
            [(header::CONTENT_RANGE, format!("bytes */{total}"))],
        )
            .into_response();
    }
    if fs.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "seek failed").into_response();
    }
    let len = end - start + 1;
    let body = Body::from_stream(ReaderStream::new(fs.take(len)));
    let status = if range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    // Serve the file's real media type (not a blanket video/mp4) so audio — FLAC,
    // MP3, ALAC… — is labeled audio/*; WKWebView decodes FLAC natively when the
    // Content-Type is right, otherwise it refuses the mislabeled stream.
    let ct = file_name(&handle, file).as_deref().map(content_type_for).unwrap_or("video/mp4");
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, ct)
        .header(header::CONTENT_LENGTH, len.to_string());
    if range.is_some() {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"));
    }
    builder.body(body).unwrap().into_response()
}

/// Bridges librqbit's async, piece-aware `FileStream` to the synchronous `Read + Seek`
/// the Matroska demuxer needs, by blocking on each op. Only safe to use from a blocking
/// thread (e.g. `spawn_blocking`) — never a runtime worker. Seeking lets the demuxer reach
/// the Cues/SeekHead at the file's tail; librqbit prioritises + waits for those pieces, so
/// remux works while the torrent is still downloading.
struct BlockingRead<S> {
    inner: S,
    rt: tokio::runtime::Handle,
}
impl<S: AsyncReadExt + Unpin> std::io::Read for BlockingRead<S> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.rt.block_on(self.inner.read(buf))
    }
}
impl<S: AsyncSeekExt + Unpin> std::io::Seek for BlockingRead<S> {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.rt.block_on(self.inner.seek(pos))
    }
}

/// iOS can't spawn ffmpeg, so non-web-native Matroska video is repackaged to fragmented
/// MP4 in-process (pure Rust, no re-encode) and streamed here. Codecs that genuinely need
/// decoding (AC-3/DTS audio, VP9/MPEG-4 ASP video) return an error → the player shows an
/// honest "unsupported format" message.
async fn remux_handler(
    AxPath((id, file)): AxPath<(String, usize)>,
    AxState(state): AxState<ServerState>,
) -> Response {
    let handle = match state.torrents.read().await.get(&id).map(|e| e.handle.clone()) {
        Some(h) => h,
        None => return (StatusCode::NOT_FOUND, "unknown torrent").into_response(),
    };
    // Storage may still be initializing on the first request — retry briefly.
    let stream = {
        let mut opened = None;
        for _ in 0..25 {
            match handle.clone().stream(file) {
                Ok(f) => {
                    opened = Some(f);
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
        match opened {
            Some(f) => f,
            None => return (StatusCode::SERVICE_UNAVAILABLE, "not ready").into_response(),
        }
    };

    // Run the (synchronous) demux+mux on a blocking thread, piping fMP4 bytes through an
    // in-memory duplex into the HTTP body. Backpressure: if the client reads slowly the
    // duplex fills and write_all blocks; if it disconnects, writes error → remux stops.
    let (writer, reader) = tokio::io::duplex(256 * 1024);
    let rt = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let src = BlockingRead { inner: stream, rt: rt.clone() };
        let mut writer = writer;
        let res = crate::remux::remux_mkv_to_fmp4(src, |chunk| {
            rt.block_on(async { writer.write_all(chunk).await }).is_ok()
        });
        if let Err(e) = res {
            eprintln!("ghosty: remux {id}/{file}: {e}");
        }
        // `writer` drops here → EOF on the reader → response body completes.
    });

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "video/mp4")
        .header(header::ACCEPT_RANGES, "none")
        .body(Body::from_stream(ReaderStream::new(reader)))
        .unwrap()
        .into_response()
}

/// Serve the HLS playlist for a file, starting the ffmpeg transcode on first request
/// and waiting for the first segment so the player gets a usable playlist.
/// Serve a VOD-style HLS playlist that declares the full source duration, so the player
/// treats it as a normal seekable video (scrub the whole timeline, pause/resume) rather
/// than a live broadcast. Segments are produced on demand; the segment handler waits for
/// any ffmpeg hasn't reached yet (backward seeks are instant, forward seeks buffer).
async fn hls_playlist_handler(
    AxPath((id, file)): AxPath<(String, usize)>,
    axum::extract::RawQuery(query): axum::extract::RawQuery,
    AxState(state): AxState<ServerState>,
) -> Response {
    // Propagate any ?tk= stream token onto the segment URIs so a LAN client's per-segment
    // fetches carry it through the auth middleware (a <video> can't add headers per segment).
    let tk_suffix = query
        .as_deref()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("tk=")))
        .map(|t| format!("?tk={t}"))
        .unwrap_or_default();
    let ffmpeg = match &state.ffmpeg {
        Some(p) => p.clone(),
        None => return (StatusCode::NOT_IMPLEMENTED, "ffmpeg not installed").into_response(),
    };
    if !state.torrents.read().await.contains_key(&id) {
        return (StatusCode::NOT_FOUND, "unknown torrent").into_response();
    }

    let key = format!("{id}/{file}");
    let dir = state.hls_root.join(format!("{id}_{file}"));
    let duration = {
        let mut jobs = state.hls.write().await;
        if let Some(job) = jobs.get(&key) {
            job.duration
        } else {
            let _ = std::fs::create_dir_all(&dir);
            let input = format!("http://127.0.0.1:{STREAM_PORT}/stream/{id}/{file}");
            match start_hls(&ffmpeg, state.ffprobe.as_deref(), &input, &key, &dir, state.transcode_errors.clone()).await {
                Ok((child, dur)) => {
                    jobs.insert(key.clone(), HlsJob { dir: dir.clone(), duration: dur, _child: child });
                    dur
                }
                Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("hls: {e:#}")).into_response(),
            }
        }
    };

    if duration > 0.5 {
        // Full VOD playlist: each segment is exactly HLS_SEG long (forced keyframes) except
        // the last. ENDLIST + known durations → the player shows the whole timeline upfront.
        let n = (duration / HLS_SEG).ceil() as usize;
        let mut m3u8 = String::from(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n",
        );
        for i in 0..n {
            let d = if i + 1 == n { (duration - (i as f64) * HLS_SEG).max(0.1) } else { HLS_SEG };
            m3u8.push_str(&format!("#EXTINF:{d:.3},\nseg{i:05}.ts{tk_suffix}\n"));
        }
        m3u8.push_str("#EXT-X-ENDLIST\n");
        return (
            [
                (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            m3u8,
        )
            .into_response();
    }

    // Unknown duration → fall back to ffmpeg's own (growing) playlist once it exists.
    let ff = dir.join("ff.m3u8");
    for _ in 0..150 {
        if let Ok(content) = std::fs::read_to_string(&ff) {
            if content.contains(".ts") {
                let body = if tk_suffix.is_empty() {
                    content
                } else {
                    content
                        .lines()
                        .map(|l| if l.ends_with(".ts") { format!("{l}{tk_suffix}") } else { l.to_string() })
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                return (
                    [
                        (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                        (header::CACHE_CONTROL, "no-store"),
                    ],
                    body,
                )
                    .into_response();
            }
        }
        if let Some(err) = state.transcode_errors.read().await.get(&id).cloned() {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("transcode failed: {err}")).into_response();
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    (StatusCode::SERVICE_UNAVAILABLE, "still preparing").into_response()
}

/// Serve one HLS segment, waiting if ffmpeg hasn't transcoded that far yet (sequential).
async fn hls_segment_handler(
    AxPath((id, file, seg)): AxPath<(String, usize, String)>,
    AxState(state): AxState<ServerState>,
) -> Response {
    if !seg.ends_with(".ts") || seg.contains('/') || seg.contains("..") {
        return (StatusCode::BAD_REQUEST, "bad segment").into_response();
    }
    let path = state.hls_root.join(format!("{id}_{file}")).join(&seg);
    for _ in 0..300 {
        if let Ok(bytes) = tokio::fs::read(&path).await {
            if !bytes.is_empty() {
                return ([(header::CONTENT_TYPE, "video/mp2t")], bytes).into_response();
            }
        }
        if state.transcode_errors.read().await.contains_key(&id) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    (StatusCode::NOT_FOUND, "segment not ready").into_response()
}

// ---- local-file HLS (Library playback of formats WKWebView can't decode, e.g. .mkv) ----
// Finished local files are normally served raw at /file/{relpath}; video the webview can't
// decode is transcoded on the fly here, reusing the same ffmpeg→HLS machinery as torrent
// streaming. The token is the hex-encoded relative path under the download root.

/// True if a finished local file should play via on-the-fly HLS transcode rather than raw
/// bytes — i.e. it's video in a container the macOS webview can't decode (anything but
/// mp4/m4v/webm/mov: mkv, avi, ts, …). Audio and web-native video are served direct.
pub fn local_transcodes(name: &str) -> bool {
    media_kind(name) == "video" && !is_web_native(name)
}

/// URL-safe token for a relative library path (hex of its bytes), used in /localhls URLs.
pub fn hls_token(relpath: &str) -> String {
    relpath.as_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Option<String> {
    if s.is_empty() || s.len() % 2 != 0 {
        return None;
    }
    let b = s.as_bytes();
    let mut bytes = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < b.len() {
        let hi = (b[i] as char).to_digit(16)?;
        let lo = (b[i + 1] as char).to_digit(16)?;
        bytes.push((hi * 16 + lo) as u8);
        i += 2;
    }
    String::from_utf8(bytes).ok()
}

/// Stable per-run hash of the token → a short, filesystem-safe scratch-dir name.
fn stable_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

async fn local_hls_playlist_handler(
    AxPath(token): AxPath<String>,
    axum::extract::RawQuery(query): axum::extract::RawQuery,
    AxState(state): AxState<ServerState>,
) -> Response {
    let tk_suffix = query
        .as_deref()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("tk=")))
        .map(|t| format!("?tk={t}"))
        .unwrap_or_default();
    let ffmpeg = match &state.ffmpeg {
        Some(p) => p.clone(),
        None => return (StatusCode::NOT_IMPLEMENTED, "ffmpeg not installed").into_response(),
    };
    let rel = match hex_decode(&token) {
        Some(r) if !r.contains("..") => r,
        _ => return (StatusCode::BAD_REQUEST, "bad token").into_response(),
    };
    let abs = state.download_dir.join(&rel);
    if !tokio::fs::metadata(&abs).await.map(|m| m.is_file()).unwrap_or(false) {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let key = format!("local:{token}");
    let dir = state.hls_root.join(format!("local_{:016x}", stable_hash(&token)));
    let duration = {
        let mut jobs = state.hls.write().await;
        if let Some(job) = jobs.get(&key) {
            job.duration
        } else {
            let _ = std::fs::create_dir_all(&dir);
            let input = abs.to_string_lossy().to_string();
            match start_hls(&ffmpeg, state.ffprobe.as_deref(), &input, &key, &dir, state.transcode_errors.clone()).await {
                Ok((child, dur)) => {
                    jobs.insert(key.clone(), HlsJob { dir: dir.clone(), duration: dur, _child: child });
                    dur
                }
                Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("hls: {e:#}")).into_response(),
            }
        }
    };

    if duration > 0.5 {
        let n = (duration / HLS_SEG).ceil() as usize;
        let mut m3u8 = String::from(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n",
        );
        for i in 0..n {
            let d = if i + 1 == n { (duration - (i as f64) * HLS_SEG).max(0.1) } else { HLS_SEG };
            m3u8.push_str(&format!("#EXTINF:{d:.3},\nseg{i:05}.ts{tk_suffix}\n"));
        }
        m3u8.push_str("#EXT-X-ENDLIST\n");
        return (
            [
                (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            m3u8,
        )
            .into_response();
    }

    let ff = dir.join("ff.m3u8");
    for _ in 0..150 {
        if let Ok(content) = std::fs::read_to_string(&ff) {
            if content.contains(".ts") {
                let body = if tk_suffix.is_empty() {
                    content
                } else {
                    content
                        .lines()
                        .map(|l| if l.ends_with(".ts") { format!("{l}{tk_suffix}") } else { l.to_string() })
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                return (
                    [
                        (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                        (header::CACHE_CONTROL, "no-store"),
                    ],
                    body,
                )
                    .into_response();
            }
        }
        if let Some(err) = state.transcode_errors.read().await.get(&key).cloned() {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("transcode failed: {err}")).into_response();
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    (StatusCode::SERVICE_UNAVAILABLE, "still preparing").into_response()
}

async fn local_hls_segment_handler(
    AxPath((token, seg)): AxPath<(String, String)>,
    AxState(state): AxState<ServerState>,
) -> Response {
    if !seg.ends_with(".ts") || seg.contains('/') || seg.contains("..") {
        return (StatusCode::BAD_REQUEST, "bad segment").into_response();
    }
    let key = format!("local:{token}");
    let path = state
        .hls_root
        .join(format!("local_{:016x}", stable_hash(&token)))
        .join(&seg);
    for _ in 0..300 {
        if let Ok(bytes) = tokio::fs::read(&path).await {
            if !bytes.is_empty() {
                return ([(header::CONTENT_TYPE, "video/mp2t")], bytes).into_response();
            }
        }
        if state.transcode_errors.read().await.contains_key(&key) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    (StatusCode::NOT_FOUND, "segment not ready").into_response()
}

/// Serve a cached poster from the artwork library. Files are stored by infohash
/// with no extension; the content type is sniffed from the leading magic bytes.
async fn art_handler(
    AxPath(id): AxPath<String>,
    AxState(state): AxState<ServerState>,
) -> Response {
    if id.contains('/') || id.contains("..") {
        return (StatusCode::BAD_REQUEST, "bad id").into_response();
    }
    let path = state.art_dir.join(&id);
    match tokio::fs::read(&path).await {
        Ok(bytes) if !bytes.is_empty() => {
            let ct = match bytes.as_slice() {
                [0x89, 0x50, ..] => "image/png",
                [0x47, 0x49, 0x46, ..] => "image/gif",
                [0x52, 0x49, 0x46, 0x46, ..] => "image/webp",
                _ => "image/jpeg",
            };
            (
                [
                    (header::CONTENT_TYPE, ct),
                    (header::CACHE_CONTROL, "public, max-age=86400"),
                ],
                bytes,
            )
                .into_response()
        }
        _ => (StatusCode::NOT_FOUND, "no artwork").into_response(),
    }
}

/// Only these hosts may be fetched through the /img cache, so it can't be abused as an open
/// proxy. They're the artwork sources the app already loads posters/album covers from.
fn is_cacheable_image_host(url: &str) -> bool {
    let u = url.to_lowercase();
    if !u.starts_with("https://") {
        return false;
    }
    let host = u
        .trim_start_matches("https://")
        .split(['/', '?'])
        .next()
        .unwrap_or("");
    host == "theblackpearl.tv"
        || host == "covers.openlibrary.org"
        || host.ends_with(".mzstatic.com") // iTunes / Apple Music album art
        || host == "image.tmdb.org"
}

/// Stable 64-bit content address for a URL (deterministic across runs — DefaultHasher uses
/// fixed keys), used as the cache filename. Collisions only mis-serve one poster, which is fine.
fn img_cache_key(url: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn image_bytes_response(bytes: Vec<u8>) -> Response {
    let ct = match bytes.as_slice() {
        [0x89, 0x50, ..] => "image/png",
        [0x47, 0x49, 0x46, ..] => "image/gif",
        [0x52, 0x49, 0x46, 0x46, ..] => "image/webp",
        _ => "image/jpeg",
    };
    (
        [
            (header::CONTENT_TYPE, ct),
            // Content-addressed → safe to cache hard; the webview won't re-request the same URL.
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
    )
        .into_response()
}

/// Local on-disk image cache: `GET /img?u=<percent-encoded https URL>`. Serves the bytes from a
/// content-addressed cache (so repeat browses + relaunches don't re-hit the relay), fetching +
/// caching on a miss. Local-only (the auth middleware denies non-loopback callers) and limited to
/// known artwork hosts, so it can't be used as an open fetch proxy.
async fn img_handler(
    axum::extract::RawQuery(query): axum::extract::RawQuery,
    AxState(state): AxState<ServerState>,
) -> Response {
    let url = query
        .as_deref()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("u=")))
        .map(urldecode)
        .unwrap_or_default();
    if !is_cacheable_image_host(&url) {
        return (StatusCode::BAD_REQUEST, "host not allowed").into_response();
    }
    let dir = state.art_dir.join("imgcache");
    let path = dir.join(img_cache_key(&url));
    if let Ok(bytes) = tokio::fs::read(&path).await {
        if !bytes.is_empty() {
            return image_bytes_response(bytes); // cache hit
        }
    }
    match state.http.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => match resp.bytes().await {
            Ok(b) if b.len() > 256 => {
                let _ = tokio::fs::create_dir_all(&dir).await;
                let _ = tokio::fs::write(&path, &b).await;
                image_bytes_response(b.to_vec())
            }
            _ => (StatusCode::BAD_GATEWAY, "empty image").into_response(),
        },
        Ok(resp) => (
            StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            "upstream error",
        )
            .into_response(),
        Err(_) => (StatusCode::BAD_GATEWAY, "fetch failed").into_response(),
    }
}

/// Serve a finished file from the download root (HTTP Range), so the Library can play
/// locally-downloaded content even after the torrent has left the session. The path is
/// relative to `download_dir`; `..` is rejected to keep it confined to that root.
async fn file_handler(
    AxPath(relpath): AxPath<String>,
    headers: HeaderMap,
    AxState(state): AxState<ServerState>,
) -> Response {
    if relpath.contains("..") {
        return (StatusCode::BAD_REQUEST, "bad path").into_response();
    }
    let path = state.download_dir.join(&relpath);
    let total = match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => m.len(),
        _ => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return (StatusCode::NOT_FOUND, "open failed").into_response(),
    };
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|r| parse_range(r, total));
    let (start, end) = range.unwrap_or((0, total.saturating_sub(1)));
    if total == 0 || start > end || start >= total {
        return (
            StatusCode::RANGE_NOT_SATISFIABLE,
            [(header::CONTENT_RANGE, format!("bytes */{total}"))],
        )
            .into_response();
    }
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "seek failed").into_response();
    }
    let len = end - start + 1;
    let body = Body::from_stream(ReaderStream::new(file.take(len)));
    let status = if range.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, content_type_for(&relpath))
        .header(header::CONTENT_LENGTH, len.to_string());
    if range.is_some() {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"));
    }
    builder.body(body).unwrap().into_response()
}

/// Best-effort content type from a file's extension (covers the formats WKWebView plays).
fn content_type_for(name: &str) -> &'static str {
    match name.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("mp4") | Some("m4v") | Some("mov") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("m4a") | Some("aac") => "audio/mp4",
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("wav") => "audio/wav",
        Some("ogg") | Some("oga") => "audio/ogg",
        _ => "application/octet-stream",
    }
}

// ---- subtitles (served as WebVTT for the player's <track> elements) ----

fn file_ext(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default()
}

fn video_count(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|es| {
            es.flatten()
                .filter(|e| e.path().file_name().and_then(|n| n.to_str()).map(|n| media_kind(n) == "video").unwrap_or(false))
                .count()
        })
        .unwrap_or(0)
}

/// Pull a 2–3 letter language code off a subtitle filename stem ("movie.en" → "en").
fn sub_lang(stem: &str) -> String {
    if let Some(last) = stem.rsplit('.').next() {
        if (2..=3).contains(&last.len()) && last.chars().all(|c| c.is_ascii_alphabetic()) && last != stem {
            return last.to_lowercase();
        }
    }
    String::new()
}

fn lang_label(lang: &str) -> String {
    let name = match lang.to_lowercase().as_str() {
        "en" | "eng" => "English",
        "es" | "spa" => "Spanish",
        "fr" | "fra" | "fre" => "French",
        "de" | "ger" | "deu" => "German",
        "it" | "ita" => "Italian",
        "pt" | "por" => "Portuguese",
        "ja" | "jpn" => "Japanese",
        "ko" | "kor" => "Korean",
        "zh" | "chi" | "zho" => "Chinese",
        "ru" | "rus" => "Russian",
        "ar" | "ara" => "Arabic",
        "nl" | "dut" | "nld" => "Dutch",
        "sv" | "swe" => "Swedish",
        "pl" | "pol" => "Polish",
        "" => "Subtitles",
        other => return other.to_uppercase(),
    };
    name.to_string()
}

fn sub_label(stem: &str, lang: &str) -> String {
    if !lang.is_empty() {
        lang_label(lang)
    } else {
        // Last path component (no ext) as a friendly-ish label.
        let base = stem.rsplit('/').next().unwrap_or(stem);
        if base.is_empty() { "Subtitles".to_string() } else { base.to_string() }
    }
}

/// Minimal SRT → WebVTT: prepend the header and turn the `,` in timestamp lines into `.`.
/// Cue numbers and text pass through unchanged (WebVTT tolerates both).
fn srt_to_vtt(srt: &str) -> String {
    let srt = srt.trim_start_matches('\u{feff}'); // strip BOM
    let mut out = String::with_capacity(srt.len() + 16);
    out.push_str("WEBVTT\n\n");
    for line in srt.lines() {
        if line.contains("-->") {
            out.push_str(&line.replace(',', "."));
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

fn vtt_response(vtt: String) -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/vtt; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        vtt,
    )
        .into_response()
}

/// Run ffmpeg to convert a subtitle to WebVTT on stdout. `sub_idx` picks an embedded
/// subtitle stream (`0:s:{idx}`); `None` converts a standalone subtitle file (e.g. .ass).
async fn ffmpeg_to_vtt(ffmpeg: &Path, path: &Path, sub_idx: Option<usize>) -> Option<String> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-i"]).arg(path);
    let map;
    if let Some(i) = sub_idx {
        map = format!("0:s:{i}");
        cmd.args(["-map", &map]);
    }
    cmd.args(["-f", "webvtt", "-"]);
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let vtt = String::from_utf8_lossy(&out.stdout).to_string();
    (!vtt.trim().is_empty()).then_some(vtt)
}

/// ffprobe a container for text-based subtitle streams → (subtitle-relative index, lang, title).
async fn probe_subtitle_streams(ffprobe: &Path, path: &Path) -> Vec<(usize, String, String)> {
    let out = tokio::process::Command::new(ffprobe)
        .args([
            "-v", "error",
            "-select_streams", "s",
            "-show_entries", "stream=codec_name:stream_tags=language,title",
            "-of", "json",
        ])
        .arg(path)
        .output()
        .await;
    let Ok(o) = out else { return Vec::new() };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&o.stdout) else { return Vec::new() };
    let mut res = Vec::new();
    if let Some(streams) = v["streams"].as_array() {
        for (n, st) in streams.iter().enumerate() {
            let codec = st["codec_name"].as_str().unwrap_or("");
            // Only text-based subs can become WebVTT; skip image subs (pgs/dvdsub/dvbsub).
            if !matches!(codec, "subrip" | "srt" | "ass" | "ssa" | "mov_text" | "webvtt" | "text" | "stl" | "eia_608" | "subviewer") {
                continue;
            }
            let lang = st["tags"]["language"].as_str().unwrap_or("").to_string();
            let title = st["tags"]["title"].as_str().unwrap_or("").to_string();
            res.push((n, lang, title));
        }
    }
    res
}

/// Serve a sidecar subtitle file (`/subs/file/{hex-relpath}`) as WebVTT — .vtt passes
/// through, .srt is converted in-process, .ass/.ssa go through ffmpeg.
async fn subs_file_handler(
    AxPath(token): AxPath<String>,
    AxState(state): AxState<ServerState>,
) -> Response {
    let rel = match hex_decode(&token) {
        Some(r) if !r.contains("..") => r,
        _ => return (StatusCode::BAD_REQUEST, "bad token").into_response(),
    };
    let path = state.download_dir.join(&rel);
    let ext = file_ext(&path);
    let vtt = match ext.as_str() {
        "vtt" => match tokio::fs::read(&path).await {
            Ok(b) => String::from_utf8_lossy(&b).to_string(),
            Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
        },
        "srt" => match tokio::fs::read(&path).await {
            Ok(b) => srt_to_vtt(&String::from_utf8_lossy(&b)),
            Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
        },
        "ass" | "ssa" => match &state.ffmpeg {
            Some(ff) => match ffmpeg_to_vtt(ff, &path, None).await {
                Some(v) => v,
                None => return (StatusCode::INTERNAL_SERVER_ERROR, "convert failed").into_response(),
            },
            None => return (StatusCode::NOT_IMPLEMENTED, "ffmpeg required for .ass").into_response(),
        },
        _ => return (StatusCode::BAD_REQUEST, "unsupported subtitle").into_response(),
    };
    vtt_response(vtt)
}

/// Extract an embedded subtitle stream (`/subs/embed/{hex-relpath}/{idx}.vtt`) to WebVTT
/// via ffmpeg.
async fn subs_embed_handler(
    AxPath((token, name)): AxPath<(String, String)>,
    AxState(state): AxState<ServerState>,
) -> Response {
    let ffmpeg = match &state.ffmpeg {
        Some(f) => f.clone(),
        None => return (StatusCode::NOT_IMPLEMENTED, "ffmpeg not installed").into_response(),
    };
    let idx: usize = match name.strip_suffix(".vtt").and_then(|s| s.parse().ok()) {
        Some(i) => i,
        None => return (StatusCode::BAD_REQUEST, "bad stream").into_response(),
    };
    let rel = match hex_decode(&token) {
        Some(r) if !r.contains("..") => r,
        _ => return (StatusCode::BAD_REQUEST, "bad token").into_response(),
    };
    let path = state.download_dir.join(&rel);
    if !tokio::fs::metadata(&path).await.map(|m| m.is_file()).unwrap_or(false) {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    match ffmpeg_to_vtt(&ffmpeg, &path, Some(idx)).await {
        Some(vtt) => vtt_response(vtt),
        None => (StatusCode::INTERNAL_SERVER_ERROR, "subtitle extract failed").into_response(),
    }
}

/// Spawn ffmpeg to write HLS segments into `dir`, reading from our own /stream endpoint
/// so it transcodes while the torrent downloads. Video is re-encoded to H.264 (hardware
/// on macOS) with a forced keyframe every HLS_SEG seconds → uniform, independently
/// seekable segments. Returns the child + source duration (for the VOD playlist).
async fn start_hls(
    ffmpeg: &Path,
    ffprobe: Option<&Path>,
    input: &str,
    err_key: &str,
    dir: &Path,
    errors: TranscodeErrors,
) -> Result<(tokio::process::Child, f64)> {
    let (vcodec, acodec, duration, height) =
        tokio::time::timeout(Duration::from_secs(25), hls_probe(ffprobe, input))
            .await
            .unwrap_or((None, None, 0.0, 0));
    // Already-H.264 video can be stream-copied into the HLS segments — no re-encode, so a
    // file whose only problem is its audio (e.g. an H.264 + AC-3 mp4) "converts" instantly.
    // Anything else (HEVC/VP9/AV1/MPEG-4…) is re-encoded to H.264 via VideoToolbox.
    let vcopy = matches!(vcodec.as_deref(), Some("h264") | Some("avc1"));
    let acopy = matches!(acodec.as_deref(), Some("aac"));
    let vbitrate = match height {
        0..=480 => "2500k",
        481..=720 => "5000k",
        721..=1080 => "8000k",
        _ => "14000k",
    };

    // Build the HLS transcode command for a given H.264 video encoder. Hardware (VideoToolbox)
    // is tried first for speed; if it rejects the input outright we retry with the universal
    // software encoder (libx264) so the file still converts.
    let build = |vencoder: &str| {
        let mut cmd = tokio::process::Command::new(ffmpeg);
        // Robust input handling: regenerate broken/missing presentation timestamps (common in
        // AVIs, raw TS, and partially-downloaded files) so the mux doesn't abort, drop corrupt
        // packets instead of dying on them, and probe deeper so a file whose stream headers
        // arrive late is still demuxed.
        cmd.args([
            "-hide_banner", "-loglevel", "error",
            "-fflags", "+genpts+discardcorrupt",
            "-err_detect", "ignore_err",
            "-analyzeduration", "30M", "-probesize", "30M",
            "-i", input,
        ]);
        // `0:V:0` = first REAL video stream — skips an embedded cover-art / thumbnail mjpeg that
        // `0:v:0` would wrongly select as "the video" (a common cause of a black/failed
        // transcode). Drop subtitle + data streams so an odd one can't break the HLS mux. `?`
        // tolerates a file with no real video stream (transcode the audio instead of failing).
        cmd.args(["-map", "0:V:0?", "-map", "0:a:0?", "-sn", "-dn"]);
        if vcopy {
            cmd.args(["-c:v", "copy"]);
        } else if vencoder == "h264_videotoolbox" {
            cmd.args([
                "-c:v", "h264_videotoolbox",
                "-b:v", vbitrate,
                // Let VideoToolbox fall back to its software encoder for inputs the hardware
                // path rejects (odd dimensions, some 10-bit/HDR sources) instead of erroring.
                "-allow_sw", "1",
                "-force_key_frames", "expr:gte(t,n_forced*4)",
                "-pix_fmt", "yuv420p",
            ]);
        } else {
            cmd.args([
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "21",
                "-force_key_frames", "expr:gte(t,n_forced*4)",
                "-pix_fmt", "yuv420p",
            ]);
        }
        if acopy {
            cmd.args(["-c:a", "copy"]);
        } else {
            cmd.args(["-c:a", "aac", "-b:a", "192k", "-ac", "2"]);
        }
        cmd.args([
            "-f", "hls",
            "-hls_time", "4",
            "-hls_list_size", "0",
            "-hls_segment_type", "mpegts",
            "-hls_flags", "independent_segments+temp_file",
        ]);
        cmd.arg("-hls_segment_filename").arg(dir.join("seg%05d.ts"));
        cmd.arg(dir.join("ff.m3u8"));
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::piped());
        cmd.kill_on_drop(true);
        cmd
    };

    let child = match spawn_hls_checked(build("h264_videotoolbox"), dir, &errors, err_key).await {
        Ok(c) => c,
        // Hardware encoder rejected the input within the first moment — wipe the half-written
        // playlist and retry with the universal software encoder so the file still plays.
        Err(_) if !vcopy => {
            let _ = std::fs::remove_dir_all(dir);
            let _ = std::fs::create_dir_all(dir);
            spawn_hls_checked(build("libx264"), dir, &errors, err_key).await?
        }
        Err(e) => return Err(e),
    };
    Ok((child, duration))
}

/// Spawn an ffmpeg HLS transcode and resolve as soon as the outcome is known: success the instant
/// the first segment lands (the common path — no waiting on a fixed timer), or Err the instant
/// ffmpeg exits non-zero (the encoder rejected the input) so the caller can retry with a different
/// encoder. Then attaches the long-lived stderr reader that records the final error, if any.
async fn spawn_hls_checked(
    mut cmd: tokio::process::Command,
    dir: &Path,
    errors: &TranscodeErrors,
    err_key: &str,
) -> Result<tokio::process::Child> {
    let mut child = cmd.spawn().context("spawning ffmpeg (hls)")?;
    let mut stderr = child.stderr.take();
    // Poll for the decisive event instead of always sleeping a fixed window: the first segment
    // appearing (it's working) or ffmpeg exiting. Cap the wait so a slow-to-start-but-healthy
    // transcode still returns and lets the playlist handler take over.
    let seg0 = dir.join("seg00000.ts");
    let start = std::time::Instant::now();
    loop {
        if seg0.exists() {
            break; // first segment written → the encoder accepted the input and is producing
        }
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => {
                let mut log = String::new();
                if let Some(mut e) = stderr.take() {
                    let _ = e.read_to_string(&mut log).await;
                }
                let last = log.trim().lines().last().unwrap_or("ffmpeg failed").to_string();
                errors.write().await.insert(err_key.to_string(), last.clone());
                return Err(anyhow!(last));
            }
            Ok(Some(_)) => break, // exited 0 (e.g. a very short clip) — segments are on disk
            _ => {}
        }
        if start.elapsed() >= Duration::from_millis(2500) {
            break; // still running, no segment yet — assume healthy and hand off
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if let Some(mut e) = stderr {
        let err_id = err_key.to_string();
        let errors = errors.clone();
        tauri::async_runtime::spawn(async move {
            let mut log = String::new();
            let _ = e.read_to_string(&mut log).await; // returns when ffmpeg exits
            let mut map = errors.write().await;
            if log.trim().is_empty() {
                map.remove(&err_id);
            } else {
                map.insert(err_id, log.trim().lines().last().unwrap_or("ffmpeg failed").to_string());
            }
        });
    }
    Ok(child)
}

/// Probe video/audio codecs, duration, and video height in one ffprobe call.
async fn hls_probe(ffprobe: Option<&Path>, input: &str) -> (Option<String>, Option<String>, f64, u32) {
    let Some(p) = ffprobe else {
        return (None, None, 0.0, 0);
    };
    let out = tokio::process::Command::new(p)
        .args([
            "-v", "error",
            "-show_entries", "format=duration:stream=codec_type,codec_name,height",
            "-of", "json",
            input,
        ])
        .output()
        .await;
    let Ok(o) = out else {
        return (None, None, 0.0, 0);
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&o.stdout) else {
        return (None, None, 0.0, 0);
    };
    let duration = v["format"]["duration"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    let (mut vc, mut ac, mut h) = (None, None, 0u32);
    if let Some(streams) = v["streams"].as_array() {
        for st in streams {
            match st["codec_type"].as_str() {
                Some("video") if vc.is_none() => {
                    vc = st["codec_name"].as_str().map(|s| s.to_string());
                    h = st["height"].as_u64().unwrap_or(0) as u32;
                }
                Some("audio") if ac.is_none() => ac = st["codec_name"].as_str().map(|s| s.to_string()),
                _ => {}
            }
        }
    }
    (vc, ac, duration, h)
}

/// Parse a single `bytes=start-end` range against a known total length.
fn parse_range(h: &str, total: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?;
    let (s, e) = spec.split_once('-')?;
    let last = total.saturating_sub(1);
    let (start, end) = if s.is_empty() {
        // suffix range: bytes=-N → last N bytes
        let n: u64 = e.parse().ok()?;
        (total.saturating_sub(n), last)
    } else {
        let start: u64 = s.parse().ok()?;
        let end: u64 = if e.is_empty() { last } else { e.parse().ok()? };
        (start, end.min(last))
    };
    Some((start, end))
}

fn infohash_from_magnet(magnet: &str) -> Option<String> {
    let query = magnet.split_once('?')?.1;
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix("xt=urn:btih:"))
        .map(|h| h.to_ascii_lowercase())
}

fn magnet_title(magnet: &str) -> Option<String> {
    let query = magnet.split_once('?')?.1;
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix("dn="))
        .map(urldecode)
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(v) => {
                    out.push(v);
                    i += 3;
                }
                Err(_) => {
                    out.push(bytes[i]);
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::pick_queue_releases;
    use std::time::{Duration, Instant};

    #[test]
    fn queue_releases_up_to_free_slots_only() {
        let now = Instant::now();
        let q = || vec![
            ("a".to_string(), now),
            ("b".to_string(), now + Duration::from_secs(1)),
            ("c".to_string(), now + Duration::from_secs(2)),
        ];
        // One-at-a-time, nothing active → exactly one starts.
        assert_eq!(pick_queue_releases(0, 1, q()).len(), 1);
        // A download is already active → nothing else starts.
        assert!(pick_queue_releases(1, 1, q()).is_empty());
        // Two slots free → two start.
        assert_eq!(pick_queue_releases(0, 2, q()).len(), 2);
        // Over capacity (more active than max) → none.
        assert!(pick_queue_releases(5, 1, q()).is_empty());
    }

    #[test]
    fn queue_releases_oldest_first() {
        let now = Instant::now();
        // Deliberately out of order; the oldest (a) must come out first.
        let queued = vec![
            ("c".to_string(), now + Duration::from_secs(2)),
            ("a".to_string(), now),
            ("b".to_string(), now + Duration::from_secs(1)),
        ];
        assert_eq!(pick_queue_releases(0, 2, queued), vec!["a".to_string(), "b".to_string()]);
    }
}
