pub mod ai;
mod artwork;
pub mod catalog;
pub mod discover;
mod engine;
pub mod enrich;
mod export;
pub mod indexer;
mod metadata;
pub mod music;
mod organize;
pub mod posters;
mod remux;
mod spotify;
pub mod tvmaze;

use std::collections::{HashMap, HashSet};
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
use catalog::{Catalog, CatalogItem, Source};
use engine::{DownloadStats, Engine, MediaInfo};
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
struct AppInfo {
    download_dir: String,
    data_dir: String,
    ffmpeg_available: bool,
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

#[tauri::command]
async fn add_torrent(engine: tauri::State<'_, Engine>, magnet: String) -> Result<String, String> {
    engine.add(&magnet).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn stream_url(
    engine: tauri::State<'_, Engine>,
    id: String,
    file_idx: Option<usize>,
) -> Result<String, String> {
    engine.stream_url(&id, file_idx).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn torrent_stats(engine: tauri::State<'_, Engine>, id: String) -> Result<DownloadStats, String> {
    engine.stats_for(&id).await.ok_or_else(|| "unknown torrent".to_string())
}

#[tauri::command]
async fn list_downloads(engine: tauri::State<'_, Engine>) -> Result<Vec<DownloadStats>, String> {
    Ok(engine.snapshot().await)
}

#[tauri::command]
async fn media_info(engine: tauri::State<'_, Engine>, id: String) -> Result<MediaInfo, String> {
    engine.media_info(&id).await.map_err(|e| format!("{e:#}"))
}

/// Subtitle tracks (sidecar files + embedded streams) for a local video, by its relative
/// path under the download folder. Served as WebVTT for the player's <track> elements.
#[tauri::command]
async fn list_subtitles(
    engine: tauri::State<'_, Engine>,
    rel: String,
) -> Result<Vec<engine::SubTrack>, String> {
    Ok(engine.list_subtitles(&rel).await)
}

#[tauri::command]
async fn remove_torrent(
    engine: tauri::State<'_, Engine>,
    id: String,
    delete_files: Option<bool>,
) -> Result<(), String> {
    engine.remove(&id, delete_files.unwrap_or(false)).await.map_err(|e| format!("{e:#}"))
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
    "Verify the redirect URI in TIDAL developer settings exactly matches Ghosty (scheme, host, port, path).";

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
    PathBuf::from(&info.download_dir).join("Music")
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
                "<html><body><h2>TIDAL login failed</h2><p>Ghosty received an invalid callback request.</p></body></html>"
                    .to_string(),
                Err("TIDAL callback request was malformed.".to_string()),
            )
        } else {
            let callback_url = tauri::Url::parse(&format!("http://localhost{target}"))
                .map_err(|e| format!("Failed to parse callback URL: {e}"));

            match callback_url {
                Err(err) => (
                    "400 Bad Request".to_string(),
                    "<html><body><h2>TIDAL login failed</h2><p>Ghosty could not parse the callback URL.</p></body></html>"
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
                            Err("TIDAL callback path mismatch. Ensure your app redirect URI exactly matches Ghosty's redirect URI."
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
                            "<html><body><h2>TIDAL login failed</h2><p>State mismatch detected. Return to Ghosty and retry.</p></body></html>"
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
                            "<html><body><h2>TIDAL login complete</h2><p>You can close this browser tab and return to Ghosty.</p></body></html>"
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
                "Install SpotiFLAC so Ghosty can launch `spotiflac` (for example: `pipx install SpotiFLAC` or `python3 -m pip install --user SpotiFLAC`)."
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
        "SpotiFLAC CLI not found. Install it first, then relaunch Ghosty if you opened the app from Finder.".to_string()
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
        return Err(format!("SpotiFLAC failed. {detail}"));
    }
    if completed_files == 0 {
        let mut detail = if !stderr.is_empty() {
            stderr.clone()
        } else if !stdout.is_empty() {
            stdout.clone()
        } else {
            "SpotiFLAC exited successfully, but Ghosty did not see any completed music files written to disk.".to_string()
        };
        if tidal_error_is_missing_bearer(&detail) {
            detail = format!("{}\n{}", detail, tidal_missing_bearer_hint(tidal_api_mode));
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
        return Err("Couldn't find `pipx` or `python3`, so Ghosty can't install SpotiFLAC automatically on this machine.".to_string());
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
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
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

fn norm_title(s: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_space = false;
        } else if !prev_space && !out.is_empty() {
            out.push(' ');
            prev_space = true;
        }
    }
    out.trim().to_string()
}

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
    posters::candidates(&client, &title, kind.as_deref().unwrap_or("movie")).await
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
struct DownloadedItem {
    id: String,
    title: String,
    file_name: String,
    kind: String,       // "video" | "audio"
    media_type: String, // "movie" | "show" | "music"
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
    engine: tauri::State<'_, Engine>,
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
) -> Result<ClearResult, String> {
    let removed_active = engine.clear().await;

    let root = std::path::PathBuf::from(&info.download_dir);
    let removed = removed_set(&catalog);
    // On-disk media files removed from the Library (the "unsorted" shelf) — these get trashed.
    let victims: Vec<std::path::PathBuf> = export::scan(&root)
        .into_iter()
        .filter_map(|e| {
            let abs = std::path::PathBuf::from(&e.path);
            let rel = abs.strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/");
            removed.contains(&rel).then_some(abs)
        })
        .collect();

    let root2 = root.clone();
    let trashed = tokio::task::spawn_blocking(move || {
        let n = trash_files(&victims);
        sweep_empty_dirs(&root2);
        n
    })
    .await
    .map_err(|e| e.to_string())?;

    invalidate_scan(&cache); // files trashed off disk
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
/// (add/remove/trash/clear/organize); the short TTL also picks up just-finished downloads.
#[derive(Clone)]
struct ScanCache(Arc<Mutex<Option<(Vec<DownloadedItem>, Instant)>>>);
const SCAN_TTL: Duration = Duration::from_secs(5);

/// Start an FSEvents watcher on the download folder. When files land there — a download
/// finishing, the organize pass, anything — it invalidates the scan cache and emits
/// `library://changed` so the UI re-scans automatically (no manual Refresh). Debounced so
/// a torrent writing many chunks coalesces into one refresh. Source-agnostic: it only
/// knows "files changed on disk", nothing about where they came from.
fn start_library_watcher(app: tauri::AppHandle, dir: PathBuf, cache: ScanCache) {
    use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult};
    use tauri::Emitter;
    let mut debouncer = match new_debouncer(Duration::from_secs(2), move |res: DebounceEventResult| {
        if res.is_ok() {
            invalidate_scan(&cache);
            let _ = app.emit("library://changed", ());
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

fn invalidate_scan(cache: &ScanCache) {
    if let Ok(mut g) = cache.0.lock() {
        *g = None;
    }
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
fn scan_downloaded(info: &AppInfo, catalog: &Catalog) -> Vec<DownloadedItem> {
    let root = std::path::PathBuf::from(&info.download_dir);
    let art_dir = std::path::PathBuf::from(&info.data_dir).join("artwork");
    std::fs::create_dir_all(&art_dir).ok();
    let removed = removed_set(catalog);
    export::scan(&root)
        .into_iter()
        .filter_map(|e| {
            let abs = std::path::PathBuf::from(&e.path);
            let rel = abs.strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/");
            // Video the webview can't decode (mkv, avi, …) is served via on-the-fly HLS
            // transcode; everything else (web-native video, audio) is served raw with Range.
            let url = if info.ffmpeg_available && engine::local_transcodes(&rel) {
                format!("http://127.0.0.1:{}/localhls/{}/index.m3u8", engine::STREAM_PORT, engine::hls_token(&rel))
            } else {
                format!("http://127.0.0.1:{}/file/{}", engine::STREAM_PORT, enc_path(&rel))
            };
            // For audio, embedded tags are the source of truth for artist/album/track/title.
            let (artist, album, genre, track_no, tag_title, embedded_art) = if e.kind == "audio" {
                metadata::read_audio_tags(&abs)
            } else {
                (None, None, None, None, None, None)
            };
            let artwork_url = embedded_art.as_deref().and_then(|bytes| {
                cached_music_artwork_url(&art_dir, &rel, e.size_bytes as i64, e.added_at, bytes)
            });
            Some(DownloadedItem {
                in_library: !removed.contains(&rel),
                id: rel.clone(),
                title: tag_title.unwrap_or(e.title),
                file_name: e.file_name,
                kind: e.kind,
                media_type: e.media_type,
                season: e.season,
                episode: e.episode,
                artist,
                album,
                genre,
                track_no,
                artwork_url,
                size_bytes: e.size_bytes as i64,
                added_at: e.added_at,
                url,
            })
        })
        .collect()
}

/// Everything downloaded to disk, parsed into movies / shows / music with a ready-to-play
/// loopback URL. This is the Library — your local content, independent of the live session.
/// Served from a 5s in-memory cache so rapid tab-switching doesn't re-walk the disk.
#[tauri::command]
fn list_downloaded(
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
) -> Vec<DownloadedItem> {
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
) -> Result<organize::OrganizeResult, String> {
    use tauri::Emitter;
    let root = std::path::PathBuf::from(&info.download_dir);
    let organized = root.join("Library");
    let llm = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let model = resolve_model(catalog.inner(), &llm).await;
    let res = organize::run(&root, &organized, &llm, model.as_deref(), move |step| {
        let _ = app.emit("organize://progress", &step);
    })
    .await;
    invalidate_scan(&cache); // files moved on disk
    Ok(res)
}

fn organize_progress(phase: &str, done: usize, total: usize) -> serde_json::Value {
    serde_json::json!({ "phase": phase, "done": done, "total": total })
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
    let res = tokio::task::spawn_blocking(move || {
        use tauri::Emitter;
        metadata::apply(&root, &changes, |done, total| {
            let _ = app.emit("tag://progress", organize_progress("apply", done, total));
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    invalidate_scan(&cache); // files renamed on disk
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
    engine: tauri::State<'_, Engine>,
    id: String,
    paused: bool,
) -> Result<(), String> {
    engine.set_paused(&id, paused).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn reveal_download(engine: tauri::State<'_, Engine>, id: String) -> Result<(), String> {
    engine.reveal(&id).await.map_err(|e| format!("{e:#}"))
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
                .title("Verify & browse — The Black Pearl")
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
            // A user-chosen storage folder (Settings) overrides the default download dir.
            let stored_dir = catalog.get_setting("storage_dir").filter(|s| !s.trim().is_empty());
            app.manage(catalog);
            let scan_cache = ScanCache(Arc::new(Mutex::new(None)));
            app.manage(scan_cache.clone());

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
                        .join("The Black Pearl")
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
            // Auto-refresh the library when files land in the download folder.
            start_library_watcher(app.handle().clone(), download_dir.clone(), scan_cache);
            let art_dir = data_dir.join("artwork");
            std::fs::create_dir_all(&art_dir).ok();
            let (ffmpeg, ffprobe) = engine::resolve_ffmpeg();
            app.manage(AppInfo {
                download_dir: download_dir.display().to_string(),
                data_dir: data_dir.display().to_string(),
                ffmpeg_available: ffmpeg.is_some(),
            });
            let engine = tauri::async_runtime::block_on(Engine::start(
                app.handle().clone(),
                download_dir,
                art_dir,
                ffmpeg,
                ffprobe,
            ))
            .map_err(|e| Box::<dyn std::error::Error>::from(format!("{e:#}")))?;
            app.manage(engine);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_torrent,
            stream_url,
            torrent_stats,
            list_downloads,
            media_info,
            list_subtitles,
            remove_torrent,
            list_sources,
            add_source,
            remove_source,
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
            vpn_status,
            music_spotiflac_status,
            music_spotiflac_install,
            music_spotiflac_download,
            enrich_catalog,
            fetch_posters,
            tv_search,
            tv_episodes,
            tv_trailer,
            music_search_artists,
            music_artist_albums,
            music_album_tracks,
            ai_status,
            ai_scan,
            clean_titles,
            organize_run,
            tag_plan,
            tag_apply,
            convert_audio,
            list_library,
            list_downloaded,
            poster_candidates,
            set_poster,
            list_poster_overrides,
            add_to_library,
            remove_from_library,
            reveal_path,
            trash_downloaded,
            clear_downloads,
            pause_download,
            reveal_download,
            open_browser,
            import_from_browser,
            pick_folder,
            set_storage_dir,
            restart_app,
            relaunch_for_update,
            list_exportable,
            export_items,
            popular_shows,
            compile_seasons,
            spotify::spotify_status,
            spotify::spotify_login,
            spotify::spotify_logout,
            spotify::spotify_playlist_preview,
            spotify::spotify_replicate,
            spotify::spotify_album_art,
            spotify::spotify_search_artists,
            spotify::spotify_artist_albums
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
    ];
    for (name, kind, url) in defaults {
        let _ = catalog.add_source(name, kind, url);
    }
}
