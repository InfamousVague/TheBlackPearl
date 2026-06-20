pub mod ai;
pub mod anime;
mod artwork;
pub mod catalog;
mod devices;
pub mod discover;
mod engine;
pub mod enrich;
mod export;
pub mod indexer;
mod metadata;
pub mod music;
mod organize;
pub mod playlist;
pub mod posters;
mod safety;
mod social;
mod subtitles;
mod remote;
mod remux;
mod update_p2p;
mod spotify;
mod trending;
pub mod tvmaze;

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{
    extract::{Path as AxumPath, Query, State as AxumState},
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use catalog::{Catalog, CatalogItem, LibraryFileRow, Source};
use engine::{DownloadStats, Engine, MediaInfo};
use rayon::prelude::*;
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

/// A current Safari UA so Cloudflare-protected sites serve the normal page in the
/// embedded browser (and so any cf_clearance cookie stays valid for this engine).
const BROWSER_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15";
const VERIFY_LABEL: &str = "ghosty-verify";
const SPOTIFLAC_OUTPUT_EVENT: &str = "spotiflac://output";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppInfo {
    pub(crate) download_dir: String,
    pub(crate) data_dir: String,
    pub(crate) ffmpeg_available: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VpnStatus {
    active: bool,
    interface: String,
}

/// Heuristic VPN detection: a full-tunnel VPN routes the default route through a
/// tunnel interface (utun/ipsec/ppp/…) rather than physical en0/Wi-Fi. Local-only,
/// no external calls.
#[tauri::command]
fn vpn_status() -> VpnStatus {
    let interface = default_route_interface();
    let prefix: String = interface.chars().take_while(|c| !c.is_ascii_digit()).collect();
    let active = matches!(prefix.as_str(), "utun" | "tun" | "tap" | "ppp" | "ipsec" | "wg" | "gpd");
    VpnStatus { active, interface }
}

#[cfg(target_os = "macos")]
fn default_route_interface() -> String {
    std::process::Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.trim().strip_prefix("interface:").map(|x| x.trim().to_string()))
        })
        .unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn default_route_interface() -> String {
    String::new()
}

/// Watch for the VPN dropping while the app is open and trip a kill-switch. We only arm once
/// the VPN has been seen ACTIVE during this session, so launching WITHOUT a VPN never warns —
/// only an active→inactive transition (the VPN switching off mid-session) fires. On a drop we
/// halt all download traffic and emit `vpn://dropped` so the UI can warn the user.
fn spawn_vpn_monitor(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Baseline: whether a VPN was already up at launch. If so, a later drop is armed; if
        // not, the kill-switch only arms after the user turns a VPN on (then off) while open.
        let mut prev_active = vpn_status().active;
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        tick.tick().await; // consume the immediate first tick
        loop {
            tick.tick().await;
            // Run the (blocking) `route` probe off the async runtime thread.
            let status = tauri::async_runtime::spawn_blocking(vpn_status)
                .await
                .unwrap_or(VpnStatus { active: prev_active, interface: String::new() });
            if prev_active && !status.active {
                // VPN dropped mid-session: halt all traffic, then warn the UI.
                if let Some(engine) = app.try_state::<Engine>() {
                    engine.pause_all_network().await;
                }
                let _ = app.emit("vpn://dropped", &status);
            }
            prev_active = status.active;
        }
    });
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_s() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---- streaming engine commands ----

/// Fetch the torrent engine, or a friendly "still starting" error. The engine is brought up
/// off the launch thread (see `setup`) so the window appears instantly; a command fired in the
/// first moment after launch — before `Engine::start` finishes restoring the persisted session
/// — gets this Err instead of panicking on un-managed State.
fn app_engine(app: &tauri::AppHandle) -> Option<tauri::State<'_, Engine>> {
    use tauri::Manager;
    app.try_state::<Engine>()
}
fn engine_state(app: &tauri::AppHandle) -> Result<tauri::State<'_, Engine>, String> {
    app_engine(app)
        .ok_or_else(|| "The download engine is still starting — try again in a moment.".to_string())
}

#[tauri::command]
async fn add_torrent(app: tauri::AppHandle, magnet: String, queue: Option<bool>, peers: Option<Vec<String>>) -> Result<String, String> {
    // queue=true enqueues a download (one-at-a-time); the default (false) streams immediately.
    // `peers` are seeder socket addresses carried by a friend's share, so we dial them directly
    // instead of waiting on DHT — that's what makes a friend-to-friend transfer actually start.
    let initial_peers: Vec<std::net::SocketAddr> = peers
        .unwrap_or_default()
        .iter()
        .filter_map(|p| p.parse().ok())
        .collect();
    engine_state(&app)?.add(&magnet, queue.unwrap_or(false), initial_peers).await.map_err(|e| format!("{e:#}"))
}

/// PIN + LAN address to show on the host so a client can link to it.
#[derive(serde::Serialize)]
struct PairingInfo {
    pin: String,
    address: String,
}

/// Generate a fresh PIN for linking another device (the iPad) to this host over the LAN.
/// The host UI shows the PIN + this Mac's address; the client enters them at `POST /api/pair`.
#[tauri::command]
async fn pairing_pin(app: tauri::AppHandle) -> Result<PairingInfo, String> {
    let pin = engine_state(&app)?.offer_pairing_pin().await;
    let ip = remote::local_ip().unwrap_or_else(|| "your-mac-ip".to_string());
    Ok(PairingInfo {
        pin,
        address: format!("{ip}:{}", engine::STREAM_PORT),
    })
}

#[tauri::command]
async fn stream_url(
    app: tauri::AppHandle,
    id: String,
    file_idx: Option<usize>,
) -> Result<String, String> {
    engine_state(&app)?.stream_url(&id, file_idx).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn torrent_stats(app: tauri::AppHandle, id: String) -> Result<DownloadStats, String> {
    engine_state(&app)?.stats_for(&id).await.ok_or_else(|| "unknown torrent".to_string())
}

#[tauri::command]
async fn list_downloads(app: tauri::AppHandle) -> Result<Vec<DownloadStats>, String> {
    // Before the engine has finished starting there are simply no active transfers yet.
    match app_engine(&app) {
        Some(engine) => Ok(engine.snapshot().await),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
async fn media_info(app: tauri::AppHandle, id: String) -> Result<MediaInfo, String> {
    engine_state(&app)?.media_info(&id).await.map_err(|e| format!("{e:#}"))
}

/// Subtitle tracks (sidecar files + embedded streams) for a local video, by its relative
/// path under the download folder. Served as WebVTT for the player's <track> elements.
#[tauri::command]
async fn list_subtitles(
    app: tauri::AppHandle,
    rel: String,
) -> Result<Vec<engine::SubTrack>, String> {
    match app_engine(&app) {
        Some(engine) => Ok(engine.list_subtitles(&rel).await),
        None => Ok(Vec::new()),
    }
}

/// Fetch a subtitle for a video that has none, free + keyless from OpenSubtitles. Saves it
/// next to the file and returns the refreshed track list.
#[tauri::command]
async fn fetch_subtitles(
    app: tauri::AppHandle,
    rel: String,
    title: String,
    season: Option<i64>,
    episode: Option<i64>,
    lang: Option<String>,
) -> Result<Vec<engine::SubTrack>, String> {
    engine_state(&app)?
        .fetch_subtitles(&rel, &title, season, episode, lang.as_deref().unwrap_or("eng"))
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn remove_torrent(
    app: tauri::AppHandle,
    id: String,
    delete_files: Option<bool>,
) -> Result<(), String> {
    engine_state(&app)?.remove(&id, delete_files.unwrap_or(false)).await.map_err(|e| format!("{e:#}"))
}

/// Create a `.torrent` from a local file/folder (optionally writing it to `save_path`) and
/// start seeding it from the user's own machine. Purely local — nothing is uploaded to any
/// GhostWire server; the user shares the returned magnet / `.torrent` wherever they choose.
#[tauri::command]
async fn create_torrent(
    app: tauri::AppHandle,
    source_path: String,
    save_path: Option<String>,
    trackers: Option<Vec<String>>,
    start_seeding: Option<bool>,
) -> Result<engine::CreatedTorrent, String> {
    engine_state(&app)?
        .create_torrent(
            &source_path,
            save_path.as_deref(),
            trackers.unwrap_or_default(),
            start_seeding.unwrap_or(true),
        )
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Re-seed a previously created `.torrent` file by pointing it at the directory holding the
/// content; resolves to the torrent's infohash id.
#[tauri::command]
async fn seed_torrent(
    app: tauri::AppHandle,
    torrent_path: String,
    content_dir: String,
) -> Result<String, String> {
    engine_state(&app)?
        .seed_torrent(&torrent_path, &content_dir)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Share an item that's already downloaded to the library: create a fresh torrent from its
/// file/folder (`id` is the path relative to the download dir) and start seeding it so friends
/// can find it over the social P2P link. Returns the new share's infohash/magnet. Purely local
/// — nothing is uploaded to any GhostWire server.
#[tauri::command]
async fn share_library_item(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    id: String,
) -> Result<engine::CreatedTorrent, String> {
    let path = std::path::PathBuf::from(&info.download_dir).join(&id);
    if !path.exists() {
        return Err("That file is no longer on disk.".into());
    }
    let source = path.to_string_lossy().to_string();
    engine_state(&app)?
        .create_torrent(&source, None, Vec::new(), true)
        .await
        .map_err(|e| format!("{e:#}"))
}

// ---- social P2P (P1.2) commands ----
//
// The coordination server is a pure address-book + signaling relay — it never sees content or
// magnets. These commands manage the local Ed25519 identity, the follow graph, and live
// friend-to-friend search/browse (whose hits arrive as `social://*` events). Transfers still
// happen peer-to-peer over BitTorrent once the user grabs a returned magnet.

#[tauri::command]
async fn social_status(
    social: tauri::State<'_, social::Social>,
) -> Result<social::SocialStatus, String> {
    Ok(social.status().await)
}

#[tauri::command]
async fn social_register(
    app: tauri::AppHandle,
    social: tauri::State<'_, social::Social>,
    base_url: Option<String>,
    handle: String,
) -> Result<social::SocialStatus, String> {
    let base = base_url.unwrap_or_else(|| social::DEFAULT_BASE_URL.to_string());
    social
        .register(&app, &base, handle.trim())
        .await
        .map_err(|e| format!("{e:#}"))?;
    Ok(social.status().await)
}

#[tauri::command]
async fn social_login(
    app: tauri::AppHandle,
    social: tauri::State<'_, social::Social>,
    base_url: Option<String>,
) -> Result<social::SocialStatus, String> {
    let base = base_url.unwrap_or_else(|| social::DEFAULT_BASE_URL.to_string());
    social.login(&app, &base).await.map_err(|e| format!("{e:#}"))?;
    Ok(social.status().await)
}

#[tauri::command]
async fn social_disconnect(social: tauri::State<'_, social::Social>) -> Result<(), String> {
    social.disconnect().await;
    Ok(())
}

#[tauri::command]
async fn social_following(
    social: tauri::State<'_, social::Social>,
) -> Result<Vec<social::FriendPresence>, String> {
    social.following().await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn social_followers(
    social: tauri::State<'_, social::Social>,
) -> Result<Vec<social::FriendPresence>, String> {
    social.followers().await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn social_friends(
    social: tauri::State<'_, social::Social>,
) -> Result<Vec<social::FriendPresence>, String> {
    social.friends().await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn social_follow(
    social: tauri::State<'_, social::Social>,
    handle: String,
) -> Result<(), String> {
    social.follow(handle.trim()).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn social_unfollow(
    social: tauri::State<'_, social::Social>,
    handle: String,
) -> Result<(), String> {
    social.unfollow(handle.trim()).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn social_report(
    social: tauri::State<'_, social::Social>,
    handle: String,
    infohash: Option<String>,
    reason: String,
) -> Result<(), String> {
    social
        .report(handle.trim(), infohash.as_deref(), reason.trim())
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn social_search(
    social: tauri::State<'_, social::Social>,
    query: String,
) -> Result<String, String> {
    social.search(query.trim()).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn social_browse(
    social: tauri::State<'_, social::Social>,
    handle: String,
) -> Result<String, String> {
    social.browse(handle.trim()).await.map_err(|e| format!("{e:#}"))
}

// ---- catalog / source commands ----

#[tauri::command]
fn list_sources(catalog: tauri::State<'_, Catalog>) -> Result<Vec<Source>, String> {
    catalog.list_sources().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn add_source(
    catalog: tauri::State<'_, Catalog>,
    name: String,
    kind: String,
    url: String,
) -> Result<Source, String> {
    catalog.add_source(&name, &kind, &url).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn remove_source(catalog: tauri::State<'_, Catalog>, id: String) -> Result<(), String> {
    catalog.remove_source(&id).map_err(|e| format!("{e:#}"))
}

/// One source in a portable, shareable sources file (no per-install IDs or counts).
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourceExport {
    name: String,
    kind: String,
    url: String,
}

/// The on-disk format for a shareable GhostWire sources file.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourcesFile {
    /// Magic string so imports can reject unrelated JSON.
    format: String,
    version: u32,
    #[serde(default)]
    exported_at: i64,
    sources: Vec<SourceExport>,
}

const SOURCES_FILE_FORMAT: &str = "ghostwire.sources";
const VALID_SOURCE_KINDS: [&str; 4] = ["scraper", "adapter", "torznab", "webview"];

/// Outcome of importing a sources file, surfaced to the user.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SourcesImportResult {
    added: usize,
    skipped: usize,
    total: usize,
}

/// Write every configured source to `path` as a portable JSON file. Returns the count.
#[tauri::command]
fn export_sources(catalog: tauri::State<'_, Catalog>, path: String) -> Result<usize, String> {
    let sources = catalog.list_sources().map_err(|e| format!("{e:#}"))?;
    let exports: Vec<SourceExport> = sources
        .iter()
        .map(|s| SourceExport {
            name: s.name.clone(),
            kind: s.kind.clone(),
            url: s.url.clone(),
        })
        .collect();
    let count = exports.len();
    let file = SourcesFile {
        format: SOURCES_FILE_FORMAT.to_string(),
        version: 1,
        exported_at: now_unix_secs(),
        sources: exports,
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Couldn't write {path}: {e}"))?;
    Ok(count)
}

/// Read a sources file from `path` and add any new sources (dedup by URL). Existing
/// URLs and entries with an unknown kind are skipped, never overwritten.
#[tauri::command]
fn import_sources(
    catalog: tauri::State<'_, Catalog>,
    path: String,
) -> Result<SourcesImportResult, String> {
    let data =
        std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    let file: SourcesFile = serde_json::from_str(&data)
        .map_err(|_| "That file isn't a valid GhostWire sources file.".to_string())?;
    if file.format != SOURCES_FILE_FORMAT {
        return Err("That file isn't a GhostWire sources file.".to_string());
    }

    let existing_urls: std::collections::HashSet<String> = catalog
        .list_sources()
        .map_err(|e| format!("{e:#}"))?
        .into_iter()
        .map(|s| s.url.trim().to_lowercase())
        .collect();

    let total = file.sources.len();
    let mut added = 0;
    let mut skipped = 0;
    let mut seen = existing_urls;
    for src in file.sources {
        let url = src.url.trim();
        let kind = src.kind.trim();
        let name = src.name.trim();
        let key = url.to_lowercase();
        if url.is_empty() || name.is_empty() || !VALID_SOURCE_KINDS.contains(&kind) || seen.contains(&key) {
            skipped += 1;
            continue;
        }
        match catalog.add_source(name, kind, url) {
            Ok(_) => {
                seen.insert(key);
                added += 1;
            }
            Err(_) => skipped += 1,
        }
    }
    Ok(SourcesImportResult { added, skipped, total })
}

#[tauri::command]
fn list_catalog(
    catalog: tauri::State<'_, Catalog>,
    query: Option<String>,
    category: Option<String>,
    sort: Option<String>,
) -> Result<Vec<CatalogItem>, String> {
    catalog
        .list_items(query.as_deref(), category.as_deref(), sort.as_deref().unwrap_or("popularity"), 1000)
        .map_err(|e| format!("{e:#}"))
}

/// Fetch + parse a source, upsert discovered items, stamp the source. Returns count found.
#[tauri::command]
async fn refresh_source(catalog: tauri::State<'_, Catalog>, id: String) -> Result<usize, String> {
    let src = catalog
        .get_source(&id)
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| "unknown source".to_string())?;
    let items = indexer::run_source(&src.kind, &src.url, &src.name, now_ms())
        .await
        .map_err(|e| format!("{e:#}"))?;
    let n = items.len();
    catalog.upsert_items(&items).map_err(|e| format!("{e:#}"))?;
    catalog.set_source_indexed(&id, now_ms()).map_err(|e| format!("{e:#}"))?;
    Ok(n)
}

/// Probe a source and return detailed diagnostics (HTTP status, detected format, item
/// count, a sample, and a plain-language hint) for the "Test source" button. Read-only —
/// nothing is persisted.
#[tauri::command]
async fn test_source(
    catalog: tauri::State<'_, Catalog>,
    id: String,
) -> Result<indexer::SourceTest, String> {
    let src = catalog
        .get_source(&id)
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| "unknown source".to_string())?;
    Ok(indexer::test_source(&src.kind, &src.url, &src.name, now_ms()).await)
}

/// Live-search every enabled source for `query`, merge + dedupe by infohash,
/// persist to the catalog, and return the results (seeders-sorted).
#[tauri::command]
async fn search_sources(
    catalog: tauri::State<'_, Catalog>,
    query: String,
) -> Result<Vec<CatalogItem>, String> {
    search_sources_core(catalog.inner(), &query).await
}

/// Callable core of `search_sources` (no `tauri::State`), so the LAN engine server can run
/// the same live source search for a linked iPad in companion mode.
pub(crate) async fn search_sources_core(
    catalog: &Catalog,
    query: &str,
) -> Result<Vec<CatalogItem>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let sources: Vec<Source> = catalog
        .list_sources()
        .map_err(|e| format!("{e:#}"))?
        .into_iter()
        .filter(|s| s.enabled)
        .collect();
    let now = now_ms();
    // Query every source concurrently instead of one-after-another — total time
    // becomes the slowest single source, not the sum of all of them.
    let mut set = tokio::task::JoinSet::new();
    for s in sources {
        let (kind, url, name, q) = (s.kind, s.url, s.name, q.clone());
        set.spawn(async move {
            indexer::search_source(&kind, &url, &q, &name, now).await.unwrap_or_default()
        });
    }
    let mut seen = HashSet::new();
    let mut merged: Vec<CatalogItem> = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(items) = res {
            for it in items {
                if seen.insert(it.id.clone()) {
                    merged.push(it);
                }
            }
        }
    }
    let merged = rank_by_relevance(&q, merged);
    let _ = catalog.upsert_items(&merged);
    Ok(merged)
}

/// Significant lowercase tokens of a search query: drops stopwords / season-noise /
/// 1-char fragments so relevance keys on the title words that actually matter.
fn query_tokens(q: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "the", "a", "an", "of", "and", "or", "to", "in", "on", "at",
        "complete", "series", "season", "episode", "part", "vol",
    ];
    q.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 2 && !STOP.contains(t))
        .map(str::to_string)
        .collect()
}

/// Drop results that share NO significant word with the query, then rank by how many
/// query words they match (desc) and seeders (desc). Without this a popular-but-
/// unrelated file leads on pure seeders — e.g. searching "The Apothecary Diaries"
/// surfacing "The Lion King". If the query is all stopwords, fall back to seeders.
fn rank_by_relevance(query: &str, items: Vec<CatalogItem>) -> Vec<CatalogItem> {
    let tokens = query_tokens(query);
    if tokens.is_empty() {
        let mut items = items;
        items.sort_by(|a, b| b.seeders.cmp(&a.seeders));
        return items;
    }
    let mut scored: Vec<(usize, CatalogItem)> = items
        .into_iter()
        .map(|it| {
            let score = title_score(&tokens, &it.title);
            (score, it)
        })
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.seeders.cmp(&a.1.seeders)));
    scored.into_iter().map(|(_, it)| it).collect()
}

/// How many of `tokens` appear (as substrings) in `title`. 0 = no overlap = irrelevant.
fn title_score(tokens: &[String], title: &str) -> usize {
    let title = title.to_lowercase();
    tokens.iter().filter(|tok| title.contains(tok.as_str())).count()
}

/// Whether any RELEVANCE-matching torrent exists for `query` across `sources`. Mirrors
/// `search_sources_core`'s fan-out + relevance filter but persists NOTHING (these are
/// background availability probes, not user searches — so they don't pollute the catalog).
async fn query_available(sources: &[Source], query: &str) -> bool {
    let q = query.trim();
    if q.is_empty() || sources.is_empty() {
        return false;
    }
    let now = now_ms();
    let mut set = tokio::task::JoinSet::new();
    for s in sources {
        let (kind, url, name, qq) = (s.kind.clone(), s.url.clone(), s.name.clone(), q.to_string());
        set.spawn(async move {
            indexer::search_source(&kind, &url, &qq, &name, now).await.unwrap_or_default()
        });
    }
    let mut merged: Vec<CatalogItem> = Vec::new();
    let mut seen = HashSet::new();
    while let Some(res) = set.join_next().await {
        if let Ok(items) = res {
            for it in items {
                if seen.insert(it.id.clone()) {
                    merged.push(it);
                }
            }
        }
    }
    !rank_by_relevance(q, merged).is_empty()
}

/// For each query, whether the user's sources have any torrent for it (relevance-filtered).
/// Results are cached with a TTL and live probes are concurrency-capped by a shared semaphore,
/// so a Discover tab checking dozens of titles probes the indexers gently and re-visits are
/// instant. Bools are aligned to `queries`; an unresolved/uncertain query defaults to `true`
/// (available) so we never gray something out on a transient failure.
#[tauri::command]
async fn check_availability(
    catalog: tauri::State<'_, Catalog>,
    state: tauri::State<'_, AvailabilityState>,
    queries: Vec<String>,
) -> Result<Vec<bool>, String> {
    // Unique, non-empty trimmed queries.
    let mut seen = HashSet::new();
    let uniq: Vec<String> = queries
        .iter()
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty() && seen.insert(q.clone()))
        .collect();

    // Serve fresh cache hits; collect the misses to probe live.
    let mut results: HashMap<String, bool> = HashMap::new();
    let mut to_probe: Vec<String> = Vec::new();
    if let Ok(cache) = state.cache.lock() {
        for q in &uniq {
            match cache.get(q) {
                Some((avail, at)) if at.elapsed() < AVAIL_TTL => {
                    results.insert(q.clone(), *avail);
                }
                _ => to_probe.push(q.clone()),
            }
        }
    } else {
        to_probe = uniq.clone();
    }

    if !to_probe.is_empty() {
        let sources: Arc<Vec<Source>> = Arc::new(
            catalog
                .list_sources()
                .map_err(|e| format!("{e:#}"))?
                .into_iter()
                .filter(|s| s.enabled)
                .collect(),
        );
        let mut set = tokio::task::JoinSet::new();
        for q in to_probe {
            let sem = state.sem.clone();
            let srcs = sources.clone();
            set.spawn(async move {
                // The owned permit caps how many titles probe their sources concurrently.
                let _permit = sem.acquire_owned().await.ok();
                let avail = query_available(&srcs, &q).await;
                (q, avail)
            });
        }
        while let Some(res) = set.join_next().await {
            if let Ok((q, avail)) = res {
                if let Ok(mut cache) = state.cache.lock() {
                    cache.insert(q.clone(), (avail, Instant::now()));
                }
                results.insert(q, avail);
            }
        }
    }

    // Align to input order; unknown → available (don't gray on uncertainty).
    Ok(queries.iter().map(|q| *results.get(q.trim()).unwrap_or(&true)).collect())
}

#[cfg(test)]
mod relevance_tests {
    use super::{query_tokens, title_score};

    #[test]
    fn drops_unrelated_popular_result() {
        // The reported bug: "The Apothecary Diaries" must not surface "The Lion King".
        let tokens = query_tokens("The Apothecary Diaries");
        assert_eq!(tokens, vec!["apothecary", "diaries"]); // "the" dropped as a stopword
        assert_eq!(title_score(&tokens, "The Lion King"), 0); // filtered out (no overlap)
        assert_eq!(title_score(&tokens, "The Apothecary Diaries S01 1080p WEB"), 2);
        // A weaker single-word match survives but ranks below the full match.
        assert_eq!(title_score(&tokens, "Diary of a Wimpy Kid"), 0); // "diaries" != "diary"
        assert_eq!(title_score(&tokens, "The Apothecary 2023"), 1);
    }

    #[test]
    fn season_query_keeps_both_naming_styles() {
        let tokens = query_tokens("The Apothecary Diaries S01 complete");
        // "the", "complete" dropped; "s01" kept as meaningful.
        assert_eq!(tokens, vec!["apothecary", "diaries", "s01"]);
        assert_eq!(title_score(&tokens, "The.Apothecary.Diaries.S01.1080p"), 3);
        assert_eq!(title_score(&tokens, "The Apothecary Diaries Season 1"), 2); // still kept
    }

    #[test]
    fn all_stopword_query_yields_no_tokens() {
        assert!(query_tokens("the of and").is_empty());
    }
}

// ---- settings / enrichment / download management ----

#[tauri::command]
fn get_setting(catalog: tauri::State<'_, Catalog>, key: String) -> Option<String> {
    catalog.get_setting(&key)
}

#[tauri::command]
fn set_setting(catalog: tauri::State<'_, Catalog>, key: String, value: String) -> Result<(), String> {
    catalog.set_setting(&key, &value).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn clear_catalog(catalog: tauri::State<'_, Catalog>) -> Result<usize, String> {
    catalog.clear_items().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn tidal_auth_status(catalog: tauri::State<'_, Catalog>) -> Result<TidalAuthStatus, String> {
    tidal_auth_status_inner(catalog.inner())
}

#[tauri::command]
fn tidal_save_credentials(
    catalog: tauri::State<'_, Catalog>,
    client_id: String,
    client_secret: String,
    refresh_token: Option<String>,
) -> Result<TidalAuthStatus, String> {
    let mut client_id = client_id.trim().to_string();
    let mut client_secret = client_secret.trim().to_string();
    if client_id.is_empty() || client_secret.is_empty() {
        if let Ok((saved_id, saved_secret)) = tidal_credentials_from_keychain() {
            if client_id.is_empty() {
                client_id = saved_id;
            }
            if client_secret.is_empty() {
                client_secret = saved_secret;
            }
        }
    }
    if client_id.is_empty() || client_secret.is_empty() {
        return Err("Client ID and Client Secret are required.".to_string());
    }
    keychain_set(TIDAL_CLIENT_ID_ACCOUNT, &client_id)?;
    keychain_set(TIDAL_CLIENT_SECRET_ACCOUNT, &client_secret)?;
    if let Some(refresh_token) = refresh_token.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        keychain_set(TIDAL_REFRESH_TOKEN_ACCOUNT, &refresh_token)?;
    }
    let _ = keychain_delete(TIDAL_ACCESS_TOKEN_ACCOUNT);
    let _ = catalog.set_setting("tidal_access_token_expires_at", "");
    tidal_auth_status_inner(catalog.inner())
}

#[tauri::command]
fn tidal_clear_credentials(catalog: tauri::State<'_, Catalog>) -> Result<TidalAuthStatus, String> {
    let _ = keychain_delete(TIDAL_CLIENT_ID_ACCOUNT);
    let _ = keychain_delete(TIDAL_CLIENT_SECRET_ACCOUNT);
    let _ = keychain_delete(TIDAL_REFRESH_TOKEN_ACCOUNT);
    let _ = keychain_delete(TIDAL_ACCESS_TOKEN_ACCOUNT);
    let _ = catalog.set_setting("tidal_access_token_expires_at", "");
    tidal_auth_status_inner(catalog.inner())
}

#[tauri::command]
async fn tidal_test_auth(catalog: tauri::State<'_, Catalog>) -> Result<TidalAuthResult, String> {
    let (client_id, client_secret) = tidal_credentials_from_keychain()?;
    let maybe_refresh = tidal_refresh_token_from_keychain()?;
    let (token, auth_mode) = match maybe_refresh {
        Some(refresh_token) => {
            let token = tidal_exchange_refresh_token(&client_id, &client_secret, &refresh_token).await?;
            (token, "refresh_token")
        }
        None => {
            let token = tidal_exchange_client_credentials(&client_id, &client_secret).await?;
            (token, "client_credentials")
        }
    };
    store_tidal_access_token(catalog.inner(), &token)?;

    Ok(TidalAuthResult {
        token_type: token.token_type,
        expires_in: token.expires_in,
        access_token_expires_at: token.access_token_expires_at,
        auth_mode: auth_mode.to_string(),
    })
}

#[tauri::command]
async fn tidal_authorize_login(
    app: tauri::AppHandle,
    catalog: tauri::State<'_, Catalog>,
    redirect_uri: Option<String>,
) -> Result<TidalAuthResult, String> {
    use tauri_plugin_opener::OpenerExt;

    let (client_id, client_secret) = tidal_credentials_from_keychain()?;
    let redirect_uri = redirect_uri
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| catalog.get_setting("tidal_oauth_redirect_uri").filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| TIDAL_OAUTH_DEFAULT_REDIRECT_URI.to_string());

    let redirect = tauri::Url::parse(&redirect_uri)
        .map_err(|e| format!("Invalid TIDAL OAuth redirect URI: {e}"))?;
    if redirect.scheme() != "http" {
        return Err(
            "TIDAL OAuth redirect URI must use http:// and point to localhost (for desktop callback capture)."
                .to_string(),
        );
    }
    let host = redirect
        .host_str()
        .ok_or_else(|| "TIDAL OAuth redirect URI must include a host, e.g. 127.0.0.1.".to_string())?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err("TIDAL OAuth redirect URI host must be localhost or 127.0.0.1.".to_string());
    }
    let port = redirect.port().ok_or_else(|| {
        "TIDAL OAuth redirect URI must include an explicit port, e.g. http://127.0.0.1:46171/tidal/callback"
            .to_string()
    })?;
    let path = if redirect.path().is_empty() {
        "/".to_string()
    } else {
        redirect.path().to_string()
    };

    let bind_addr: SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|e| format!("Invalid localhost callback port: {e}"))?;
    let state = format!("ghosty-{}-{}", now_ms(), std::process::id());
    let code_verifier = tidal_pkce_code_verifier();
    let code_challenge = tidal_pkce_code_challenge(&code_verifier);

    let callback_task = tokio::spawn(wait_for_tidal_oauth_code(bind_addr, path, state.clone()));

    let mut auth_url = tauri::Url::parse(TIDAL_OAUTH_AUTHORIZE_URL).map_err(|e| e.to_string())?;
    {
        let mut query = auth_url.query_pairs_mut();
        query.append_pair("response_type", "code");
        query.append_pair("client_id", &client_id);
        query.append_pair("redirect_uri", redirect.as_str());
        query.append_pair("scope", TIDAL_OAUTH_SCOPE);
        query.append_pair("state", &state);
        query.append_pair("code_challenge", &code_challenge);
        query.append_pair("code_challenge_method", "S256");
    }

    if let Err(err) = app.opener().open_url(auth_url.to_string(), None::<&str>) {
        callback_task.abort();
        return Err(format!("Couldn't open browser for TIDAL login: {err}"));
    }

    let code = match callback_task.await {
        Ok(result) => result?,
        Err(err) => {
            return Err(format!(
                "TIDAL OAuth callback listener failed to run: {err}. Make sure nothing is already using port {port}."
            ));
        }
    };

    let token = tidal_exchange_authorization_code(
        &client_id,
        &client_secret,
        &code,
        &code_verifier,
        redirect.as_str(),
    )
    .await
    .map_err(|err| {
        let lower = err.to_ascii_lowercase();
        if lower.contains("1002") || lower.contains("forbidden") || lower.contains("permission") {
            format!("{err}\n{TIDAL_OAUTH_FALLBACK_HINT}")
        } else {
            err
        }
    })?;
    if token
        .refresh_token
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .is_none()
    {
        return Err(
            "TIDAL login succeeded but no refresh token was returned. Verify your app allows Authorization Code flow and offline account access."
                .to_string(),
        );
    }
    store_tidal_access_token(catalog.inner(), &token)?;
    let _ = catalog.set_setting("tidal_oauth_redirect_uri", redirect.as_str());

    Ok(TidalAuthResult {
        token_type: token.token_type,
        expires_in: token.expires_in,
        access_token_expires_at: token.access_token_expires_at,
        auth_mode: "authorization_code".to_string(),
    })
}

#[tauri::command]
fn app_info(info: tauri::State<'_, AppInfo>) -> AppInfo {
    info.inner().clone()
}

/// Codec-aware loopback playback URL for a downloaded file (by relpath = its library id).
/// The scan bakes URLs by extension; this re-checks at play time by probing the actual
/// streams, so a `.mp4` carrying HEVC video or AC-3/DTS audio routes through the transcoder
/// instead of being served raw and failing silently in the player. Falls back to the raw
/// `/file` URL if anything goes wrong (caller also falls back to the item's own `url`).
#[tauri::command]
async fn local_play_url(info: tauri::State<'_, AppInfo>, rel: String) -> Result<String, String> {
    let dir = info.download_dir.clone();
    let ffmpeg_available = info.ffmpeg_available;
    let (_ffmpeg, ffprobe) = engine::resolve_ffmpeg();
    Ok(engine::local_play_url_for(&dir, ffmpeg_available, ffprobe.as_deref(), &rel).await)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayStatus {
    url: String,
    reachable: bool,
    status: Option<u16>,
    latency_ms: Option<u64>,
}

/// Liveness probe for GhostWire artwork relay (posters + album art). A quick,
/// short-timeout GET to the relay's poster endpoint — any HTTP response means the
/// relay is reachable; a transport error means it isn't. Surfaced in Settings.
#[tauri::command]
async fn relay_status() -> Result<RelayStatus, String> {
    let base = posters::RELAY_BASE;
    let url = format!("{base}/poster?type=movie&title=ping&year=2000");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    match client.get(&url).send().await {
        Ok(resp) => Ok(RelayStatus {
            url: base.to_string(),
            reachable: resp.status().is_success() || resp.status().is_redirection(),
            status: Some(resp.status().as_u16()),
            latency_ms: Some(started.elapsed().as_millis() as u64),
        }),
        Err(_) => Ok(RelayStatus {
            url: base.to_string(),
            reachable: false,
            status: None,
            latency_ms: None,
        }),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MusicSpotiFlacStatus {
    available: bool,
    command: Option<String>,
    output_dir: String,
    hint: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MusicSpotiFlacResult {
    command: String,
    output_dir: String,
    stdout: String,
    stderr: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MusicSpotiFlacInstallResult {
    command: String,
    resolved_command: Option<String>,
    stdout: String,
    stderr: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MusicSpotiFlacOutput {
    stream: String,
    line: String,
    completed_files: Option<usize>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TidalAuthStatus {
    has_client_id: bool,
    has_client_secret: bool,
    has_refresh_token: bool,
    has_access_token: bool,
    access_token_expires_at: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TidalAuthResult {
    token_type: String,
    expires_in: i64,
    access_token_expires_at: i64,
    auth_mode: String,
}

struct TidalAccessToken {
    access_token: String,
    token_type: String,
    expires_in: i64,
    access_token_expires_at: i64,
    refresh_token: Option<String>,
}

const TIDAL_KEYCHAIN_SERVICE: &str = "com.ghosty.tidal";
const TIDAL_CLIENT_ID_ACCOUNT: &str = "client_id";
const TIDAL_CLIENT_SECRET_ACCOUNT: &str = "client_secret";
const TIDAL_REFRESH_TOKEN_ACCOUNT: &str = "refresh_token";
const TIDAL_ACCESS_TOKEN_ACCOUNT: &str = "access_token";
const TIDAL_OAUTH_SCOPE: &str = "r_usr";
const TIDAL_OAUTH_AUTHORIZE_URL: &str = "https://login.tidal.com/authorize";
const TIDAL_OAUTH_TOKEN_URL: &str = "https://auth.tidal.com/v1/oauth2/token";
const TIDAL_OAUTH_DEFAULT_REDIRECT_URI: &str = "http://127.0.0.1:46171/tidal/callback";
const TIDAL_OAUTH_TIMEOUT_SECS: u64 = 600;
const TIDAL_OAUTH_FALLBACK_HINT: &str =
    "If TIDAL keeps showing error 1002/permission issues, use a custom HiFi API URL in Settings (SpotiFLAC-style flow) instead of direct TIDAL OAuth.";
const TIDAL_OAUTH_REDIRECT_HINT: &str =
    "Verify the redirect URI in TIDAL developer settings exactly matches GhostWire (scheme, host, port, path).";

struct SpotiFlacCmd {
    program: PathBuf,
    fixed_args: Vec<String>,
}

#[derive(Clone)]
struct TidalBridgeState {
    client: reqwest::Client,
    client_id: String,
    access_token: String,
    base_url: String,
    manifests: Arc<tokio::sync::Mutex<HashMap<String, Vec<u8>>>>,
}

struct TidalBridgeHandle {
    url: String,
    auth_mode: String,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(serde::Deserialize)]
struct TidalBridgeRequest {
    id: String,
    quality: Option<String>,
    endpoint: Option<String>,
    formats: Option<Vec<String>>,
}

#[derive(serde::Deserialize)]
struct TidalBridgeTrackQuery {
    id: String,
    quality: Option<String>,
}

#[derive(serde::Serialize)]
struct TidalBridgeError {
    success: bool,
    message: String,
}

fn music_output_dir(info: &AppInfo) -> PathBuf {
    // Music lives under the organized Library alongside Movies/TV/Books/Games, so there's a
    // SINGLE music tree. (Historically SpotiFLAC/TIDAL wrote to a separate top-level `Music/`;
    // a one-time startup migration folds that into `Library/Music/`.)
    PathBuf::from(&info.download_dir).join("Library").join("Music")
}

/// Fold a legacy top-level `<root>/Music/` tree into the canonical `<root>/Library/Music/`
/// so there's exactly ONE music directory. Non-destructive: artist folders missing from the
/// destination are moved wholesale (a same-volume rename); when an artist exists in both, its
/// files are merged individually and any collision keeps the existing destination file (the
/// source copy is left untouched rather than overwritten). Empty source folders are pruned as
/// they drain. Skips macOS sidecars (`._*`, `.DS_Store`). Safe to run on every launch.
fn consolidate_music_dirs(root: &Path) {
    let legacy = root.join("Music");
    let dest = root.join("Library").join("Music");
    if !legacy.is_dir() || legacy == dest {
        return;
    }
    let is_sidecar = |name: &str| name.starts_with("._") || name == ".DS_Store";
    std::fs::create_dir_all(&dest).ok();

    // Recursively merge `src` into `dst`, moving files that don't already exist and keeping
    // the destination on any collision. Returns true if `src` is empty afterwards.
    fn merge_into(src: &Path, dst: &Path, is_sidecar: &dyn Fn(&str) -> bool) -> bool {
        std::fs::create_dir_all(dst).ok();
        let Ok(entries) = std::fs::read_dir(src) else { return false };
        for entry in entries.flatten() {
            let sp = entry.path();
            let name = match sp.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if is_sidecar(&name) {
                let _ = std::fs::remove_file(&sp);
                continue;
            }
            let dp = dst.join(&name);
            if sp.is_dir() {
                if dp.exists() {
                    merge_into(&sp, &dp, is_sidecar);
                    let _ = std::fs::remove_dir(&sp); // only succeeds if now empty
                } else {
                    // Whole subtree is new at the destination — atomic same-volume move.
                    let _ = std::fs::rename(&sp, &dp);
                }
            } else if !dp.exists() {
                let _ = std::fs::rename(&sp, &dp);
            } else {
                // A file with this name already exists in the library. If it's byte-identical
                // (same size — these are app-managed downloads, never hand-edited), the legacy
                // copy is a pure duplicate: drop it so the source tree can fully drain and the
                // top-level `Music/` folder gets removed, leaving exactly one music home.
                let same = std::fs::metadata(&sp)
                    .ok()
                    .map(|m| m.len())
                    .zip(std::fs::metadata(&dp).ok().map(|m| m.len()))
                    .map(|(a, b)| a == b)
                    .unwrap_or(false);
                if same {
                    let _ = std::fs::remove_file(&sp);
                }
                // else: a differently-sized file with this name exists — keep BOTH (never
                // overwrite or delete differing data); the legacy copy stays for the user to
                // reconcile and its folder is intentionally left in place.
            }
        }
        // Empty if nothing (besides already-removed sidecars) remains.
        std::fs::read_dir(src).map(|mut e| e.next().is_none()).unwrap_or(false)
    }

    if merge_into(&legacy, &dest, &is_sidecar) {
        let _ = std::fs::remove_dir(&legacy);
    }
}


#[cfg(target_os = "macos")]
fn keychain_set(account: &str, value: &str) -> Result<(), String> {
    let out = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            TIDAL_KEYCHAIN_SERVICE,
            "-a",
            account,
            "-w",
            value,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn keychain_get(account: &str) -> Result<Option<String>, String> {
    let out = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-w",
            "-s",
            TIDAL_KEYCHAIN_SERVICE,
            "-a",
            account,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_string()))
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("could not be found") {
            Ok(None)
        } else {
            Err(stderr.trim().to_string())
        }
    }
}

#[cfg(target_os = "macos")]
fn keychain_delete(account: &str) -> Result<(), String> {
    let out = std::process::Command::new("security")
        .args([
            "delete-generic-password",
            "-s",
            TIDAL_KEYCHAIN_SERVICE,
            "-a",
            account,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() || String::from_utf8_lossy(&out.stderr).contains("could not be found") {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn keychain_set(_account: &str, _value: &str) -> Result<(), String> {
    Err("Secure TIDAL credential storage is currently implemented for macOS only.".to_string())
}

#[cfg(not(target_os = "macos"))]
fn keychain_get(_account: &str) -> Result<Option<String>, String> {
    Err("Secure TIDAL credential storage is currently implemented for macOS only.".to_string())
}

#[cfg(not(target_os = "macos"))]
fn keychain_delete(_account: &str) -> Result<(), String> {
    Err("Secure TIDAL credential storage is currently implemented for macOS only.".to_string())
}

fn tidal_auth_status_inner(catalog: &Catalog) -> Result<TidalAuthStatus, String> {
    let has_client_id = keychain_get(TIDAL_CLIENT_ID_ACCOUNT)?.map(|s| !s.trim().is_empty()).unwrap_or(false);
    let has_client_secret = keychain_get(TIDAL_CLIENT_SECRET_ACCOUNT)?.map(|s| !s.trim().is_empty()).unwrap_or(false);
    let has_refresh_token = keychain_get(TIDAL_REFRESH_TOKEN_ACCOUNT)?.map(|s| !s.trim().is_empty()).unwrap_or(false);
    let has_access_token = keychain_get(TIDAL_ACCESS_TOKEN_ACCOUNT)?.map(|s| !s.trim().is_empty()).unwrap_or(false);
    let access_token_expires_at = catalog
        .get_setting("tidal_access_token_expires_at")
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|v| *v > 0);
    Ok(TidalAuthStatus {
        has_client_id,
        has_client_secret,
        has_refresh_token,
        has_access_token,
        access_token_expires_at,
    })
}

fn tidal_credentials_from_keychain() -> Result<(String, String), String> {
    let client_id = keychain_get(TIDAL_CLIENT_ID_ACCOUNT)?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Save a TIDAL Client ID first.".to_string())?;
    let client_secret = keychain_get(TIDAL_CLIENT_SECRET_ACCOUNT)?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Save a TIDAL Client Secret first.".to_string())?;
    Ok((client_id, client_secret))
}

fn tidal_refresh_token_from_keychain() -> Result<Option<String>, String> {
    Ok(keychain_get(TIDAL_REFRESH_TOKEN_ACCOUNT)?.filter(|s| !s.trim().is_empty()))
}

fn tidal_oauth_error_message(body: &str) -> String {
    #[derive(serde::Deserialize)]
    struct TidalOauthError {
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        error_description: Option<String>,
        #[serde(default)]
        detail: Option<String>,
        #[serde(default)]
        title: Option<String>,
    }

    if let Ok(err) = serde_json::from_str::<TidalOauthError>(body) {
        if let Some(message) = err.error_description.filter(|s| !s.trim().is_empty()) {
            return message;
        }
        if let Some(message) = err.detail.filter(|s| !s.trim().is_empty()) {
            return message;
        }
        if let Some(message) = err.title.filter(|s| !s.trim().is_empty()) {
            return message;
        }
        if let Some(message) = err.error.filter(|s| !s.trim().is_empty()) {
            return message;
        }
    }

    let trimmed = body.trim();
    if trimmed.is_empty() {
        "Unknown TIDAL OAuth error".to_string()
    } else {
        trimmed.to_string()
    }
}

fn tidal_pkce_code_verifier() -> String {
    use base64::Engine;

    let mut bytes = [0u8; 64];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn tidal_pkce_code_challenge(code_verifier: &str) -> String {
    use base64::Engine;

    let digest = Sha256::digest(code_verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

async fn wait_for_tidal_oauth_code(
    bind_addr: SocketAddr,
    expected_path: String,
    expected_state: String,
) -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|e| format!("Failed to listen for TIDAL OAuth callback on {bind_addr}: {e}"))?;

    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(TIDAL_OAUTH_TIMEOUT_SECS), listener.accept())
        .await
        .map_err(|_| {
            format!(
                "Timed out waiting for TIDAL login callback ({}s). Complete login in your browser and try again.\nIf your browser showed authorize 400/permission errors, your app may not be approved for this OAuth login path.\n{}\n{}",
                TIDAL_OAUTH_TIMEOUT_SECS,
                TIDAL_OAUTH_REDIRECT_HINT,
                TIDAL_OAUTH_FALLBACK_HINT
            )
        })
        .and_then(|result| result.map_err(|e| format!("Failed to accept TIDAL OAuth callback: {e}")))?;

    let (status_line, html, code_result) = {
        let mut reader = tokio::io::BufReader::new(&mut stream);
        let mut request_line = String::new();
        if reader
            .read_line(&mut request_line)
            .await
            .map_err(|e| format!("Failed reading callback request: {e}"))?
            == 0
        {
            return Err("TIDAL callback connection closed before sending data.".to_string());
        }

        loop {
            let mut header_line = String::new();
            let n = reader
                .read_line(&mut header_line)
                .await
                .map_err(|e| format!("Failed reading callback headers: {e}"))?;
            if n == 0 || header_line == "\r\n" || header_line == "\n" {
                break;
            }
        }

        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("");
        let target = parts.next().unwrap_or("");

        if method != "GET" || target.is_empty() {
            (
                "400 Bad Request".to_string(),
                "<html><body><h2>TIDAL login failed</h2><p>GhostWire received an invalid callback request.</p></body></html>"
                    .to_string(),
                Err("TIDAL callback request was malformed.".to_string()),
            )
        } else {
            let callback_url = tauri::Url::parse(&format!("http://localhost{target}"))
                .map_err(|e| format!("Failed to parse callback URL: {e}"));

            match callback_url {
                Err(err) => (
                    "400 Bad Request".to_string(),
                    "<html><body><h2>TIDAL login failed</h2><p>GhostWire could not parse the callback URL.</p></body></html>"
                        .to_string(),
                    Err(err),
                ),
                Ok(url) => {
                    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
                    if url.path() != expected_path {
                        (
                            "400 Bad Request".to_string(),
                            "<html><body><h2>TIDAL login failed</h2><p>Callback path did not match your configured redirect URI.</p></body></html>"
                                .to_string(),
                            Err("TIDAL callback path mismatch. Ensure your app redirect URI exactly matches GhostWire's redirect URI."
                                .to_string()),
                        )
                    } else if let Some(error) = params.get("error").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                        let detail = params
                            .get("error_description")
                            .map(|s| s.trim())
                            .filter(|s| !s.is_empty())
                            .unwrap_or("");
                        let message = if detail.is_empty() {
                            format!("TIDAL authorization failed: {error}")
                        } else {
                            format!("TIDAL authorization failed: {error} ({detail})")
                        };
                        (
                            "400 Bad Request".to_string(),
                            "<html><body><h2>TIDAL login failed</h2><p>You denied access or TIDAL returned an authorization error.</p></body></html>"
                                .to_string(),
                            Err(message),
                        )
                    } else if params.get("state").map(String::as_str) != Some(expected_state.as_str()) {
                        (
                            "400 Bad Request".to_string(),
                            "<html><body><h2>TIDAL login failed</h2><p>State mismatch detected. Return to GhostWire and retry.</p></body></html>"
                                .to_string(),
                            Err("TIDAL OAuth state mismatch. Please retry login.".to_string()),
                        )
                    } else if let Some(code) = params
                        .get("code")
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                    {
                        (
                            "200 OK".to_string(),
                            "<html><body><h2>TIDAL login complete</h2><p>You can close this browser tab and return to GhostWire.</p></body></html>"
                                .to_string(),
                            Ok(code),
                        )
                    } else {
                        (
                            "400 Bad Request".to_string(),
                            "<html><body><h2>TIDAL login failed</h2><p>TIDAL did not return an authorization code.</p></body></html>"
                                .to_string(),
                            Err("TIDAL callback did not include an authorization code.".to_string()),
                        )
                    }
                }
            }
        }
    };

    let response = format!(
        "HTTP/1.1 {status_line}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;

    code_result
}

async fn tidal_exchange_authorization_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TidalAccessToken, String> {
    #[derive(serde::Deserialize)]
    struct TokenResponse {
        access_token: String,
        token_type: String,
        expires_in: i64,
        #[serde(default)]
        refresh_token: Option<String>,
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(TIDAL_OAUTH_TOKEN_URL)
        .basic_auth(client_id, Some(client_secret))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", code_verifier),
            ("redirect_uri", redirect_uri),
            ("client_id", client_id),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "TIDAL authorization-code exchange failed: {status} {}",
            tidal_oauth_error_message(&body)
        ));
    }

    let token: TokenResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(TidalAccessToken {
        access_token: token.access_token,
        token_type: token.token_type,
        expires_in: token.expires_in,
        access_token_expires_at: now_s() + token.expires_in,
        refresh_token: token.refresh_token,
    })
}

async fn tidal_exchange_client_credentials(client_id: &str, client_secret: &str) -> Result<TidalAccessToken, String> {
    use base64::Engine;

    #[derive(serde::Deserialize)]
    struct TokenResponse {
        access_token: String,
        token_type: String,
        expires_in: i64,
        #[serde(default)]
        refresh_token: Option<String>,
    }

    let basic = base64::engine::general_purpose::STANDARD.encode(format!("{client_id}:{client_secret}"));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(TIDAL_OAUTH_TOKEN_URL)
        .header(reqwest::header::AUTHORIZATION, format!("Basic {basic}"))
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body("grant_type=client_credentials")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("TIDAL auth failed: {status} {}", body.trim()));
    }

    let token: TokenResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(TidalAccessToken {
        access_token: token.access_token,
        token_type: token.token_type,
        expires_in: token.expires_in,
        access_token_expires_at: now_s() + token.expires_in,
        refresh_token: token.refresh_token,
    })
}

async fn tidal_exchange_refresh_token(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<TidalAccessToken, String> {
    use base64::Engine;

    #[derive(serde::Deserialize)]
    struct TokenResponse {
        access_token: String,
        token_type: String,
        expires_in: i64,
        #[serde(default)]
        refresh_token: Option<String>,
    }

    let basic = base64::engine::general_purpose::STANDARD.encode(format!("{client_id}:{client_secret}"));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(TIDAL_OAUTH_TOKEN_URL)
        .header(reqwest::header::AUTHORIZATION, format!("Basic {basic}"))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("TIDAL refresh-token auth failed: {status} {}", body.trim()));
    }

    let token: TokenResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(TidalAccessToken {
        access_token: token.access_token,
        token_type: token.token_type,
        expires_in: token.expires_in,
        access_token_expires_at: now_s() + token.expires_in,
        refresh_token: token.refresh_token,
    })
}

fn store_tidal_access_token(catalog: &Catalog, token: &TidalAccessToken) -> Result<(), String> {
    keychain_set(TIDAL_ACCESS_TOKEN_ACCOUNT, &token.access_token)?;
    if let Some(refresh_token) = token.refresh_token.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        keychain_set(TIDAL_REFRESH_TOKEN_ACCOUNT, refresh_token)?;
    }
    catalog
        .set_setting("tidal_access_token_expires_at", &token.access_token_expires_at.to_string())
        .map_err(|e| format!("{e:#}"))
}

async fn ensure_tidal_access_token(catalog: &Catalog) -> Result<(String, String, String), String> {
    let (client_id, client_secret) = tidal_credentials_from_keychain()?;
    let expires_at = catalog
        .get_setting("tidal_access_token_expires_at")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    if expires_at > now_s() + 120 {
        if let Some(access_token) = keychain_get(TIDAL_ACCESS_TOKEN_ACCOUNT)?.filter(|s| !s.trim().is_empty()) {
            let auth_mode = if tidal_refresh_token_from_keychain()?.is_some() {
                "refresh_token"
            } else {
                "client_credentials"
            };
            return Ok((client_id, access_token, auth_mode.to_string()));
        }
    }

    if let Some(refresh_token) = tidal_refresh_token_from_keychain()? {
        let token = tidal_exchange_refresh_token(&client_id, &client_secret, &refresh_token).await?;
        store_tidal_access_token(catalog, &token)?;
        return Ok((client_id, token.access_token, "refresh_token".to_string()));
    }

    let token = tidal_exchange_client_credentials(&client_id, &client_secret).await?;
    store_tidal_access_token(catalog, &token)?;
    Ok((client_id, token.access_token, "client_credentials".to_string()))
}

fn normalize_tidal_quality(value: &str) -> String {
    match value.trim().to_ascii_uppercase().as_str() {
        "HIRES" | "HI_RES" | "MASTER" => "HI_RES_LOSSLESS".to_string(),
        "FLAC" => "LOSSLESS".to_string(),
        "DOLBY" | "ATMOS" | "DOLBY ATMOS" | "EAC3" | "EC3" | "EAC3_JOC" => "DOLBY_ATMOS".to_string(),
        "LOW" | "HIGH" | "LOSSLESS" | "HI_RES_LOSSLESS" | "DOLBY_ATMOS" => value.trim().to_ascii_uppercase(),
        _ => "LOSSLESS".to_string(),
    }
}

fn tidal_error_is_missing_bearer(detail: &str) -> bool {
    detail.to_ascii_lowercase().contains("bearer token is missing or empty")
}

fn tidal_missing_bearer_hint(api_mode: &str) -> &'static str {
    match api_mode {
        "custom" => {
            "Hint: Your custom TIDAL API returned a missing bearer-token error. Ensure that API has a valid account token configured, or clear TIDAL API URL in Settings to use SpotiFLAC's built-in public mirror pool."
        }
        "spotiflac_public" => {
            "Hint: SpotiFLAC's public TIDAL API pool returned a missing bearer-token error. Retry later, or set your own self-hosted hifi-api URL in Settings for more reliable access."
        }
        _ => "Hint: TIDAL playback needs an account refresh token. Open Settings -> TIDAL app auth and click Get refresh token.",
    }
}

fn spotify_clienttoken_unauthorized(detail: &str) -> bool {
    let d = detail.to_ascii_lowercase();
    d.contains("clienttoken.spotify.com") && d.contains("401")
}

fn spotify_clienttoken_hint() -> &'static str {
    "Hint: Spotify rejected SpotiFLAC's client-token request (401). This is upstream Spotify auth hardening and is not caused by GhostWire's local HTTP server/TLS. Update SpotiFLAC, retry later, or import via YouTube-link/search fallback."
}

fn tidal_bridge_quality(req: &TidalBridgeRequest) -> String {
    if req.endpoint.as_deref() == Some("manifests")
        || req
            .formats
            .as_ref()
            .is_some_and(|formats| formats.iter().any(|f| f.eq_ignore_ascii_case("EAC3_JOC")))
    {
        return "DOLBY_ATMOS".to_string();
    }
    normalize_tidal_quality(req.quality.as_deref().unwrap_or("LOSSLESS"))
}

async fn fetch_tidal_playback(
    client: &reqwest::Client,
    client_id: &str,
    access_token: &str,
    track_id: &str,
    quality: &str,
) -> Result<serde_json::Value, String> {
    let candidates = [
        format!("https://listen.tidal.com/v1/tracks/{track_id}/playbackinfopostpaywall/v4"),
        format!("https://listen.tidal.com/v1/tracks/{track_id}/playbackinfopostpaywall/v1"),
        format!("https://listen.tidal.com/v1/tracks/{track_id}/playbackinfopostpaywall"),
        format!("https://api.tidal.com/v1/tracks/{track_id}/playbackinfopostpaywall"),
    ];
    let mut last_err = None;

    for url in candidates {
        let res = client
            .get(&url)
            .query(&[
                ("audioquality", quality),
                ("playbackmode", "STREAM"),
                ("assetpresentation", "FULL"),
                ("countryCode", "US"),
                ("deviceType", "BROWSER"),
            ])
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {access_token}"))
            .header("X-Tidal-Token", client_id)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::USER_AGENT, BROWSER_UA)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            last_err = Some(format!("{status} {}", body.trim()));
            continue;
        }
        let json = serde_json::from_str::<serde_json::Value>(&body).map_err(|e| e.to_string())?;
        return Ok(json);
    }

    Err(format!(
        "TIDAL playback lookup failed for track {track_id}. {}",
        last_err.unwrap_or_else(|| "No TIDAL playback endpoint returned a response.".to_string())
    ))
}

fn tidal_manifest_from_payload(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("manifest")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("data").and_then(|v| v.get("manifest")).and_then(|v| v.as_str()))
        .map(str::to_string)
}

fn tidal_asset_presentation(payload: &serde_json::Value) -> String {
    payload
        .get("assetPresentation")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("data").and_then(|v| v.get("assetPresentation")).and_then(|v| v.as_str()))
        .unwrap_or("FULL")
        .to_string()
}

async fn tidal_bridge_post(
    AxumState(state): AxumState<TidalBridgeState>,
    Json(req): Json<TidalBridgeRequest>,
) -> Response {
    let track_id = req.id.trim();
    if track_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(TidalBridgeError {
                success: false,
                message: "Missing TIDAL track id.".to_string(),
            }),
        )
            .into_response();
    }

    let quality = tidal_bridge_quality(&req);
    let payload = match fetch_tidal_playback(&state.client, &state.client_id, &state.access_token, track_id, &quality).await {
        Ok(payload) => payload,
        Err(err) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(TidalBridgeError {
                    success: false,
                    message: err,
                }),
            )
                .into_response();
        }
    };

    let manifest = match tidal_manifest_from_payload(&payload) {
        Some(manifest) => manifest,
        None => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(TidalBridgeError {
                    success: false,
                    message: "TIDAL playback response did not include a manifest.".to_string(),
                }),
            )
                .into_response();
        }
    };

    if quality == "DOLBY_ATMOS" {
        use base64::Engine;

        let bytes = match base64::engine::general_purpose::STANDARD.decode(manifest.as_bytes()) {
            Ok(bytes) => bytes,
            Err(err) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(TidalBridgeError {
                        success: false,
                        message: format!("TIDAL returned an invalid Dolby Atmos manifest: {err}"),
                    }),
                )
                    .into_response();
            }
        };
        let key = format!("{}-{}-{}", track_id, quality.to_ascii_lowercase(), now_ms());
        {
            let mut manifests = state.manifests.lock().await;
            manifests.insert(key.clone(), bytes);
            if manifests.len() > 24 {
                let mut keys: Vec<String> = manifests.keys().cloned().collect();
                keys.sort();
                let drop_n = manifests.len().saturating_sub(24);
                for old in keys.into_iter().take(drop_n) {
                    manifests.remove(&old);
                }
            }
        }
        return Json(serde_json::json!({
            "data": {
                "data": {
                    "attributes": {
                        "formats": ["EAC3_JOC"],
                        "uri": format!("{}/manifest/{}", state.base_url, key),
                    }
                }
            }
        }))
        .into_response();
    }

    Json(serde_json::json!({
        "manifest": manifest,
        "data": {
            "manifest": manifest,
            "assetPresentation": tidal_asset_presentation(&payload),
        }
    }))
    .into_response()
}

async fn tidal_bridge_track_get(
    AxumState(state): AxumState<TidalBridgeState>,
    Query(query): Query<TidalBridgeTrackQuery>,
) -> Response {
    tidal_bridge_post(
        AxumState(state),
        Json(TidalBridgeRequest {
            id: query.id,
            quality: query.quality,
            endpoint: None,
            formats: None,
        }),
    )
    .await
}

async fn tidal_bridge_manifest(
    AxumState(state): AxumState<TidalBridgeState>,
    AxumPath(key): AxumPath<String>,
) -> Response {
    let bytes = {
        let manifests = state.manifests.lock().await;
        manifests.get(&key).cloned()
    };
    match bytes {
        Some(bytes) => {
            let mut res = bytes.into_response();
            res.headers_mut().insert(axum::http::header::CONTENT_TYPE, HeaderValue::from_static("application/dash+xml"));
            res
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn start_tidal_bridge(catalog: &Catalog) -> Result<TidalBridgeHandle, String> {
    let (client_id, access_token, auth_mode) = ensure_tidal_access_token(catalog).await?;
    let mut access_token = access_token;
    let mut auth_mode = auth_mode;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    // Some TIDAL app-only tokens pass initial auth but fail playback calls with a
    // bearer-token error. If we have a refresh token, retry once with account auth.
    if let Err(err) = fetch_tidal_playback(&client, &client_id, &access_token, "441821360", "LOSSLESS").await {
        if tidal_error_is_missing_bearer(&err) {
            if let Some(refresh_token) = tidal_refresh_token_from_keychain()? {
                let (_, client_secret) = tidal_credentials_from_keychain()?;
                let token = tidal_exchange_refresh_token(&client_id, &client_secret, &refresh_token).await?;
                store_tidal_access_token(catalog, &token)?;
                access_token = token.access_token;
                auth_mode = "refresh_token".to_string();
            } else {
                return Err(format!(
                    "TIDAL rejected the current bearer token. {}",
                    tidal_missing_bearer_hint("ghosty_bridge")
                ));
            }
        }
    }

    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|e| e.to_string())?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let base_url = format!("http://{}", addr);
    let state = TidalBridgeState {
        client,
        client_id,
        access_token,
        base_url: base_url.clone(),
        manifests: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
    };
    let router = Router::new()
        .route("/", post(tidal_bridge_post))
        .route("/track/", get(tidal_bridge_track_get))
        .route("/track", get(tidal_bridge_track_get))
        .route("/manifest/{key}", get(tidal_bridge_manifest))
        .with_state(state);
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        let _ = server.await;
    });

    Ok(TidalBridgeHandle {
        url: base_url,
        auth_mode,
        shutdown: Some(shutdown_tx),
        task,
    })
}

impl TidalBridgeHandle {
    async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        let _ = self.task.await;
    }
}

fn find_bin(name: &str) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        let mut extra = vec![home.join(".local/bin")];
        if let Ok(lib_py) = std::fs::read_dir(home.join("Library/Python")) {
            for dir in lib_py.flatten() {
                let p = dir.path().join("bin");
                if p.is_dir() {
                    extra.push(p);
                }
            }
        }
        for dir in extra {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let candidate = Path::new(dir).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_spotiflac() -> Option<SpotiFlacCmd> {
    find_bin("spotiflac").map(|program| SpotiFlacCmd {
        program,
        fixed_args: Vec::new(),
    })
}

fn render_command(program: &Path, fixed_args: &[String], args: &[String]) -> String {
    let mut parts = vec![program.display().to_string()];
    parts.extend(fixed_args.iter().cloned());
    parts.extend(args.iter().cloned());
    parts
        .into_iter()
        .map(|part| {
            if part.chars().any(char::is_whitespace) {
                format!("\"{}\"", part.replace('"', "\\\""))
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn system_path_for_installs() -> std::ffi::OsString {
    let mut parts: Vec<PathBuf> = std::env::var_os("PATH")
        .as_deref()
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .collect();
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        parts.push(home.join(".local/bin"));
        parts.push(PathBuf::from("/opt/homebrew/bin"));
        parts.push(PathBuf::from("/usr/local/bin"));
        parts.push(PathBuf::from("/usr/bin"));
        if let Ok(lib_py) = std::fs::read_dir(home.join("Library/Python")) {
            for dir in lib_py.flatten() {
                let p = dir.path().join("bin");
                if p.is_dir() {
                    parts.push(p);
                }
            }
        }
    }
    let mut uniq: Vec<PathBuf> = Vec::new();
    for part in parts {
        if !uniq.iter().any(|p| p == &part) {
            uniq.push(part);
        }
    }
    std::env::join_paths(uniq).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn preferred_python_for_install() -> Option<PathBuf> {
    for candidate in ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python", "/usr/local/bin/python"] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    find_bin("python3")
        .filter(|p| p != Path::new("/usr/bin/python3"))
        .or_else(|| find_bin("python").filter(|p| p != Path::new("/usr/bin/python")))
        .or_else(|| find_bin("python3"))
        .or_else(|| find_bin("python"))
}

fn install_attempts() -> Vec<(String, Vec<String>)> {
    let mut cmds = Vec::new();
    if let Some(pipx) = find_bin("pipx") {
        cmds.push((
            pipx.display().to_string(),
            vec!["install".to_string(), "--force".to_string(), "SpotiFLAC".to_string()],
        ));
    }
    if let Some(py) = preferred_python_for_install() {
        cmds.push((
            py.display().to_string(),
            vec![
                "-m".to_string(),
                "pip".to_string(),
                "install".to_string(),
                "--user".to_string(),
                "--upgrade".to_string(),
                "SpotiFLAC".to_string(),
            ],
        ));
    }
    cmds
}

async fn run_install_capture(
    program: String,
    args: Vec<String>,
    path: std::ffi::OsString,
    max_lines: usize,
) -> Result<(bool, String, String, String), String> {
    let rendered = render_command(Path::new(&program), &[], &args);
    let out = tokio::task::spawn_blocking(move || {
        let mut command = std::process::Command::new(&program);
        command.env("PATH", &path);
        command.args(&args);
        command.output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let stdout = tail_lines(&String::from_utf8_lossy(&out.stdout), max_lines);
    let stderr = tail_lines(&String::from_utf8_lossy(&out.stderr), max_lines);
    Ok((out.status.success(), rendered, stdout, stderr))
}

fn tail_lines(s: &str, max: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(max);
    lines[start..].join("\n").trim().to_string()
}

fn tail_vec_lines(lines: &[String], max: usize) -> String {
    let start = lines.len().saturating_sub(max);
    lines[start..].join("\n").trim().to_string()
}

async fn pump_spotiflac_output<R>(
    app: tauri::AppHandle,
    stream: &'static str,
    reader: R,
    lines: Arc<tokio::sync::Mutex<Vec<String>>>,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut reader = tokio::io::BufReader::new(reader).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        let line = line.trim_end().to_string();
        if line.is_empty() {
            continue;
        }
        let _ = app.emit(
            SPOTIFLAC_OUTPUT_EVENT,
            MusicSpotiFlacOutput {
                stream: stream.to_string(),
                line: line.clone(),
                completed_files: None,
            },
        );
        let mut out = lines.lock().await;
        out.push(line);
        if out.len() > 240 {
            let drop_n = out.len() - 240;
            out.drain(0..drop_n);
        }
    }
}

fn current_music_file_set(root: &Path) -> HashSet<String> {
    export::scan(root)
        .into_iter()
        .filter(|item| item.kind == "audio" && item.media_type == "music")
        .map(|item| item.path)
        .collect()
}

async fn emit_spotiflac_completed_files(
    app: &tauri::AppHandle,
    output_dir: &Path,
    baseline: &HashSet<String>,
) {
    let count = current_music_file_set(output_dir)
        .into_iter()
        .filter(|path| !baseline.contains(path))
        .count();
    let _ = app.emit(
        SPOTIFLAC_OUTPUT_EVENT,
        MusicSpotiFlacOutput {
            stream: "meta".to_string(),
            line: String::new(),
            completed_files: Some(count),
        },
    );
}

async fn watch_spotiflac_completed_files(
    app: tauri::AppHandle,
    output_dir: PathBuf,
    baseline: HashSet<String>,
    mut stop: tokio::sync::oneshot::Receiver<()>,
) {
    let mut interval = tokio::time::interval(Duration::from_millis(700));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_count = usize::MAX;
    loop {
        tokio::select! {
            _ = &mut stop => {
                emit_spotiflac_completed_files(&app, &output_dir, &baseline).await;
                break;
            }
            _ = interval.tick() => {
                let count = current_music_file_set(&output_dir)
                    .into_iter()
                    .filter(|path| !baseline.contains(path))
                    .count();
                if count != last_count {
                    last_count = count;
                    let _ = app.emit(
                        SPOTIFLAC_OUTPUT_EVENT,
                        MusicSpotiFlacOutput {
                            stream: "meta".to_string(),
                            line: String::new(),
                            completed_files: Some(count),
                        },
                    );
                }
            }
        }
    }
}

fn normalize_service(service: &str) -> String {
    let value = service.trim().to_ascii_lowercase();
    match value.as_str() {
        "tidal" | "qobuz" | "deezer" | "amazon" | "apple" | "soundcloud" | "youtube" | "pandora" | "joox"
        | "netease" | "migu" | "kuwo" => value,
        _ => "youtube".to_string(),
    }
}

#[tauri::command]
fn music_spotiflac_status(info: tauri::State<'_, AppInfo>) -> MusicSpotiFlacStatus {
    let output_dir = music_output_dir(info.inner()).display().to_string();
    match resolve_spotiflac() {
        Some(cmd) => MusicSpotiFlacStatus {
            available: true,
            command: Some(cmd.program.display().to_string()),
            output_dir,
            hint: None,
        },
        None => MusicSpotiFlacStatus {
            available: false,
            command: None,
            output_dir,
            hint: Some(
                "Install SpotiFLAC so GhostWire can launch `spotiflac` (for example: `pipx install SpotiFLAC` or `python3 -m pip install --user SpotiFLAC`)."
                    .to_string(),
            ),
        },
    }
}

#[tauri::command]
async fn music_spotiflac_download(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
    url: String,
    service: String,
    quality: Option<String>,
) -> Result<MusicSpotiFlacResult, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("Paste a music URL first.".to_string());
    }

    let cmd = resolve_spotiflac().ok_or_else(|| {
        "SpotiFLAC CLI not found. Install it first, then relaunch GhostWire if you opened the app from Finder.".to_string()
    })?;
    let output_dir = music_output_dir(info.inner());
    std::fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    let baseline_files = current_music_file_set(&output_dir);
    let service = normalize_service(&service);

    let mut args = vec![
        url,
        output_dir.display().to_string(),
        "--service".to_string(),
        service.clone(),
        "--quality".to_string(),
        quality.unwrap_or_else(|| "LOSSLESS".to_string()).trim().to_string(),
        "--use-artist-subfolders".to_string(),
        "--use-album-subfolders".to_string(),
        "--use-album-track-numbers".to_string(),
        "--first-artist-only".to_string(),
        "--filename-format".to_string(),
        "{track}. {title}".to_string(),
        "--verbose".to_string(),
    ];
    let mut tidal_api_mode = "spotiflac_public";
    if let Some(tidal_api) = catalog.get_setting("spotiflac_tidal_api").filter(|s| !s.trim().is_empty()) {
        tidal_api_mode = "custom";
        args.push("--tidal-api".to_string());
        args.push(tidal_api.trim().to_string());
    } else if service == "tidal" {
        let _ = app.emit(
            SPOTIFLAC_OUTPUT_EVENT,
            MusicSpotiFlacOutput {
                stream: "meta".to_string(),
                line: "Using SpotiFLAC community TIDAL API pool (no account login required).".to_string(),
                completed_files: None,
            },
        );
    }
    let rendered = render_command(&cmd.program, &cmd.fixed_args, &args);
    let program = cmd.program.clone();
    let fixed_args = cmd.fixed_args.clone();

    let _ = app.emit(
        SPOTIFLAC_OUTPUT_EVENT,
        MusicSpotiFlacOutput {
            stream: "meta".to_string(),
            line: format!("Running: {rendered}"),
            completed_files: None,
        },
    );

    let (progress_stop_tx, progress_stop_rx) = tokio::sync::oneshot::channel::<()>();
    let progress_task = tokio::spawn(watch_spotiflac_completed_files(
        app.clone(),
        output_dir.clone(),
        baseline_files.clone(),
        progress_stop_rx,
    ));

    let mut command = tokio::process::Command::new(&program);
    command.args(&fixed_args);
    command.args(&args);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            let _ = progress_stop_tx.send(());
            let _ = progress_task.await;
            return Err(err.to_string());
        }
    };

    let stdout_lines = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    let stderr_lines = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));

    let stdout_task = child.stdout.take().map(|stdout| {
        let app = app.clone();
        let lines = stdout_lines.clone();
        tokio::spawn(async move {
            pump_spotiflac_output(app, "stdout", stdout, lines).await;
        })
    });
    let stderr_task = child.stderr.take().map(|stderr| {
        let app = app.clone();
        let lines = stderr_lines.clone();
        tokio::spawn(async move {
            pump_spotiflac_output(app, "stderr", stderr, lines).await;
        })
    });

    let status = child.wait().await;
    if let Some(task) = stdout_task {
        let _ = task.await;
    }
    if let Some(task) = stderr_task {
        let _ = task.await;
    }

    let stdout = {
        let lines = stdout_lines.lock().await;
        tail_vec_lines(&lines, 120)
    };
    let stderr = {
        let lines = stderr_lines.lock().await;
        tail_vec_lines(&lines, 120)
    };
    let _ = progress_stop_tx.send(());
    let _ = progress_task.await;
    let completed_files = current_music_file_set(&output_dir)
        .into_iter()
        .filter(|path| !baseline_files.contains(path))
        .count();
    let status = status.map_err(|e| e.to_string())?;
    if !status.success() {
        let mut detail = if !stderr.is_empty() {
            stderr.clone()
        } else if !stdout.is_empty() {
            stdout.clone()
        } else {
            format!("SpotiFLAC exited with status {:?}.", status.code())
        };
        if tidal_error_is_missing_bearer(&detail) {
            detail = format!("{}\n{}", detail, tidal_missing_bearer_hint(tidal_api_mode));
        }
        if spotify_clienttoken_unauthorized(&detail) {
            detail = format!("{}\n{}", detail, spotify_clienttoken_hint());
        }
        return Err(format!("SpotiFLAC failed. {detail}"));
    }
    if completed_files == 0 {
        let mut detail = if !stderr.is_empty() {
            stderr.clone()
        } else if !stdout.is_empty() {
            stdout.clone()
        } else {
            "SpotiFLAC exited successfully, but GhostWire did not see any completed music files written to disk.".to_string()
        };
        if tidal_error_is_missing_bearer(&detail) {
            detail = format!("{}\n{}", detail, tidal_missing_bearer_hint(tidal_api_mode));
        }
        if spotify_clienttoken_unauthorized(&detail) {
            detail = format!("{}\n{}", detail, spotify_clienttoken_hint());
        }
        return Err(format!(
            "SpotiFLAC finished but saved no new music files in {}. {}",
            output_dir.display(),
            detail
        ));
    }

    invalidate_scan(&cache);
    Ok(MusicSpotiFlacResult {
        command: rendered,
        output_dir: output_dir.display().to_string(),
        stdout,
        stderr,
    })
}

// ============================================================================
// Persistent music-import queue.
//
// Spotify (and other music-service) collection links — playlists, albums,
// artists, single tracks — are queued here and downloaded via SpotiFLAC by a
// single background worker. Jobs are persisted to `data_dir/music-imports.json`
// so a large import resumes automatically after an app restart (SpotiFLAC skips
// tracks already on disk, so re-running a collection only fetches what's missing).
// The frontend surfaces these as cards on the Downloads page.
// ============================================================================

const MUSIC_IMPORTS_EVENT: &str = "music-imports://state";

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MusicImportJob {
    id: String,
    url: String,
    /// playlist | album | artist | track | link
    kind: String,
    title: String,
    service: String,
    quality: String,
    total: Option<u32>,
    completed: u32,
    /// queued | downloading | done | error
    state: String,
    error: Option<String>,
    created_at: i64,
    /// Cover art for the playlist/album/artist (Spotify CDN URL).
    #[serde(default)]
    artwork_url: Option<String>,
    /// Short label under the title, e.g. "Spotify playlist".
    #[serde(default)]
    subtitle: Option<String>,
    /// Most recently written track, surfaced as live progress detail.
    #[serde(default)]
    current_track: Option<String>,
}

struct MusicImportManager {
    jobs: tokio::sync::Mutex<Vec<MusicImportJob>>,
    notify: tokio::sync::Notify,
    persist_path: PathBuf,
    app: tauri::AppHandle,
}

impl MusicImportManager {
    async fn snapshot(&self) -> Vec<MusicImportJob> {
        self.jobs.lock().await.clone()
    }

    /// Write the current job list to disk and broadcast it to the frontend.
    async fn persist_and_emit(&self) {
        let jobs = self.jobs.lock().await.clone();
        if let Ok(json) = serde_json::to_string_pretty(&jobs) {
            let _ = std::fs::write(&self.persist_path, json);
        }
        let _ = self.app.emit(MUSIC_IMPORTS_EVENT, &jobs);
    }
}

fn load_music_import_jobs(path: &Path) -> Vec<MusicImportJob> {
    let Ok(data) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut jobs: Vec<MusicImportJob> = serde_json::from_str(&data).unwrap_or_default();
    // Anything left "downloading" when the app was last closed is requeued so the
    // worker picks it back up on launch.
    for job in jobs.iter_mut() {
        if job.state == "downloading" {
            job.state = "queued".to_string();
            job.error = None;
            job.current_track = None;
        }
    }
    jobs
}

fn music_import_random_id() -> String {
    let mut buf = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn detect_music_import_kind(url: &str) -> &'static str {
    let u = url.to_ascii_lowercase();
    if u.contains("/playlist/") || u.contains("spotify:playlist:") {
        "playlist"
    } else if u.contains("/album/") || u.contains("spotify:album:") {
        "album"
    } else if u.contains("/artist/") || u.contains("spotify:artist:") {
        "artist"
    } else if u.contains("/track/") || u.contains("spotify:track:") {
        "track"
    } else {
        "link"
    }
}

fn default_music_import_title(kind: &str) -> String {
    match kind {
        "playlist" => "Spotify playlist",
        "album" => "Spotify album",
        "artist" => "Spotify artist",
        "track" => "Spotify track",
        _ => "Music import",
    }
    .to_string()
}

/// Human label for a `kind`, shown as the card subtitle.
fn music_import_kind_label(kind: &str) -> String {
    match kind {
        "playlist" => "Spotify playlist",
        "album" => "Spotify album",
        "artist" => "Spotify artist",
        "track" => "Spotify track",
        _ => "Music link",
    }
    .to_string()
}

/// Derive a clean "Artist — Title" label from a downloaded file path so the card can
/// show what just landed. Strips the leading track number and file extension.
fn music_track_label_from_path(path: &str) -> String {
    let p = Path::new(path);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim();
    // Strip a leading track number like "01. ", "01 - ", "1) ".
    let title = {
        let bytes = stem.as_bytes();
        let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
        if digits > 0 && digits < stem.len() {
            stem[digits..]
                .trim_start_matches(['.', ')', '-', ' '])
                .trim()
        } else {
            stem
        }
    };
    // Artist subfolder sits two levels up: Music/<Artist>/<Album>/<track>.
    let artist = p
        .parent()
        .and_then(|album| album.parent())
        .and_then(|artist| artist.file_name())
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|a| !a.is_empty() && *a != "Music");
    match artist {
        Some(a) => format!("{a} — {title}"),
        None => title.to_string(),
    }
}

/// Scan for the newest new file (by mtime) and report the running count + its label.
fn music_import_progress_detail(
    root: &Path,
    baseline: &HashSet<String>,
) -> (u32, Option<String>) {
    let mut count = 0u32;
    let mut newest: Option<(SystemTime, String)> = None;
    for path in current_music_file_set(root) {
        if baseline.contains(&path) {
            continue;
        }
        count += 1;
        if let Ok(modified) = std::fs::metadata(&path).and_then(|m| m.modified()) {
            if newest.as_ref().map_or(true, |(t, _)| modified > *t) {
                newest = Some((modified, path.clone()));
            }
        }
    }
    (count, newest.map(|(_, p)| music_track_label_from_path(&p)))
}

/// Best-effort friendly title, track count, and cover art for a queued import. Tries
/// the authed playlist manifest (covers private playlists) plus the public embed scrape
/// (cover art + totals for albums/artists/editorial playlists).
async fn music_import_preview(
    catalog: &Catalog,
    url: &str,
    kind: &str,
) -> (String, Option<u32>, Option<String>) {
    let mut title = default_music_import_title(kind);
    let mut total = None;
    let mut artwork = None;

    if kind == "playlist" {
        if let Ok((name, tracks)) = crate::spotify::fetch_playlist_for(catalog, url).await {
            if !name.trim().is_empty() {
                title = name;
            }
            total = Some(tracks.len() as u32);
        }
    }

    // Embed scrape fills in cover art (and name/total when the manifest path missed).
    // Covers playlists/albums/artists *and* single tracks — the track embed exposes the
    // song's cover art too, so importing a single should show its artwork like the rest.
    if matches!(kind, "playlist" | "album" | "artist" | "track") {
        if let Ok((name, cover, embed_total)) = crate::spotify::fetch_embed_meta(url, kind).await {
            if title == default_music_import_title(kind) && !name.trim().is_empty() {
                title = name;
            }
            if total.is_none() {
                total = embed_total;
            }
            artwork = cover;
        }
    }

    (title, total, artwork)
}

/// Drain a child process pipe, keeping a rolling tail for error reporting.
async fn drain_import_lines<R>(reader: R, lines: Arc<tokio::sync::Mutex<Vec<String>>>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut reader = tokio::io::BufReader::new(reader).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        let line = line.trim_end().to_string();
        if line.is_empty() {
            continue;
        }
        let mut out = lines.lock().await;
        out.push(line);
        if out.len() > 240 {
            let drop_n = out.len() - 240;
            out.drain(0..drop_n);
        }
    }
}

/// Run SpotiFLAC for one queued import, updating `job.completed` as files land.
/// Returns the number of new files written on success.
async fn run_music_import_job(
    manager: &Arc<MusicImportManager>,
    id: &str,
    url: &str,
    service: &str,
    quality: &str,
) -> Result<u32, String> {
    let app = manager.app.clone();

    let output_dir = {
        let info = app.state::<AppInfo>();
        music_output_dir(info.inner())
    };
    std::fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    let baseline_files = current_music_file_set(&output_dir);

    let cmd = resolve_spotiflac().ok_or_else(|| {
        "SpotiFLAC CLI not found. Install it first, then relaunch GhostWire if you opened the app from Finder.".to_string()
    })?;
    let service = normalize_service(service);
    let quality = if quality.trim().is_empty() {
        "LOSSLESS".to_string()
    } else {
        quality.trim().to_string()
    };

    let mut args = vec![
        url.to_string(),
        output_dir.display().to_string(),
        "--service".to_string(),
        service.clone(),
        "--quality".to_string(),
        quality,
        "--use-artist-subfolders".to_string(),
        "--use-album-subfolders".to_string(),
        "--use-album-track-numbers".to_string(),
        "--first-artist-only".to_string(),
        "--filename-format".to_string(),
        "{track}. {title}".to_string(),
        "--verbose".to_string(),
    ];
    let mut tidal_api_mode = "spotiflac_public";
    {
        let catalog = app.state::<Catalog>();
        if let Some(tidal_api) = catalog
            .get_setting("spotiflac_tidal_api")
            .filter(|s| !s.trim().is_empty())
        {
            tidal_api_mode = "custom";
            args.push("--tidal-api".to_string());
            args.push(tidal_api.trim().to_string());
        }
    }
    let program = cmd.program.clone();
    let fixed_args = cmd.fixed_args.clone();

    // Poll the output folder and reflect file counts into the job's progress.
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let progress_manager = Arc::clone(manager);
    let progress_id = id.to_string();
    let progress_dir = output_dir.clone();
    let progress_baseline = baseline_files.clone();
    let progress_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(800));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last = u32::MAX;
        let mut last_track: Option<String> = None;
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = interval.tick() => {
                    let (count, track) =
                        music_import_progress_detail(&progress_dir, &progress_baseline);
                    if count != last || track != last_track {
                        last = count;
                        last_track = track.clone();
                        {
                            let mut jobs = progress_manager.jobs.lock().await;
                            if let Some(job) = jobs.iter_mut().find(|j| j.id == progress_id) {
                                job.completed = count.max(job.completed);
                                if track.is_some() {
                                    job.current_track = track.clone();
                                }
                            }
                        }
                        progress_manager.persist_and_emit().await;
                    }
                }
            }
        }
    });

    let mut command = tokio::process::Command::new(&program);
    command.args(&fixed_args);
    command.args(&args);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            let _ = stop_tx.send(());
            let _ = progress_task.await;
            return Err(err.to_string());
        }
    };

    let stdout_lines = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    let stderr_lines = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    let stdout_task = child.stdout.take().map(|stdout| {
        let lines = stdout_lines.clone();
        tokio::spawn(async move { drain_import_lines(stdout, lines).await })
    });
    let stderr_task = child.stderr.take().map(|stderr| {
        let lines = stderr_lines.clone();
        tokio::spawn(async move { drain_import_lines(stderr, lines).await })
    });

    let status = child.wait().await;
    if let Some(task) = stdout_task {
        let _ = task.await;
    }
    if let Some(task) = stderr_task {
        let _ = task.await;
    }
    let _ = stop_tx.send(());
    let _ = progress_task.await;

    let stdout = {
        let lines = stdout_lines.lock().await;
        tail_vec_lines(&lines, 120)
    };
    let stderr = {
        let lines = stderr_lines.lock().await;
        tail_vec_lines(&lines, 120)
    };

    let completed = current_music_file_set(&output_dir)
        .into_iter()
        .filter(|p| !baseline_files.contains(p))
        .count() as u32;

    let build_detail = |fallback: &str| -> String {
        let mut detail = if !stderr.is_empty() {
            stderr.clone()
        } else if !stdout.is_empty() {
            stdout.clone()
        } else {
            fallback.to_string()
        };
        if tidal_error_is_missing_bearer(&detail) {
            detail = format!("{}\n{}", detail, tidal_missing_bearer_hint(tidal_api_mode));
        }
        if spotify_clienttoken_unauthorized(&detail) {
            detail = format!("{}\n{}", detail, spotify_clienttoken_hint());
        }
        detail
    };

    let status = status.map_err(|e| e.to_string())?;
    if !status.success() {
        // A non-zero exit that still wrote files is treated as a partial success so
        // the queue can move on; the user can re-run to fill any gaps.
        if completed > 0 {
            invalidate_scan(app.state::<ScanCache>().inner());
            return Ok(completed);
        }
        let detail = build_detail(&format!("SpotiFLAC exited with status {:?}.", status.code()));
        return Err(format!("SpotiFLAC failed. {detail}"));
    }
    if completed == 0 {
        let detail = build_detail(
            "SpotiFLAC exited successfully, but no new music files were written to disk.",
        );
        return Err(format!("SpotiFLAC finished but saved no new files. {detail}"));
    }

    invalidate_scan(app.state::<ScanCache>().inner());
    Ok(completed)
}

/// Background worker: processes queued imports one at a time, forever.
async fn music_import_worker(manager: Arc<MusicImportManager>) {
    loop {
        let next_id = {
            let jobs = manager.jobs.lock().await;
            jobs.iter()
                .find(|j| j.state == "queued")
                .map(|j| j.id.clone())
        };
        let Some(id) = next_id else {
            manager.notify.notified().await;
            continue;
        };

        let target = {
            let mut jobs = manager.jobs.lock().await;
            match jobs.iter_mut().find(|j| j.id == id) {
                Some(job) => {
                    job.state = "downloading".to_string();
                    job.error = None;
                    Some((job.url.clone(), job.service.clone(), job.quality.clone()))
                }
                None => None,
            }
        };
        let Some((url, service, quality)) = target else {
            continue;
        };
        manager.persist_and_emit().await;

        let result = run_music_import_job(&manager, &id, &url, &service, &quality).await;

        {
            let mut jobs = manager.jobs.lock().await;
            if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
                match &result {
                    Ok(count) => {
                        job.completed = (*count).max(job.completed);
                        if job.total.is_none() {
                            job.total = Some(job.completed);
                        }
                        job.state = "done".to_string();
                        job.error = None;
                        job.current_track = None;
                    }
                    Err(err) => {
                        job.state = "error".to_string();
                        job.error = Some(err.clone());
                    }
                }
            }
        }
        manager.persist_and_emit().await;
    }
}

#[tauri::command]
async fn music_import_enqueue(
    manager: tauri::State<'_, Arc<MusicImportManager>>,
    catalog: tauri::State<'_, Catalog>,
    url: String,
) -> Result<MusicImportJob, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("Paste a music link first.".to_string());
    }
    let kind = detect_music_import_kind(&url);
    let (title, total, artwork_url) = music_import_preview(catalog.inner(), &url, kind).await;
    let job = MusicImportJob {
        id: format!("import-{}", music_import_random_id()),
        url,
        kind: kind.to_string(),
        title,
        service: "youtube".to_string(),
        quality: "LOSSLESS".to_string(),
        total,
        completed: 0,
        state: "queued".to_string(),
        error: None,
        created_at: now_unix_secs(),
        artwork_url,
        subtitle: Some(music_import_kind_label(kind)),
        current_track: None,
    };
    {
        let mut jobs = manager.jobs.lock().await;
        jobs.push(job.clone());
    }
    manager.persist_and_emit().await;
    manager.notify.notify_one();
    Ok(job)
}

#[tauri::command]
async fn music_imports_list(
    manager: tauri::State<'_, Arc<MusicImportManager>>,
) -> Result<Vec<MusicImportJob>, String> {
    Ok(manager.snapshot().await)
}

#[tauri::command]
async fn music_import_remove(
    manager: tauri::State<'_, Arc<MusicImportManager>>,
    id: String,
) -> Result<(), String> {
    {
        let mut jobs = manager.jobs.lock().await;
        // Leave an actively-downloading job in place (its process keeps running).
        jobs.retain(|j| j.id != id || j.state == "downloading");
    }
    manager.persist_and_emit().await;
    Ok(())
}

#[tauri::command]
async fn music_import_retry(
    manager: tauri::State<'_, Arc<MusicImportManager>>,
    id: String,
) -> Result<(), String> {
    {
        let mut jobs = manager.jobs.lock().await;
        if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
            job.state = "queued".to_string();
            job.error = None;
        }
    }
    manager.persist_and_emit().await;
    manager.notify.notify_one();
    Ok(())
}

#[tauri::command]
async fn music_spotiflac_install() -> Result<MusicSpotiFlacInstallResult, String> {
    if resolve_spotiflac().is_some() {
        let command = resolve_spotiflac()
            .and_then(|cmd| Some(cmd.program.display().to_string()))
            .unwrap_or_else(|| "spotiflac".to_string());
        return Ok(MusicSpotiFlacInstallResult {
            command,
            resolved_command: resolve_spotiflac().map(|cmd| cmd.program.display().to_string()),
            stdout: "SpotiFLAC is already installed.".to_string(),
            stderr: String::new(),
        });
    }

    let path = system_path_for_installs();
    let mut failures = Vec::new();

    if find_bin("pipx").is_none() {
        if let Some(brew) = find_bin("brew") {
            let (ok, rendered, stdout, stderr) = run_install_capture(
                brew.display().to_string(),
                vec!["install".to_string(), "pipx".to_string()],
                path.clone(),
                40,
            )
            .await?;
            if !ok {
                let detail = if !stderr.is_empty() {
                    stderr
                } else if !stdout.is_empty() {
                    stdout
                } else {
                    "exit status unknown".to_string()
                };
                failures.push(format!("{rendered}: {detail}"));
            }
        }
    }

    let attempts = install_attempts();
    if attempts.is_empty() {
        return Err("Couldn't find `pipx` or `python3`, so GhostWire can't install SpotiFLAC automatically on this machine.".to_string());
    }

    for (program, args) in attempts {
        let (ok, rendered, stdout, stderr) = run_install_capture(program, args, path.clone(), 40).await?;
        if ok {
            let resolved = resolve_spotiflac().map(|cmd| cmd.program.display().to_string());
            return Ok(MusicSpotiFlacInstallResult {
                command: rendered,
                resolved_command: resolved,
                stdout,
                stderr,
            });
        }
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "exit status unknown".to_string()
        };
        failures.push(format!("{rendered}: {detail}"));
    }

    Err(format!("Couldn't install SpotiFLAC automatically. {}", failures.join(" | ")))
}

/// Look up posters/overviews for un-enriched items via TMDB (needs `tmdb_key`).
#[tauri::command]
async fn enrich_catalog(catalog: tauri::State<'_, Catalog>) -> Result<usize, String> {
    let key = catalog
        .get_setting("tmdb_key")
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| "Set a TMDB API key in Settings first".to_string())?;
    let todo = catalog.items_needing_poster(40).map_err(|e| format!("{e:#}"))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut enriched = 0usize;
    for (id, title) in todo {
        if let Ok(Some(e)) = enrich::enrich_title(&client, &key, &title).await {
            let had_poster = e.poster.is_some();
            let _ = catalog.set_enrichment(&id, e.poster.as_deref(), e.description.as_deref(), e.year);
            if had_poster {
                enriched += 1;
            }
        }
    }
    Ok(enriched)
}

// ---- local LLM + artwork library ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    organized: usize,
    posters: usize,
    remaining: i64,
    ai_used: bool,
    model: Option<String>,
}

/// Report whether the local Ollama daemon is up and which models are installed.
#[tauri::command]
async fn ai_status() -> ai::AiStatus {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .unwrap_or_default();
    ai::status(&client).await
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PosterResult {
    found: usize,
    scanned: usize,
    remaining: i64,
    used_keys: bool,
}

/// Fetch cover art for items missing a poster — keyless-first (IMDb for movies/TV,
/// iTunes for music), falling back to TMDB/OMDb when the user has added keys. Fast
/// (no local LLM), so it can run automatically as results come in. Returns a summary.
#[tauri::command]
async fn fetch_posters(
    catalog: tauri::State<'_, Catalog>,
    info: tauri::State<'_, AppInfo>,
    limit: Option<i64>,
) -> Result<PosterResult, String> {
    let limit = limit.unwrap_or(60).clamp(1, 300);
    let art_dir = std::path::PathBuf::from(&info.data_dir).join("artwork");
    std::fs::create_dir_all(&art_dir).ok();
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let tmdb = catalog.get_setting("tmdb_key").filter(|k| !k.trim().is_empty());
    let omdb = catalog.get_setting("omdb_key").filter(|k| !k.trim().is_empty());

    let todo = catalog.items_needing_poster(limit).map_err(|e| format!("{e:#}"))?;
    let scanned = todo.len();
    let mut found = 0usize;
    for (id, title) in todo {
        let year = posters::year_from_title(&title);
        let kind = posters::guess_kind(&title);
        let clean = posters::clean_for_query(&title, kind);
        let Some(url) =
            posters::find_poster(&http, &clean, year, kind, tmdb.as_deref(), omdb.as_deref()).await
        else {
            continue;
        };
        // Cache to disk and serve from /art; fall back to the remote URL if the
        // download fails (still better than no poster).
        let stored = if artwork::cache_image(&http, &url, &art_dir, &id).await.unwrap_or(false) {
            format!("http://127.0.0.1:{}/art/{}", engine::STREAM_PORT, id)
        } else {
            url
        };
        let _ = catalog.set_enrichment(&id, Some(&stored), None, year);
        found += 1;
    }
    let remaining = catalog.count_needing_poster().unwrap_or(0);
    Ok(PosterResult {
        found,
        scanned,
        remaining,
        used_keys: tmdb.is_some() || omdb.is_some(),
    })
}

// ---- TV series finder (keyless TVMaze metadata) ----

fn web_client() -> Result<reqwest::Client, String> {
    // One shared, cached client so callers reuse a single connection pool (TLS sessions + keep-alive)
    // instead of building a fresh client — and dropping its pool — on every command. reqwest::Client
    // is an Arc internally, so cloning is cheap and shares the pool.
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    Ok(CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent("Mozilla/5.0")
                .timeout(std::time::Duration::from_secs(15))
                .connect_timeout(std::time::Duration::from_secs(8))
                .build()
                .unwrap_or_default()
        })
        .clone())
}

/// A movie/show details digest (overview, IMDb/RT ratings, genres, runtime, cast,
/// poster/backdrop, YouTube trailer key) fetched from the relay, which resolves it
/// from TMDB/OMDb and caches it server-side — keyless and read-only.
#[tauri::command]
async fn movie_digest(kind: String, title: String, year: Option<i64>) -> Result<posters::MovieDigest, String> {
    let client = web_client()?;
    let clean = posters::clean_for_query(&title, &kind);
    let yr = year.or_else(|| posters::year_from_title(&title));
    posters::fetch_details(&client, &clean, yr, &kind).await.map_err(|e| format!("{e:#}"))
}

/// The curated featured carousel (movies/shows, each a full digest) from the relay.
#[tauri::command]
async fn featured() -> Result<Vec<posters::MovieDigest>, String> {
    let client = web_client()?;
    posters::fetch_featured(&client).await.map_err(|e| format!("{e:#}"))
}

/// Search TVMaze for shows matching `query` (the real series catalog).
#[tauri::command]
async fn tv_search(query: String) -> Result<Vec<tvmaze::TvShow>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    tvmaze::search_shows(&web_client()?, q).await.map_err(|e| format!("{e:#}"))
}

/// Every episode of a TVMaze show, in order — so the finder can list seasons/episodes.
#[tauri::command]
async fn tv_episodes(show_id: i64) -> Result<Vec<tvmaze::TvEpisode>, String> {
    tvmaze::episodes(&web_client()?, show_id).await.map_err(|e| format!("{e:#}"))
}

/// Lowercase + collapse to alphanumeric words — the join key shared with the frontend
/// `norm()` so cached anime verdicts line up with the show titles the Anime tab sends.
fn norm_title(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// TVMaze-backed anime classification for downloaded show titles, cached in settings so
/// repeat calls are instant. Returns the subset of `titles` TVMaze tags with the **Anime**
/// genre. This catches anime the local release-name heuristic can't — once a file is
/// organized its fansub tag is stripped, and a show like "The Apothecary Diaries" carries
/// no anime marker in its name; the genre lives only on TVMaze. Read-only, keyless.
#[tauri::command]
async fn classify_anime(
    catalog: tauri::State<'_, Catalog>,
    titles: Vec<String>,
) -> Result<Vec<String>, String> {
    use std::collections::HashMap;
    // Persistent verdict cache: norm(title) -> is-anime. Only successful lookups are cached,
    // so a transient TVMaze hiccup retries next time instead of sticking a false negative.
    let mut cache: HashMap<String, bool> = catalog
        .get_setting("anime_classify")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let client = web_client()?;
    let mut out = Vec::new();
    // Decide cached titles instantly; collect the misses to probe TVMaze in parallel rather
    // than one-at-a-time (N sequential ~500ms calls made the Anime tab crawl on a fresh library).
    let mut to_probe: Vec<(String, String)> = Vec::new();
    for t in &titles {
        let key = norm_title(t);
        if key.is_empty() {
            continue;
        }
        match cache.get(&key) {
            Some(&true) => out.push(t.clone()),
            Some(&false) => {}
            None => to_probe.push((t.clone(), key)),
        }
    }
    let mut set: tokio::task::JoinSet<(String, String, Option<bool>)> = tokio::task::JoinSet::new();
    for (t, key) in to_probe {
        let client = client.clone();
        set.spawn(async move {
            // Don't let one slow/down TVMaze request stall the batch (default timeout is ~30s).
            let v = match tokio::time::timeout(std::time::Duration::from_secs(6), tvmaze::search_shows(&client, &t)).await {
                Ok(Ok(shows)) => {
                    let best = shows.iter().find(|s| norm_title(&s.name) == key).or_else(|| shows.first());
                    Some(best.map(|s| s.genres.iter().any(|g| g.eq_ignore_ascii_case("anime"))).unwrap_or(false))
                }
                // Timeout or network/parse error — leave uncached so it's retried next time.
                _ => None,
            };
            (t, key, v)
        });
    }
    let mut dirty = false;
    while let Some(res) = set.join_next().await {
        if let Ok((t, key, Some(v))) = res {
            cache.insert(key, v);
            dirty = true;
            if v {
                out.push(t);
            }
        }
    }
    if dirty {
        if let Ok(j) = serde_json::to_string(&cache) {
            let _ = catalog.set_setting("anime_classify", &j);
        }
    }
    Ok(out)
}

// ---- Music discovery (keyless iTunes metadata) ----

/// Search iTunes for recording artists matching `query` (the artist finder).
#[tauri::command]
async fn music_search_artists(query: String) -> Result<Vec<music::Artist>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    music::search_artists(&web_client()?, q).await.map_err(|e| format!("{e:#}"))
}

/// An artist's albums, newest first — so the finder can lay out the discography.
#[tauri::command]
async fn music_artist_albums(artist_id: i64) -> Result<Vec<music::Album>, String> {
    music::artist_albums(&web_client()?, artist_id).await.map_err(|e| format!("{e:#}"))
}

/// Every track on an album, in order — so the finder can list songs to source.
#[tauri::command]
async fn music_album_tracks(album_id: i64) -> Result<Vec<music::Track>, String> {
    music::album_tracks(&web_client()?, album_id).await.map_err(|e| format!("{e:#}"))
}

/// A YouTube trailer key for a show via TMDB (needs `tmdb_key`). Returns None if
/// there's no key or no trailer — the UI just hides the trailer in that case.
#[tauri::command]
async fn tv_trailer(
    catalog: tauri::State<'_, Catalog>,
    title: String,
    year: Option<i64>,
) -> Result<Option<String>, String> {
    let Some(key) = catalog.get_setting("tmdb_key").filter(|k| !k.trim().is_empty()) else {
        return Ok(None);
    };
    let client = web_client()?;
    // 1. Resolve the TMDB tv id (year-filtered so the right show wins).
    let mut params: Vec<(&str, String)> = vec![("api_key", key.clone()), ("query", title)];
    if let Some(y) = year {
        params.push(("first_air_date_year", y.to_string()));
    }
    let search: serde_json::Value = client
        .get("https://api.themoviedb.org/3/search/tv")
        .query(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let Some(id) = search["results"].get(0).and_then(|r| r["id"].as_i64()) else {
        return Ok(None);
    };
    // 2. Pick the best YouTube trailer (official trailer → trailer → teaser → any).
    let vids: serde_json::Value = client
        .get(format!("https://api.themoviedb.org/3/tv/{id}/videos"))
        .query(&[("api_key", key.as_str())])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let arr = vids["results"].as_array().cloned().unwrap_or_default();
    let yt = |v: &serde_json::Value| v["site"].as_str() == Some("YouTube");
    let pick = arr
        .iter()
        .find(|v| yt(v) && v["type"].as_str() == Some("Trailer") && v["official"].as_bool() == Some(true))
        .or_else(|| arr.iter().find(|v| yt(v) && v["type"].as_str() == Some("Trailer")))
        .or_else(|| arr.iter().find(|v| yt(v) && v["type"].as_str() == Some("Teaser")))
        .or_else(|| arr.iter().find(|v| yt(v)))
        .and_then(|v| v["key"].as_str().map(|s| s.to_string()));
    Ok(pick)
}

/// Scanned items joined with their AI/artwork metadata — the Library view.
#[tauri::command]
fn list_library(catalog: tauri::State<'_, Catalog>) -> Result<Vec<catalog::LibraryItem>, String> {
    catalog.list_library(500).map_err(|e| format!("{e:#}"))
}

// ---- manual poster overrides (right-click → Replace poster) ----

/// Candidate poster URLs for a title (keyless IMDb + iTunes) — the picker grid.
#[tauri::command]
async fn poster_candidates(title: String, kind: Option<String>) -> Vec<String> {
    let Ok(client) = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()
    else {
        return Vec::new();
    };
    let inferred = kind
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .unwrap_or_else(|| posters::guess_kind(&title));
    posters::candidates(&client, &title, inferred).await
}

/// Set a manual poster for everything matching `title`. Caches the chosen image and
/// records the override (keyed by normalized title). Returns the local art URL.
#[tauri::command]
async fn set_poster(
    catalog: tauri::State<'_, Catalog>,
    info: tauri::State<'_, AppInfo>,
    title: String,
    url: String,
) -> Result<String, String> {
    let key = norm_title(&title);
    if key.is_empty() || url.trim().is_empty() {
        return Err("Missing title or image.".into());
    }
    let art_dir = std::path::PathBuf::from(&info.data_dir).join("artwork");
    std::fs::create_dir_all(&art_dir).ok();
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut h);
    let name = format!("ovr-{:x}", h.finish());

    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let stored = if artwork::cache_image(&http, &url, &art_dir, &name).await.unwrap_or(false) {
        format!("http://127.0.0.1:{}/art/{}", engine::STREAM_PORT, name)
    } else {
        url
    };
    catalog.set_poster_override(&key, &stored).map_err(|e| format!("{e:#}"))?;
    Ok(stored)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PosterOverride {
    title: String,
    url: String,
}

/// All manual poster overrides (normalized title → url) for the UI to overlay.
#[tauri::command]
fn list_poster_overrides(catalog: tauri::State<'_, Catalog>) -> Vec<PosterOverride> {
    catalog
        .list_poster_overrides()
        .unwrap_or_default()
        .into_iter()
        .map(|(title, url)| PosterOverride { title, url })
        .collect()
}

// ---- local Library (content downloaded to disk) ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadedItem {
    id: String,
    title: String,
    file_name: String,
    kind: String,       // "video" | "audio" | "book" | "game"
    media_type: String, // "movie" | "show" | "music" | "book" | "game"
    season: Option<i64>,
    episode: Option<i64>,
    /// Embedded audio tags (music only) — the Music view groups by these, since the
    /// path no longer carries artist/album once a file is flattened into the library.
    artist: Option<String>,
    album: Option<String>,
    /// Embedded genre tag (music only) — the Music view groups albums by it.
    genre: Option<String>,
    track_no: Option<i64>,
    /// Embedded album artwork (music only), served from the local /art cache.
    artwork_url: Option<String>,
    size_bytes: i64,
    /// File mtime as epoch seconds — drives the "Recently added" feed.
    added_at: i64,
    /// Loopback URL the player can stream the local file from (with HTTP Range).
    url: String,
    /// True once the user has curated it into the Library; otherwise it lives,
    /// "unsorted", under Downloads.
    in_library: bool,
}

/// Everything downloaded is in the Library by default; "Remove from library" hides a
/// file (it stays on disk, reappears under Downloads to re-add) without deleting it —
/// that's "Move to Trash". So we persist the OPT-OUT set of removed ids (relative
/// paths), as a JSON array in settings — survives restarts, no schema migration.
fn removed_set(catalog: &Catalog) -> HashSet<String> {
    catalog
        .get_setting("library_removed")
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

fn save_removed_set(catalog: &Catalog, set: &HashSet<String>) {
    let v: Vec<&String> = set.iter().collect();
    if let Ok(json) = serde_json::to_string(&v) {
        let _ = catalog.set_setting("library_removed", &json);
    }
}

/// Restore a removed item to the Library (un-hide).
#[tauri::command]
fn add_to_library(
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
    id: String,
) -> Result<(), String> {
    let mut s = removed_set(&catalog);
    s.remove(&id);
    save_removed_set(&catalog, &s);
    invalidate_scan(&cache); // in_library flag changed
    Ok(())
}

/// Hide an item from the Library (keeps the file on disk).
#[tauri::command]
fn remove_from_library(
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
    id: String,
) -> Result<(), String> {
    let mut s = removed_set(&catalog);
    s.insert(id);
    save_removed_set(&catalog, &s);
    invalidate_scan(&cache); // in_library flag changed
    Ok(())
}

/// Reveal a downloaded file in Finder (by its relative-path id).
#[tauri::command]
fn reveal_path(info: tauri::State<'_, AppInfo>, id: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&info.download_dir).join(&id);
    std::process::Command::new("open")
        .arg("-R")
        .arg(&p)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Scan a downloaded file or folder (by its relative-path id) for risky content — disguised
/// double-extension files (`song.mp3.exe`) and executables. Local + filename-only, so it's
/// instant and private. Path-guarded to the download folder.
#[tauri::command]
fn scan_safety(info: tauri::State<'_, AppInfo>, id: String) -> Result<safety::SafetyReport, String> {
    let root = std::path::PathBuf::from(&info.download_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let target = root.join(&id).canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(&root) {
        return Err("Refusing to scan a path outside the download folder.".to_string());
    }
    Ok(safety::scan_path(&target))
}

/// Move a downloaded file to the Trash (recoverable) and drop it from the Library.
/// Path-guarded to the download folder so nothing outside it can be touched.
#[tauri::command]
fn trash_downloaded(
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
    id: String,
) -> Result<(), String> {
    let root = std::path::PathBuf::from(&info.download_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let target = root.join(&id).canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(&root) {
        return Err("Refusing to trash a file outside the download folder.".to_string());
    }
    let path = target.display().to_string().replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("tell application \"Finder\" to delete POSIX file \"{path}\"");
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    // Drop any "removed" flag so a future re-download starts back in the Library.
    let mut s = removed_set(&catalog);
    s.remove(&id);
    save_removed_set(&catalog, &s);
    // Drop the index row now so the file disappears immediately (don't wait for the watcher to
    // reconcile the deletion). The disk-relative `id` is exactly the index key.
    catalog.delete_library_files(std::slice::from_ref(&id)).ok();
    invalidate_scan(&cache); // file gone from disk
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClearResult {
    removed_active: usize,
    trashed: usize,
}

/// Clear Downloads: stop & drop every active transfer (wiping partials), then move every
/// on-disk file that ISN'T in the Library to the Trash (recoverable). The curated Library
/// is kept untouched. Empty leftover folders are swept.
#[tauri::command]
async fn clear_downloads(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
) -> Result<ClearResult, String> {
    let removed_active = match app_engine(&app) {
        Some(engine) => engine.clear().await,
        None => 0,
    };

    let root = std::path::PathBuf::from(&info.download_dir);
    let removed = removed_set(&catalog);
    // On-disk media files removed from the Library (the "unsorted" shelf) — these get trashed.
    let mut victims: Vec<std::path::PathBuf> = Vec::new();
    let mut victim_rels: Vec<String> = Vec::new();
    for e in export::scan(&root) {
        let abs = std::path::PathBuf::from(&e.path);
        if let Ok(stripped) = abs.strip_prefix(&root) {
            let rel = stripped.to_string_lossy().replace('\\', "/");
            if removed.contains(&rel) {
                victim_rels.push(rel);
                victims.push(abs);
            }
        }
    }

    let root2 = root.clone();
    let trashed = tokio::task::spawn_blocking(move || {
        let n = trash_files(&victims);
        sweep_empty_dirs(&root2);
        n
    })
    .await
    .map_err(|e| e.to_string())?;

    // Drop the trashed files' index rows now so they don't linger in the cache until the
    // background reconcile catches up; the nudge still runs to sweep anything missed.
    catalog.delete_library_files(&victim_rels).ok();
    invalidate_scan(&cache); // files trashed off disk
    nudge_indexer(&app); // reconcile now so the trashed rows leave the index promptly
    Ok(ClearResult { removed_active, trashed })
}

/// Batch-move files to the Trash via Finder (one AppleScript call, falling back to
/// per-file so one locked file can't abort the batch). Returns how many were moved.
fn trash_files(paths: &[std::path::PathBuf]) -> usize {
    if paths.is_empty() {
        return 0;
    }
    let list = paths
        .iter()
        .map(|p| format!("POSIX file \"{}\"", applescript_escape(p)))
        .collect::<Vec<_>>()
        .join(", ");
    let script = format!("tell application \"Finder\" to delete {{{list}}}");
    let ok = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if ok {
        paths.len()
    } else {
        paths
            .iter()
            .filter(|p| {
                let s = format!("tell application \"Finder\" to delete POSIX file \"{}\"", applescript_escape(p));
                std::process::Command::new("osascript").arg("-e").arg(&s).output().map(|o| o.status.success()).unwrap_or(false)
            })
            .count()
    }
}

fn applescript_escape(p: &std::path::Path) -> String {
    p.display().to_string().replace('\\', "\\\\").replace('"', "\\\"")
}

/// Remove now-empty leftover folders under `root` (bottom-up; `remove_dir` only deletes
/// empty dirs, so folders that still hold Library files are never touched).
fn sweep_empty_dirs(root: &std::path::Path) {
    let mut dirs = Vec::new();
    collect_dirs(root, 0, &mut dirs);
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = std::fs::remove_dir(&d);
    }
}

fn collect_dirs(dir: &std::path::Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_dirs(&p, depth + 1, out);
            out.push(p);
        }
    }
}

/// Percent-encode each path segment so spaces / unicode survive the loopback URL.
fn enc_path(rel: &str) -> String {
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

/// In-memory TTL cache over the (recursive, disk-walking) library scan. Every media tab
/// re-runs `list_downloaded` on mount, so without this a Library→Movies→Music sweep
/// re-walks the same folder several times. Invalidated explicitly on any mutation
/// (add/remove/trash/clear/organize), plus filesystem watch events.
#[derive(Clone)]
struct ScanCache(Arc<Mutex<Option<(Vec<DownloadedItem>, Instant)>>>);
const SCAN_TTL: Duration = Duration::from_secs(60);
const PERF_EVENT_CAP: usize = 240;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BackendPerfEvent {
    at: i64,
    name: String,
    duration_ms: f64,
    detail: String,
}

#[derive(Default)]
struct BackendPerfData {
    cache_hits: u64,
    cache_misses: u64,
    scan_runs: u64,
    last_scan_ms: f64,
    max_scan_ms: f64,
    total_scan_ms: f64,
    last_item_count: usize,
    events: VecDeque<BackendPerfEvent>,
}

#[derive(Clone)]
struct BackendPerfState(Arc<Mutex<BackendPerfData>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BackendPerfSnapshot {
    cache_hits: u64,
    cache_misses: u64,
    scan_runs: u64,
    avg_scan_ms: f64,
    max_scan_ms: f64,
    last_scan_ms: f64,
    last_item_count: usize,
    events: Vec<BackendPerfEvent>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BackendScanBench {
    iterations: usize,
    item_count: usize,
    min_ms: f64,
    avg_ms: f64,
    max_ms: f64,
    samples_ms: Vec<f64>,
}

fn backend_perf_push(perf: &BackendPerfState, name: &str, duration_ms: f64, detail: impl Into<String>) {
    if let Ok(mut p) = perf.0.lock() {
        p.events.push_front(BackendPerfEvent {
            at: now_ms(),
            name: name.to_string(),
            duration_ms,
            detail: detail.into(),
        });
        while p.events.len() > PERF_EVENT_CAP {
            p.events.pop_back();
        }
    }
}

fn backend_perf_record_scan(perf: &BackendPerfState, scan_ms: f64, item_count: usize) {
    if let Ok(mut p) = perf.0.lock() {
        p.scan_runs += 1;
        p.last_scan_ms = scan_ms;
        p.max_scan_ms = p.max_scan_ms.max(scan_ms);
        p.total_scan_ms += scan_ms;
        p.last_item_count = item_count;
    }
}

/// "Does this title have any torrent across the user's sources?" — keyed by search query,
/// with a TTL. The shared semaphore caps how many live probes run at once so opening a
/// Discover tab (which checks dozens of titles) doesn't hammer the indexers. Backs the
/// `check_availability` command / the Discover "gray out what you can't get" treatment.
#[derive(Clone)]
struct AvailabilityState {
    cache: Arc<Mutex<HashMap<String, (bool, Instant)>>>,
    sem: Arc<tokio::sync::Semaphore>,
}
const AVAIL_TTL: Duration = Duration::from_secs(6 * 3600);

/// A "the library on disk may have changed, please re-reconcile" doorbell for the background
/// indexer. Triggered by the FS watcher (and, for snappy UX, mutation handlers). The indexer
/// thread waits on the condvar, so triggers while it's busy coalesce into one extra pass.
pub(crate) struct IndexerSignal {
    dirty: Mutex<bool>,
    cv: std::sync::Condvar,
}

impl IndexerSignal {
    fn new() -> Self {
        IndexerSignal { dirty: Mutex::new(false), cv: std::sync::Condvar::new() }
    }
    /// Ring the doorbell — the indexer will reconcile (debounced).
    pub(crate) fn trigger(&self) {
        let mut d = self.dirty.lock().unwrap_or_else(|e| e.into_inner());
        *d = true;
        self.cv.notify_one();
    }
    /// Block until the doorbell rings, then clear it.
    fn wait_dirty(&self) {
        let mut d = self.dirty.lock().unwrap_or_else(|e| e.into_inner());
        while !*d {
            d = self.cv.wait(d).unwrap_or_else(|e| e.into_inner());
        }
        *d = false;
    }
    fn clear(&self) {
        *self.dirty.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }
}

/// Nudge the background indexer from anywhere with an `AppHandle` (mutation handlers, download
/// completion). Best-effort: a no-op if the indexer isn't running yet.
pub(crate) fn nudge_indexer(app: &tauri::AppHandle) {
    if let Some(sig) = app.try_state::<Arc<IndexerSignal>>() {
        sig.trigger();
    }
}

/// Start an FSEvents watcher on the download folder. When files land there — a download
/// finishing, the organize pass, anything — it rings the indexer's doorbell so the persistent
/// index reconciles and the UI is told to refresh. Debounced so a torrent writing many chunks
/// coalesces into one pass. Source-agnostic: it only knows "files changed on disk".
fn start_library_watcher(dir: PathBuf, signal: Arc<IndexerSignal>) {
    use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult};
    let mut debouncer = match new_debouncer(Duration::from_secs(2), move |res: DebounceEventResult| {
        if res.is_ok() {
            signal.trigger();
        }
    }) {
        Ok(d) => d,
        Err(_) => return,
    };
    if debouncer.watcher().watch(&dir, RecursiveMode::Recursive).is_ok() {
        // Keep the watcher alive for the app's lifetime (dropping it stops watching).
        std::mem::forget(debouncer);
    }
}

/// The background Library indexer. Reconciles the persistent `library_files` index against disk
/// on launch, then on every doorbell ring (FS watcher / mutations), so `list_downloaded` reads an
/// up-to-date index instead of walking the disk on the foreground. After a reconcile that changed
/// anything, it invalidates the in-memory scan cache and emits `library://changed` to refresh the
/// UI. Runs on its own thread — the reconcile (disk walk + tag reads) is blocking.
fn start_library_indexer(
    app: tauri::AppHandle,
    info: AppInfo,
    catalog: Catalog,
    cache: ScanCache,
    signal: Arc<IndexerSignal>,
) {
    use tauri::Emitter;
    // Run one reconcile, catching any panic (a bad tag parse, etc.) so it can't kill the worker —
    // a dead indexer would freeze the index forever (list_downloaded keeps serving stale rows and
    // never falls back to a live scan). Returns (upserted, deleted), or (0,0) on panic.
    fn safe_reconcile(info: &AppInfo, catalog: &Catalog) -> (usize, usize) {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            reconcile_library_index(info, catalog)
        })) {
            Ok(counts) => counts,
            Err(_) => {
                eprintln!("[indexer] reconcile panicked; continuing (index left as-is this pass)");
                (0, 0)
            }
        }
    }
    std::thread::spawn(move || {
        // Initial reconcile on launch — warms the index (or seeds it on first-ever run).
        let _ = safe_reconcile(&info, &catalog);
        invalidate_scan(&cache);
        let _ = app.emit("library://changed", ());
        loop {
            signal.wait_dirty();
            // Coalesce a burst of triggers (a download writing many files) into one reconcile.
            std::thread::sleep(Duration::from_millis(800));
            signal.clear();
            let (up, del) = safe_reconcile(&info, &catalog);
            if up > 0 || del > 0 {
                invalidate_scan(&cache);
                let _ = app.emit("library://changed", ());
            }
        }
    });
}

fn invalidate_scan(cache: &ScanCache) {
    if let Ok(mut g) = cache.0.lock() {
        *g = None;
    }
    // The playlist resolver keeps its own cached audio-file index; drop it on the same
    // signals so a just-downloaded song is matchable in playlists immediately.
    playlist::invalidate_audio_index();
}

fn music_artwork_id(rel: &str, size_bytes: i64, added_at: i64) -> String {
    let mut h = Sha256::new();
    h.update(rel.as_bytes());
    h.update(b":");
    h.update(size_bytes.to_le_bytes());
    h.update(b":");
    h.update(added_at.to_le_bytes());
    format!("music-{:x}", h.finalize())
}

fn cached_music_artwork_url(
    art_dir: &std::path::Path,
    rel: &str,
    size_bytes: i64,
    added_at: i64,
    bytes: &[u8],
) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let id = music_artwork_id(rel, size_bytes, added_at);
    let path = art_dir.join(&id);
    if path.exists() {
        if path.is_file() {
            return Some(format!("http://127.0.0.1:{}/art/{id}", engine::STREAM_PORT));
        }
        return None;
    }
    std::fs::write(&path, bytes)
        .ok()
        .map(|_| format!("http://127.0.0.1:{}/art/{id}", engine::STREAM_PORT))
}

/// The actual disk walk + parse (uncached). Kept separate so the command can cache it.
/// `pub(crate)` so the LAN engine server (`engine.rs`) can serve the same Library scan
/// to a linked iPad in companion mode.
/// Per-file audio-tag cache so a library re-scan doesn't re-parse lofty tags for UNCHANGED files —
/// that re-parse (for ~1700 files) was the dominant cost of `scan_downloaded` (~2.9s), and the
/// file watcher was firing it constantly. Keyed by relpath; a changed size or mtime (added_at)
/// misses and re-reads. Stores metadata only (artwork bytes are materialized to /artwork on the
/// first read, after which `include_artwork` is false anyway).
type CachedAudioTags = (Option<String>, Option<String>, Option<String>, Option<i64>, Option<String>);
fn audio_tag_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, (i64, i64, CachedAudioTags)>> {
    static C: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, (i64, i64, CachedAudioTags)>>,
    > = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// The loopback URL the player streams a local file from. Cheap + volatile (depends on whether
/// ffmpeg is available this session), so it's recomputed at read time rather than indexed.
/// Video the webview can't decode (mkv, avi, …) is served via on-the-fly HLS transcode;
/// everything else (web-native video, audio) is served raw with HTTP Range.
fn entry_url(info: &AppInfo, rel: &str) -> String {
    if info.ffmpeg_available && engine::local_transcodes(rel) {
        format!("http://127.0.0.1:{}/localhls/{}/index.m3u8", engine::STREAM_PORT, engine::hls_token(rel))
    } else {
        format!("http://127.0.0.1:{}/file/{}", engine::STREAM_PORT, enc_path(rel))
    }
}

/// Do the expensive enrichment for one on-disk file → an index row (no `url`/`in_library`, which
/// are recomputed at read time). For audio this reads embedded tags (artist/album/track/title) and
/// materializes cover art; both are cached so an unchanged file isn't re-parsed. Shared by the live
/// scan and the background indexer.
fn enrich_row(e: &export::Exportable, rel: &str, art_dir: &std::path::Path) -> LibraryFileRow {
    let abs = std::path::PathBuf::from(&e.path);
    // For music, if we've already materialized cover art in /artwork, reuse it and skip
    // extracting picture bytes from tags (the expensive part of tag parsing).
    let cached_artwork_url = if e.kind == "audio" {
        let id = music_artwork_id(rel, e.size_bytes as i64, e.added_at);
        let path = art_dir.join(&id);
        if path.is_file() {
            Some(format!("http://127.0.0.1:{}/art/{id}", engine::STREAM_PORT))
        } else {
            None
        }
    } else {
        None
    };
    // For audio, embedded tags are the source of truth for artist/album/track/title — but
    // re-parsing them every scan is what made the watcher storm hurt. Reuse a cached parse when
    // the file's size + mtime are unchanged (the common case).
    let (artist, album, genre, track_no, tag_title, embedded_art) = if e.kind == "audio" {
        let sz = e.size_bytes as i64;
        let cached = {
            let c = audio_tag_cache().lock().unwrap_or_else(|p| p.into_inner());
            c.get(rel)
                .filter(|(csz, cat, _)| *csz == sz && *cat == e.added_at)
                .map(|(_, _, tags)| tags.clone())
        };
        if let Some((artist, album, genre, track_no, tag_title)) = cached {
            (artist, album, genre, track_no, tag_title, None)
        } else {
            let t = metadata::read_audio_tags(&abs, cached_artwork_url.is_none());
            audio_tag_cache().lock().unwrap_or_else(|p| p.into_inner()).insert(
                rel.to_string(),
                (sz, e.added_at, (t.0.clone(), t.1.clone(), t.2.clone(), t.3, t.4.clone())),
            );
            t
        }
    } else {
        (None, None, None, None, None, None)
    };
    let artwork_url = cached_artwork_url.or_else(|| {
        embedded_art.as_deref().and_then(|bytes| {
            cached_music_artwork_url(art_dir, rel, e.size_bytes as i64, e.added_at, bytes)
        })
    });
    LibraryFileRow {
        rel_path: rel.to_string(),
        size_bytes: e.size_bytes as i64,
        added_at: e.added_at,
        kind: e.kind.clone(),
        media_type: e.media_type.clone(),
        season: e.season,
        episode: e.episode,
        title: tag_title.unwrap_or_else(|| e.title.clone()),
        file_name: e.file_name.clone(),
        artist,
        album,
        genre,
        track_no,
        artwork_url,
    }
}

/// Turn an index row into the wire `DownloadedItem`, filling the read-time fields: `url` (depends
/// on this session's ffmpeg) and `in_library` (from the removed-from-library opt-out set).
fn row_to_item(r: LibraryFileRow, info: &AppInfo, removed: &HashSet<String>) -> DownloadedItem {
    let url = entry_url(info, &r.rel_path);
    DownloadedItem {
        in_library: !removed.contains(&r.rel_path),
        id: r.rel_path,
        title: r.title,
        file_name: r.file_name,
        kind: r.kind,
        media_type: r.media_type,
        season: r.season,
        episode: r.episode,
        artist: r.artist,
        album: r.album,
        genre: r.genre,
        track_no: r.track_no,
        artwork_url: r.artwork_url,
        size_bytes: r.size_bytes,
        added_at: r.added_at,
        url,
    }
}

/// The live disk walk + enrich (uncached, no index). The cold-start fallback for `list_downloaded`
/// and the data source the LAN engine serves to a linked iPad. `pub(crate)` so `engine.rs` can call it.
pub(crate) fn scan_downloaded(info: &AppInfo, catalog: &Catalog) -> Vec<DownloadedItem> {
    let root = std::path::PathBuf::from(&info.download_dir);
    let art_dir = std::path::PathBuf::from(&info.data_dir).join("artwork");
    std::fs::create_dir_all(&art_dir).ok();
    let removed = removed_set(catalog);
    export::scan(&root)
        .into_par_iter()
        .filter_map(|e| {
            let abs = std::path::PathBuf::from(&e.path);
            let rel = abs.strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/");
            let row = enrich_row(&e, &rel, &art_dir);
            Some(row_to_item(row, info, &removed))
        })
        .collect()
}

/// Reconcile the persistent `library_files` index against what's actually on disk. Cheap disk walk
/// (`export::scan` — read_dir + stat, bounded), then a delta: only files whose size or mtime differ
/// from the indexed stamp (or are brand new) get the expensive enrich; files gone from disk are
/// deleted. Returns (upserted, deleted). Run on a background thread — the walk + tag reads block.
fn reconcile_library_index(info: &AppInfo, catalog: &Catalog) -> (usize, usize) {
    let root = std::path::PathBuf::from(&info.download_dir);
    let art_dir = std::path::PathBuf::from(&info.data_dir).join("artwork");
    std::fs::create_dir_all(&art_dir).ok();

    // Pair each on-disk entry with its disk-relative path (the index key).
    let with_rel: Vec<(export::Exportable, String)> = export::scan(&root)
        .into_iter()
        .filter_map(|e| {
            let abs = std::path::PathBuf::from(&e.path);
            let rel = abs.strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/");
            Some((e, rel))
        })
        .collect();
    let on_disk: HashSet<&str> = with_rel.iter().map(|(_, rel)| rel.as_str()).collect();

    // Guard against a transient unreadable root (e.g. an external drive mid-mount) wiping the
    // whole index: an empty walk only prunes rows when the root genuinely reads as empty.
    if with_rel.is_empty() && std::fs::read_dir(&root).is_err() {
        return (0, 0);
    }

    let stamps = catalog.library_file_stamps().unwrap_or_default();
    // New or changed files (size or mtime differs) — enrich in parallel.
    let changed: Vec<LibraryFileRow> = with_rel
        .par_iter()
        .filter(|(e, rel)| match stamps.get(rel) {
            Some((sz, at)) => *sz != e.size_bytes as i64 || *at != e.added_at,
            None => true,
        })
        .map(|(e, rel)| enrich_row(e, rel, &art_dir))
        .collect();
    // Indexed rows whose file no longer exists on disk. CRITICAL: `export::scan` is capped
    // (it stops collecting past a bound), so "not in the capped walk" does NOT prove the file is
    // gone — a file beyond the cap is absent from `on_disk` yet still on disk. Before pruning a
    // row we therefore stat its actual path and only delete it when it genuinely doesn't exist.
    // This keeps a large (> cap) library from silently losing rows, and lets the index accumulate
    // coverage across reconciles instead of churning.
    let gone: Vec<String> = stamps
        .keys()
        .filter(|k| !on_disk.contains(k.as_str()))
        .filter(|k| !root.join(k.as_str()).exists())
        .cloned()
        .collect();

    let upserted = changed.len();
    let deleted = gone.len();
    catalog.upsert_library_files(&changed, now_ms()).ok();
    catalog.delete_library_files(&gone).ok();
    (upserted, deleted)
}

/// Everything downloaded to disk, parsed into movies / shows / music / books / games with a ready-to-play
/// loopback URL. This is the Library — your local content, independent of the live session.
/// Served from an in-memory cache so rapid tab-switching doesn't re-walk the disk.
#[tauri::command]
fn list_downloaded(
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
    perf: tauri::State<'_, BackendPerfState>,
) -> Vec<DownloadedItem> {
    let started = Instant::now();
    if let Ok(g) = cache.0.lock() {
        if let Some((items, at)) = g.as_ref() {
            if at.elapsed() < SCAN_TTL {
                if let Ok(mut p) = perf.0.lock() {
                    p.cache_hits += 1;
                }
                backend_perf_push(
                    perf.inner(),
                    "list_downloaded.cache_hit",
                    started.elapsed().as_secs_f64() * 1000.0,
                    format!("items={} age_ms={}", items.len(), at.elapsed().as_millis()),
                );
                return items.clone();
            }
        }
    }
    if let Ok(mut p) = perf.0.lock() {
        p.cache_misses += 1;
    }
    // Warm path: the background indexer has populated `library_files`, so read it (instant — no
    // disk walk, no tag reads) and fill the read-time fields. Cold path (first-ever launch, before
    // the indexer's first reconcile): fall back to a live scan; the indexer seeds the index for next
    // time. `in_library`/`url` are recomputed here so the index never goes stale on a library
    // remove or an ffmpeg-availability change.
    let from_index = catalog.count_library_files().map(|n| n > 0).unwrap_or(false);
    let items = if from_index {
        let removed = removed_set(catalog.inner());
        catalog
            .list_library_files()
            .unwrap_or_default()
            .into_iter()
            .map(|r| row_to_item(r, info.inner(), &removed))
            .collect::<Vec<_>>()
    } else {
        scan_downloaded(info.inner(), catalog.inner())
    };
    let scan_ms = started.elapsed().as_secs_f64() * 1000.0;
    backend_perf_record_scan(perf.inner(), scan_ms, items.len());
    backend_perf_push(
        perf.inner(),
        if from_index { "list_downloaded.index_read" } else { "list_downloaded.cold_scan" },
        scan_ms,
        format!("items={} src={}", items.len(), if from_index { "index" } else { "scan" }),
    );
    if let Ok(mut g) = cache.0.lock() {
        *g = Some((items.clone(), Instant::now()));
    }
    items
}

/// Cached scan of downloaded items for internal callers that only have an `AppHandle`
/// (e.g. the social layer enriching share metadata). Reuses the same TTL cache as the
/// `list_downloaded` command so we don't re-read tags on every friend browse/search.
pub(crate) fn cached_downloaded(app: &tauri::AppHandle) -> Vec<DownloadedItem> {
    let (Some(info), Some(catalog), Some(cache)) = (
        app.try_state::<AppInfo>(),
        app.try_state::<Catalog>(),
        app.try_state::<ScanCache>(),
    ) else {
        return Vec::new();
    };
    if let Ok(g) = cache.0.lock() {
        if let Some((items, at)) = g.as_ref() {
            if at.elapsed() < SCAN_TTL {
                return items.clone();
            }
        }
    }
    let items = scan_downloaded(info.inner(), catalog.inner());
    if let Ok(mut g) = cache.0.lock() {
        *g = Some((items.clone(), Instant::now()));
    }
    items
}

#[tauri::command]
fn perf_backend_snapshot(perf: tauri::State<'_, BackendPerfState>) -> BackendPerfSnapshot {
    if let Ok(p) = perf.0.lock() {
        let avg_scan_ms = if p.scan_runs > 0 {
            p.total_scan_ms / p.scan_runs as f64
        } else {
            0.0
        };
        return BackendPerfSnapshot {
            cache_hits: p.cache_hits,
            cache_misses: p.cache_misses,
            scan_runs: p.scan_runs,
            avg_scan_ms,
            max_scan_ms: p.max_scan_ms,
            last_scan_ms: p.last_scan_ms,
            last_item_count: p.last_item_count,
            events: p.events.iter().cloned().collect(),
        };
    }
    BackendPerfSnapshot {
        cache_hits: 0,
        cache_misses: 0,
        scan_runs: 0,
        avg_scan_ms: 0.0,
        max_scan_ms: 0.0,
        last_scan_ms: 0.0,
        last_item_count: 0,
        events: Vec::new(),
    }
}

#[tauri::command]
fn perf_backend_clear(perf: tauri::State<'_, BackendPerfState>) {
    if let Ok(mut p) = perf.0.lock() {
        *p = BackendPerfData::default();
    }
}

/// Fixed path for the live perf-session trace, so a developer (or an agent driving the app) can
/// `tail`/read the JSONL stream WHILE manually navigating — not just a one-shot export. Each line
/// is one frontend PerfEvent. macOS/Linux dev tool; /tmp is world-writable on both.
const PERF_SESSION_PATH: &str = "/tmp/ghostwire-perf.jsonl";

#[tauri::command]
fn perf_session_start() -> Result<String, String> {
    std::fs::write(PERF_SESSION_PATH, b"").map_err(|e| e.to_string())?;
    Ok(PERF_SESSION_PATH.to_string())
}

#[tauri::command]
fn perf_session_append(lines: Vec<String>) -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(PERF_SESSION_PATH)
        .map_err(|e| e.to_string())?;
    for line in lines {
        let _ = writeln!(f, "{line}");
    }
    Ok(())
}

#[tauri::command]
async fn perf_backend_scan_bench(
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    perf: tauri::State<'_, BackendPerfState>,
    iterations: Option<u32>,
) -> Result<BackendScanBench, String> {
    let iter = iterations.unwrap_or(4).clamp(1, 10) as usize;
    let info = info.inner().clone();
    let catalog = catalog.inner().clone();
    let samples = tokio::task::spawn_blocking(move || {
        let mut samples = Vec::with_capacity(iter);
        let mut item_count = 0usize;
        for _ in 0..iter {
            let started = Instant::now();
            let items = scan_downloaded(&info, &catalog);
            item_count = items.len();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        (samples, item_count)
    })
    .await
    .map_err(|e| e.to_string())?;

    let (samples_ms, item_count) = samples;
    let min_ms = samples_ms.iter().copied().fold(f64::INFINITY, f64::min);
    let max_ms = samples_ms.iter().copied().fold(0.0f64, f64::max);
    let avg_ms = if samples_ms.is_empty() {
        0.0
    } else {
        samples_ms.iter().sum::<f64>() / samples_ms.len() as f64
    };
    backend_perf_push(
        perf.inner(),
        "scan_bench.run",
        avg_ms,
        format!("iterations={iter} min_ms={min_ms:.1} max_ms={max_ms:.1} items={item_count}"),
    );
    Ok(BackendScanBench {
        iterations: iter,
        item_count,
        min_ms: if min_ms.is_finite() { min_ms } else { 0.0 },
        avg_ms,
        max_ms,
        samples_ms,
    })
}

// ---- removable-device music sync (MP3 players / SD cards) ----

/// Connected removable volumes the user could sync music onto. `folder_name` is the sync
/// folder to report existing-track counts for (defaults to "Music"). The Library's own
/// volume is excluded so you can't sync the source onto itself.
#[tauri::command]
async fn list_devices(
    info: tauri::State<'_, AppInfo>,
    folder_name: Option<String>,
) -> Result<Vec<devices::Device>, String> {
    let root = std::path::PathBuf::from(&info.download_dir);
    let folder = folder_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Music")
        .to_string();
    tokio::task::spawn_blocking(move || devices::list(&root, &folder))
        .await
        .map_err(|e| e.to_string())
}

/// If a device-relative path is already taken this sync, append " (2)" etc. so two tracks
/// (e.g. two "Unknown Artist/Untitled.mp3") never clobber each other on the card.
fn dedupe_rel(taken: &mut std::collections::BTreeSet<String>, rel: String) -> String {
    if taken.insert(rel.clone()) {
        return rel;
    }
    let (stem, ext) = rel.rsplit_once('.').unwrap_or((rel.as_str(), ""));
    for n in 2..1000 {
        let cand = if ext.is_empty() {
            format!("{stem} ({n})")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        if taken.insert(cand.clone()) {
            return cand;
        }
    }
    rel
}

/// Sync the Library's music onto a removable device into `<mount>/<folder_name>`, laid out
/// as `Artist/Album/NN - Title.ext` from each file's tags. Copies only new/changed tracks
/// (same-size files are skipped); when `mirror` is set, audio on the device that's no longer
/// in the Library is deleted and emptied folders pruned (non-audio user files are never
/// touched). When `playlists` is set, the app's playlists are also written into a `Playlists/`
/// folder at the device root — as `.m3u8` files referencing the synced tracks (no duplication)
/// or, in "folders" mode, as folders of copied tracks (for players that can't read .m3u).
/// Streams a per-file `device-sync://progress` step to the UI.
#[tauri::command]
async fn sync_music_to_device(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    mount_path: String,
    folder_name: Option<String>,
    mirror: Option<bool>,
    playlists: Option<bool>,
    playlist_mode: Option<String>,
) -> Result<devices::SyncResult, String> {
    use tauri::Emitter;
    let mount = std::path::PathBuf::from(&mount_path);
    if !mount.is_dir() {
        return Err(format!("{mount_path} is not connected."));
    }
    let folder = folder_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Music")
        .to_string();
    let root = std::path::PathBuf::from(&info.download_dir);
    let info = info.inner().clone();
    let catalog = catalog.inner().clone();
    let mirror = mirror.unwrap_or(false);
    let do_playlists = playlists.unwrap_or(false);
    let playlist_mode = playlist_mode.unwrap_or_else(|| "m3u8".to_string());
    tokio::task::spawn_blocking(move || {
        // The on-device layout comes from each track's tags (artist/album/title/track), so the
        // card matches the desktop Library regardless of where the source file actually sits.
        let mut taken: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let files: Vec<devices::SyncFile> = scan_downloaded(&info, &catalog)
            .into_iter()
            .filter(|i| i.kind == "audio" && i.in_library)
            .filter_map(|i| {
                let src = root.join(&i.id);
                if !src.is_file() {
                    return None;
                }
                let ext = i.file_name.rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_default();
                let rel = devices::music_rel(i.artist.as_deref(), i.album.as_deref(), &i.title, i.track_no, &ext);
                Some(devices::SyncFile {
                    src,
                    rel: dedupe_rel(&mut taken, rel),
                    size: i.size_bytes.max(0) as u64,
                })
            })
            .collect();

        let dest_root = mount.join(&folder);
        let app_music = app.clone();
        let mut result = devices::sync(&files, &dest_root, mirror, move |step| {
            let _ = app_music.emit("device-sync://progress", &step);
        });

        // Optionally write the app's playlists into <device>/Playlists/, mapping each
        // playlist track to the synced copy on the card by its source path.
        if do_playlists {
            use std::collections::HashMap;
            let by_src: HashMap<std::path::PathBuf, (String, u64)> =
                files.iter().map(|f| (f.src.clone(), (f.rel.clone(), f.size))).collect();

            let mut specs: Vec<devices::PlaylistSpec> = Vec::new();
            for mut pl in playlist::list(&info.data_dir) {
                // Make sure tracks point at their local files (paths aren't always persisted).
                playlist::resolve_paths(&info.download_dir, &mut pl);
                let entries: Vec<devices::PlaylistEntry> = pl
                    .tracks
                    .iter()
                    .filter_map(|t| {
                        let path = t.path.as_ref()?;
                        // Only tracks that actually live on the device are included.
                        let (rel, size) = by_src.get(&std::path::PathBuf::from(path))?;
                        Some(devices::PlaylistEntry {
                            src: std::path::PathBuf::from(path),
                            device_rel: rel.clone(),
                            title: t.title.clone(),
                            artist: t.artist.clone(),
                            duration_secs: (t.duration_ms / 1000).max(0),
                            size: *size,
                        })
                    })
                    .collect();
                if !entries.is_empty() {
                    specs.push(devices::PlaylistSpec { name: pl.name.clone(), entries });
                }
            }

            let mode = devices::PlaylistMode::parse(&playlist_mode);
            let app_pl = app.clone();
            let pres = devices::sync_playlists(&specs, &mount, &folder, mode, move |step| {
                let _ = app_pl.emit("device-sync://progress", &step);
            });
            result.playlists_written = pres.playlists_written;
            result.playlist_tracks = pres.entries_written;
            result.errors += pres.errors;
            result.bytes_copied += pres.bytes_copied;
            // Folder-mode playlist track copies are real file copies (emitted as "copied"
            // steps), so fold them into the run's copied total — keeps the live tally and the
            // final summary in agreement.
            result.copied += pres.tracks_copied;
        }

        result
    })
    .await
    .map_err(|e| e.to_string())
}

/// The model the AI tasks should use: the user's `ollama_model` override when it is
/// actually installed, otherwise the best auto-pick. None when Ollama is offline.
async fn resolve_model(catalog: &Catalog, client: &reqwest::Client) -> Option<String> {
    let status = ai::status(client).await;
    if let Some(pref) = catalog.get_setting("ollama_model").filter(|m| !m.trim().is_empty()) {
        if status.models.iter().any(|m| *m == pref) {
            return Some(pref);
        }
    }
    status.model
}

/// Incrementally organize the download folder into a separate `Organized/` library —
/// one file at a time, moved as it is processed, so a crash or stop resumes without
/// redoing finished files (organized files leave the source tree). Streams a per-file
/// `organize://progress` step to the UI.
#[tauri::command]
async fn organize_run(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
    // Music is already nested into Artist/Album by SpotiFLAC, so the auto-cleanup pass
    // passes false to leave it alone; a manual Organize defaults to including it.
    include_music: Option<bool>,
) -> Result<organize::OrganizeResult, String> {
    use tauri::Emitter;
    let root = std::path::PathBuf::from(&info.download_dir);
    let organized = root.join("Library");
    let llm = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let model = resolve_model(catalog.inner(), &llm).await;
    let app_idx = app.clone();
    let res = organize::run(&root, &organized, &llm, model.as_deref(), include_music.unwrap_or(true), move |step| {
        let _ = app.emit("organize://progress", &step);
    })
    .await;
    invalidate_scan(&cache); // files moved on disk
    nudge_indexer(&app_idx); // reconcile the index against the new organized paths
    Ok(res)
}

fn organize_progress(phase: &str, done: usize, total: usize) -> serde_json::Value {
    serde_json::json!({ "phase": phase, "done": done, "total": total })
}

// ---- Library de-duplication (exact pass + AI-judged near-duplicate pass) ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DedupeDup {
    id: String,
    name: String,
    album: String,
    size_bytes: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DedupeGroup {
    /// id (relpath) of the copy to keep.
    keep: String,
    keep_name: String,
    keep_album: String,
    keep_size: i64,
    /// The redundant copies (proposed for the Trash).
    duplicates: Vec<DedupeDup>,
    reason: String,
    /// "exact" (same artist+album+title) or "near" (AI-judged across releases).
    kind: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DedupeResult {
    root: String,
    groups: Vec<DedupeGroup>,
    removed: usize,
    bytes_freed: i64,
    errors: usize,
    ai_used: bool,
    model: Option<String>,
}

/// Punctuation/case-normalize, KEEPING bracketed qualifiers so "Song" and
/// "Song (Live)" stay distinct for the exact pass.
fn norm_exact(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Loose key for grouping near-duplicate CANDIDATES — drops bracketed qualifiers
/// (Remaster/Live/feat…) so variants land together for the AI to adjudicate.
fn norm_loose(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out = String::new();
    let mut depth = 0i32;
    for c in lower.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    if let Some(i) = out.find(" feat") {
        out.truncate(i);
    }
    norm_exact(&out)
}

struct DTrack {
    id: String,
    artist: String,
    album: String,
    title: String,
    size: i64,
    added: i64,
}

/// Dry run: find duplicate copies within ONE category — picked individually so each can be
/// run on its own. `category`:
///   - "music"  → exact (artist+album+title) + an AI near-duplicate pass across releases.
///   - "movies" → same film saved more than once (e.g. a 720p and a 1080p copy).
///   - "shows"  → same episode (title + season + episode) saved more than once.
///   - "games"  → same game/repack saved more than once.
///   - "books"  → same ebook/comic title saved more than once.
/// Always keeps the largest (best-quality) copy. Movies/shows/games match offline (no model).
/// Read-only — nothing is removed until `dedupe_apply`. Streams `dedupe://progress`.
#[tauri::command]
async fn dedupe_plan(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    category: String,
) -> Result<DedupeResult, String> {
    use tauri::Emitter;
    let root = std::path::PathBuf::from(&info.download_dir);

    let pick_keeper = |idxs: &[usize], t: &[DTrack]| -> usize {
        *idxs.iter().max_by_key(|&&i| (t[i].size, -t[i].added)).unwrap()
    };

    // ---- MUSIC: artist|album|title exact pass, then an AI near-duplicate pass ----
    if category == "music" {
        let tracks: Vec<DTrack> = scan_downloaded(info.inner(), catalog.inner())
            .into_iter()
            .filter(|i| i.kind == "audio" && i.in_library)
            .map(|i| DTrack {
                artist: i.artist.clone().unwrap_or_default(),
                album: i.album.clone().unwrap_or_default(),
                title: i.title.clone(),
                id: i.id,
                size: i.size_bytes,
                added: i.added_at,
            })
            .collect();

        let mut groups: Vec<DedupeGroup> = Vec::new();
        let mut bytes_freed: i64 = 0;
        let mut push_group = |idxs: &[usize], t: &[DTrack], reason: String, kind: &str, freed: &mut i64| -> usize {
            let keep = pick_keeper(idxs, t);
            let duplicates: Vec<DedupeDup> = idxs
                .iter()
                .filter(|&&i| i != keep)
                .map(|&i| {
                    *freed += t[i].size;
                    DedupeDup { id: t[i].id.clone(), name: t[i].title.clone(), album: t[i].album.clone(), size_bytes: t[i].size }
                })
                .collect();
            groups.push(DedupeGroup {
                keep: t[keep].id.clone(),
                keep_name: t[keep].title.clone(),
                keep_album: t[keep].album.clone(),
                keep_size: t[keep].size,
                duplicates,
                reason,
                kind: kind.to_string(),
            });
            keep
        };

        let mut exact: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
        for (idx, t) in tracks.iter().enumerate() {
            let key = format!("{}|{}|{}", norm_exact(&t.artist), norm_exact(&t.album), norm_exact(&t.title));
            exact.entry(key).or_default().push(idx);
        }
        let mut survivors: Vec<usize> = Vec::new();
        for idxs in exact.into_values() {
            if idxs.len() <= 1 {
                survivors.push(idxs[0]);
                continue;
            }
            let keep = push_group(&idxs, &tracks, "Same track in the same album — keeping the largest copy.".to_string(), "exact", &mut bytes_freed);
            survivors.push(keep);
        }

        let llm = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
        let model = resolve_model(catalog.inner(), &llm).await;
        let mut ai_used = false;
        if let Some(m) = model.as_deref() {
            let mut near: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
            for &i in &survivors {
                if tracks[i].title.trim().is_empty() {
                    continue; // untagged — nothing reliable to compare
                }
                let key = format!("{}|{}", norm_loose(&tracks[i].artist), norm_loose(&tracks[i].title));
                near.entry(key).or_default().push(i);
            }
            let candidates: Vec<Vec<usize>> = near.into_values().filter(|v| v.len() > 1).collect();
            let total = candidates.len();
            for (gi, idxs) in candidates.into_iter().enumerate() {
                let _ = app.emit("dedupe://progress", organize_progress("plan", gi + 1, total));
                let mut ctx = String::new();
                for (n, &i) in idxs.iter().enumerate() {
                    ctx.push_str(&format!(
                        "[{}] artist={} | album={} | title={} | size={}MB\n",
                        n, tracks[i].artist, tracks[i].album, tracks[i].title, tracks[i].size / 1_048_576
                    ));
                }
                ai_used = true;
                match ai::dedupe_judge(&llm, m, &ctx).await {
                    Ok(v) if v.duplicate => {
                        let reason = if v.reason.trim().is_empty() {
                            "AI: same recording across releases.".to_string()
                        } else {
                            format!("AI: {}", v.reason.trim())
                        };
                        push_group(&idxs, &tracks, reason, "near", &mut bytes_freed);
                    }
                    _ => { /* distinct versions, or model error → keep both */ }
                }
            }
        }

        return Ok(DedupeResult {
            root: root.display().to_string(),
            groups,
            removed: 0,
            bytes_freed,
            errors: 0,
            ai_used,
            model,
        });
    }

    // ---- MOVIES / SHOWS / GAMES: offline exact-match, keep the largest copy ----
    let items: Vec<DownloadedItem> = scan_downloaded(info.inner(), catalog.inner())
        .into_iter()
        .filter(|i| i.in_library)
        .filter(|i| match category.as_str() {
            "movies" => i.kind == "video" && i.media_type == "movie",
            "shows" => i.kind == "video" && i.media_type == "show",
            "games" => i.kind == "game",
            "books" => i.kind == "book" || i.media_type == "book",
            _ => false,
        })
        .collect();

    // Carry the SxxEyy / Season label in `album` so the preview reads naturally (it reuses
    // the music DedupeGroup shape, which surfaces name + album).
    let tracks: Vec<DTrack> = items
        .iter()
        .map(|i| DTrack {
            artist: String::new(),
            album: match (i.season, i.episode) {
                (Some(s), Some(e)) => format!("S{s:02}E{e:02}"),
                (Some(s), None) => format!("Season {s}"),
                _ => String::new(),
            },
            title: i.title.clone(),
            id: i.id.clone(),
            size: i.size_bytes,
            added: i.added_at,
        })
        .collect();

    let mut groups: Vec<DedupeGroup> = Vec::new();
    let mut bytes_freed: i64 = 0;
    let mut push_group = |idxs: &[usize], t: &[DTrack], reason: String, freed: &mut i64| {
        let keep = pick_keeper(idxs, t);
        let duplicates: Vec<DedupeDup> = idxs
            .iter()
            .filter(|&&i| i != keep)
            .map(|&i| {
                *freed += t[i].size;
                DedupeDup { id: t[i].id.clone(), name: t[i].title.clone(), album: t[i].album.clone(), size_bytes: t[i].size }
            })
            .collect();
        groups.push(DedupeGroup {
            keep: t[keep].id.clone(),
            keep_name: t[keep].title.clone(),
            keep_album: t[keep].album.clone(),
            keep_size: t[keep].size,
            duplicates,
            reason,
            kind: "exact".to_string(),
        });
    };

    // A movie/game keys on its clean title; a show episode on title + season + episode.
    let mut exact: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    for (idx, i) in items.iter().enumerate() {
        let key = if category == "shows" {
            format!("show|{}|s{}e{}", norm_exact(&i.title), i.season.unwrap_or(0), i.episode.unwrap_or(0))
        } else {
            format!("{category}|{}", norm_exact(&i.title))
        };
        exact.entry(key).or_default().push(idx);
    }
    let reason = if category == "games" {
        "Same game saved more than once — keeping the largest copy.".to_string()
    } else if category == "books" {
        "Same book saved more than once — keeping the largest/most complete copy.".to_string()
    } else {
        "Same title saved more than once — keeping the largest (best-quality) copy.".to_string()
    };
    for idxs in exact.into_values() {
        if idxs.len() <= 1 {
            continue;
        }
        push_group(&idxs, &tracks, reason.clone(), &mut bytes_freed);
    }

    Ok(DedupeResult {
        root: root.display().to_string(),
        groups,
        removed: 0,
        bytes_freed,
        errors: 0,
        ai_used: false,
        model: None,
    })
}

/// Move the confirmed duplicate copies (by relpath) to the Trash. Recoverable from
/// Finder; never touches keepers. Guards every path against the download root.
#[tauri::command]
async fn dedupe_apply(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    cache: tauri::State<'_, ScanCache>,
    paths: Vec<String>,
) -> Result<DedupeResult, String> {
    use tauri::Emitter;
    let root = std::path::PathBuf::from(&info.download_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let root_disp = root.display().to_string();
    let total = paths.len();
    let app_idx = app.clone();
    let res = tokio::task::spawn_blocking(move || {
        let mut removed = 0usize;
        let mut errors = 0usize;
        let mut bytes_freed = 0i64;
        for (i, rel) in paths.iter().enumerate() {
            let _ = app.emit("dedupe://progress", organize_progress("apply", i + 1, total));
            let abs = match root.join(rel).canonicalize() {
                Ok(a) => a,
                Err(_) => { errors += 1; continue; }
            };
            if !abs.starts_with(&root) {
                errors += 1;
                continue;
            }
            let sz = std::fs::metadata(&abs).map(|m| m.len() as i64).unwrap_or(0);
            if trash_files(std::slice::from_ref(&abs)) == 1 {
                removed += 1;
                bytes_freed += sz;
            } else {
                errors += 1;
            }
        }
        DedupeResult { root: root_disp, groups: Vec::new(), removed, bytes_freed, errors, ai_used: false, model: None }
    })
    .await
    .map_err(|e| e.to_string())?;
    invalidate_scan(&cache); // files gone from disk
    nudge_indexer(&app_idx); // reconcile so the de-duped files leave the index
    Ok(res)
}

// ---- AI metadata tagging (clean tags + legible names, embedded into files) ----

/// Preview clean tags + legible filenames for the music library (Ollama-driven,
/// regex fallback). Read-only — embeds nothing until `tag_apply`.
#[tauri::command]
async fn tag_plan(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
) -> Result<metadata::TagResult, String> {
    use tauri::Emitter;
    let root = std::path::PathBuf::from(&info.download_dir);
    let llm = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let model = resolve_model(catalog.inner(), &llm).await;
    Ok(metadata::plan(&root, &llm, model.as_deref(), move |done, total| {
        let _ = app.emit("tag://progress", organize_progress("plan", done, total));
    })
    .await)
}

/// Write previewed tags into the files (lofty, pure-Rust) + apply legible renames.
/// Blocking fs/tag work runs off the main thread; never overwrites or deletes.
#[tauri::command]
async fn tag_apply(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    cache: tauri::State<'_, ScanCache>,
    changes: Vec<metadata::TagApply>,
) -> Result<metadata::TagResult, String> {
    let root = std::path::PathBuf::from(&info.download_dir);
    let app_idx = app.clone();
    let res = tokio::task::spawn_blocking(move || {
        use tauri::Emitter;
        metadata::apply(&root, &changes, |done, total| {
            let _ = app.emit("tag://progress", organize_progress("apply", done, total));
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    invalidate_scan(&cache); // files renamed on disk
    nudge_indexer(&app_idx); // reconcile against the renamed paths
    Ok(res)
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct ConvertResult {
    converted: usize,
    skipped: usize,
    errors: usize,
    dest: String,
}

/// Transcode non-portable audio (FLAC/OGG/Opus/WMA/AIFF…) into a device-friendly
/// format under a `Converted/` folder. Originals stay put (keep seeding). Desktop only.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
async fn convert_audio(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    format: String,
) -> Result<ConvertResult, String> {
    use tauri::Emitter;
    let root = std::path::PathBuf::from(&info.download_dir);
    let (ffmpeg, _ffprobe) = engine::resolve_ffmpeg();
    let ffmpeg = ffmpeg.ok_or("FFmpeg not found — install it to convert audio")?;
    let codec = if format == "mp3" { "mp3" } else { "alac" };
    let target_ext = if codec == "mp3" { "mp3" } else { "m4a" };
    let portable = ["mp3", "m4a", "aac", "alac"];

    let files: Vec<_> = export::scan(&root)
        .into_iter()
        .filter(|e| e.kind == "audio")
        .filter(|e| {
            let ext = std::path::Path::new(&e.file_name)
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            !portable.contains(&ext.as_str())
        })
        .collect();

    let dest_root = root.join("Converted");
    let dest_str = dest_root.display().to_string();
    let res = tokio::task::spawn_blocking(move || {
        let mut r = ConvertResult { dest: dest_str, ..Default::default() };
        let total = files.len();
        for (i, f) in files.iter().enumerate() {
            let _ = app.emit("convert://progress", organize_progress("convert", i + 1, total));
            let src = std::path::PathBuf::from(&f.path);
            let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
            let dst = dest_root.join(format!("{stem}.{target_ext}"));
            if dst.exists() {
                r.skipped += 1;
                continue;
            }
            match export::transcode_audio(&ffmpeg, &src, &dst, codec) {
                Ok(()) => r.converted += 1,
                Err(_) => r.errors += 1,
            }
        }
        r
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(res)
}

#[cfg(target_os = "ios")]
#[tauri::command]
async fn convert_audio(
    _app: tauri::AppHandle,
    _info: tauri::State<'_, AppInfo>,
    _format: String,
) -> Result<ConvertResult, String> {
    Err("Audio conversion is desktop-only".into())
}

/// Organize + scan up to `limit` un-processed items: the local LLM parses each
/// messy release name into a clean title/type/quality/tags, then OMDb (IMDb + RT)
/// and TMDB fill in posters and ratings, cached to disk. Degrades to a regex
/// title clean-up when Ollama isn't running. Returns a per-run summary.
#[tauri::command]
async fn ai_scan(
    catalog: tauri::State<'_, Catalog>,
    info: tauri::State<'_, AppInfo>,
    limit: Option<i64>,
) -> Result<ScanResult, String> {
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let art_dir = std::path::PathBuf::from(&info.data_dir).join("artwork");
    std::fs::create_dir_all(&art_dir).ok();

    // The LLM client gets a generous timeout — a 7B model on CPU can take seconds
    // per title; the HTTP client for posters/ratings stays snappy.
    let llm = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let model = resolve_model(catalog.inner(), &llm).await;
    let omdb = catalog.get_setting("omdb_key").filter(|k| !k.trim().is_empty());
    let tmdb = catalog.get_setting("tmdb_key").filter(|k| !k.trim().is_empty());

    let todo = catalog.items_needing_scan(limit).map_err(|e| format!("{e:#}"))?;
    let mut organized = 0usize;
    let mut posters = 0usize;

    for (id, title) in &todo {
        // 1. Understand the title (LLM, else regex fallback).
        let parsed = match &model {
            Some(m) => ai::parse_title(&llm, m, title).await.ok(),
            None => None,
        };
        let clean = parsed
            .as_ref()
            .map(|p| p.title.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| enrich::clean_title(title));
        let kind = parsed.as_ref().map(|p| p.kind.clone()).filter(|k| !k.is_empty());
        let mut year = parsed.as_ref().and_then(|p| p.year);

        // 2. Classification tags from the parse.
        let mut tags: Vec<String> = Vec::new();
        if let Some(p) = &parsed {
            for s in [p.quality.as_ref(), p.codec.as_ref(), p.language.as_ref()].into_iter().flatten() {
                if !s.is_empty() {
                    tags.push(s.clone());
                }
            }
            if let (Some(s), Some(e)) = (p.season, p.episode) {
                tags.push(format!("S{s:02}E{e:02}"));
            }
            tags.extend(p.genres.iter().filter(|g| !g.is_empty()).cloned());
        }

        // 3. Posters + ratings for video-ish items. OMDb (IMDb + RT) first, TMDB poster fallback.
        let video_ish = kind.as_deref().map(|k| matches!(k, "movie" | "show")).unwrap_or(true);
        let mut poster_url: Option<String> = None;
        let (mut imdb, mut rt, mut genre, mut plot) = (None, None, None, None);
        if video_ish {
            if let Some(k) = &omdb {
                if let Ok(Some(a)) = artwork::omdb_lookup(&http, k, &clean, year, kind.as_deref()).await {
                    poster_url = a.poster_url;
                    imdb = a.imdb_rating;
                    rt = a.rt_rating;
                    genre = a.genre;
                    plot = a.plot;
                    year = year.or(a.year);
                }
            }
            if poster_url.is_none() {
                if let Some(k) = &tmdb {
                    if let Ok(Some(e)) = enrich::enrich_title(&http, k, &clean).await {
                        poster_url = e.poster;
                        plot = plot.or(e.description);
                        year = year.or(e.year);
                    }
                }
            }
        }

        // 4. Cache the poster to disk; prefer the local /art URL once cached.
        let mut art_url = poster_url.clone();
        if let Some(url) = &poster_url {
            if artwork::cache_image(&http, url, &art_dir, id).await.unwrap_or(false) {
                art_url = Some(format!("http://127.0.0.1:{}/art/{}", engine::STREAM_PORT, id));
                posters += 1;
            }
        }

        // Fold OMDb genres into the tag list.
        if let Some(g) = &genre {
            for part in g.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                if !tags.iter().any(|t| t.eq_ignore_ascii_case(part)) {
                    tags.push(part.to_string());
                }
            }
        }
        let tags_json = (!tags.is_empty()).then(|| serde_json::to_string(&tags).unwrap_or_default());

        // 5. Persist: enrich the item row, then write the meta row (marks it scanned).
        let _ = catalog.set_enrichment(id, art_url.as_deref(), plot.as_deref(), year);
        let meta = catalog::Meta {
            clean_title: Some(clean),
            media_type: kind,
            imdb_rating: imdb,
            rt_rating: rt,
            genre,
            quality: parsed.as_ref().and_then(|p| p.quality.clone()),
            tags: tags_json,
        };
        let _ = catalog.set_meta(id, &meta, now_ms());
        organized += 1;
    }

    let remaining = catalog.count_needing_scan().unwrap_or(0);
    Ok(ScanResult {
        organized,
        posters,
        remaining,
        ai_used: model.is_some(),
        model,
    })
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CleanTitlesResult {
    /// (id, cleanTitle) for every requested id that now has a clean title (cache + this run).
    titles: Vec<(String, String)>,
    /// Requested ids still missing a clean title — call again with the same ids to do more.
    remaining: usize,
    ai_used: bool,
}

/// Turn messy release-name titles into clean display names for a set of catalog items,
/// using the local LLM (regex fallback) and caching each result in `meta.clean_title`.
/// Cache hits are free; only up to `limit` uncached titles are cleaned per call so the
/// search UI stays responsive — the caller loops with the same ids until `remaining` is 0.
#[tauri::command]
async fn clean_titles(
    catalog: tauri::State<'_, Catalog>,
    ids: Vec<String>,
    limit: Option<i64>,
) -> Result<CleanTitlesResult, String> {
    let budget = limit.unwrap_or(8).clamp(1, 40) as usize;
    let llm = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let model = resolve_model(catalog.inner(), &llm).await;

    let mut out = CleanTitlesResult::default();
    let mut cleaned_now = 0usize;

    for id in &ids {
        // Cache hit — return the stored clean title for free.
        if let Some(ct) = catalog.clean_title_for(id) {
            out.titles.push((id.clone(), ct));
            continue;
        }
        // Stay within this batch's budget; the rest is reported as `remaining`.
        if cleaned_now >= budget {
            out.remaining += 1;
            continue;
        }
        let Some(raw) = catalog.raw_title_for(id) else { continue };
        let parsed = match &model {
            Some(m) => ai::parse_title(&llm, m, &raw).await.ok(),
            None => None,
        };
        if parsed.is_some() {
            out.ai_used = true;
        }
        let clean = parsed
            .as_ref()
            .map(|p| p.title.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| enrich::clean_title(&raw));
        let clean = if clean.trim().is_empty() { raw.clone() } else { clean };
        let media_type = parsed.as_ref().map(|p| p.kind.clone()).filter(|k| !k.is_empty());
        let year = parsed.as_ref().and_then(|p| p.year);
        let _ = catalog.set_clean_title(id, &clean, media_type.as_deref(), year, now_ms());
        out.titles.push((id.clone(), clean));
        cleaned_now += 1;
    }
    Ok(out)
}

#[tauri::command]
async fn pause_download(
    app: tauri::AppHandle,
    id: String,
    paused: bool,
) -> Result<(), String> {
    engine_state(&app)?.set_paused(&id, paused).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn get_download_concurrency(app: tauri::AppHandle) -> Result<usize, String> {
    Ok(engine_state(&app)?.max_active_downloads().await)
}

/// VPN kill-switch: halt all download traffic (called when the VPN drops mid-session).
#[tauri::command]
async fn network_pause_all(app: tauri::AppHandle) -> Result<(), String> {
    engine_state(&app)?.pause_all_network().await;
    Ok(())
}

/// Lift the VPN kill-switch and let downloads resume (the user chose “Resume anyway”).
#[tauri::command]
async fn network_resume_all(app: tauri::AppHandle) -> Result<(), String> {
    engine_state(&app)?.resume_all_network().await;
    Ok(())
}

#[tauri::command]
async fn set_download_concurrency(
    app: tauri::AppHandle,
    catalog: tauri::State<'_, Catalog>,
    value: usize,
) -> Result<usize, String> {
    let clamped = value.clamp(1, 6);
    engine_state(&app)?.set_max_active_downloads(clamped).await;
    catalog
        .set_setting("download_concurrency", &clamped.to_string())
        .map_err(|e| format!("{e:#}"))?;
    Ok(clamped)
}

#[tauri::command]
async fn reveal_download(app: tauri::AppHandle, id: String) -> Result<(), String> {
    engine_state(&app)?.reveal(&id).await.map_err(|e| format!("{e:#}"))
}

// ---- manual-verification browser (Cloudflare / "I'm not a robot") ----

/// Open (or refocus) an embedded browser window at `url`. The user solves any
/// Cloudflare / bot-check challenge there themselves, then browses to a results or
/// detail page. Window creation is marshalled to the main thread (required on macOS).
#[tauri::command]
async fn open_browser(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid URL: {e}"))?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let r = (|| -> Result<(), String> {
            if let Some(w) = app2.get_webview_window(VERIFY_LABEL) {
                w.navigate(parsed.clone()).map_err(|e| e.to_string())?;
                let _ = w.set_focus();
                return Ok(());
            }
            WebviewWindowBuilder::new(&app2, VERIFY_LABEL, WebviewUrl::External(parsed.clone()))
                .title("Verify & browse — GhostWire")
                .inner_size(1180.0, 840.0)
                .user_agent(BROWSER_UA)
                .build()
                .map(|_| ())
                .map_err(|e| format!("{e:#}"))
        })();
        let _ = tx.send(r);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())??;
    Ok(VERIFY_LABEL.to_string())
}

/// Scrape magnets from whatever page is currently shown in the verification browser
/// and add them to the catalog under `source_name`. Reads the rendered DOM via
/// `eval_with_callback` (no page-side IPC needed), then runs the normal parser.
#[tauri::command]
async fn import_from_browser(
    app: tauri::AppHandle,
    catalog: tauri::State<'_, Catalog>,
    source_name: String,
) -> Result<usize, String> {
    let w = app
        .get_webview_window(VERIFY_LABEL)
        .ok_or_else(|| "The verification browser isn't open. Click \"Open & verify\" first.".to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let slot = std::sync::Mutex::new(Some(tx));
    let w2 = w.clone();
    app.run_on_main_thread(move || {
        let _ = w2.eval_with_callback("document.documentElement.outerHTML", move |json| {
            if let Ok(mut g) = slot.lock() {
                if let Some(s) = g.take() {
                    let _ = s.send(json);
                }
            }
        });
    })
    .map_err(|e| e.to_string())?;

    let json = tokio::time::timeout(std::time::Duration::from_secs(10), rx)
        .await
        .map_err(|_| "Timed out reading the page.".to_string())?
        .map_err(|_| "Couldn't read the page contents.".to_string())?;
    // eval results arrive JSON-encoded; the DOM string decodes back to raw HTML.
    let html: String = serde_json::from_str(&json).unwrap_or(json);

    let items = indexer::parse_body(&html, &source_name, now_ms());
    let n = items.len();
    if n > 0 {
        catalog.upsert_items(&items).map_err(|e| format!("{e:#}"))?;
    }
    Ok(n)
}

fn is_zlib_http_url(url: &str) -> bool {
    let u = url.to_lowercase();
    (u.starts_with("http://") || u.starts_with("https://"))
        && (u.contains("z-library") || u.contains("zlibrary") || u.contains("z-lib") || u.contains("singlelogin"))
}

fn percent_decode_component(s: &str) -> String {
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

fn filename_from_content_disposition(v: Option<&reqwest::header::HeaderValue>) -> Option<String> {
    let raw = v?.to_str().ok()?.trim();
    let lower = raw.to_lowercase();

    if let Some(i) = lower.find("filename*=") {
        let mut p = raw.get(i + 10..)?.trim();
        if let Some(end) = p.find(';') {
            p = &p[..end];
        }
        p = p.trim_matches('"');
        if let Some(pos) = p.find("''") {
            p = &p[pos + 2..];
        }
        let d = percent_decode_component(p).trim().to_string();
        if !d.is_empty() {
            return Some(d);
        }
    }

    if let Some(i) = lower.find("filename=") {
        let mut p = raw.get(i + 9..)?.trim();
        if let Some(end) = p.find(';') {
            p = &p[..end];
        }
        let d = p.trim_matches('"').trim().to_string();
        if !d.is_empty() {
            return Some(d);
        }
    }

    None
}

fn filename_from_url(url: &str) -> Option<String> {
    let q = url.split('?').next().unwrap_or(url);
    let part = q.rsplit('/').next().unwrap_or("").trim();
    if part.is_empty() {
        None
    } else {
        Some(percent_decode_component(part))
    }
}

fn ext_from_content_type(ct: Option<&reqwest::header::HeaderValue>) -> Option<&'static str> {
    let s = ct?.to_str().ok()?.to_ascii_lowercase();
    if s.contains("application/pdf") {
        Some("pdf")
    } else if s.contains("application/epub+zip") {
        Some("epub")
    } else if s.contains("application/x-mobipocket-ebook") || s.contains("application/vnd.amazon.mobi8-ebook") {
        Some("mobi")
    } else if s.contains("application/vnd.amazon.ebook") {
        Some("azw")
    } else if s.contains("application/x-fictionbook+xml") {
        Some("fb2")
    } else if s.contains("application/zip") {
        Some("zip")
    } else if s.contains("application/octet-stream") {
        None
    } else if s.contains("text/plain") {
        Some("txt")
    } else {
        None
    }
}

fn normalized_download_name(raw: &str) -> String {
    let cleaned = export::sanitize(raw).trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "book".to_string()
    } else {
        cleaned
    }
}

fn with_extension_if_missing(name: String, ext: Option<&str>) -> String {
    if name.rsplit_once('.').is_some() {
        return name;
    }
    match ext {
        Some(e) if !e.is_empty() => format!("{name}.{e}"),
        _ => name,
    }
}

fn unique_download_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let parent = path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("book");
    let ext = path.extension().and_then(|s| s.to_str());
    for n in 2..1000 {
        let cand = match ext {
            Some(e) if !e.is_empty() => parent.join(format!("{stem} ({n}).{e}")),
            _ => parent.join(format!("{stem} ({n})")),
        };
        if !cand.exists() {
            return cand;
        }
    }
    path
}

/// Download a direct HTTP(S) file into the app's download folder and return the saved path.
/// For z-library domains this solves the anti-bot cookie challenge first, so books can be
/// downloaded in-app without opening the verification browser.
#[tauri::command]
async fn download_http_file(
    info: tauri::State<'_, AppInfo>,
    url: String,
    title: Option<String>,
    allow_duplicate: Option<bool>,
) -> Result<String, String> {
    let link = url.trim();
    if !(link.starts_with("http://") || link.starts_with("https://")) {
        return Err("Only http(s) URLs can be downloaded directly.".to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(link);
    if is_zlib_http_url(link) {
        if let Some(cookie) = indexer::zlib_cookie_header(link).await {
            req = req.header(reqwest::header::COOKIE, cookie);
        }
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let final_url = resp.url().to_string();
    let headers = resp.headers().clone();
    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.starts_with("text/html") || content_type.contains("application/xhtml") {
        return Err("URL resolved to an HTML page, not a direct file.".to_string());
    }
    let data = resp.bytes().await.map_err(|e| e.to_string())?;
    if data.is_empty() {
        return Err("Download returned no data.".to_string());
    }
    let head = String::from_utf8_lossy(&data[..data.len().min(512)]).to_ascii_lowercase();
    if head.contains("<!doctype html") || head.contains("<html") {
        return Err("URL resolved to an HTML page, not a direct file.".to_string());
    }

    std::fs::create_dir_all(&info.download_dir).map_err(|e| e.to_string())?;
    let ct_ext = ext_from_content_type(headers.get(reqwest::header::CONTENT_TYPE));
    let preferred = filename_from_content_disposition(headers.get(reqwest::header::CONTENT_DISPOSITION))
        .or_else(|| filename_from_url(&final_url))
        .or_else(|| filename_from_url(link))
        .or_else(|| title.map(|t| normalized_download_name(&t)))
        .unwrap_or_else(|| "book".to_string());
    let file_name = with_extension_if_missing(normalized_download_name(&preferred), ct_ext);
    let desired_path = PathBuf::from(&info.download_dir).join(file_name);
    let allow_duplicate = allow_duplicate.unwrap_or(false);
    if desired_path.exists() && !allow_duplicate {
        return Err("already downloaded".to_string());
    }
    let path = if allow_duplicate {
        unique_download_path(desired_path)
    } else {
        desired_path
    };
    tokio::fs::write(&path, &data).await.map_err(|e| e.to_string())?;

    Ok(path.display().to_string())
}

// ---- export to media libraries (Plex / Apple Music / generic folder) ----

/// Native folder picker (supports creating new folders). Returns the chosen path.
/// Desktop only — iOS/iPadOS has no directory picker (tauri-plugin-dialog exposes
/// only file open/save there), so the app uses its sandbox Documents folder instead.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    rx.await
        .ok()
        .flatten()
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.display().to_string())
}

/// iOS has no folder picker — downloads live in the app's Documents sandbox.
#[cfg(target_os = "ios")]
#[tauri::command]
async fn pick_folder(_app: tauri::AppHandle) -> Option<String> {
    None
}

/// Choose a new storage folder. Optionally migrate (move) existing downloads into it.
/// The setting is read on next launch, so the UI prompts a restart to apply.
#[tauri::command]
fn set_storage_dir(
    catalog: tauri::State<'_, Catalog>,
    info: tauri::State<'_, AppInfo>,
    path: String,
    migrate: bool,
) -> Result<String, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("No folder chosen.".into());
    }
    let new_dir = std::path::PathBuf::from(&path);
    std::fs::create_dir_all(&new_dir).map_err(|e| format!("Can't use that folder: {e}"))?;
    let old_dir = std::path::PathBuf::from(&info.download_dir);

    let mut moved = 0usize;
    if migrate && old_dir != new_dir && old_dir.is_dir() {
        moved = move_dir_contents(&old_dir, &new_dir).map_err(|e| format!("Move failed: {e}"))?;
    }
    catalog.set_setting("storage_dir", &path).map_err(|e| format!("{e:#}"))?;

    Ok(if moved > 0 {
        format!(
            "Saved. Moved {moved} item{} to the new folder — restart to start using it.",
            if moved == 1 { "" } else { "s" }
        )
    } else {
        "Saved. Restart the app to start using the new folder.".into()
    })
}

/// Relaunch the app (so a new storage folder takes effect).
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// Relaunch after an OTA update has staged a new bundle.
///
/// On macOS the updater swaps the .app in place, but the plugin's plain
/// `relaunch()` re-execs so fast that Launch Services can reopen the OLD
/// bundle before this process fully exits. We instead spawn a detached
/// `/bin/sh` that waits for our PID to die, pauses, then `open`s the (now
/// freshly swapped) bundle — guaranteeing the NEW version comes up. For
/// `tauri dev` (no .app wrapper) and non-macOS we fall back to `app.restart()`.
/// Opt-in P2P self-update: download the signed update bundle over BitTorrent, verify the minisign
/// signature, and install it. Returns true if an update was installed (the caller should then call
/// `relaunch_for_update`), false if already current. Any error means "fall back to the HTTP updater".
#[tauri::command]
async fn p2p_update(app: tauri::AppHandle) -> Result<bool, String> {
    update_p2p::try_p2p_update(app).await.map_err(|e| format!("{e:#}"))
}

/// Opt-in: start seeding the latest GhostWire build to other users. Returns the version seeded.
#[tauri::command]
async fn start_app_seed(app: tauri::AppHandle) -> Result<String, String> {
    update_p2p::start_seeding_app(app).await.map_err(|e| format!("{e:#}"))
}

/// Opt-out: stop seeding the app build.
#[tauri::command]
async fn stop_app_seed(app: tauri::AppHandle) -> Result<(), String> {
    update_p2p::stop_seeding_app(app).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn relaunch_for_update<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        // <bundle>.app/Contents/MacOS/<bin> → climb three parents to the .app.
        let bundle = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf());
        if let Some(bundle) = bundle {
            if bundle.extension().and_then(|e| e.to_str()) == Some("app") {
                let pid = std::process::id();
                let bundle_arg = bundle.to_string_lossy().replace('"', "\\\"");
                let script = format!(
                    "while kill -0 {pid} 2>/dev/null; do sleep 0.2; done; sleep 0.5; open \"{bundle_arg}\""
                );
                std::process::Command::new("/bin/sh")
                    .arg("-c")
                    .arg(&script)
                    .spawn()
                    .map_err(|e| format!("failed to spawn relaunch helper: {e}"))?;
                std::process::exit(0);
            }
        }
    }
    app.restart();
}

/// Move every entry from `from` into `to` (rename when same volume, else copy + delete).
fn move_dir_contents(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<usize> {
    let mut n = 0usize;
    for entry in std::fs::read_dir(from)? {
        let src = entry?.path();
        let dest = to.join(src.file_name().unwrap_or_default());
        if std::fs::rename(&src, &dest).is_err() {
            copy_recursive(&src, &dest)?;
            if src.is_dir() {
                let _ = std::fs::remove_dir_all(&src);
            } else {
                let _ = std::fs::remove_file(&src);
            }
        }
        n += 1;
    }
    Ok(n)
}

fn copy_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

/// Media files found in the download folder, with parsed names + library-path previews.
#[tauri::command]
fn list_exportable(info: tauri::State<'_, AppInfo>) -> Vec<export::Exportable> {
    export::scan(std::path::Path::new(&info.download_dir))
}

/// Export the given files to `target` ("plex" | "generic" | "apple_music"). Copies
/// (keeps seeding), organizes into the right structure, transcodes audio to ALAC for
/// Apple Music as needed, and triggers a Plex scan when a server is configured.
#[tauri::command]
async fn export_items(
    catalog: tauri::State<'_, Catalog>,
    info: tauri::State<'_, AppInfo>,
    target: String,
    paths: Vec<String>,
) -> Result<Vec<export::ExportResult>, String> {
    let staging = export::staging_dir(&info.data_dir);
    let (ffmpeg, _ffprobe) = engine::resolve_ffmpeg();
    let plex_url = catalog.get_setting("plex_url").filter(|s| !s.trim().is_empty());
    let plex_token = catalog.get_setting("plex_token").filter(|s| !s.trim().is_empty());

    let lib_root: Option<std::path::PathBuf> = match target.as_str() {
        "plex" => Some(
            catalog
                .get_setting("plex_dir")
                .filter(|s| !s.trim().is_empty())
                .ok_or("Set your Plex library folder first (Export settings).")?
                .into(),
        ),
        "generic" => Some(
            catalog
                .get_setting("generic_dir")
                .filter(|s| !s.trim().is_empty())
                .ok_or("Choose an export folder first (Export settings).")?
                .into(),
        ),
        "apple_music" => None,
        other => return Err(format!("Unknown export target: {other}")),
    };

    let is_plex = target == "plex";
    let mut results = tokio::task::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| {
                let src = std::path::Path::new(p);
                match target.as_str() {
                    "apple_music" => export::export_to_apple_music(src, ffmpeg.as_deref(), &staging),
                    _ => export::export_to_library(src, lib_root.as_ref().unwrap()),
                }
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;

    // Best-effort Plex rescan once files have landed.
    if is_plex && results.iter().any(|r| r.ok) {
        if let (Some(url), Some(token)) = (plex_url, plex_token) {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| e.to_string())?;
            let (ok, message) = match export::plex_scan(&client, &url, &token).await {
                Ok(()) => (true, "Plex library scan triggered.".to_string()),
                Err(e) => (false, format!("Files copied, but Plex scan failed: {e}")),
            };
            results.push(export::ExportResult {
                path: "Plex server".to_string(),
                ok,
                dest: None,
                converted: false,
                message,
            });
        }
    }
    Ok(results)
}

// ---- playlists (portable JSON manifests + format export/import) ----

/// Fill each resolved track's `url` with the loopback stream URL the player uses for
/// local files (same `/file/{relpath}` scheme as the Downloads list).
fn fill_playlist_urls(download_dir: &str, p: &mut playlist::Playlist) {
    let root = Path::new(download_dir);
    for t in &mut p.tracks {
        t.url = t.path.as_ref().and_then(|abs| {
            Path::new(abs)
                .strip_prefix(root)
                .ok()
                .map(|rel| format!("http://127.0.0.1:{}/file/{}", engine::STREAM_PORT, enc_path(&rel.to_string_lossy())))
        });
    }
}


/// All saved playlist manifests (newest first). File paths are re-resolved against the
/// current library on each read so newly-downloaded songs light up automatically.
#[tauri::command]
fn list_playlists(info: tauri::State<'_, AppInfo>) -> Vec<playlist::Playlist> {
    // Keep sidebar/list fetches lightweight: this command can be hit during shell paint,
    // and resolving every track path across every playlist can trigger repeated full-library scans.
    // Path/url resolution still happens in `get_playlist` (detail view), export, and mutating ops.
    playlist::list(&info.data_dir)
}

#[tauri::command]
fn get_playlist(info: tauri::State<'_, AppInfo>, id: String) -> Result<playlist::Playlist, String> {
    let mut p = playlist::load(&info.data_dir, &id)?;
    if playlist::resolve_paths(&info.download_dir, &mut p) > 0 {
        let _ = playlist::save(&info.data_dir, &p);
    }
    fill_playlist_urls(&info.download_dir, &mut p);
    Ok(p)
}

#[tauri::command]
fn create_playlist(
    info: tauri::State<'_, AppInfo>,
    name: String,
    tracks: Option<Vec<playlist::PlaylistTrack>>,
) -> Result<playlist::Playlist, String> {
    let mut p = playlist::create(&info.data_dir, &name, "manual", now_ms(), tracks.unwrap_or_default())?;
    playlist::resolve_paths(&info.download_dir, &mut p);
    playlist::save(&info.data_dir, &p)?;
    fill_playlist_urls(&info.download_dir, &mut p);
    Ok(p)
}

#[tauri::command]
fn delete_playlist(info: tauri::State<'_, AppInfo>, id: String) -> Result<(), String> {
    playlist::delete(&info.data_dir, &id)
}

#[tauri::command]
fn rename_playlist(info: tauri::State<'_, AppInfo>, id: String, name: String) -> Result<playlist::Playlist, String> {
    let mut p = playlist::load(&info.data_dir, &id)?;
    p.name = name.trim().to_string();
    p.updated_at = now_ms();
    playlist::save(&info.data_dir, &p)?;
    Ok(p)
}

/// Append tracks to a playlist (used by "Save as playlist" / "Add to playlist").
#[tauri::command]
fn playlist_add_tracks(
    info: tauri::State<'_, AppInfo>,
    id: String,
    tracks: Vec<playlist::PlaylistTrack>,
) -> Result<playlist::Playlist, String> {
    let mut p = playlist::load(&info.data_dir, &id)?;
    p.tracks.extend(tracks);
    p.updated_at = now_ms();
    playlist::resolve_paths(&info.download_dir, &mut p);
    playlist::save(&info.data_dir, &p)?;
    fill_playlist_urls(&info.download_dir, &mut p);
    Ok(p)
}

#[tauri::command]
fn playlist_remove_track(info: tauri::State<'_, AppInfo>, id: String, index: usize) -> Result<playlist::Playlist, String> {
    let mut p = playlist::load(&info.data_dir, &id)?;
    if index < p.tracks.len() {
        p.tracks.remove(index);
        p.updated_at = now_ms();
        playlist::save(&info.data_dir, &p)?;
    }
    fill_playlist_urls(&info.download_dir, &mut p);
    Ok(p)
}

/// Replace a playlist's whole track list (drag-to-reorder / bulk edit). Tracks arrive in
/// their new order; paths + stream urls are re-resolved on save.
#[tauri::command]
fn set_playlist_tracks(
    info: tauri::State<'_, AppInfo>,
    id: String,
    tracks: Vec<playlist::PlaylistTrack>,
) -> Result<playlist::Playlist, String> {
    let mut p = playlist::load(&info.data_dir, &id)?;
    p.tracks = tracks;
    p.updated_at = now_ms();
    playlist::resolve_paths(&info.download_dir, &mut p);
    playlist::save(&info.data_dir, &p)?;
    fill_playlist_urls(&info.download_dir, &mut p);
    Ok(p)
}

/// Export a playlist to `format` ("m3u8"|"m3u"|"pls"|"xspf") inside `dir`.
/// Returns a human summary (written file + counts).
#[tauri::command]
fn export_playlist(
    info: tauri::State<'_, AppInfo>,
    id: String,
    format: String,
    dir: Option<String>,
) -> Result<String, String> {
    let mut p = playlist::load(&info.data_dir, &id)?;
    playlist::resolve_paths(&info.download_dir, &mut p);
    // Default to a Playlists/ folder under the music library when no dir is chosen.
    let out = dir
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| music_output_dir(&info).join("Playlists"));
    let (file, written, skipped) = playlist::export(&p, &format, &out)?;
    let mut msg = format!("Exported {written} track{} to {file}", if written == 1 { "" } else { "s" });
    if skipped > 0 {
        msg.push_str(&format!(" ({skipped} not yet downloaded, skipped)"));
    }
    Ok(msg)
}

/// Import an M3U/M3U8/PLS/XSPF file as a new playlist manifest.
#[tauri::command]
fn import_playlist(info: tauri::State<'_, AppInfo>, file_path: String) -> Result<playlist::Playlist, String> {
    let mut p = playlist::import(&file_path, now_ms())?;
    playlist::resolve_paths(&info.download_dir, &mut p);
    playlist::save(&info.data_dir, &p)?;
    fill_playlist_urls(&info.download_dir, &mut p);
    Ok(p)
}

/// Link a Spotify playlist → save a real manifest of its songs (matched to local
/// files where downloaded). The companion to `spotify_replicate`, which finds the
/// torrents; this captures *which* songs belong together so they can be exported.
#[tauri::command]
async fn spotify_to_playlist(
    catalog: tauri::State<'_, Catalog>,
    info: tauri::State<'_, AppInfo>,
    link: String,
) -> Result<playlist::Playlist, String> {
    let (name, tracks) = spotify::fetch_playlist_for(&catalog, &link).await?;
    let mut p = playlist::create(&info.data_dir, &name, "spotify", now_ms(), tracks)?;
    playlist::resolve_paths(&info.download_dir, &mut p);
    playlist::save(&info.data_dir, &p)?;
    fill_playlist_urls(&info.download_dir, &mut p);
    Ok(p)
}

// ---- TV discovery + AI season compilation ----

/// Popular/trending TV shows merged from TMDB, Trakt and IMDb (whichever are
/// available), enriched with posters + IMDb/RT ratings. Powers the TV discovery page.
#[tauri::command]
async fn popular_shows(catalog: tauri::State<'_, Catalog>) -> Result<Vec<discover::Show>, String> {
    let tmdb = catalog.get_setting("tmdb_key").filter(|s| !s.trim().is_empty());
    let trakt = catalog.get_setting("trakt_key").filter(|s| !s.trim().is_empty());
    let omdb = catalog.get_setting("omdb_key").filter(|s| !s.trim().is_empty());
    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(discover::popular_shows(&client, tmdb.as_deref(), trakt.as_deref(), omdb.as_deref()).await)
}

/// Popular/trending/seasonal anime from free keyless APIs (AniList + MyAnimeList via
/// Jikan). Powers the Anime discovery rails. No key required.
#[tauri::command]
async fn popular_anime() -> Result<anime::AnimeDiscovery, String> {
    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(anime::popular_anime(&client).await)
}

/// The Discover feed for a category — a hero pick + several labelled rows — from free
/// sources: Movies/TV via the relay (TMDB trending/popular/top-rated), Music via Apple RSS
/// (albums + songs), Books via Open Library (today/week/month), Games via SteamSpy (trending
/// + all-time). Each row degrades to empty on error. Clicking a result runs a source search.
#[tauri::command]
async fn discover_feed(category: String) -> Result<trending::DiscoverFeed, String> {
    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(trending::feed(&client, posters::RELAY_BASE, &category).await)
}

/// Look up one anime by title (synopsis, genres, episode count + episode list) for the
/// below-player anime panel. Keyless (AniList → Jikan). Null when nothing matches.
#[tauri::command]
async fn anime_detail(title: String) -> Result<Option<anime::AnimeDetail>, String> {
    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(anime::anime_detail(&client, title.trim()).await)
}

/// For a chosen show, search every linked source and bucket the magnets by season
/// (validated against TMDB's real season list when a key is set) so each season is
/// one click to stream.
#[tauri::command]
async fn compile_seasons(
    catalog: tauri::State<'_, Catalog>,
    title: String,
    year: Option<i64>,
) -> Result<discover::Compilation, String> {
    let tmdb = catalog.get_setting("tmdb_key").filter(|s| !s.trim().is_empty());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;
    discover::compile_seasons(&catalog, &client, tmdb.as_deref(), &title, year, now_ms())
        .await
        .map_err(|e| format!("{e:#}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // Single-instance (desktop only): the engine binds a fixed loopback port, so a
    // second launch — e.g. opening the installed app while the dev build runs, or a
    // double-launch — would otherwise abort on the port. Instead, focus the running
    // window and let the new process exit cleanly. iOS is single-instance via the OS.
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // OTA auto-update + the relaunch the in-app UpdateBanner uses after a swap.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("ghosty");
            std::fs::create_dir_all(&data_dir).ok();

            // Catalog store (sources + discovered items).
            let catalog = Catalog::open(&data_dir.join("ghosty.db"))
                .map_err(|e| Box::<dyn std::error::Error>::from(format!("{e:#}")))?;
            if catalog.list_sources().map(|s| s.is_empty()).unwrap_or(false) {
                seed_default_sources(&catalog);
            }
            // One-time cleanup: older builds auto-seeded a Nyaa default source. That was
            // unintentional — the adapter stays, but the source shouldn't ship baked in.
            // This removes only the exact seeded entry from existing installs.
            remove_seeded_nyaa_source(&catalog);
            // A user-chosen storage folder (Settings) overrides the default download dir.
            let stored_dir = catalog.get_setting("storage_dir").filter(|s| !s.trim().is_empty());
            // Stable identity + HMAC secret for LAN device-linking (generated on first run).
            let device_identity = remote::ensure_device_identity(&catalog);
            // Hand a cheap clone (shared Arc<Mutex> connection) to the engine so the LAN API
            // can serve this desktop's catalog/Library to a linked iPad in companion mode.
            let engine_catalog = catalog.clone();
            let indexer_catalog = catalog.clone();
            app.manage(catalog);
            let scan_cache = ScanCache(Arc::new(Mutex::new(None)));
            app.manage(scan_cache.clone());
            // The background-indexer doorbell — managed so mutation handlers can nudge it.
            let indexer_signal = Arc::new(IndexerSignal::new());
            app.manage(indexer_signal.clone());
            app.manage(BackendPerfState(Arc::new(Mutex::new(BackendPerfData::default()))));
            app.manage(AvailabilityState {
                cache: Arc::new(Mutex::new(HashMap::new())),
                sem: Arc::new(tokio::sync::Semaphore::new(6)),
            });

            // Streaming engine (librqbit + loopback HTTP server).
            let download_dir = stored_dir.map(std::path::PathBuf::from).unwrap_or_else(|| {
                // iOS: write into the app-sandbox Documents dir so downloads appear in the
                // Files app (UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace).
                #[cfg(target_os = "ios")]
                {
                    app.path().document_dir().unwrap_or_else(|_| std::env::temp_dir())
                }
                #[cfg(not(target_os = "ios"))]
                {
                    app.path()
                        .download_dir()
                        .unwrap_or_else(|_| std::env::temp_dir())
                        .join("GhostWire")
                }
            });
            std::fs::create_dir_all(&download_dir).ok();
            // Migrate the old "Organized" library folder name to "Library" (one-time, idempotent).
            {
                let old = download_dir.join("Organized");
                let new = download_dir.join("Library");
                if old.is_dir() && !new.exists() {
                    let _ = std::fs::rename(&old, &new);
                }
            }
            // Consolidate the legacy top-level `Music/` (old SpotiFLAC/TIDAL output) into the
            // single canonical music home `Library/Music/`. Same-volume folder renames make
            // this fast and non-destructive: an artist folder that doesn't exist in the
            // destination is moved wholesale; when it exists in BOTH, files are merged one by
            // one and any name collision keeps the destination copy (never overwrites). The
            // source `Music/` is removed only once it's fully drained. Idempotent + safe to
            // re-run. (One-time, but cheap to re-check each launch.)
            consolidate_music_dirs(&download_dir);
            // Raw torrents download into a `Downloads/` staging folder beside `Library/`
            // (rather than straight onto the storage root). Create it up front so it exists
            // before the engine's session binds it as the default output folder, and so the
            // organize/cleanup passes (which walk the whole root) have a stable home for the
            // unsorted shelf. `Library/` (organized) and `Downloads/` (unsorted) are siblings.
            std::fs::create_dir_all(download_dir.join("Downloads")).ok();
            // Watch the download folder → ring the indexer's doorbell when files change.
            start_library_watcher(download_dir.clone(), indexer_signal.clone());
            let art_dir = data_dir.join("artwork");
            std::fs::create_dir_all(&art_dir).ok();
            let (ffmpeg, ffprobe) = engine::resolve_ffmpeg();
            let app_info = AppInfo {
                download_dir: download_dir.display().to_string(),
                data_dir: data_dir.display().to_string(),
                ffmpeg_available: ffmpeg.is_some(),
            };
            // Clone for the engine (companion mode) before app.manage moves the original.
            let engine_app_info = app_info.clone();
            let indexer_app_info = app_info.clone();
            app.manage(app_info);
            // Background Library indexer: keeps `library_files` reconciled with disk so
            // `list_downloaded` reads an index instead of walking the disk on the foreground.
            start_library_indexer(
                app.handle().clone(),
                indexer_app_info,
                indexer_catalog,
                scan_cache,
                indexer_signal,
            );

            // Social P2P (P1.2): load (or first-run generate) the Ed25519 identity, then
            // reconnect to the coordination server in the background if we were signed in last
            // session. Connecting early is fine — the engine fills in shares once it's ready.
            let social = social::Social::load(&data_dir.display().to_string());
            app.manage(social.clone());
            {
                let social_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    social.autostart(&social_app).await;
                });
            }
            // Start the torrent engine OFF the launch thread. `Session::new_with_opts`
            // restores the persisted session (re-checks files + fastresume), which can take
            // several seconds — `block_on`-ing it here froze the window for 3–5s on launch.
            // Spawn it, `manage` the engine once ready, and emit `engine://ready`. Until then,
            // engine-dependent commands return a benign "still starting" (or empty) result, and
            // the shell is fully interactive (it already tolerates empty downloads).
            let engine_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri::{Emitter, Manager};
                match Engine::start(
                    engine_handle.clone(),
                    download_dir,
                    art_dir,
                    ffmpeg,
                    ffprobe,
                    device_identity,
                    engine_catalog,
                    engine_app_info,
                )
                .await
                {
                    Ok(engine) => {
                        engine_handle.manage(engine);
                        let _ = engine_handle.emit("engine://ready", ());
                    }
                    Err(e) => eprintln!("engine start failed: {e:#}"),
                }
            });
            // Watch for a VPN dropping while the app is open (kill-switch).
            spawn_vpn_monitor(app.handle().clone());

            // Persistent music-import queue: load any jobs from the last session,
            // requeue ones that were mid-download, and start the background worker.
            let import_persist = data_dir.join("music-imports.json");
            let import_manager = Arc::new(MusicImportManager {
                jobs: tokio::sync::Mutex::new(load_music_import_jobs(&import_persist)),
                notify: tokio::sync::Notify::new(),
                persist_path: import_persist,
                app: app.handle().clone(),
            });
            app.manage(import_manager.clone());
            tauri::async_runtime::spawn(async move {
                // Broadcast the restored state, then process the queue forever.
                import_manager.persist_and_emit().await;
                music_import_worker(import_manager).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_torrent,
            pairing_pin,
            stream_url,
            torrent_stats,
            list_downloads,
            media_info,
            list_subtitles,
            fetch_subtitles,
            remove_torrent,
            create_torrent,
            seed_torrent,
            share_library_item,
            list_sources,
            add_source,
            remove_source,
            export_sources,
            import_sources,
            list_catalog,
            refresh_source,
            test_source,
            search_sources,
            get_setting,
            set_setting,
            clear_catalog,
            tidal_auth_status,
            tidal_save_credentials,
            tidal_clear_credentials,
            tidal_test_auth,
            tidal_authorize_login,
            app_info,
            local_play_url,
            relay_status,
            movie_digest,
            featured,
            vpn_status,
            network_pause_all,
            network_resume_all,
            music_spotiflac_status,
            music_spotiflac_install,
            music_spotiflac_download,
            music_import_enqueue,
            music_imports_list,
            music_import_remove,
            music_import_retry,
            enrich_catalog,
            fetch_posters,
            tv_search,
            tv_episodes,
            tv_trailer,
            classify_anime,
            music_search_artists,
            music_artist_albums,
            music_album_tracks,
            ai_status,
            ai_scan,
            clean_titles,
            organize_run,
            tag_plan,
            tag_apply,
            dedupe_plan,
            dedupe_apply,
            convert_audio,
            list_library,
            list_downloaded,
            perf_backend_snapshot,
            perf_backend_clear,
            perf_session_start,
            perf_session_append,
            perf_backend_scan_bench,
            list_devices,
            sync_music_to_device,
            poster_candidates,
            set_poster,
            list_poster_overrides,
            add_to_library,
            remove_from_library,
            reveal_path,
            trash_downloaded,
            scan_safety,
            clear_downloads,
            pause_download,
            get_download_concurrency,
            set_download_concurrency,
            reveal_download,
            open_browser,
            import_from_browser,
            download_http_file,
            pick_folder,
            set_storage_dir,
            restart_app,
            relaunch_for_update,
            p2p_update,
            start_app_seed,
            stop_app_seed,
            list_exportable,
            export_items,
            popular_shows,
            popular_anime,
            discover_feed,
            check_availability,
            anime_detail,
            compile_seasons,
            list_playlists,
            get_playlist,
            create_playlist,
            delete_playlist,
            rename_playlist,
            playlist_add_tracks,
            playlist_remove_track,
            set_playlist_tracks,
            export_playlist,
            import_playlist,
            spotify_to_playlist,
            spotify::spotify_status,
            spotify::spotify_login,
            spotify::spotify_logout,
            spotify::spotify_playlist_preview,
            spotify::spotify_album_preview,
            spotify::spotify_artist_top_tracks_preview,
            spotify::spotify_replicate,
            spotify::spotify_album_art,
            spotify::spotify_search_artists,
            spotify::spotify_artist_albums,
            social_status,
            social_register,
            social_login,
            social_disconnect,
            social_following,
            social_followers,
            social_friends,
            social_follow,
            social_unfollow,
            social_report,
            social_search,
            social_browse
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Legal-by-default sources. Magnet-exposing pages so the generic scraper has
/// something to find; users add their own from the Sources tab.
fn seed_default_sources(catalog: &Catalog) {
    let defaults = [
        ("WebTorrent (free media)", "scraper", "https://webtorrent.io/free-torrents"),
        ("Academic Torrents", "scraper", "https://academictorrents.com/browse.php?cat=6"),
        ("Linux Tracker", "scraper", "https://linuxtracker.org/index.php?page=torrents&active=1"),
        // Anime: SubsPlease's keyless JSON API (handled by an adapter in indexer.rs).
        // NOTE: the Nyaa adapter still lives in indexer.rs and works if a user adds a
        // Nyaa source themselves — but we do NOT ship it as a default source.
        ("SubsPlease (anime)", "scraper", "https://subsplease.org"),
    ];
    for (name, kind, url) in defaults {
        let _ = catalog.add_source(name, kind, url);
    }
}

/// Remove the Nyaa source that older builds auto-seeded as a default. The Nyaa
/// adapter in `indexer.rs` is unchanged and still works for anyone who adds a
/// Nyaa source themselves — this only deletes the exact baked-in default (matching
/// both the seeded name and url) so it stops shipping out of the box, without
/// touching a Nyaa source a user added on their own.
fn remove_seeded_nyaa_source(catalog: &Catalog) {
    let Ok(sources) = catalog.list_sources() else {
        return;
    };
    for s in sources {
        if s.name == "Nyaa (anime + more)" && s.url == "https://nyaa.si" {
            let _ = catalog.remove_source(&s.id);
        }
    }
}
