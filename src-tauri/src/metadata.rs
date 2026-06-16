//! Clean, device-ready audio tagging. The local LLM (Ollama) reads each file's messy
//! name + folder + any existing tags and proposes clean Title / Artist / Album / Track /
//! Year / Genre, which we write straight into the file with `lofty` — pure Rust, no
//! subprocess, so the embedded tags ride along to any device or player (Plex, Music.app,
//! a phone). Optionally renames the file to a legible `NN - Title.ext` in the same folder.
//! `plan` previews (no disk changes); `apply` writes. Never deletes content.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::ai;
use crate::export;

/// One proposed (plan) or completed (apply) tag change for a single audio file.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TagChange {
    pub path: String,
    pub file_name: String,
    /// Proposed legible filename in the same folder — None when it's already clean.
    pub new_name: Option<String>,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track: Option<i64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    /// Whether the local model (vs. the filename fallback) produced this row.
    pub ai_used: bool,
    /// "plan" | "tagged" | "error"
    pub status: String,
    pub message: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TagResult {
    pub root: String,
    pub ai_used: bool,
    pub model: Option<String>,
    pub planned: usize,
    pub tagged: usize,
    pub errors: usize,
    pub changes: Vec<TagChange>,
}

/// A previewed change the user accepted, sent back to `apply`.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TagApply {
    pub path: String,
    pub new_name: Option<String>,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track: Option<i64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
}

/// Resolve clean music tags for a file: existing embedded tags + the LLM (given that
/// context), falling back to a filename/folder parse and backfilling blanks. Returns the
/// tags plus whether the model (vs. the deterministic fallback) produced them. Shared by
/// the tag pass and the organizer.
pub async fn music_tags_for(
    path: &Path,
    client: &reqwest::Client,
    model: Option<&str>,
) -> (ai::MusicTags, bool) {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let parent = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let existing = read_existing(path);

    let mut ai_used = false;
    let mut tags = match model {
        Some(m) => match ai::parse_music(client, m, &context_for(parent, file_name, &existing)).await {
            Ok(t) if !t.title.trim().is_empty() => {
                ai_used = true;
                t
            }
            _ => fallback(stem, parent),
        },
        None => fallback(stem, parent),
    };

    // Backfill blanks: deterministic parse first, then the file's own embedded tags.
    let fb = fallback(stem, parent);
    if tags.title.trim().is_empty() {
        tags.title = fb.title;
    }
    tags.artist = clean_opt(tags.artist).or(fb.artist).or_else(|| existing.1.clone());
    tags.album = clean_opt(tags.album).or(fb.album).or_else(|| existing.2.clone());
    tags.track = tags.track.or(fb.track);
    tags.year = tags.year.or(fb.year);
    tags.genre = clean_opt(tags.genre);
    (tags, ai_used)
}

/// Preview clean tags + legible names for every audio file under `root`. Read-only.
/// `on_progress(done, total)` fires per file so the UI can show live progress.
pub async fn plan(
    root: &Path,
    client: &reqwest::Client,
    model: Option<&str>,
    on_progress: impl Fn(usize, usize),
) -> TagResult {
    let audio: Vec<export::Exportable> =
        export::scan(root).into_iter().filter(|e| e.kind == "audio").collect();
    let total = audio.len();
    let mut result = TagResult {
        root: root.display().to_string(),
        ai_used: model.is_some(),
        model: model.map(|m| m.to_string()),
        ..Default::default()
    };

    for (idx, f) in audio.iter().enumerate() {
        on_progress(idx + 1, total);
        let path = PathBuf::from(&f.path);
        let ext = ext_of(&path);
        let (tags, ai_used) = music_tags_for(&path, client, model).await;

        let title = tags.title.trim().to_string();
        let legible = legible_name(tags.track, &title, &ext);
        let new_name = (legible != f.file_name).then_some(legible);

        result.planned += 1;
        result.changes.push(TagChange {
            path: f.path.clone(),
            file_name: f.file_name.clone(),
            new_name,
            title,
            artist: tags.artist,
            album: tags.album,
            track: tags.track,
            year: tags.year,
            genre: tags.genre,
            ai_used,
            status: "plan".into(),
            message: None,
        });
    }
    result
}

/// Write the accepted tags into each file and optionally rename it. Blocking fs/tag
/// work — run from `spawn_blocking`. Never overwrites an existing file on rename.
pub fn apply(root: &Path, items: &[TagApply], on_progress: impl Fn(usize, usize)) -> TagResult {
    let mut result = TagResult { root: root.display().to_string(), ..Default::default() };
    let total = items.len();
    // Canonical root so symlinked/relative paths can't escape it (matches trash_downloaded).
    let canon_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());

    for (idx, it) in items.iter().enumerate() {
        on_progress(idx + 1, total);

        // Resolve the source to a real path and require it inside the library root —
        // canonicalize() follows symlinks, so a symlink pointing outside is rejected.
        let mut path = match std::fs::canonicalize(&it.path) {
            Ok(real) if real.starts_with(&canon_root) => real,
            _ => {
                result.errors += 1;
                result.changes.push(err_change(it, "outside library root"));
                continue;
            }
        };

        if let Err(e) = write_tags(&path, it) {
            result.errors += 1;
            result.changes.push(err_change(it, &e));
            continue;
        }

        // Legible rename within the SAME folder. `new_name` must be a bare filename
        // (no separators or `..`) that lands back inside the root; never overwrite.
        let mut renamed_to = None;
        if let Some(name) = &it.new_name {
            let bare = !name.is_empty()
                && !name.contains('/')
                && !name.contains('\\')
                && !name.contains("..");
            if bare {
                if let Some(parent) = path.parent() {
                    let dst = parent.join(name);
                    if dst != path
                        && dst.starts_with(&canon_root)
                        && !dst.exists()
                        && std::fs::rename(&path, &dst).is_ok()
                    {
                        renamed_to = Some(name.clone());
                        path = dst;
                    }
                }
            }
        }

        result.tagged += 1;
        result.changes.push(TagChange {
            file_name: path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string(),
            path: path.display().to_string(),
            new_name: renamed_to,
            title: it.title.clone(),
            artist: it.artist.clone(),
            album: it.album.clone(),
            track: it.track,
            year: it.year,
            genre: it.genre.clone(),
            ai_used: false,
            status: "tagged".into(),
            message: None,
        });
    }
    result
}

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn clean_opt(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// A filesystem-safe, legible name: `NN - Title.ext`, or `Title.ext` without a track.
fn legible_name(track: Option<i64>, title: &str, ext: &str) -> String {
    let t = export::sanitize(title);
    let t = if t.is_empty() { "Untitled".to_string() } else { t };
    match track {
        Some(n) if n > 0 => format!("{n:02} - {t}.{ext}"),
        _ => format!("{t}.{ext}"),
    }
}

/// Embedded audio tags for the Music view's grouping. Once files are flattened into the
/// library (e.g. `Library/Music/Track.flac`), the path carries no artist/album — the tags
/// are the only surviving source, so the Music view groups by these.
/// Returns artist, album, track number, title, and optional embedded artwork bytes.
pub fn read_audio_tags(
    path: &Path,
) -> (Option<String>, Option<String>, Option<String>, Option<i64>, Option<String>, Option<Vec<u8>>) {
    use lofty::file::TaggedFileExt;
    use lofty::picture::PictureType;
    use lofty::prelude::Accessor;
    let clean = |s: String| {
        let t = s.trim().to_string();
        (!t.is_empty()).then_some(t)
    };
    if let Ok(tf) = lofty::read_from_path(path) {
        if let Some(tag) = tf.primary_tag().or_else(|| tf.first_tag()) {
            let art = tag
                .pictures()
                .iter()
                .find(|p| matches!(p.pic_type(), PictureType::CoverFront))
                .or_else(|| tag.pictures().first())
                .map(|p| p.data().to_vec());
            return (
                tag.artist().and_then(|c| clean(c.to_string())),
                tag.album().and_then(|c| clean(c.to_string())),
                tag.genre().and_then(|c| clean(c.to_string())),
                tag.track().map(|n| n as i64),
                tag.title().and_then(|c| clean(c.to_string())),
                art,
            );
        }
    }
    (None, None, None, None, None, None)
}

/// Read the file's current title/artist/album so the model has context to clean up.
fn read_existing(path: &Path) -> (Option<String>, Option<String>, Option<String>) {
    use lofty::file::TaggedFileExt;
    use lofty::prelude::Accessor;
    if let Ok(tf) = lofty::read_from_path(path) {
        if let Some(tag) = tf.primary_tag().or_else(|| tf.first_tag()) {
            return (
                tag.title().map(|c| c.to_string()),
                tag.artist().map(|c| c.to_string()),
                tag.album().map(|c| c.to_string()),
            );
        }
    }
    (None, None, None)
}

fn context_for(
    parent: &str,
    file_name: &str,
    existing: &(Option<String>, Option<String>, Option<String>),
) -> String {
    let (t, a, al) = existing;
    format!(
        "Folder: {parent}\nFile: {file_name}\nExisting tags — title: {}, artist: {}, album: {}",
        t.as_deref().unwrap_or("(none)"),
        a.as_deref().unwrap_or("(none)"),
        al.as_deref().unwrap_or("(none)"),
    )
}

/// Write the accepted tags into the file in place (creating a tag if none exists).
fn write_tags(path: &Path, it: &TagApply) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::file::TaggedFileExt;
    use lofty::prelude::{Accessor, TagExt};
    use lofty::tag::Tag;

    let mut tf = lofty::read_from_path(path).map_err(|e| format!("read tags: {e}"))?;
    if tf.primary_tag().is_none() {
        let tt = tf.primary_tag_type();
        tf.insert_tag(Tag::new(tt));
    }
    let tag = tf.primary_tag_mut().ok_or("no writable tag")?;

    let title = it.title.trim();
    tag.set_title(if title.is_empty() { "Untitled".to_string() } else { title.to_string() });
    if let Some(a) = clean_opt(it.artist.clone()) {
        tag.set_artist(a);
    }
    if let Some(al) = clean_opt(it.album.clone()) {
        tag.set_album(al);
    }
    if let Some(g) = clean_opt(it.genre.clone()) {
        tag.set_genre(g);
    }
    if let Some(n) = it.track {
        if n > 0 {
            tag.set_track(n as u32);
        }
    }
    if let Some(y) = it.year {
        if y > 0 {
            tag.set_year(y as u32);
        }
    }
    tag.save_to_path(path, WriteOptions::default()).map_err(|e| format!("write tags: {e}"))
}

/// Deterministic parse from the file stem + folder when the model can't help.
fn fallback(stem: &str, parent: &str) -> ai::MusicTags {
    let s = stem.trim();
    // "06 - Beautiful Boy" / "06. Beautiful Boy" / "06 Beautiful Boy"
    let re = regex::Regex::new(r"^\s*(\d{1,3})\s*[-._)\s]+\s*(.+)$").unwrap();
    let (track, title) = match re.captures(s) {
        Some(c) => (c[1].parse::<i64>().ok(), c[2].trim().to_string()),
        None => (None, s.to_string()),
    };
    let (artist, album, year) = parse_folder(parent);
    ai::MusicTags { title, artist, album, track, year, genre: None }
}

/// Pull Artist / Album / Year out of a folder like "Artist - Album (Year) [24-48]".
fn parse_folder(parent: &str) -> (Option<String>, Option<String>, Option<i64>) {
    let year = regex::Regex::new(r"\b(?:19|20)\d{2}\b")
        .unwrap()
        .find(parent)
        .and_then(|m| m.as_str().parse::<i64>().ok());
    // Drop any trailing "(...)" / "[...]" qualifier before splitting Artist - Album.
    let cleaned = regex::Regex::new(r"[\[(].*$").unwrap().replace(parent, "").trim().to_string();
    if let Some((a, al)) = cleaned.split_once(" - ") {
        let a = a.trim();
        let al = al.trim();
        ((!a.is_empty()).then(|| a.to_string()), (!al.is_empty()).then(|| al.to_string()), year)
    } else {
        (None, (!cleaned.is_empty()).then_some(cleaned), year)
    }
}

fn err_change(it: &TagApply, msg: &str) -> TagChange {
    TagChange {
        file_name: PathBuf::from(&it.path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string(),
        path: it.path.clone(),
        new_name: it.new_name.clone(),
        title: it.title.clone(),
        artist: it.artist.clone(),
        album: it.album.clone(),
        track: it.track,
        year: it.year,
        genre: it.genre.clone(),
        ai_used: false,
        status: "error".into(),
        message: Some(msg.to_string()),
    }
}
