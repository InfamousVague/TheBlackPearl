//! Export downloaded media into tidy, app-ready libraries.
//! Targets: Plex / a generic media folder (organized into the Plex naming
//! convention so any server — Plex, Jellyfin, Emby, Infuse — ingests it cleanly)
//! and Apple Music (audio; FLAC/OGG/… transcoded to ALAC). Originals are copied,
//! so torrents keep seeding. Optional: trigger a Plex scan + AppleScript add.

use std::path::{Path, PathBuf};

use serde::Serialize;

pub const VIDEO_EXT: &[&str] = &[
    "mp4", "mkv", "m4v", "mov", "avi", "webm", "wmv", "flv", "ts", "m2ts", "mpg", "mpeg",
];
pub const AUDIO_EXT: &[&str] = &[
    "mp3", "flac", "m4a", "aac", "wav", "aiff", "aif", "alac", "ogg", "opus", "wma",
];
pub const BOOK_EXT: &[&str] = &[
    "epub", "pdf", "mobi", "azw3", "fb2", "djvu", "cbz", "cbr",
];
pub const GAME_EXT: &[&str] = &[
    "nsp", "xci", "3ds", "cia", "nds", "gba", "gbc", "gb", "nes", "sfc", "smc",
    "n64", "z64", "vpk", "wad", "xex", "cso", "pbp", "rom", "iso",
    // More console / disc-image formats so loose ROMs of these systems surface too.
    "md", "gen", "sms", "gg", "pce", "ws", "wsc", "ngp", "vb", "lnx", "a26", "a78",
    "j64", "rvz", "wbfs", "gcm", "gcz", "ciso", "chd", "cdi", "gdi", "32x",
];
/// Containers Apple Music imports directly; anything else is transcoded to ALAC.
const APPLE_MUSIC_OK: &[&str] = &["mp3", "m4a", "aac", "wav", "aiff", "aif", "alac"];
pub const SUBTITLE_EXT: &[&str] = &["srt", "ass", "ssa", "vtt", "sub", "idx"];

/// Sidecar subtitles that belong to `video`, as `(source_path, dest_suffix)` pairs —
/// `dest_suffix` is appended to the destination video's stem so they keep its name and
/// the player's stem-match lookup finds them. Covers: same-folder files that share the
/// video's stem (`Movie.mkv` + `Movie.en.srt`), any subtitle in a lone-video folder, and
/// a sibling `Subs/`/`Subtitles/` folder (the common scene-release layout). This is how
/// caption files travel WITH the video when it's organized or exported.
pub(crate) fn related_subtitles(video: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let Some(dir) = video.parent() else { return out };
    let Some(stem) = video.file_stem().and_then(|s| s.to_str()) else { return out };
    let is_sub = |p: &Path| SUBTITLE_EXT.contains(&ext_of(p).as_str());

    // Lone video → adopt subs that don't share the name (e.g. "English.srt").
    let lone = std::fs::read_dir(dir)
        .map(|es| es.flatten().filter(|e| VIDEO_EXT.contains(&ext_of(&e.path()).as_str())).count() <= 1)
        .unwrap_or(false);

    // Same folder.
    if let Ok(es) = std::fs::read_dir(dir) {
        for e in es.flatten() {
            let p = e.path();
            if !p.is_file() || !is_sub(&p) {
                continue;
            }
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if let Some(suffix) = name.strip_prefix(stem) {
                out.push((p.clone(), suffix.to_string()));
            } else if lone {
                out.push((p.clone(), format!(".{name}")));
            }
        }
    }

    // Sibling Subs/ (or Subtitles/) folder.
    if let Ok(es) = std::fs::read_dir(dir) {
        for e in es.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let dn = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
            if !matches!(dn.as_str(), "subs" | "subtitles" | "sub") {
                continue;
            }
            if let Ok(subs) = std::fs::read_dir(&p) {
                for se in subs.flatten() {
                    let sp = se.path();
                    if !sp.is_file() || !is_sub(&sp) {
                        continue;
                    }
                    let sname = sp.file_name().and_then(|s| s.to_str()).unwrap_or("");
                    out.push((sp.clone(), format!(".{sname}")));
                }
            }
        }
    }
    out
}

/// One media file found under the download folder, with parsed naming + a preview
/// of where it would land in an organized library.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Exportable {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub kind: String,       // "video" | "audio" | "book" | "game"
    pub media_type: String, // "movie" | "show" | "music" | "book" | "game"
    pub title: String,
    pub year: Option<i64>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    /// File mtime as epoch seconds (0 if unknown) — drives the "Recently added" feed.
    pub added_at: i64,
    /// Relative library path it would be organized into (Plex convention).
    pub rel_path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub ok: bool,
    pub dest: Option<String>,
    pub converted: bool,
    pub message: String,
}

struct Parsed {
    title: String,
    year: Option<i64>,
    season: Option<i64>,
    episode: Option<i64>,
    is_show: bool,
}

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn kind_of(ext: &str) -> Option<&'static str> {
    kind_of_ext(ext)
}

/// Coarse media kind ("video"/"audio"/"book"/"game") for a lowercase extension. Public so
/// the engine can label a share with what it actually is, instead of the peer guessing from
/// the file name.
pub(crate) fn kind_of_ext(ext: &str) -> Option<&'static str> {
    if VIDEO_EXT.contains(&ext) {
        Some("video")
    } else if AUDIO_EXT.contains(&ext) {
        Some("audio")
    } else if BOOK_EXT.contains(&ext) {
        Some("book")
    } else if GAME_EXT.contains(&ext) {
        Some("game")
    } else {
        None
    }
}

/// Replace path-hostile characters so the organized name is filesystem-safe.
pub fn sanitize(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { ' ' } else { c })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Pull a clean title + year + season/episode out of a release filename stem.
fn parse_name(stem: &str) -> Parsed {
    let s = stem.replace(['.', '_'], " ");
    let se = regex::Regex::new(r"(?i)\bs(\d{1,2})\s*e(\d{1,3})\b").unwrap();
    let season_word = regex::Regex::new(r"(?i)\bseason\s+(\d{1,2})\b").unwrap();
    let year_re = regex::Regex::new(r"\b(19|20)\d{2}\b").unwrap();

    let (mut season, mut episode, mut is_show) = (None, None, false);
    let mut head = s.clone();
    if let Some(c) = se.captures(&s) {
        season = c[1].parse().ok();
        episode = c[2].parse().ok();
        is_show = true;
        head = s[..c.get(0).unwrap().start()].to_string();
    } else if let Some(c) = season_word.captures(&s) {
        season = c[1].parse().ok();
        is_show = true;
        head = s[..c.get(0).unwrap().start()].to_string();
    }

    let year = year_re.find(&head).and_then(|m| m.as_str().parse::<i64>().ok());
    let lower = head.to_lowercase();
    let mut end = head.len();
    for m in [
        "1080p", "720p", "2160p", "480p", "4k", "x264", "x265", "h264", "h265", "hevc", "bluray",
        "blu-ray", "webrip", "web-dl", "web dl", "hdtv", "dvdrip", "brrip", "bdrip", "xvid",
        "aac", "ac3", "dts", "(", "[",
    ] {
        if let Some(p) = lower.find(m) {
            end = end.min(p);
        }
    }
    if let Some(m) = year_re.find(&head) {
        end = end.min(m.start());
    }
    let title = head[..end].trim().trim_matches(|c| c == '-' || c == '–').trim().to_string();
    let title = if title.is_empty() { s.trim().to_string() } else { title };
    Parsed { title, year, season, episode, is_show }
}

fn media_type(kind: &str, p: &Parsed) -> &'static str {
    if kind == "audio" {
        "music"
    } else if kind == "book" {
        "book"
    } else if kind == "game" {
        "game"
    } else if p.is_show {
        "show"
    } else {
        "movie"
    }
}

/// Relative destination path under a library root, Plex naming convention.
fn rel_path(p: &Parsed, kind: &str, ext: &str) -> String {
    let t = sanitize(&p.title);
    let t = if t.is_empty() { "Unknown".to_string() } else { t };
    if kind == "audio" {
        format!("Music/{t}/{t}.{ext}")
    } else if kind == "book" {
        format!("Books/{t}/{t}.{ext}")
    } else if kind == "game" {
        format!("Games/{t}/{t}.{ext}")
    } else if p.is_show {
        let ss = p.season.unwrap_or(1);
        let ee = p.episode.unwrap_or(1);
        format!("TV Shows/{t}/Season {ss:02}/{t} - s{ss:02}e{ee:02}.{ext}")
    } else {
        let name = match p.year {
            Some(y) => format!("{t} ({y})"),
            None => t,
        };
        format!("Movies/{name}/{name}.{ext}")
    }
}

/// Detect a game install/repack folder and, if so, return `(clean title, total size,
/// newest mtime)`. Games rarely arrive as a single recognizable file — they're FitGirl /
/// DODI repacks (split `fg-*.bin` + `setup.exe`), multipart `.rar` rips, or a folder of
/// loose ROMs — so we classify at the FOLDER level: a repack/crack-group tag in the name,
/// a `setup.exe`, a bare ROM inside, or a region-tagged folder of archives with no A/V.
fn is_game_folder(dir: &Path) -> Option<(String, u64, i64)> {
    let name = dir.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if name.is_empty() {
        return None;
    }
    let repack = regex::Regex::new(r"(?i)\b(fitgirl|dodi|repack|steamrip|gog|codex|plaza|skidrow|reloaded|razor1911|empress|tenoke|rune|elamigos|flt)\b")
        .unwrap()
        .is_match(name);
    let region = regex::Regex::new(r"(?i)\((usa|europe|japan|world|eur|jpn|ntsc|pal)\)")
        .unwrap()
        .is_match(name);
    let rar_part = regex::Regex::new(r"^r\d{2}$").unwrap();

    let (mut has_setup, mut has_rom, mut has_archive, mut has_av) = (false, false, false, false);
    let mut total: u64 = 0;
    let mut newest: i64 = 0;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            continue;
        }
        let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        if fname.starts_with('.') {
            continue;
        }
        if let Ok(m) = e.metadata() {
            total += m.len();
            if let Some(secs) = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()) {
                newest = newest.max(secs.as_secs() as i64);
            }
        }
        if fname == "setup.exe" {
            has_setup = true;
        }
        let ext = ext_of(&p);
        if GAME_EXT.contains(&ext.as_str()) {
            has_rom = true;
        } else if VIDEO_EXT.contains(&ext.as_str()) || AUDIO_EXT.contains(&ext.as_str()) {
            has_av = true;
        } else if matches!(ext.as_str(), "rar" | "7z" | "zip" | "bin" | "arc") || rar_part.is_match(&ext) {
            has_archive = true;
        }
    }
    if repack || has_setup || has_rom || (region && has_archive && !has_av) {
        Some((clean_game_title(name), total, newest))
    } else {
        None
    }
}

/// Strip repack/group tags + bracketed noise from a game folder name for display.
fn clean_game_title(name: &str) -> String {
    let bracket = regex::Regex::new(r"[\[\(\{][^\]\)\}]*[\]\)\}]").unwrap();
    let noise = regex::Regex::new(r"(?i)\b(fitgirl|dodi|repack|steamrip|gog|codex|plaza|skidrow|reloaded|razor1911|empress|tenoke|rune|elamigos|flt|rare|multi\d*|update|build|incl|dlcs?)\b").unwrap();
    let mut s = bracket.replace_all(name, " ").to_string();
    s = noise.replace_all(&s, " ").to_string();
    s = s.replace(['.', '_'], " ");
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.trim().is_empty() { name.to_string() } else { s }
}

/// Recursively collect exportable media files under `root` (bounded depth).
pub fn scan(root: &Path) -> Vec<Exportable> {
    let mut out = Vec::new();
    walk(root, 0, &mut out);
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    out
}

// Upper bound on files collected per scan. Generous enough for a real personal media library
// (the persistent library index relies on a complete-enough walk; the reconcile's prune step
// also stats each candidate before deleting, so exceeding this degrades gracefully rather than
// dropping rows). Still bounded so a pathological tree can't blow up memory/time.
const MAX_SCAN_FILES: usize = 20_000;

fn walk(dir: &Path, depth: usize, out: &mut Vec<Exportable>) {
    if depth > 6 || out.len() > MAX_SCAN_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        // Skip macOS dotfiles — especially AppleDouble `._*` resource forks, which carry
        // the real file's extension (e.g. `._track.flac`) but only ~4 KB of xattrs, not
        // audio. They sit next to every real file on exFAT/external drives, and playing
        // one yields silence. Also skips .DS_Store, .Spotlight-V100, .Trashes, etc.
        if path.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with('.')).unwrap_or(false) {
            continue;
        }
        if path.is_dir() {
            // A game install/repack folder is surfaced as ONE game entry — don't recurse
            // into its split archive parts (fg-*.bin, .rar volumes, setup.exe).
            //
            // BUT a *category container* (the organized `Games/` folder) can itself look
            // like a game when loose roms or cover art get dumped beside the real game
            // subfolders (e.g. a stray `Pac-Man World (USA).gba` next to Mario/Tomb Raider
            // folders). If this dir holds child folders that are themselves games, treat it
            // as a container and recurse so every game lists separately instead of
            // collapsing into one bogus entry.
            let holds_game_folders = std::fs::read_dir(&path)
                .map(|es| {
                    es.flatten().any(|c| {
                        let cp = c.path();
                        cp.is_dir() && is_game_folder(&cp).is_some()
                    })
                })
                .unwrap_or(false);
            if !holds_game_folders {
                if let Some((title, size, added_at)) = is_game_folder(&path) {
                    out.push(Exportable {
                        file_name: path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string(),
                        size_bytes: size,
                        kind: "game".to_string(),
                        media_type: "game".to_string(),
                        rel_path: format!("Games/{}", sanitize(&title)),
                        title,
                        year: None,
                        season: None,
                        episode: None,
                        added_at,
                        path: path.display().to_string(),
                    });
                    continue;
                }
            }
            walk(&path, depth + 1, out);
            continue;
        }
        let ext = ext_of(&path);
        let Some(kind) = kind_of(&ext) else { continue };
        let meta = entry.metadata().ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        // Skip tiny sample/junk files.
        if kind == "video" && size < 5 * 1024 * 1024 {
            continue;
        }
        let added_at = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let parsed = parse_name(stem);
        out.push(Exportable {
            file_name: path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string(),
            size_bytes: size,
            kind: kind.to_string(),
            media_type: media_type(kind, &parsed).to_string(),
            rel_path: rel_path(&parsed, kind, &ext),
            title: parsed.title.clone(),
            year: parsed.year,
            season: parsed.season,
            episode: parsed.episode,
            added_at,
            path: path.display().to_string(),
        });
    }
}

fn escape_applescript(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Add a file to the Apple Music library via AppleScript (user grants automation once).
pub fn add_to_apple_music(path: &Path) -> Result<(), String> {
    let script = format!(
        "tell application \"Music\" to add POSIX file \"{}\"",
        escape_applescript(&path.display().to_string())
    );
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Transcode an audio file to ALAC in an .m4a container (lossless, Apple-native).
pub fn transcode_to_alac(ffmpeg: &Path, src: &Path, dst: &Path) -> Result<(), String> {
    transcode_audio(ffmpeg, src, dst, "alac")
}

/// Transcode an audio file to a portable codec ("alac" → .m4a lossless, or "mp3" →
/// universally-playable lossy). Existing tags are carried over via `-map_metadata 0`.
pub fn transcode_audio(ffmpeg: &Path, src: &Path, dst: &Path, codec: &str) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let codec_args: &[&str] = match codec {
        "mp3" => &["-map", "0:a:0", "-c:a", "libmp3lame", "-q:a", "2", "-map_metadata", "0", "-id3v2_version", "3"],
        _ => &["-map", "0:a:0", "-c:a", "alac", "-map_metadata", "0"],
    };
    let out = std::process::Command::new(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(src)
        .args(codec_args)
        .arg(dst)
        .output()
        .map_err(|e| format!("ffmpeg failed: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("ffmpeg error").to_string())
    }
}

/// Copy a source file to `dest`, creating parent dirs. Skips if identical size already there.
pub fn copy_into(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let (Ok(s), Ok(d)) = (src.metadata(), dest.metadata()) {
        if s.len() == d.len() {
            return Ok(()); // already exported
        }
    }
    std::fs::copy(src, dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Export one file into a library root (Plex/generic). Returns the destination path.
pub fn export_to_library(src: &Path, root: &Path) -> ExportResult {
    let ext = ext_of(src);
    let kind = kind_of(&ext).unwrap_or("video");
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let parsed = parse_name(stem);
    let dest = root.join(rel_path(&parsed, kind, &ext));
    match copy_into(src, &dest) {
        Ok(()) => {
            // Bring any sidecar caption files along, renamed next to the exported video so
            // Plex (and our own player) pick them up.
            if kind == "video" {
                if let (Some(to_dir), Some(to_stem)) =
                    (dest.parent(), dest.file_stem().and_then(|s| s.to_str()))
                {
                    for (sub_src, suffix) in related_subtitles(src) {
                        let sub_dest = to_dir.join(format!("{to_stem}{suffix}"));
                        if !sub_dest.exists() {
                            let _ = copy_into(&sub_src, &sub_dest);
                        }
                    }
                }
            }
            ExportResult {
                path: src.display().to_string(),
                ok: true,
                dest: Some(dest.display().to_string()),
                converted: false,
                message: format!("Copied to {}", dest.display()),
            }
        }
        Err(e) => ExportResult {
            path: src.display().to_string(),
            ok: false,
            dest: None,
            converted: false,
            message: e,
        },
    }
}

/// Export one audio file into Apple Music (transcoding to ALAC if needed).
pub fn export_to_apple_music(src: &Path, ffmpeg: Option<&Path>, staging: &Path) -> ExportResult {
    let ext = ext_of(src);
    if !AUDIO_EXT.contains(&ext.as_str()) {
        return ExportResult {
            path: src.display().to_string(),
            ok: false,
            dest: None,
            converted: false,
            message: "Apple Music export is audio-only.".to_string(),
        };
    }
    let mut to_add = src.to_path_buf();
    let mut converted = false;
    if !APPLE_MUSIC_OK.contains(&ext.as_str()) {
        let Some(ff) = ffmpeg else {
            return ExportResult {
                path: src.display().to_string(),
                ok: false,
                dest: None,
                converted: false,
                message: format!("{} needs converting to ALAC, but ffmpeg isn't installed.", ext.to_uppercase()),
            };
        };
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
        let dst = staging.join(format!("{stem}.m4a"));
        if let Err(e) = transcode_to_alac(ff, src, &dst) {
            return ExportResult {
                path: src.display().to_string(),
                ok: false,
                dest: None,
                converted: false,
                message: format!("Convert failed: {e}"),
            };
        }
        to_add = dst;
        converted = true;
    }
    match add_to_apple_music(&to_add) {
        Ok(()) => ExportResult {
            path: src.display().to_string(),
            ok: true,
            dest: Some(to_add.display().to_string()),
            converted,
            message: if converted {
                "Converted to ALAC and added to Apple Music.".to_string()
            } else {
                "Added to Apple Music.".to_string()
            },
        },
        Err(e) => ExportResult {
            path: src.display().to_string(),
            ok: false,
            dest: Some(to_add.display().to_string()),
            converted,
            message: format!("Couldn't add to Music: {e} (grant automation access to Music in System Settings ▸ Privacy)"),
        },
    }
}

/// Ask a Plex Media Server to rescan all libraries (picks up newly-copied files).
pub async fn plex_scan(client: &reqwest::Client, server: &str, token: &str) -> Result<(), String> {
    let base = server.trim_end_matches('/');
    let url = format!("{base}/library/sections/all/refresh");
    client
        .get(&url)
        .header("X-Plex-Token", token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Plex unreachable: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Plex scan rejected: {e}"))?;
    Ok(())
}

/// The staging dir for transcodes, under the app data dir.
pub fn staging_dir(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join("export-staging")
}

