//! Free, keyless subtitle fetching from OpenSubtitles' legacy REST endpoint
//! (rest.opensubtitles.org) — no API key, no login. Used when a video has no sidecar or
//! embedded captions: we search by title (+ season/episode for shows), download the
//! most-downloaded matching .srt (served gzipped) and hand back plain SRT text for the
//! caller to drop next to the video.

use std::io::Read;

use anyhow::{anyhow, Result};
use serde::Deserialize;

// OpenSubtitles asks API consumers to send a User-Agent; a stable app identifier is fine.
const UA: &str = "GhostWire v0.1";

#[derive(Deserialize)]
struct OsResult {
    #[serde(rename = "SubDownloadLink")]
    download_link: Option<String>,
    #[serde(rename = "SubLanguageID")]
    lang: Option<String>,
    #[serde(rename = "SubFormat")]
    format: Option<String>,
    #[serde(rename = "SubDownloadsCnt")]
    downloads: Option<String>,
}

pub struct FoundSub {
    /// Decoded SRT text, ready to write to disk.
    pub srt: String,
    /// 3-letter language id (e.g. "eng").
    pub lang: String,
}

/// Normalize a 2-letter language code to the 3-letter ISO 639-2 id OpenSubtitles wants
/// (sublanguageid). Passes 3-letter (and unknown) codes through unchanged.
fn to_iso3(l: &str) -> String {
    match l.to_lowercase().as_str() {
        "en" => "eng",
        "es" => "spa",
        "fr" => "fre",
        "de" => "ger",
        "it" => "ita",
        "pt" => "por",
        "ja" => "jpn",
        "ko" => "kor",
        "zh" => "chi",
        "ru" => "rus",
        "ar" => "ara",
        "nl" => "dut",
        "sv" => "swe",
        "pl" => "pol",
        other => other,
    }
    .to_string()
}

/// Percent-encode a query for the legacy REST path segment (`query-{q}`).
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Find the best matching subtitle for a title (+ optional season/episode) in `lang`
/// (3-letter id, e.g. "eng"). Returns None when nothing matches.
pub async fn fetch_best(
    client: &reqwest::Client,
    title: &str,
    season: Option<i64>,
    episode: Option<i64>,
    lang: &str,
) -> Result<Option<FoundSub>> {
    let lang = to_iso3(lang);
    let mut url = format!("https://rest.opensubtitles.org/search/query-{}", enc(title.trim()));
    if let Some(s) = season {
        url.push_str(&format!("/season-{s}"));
    }
    if let Some(e) = episode {
        url.push_str(&format!("/episode-{e}"));
    }
    url.push_str(&format!("/sublanguageid-{lang}"));

    let resp = client.get(&url).header("User-Agent", UA).send().await?.error_for_status()?;
    let mut results: Vec<OsResult> = resp.json().await.unwrap_or_default();

    // Keep downloadable SRTs, then prefer the most-downloaded (widely-used → most likely
    // a correct, well-synced track).
    results.retain(|r| {
        r.download_link.is_some() && r.format.as_deref().map_or(true, |f| f.eq_ignore_ascii_case("srt"))
    });
    results.sort_by_key(|r| std::cmp::Reverse(r.downloads.as_deref().and_then(|d| d.parse::<u64>().ok()).unwrap_or(0)));

    let Some(best) = results.into_iter().next() else { return Ok(None) };
    let link = best.download_link.ok_or_else(|| anyhow!("no download link"))?;
    let bytes = client.get(&link).header("User-Agent", UA).send().await?.error_for_status()?.bytes().await?;
    Ok(Some(FoundSub {
        srt: gunzip_to_string(&bytes)?,
        lang: best.lang.filter(|l| !l.is_empty()).unwrap_or_else(|| lang.to_string()),
    }))
}

/// Decode the download body. OpenSubtitles serves a gzip file; if we ever get a raw .srt
/// (or the bytes aren't gzip), fall back to treating it as plain text.
fn gunzip_to_string(bytes: &[u8]) -> Result<String> {
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        let mut buf = Vec::new();
        flate2::read::GzDecoder::new(bytes).read_to_end(&mut buf)?;
        Ok(String::from_utf8_lossy(&buf).into_owned())
    } else {
        Ok(String::from_utf8_lossy(bytes).into_owned())
    }
}
