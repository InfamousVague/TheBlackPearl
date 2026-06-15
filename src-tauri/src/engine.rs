//! Ghosty torrent engine: a librqbit session + a loopback HTTP server that
//! serves any file from an active torrent with HTTP Range support, so a
//! `<video>` element can stream it while it's still downloading.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use axum::{
    body::Body,
    extract::{Path as AxPath, State as AxState},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use librqbit::{AddTorrent, AddTorrentOptions, AddTorrentResponse, ManagedTorrent, Session, SessionOptions};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::RwLock;
use tokio_util::io::ReaderStream;

/// Fixed loopback port for the streaming server (kept stable so the CSP can name it).
pub const STREAM_PORT: u16 = 3030;

/// HLS segment length (seconds). Forced keyframes at this interval make every segment
/// exactly this long, so a generated VOD playlist's timing matches the real segments.
const HLS_SEG: f64 = 4.0;

/// Event channel name (mirrors `src/ipc/engine.ts`).
const DOWNLOADS_EVENT: &str = "ghosty://downloads";

type Handle = Arc<ManagedTorrent>;
type Torrents = Arc<RwLock<HashMap<String, Entry>>>;
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
}

/// Shared axum state for the loopback media server.
#[derive(Clone)]
struct ServerState {
    torrents: Torrents,
    ffmpeg: Option<PathBuf>,
    ffprobe: Option<PathBuf>,
    transcode_errors: TranscodeErrors,
    hls: HlsJobs,
    hls_root: PathBuf,
    /// On-disk poster cache served at /art/{id} for the local artwork library.
    art_dir: PathBuf,
    /// Download root — local finished files are served at /file/{relpath} for the Library.
    download_dir: PathBuf,
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

pub struct Engine {
    session: Arc<Session>,
    torrents: Torrents,
    ffmpeg: Option<PathBuf>,
    ffprobe: Option<PathBuf>,
    download_dir: PathBuf,
    transcode_errors: TranscodeErrors,
    hls: HlsJobs,
}

impl Engine {
    pub async fn start(
        app: AppHandle,
        download_dir: PathBuf,
        art_dir: PathBuf,
        ffmpeg: Option<PathBuf>,
        ffprobe: Option<PathBuf>,
    ) -> Result<Engine> {
        // Don't re-bind a *persisted* DHT port: librqbit otherwise re-uses a port saved
        // in the data dir, so a second instance sharing that dir (e.g. the dev build
        // running alongside the installed app) collides on it and the whole app aborts
        // during setup. A fresh ephemeral DHT port per launch lets instances coexist.
        let session = Session::new_with_opts(
            download_dir.clone(),
            SessionOptions {
                disable_dht_persistence: true,
                ..Default::default()
            },
        )
        .await
        .context("creating librqbit session")?;
        let torrents: Torrents = Arc::new(RwLock::new(HashMap::new()));
        let transcode_errors: TranscodeErrors = Arc::new(RwLock::new(HashMap::new()));
        let hls: HlsJobs = Arc::new(RwLock::new(HashMap::new()));
        let hls_root = std::env::temp_dir().join("ghosty-hls");
        let _ = std::fs::remove_dir_all(&hls_root);
        let _ = std::fs::create_dir_all(&hls_root);
        let _ = std::fs::create_dir_all(&art_dir);

        // Loopback media server. /stream serves raw bytes with Range (direct play);
        // /hls serves an ffmpeg HLS playlist + segments for formats WKWebView can't play
        // natively — HLS needs no byte-range, unlike a progressive <video src> MP4.
        let state = ServerState {
            torrents: torrents.clone(),
            ffmpeg: ffmpeg.clone(),
            ffprobe: ffprobe.clone(),
            transcode_errors: transcode_errors.clone(),
            hls: hls.clone(),
            hls_root: hls_root.clone(),
            art_dir: art_dir.clone(),
            download_dir: download_dir.clone(),
        };
        let router = Router::new()
            .route("/stream/{id}/{file}", get(stream_handler))
            .route("/hls/{id}/{file}/index.m3u8", get(hls_playlist_handler))
            .route("/hls/{id}/{file}/{seg}", get(hls_segment_handler))
            .route("/localhls/{token}/index.m3u8", get(local_hls_playlist_handler))
            .route("/localhls/{token}/{seg}", get(local_hls_segment_handler))
            .route("/subs/file/{token}", get(subs_file_handler))
            .route("/subs/embed/{token}/{name}", get(subs_embed_handler))
            .route("/art/{id}", get(art_handler))
            .route("/file/{*relpath}", get(file_handler))
            .with_state(state)
            // Allow the WKWebView page (a different origin) to read these responses with
            // CORS — required so a Web Audio AnalyserNode can tap the <audio> element for
            // the visualizer instead of getting silenced (zeroed) samples. Applied to ALL
            // responses, including 206 Partial Content range responses.
            .layer(axum::middleware::from_fn(cors_headers));
        let addr = format!("127.0.0.1:{STREAM_PORT}");
        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .with_context(|| format!("binding stream server on {addr}"))?;
        tauri::async_runtime::spawn(async move {
            if let Err(e) = axum::serve(listener, router).await {
                eprintln!("ghosty: stream server exited: {e}");
            }
        });

        // Push a full snapshot of active downloads to the UI ~1/s.
        {
            let torrents = torrents.clone();
            let ffmpeg_on = ffmpeg.is_some();
            tauri::async_runtime::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(1));
                loop {
                    tick.tick().await;
                    let snap = build_snapshot(&torrents, ffmpeg_on).await;
                    let _ = app.emit(DOWNLOADS_EVENT, &snap);
                }
            });
        }

        Ok(Engine {
            session,
            torrents,
            ffmpeg,
            ffprobe,
            download_dir,
            transcode_errors,
            hls,
        })
    }

    /// Add a magnet; returns its infohash (the id everything else is keyed by).
    pub async fn add(&self, magnet: &str) -> Result<String> {
        let id = infohash_from_magnet(magnet).ok_or_else(|| anyhow!("no btih infohash in magnet"))?;
        let resp = self
            .session
            .add_torrent(
                AddTorrent::from_url(magnet),
                Some(AddTorrentOptions {
                    overwrite: true, // allow resuming an already-downloaded torrent
                    ..Default::default()
                }),
            )
            .await
            .context("add_torrent")?;
        let handle = match resp {
            AddTorrentResponse::Added(_, h) | AddTorrentResponse::AlreadyManaged(_, h) => h,
            AddTorrentResponse::ListOnly(_) => return Err(anyhow!("list-only response")),
        };
        let title = magnet_title(magnet).unwrap_or_else(|| id.clone());
        self.torrents.write().await.insert(
            id.clone(),
            Entry {
                handle,
                title,
                magnet: magnet.to_string(),
                added: std::time::Instant::now(),
            },
        );
        Ok(id)
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
        for _ in 0..300 {
            if matches!(handle.stats().state, librqbit::TorrentStatsState::Live) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let file = file_idx.or_else(|| largest_file(&handle)).unwrap_or(0);
        let name = file_name(&handle, file);
        Ok(play_url(self.ffmpeg.is_some(), id, file, name.as_deref()))
    }

    pub async fn snapshot(&self) -> Vec<DownloadStats> {
        build_snapshot(&self.torrents, self.ffmpeg.is_some()).await
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

    pub async fn stats_for(&self, id: &str) -> Option<DownloadStats> {
        let on = self.ffmpeg.is_some();
        self.torrents.read().await.get(id).map(|e| stats_of(id, e, on))
    }

    pub async fn remove(&self, id: &str, delete_files: bool) -> Result<()> {
        let handle = self.torrents.write().await.remove(id).map(|e| e.handle);
        if let Some(h) = handle {
            // Stop + drop from the librqbit session. delete_files=true wipes partial
            // data — used to tear down ephemeral stream previews so they don't linger.
            let _ = self.session.delete(h.info_hash().into(), delete_files).await;
        }
        // Tear down any HLS transcode jobs for this torrent (kills ffmpeg + clears segments).
        let prefix = format!("{id}/");
        let mut jobs = self.hls.write().await;
        let keys: Vec<String> = jobs.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        for k in keys {
            if let Some(job) = jobs.remove(&k) {
                let _ = std::fs::remove_dir_all(&job.dir);
            }
        }
        Ok(())
    }

    /// Remove every torrent from the session. Incomplete ones have their partial data
    /// wiped; finished ones keep their on-disk file (the caller decides whether to trash
    /// those, e.g. keeping Library items). Returns how many were removed.
    pub async fn clear(&self) -> usize {
        let targets: Vec<(String, bool)> = {
            let g = self.torrents.read().await;
            g.iter().map(|(id, e)| (id.clone(), e.handle.stats().finished)).collect()
        };
        let n = targets.len();
        for (id, finished) in targets {
            let _ = self.remove(&id, !finished).await;
        }
        n
    }

    pub async fn set_paused(&self, id: &str, paused: bool) -> Result<()> {
        let handle = self.torrents.read().await.get(id).map(|e| e.handle.clone());
        if let Some(h) = handle {
            if paused {
                self.session.pause(&h).await?;
            } else {
                self.session.unpause(&h).await?;
            }
        }
        Ok(())
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
        let target = match name {
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

async fn build_snapshot(torrents: &Torrents, ffmpeg_on: bool) -> Vec<DownloadStats> {
    torrents
        .read()
        .await
        .iter()
        .map(|(id, e)| stats_of(id, e, ffmpeg_on))
        .filter(is_real_download)
        .collect()
}

/// A download is "real" — worth reporting to the UI — once it has actually pulled some
/// data, found peers, or is transferring. This drops dead/stalled phantoms (magnets that
/// were added but never resolved a swarm — mock catalog items, dead torrents) that would
/// otherwise inflate the Downloads count far past what's on disk.
fn is_real_download(d: &DownloadStats) -> bool {
    d.progress > 0.0 || d.peers > 0 || d.down_speed > 0 || d.up_speed > 0
}

fn stats_of(id: &str, e: &Entry, ffmpeg_on: bool) -> DownloadStats {
    let s = e.handle.stats();
    let has_meta = s.total_bytes > 0;
    let progress = if has_meta {
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
    let state = {
        use librqbit::TorrentStatsState as St;
        match s.state {
            St::Initializing => "connecting",
            St::Paused => "paused",
            St::Error => "error",
            St::Live => {
                if s.finished {
                    // Finished + still sharing to peers (or uploading) = seeding;
                    // finished + idle = ready (done, nobody pulling right now).
                    if up > 0 || peers > 0 {
                        "seeding"
                    } else {
                        "ready"
                    }
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

fn play_url(ffmpeg_on: bool, id: &str, file: usize, name: Option<&str>) -> String {
    // Only non-web-native VIDEO is transcoded. Audio + everything else is served raw.
    let kind = name.map_or("video", media_kind);
    let transcode = ffmpeg_on && kind == "video" && name.map_or(true, |n| !is_web_native(n));
    if transcode {
        format!("http://127.0.0.1:{STREAM_PORT}/hls/{id}/{file}/index.m3u8")
    } else {
        format!("http://127.0.0.1:{STREAM_PORT}/stream/{id}/{file}")
    }
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
    (find_bin("ffmpeg"), find_bin("ffprobe"))
}

fn find_bin(name: &str) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let p = Path::new(d).join(name);
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

/// Adds permissive CORS headers to every loopback response so the cross-origin
/// WKWebView page can read media bytes (un-taints audio for the Web Audio analyser).
async fn cors_headers(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, axum::http::HeaderValue::from_static("*"));
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, axum::http::HeaderValue::from_static("GET, HEAD, OPTIONS"));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, axum::http::HeaderValue::from_static("range, content-type"));
    h.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, axum::http::HeaderValue::from_static("content-range, content-length, accept-ranges"));
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

/// Serve the HLS playlist for a file, starting the ffmpeg transcode on first request
/// and waiting for the first segment so the player gets a usable playlist.
/// Serve a VOD-style HLS playlist that declares the full source duration, so the player
/// treats it as a normal seekable video (scrub the whole timeline, pause/resume) rather
/// than a live broadcast. Segments are produced on demand; the segment handler waits for
/// any ffmpeg hasn't reached yet (backward seeks are instant, forward seeks buffer).
async fn hls_playlist_handler(
    AxPath((id, file)): AxPath<(String, usize)>,
    AxState(state): AxState<ServerState>,
) -> Response {
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
            m3u8.push_str(&format!("#EXTINF:{d:.3},\nseg{i:05}.ts\n"));
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
                return (
                    [
                        (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                        (header::CACHE_CONTROL, "no-store"),
                    ],
                    content,
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
    AxState(state): AxState<ServerState>,
) -> Response {
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
            m3u8.push_str(&format!("#EXTINF:{d:.3},\nseg{i:05}.ts\n"));
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
                return (
                    [
                        (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                        (header::CACHE_CONTROL, "no-store"),
                    ],
                    content,
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
    let (_vcodec, acodec, duration, height) =
        tokio::time::timeout(Duration::from_secs(25), hls_probe(ffprobe, input))
            .await
            .unwrap_or((None, None, 0.0, 0));
    let acopy = matches!(acodec.as_deref(), Some("aac"));
    let vbitrate = match height {
        0..=480 => "2500k",
        481..=720 => "5000k",
        721..=1080 => "8000k",
        _ => "14000k",
    };

    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-i", input]);
    cmd.args(["-map", "0:v:0", "-map", "0:a:0?"]);
    cmd.args([
        "-c:v", "h264_videotoolbox",
        "-b:v", vbitrate,
        "-force_key_frames", "expr:gte(t,n_forced*4)",
        "-pix_fmt", "yuv420p",
    ]);
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

    let mut child = cmd.spawn().context("spawning ffmpeg (hls)")?;
    if let Some(mut stderr) = child.stderr.take() {
        let err_id = err_key.to_string();
        tauri::async_runtime::spawn(async move {
            let mut log = String::new();
            let _ = stderr.read_to_string(&mut log).await; // returns when ffmpeg exits
            let mut map = errors.write().await;
            if log.trim().is_empty() {
                map.remove(&err_id);
            } else {
                map.insert(err_id, log.trim().lines().last().unwrap_or("ffmpeg failed").to_string());
            }
        });
    }
    Ok((child, duration))
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
