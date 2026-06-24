//! Removable-device music sync. Detects connected MP3 players / SD cards (removable
//! volumes) and mirrors the Library's music onto them into a single folder, copying only
//! new or changed tracks so re-syncs are fast. An optional "mirror" mode also removes
//! tracks on the device that are no longer in the Library. Pure `std::fs` + `sysinfo` —
//! no external tools — so a freshly formatted FAT32/exFAT card just works.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::export;

/// A connected storage volume the user could sync music onto.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// Volume label (falls back to the mount-point folder name).
    pub name: String,
    /// Absolute mount path (`/Volumes/SANSA`, `E:\`, `/media/usb`, …).
    pub mount_path: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub removable: bool,
    pub file_system: String,
    /// A sync folder of the requested name already exists on the device…
    pub has_sync_folder: bool,
    /// …and holds this many audio files.
    pub synced_tracks: u64,
}

/// Audio extensions we manage on the device — used for the synced-track count and, in
/// mirror mode, to decide what we may delete (non-audio on the card is never touched).
const AUDIO_EXTS: &[&str] = &[
    "mp3", "flac", "m4a", "aac", "wav", "ogg", "oga", "opus", "aiff", "aif", "wma", "alac",
];

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Enumerate removable volumes, excluding the volume the Library itself lives on (so we
/// never offer to sync the source onto itself) and the system root. `library_root` is the
/// download dir; `sync_folder` is the folder name whose existing contents we report.
pub fn list(library_root: &Path, sync_folder: &str) -> Vec<Device> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();

    // The volume hosting the Library: the disk whose mount point is the longest prefix of
    // the download dir. We exclude it so the user can't sync the library onto itself.
    let lib_mount = disks
        .iter()
        .filter(|d| library_root.starts_with(d.mount_point()))
        .map(|d| d.mount_point().to_path_buf())
        .max_by_key(|p| p.components().count());

    let mut out = Vec::new();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    for d in &disks {
        if !d.is_removable() {
            continue;
        }
        let mount = d.mount_point().to_path_buf();
        if mount == Path::new("/") || Some(&mount) == lib_mount.as_ref() {
            continue;
        }
        if !seen.insert(mount.clone()) {
            continue; // some platforms list a volume more than once
        }
        let name = {
            let label = d.name().to_string_lossy().trim().to_string();
            if !label.is_empty() {
                label
            } else {
                mount
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| mount.display().to_string())
            }
        };
        let folder = mount.join(sync_folder);
        let has_sync_folder = folder.is_dir();
        let synced_tracks = if has_sync_folder { count_audio(&folder) } else { 0 };
        out.push(Device {
            name,
            mount_path: mount.display().to_string(),
            total_bytes: d.total_space(),
            free_bytes: d.available_space(),
            removable: true,
            file_system: d.file_system().to_string_lossy().to_string(),
            has_sync_folder,
            synced_tracks,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Short-lived cache of `count_audio` results, keyed by folder path. The device list is
/// re-polled every ~15s while the Sync tab is open; without this, an idle USB stick / SD card
/// gets fully re-walked on every poll (slow on spinning or USB-2 media). A sync that adds tracks
/// re-lists devices through its own completion path, so a brief staleness here is harmless.
fn count_audio_cache() -> &'static Mutex<HashMap<PathBuf, (u64, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (u64, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const COUNT_AUDIO_TTL: Duration = Duration::from_secs(20);

fn count_audio(dir: &Path) -> u64 {
    let now = Instant::now();
    if let Ok(cache) = count_audio_cache().lock() {
        if let Some((count, at)) = cache.get(dir) {
            if now.duration_since(*at) < COUNT_AUDIO_TTL {
                return *count;
            }
        }
    }
    let count = count_audio_inner(dir, 0);
    if let Ok(mut cache) = count_audio_cache().lock() {
        cache.insert(dir.to_path_buf(), (count, now));
    }
    count
}

fn count_audio_inner(dir: &Path, depth: usize) -> u64 {
    if depth > 12 {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut count = 0u64;
    for e in entries.flatten() {
        let p = e.path();
        if is_hidden(&p) {
            continue;
        }
        if p.is_dir() {
            count = count.saturating_add(count_audio_inner(&p, depth + 1));
        } else if is_audio(&p) {
            count = count.saturating_add(1);
        }
    }
    count
}

/// Device-relative path for a track: `Artist/Album/NN - Title.ext` (Artist-only when there
/// is no album), every segment filesystem-sanitized. Mirrors the desktop Library's organize
/// layout so a card created here looks identical to the app.
pub fn music_rel(
    artist: Option<&str>,
    album: Option<&str>,
    title: &str,
    track_no: Option<i64>,
    ext: &str,
) -> String {
    let artist = sanitize_or(artist, "Unknown Artist");
    let title = {
        let t = export::sanitize(title.trim());
        if t.is_empty() { "Untitled".to_string() } else { t }
    };
    let ext = {
        let e = ext.trim().trim_start_matches('.').to_ascii_lowercase();
        if e.is_empty() { "mp3".to_string() } else { e }
    };
    let file = match track_no.filter(|n| *n > 0) {
        Some(n) => format!("{n:02} - {title}.{ext}"),
        None => format!("{title}.{ext}"),
    };
    match album.map(str::trim).filter(|a| !a.is_empty()) {
        Some(a) => format!("{}/{}/{}", artist, sanitize_or(Some(a), "Unknown Album"), file),
        None => format!("{}/{}", artist, file),
    }
}

fn sanitize_or(raw: Option<&str>, fallback: &str) -> String {
    let cleaned = export::sanitize(raw.unwrap_or("").trim());
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// One track to put on the device.
pub struct SyncFile {
    /// Absolute source path in the Library.
    pub src: PathBuf,
    /// Destination path relative to the device sync folder.
    pub rel: String,
    /// Source byte size (the cheap "unchanged" check).
    pub size: u64,
}

/// One file's outcome, streamed to the UI the moment it happens.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncStep {
    /// Which pass this step belongs to: "copy" (transferring tracks) or "mirror"
    /// (deleting tracks no longer in the Library). Carried explicitly so the UI never has
    /// to infer the phase from `action` — a delete-pass error is still phase "mirror".
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub file: String,
    /// "copying" | "copied" | "skipped" | "deleted" | "error" | "playlist" (a written playlist)
    pub action: String,
    pub message: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    /// Absolute device folder synced into.
    pub folder: String,
    pub copied: usize,
    pub skipped: usize,
    pub deleted: usize,
    pub errors: usize,
    pub bytes_copied: u64,
    pub total_tracks: usize,
    /// Playlists written onto the device (0 unless playlist sync was enabled).
    pub playlists_written: usize,
    /// Track references written (m3u entries) or track copies made (folders mode).
    pub playlist_tracks: usize,
}

/// Copy `files` into `dest_root`, skipping tracks already present at the same byte size.
/// A small hidden `.ghostwire-sync.json` manifest at `dest_root` records what was synced
/// (rel → size), so a re-sync skips unchanged tracks straight from the manifest — no
/// per-file stat against the (often slow) device, which is what made big re-syncs crawl.
/// When `mirror` is set, audio files under `dest_root` that aren't in `files` are deleted
/// and emptied folders pruned. Each outcome is reported via `on_progress` as it happens.
pub fn sync(
    files: &[SyncFile],
    dest_root: &Path,
    mirror: bool,
    on_progress: impl Fn(SyncStep),
) -> SyncResult {
    let mut result = SyncResult {
        folder: dest_root.display().to_string(),
        total_tracks: files.len(),
        ..Default::default()
    };

    if let Err(e) = std::fs::create_dir_all(dest_root) {
        result.errors += 1;
        on_progress(SyncStep {
            phase: "copy".into(),
            done: 0,
            total: files.len(),
            file: dest_root.display().to_string(),
            action: "error".into(),
            message: Some(e.to_string()),
        });
        return result;
    }

    // Mirror bookkeeping: the absolute dest paths we intend to keep.
    let mut wanted: BTreeSet<PathBuf> = BTreeSet::new();
    // Fast-skip manifest: rel -> source size from the last sync. Skipping an
    // unchanged track from the manifest avoids stat-ing its destination on the
    // (often slow) device — the per-file stat is what made big re-syncs crawl.
    // `next` accumulates what's on the device now and is written back at the end.
    let prior = load_manifest(dest_root);
    let mut next: HashMap<String, u64> = HashMap::with_capacity(files.len());
    let total = files.len();
    for (idx, f) in files.iter().enumerate() {
        let dest = dest_root.join(&f.rel);
        wanted.insert(dest.clone());
        // `||` short-circuits: a track the manifest already records at this exact
        // size is skipped without ever touching the card; only manifest misses
        // fall through to the (slower) on-device size check.
        if prior.get(f.rel.as_str()).copied() == Some(f.size) || up_to_date(&dest, f.size) {
            result.skipped += 1;
            next.insert(f.rel.clone(), f.size);
            on_progress(SyncStep {
                phase: "copy".into(),
                done: idx + 1,
                total,
                file: f.rel.clone(),
                action: "skipped".into(),
                message: None,
            });
            continue;
        }
        // Announce the in-flight track BEFORE the (possibly slow) copy, so the UI shows the
        // song currently transferring in real time — not just the ones already finished.
        on_progress(SyncStep {
            phase: "copy".into(),
            done: idx,
            total,
            file: f.rel.clone(),
            action: "copying".into(),
            message: None,
        });
        let (action, message): (&str, Option<String>) = match copy_file(&f.src, &dest) {
            Ok(n) => {
                result.copied += 1;
                result.bytes_copied += n;
                next.insert(f.rel.clone(), f.size);
                ("copied", None)
            }
            Err(e) => {
                result.errors += 1;
                ("error", Some(e))
            }
        };
        on_progress(SyncStep {
            phase: "copy".into(),
            done: idx + 1,
            total,
            file: f.rel.clone(),
            action: action.into(),
            message,
        });
    }

    if mirror {
        let mut existing = Vec::new();
        collect_audio(dest_root, 0, &mut existing);
        let extras: Vec<PathBuf> = existing.into_iter().filter(|p| !wanted.contains(p)).collect();
        let del_total = extras.len();
        for (idx, p) in extras.iter().enumerate() {
            let name = p.strip_prefix(dest_root).unwrap_or(p).display().to_string();
            match std::fs::remove_file(p) {
                Ok(()) => {
                    result.deleted += 1;
                    on_progress(SyncStep {
                        phase: "mirror".into(),
                        done: idx + 1,
                        total: del_total,
                        file: name,
                        action: "deleted".into(),
                        message: None,
                    });
                }
                Err(e) => {
                    result.errors += 1;
                    on_progress(SyncStep {
                        phase: "mirror".into(),
                        done: idx + 1,
                        total: del_total,
                        file: name,
                        action: "error".into(),
                        message: Some(e.to_string()),
                    });
                }
            }
        }
        prune_empty_dirs(dest_root);
    }

    // Record what's on the device so the next re-sync can skip unchanged tracks
    // without a per-file stat. Best-effort: a write failure only forfeits next
    // time's fast path, so it's never counted as a sync error.
    write_manifest(dest_root, next);

    result
}

// ---- playlist sync ----

/// How playlists are written onto the device.
pub enum PlaylistMode {
    /// `Playlists/<name>.m3u8` text files referencing the synced tracks via relative
    /// `../<music_folder>/...` paths. No audio is duplicated.
    M3u8,
    /// `Playlists/<name>/` folders with the tracks COPIED in (numbered to preserve order),
    /// for players that can't read .m3u. This duplicates the audio.
    Folders,
}

impl PlaylistMode {
    pub fn parse(s: &str) -> PlaylistMode {
        match s.trim().to_ascii_lowercase().as_str() {
            "folders" | "folder" => PlaylistMode::Folders,
            _ => PlaylistMode::M3u8,
        }
    }
}

/// One track in a device playlist — already matched to its synced location on the card.
pub struct PlaylistEntry {
    /// Absolute source path in the Library (for folders mode's copy).
    pub src: PathBuf,
    /// The track's path under the device music folder: `Artist/Album/NN - Title.ext`.
    pub device_rel: String,
    pub title: String,
    pub artist: String,
    pub duration_secs: i64,
    pub size: u64,
}

pub struct PlaylistSpec {
    pub name: String,
    /// Ordered, already filtered to tracks that are present on the device.
    pub entries: Vec<PlaylistEntry>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSyncResult {
    pub playlists_written: usize,
    /// m3u entries written, or (folders mode) track copies made.
    pub entries_written: usize,
    /// Actual audio files copied (folders mode only) — folded into the run's `copied` total.
    pub tracks_copied: usize,
    pub bytes_copied: u64,
    pub errors: usize,
}

/// Write the app's playlists into a `Playlists/` folder at the device root. M3u8 mode writes
/// `.m3u8` text files that reference the already-synced tracks with relative `../<music_folder>/`
/// paths (no audio duplicated). Folders mode creates one folder per playlist and copies the
/// tracks in, numbered to preserve order (this DOES duplicate audio — for players that can't
/// read .m3u). Additive only: never deletes existing playlists on the device.
pub fn sync_playlists(
    specs: &[PlaylistSpec],
    device_root: &Path,
    music_folder: &str,
    mode: PlaylistMode,
    on_progress: impl Fn(SyncStep),
) -> PlaylistSyncResult {
    let mut result = PlaylistSyncResult::default();
    let root = device_root.join("Playlists");
    if let Err(e) = std::fs::create_dir_all(&root) {
        result.errors += 1;
        on_progress(SyncStep {
            phase: "playlists".into(),
            done: 0,
            total: specs.len(),
            file: root.display().to_string(),
            action: "error".into(),
            message: Some(e.to_string()),
        });
        return result;
    }

    // Playlist names aren't unique and can collide after sanitizing (e.g. "Rock/Pop" and
    // "Rock Pop"), so resolve a DISTINCT on-device base name per playlist up front — else
    // one would clobber another (m3u8) or merge into one folder (folders). Case-insensitive
    // because FAT/exFAT are.
    let mut taken: BTreeSet<String> = BTreeSet::new();
    let named: Vec<(String, &PlaylistSpec)> = specs
        .iter()
        .map(|spec| (unique_playlist_name(&playlist_name(&spec.name), &mut taken), spec))
        .collect();

    match mode {
        PlaylistMode::M3u8 => {
            let total = named.len();
            for (idx, (base, spec)) in named.iter().enumerate() {
                let body = build_m3u8(spec, music_folder);
                let file = root.join(format!("{base}.m3u8"));
                let (action, message): (&str, Option<String>) = match std::fs::write(&file, body) {
                    Ok(()) => {
                        result.playlists_written += 1;
                        result.entries_written += spec.entries.len();
                        ("playlist", None)
                    }
                    Err(e) => {
                        result.errors += 1;
                        ("error", Some(e.to_string()))
                    }
                };
                on_progress(SyncStep {
                    phase: "playlists".into(),
                    done: idx + 1,
                    total,
                    file: spec.name.clone(),
                    action: action.into(),
                    message,
                });
            }
        }
        PlaylistMode::Folders => {
            // The real work is copying tracks, so the bar tracks total entries across playlists.
            let total: usize = named.iter().map(|(_, s)| s.entries.len()).sum();
            let mut done = 0usize;
            for (base, spec) in &named {
                let pl_dir = root.join(base);
                if std::fs::create_dir_all(&pl_dir).is_err() {
                    result.errors += 1;
                    continue;
                }
                // The filename carries the playlist position, so a reorder/removal would
                // otherwise leave stale numbered copies. Prune our own "NNN - …" audio files
                // that aren't in this run's wanted set first; user-placed files are untouched.
                let wanted: BTreeSet<String> =
                    spec.entries.iter().enumerate().map(|(i, e)| folder_track_name(e, i + 1)).collect();
                if let Ok(rd) = std::fs::read_dir(&pl_dir) {
                    for ent in rd.flatten() {
                        let p = ent.path();
                        if !p.is_file() || is_hidden(&p) || !is_audio(&p) {
                            continue;
                        }
                        if let Some(fname) = p.file_name().and_then(|s| s.to_str()) {
                            if is_indexed_copy(fname) && !wanted.contains(fname) {
                                let _ = std::fs::remove_file(&p);
                            }
                        }
                    }
                }
                let mut ok = false;
                for (i, e) in spec.entries.iter().enumerate() {
                    done += 1;
                    let dest = pl_dir.join(folder_track_name(e, i + 1));
                    let (action, message): (&str, Option<String>) = if up_to_date(&dest, e.size) {
                        ok = true;
                        ("skipped", None)
                    } else {
                        match copy_file(&e.src, &dest) {
                            Ok(n) => {
                                result.bytes_copied += n;
                                result.entries_written += 1;
                                result.tracks_copied += 1;
                                ok = true;
                                ("copied", None)
                            }
                            Err(err) => {
                                result.errors += 1;
                                ("error", Some(err))
                            }
                        }
                    };
                    on_progress(SyncStep {
                        phase: "playlists".into(),
                        done,
                        total,
                        file: format!("{}/{}", spec.name, dest.file_name().and_then(|s| s.to_str()).unwrap_or("")),
                        action: action.into(),
                        message,
                    });
                }
                if ok {
                    result.playlists_written += 1;
                }
            }
        }
    }
    result
}

/// Resolve a unique on-device base name: the sanitized name, or `name (2)`, `name (3)`… if a
/// previous playlist this run already took it (case-insensitive, since FAT/exFAT are).
fn unique_playlist_name(base: &str, taken: &mut BTreeSet<String>) -> String {
    if taken.insert(base.to_lowercase()) {
        return base.to_string();
    }
    for n in 2..1000 {
        let cand = format!("{base} ({n})");
        if taken.insert(cand.to_lowercase()) {
            return cand;
        }
    }
    base.to_string()
}

/// True for a file we created in folders mode: `NNN - …` (three digits + " - " prefix). Used
/// to prune our own stale numbered copies without touching files the user placed there.
fn is_indexed_copy(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() > 6 && b[0].is_ascii_digit() && b[1].is_ascii_digit() && b[2].is_ascii_digit() && &name[3..6] == " - "
}

/// `#EXTM3U` body referencing each track relative to the `Playlists/` folder, e.g.
/// `../Music/Artist/Album/01 - Song.flac`. UTF-8 (`.m3u8`).
fn build_m3u8(spec: &PlaylistSpec, music_folder: &str) -> String {
    let mut s = String::from("#EXTM3U\n");
    for e in &spec.entries {
        let label = if e.artist.is_empty() { e.title.clone() } else { format!("{} - {}", e.artist, e.title) };
        let dur = if e.duration_secs > 0 { e.duration_secs } else { -1 };
        s.push_str(&format!("#EXTINF:{dur},{label}\n"));
        s.push_str(&format!("../{music_folder}/{}\n", e.device_rel));
    }
    s
}

/// Sanitized playlist file/folder base name. `.`/`..` are rejected (sanitize keeps dots) so a
/// folders-mode playlist can never escape the `Playlists/` directory.
fn playlist_name(name: &str) -> String {
    let n = export::sanitize(name.trim());
    if n.is_empty() || n == "." || n == ".." { "Playlist".to_string() } else { n }
}

/// Ordered flat filename for a folders-mode copy: `NNN - Artist - Title.ext`, so a
/// folder-browsing player plays the playlist in order (firmware sorts by filename).
fn folder_track_name(e: &PlaylistEntry, position: usize) -> String {
    let ext = e
        .src
        .extension()
        .and_then(|x| x.to_str())
        .map(|x| x.to_ascii_lowercase())
        .filter(|x| !x.is_empty())
        .unwrap_or_else(|| "mp3".to_string());
    let stem_raw = if e.artist.is_empty() { e.title.clone() } else { format!("{} - {}", e.artist, e.title) };
    let stem = export::sanitize(stem_raw.trim());
    let stem = if stem.is_empty() { "Track".to_string() } else { stem };
    format!("{position:03} - {stem}.{ext}")
}

/// A track is up to date when a same-named file already exists at the same byte size.
/// (Re-syncs are common; matching size is a cheap, FAT/exFAT-safe "unchanged" proxy that
/// avoids re-copying gigabytes every time.)
fn up_to_date(dest: &Path, size: u64) -> bool {
    std::fs::metadata(dest).map(|m| m.is_file() && m.len() == size).unwrap_or(false)
}

/// Name of the on-device sync manifest. Hidden (leading dot) so `is_hidden` keeps it out of
/// the synced-track count and mirror mode never deletes it.
const MANIFEST_NAME: &str = ".ghostwire-sync.json";

/// On-device record of the last sync: each track's device-relative path → source byte size.
/// A re-sync consults it to skip unchanged tracks without stat-ing every destination on the
/// card (the per-file stat is what made big re-syncs slow). Versioned so the format can evolve.
#[derive(Serialize, Deserialize, Default)]
struct SyncManifest {
    version: u32,
    tracks: HashMap<String, u64>,
}

/// Read the device manifest (rel → size). A missing or unreadable/old-format manifest yields
/// an empty map, so the first sync after this shipped simply falls back to per-file stats and
/// then writes a manifest for next time.
fn load_manifest(dest_root: &Path) -> HashMap<String, u64> {
    std::fs::read(dest_root.join(MANIFEST_NAME))
        .ok()
        .and_then(|b| serde_json::from_slice::<SyncManifest>(&b).ok())
        .map(|m| m.tracks)
        .unwrap_or_default()
}

/// Write the manifest describing what is now on the device. Best-effort: a failure only
/// forfeits the next re-sync's fast path, so it is never surfaced as a sync error.
fn write_manifest(dest_root: &Path, tracks: HashMap<String, u64>) {
    let manifest = SyncManifest { version: 1, tracks };
    if let Ok(bytes) = serde_json::to_vec(&manifest) {
        let _ = std::fs::write(dest_root.join(MANIFEST_NAME), bytes);
    }
}

fn copy_file(src: &Path, dest: &Path) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(src, dest).map_err(|e| e.to_string())
}

/// True for hidden entries (`.DS_Store`, AppleDouble `._Track.flac`, `.Spotlight-V100`,
/// `.Trashes`, …). We never count or touch these — only real audio the app put there.
fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

fn collect_audio(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 12 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if is_hidden(&p) {
            continue;
        }
        if p.is_dir() {
            collect_audio(&p, depth + 1, out);
        } else if is_audio(&p) {
            out.push(p);
        }
    }
}

/// Remove now-empty directories under `root` (deepest first); never removes `root` itself.
fn prune_empty_dirs(root: &Path) {
    let mut dirs = Vec::new();
    collect_dirs(root, 0, &mut dirs);
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        if d != root {
            let _ = std::fs::remove_dir(&d); // no-op unless empty
        }
    }
}

fn collect_dirs(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 12 {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_uses_artist_album_track() {
        assert_eq!(
            music_rel(Some("BENEE"), Some("Lychee"), "Make You Sick", Some(7), "flac"),
            "BENEE/Lychee/07 - Make You Sick.flac"
        );
    }

    #[test]
    fn rel_without_album_is_artist_only() {
        assert_eq!(
            music_rel(Some("Aphex Twin"), None, "Avril 14th", None, "mp3"),
            "Aphex Twin/Avril 14th.mp3"
        );
    }

    #[test]
    fn rel_falls_back_when_tags_missing() {
        assert_eq!(music_rel(None, None, "", None, ""), "Unknown Artist/Untitled.mp3");
    }

    #[test]
    fn sync_copies_then_skips_unchanged() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("bp-devsync-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let lib = base.join("lib");
        let dev = base.join("dev");
        fs::create_dir_all(&lib).unwrap();
        let song = lib.join("song.flac");
        fs::write(&song, vec![0u8; 1024]).unwrap();

        let files = vec![SyncFile { src: song.clone(), rel: "A/B/01 - Song.flac".into(), size: 1024 }];
        let r1 = sync(&files, &dev, false, |_| {});
        assert_eq!(r1.copied, 1);
        assert_eq!(r1.skipped, 0);
        assert!(dev.join("A/B/01 - Song.flac").is_file());

        // Second run: same size → skipped, nothing recopied.
        let r2 = sync(&files, &dev, false, |_| {});
        assert_eq!(r2.copied, 0);
        assert_eq!(r2.skipped, 1);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn manifest_skips_unchanged_without_restat_and_refreshes_on_change() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("bp-devmanifest-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let lib = base.join("lib");
        let dev = base.join("dev");
        fs::create_dir_all(&lib).unwrap();
        let song = lib.join("song.flac");
        fs::write(&song, vec![0u8; 1024]).unwrap();
        let files = vec![SyncFile { src: song.clone(), rel: "A/B/01 - Song.flac".into(), size: 1024 }];

        // First sync copies the track AND drops a manifest next to it.
        let r1 = sync(&files, &dev, false, |_| {});
        assert_eq!(r1.copied, 1);
        assert!(dev.join(MANIFEST_NAME).is_file(), "a manifest is written after a sync");

        // The manifest is authoritative for skipping: delete the dest file but keep the
        // manifest, and a re-sync still skips it (no per-file device stat) — proving the
        // fast path no longer depends on touching the card for already-synced tracks.
        fs::remove_file(dev.join("A/B/01 - Song.flac")).unwrap();
        let r2 = sync(&files, &dev, false, |_| {});
        assert_eq!(r2.skipped, 1);
        assert_eq!(r2.copied, 0);

        // A manifest entry whose recorded size no longer matches is NOT trusted: the size
        // check fails, it falls through to the on-device stat, and (dest missing) re-copies.
        fs::remove_file(dev.join("A/B/01 - Song.flac")).ok();
        fs::write(dev.join(MANIFEST_NAME), br#"{"version":1,"tracks":{"A/B/01 - Song.flac":99}}"#).unwrap();
        let r3 = sync(&files, &dev, false, |_| {});
        assert_eq!(r3.copied, 1, "a stale-size manifest entry forces a re-copy");
        assert!(dev.join("A/B/01 - Song.flac").is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn emits_copying_before_copied_for_real_transfers() {
        use std::fs;
        use std::sync::Mutex;
        let base = std::env::temp_dir().join(format!("bp-devfeed-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let lib = base.join("lib");
        let dev = base.join("dev");
        fs::create_dir_all(&lib).unwrap();
        let song = lib.join("song.flac");
        fs::write(&song, vec![0u8; 2048]).unwrap();
        let files = vec![SyncFile { src: song.clone(), rel: "A/01 - Song.flac".into(), size: 2048 }];

        let log: Mutex<Vec<String>> = Mutex::new(Vec::new());
        sync(&files, &dev, false, |s| log.lock().unwrap_or_else(|e| e.into_inner()).push(s.action.clone()));
        let actions = log.into_inner().unwrap();
        // First run announces the in-flight track, then its completion.
        assert_eq!(actions, vec!["copying".to_string(), "copied".to_string()]);

        // A re-sync of an unchanged track skips it outright — no in-flight "copying" noise.
        let log2: Mutex<Vec<String>> = Mutex::new(Vec::new());
        sync(&files, &dev, false, |s| log2.lock().unwrap_or_else(|e| e.into_inner()).push(s.action.clone()));
        assert_eq!(log2.into_inner().unwrap(), vec!["skipped".to_string()]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn mirror_removes_extras_but_keeps_non_audio() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("bp-devmirror-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let lib = base.join("lib");
        let dev = base.join("dev");
        fs::create_dir_all(&lib).unwrap();
        let keep = lib.join("keep.flac");
        fs::write(&keep, vec![0u8; 512]).unwrap();

        // Seed the device with a stale track + a user file we must NOT delete.
        fs::create_dir_all(dev.join("Old/Album")).unwrap();
        fs::write(dev.join("Old/Album/99 - Gone.mp3"), vec![0u8; 256]).unwrap();
        fs::write(dev.join("notes.txt"), b"mine").unwrap();

        let files = vec![SyncFile { src: keep.clone(), rel: "New/01 - Keep.flac".into(), size: 512 }];
        let r = sync(&files, &dev, true, |_| {});
        assert_eq!(r.copied, 1);
        assert_eq!(r.deleted, 1, "the stale track is removed");
        assert!(dev.join("New/01 - Keep.flac").is_file());
        assert!(!dev.join("Old/Album/99 - Gone.mp3").exists(), "stale audio gone");
        assert!(!dev.join("Old").exists(), "emptied folders pruned");
        assert!(dev.join("notes.txt").is_file(), "non-audio user files are never touched");
        let _ = fs::remove_dir_all(&base);
    }

    fn entry(src: &Path, rel: &str, artist: &str, title: &str, size: u64) -> PlaylistEntry {
        PlaylistEntry {
            src: src.to_path_buf(),
            device_rel: rel.into(),
            title: title.into(),
            artist: artist.into(),
            duration_secs: 180,
            size,
        }
    }

    #[test]
    fn m3u8_writes_relative_paths_no_duplication() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("bp-plm3u-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dev = base.join("dev");
        let song = base.join("src/song.flac");
        fs::create_dir_all(song.parent().unwrap()).unwrap();
        fs::write(&song, vec![0u8; 100]).unwrap();

        let spec = PlaylistSpec {
            name: "Road Trip".into(),
            entries: vec![entry(&song, "BENEE/Lychee/07 - Make You Sick.flac", "BENEE", "Make You Sick", 100)],
        };
        let r = sync_playlists(&[spec], &dev, "Music", PlaylistMode::M3u8, |_| {});
        assert_eq!(r.playlists_written, 1);
        assert_eq!(r.entries_written, 1);
        assert_eq!(r.bytes_copied, 0, "m3u mode copies no audio");

        let file = dev.join("Playlists/Road Trip.m3u8");
        assert!(file.is_file(), "the .m3u8 is written to Playlists/");
        let body = fs::read_to_string(&file).unwrap();
        assert!(body.starts_with("#EXTM3U"));
        assert!(body.contains("../Music/BENEE/Lychee/07 - Make You Sick.flac"), "relative ../Music path:\n{body}");
        assert!(body.contains("#EXTINF:180,BENEE - Make You Sick"));
        // No audio duplicated — the Playlists folder holds only the text file.
        assert!(!dev.join("Playlists/BENEE").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn folders_mode_copies_numbered_tracks_in_order() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("bp-plfold-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dev = base.join("dev");
        let a = base.join("src/a.flac");
        let b = base.join("src/b.mp3");
        fs::create_dir_all(a.parent().unwrap()).unwrap();
        fs::write(&a, vec![0u8; 10]).unwrap();
        fs::write(&b, vec![0u8; 20]).unwrap();

        let spec = PlaylistSpec {
            name: "Mix/2024".into(), // slash must be sanitized out of the folder name
            entries: vec![
                entry(&a, "X/Y/01 - First.flac", "X", "First", 10),
                entry(&b, "Z/02 - Second.mp3", "Z", "Second", 20),
            ],
        };
        let r = sync_playlists(&[spec], &dev, "Music", PlaylistMode::Folders, |_| {});
        assert_eq!(r.playlists_written, 1);
        assert_eq!(r.entries_written, 2);
        assert_eq!(r.bytes_copied, 30);

        // Folder name is sanitized (no slash); tracks are numbered in playlist order.
        let dirs: Vec<_> = fs::read_dir(dev.join("Playlists")).unwrap().flatten().filter(|e| e.path().is_dir()).collect();
        assert_eq!(dirs.len(), 1);
        let pl = dirs[0].path();
        assert!(pl.join("001 - X - First.flac").is_file(), "ordered copy 1");
        assert!(pl.join("002 - Z - Second.mp3").is_file(), "ordered copy 2");

        // Re-sync with the 2nd entry removed: the kept track is skipped (no recopy) and the
        // now-stale numbered copy is pruned, so reorders/removals don't accrete orphans.
        let r2 = sync_playlists(
            &[PlaylistSpec { name: "Mix/2024".into(), entries: vec![entry(&a, "X/Y/01 - First.flac", "X", "First", 10)] }],
            &dev,
            "Music",
            PlaylistMode::Folders,
            |_| {},
        );
        assert_eq!(r2.bytes_copied, 0, "unchanged track not recopied");
        assert!(pl.join("001 - X - First.flac").is_file(), "kept track stays");
        assert!(!pl.join("002 - Z - Second.mp3").exists(), "stale numbered copy pruned on re-sync");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn colliding_playlist_names_stay_distinct() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("bp-plcollide-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dev = base.join("dev");
        let song = base.join("src/s.flac");
        fs::create_dir_all(song.parent().unwrap()).unwrap();
        fs::write(&song, vec![0u8; 50]).unwrap();
        let mk = |name: &str| PlaylistSpec {
            name: name.into(),
            entries: vec![entry(&song, "A/01 - S.flac", "A", "S", 50)],
        };
        // "Rock/Pop" sanitizes to "Rock Pop" — same as the literal "Rock Pop".
        let r = sync_playlists(&[mk("Rock/Pop"), mk("Rock Pop")], &dev, "Music", PlaylistMode::M3u8, |_| {});
        assert_eq!(r.playlists_written, 2, "both counted");
        assert!(dev.join("Playlists/Rock Pop.m3u8").is_file());
        assert!(dev.join("Playlists/Rock Pop (2).m3u8").is_file(), "the collision gets a (2) suffix, not a clobber");
        let _ = fs::remove_dir_all(&base);
    }
}
