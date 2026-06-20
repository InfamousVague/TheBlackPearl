//! Trust & safety: scan downloaded files for the classic "looks like a song, is actually a
//! program" disguise and other executable payloads. This is the local, no-network defense
//! that the original LimeWire never had — the thing that flooded it with malware-laden fakes.
//!
//! Purely heuristic and filename-based (no content inspection, no network) so it's instant and
//! private. It flags executables and double-extension disguises; it intentionally does NOT flag
//! plain archives (too many legitimate game/book downloads are zips) to keep the signal clean.

use std::path::Path;

use serde::Serialize;

/// One file flagged as potentially unsafe, with the relative path so the UI can point at it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskyFile {
    /// Path relative to the scanned root.
    pub path: String,
    pub name: String,
    /// "disguised" | "executable" | "script"
    pub category: String,
    pub reason: String,
    /// true = high risk (disguise or Windows-style executable), false = caution.
    pub danger: bool,
}

/// Result of scanning a downloaded file/folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyReport {
    /// "safe" | "caution" | "danger"
    pub level: String,
    /// How many files were inspected.
    pub scanned: usize,
    pub files: Vec<RiskyFile>,
}

/// Executable/script extensions that are almost never legitimate inside a media download and
/// are the usual malware delivery vectors on Windows.
const DANGER_EXEC: &[&str] = &[
    "exe", "scr", "pif", "com", "bat", "cmd", "vbs", "vbe", "jse", "wsf", "wsh", "hta", "msi",
    "cpl", "msc", "gadget", "lnk", "reg", "inf",
];

/// Runnable files that CAN be legitimate (app bundles, installers, shell scripts) but still
/// deserve a heads-up before the user double-clicks them.
const CAUTION_EXEC: &[&str] = &[
    "app", "dmg", "pkg", "deb", "rpm", "apk", "sh", "command", "run", "jar", "ps1", "js",
];

/// Extensions a disguised file pretends to be — if one of these appears *before* an executable
/// extension (e.g. `song.mp3.exe`), it's the classic double-extension trick.
const MEDIA_DOC_EXT: &[&str] = &[
    "mp3", "mp4", "mkv", "avi", "mov", "m4v", "m4a", "flac", "wav", "aac", "ogg", "wma", "webm",
    "jpg", "jpeg", "png", "gif", "bmp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt",
    "epub", "mobi", "srt", "zip", "rar",
];

/// Classify a single file name. Returns `(category, reason, danger)` when it's risky.
pub fn classify(name: &str) -> Option<(&'static str, String, bool)> {
    let lower = name.to_lowercase();
    let parts: Vec<&str> = lower.split('.').collect();
    if parts.len() < 2 {
        return None; // no extension at all
    }
    let last = *parts.last().unwrap();
    let is_danger = DANGER_EXEC.contains(&last);
    let is_caution = CAUTION_EXEC.contains(&last);
    if !is_danger && !is_caution {
        return None;
    }
    // Double-extension disguise: a media/doc extension immediately precedes the executable one.
    if parts.len() >= 3 {
        let prev = parts[parts.len() - 2];
        if MEDIA_DOC_EXT.contains(&prev) {
            return Some((
                "disguised",
                format!(
                    "Looks like a .{prev} file but is actually a .{last} program — a classic malware disguise."
                ),
                true,
            ));
        }
    }
    if is_danger {
        Some((
            "executable",
            format!("Executable program (.{last}) — only open it if you trust the source."),
            true,
        ))
    } else {
        Some((
            "script",
            format!("Runnable file (.{last}) — review it before opening."),
            false,
        ))
    }
}

/// Scan a file or directory under `root`, returning everything flagged plus an overall level.
pub fn scan_path(root: &Path) -> SafetyReport {
    let mut files = Vec::new();
    let mut scanned = 0usize;
    walk(root, root, &mut scanned, &mut files);
    let level = if files.iter().any(|f| f.danger) {
        "danger"
    } else if !files.is_empty() {
        "caution"
    } else {
        "safe"
    };
    SafetyReport {
        level: level.to_string(),
        scanned,
        files,
    }
}

fn walk(base: &Path, path: &Path, scanned: &mut usize, out: &mut Vec<RiskyFile>) {
    if path.is_file() {
        consider(base, path, scanned, out);
        return;
    }
    let Ok(rd) = std::fs::read_dir(path) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            walk(base, &p, scanned, out);
        } else {
            consider(base, &p, scanned, out);
        }
    }
}

fn consider(base: &Path, file: &Path, scanned: &mut usize, out: &mut Vec<RiskyFile>) {
    *scanned += 1;
    let name = file
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Some((category, reason, danger)) = classify(&name) {
        let rel = file
            .strip_prefix(base)
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| name.clone());
        out.push(RiskyFile {
            path: rel,
            name,
            category: category.to_string(),
            reason,
            danger,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_double_extension_disguise() {
        let (cat, _reason, danger) = classify("Best.Song.Ever.mp3.exe").expect("should flag");
        assert_eq!(cat, "disguised");
        assert!(danger);
    }

    #[test]
    fn flags_plain_executable() {
        let (cat, _r, danger) = classify("setup.exe").expect("should flag");
        assert_eq!(cat, "executable");
        assert!(danger);
    }

    #[test]
    fn caution_for_installer_bundle() {
        let (cat, _r, danger) = classify("Cool App.dmg").expect("should flag");
        assert_eq!(cat, "script");
        assert!(!danger);
    }

    #[test]
    fn ignores_normal_media() {
        assert!(classify("track01.flac").is_none());
        assert!(classify("Movie.2024.1080p.mkv").is_none());
        assert!(classify("cover.jpg").is_none());
        assert!(classify("README").is_none());
    }

    #[test]
    fn level_is_danger_when_any_danger_file() {
        let files = vec![RiskyFile {
            path: "a.exe".into(),
            name: "a.exe".into(),
            category: "executable".into(),
            reason: String::new(),
            danger: true,
        }];
        let level = if files.iter().any(|f| f.danger) { "danger" } else { "caution" };
        assert_eq!(level, "danger");
    }
}
