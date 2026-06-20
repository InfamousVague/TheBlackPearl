//! Local-LLM (Ollama) title understanding. Turns a messy release name like
//! `The.Matrix.1999.1080p.BluRay.x265-GROUP` into structured metadata used for
//! artwork lookup, organizing and tagging. Fully optional — when Ollama isn't
//! running the caller falls back to a regex clean-up, so the library still works.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

const OLLAMA: &str = "http://127.0.0.1:11434";

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub available: bool,
    /// The model the scan will use (best installed match), if any.
    pub model: Option<String>,
    /// Every installed Ollama model, for display.
    pub models: Vec<String>,
}

#[derive(Deserialize)]
struct TagsResp {
    #[serde(default)]
    models: Vec<TagModel>,
}
#[derive(Deserialize)]
struct TagModel {
    name: String,
}

/// Probe the local Ollama daemon and report what's installed.
pub async fn status(client: &reqwest::Client) -> AiStatus {
    let Ok(resp) = client.get(format!("{OLLAMA}/api/tags")).send().await else {
        return AiStatus::default();
    };
    let Ok(tags) = resp.json::<TagsResp>().await else {
        return AiStatus::default();
    };
    let models: Vec<String> = tags.models.into_iter().map(|m| m.name).collect();
    AiStatus {
        available: !models.is_empty(),
        model: pick_model(&models),
        models,
    }
}

/// Prefer a small, fast instruct model; fall back to whatever is installed first.
fn pick_model(models: &[String]) -> Option<String> {
    for p in ["qwen2.5", "llama3", "llama-3", "mistral", "gemma", "phi"] {
        if let Some(m) = models.iter().find(|m| m.to_lowercase().contains(p)) {
            return Some(m.clone());
        }
    }
    models.first().cloned()
}

#[derive(Deserialize)]
struct GenResp {
    response: String,
}

/// The model's verdict on a candidate group of same-artist/same-title tracks.
#[derive(Deserialize, Default, Clone, Debug)]
pub struct DedupeVerdict {
    /// True only when these are the SAME recording saved more than once.
    #[serde(default)]
    pub duplicate: bool,
    /// Index of the copy to keep (the others are duplicates to remove).
    #[serde(default)]
    pub keep: i64,
    #[serde(default)]
    pub reason: String,
}

const DEDUPE_PROMPT: &str = "You are de-duplicating a music library. Below are music files that share an artist and a very similar title. They might be the SAME recording saved more than once, or genuinely DIFFERENT versions that should both be kept — a live take, a remaster, an acoustic or radio edit, a re-recording, or a different mix/album. Judge carefully: only call them duplicates if they are the same recording. If they are duplicates, choose the index to keep (prefer the highest quality — the largest file).\nFiles (0-indexed):\n";

/// Ask the local model whether a candidate group is a true duplicate set, and which
/// copy to keep. Errs (so the caller skips the group) when Ollama is down or replies
/// with non-JSON. Same call shape as `parse_music`.
pub async fn dedupe_judge(client: &reqwest::Client, model: &str, context: &str) -> Result<DedupeVerdict> {
    let body = serde_json::json!({
        "model": model,
        "prompt": format!("{DEDUPE_PROMPT}{context}\nRespond with ONLY a JSON object using exactly these keys: {{\"duplicate\": true or false, \"keep\": <index to keep>, \"reason\": \"<short reason>\"}}\nJSON:"),
        "format": "json",
        "stream": false,
        "options": { "temperature": 0.0 }
    });
    let resp: GenResp = client
        .post(format!("{OLLAMA}/api/generate"))
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let text = resp.response.trim();
    serde_json::from_str(text).map_err(|e| anyhow!("LLM returned non-JSON ({e}): {text}"))
}

/// Structured parse of a single release name.
#[derive(Deserialize, Default, Clone, Debug)]
pub struct Parsed {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub year: Option<i64>,
    /// movie | show | music | book | game | other
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub season: Option<i64>,
    #[serde(default)]
    pub episode: Option<i64>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub codec: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub genres: Vec<String>,
}

const PROMPT: &str = r#"You extract structured metadata from a torrent release name.
Respond with ONLY a JSON object, no prose, using exactly these keys:
"title": clean human title, no year/quality/codec/release-group/dots
"year": release year as an integer, or null
"kind": one of "movie","show","music","book","game","other"  (a PC/console game or ROM is "game")
"season": season number, or null
"episode": episode number, or null
"quality": resolution/source e.g. "1080p BluRay", or null
"codec": video codec e.g. "x265", or null
"language": primary language, or null
"genres": array of up to 3 likely genres (may be empty)
Release name: "#;

/// Clean music tags the LLM derives from a file's folder + name + existing tags.
#[derive(Deserialize, Default, Clone, Debug)]
pub struct MusicTags {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub track: Option<i64>,
    #[serde(default)]
    pub year: Option<i64>,
    #[serde(default)]
    pub genre: Option<String>,
}

const MUSIC_PROMPT: &str = r#"You produce clean, library-ready metadata for ONE audio file.
Use the folder name, file name and any existing tags below. Fix capitalization and strip
junk (track-number prefixes from the title, bitrate, "[24-48]", scene/release tags).
Respond with ONLY a JSON object using exactly these keys:
"title": clean song title, with NO leading track number
"artist": performing artist, or null
"album": album name, or null
"track": track number as an integer, or null
"year": release year as an integer, or null
"genre": one main genre, or null

"#;

/// Ask the LLM for clean music tags. Errors if Ollama is unreachable or the reply
/// isn't the JSON shape above (callers fall back to a filename parse).
pub async fn parse_music(client: &reqwest::Client, model: &str, context: &str) -> Result<MusicTags> {
    let body = serde_json::json!({
        "model": model,
        "prompt": format!("{MUSIC_PROMPT}{context}\nJSON:"),
        "format": "json",
        "stream": false,
        "options": { "temperature": 0.0 }
    });
    let resp: GenResp = client
        .post(format!("{OLLAMA}/api/generate"))
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let text = resp.response.trim();
    serde_json::from_str(text).map_err(|e| anyhow!("LLM returned non-JSON ({e}): {text}"))
}

/// Ask the LLM to parse one title. Errors if Ollama is unreachable or replies
/// with something that isn't the JSON shape above.
pub async fn parse_title(client: &reqwest::Client, model: &str, raw: &str) -> Result<Parsed> {
    let body = serde_json::json!({
        "model": model,
        "prompt": format!("{PROMPT}{raw}\nJSON:"),
        "format": "json",
        "stream": false,
        "options": { "temperature": 0.0 }
    });
    let resp: GenResp = client
        .post(format!("{OLLAMA}/api/generate"))
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let text = resp.response.trim();
    serde_json::from_str(text).map_err(|e| anyhow!("LLM returned non-JSON ({e}): {text}"))
}
