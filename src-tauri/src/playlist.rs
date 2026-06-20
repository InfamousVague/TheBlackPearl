//! Playlists as portable JSON manifests on disk (`data_dir/playlists/<id>.json`).
//! Each manifest lists its songs (title/artist/album/duration/isrc + the local file
//! path once downloaded). Manifests export to the common player formats — M3U8
//! (Rockbox), M3U, PLS and XSPF — and import back from any of them.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTrack {
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub duration_ms: i64,
    #[serde(default)]
    pub isrc: Option<String>,
    /// Absolute local path to the audio file, once matched/downloaded.
    #[serde(default)]
    pub path: Option<String>,
    /// open.spotify.com link, when this came from Spotify.
    #[serde(default)]
    pub spotify_url: Option<String>,
    /// Loopback stream URL the player can play. Recomputed on every read, so the
    /// stored value (if any) is just a harmless cache.
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// "spotify" | "manual" | "import"
    #[serde(default)]
    pub source: String,
    pub tracks: Vec<PlaylistTrack>,
}

pub fn dir(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join("playlists")
}

fn id_from(name: &str, now: i64) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(24)
        .collect();
    let slug = if slug.is_empty() { "playlist".to_string() } else { slug };
    format!("{slug}-{now:x}")
}

pub fn list(data_dir: &str) -> Vec<Playlist> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir(data_dir)) {
        for e in rd.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) == Some("json") {
                if let Ok(s) = std::fs::read_to_string(e.path()) {
                    if let Ok(p) = serde_json::from_str::<Playlist>(&s) {
                        out.push(p);
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

pub fn load(data_dir: &str, id: &str) -> Result<Playlist, String> {
    let path = dir(data_dir).join(format!("{}.json", safe_id(id)));
    let s = std::fs::read_to_string(&path).map_err(|e| format!("playlist not found: {e}"))?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

pub fn save(data_dir: &str, p: &Playlist) -> Result<(), String> {
    let d = dir(data_dir);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let path = d.join(format!("{}.json", safe_id(&p.id)));
    let json = serde_json::to_string_pretty(p).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

pub fn delete(data_dir: &str, id: &str) -> Result<(), String> {
    let path = dir(data_dir).join(format!("{}.json", safe_id(id)));
    let _ = std::fs::remove_file(path);
    Ok(())
}

pub fn create(data_dir: &str, name: &str, source: &str, now: i64, tracks: Vec<PlaylistTrack>) -> Result<Playlist, String> {
    let p = Playlist {
        id: id_from(name, now),
        name: name.trim().to_string(),
        description: String::new(),
        created_at: now,
        updated_at: now,
        source: source.to_string(),
        tracks,
    };
    save(data_dir, &p)?;
    Ok(p)
}

fn safe_id(id: &str) -> String {
    id.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect()
}

fn norm(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Match each unresolved track to a local audio file under `download_dir`. Returns how many
/// were newly resolved. Matching is by normalized title against each file's full path, with
/// artist + album adding weight — so same-named songs in different albums resolve to their own
/// file instead of all collapsing onto the first title match. Each file is claimed by at most
/// one track (a genuinely repeated song falls back to sharing), which is what stops the
/// "wrong song plays" / "duplicate gets skipped" collisions on identical filenames.
type AudioIndexCache = Mutex<Option<(String, Instant, Arc<Vec<(String, String)>>)>>;
static AUDIO_INDEX: OnceLock<AudioIndexCache> = OnceLock::new();
fn audio_index_cell() -> &'static AudioIndexCache {
    AUDIO_INDEX.get_or_init(|| Mutex::new(None))
}

/// Drop the cached audio-file index so the next playlist resolve rescans the library. Called
/// from `invalidate_scan` whenever the library changes (a download lands, files are removed),
/// so a freshly-added song is matchable immediately instead of after the TTL.
pub fn invalidate_audio_index() {
    if let Ok(mut g) = audio_index_cell().lock() {
        *g = None;
    }
}

/// A cached index of `(absolute_path, normalized_path)` for every audio file under the
/// download dir. Scanning a large library (thousands of files) on *every* playlist mutation —
/// each like, reorder, or open — was walking the whole tree and freezing the UI. We memoize
/// the scan for a short window so a burst of operations reuses one walk; library changes
/// invalidate it eagerly (and the TTL is a backstop).
fn audio_index(download_dir: &str) -> Arc<Vec<(String, String)>> {
    const TTL: Duration = Duration::from_secs(15);
    let cell = audio_index_cell();
    if let Ok(guard) = cell.lock() {
        if let Some((dir, at, files)) = guard.as_ref() {
            if dir == download_dir && at.elapsed() < TTL {
                return files.clone();
            }
        }
    }
    // Rebuild outside the lock (the scan can be slow) and then publish.
    let files: Arc<Vec<(String, String)>> = Arc::new(
        crate::export::scan(Path::new(download_dir))
            .into_iter()
            .filter(|e| e.kind == "audio")
            .map(|e| (e.path.clone(), norm(&e.path)))
            .collect(),
    );
    if let Ok(mut guard) = cell.lock() {
        *guard = Some((download_dir.to_string(), Instant::now(), files.clone()));
    }
    files
}

pub fn resolve_paths(download_dir: &str, p: &mut Playlist) -> usize {
    // Nothing to do if every track already points at an existing file — skip the library
    // scan entirely (the common case for removing, reordering, or re-opening a playlist that
    // was resolved on a previous visit). This is what makes liking / opening feel instant.
    let needs_scan = p
        .tracks
        .iter()
        .any(|t| !t.path.as_deref().map(|x| Path::new(x).exists()).unwrap_or(false));
    if !needs_scan {
        return 0;
    }
    let files = audio_index(download_dir);
    if files.is_empty() {
        return 0;
    }
    // Files already taken by a track, so two tracks never resolve to the same file (unless a
    // song legitimately repeats and no other match is left — see the fallback below).
    let mut claimed = vec![false; files.len()];
    for t in p.tracks.iter() {
        if let Some(path) = t.path.as_deref() {
            if Path::new(path).exists() {
                if let Some(i) = files.iter().position(|(abs, _)| abs == path) {
                    claimed[i] = true;
                }
            }
        }
    }
    let mut resolved = 0;
    for t in &mut p.tracks {
        if t.path.as_deref().map(|x| Path::new(x).exists()).unwrap_or(false) {
            continue;
        }
        let title = norm(&t.title);
        if title.len() < 2 {
            continue;
        }
        let artist = norm(&t.artist);
        let album = norm(&t.album);
        // Score every file whose path contains the title; artist and album each add weight so
        // the most specific match wins. Track the best unclaimed file and the best overall.
        let mut best_free: Option<(usize, u32)> = None;
        let mut best_any: Option<(usize, u32)> = None;
        for (i, (_, h)) in files.iter().enumerate() {
            if !h.contains(&title) {
                continue;
            }
            let mut score = 1u32;
            if !artist.is_empty() && h.contains(&artist) {
                score += 2;
            }
            if !album.is_empty() && h.contains(&album) {
                score += 2;
            }
            if best_any.map_or(true, |(_, bs)| score > bs) {
                best_any = Some((i, score));
            }
            if !claimed[i] && best_free.map_or(true, |(_, bs)| score > bs) {
                best_free = Some((i, score));
            }
        }
        if let Some((i, _)) = best_free {
            t.path = Some(files[i].0.clone());
            claimed[i] = true;
            resolved += 1;
        } else if let Some((i, _)) = best_any {
            // Every file matching this title is already claimed → a genuinely repeated song;
            // share the best match rather than dropping it from the playlist.
            t.path = Some(files[i].0.clone());
            resolved += 1;
        }
    }
    resolved
}

// ---------------- export ----------------

fn secs(ms: i64) -> i64 {
    if ms > 0 {
        (ms as f64 / 1000.0).round() as i64
    } else {
        -1
    }
}

/// Render the path written into a playlist file: relative to the playlist's own
/// directory when the audio lives under it (portable for Rockbox / a media drive),
/// else the absolute path.
fn rel_or_abs(abs: &str, out_dir: &Path) -> String {
    let p = Path::new(abs);
    if let Ok(rel) = p.strip_prefix(out_dir) {
        rel.to_string_lossy().replace('\\', "/")
    } else {
        abs.to_string()
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Write the playlist to `out_dir` in `format` ("m3u8"|"m3u"|"pls"|"xspf").
/// Returns (written_file_path, tracks_written, tracks_skipped). Only tracks with a
/// resolved local file are written — a playlist pointing at missing files is useless.
pub fn export(p: &Playlist, format: &str, out_dir: &Path) -> Result<(String, usize, usize), String> {
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let playable: Vec<&PlaylistTrack> = p.tracks.iter().filter(|t| t.path.is_some()).collect();
    let skipped = p.tracks.len() - playable.len();

    let base = crate::export::sanitize(&p.name);
    let base = if base.is_empty() { "playlist".to_string() } else { base };
    let ext = match format {
        "m3u" => "m3u",
        "pls" => "pls",
        "xspf" => "xspf",
        _ => "m3u8",
    };
    let file = out_dir.join(format!("{base}.{ext}"));

    let body = match format {
        "pls" => {
            let mut s = String::from("[playlist]\n");
            for (i, t) in playable.iter().enumerate() {
                let n = i + 1;
                let path = rel_or_abs(t.path.as_ref().unwrap(), out_dir);
                s.push_str(&format!("File{n}={path}\n"));
                s.push_str(&format!("Title{n}={} - {}\n", t.artist, t.title));
                s.push_str(&format!("Length{n}={}\n", secs(t.duration_ms)));
            }
            s.push_str(&format!("NumberOfEntries={}\nVersion=2\n", playable.len()));
            s
        }
        "xspf" => {
            let mut s = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<playlist version=\"1\" xmlns=\"http://xspf.org/ns/0/\">\n");
            s.push_str(&format!("  <title>{}</title>\n  <trackList>\n", xml_escape(&p.name)));
            for t in &playable {
                let abs = t.path.as_ref().unwrap();
                let loc = format!("file://{}", abs.replace(' ', "%20"));
                s.push_str("    <track>\n");
                s.push_str(&format!("      <location>{}</location>\n", xml_escape(&loc)));
                s.push_str(&format!("      <title>{}</title>\n", xml_escape(&t.title)));
                if !t.artist.is_empty() {
                    s.push_str(&format!("      <creator>{}</creator>\n", xml_escape(&t.artist)));
                }
                if !t.album.is_empty() {
                    s.push_str(&format!("      <album>{}</album>\n", xml_escape(&t.album)));
                }
                if t.duration_ms > 0 {
                    s.push_str(&format!("      <duration>{}</duration>\n", t.duration_ms));
                }
                s.push_str("    </track>\n");
            }
            s.push_str("  </trackList>\n</playlist>\n");
            s
        }
        // m3u / m3u8 (Rockbox): same content, UTF-8.
        _ => {
            let mut s = String::from("#EXTM3U\n");
            for t in &playable {
                let path = rel_or_abs(t.path.as_ref().unwrap(), out_dir);
                let label = if t.artist.is_empty() { t.title.clone() } else { format!("{} - {}", t.artist, t.title) };
                s.push_str(&format!("#EXTINF:{},{}\n{}\n", secs(t.duration_ms), label, path));
            }
            s
        }
    };

    std::fs::write(&file, body).map_err(|e| e.to_string())?;
    Ok((file.display().to_string(), playable.len(), skipped))
}

// ---------------- import ----------------

/// Import a playlist file (M3U/M3U8/PLS/XSPF) into a manifest. Paths are resolved
/// (file:// stripped, relative paths joined to the playlist's folder); a track keeps
/// a path only if the file exists locally. Returns the new manifest (unsaved).
pub fn import(file_path: &str, now: i64) -> Result<Playlist, String> {
    let p = Path::new(file_path);
    let raw = std::fs::read_to_string(p).map_err(|e| format!("can't read playlist: {e}"))?;
    let base = p.parent().unwrap_or_else(|| Path::new("."));
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let name = p.file_stem().and_then(|s| s.to_str()).unwrap_or("Imported").to_string();

    let resolve = |entry: &str| -> Option<String> {
        let cleaned = entry.trim().trim_start_matches("file://");
        let decoded = cleaned.replace("%20", " ");
        let abs = if Path::new(&decoded).is_absolute() {
            PathBuf::from(&decoded)
        } else {
            base.join(&decoded)
        };
        if abs.exists() {
            Some(abs.display().to_string())
        } else {
            None
        }
    };

    let mut tracks: Vec<PlaylistTrack> = Vec::new();

    if ext == "xspf" {
        let doc = roxmltree::Document::parse(&raw).map_err(|e| format!("bad XSPF: {e}"))?;
        for tr in doc.descendants().filter(|n| n.has_tag_name("track")) {
            let get = |tag: &str| tr.children().find(|c| c.has_tag_name(tag)).and_then(|c| c.text()).unwrap_or("").to_string();
            let loc = get("location");
            tracks.push(PlaylistTrack {
                title: { let t = get("title"); if t.is_empty() { name_from_path(&loc) } else { t } },
                artist: get("creator"),
                album: get("album"),
                duration_ms: get("duration").parse().unwrap_or(0),
                path: resolve(&loc),
                ..Default::default()
            });
        }
    } else if ext == "pls" {
        use std::collections::BTreeMap;
        let mut files: BTreeMap<usize, String> = BTreeMap::new();
        let mut titles: BTreeMap<usize, String> = BTreeMap::new();
        for line in raw.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("File") {
                if let Some((n, v)) = rest.split_once('=') {
                    if let Ok(i) = n.parse() {
                        files.insert(i, v.to_string());
                    }
                }
            } else if let Some(rest) = line.strip_prefix("Title") {
                if let Some((n, v)) = rest.split_once('=') {
                    if let Ok(i) = n.parse() {
                        titles.insert(i, v.to_string());
                    }
                }
            }
        }
        for (i, f) in files {
            let title = titles.get(&i).cloned().unwrap_or_else(|| name_from_path(&f));
            let (artist, title) = split_artist_title(&title);
            tracks.push(PlaylistTrack { title, artist, path: resolve(&f), ..Default::default() });
        }
    } else {
        // M3U / M3U8
        let mut pending: Option<(String, i64)> = None;
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Some(inf) = line.strip_prefix("#EXTINF:") {
                let (dur, label) = inf.split_once(',').unwrap_or(("-1", inf));
                pending = Some((label.to_string(), dur.trim().parse::<i64>().map(|s| s.max(0) * 1000).unwrap_or(0)));
                continue;
            }
            if line.starts_with('#') {
                continue;
            }
            let (label, dur) = pending.take().unwrap_or_else(|| (name_from_path(line), 0));
            let (artist, title) = split_artist_title(&label);
            tracks.push(PlaylistTrack { title, artist, duration_ms: dur, path: resolve(line), ..Default::default() });
        }
    }

    if tracks.is_empty() {
        return Err("No tracks found in that playlist file.".to_string());
    }
    Ok(Playlist {
        id: id_from(&name, now),
        name,
        description: String::new(),
        created_at: now,
        updated_at: now,
        source: "import".to_string(),
        tracks,
    })
}

fn name_from_path(p: &str) -> String {
    Path::new(p).file_stem().and_then(|s| s.to_str()).unwrap_or(p).to_string()
}

fn split_artist_title(label: &str) -> (String, String) {
    if let Some((a, t)) = label.split_once(" - ") {
        (a.trim().to_string(), t.trim().to_string())
    } else {
        (String::new(), label.trim().to_string())
    }
}
