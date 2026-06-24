//! Spotify integration — "replicate a playlist from your sources".
//!
//! OAuth (Authorization Code) login so it can read private playlists, then for each
//! track we search the linked torrent sources and rank candidates by audio quality
//! (FLAC → ALAC → 320 → …) so the user can pick the version they want. Self-contained:
//! the only `lib.rs` touch is registering these commands. Tokens live in the settings
//! table; the loopback redirect is caught by an ephemeral server on a fixed port.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::catalog::{Catalog, CatalogItem, Source};

pub const REDIRECT_PORT: u16 = 3031;
pub const REDIRECT_URI: &str = "http://127.0.0.1:3031/callback";
const SCOPE: &str = "playlist-read-private playlist-read-collaborative user-library-read";

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())
}

// ---- status ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyStatus {
    /// A refresh token is stored (we can fetch playlists).
    connected: bool,
    /// Client ID + Secret are present (login is possible).
    has_credentials: bool,
    /// Redirect URI the user must register in their Spotify app dashboard.
    redirect_uri: String,
}

#[tauri::command]
pub fn spotify_status(catalog: tauri::State<'_, Catalog>) -> SpotifyStatus {
    let cred = |k: &str| catalog.get_setting(k).filter(|v| !v.trim().is_empty()).is_some();
    SpotifyStatus {
        connected: cred("spotify_refresh_token"),
        has_credentials: cred("spotify_client_id") && cred("spotify_client_secret"),
        redirect_uri: REDIRECT_URI.to_string(),
    }
}

#[tauri::command]
pub fn spotify_logout(catalog: tauri::State<'_, Catalog>) -> Result<(), String> {
    for k in ["spotify_refresh_token", "spotify_access_token", "spotify_expires_at"] {
        let _ = catalog.set_setting(k, "");
    }
    Ok(())
}

// ---- OAuth login ----

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: i64,
}

#[tauri::command]
pub async fn spotify_login(app: AppHandle, catalog: tauri::State<'_, Catalog>) -> Result<(), String> {
    let id = setting(&catalog, "spotify_client_id").ok_or("Add your Spotify Client ID first.")?;
    let secret = setting(&catalog, "spotify_client_secret").ok_or("Add your Spotify Client Secret first.")?;

    // Open Spotify's consent page in the user's real browser (embedded webviews are
    // often blocked for OAuth). The redirect lands on our loopback regardless.
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(authorize_url(&id), None::<&str>)
        .map_err(|e| format!("couldn't open browser: {e}"))?;

    // Wait for Spotify to redirect to our loopback with ?code=… (or ?error=…).
    let code = tokio::time::timeout(Duration::from_secs(180), run_callback_server())
        .await
        .map_err(|_| "Timed out waiting for Spotify login.".to_string())?
        .map_err(|e| format!("{e:#}"))?;

    let client = http()?;
    let resp: TokenResp = client
        .post("https://accounts.spotify.com/api/token")
        .basic_auth(&id, Some(&secret))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", REDIRECT_URI),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("Spotify token exchange failed: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let _ = catalog.set_setting("spotify_refresh_token", &resp.refresh_token.unwrap_or_default());
    let _ = catalog.set_setting("spotify_access_token", &resp.access_token);
    let _ = catalog.set_setting("spotify_expires_at", &(now_ms() + resp.expires_in * 1000).to_string());
    Ok(())
}

fn authorize_url(client_id: &str) -> String {
    format!(
        "https://accounts.spotify.com/authorize?response_type=code&client_id={}&scope={}&redirect_uri={}&show_dialog=true",
        urlencode(client_id),
        urlencode(SCOPE),
        urlencode(REDIRECT_URI),
    )
}

/// Bind the loopback redirect server and return the authorization `code`.
async fn run_callback_server() -> Result<String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
        .await
        .map_err(|e| anyhow!("couldn't bind {REDIRECT_URI}: {e}"))?;
    loop {
        let (mut sock, _) = listener.accept().await?;
        let mut buf = [0u8; 8192];
        let n = sock.read(&mut buf).await.unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let target = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("");
        if !target.starts_with("/callback") {
            let _ = sock.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let html = "<!doctype html><meta charset=utf-8><body style=\"font-family:system-ui;background:#0b0b0d;color:#e7e7ea;display:grid;place-items:center;height:100vh;margin:0\"><div style=text-align:center><h2>Connected to Spotify</h2><p style=color:#9aa9b4>You can close this window and return to the app.</p></div></body>";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            html.len(),
            html
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        if let Some(err) = query_param(target, "error") {
            return Err(anyhow!("Spotify authorization denied ({err})"));
        }
        if let Some(code) = query_param(target, "code") {
            return Ok(code);
        }
    }
}

async fn ensure_access(catalog: &Catalog) -> Result<String, String> {
    let exp = catalog.get_setting("spotify_expires_at").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    if let Some(a) = setting(catalog, "spotify_access_token") {
        if now_ms() < exp - 30_000 {
            return Ok(a);
        }
    }
    let id = setting(catalog, "spotify_client_id").ok_or("Spotify isn't configured.")?;
    let secret = setting(catalog, "spotify_client_secret").ok_or("Spotify isn't configured.")?;
    let refresh = setting(catalog, "spotify_refresh_token").ok_or("Connect Spotify first.")?;
    let client = http()?;
    let resp: TokenResp = client
        .post("https://accounts.spotify.com/api/token")
        .basic_auth(&id, Some(&secret))
        .form(&[("grant_type", "refresh_token"), ("refresh_token", &refresh)])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|_| "Spotify session expired — reconnect in the playlist dialog.".to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let _ = catalog.set_setting("spotify_access_token", &resp.access_token);
    let _ = catalog.set_setting("spotify_expires_at", &(now_ms() + resp.expires_in * 1000).to_string());
    if let Some(r) = resp.refresh_token {
        let _ = catalog.set_setting("spotify_refresh_token", &r);
    }
    Ok(resp.access_token)
}

// ---- playlist fetch ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    name: String,
    artist: String,
    album: String,
    album_art: Option<String>,
    duration_ms: i64,
    isrc: Option<String>,
    /// Spotify track id + open.spotify.com link (so the UI can play it in Spotify).
    id: Option<String>,
    url: Option<String>,
    /// 30s preview clip, when Spotify exposes one (often null for newer apps).
    preview_url: Option<String>,
}

#[derive(Deserialize)]
struct PlMeta {
    name: String,
}
#[derive(Deserialize)]
struct TracksPage {
    items: Vec<PlItem>,
    next: Option<String>,
}
#[derive(Deserialize)]
struct PlItem {
    track: Option<TrackObj>,
}
#[derive(Deserialize)]
struct TrackObj {
    #[serde(default)]
    id: Option<String>,
    name: String,
    #[serde(default)]
    artists: Vec<NameObj>,
    album: AlbumObj,
    #[serde(default)]
    duration_ms: i64,
    #[serde(default)]
    external_ids: Option<ExtIds>,
    #[serde(default)]
    external_urls: Option<ExtUrls>,
    #[serde(default)]
    preview_url: Option<String>,
}
#[derive(Deserialize, Default)]
struct ExtUrls {
    #[serde(default)]
    spotify: Option<String>,
}
#[derive(Deserialize)]
struct NameObj {
    name: String,
}
#[derive(Deserialize)]
struct AlbumObj {
    #[serde(default)]
    name: String,
    #[serde(default)]
    images: Vec<ImageObj>,
}
#[derive(Deserialize)]
struct ImageObj {
    url: String,
}
#[derive(Deserialize, Default)]
struct ExtIds {
    #[serde(default)]
    isrc: Option<String>,
}

/// Fetch a playlist's tracks. Tries the Web API first (richest data), then falls
/// back to scraping the public embed page — Spotify blocks editorial / algorithmic
/// playlists from the Web API for apps created after Nov 2024 (HTTP 403), but the
/// embed still carries the track list (name + artist), which is all we need to match.
async fn fetch_playlist(client: &reqwest::Client, access: &str, id: &str) -> Result<(String, Vec<Track>), String> {
    match fetch_playlist_api(client, access, id).await {
        Ok(r) => Ok(r),
        Err(_api_err) => fetch_playlist_embed(client, id).await.map_err(|embed_err| {
            // Both paths failed: the API blocked it AND it isn't publicly embeddable.
            format!(
                "Couldn't read this playlist's tracks. Spotify blocks editorial & algorithmic \
                 playlists from its Web API for apps created after Nov 2024 — and {embed_err} \
                 Try a playlist you created, or any public one."
            )
        }),
    }
}

async fn fetch_playlist_api(client: &reqwest::Client, access: &str, id: &str) -> Result<(String, Vec<Track>), String> {
    let meta: PlMeta = client
        .get(format!("https://api.spotify.com/v1/playlists/{id}?fields=name"))
        .bearer_auth(access)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|_| "Couldn't open that playlist — is it private or wrong?".to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let mut url = format!(
        "https://api.spotify.com/v1/playlists/{id}/tracks?limit=100&fields=items(track(id,name,artists(name),album(name,images),duration_ms,external_ids,external_urls,preview_url)),next"
    );
    let mut out = Vec::new();
    loop {
        let page: TracksPage = client
            .get(&url)
            .bearer_auth(access)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        for it in page.items {
            if let Some(t) = it.track {
                let id = t.id.clone();
                let url = t
                    .external_urls
                    .and_then(|u| u.spotify)
                    .or_else(|| id.as_ref().map(|i| format!("https://open.spotify.com/track/{i}")));
                out.push(Track {
                    artist: t.artists.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", "),
                    name: t.name,
                    album: t.album.name,
                    album_art: t.album.images.into_iter().next().map(|i| i.url),
                    duration_ms: t.duration_ms,
                    isrc: t.external_ids.and_then(|e| e.isrc),
                    preview_url: t.preview_url,
                    id,
                    url,
                });
            }
        }
        match page.next {
            Some(n) => url = n,
            None => break,
        }
    }
    Ok((meta.name, out))
}

const SPOTIFY_EMBED_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

async fn fetch_embed_tracklist(
    client: &reqwest::Client,
    kind: &str,
    id: &str,
    fallback_name: &str,
    not_public_message: &str,
) -> Result<(String, Vec<Track>), String> {
    let html = client
        .get(format!("https://open.spotify.com/embed/{kind}/{id}"))
        .header("User-Agent", SPOTIFY_EMBED_UA)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    // Pull the __NEXT_DATA__ JSON island out of the page.
    let marker = html.find("__NEXT_DATA__").ok_or_else(|| not_public_message.to_string())?;
    let json_start = html[marker..]
        .find('>')
        .map(|i| marker + i + 1)
        .ok_or("Couldn't parse the Spotify embed.")?;
    let json_end = html[json_start..]
        .find("</script>")
        .map(|i| json_start + i)
        .ok_or("Couldn't parse the Spotify embed.")?;
    let data: serde_json::Value =
        serde_json::from_str(html[json_start..json_end].trim()).map_err(|e| format!("Couldn't parse the Spotify embed: {e}"))?;

    let list = find_key(&data, "trackList")
        .and_then(|v| v.as_array())
        .ok_or_else(|| not_public_message.to_string())?;

    let base_name = find_key(&data, "name")
        .and_then(|v| v.as_str())
        .unwrap_or(fallback_name)
        .trim()
        .to_string();
    let subtitle = find_key(&data, "subtitle").and_then(|v| v.as_str()).unwrap_or("").trim();

    let queue_name = if kind == "artist" && !base_name.is_empty() && !subtitle.is_empty() {
        format!("{} • {}", base_name, subtitle)
    } else {
        base_name.clone()
    };

    let album_fallback = if kind == "album" { base_name.as_str() } else { "" };
    let mut out = Vec::new();
    for it in list {
        let title = it.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
        if title.is_empty() {
            continue;
        }
        let id = it
            .get("uri")
            .and_then(|v| v.as_str())
            .and_then(|u| u.strip_prefix("spotify:track:"))
            .map(|s| s.to_string());
        let album_art = it
            .pointer("/coverArt/sources/0/url")
            .and_then(|v| v.as_str())
            .map(String::from);
        let preview_url = it
            .get("audioPreview")
            .and_then(|a| a.get("url"))
            .and_then(|v| v.as_str())
            .map(String::from);
        out.push(Track {
            name: title.to_string(),
            artist: it.get("subtitle").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            album: album_fallback.to_string(),
            album_art,
            duration_ms: it.get("duration").and_then(|v| v.as_i64()).unwrap_or(0),
            isrc: None,
            url: id.as_ref().map(|i| format!("https://open.spotify.com/track/{i}")),
            id,
            preview_url,
        });
    }
    if out.is_empty() {
        return Err(format!("No tracks found in that {kind}."));
    }
    Ok((queue_name, out))
}

/// Scrape the public embed page for a playlist's track list (no auth). Works for
/// public playlists — including the editorial/algorithmic ones the Web API blocks.
async fn fetch_playlist_embed(client: &reqwest::Client, id: &str) -> Result<(String, Vec<Track>), String> {
    fetch_embed_tracklist(
        client,
        "playlist",
        id,
        "Playlist",
        "This playlist isn't public, so its tracks can't be read.",
    )
    .await
}

async fn fetch_album_embed(client: &reqwest::Client, id: &str) -> Result<(String, Vec<Track>), String> {
    fetch_embed_tracklist(
        client,
        "album",
        id,
        "Album",
        "Couldn't read this album's tracks from Spotify.",
    )
    .await
}

async fn fetch_artist_embed(client: &reqwest::Client, id: &str) -> Result<(String, Vec<Track>), String> {
    fetch_embed_tracklist(
        client,
        "artist",
        id,
        "Artist",
        "Couldn't read this artist's top tracks from Spotify.",
    )
    .await
}

/// Depth-first search for the first value under `key` anywhere in a JSON tree.
fn find_key<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    match v {
        serde_json::Value::Object(m) => {
            if let Some(found) = m.get(key) {
                return Some(found);
            }
            m.values().find_map(|vv| find_key(vv, key))
        }
        serde_json::Value::Array(a) => a.iter().find_map(|vv| find_key(vv, key)),
        _ => None,
    }
}

// ---- replicate (match each track against the sources) ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaMatch {
    #[serde(flatten)]
    item: CatalogItem,
    quality: String,
    quality_rank: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaTrack {
    track: Track,
    matches: Vec<ReplicaMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaResult {
    playlist: String,
    /// Total tracks in the playlist (before the per-run cap).
    total: usize,
    tracks: Vec<ReplicaTrack>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistPreviewResult {
    playlist: String,
    total: usize,
    tracks: Vec<Track>,
}

#[tauri::command]
pub async fn spotify_playlist_preview(
    catalog: tauri::State<'_, Catalog>,
    playlist_url: String,
) -> Result<PlaylistPreviewResult, String> {
    let id = parse_playlist_id(&playlist_url).ok_or("That doesn't look like a Spotify playlist link.")?;
    let client = http()?;

    // Prefer the authenticated API (richer metadata), but still support public
    // playlists without login via embed scraping.
    let (playlist, tracks) = match ensure_access(&catalog).await {
        Ok(access) => match fetch_playlist(&client, &access, &id).await {
            Ok(result) => result,
            Err(_) => fetch_playlist_embed(&client, &id).await?,
        },
        Err(_) => fetch_playlist_embed(&client, &id).await?,
    };

    let tracks = dedupe_tracks(tracks);
    let total = tracks.len();
    if total == 0 {
        return Err("No tracks found in that playlist.".to_string());
    }
    Ok(PlaylistPreviewResult { playlist, total, tracks })
}

#[tauri::command]
pub async fn spotify_album_preview(album_url: String) -> Result<PlaylistPreviewResult, String> {
    let id = parse_album_id(&album_url).ok_or("That doesn't look like a Spotify album link.")?;
    let client = http()?;
    let (playlist, tracks) = fetch_album_embed(&client, &id).await?;
    let tracks = dedupe_tracks(tracks);
    let total = tracks.len();
    if total == 0 {
        return Err("No tracks found in that album.".to_string());
    }
    Ok(PlaylistPreviewResult { playlist, total, tracks })
}

#[tauri::command]
pub async fn spotify_artist_top_tracks_preview(artist_url: String) -> Result<PlaylistPreviewResult, String> {
    let id = parse_artist_id(&artist_url).ok_or("That doesn't look like a Spotify artist link.")?;
    let client = http()?;
    let (playlist, tracks) = fetch_artist_embed(&client, &id).await?;
    let tracks = dedupe_tracks(tracks);
    let total = tracks.len();
    if total == 0 {
        return Err("No top tracks were found for that artist.".to_string());
    }
    Ok(PlaylistPreviewResult { playlist, total, tracks })
}

// ---- the signed-in user's own library (their playlists + Liked Songs), for SpotiMirror ----

/// One of the signed-in user's playlists (the SpotiMirror sync picker lists these).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MyPlaylist {
    id: String,
    name: String,
    url: Option<String>,
    owner: Option<String>,
    image: Option<String>,
    track_count: i64,
}

/// List the signed-in user's playlists (paginated). Requires a Spotify login.
///
/// Parsed defensively from raw JSON: Spotify's `/me/playlists` is loose — `images` can be `null`,
/// individual `items` can be `null`, and fields come and go — so strict serde structs reject real
/// responses ("error decoding response body"). Walking the Value tolerates all of that.
#[tauri::command]
pub async fn spotify_my_playlists(catalog: tauri::State<'_, Catalog>) -> Result<Vec<MyPlaylist>, String> {
    let access = ensure_access(&catalog).await?;
    let client = http()?;
    let mut url = "https://api.spotify.com/v1/me/playlists?limit=50".to_string();
    let mut out = Vec::new();
    loop {
        let page: serde_json::Value = client
            .get(&url)
            .bearer_auth(&access)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|_| "Couldn't read your Spotify playlists — reconnect Spotify and try again.".to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;

        for it in page.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
            let Some(id) = it.get("id").and_then(|v| v.as_str()) else { continue };
            let id = id.to_string();
            let link = it
                .get("external_urls")
                .and_then(|u| u.get("spotify"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("https://open.spotify.com/playlist/{id}"));
            let owner = it
                .get("owner")
                .and_then(|o| o.get("display_name"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let image = it
                .get("images")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|im| im.get("url"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            // Spotify's /me/playlists gives tracks.total, but be defensive about number type +
            // alternate shapes so a quirk never collapses every playlist to "0 songs".
            let track_count = it
                .get("tracks")
                .and_then(|t| {
                    t.get("total")
                        .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|u| u as i64)).or_else(|| v.as_f64().map(|f| f as i64)))
                        .or_else(|| t.as_array().map(|a| a.len() as i64))
                })
                .or_else(|| it.get("track_count").and_then(|v| v.as_i64()))
                .unwrap_or(0);
            out.push(MyPlaylist {
                name: it.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled playlist").to_string(),
                url: Some(link),
                owner,
                image,
                track_count,
                id,
            });
        }

        match page.get("next").and_then(|v| v.as_str()) {
            Some(n) => url = n.to_string(),
            None => break,
        }
    }
    Ok(out)
}

/// The signed-in user's Liked Songs (paginated). Needs the `user-library-read` scope — a user who
/// logged in before SpotiMirror shipped must reconnect once to grant it.
#[tauri::command]
pub async fn spotify_liked_tracks(catalog: tauri::State<'_, Catalog>) -> Result<Vec<Track>, String> {
    let access = ensure_access(&catalog).await?;
    let client = http()?;
    let mut url =
        "https://api.spotify.com/v1/me/tracks?limit=50&fields=items(track(id,name,artists(name),album(name,images),duration_ms,external_ids,external_urls,preview_url)),next".to_string();
    let mut out = Vec::new();
    loop {
        let page: TracksPage = client
            .get(&url)
            .bearer_auth(&access)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|_| "Couldn't read your Liked Songs — reconnect Spotify to grant library access.".to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        for it in page.items {
            if let Some(t) = it.track {
                let id = t.id.clone();
                let track_url = t
                    .external_urls
                    .and_then(|u| u.spotify)
                    .or_else(|| id.as_ref().map(|i| format!("https://open.spotify.com/track/{i}")));
                out.push(Track {
                    artist: t.artists.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", "),
                    name: t.name,
                    album: t.album.name,
                    album_art: t.album.images.into_iter().next().map(|i| i.url),
                    duration_ms: t.duration_ms,
                    isrc: t.external_ids.and_then(|e| e.isrc),
                    preview_url: t.preview_url,
                    id,
                    url: track_url,
                });
            }
        }
        match page.next {
            Some(n) => url = n,
            None => break,
        }
    }
    Ok(dedupe_tracks(out))
}

const MAX_TRACKS: usize = 50;

#[tauri::command]
pub async fn spotify_replicate(
    catalog: tauri::State<'_, Catalog>,
    playlist_url: String,
) -> Result<ReplicaResult, String> {
    let id = parse_playlist_id(&playlist_url).ok_or("That doesn't look like a Spotify playlist link.")?;
    let access = ensure_access(&catalog).await?;
    let client = http()?;
    let (name, tracks) = fetch_playlist(&client, &access, &id).await?;
    let total = tracks.len();

    let sources: Arc<Vec<Source>> = Arc::new(
        catalog.list_sources().map_err(|e| format!("{e:#}"))?.into_iter().filter(|s| s.enabled).collect(),
    );
    let now = now_ms();
    let sem = Arc::new(tokio::sync::Semaphore::new(5));
    let mut set = tokio::task::JoinSet::new();

    for (idx, tr) in tracks.iter().take(MAX_TRACKS).enumerate() {
        let q = format!("{} {}", first_artist(&tr.artist), clean_track_query(&tr.name));
        let sources = sources.clone();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            let mut hits: Vec<CatalogItem> = Vec::new();
            for s in sources.iter() {
                if let Ok(items) = crate::indexer::search_source(&s.kind, &s.url, &q, &s.name, now).await {
                    hits.extend(items);
                }
            }
            (idx, hits)
        });
    }

    let mut hits_by_idx: std::collections::HashMap<usize, Vec<CatalogItem>> = std::collections::HashMap::new();
    while let Some(res) = set.join_next().await {
        if let Ok((idx, hits)) = res {
            hits_by_idx.insert(idx, hits);
        }
    }

    let out: Vec<ReplicaTrack> = tracks
        .into_iter()
        .take(MAX_TRACKS)
        .enumerate()
        .map(|(idx, track)| {
            let hits = hits_by_idx.remove(&idx).unwrap_or_default();
            let matches = build_matches(&track, hits);
            ReplicaTrack { track, matches }
        })
        .collect();

    Ok(ReplicaResult { playlist: name, total, tracks: out })
}

/// Keep audio results that plausibly match the track, rank them best-quality-first.
fn build_matches(track: &Track, hits: Vec<CatalogItem>) -> Vec<ReplicaMatch> {
    let artist = first_artist(&track.artist).to_lowercase();
    let name = track.name.to_lowercase();
    let mut seen = HashSet::new();
    let mut out: Vec<ReplicaMatch> = hits
        .into_iter()
        .filter(|it| {
            let t = it.title.to_lowercase();
            let audio = it.category == "audio"
                || ["flac", "mp3", "alac", "aac", "m4a", "wav", "320", "album", "discography", "lossless"]
                    .iter()
                    .any(|k| t.contains(k));
            let relevant = (!artist.is_empty() && t.contains(&artist)) || (name.len() > 3 && t.contains(&name));
            audio && relevant
        })
        .filter(|it| seen.insert(it.id.clone()))
        .map(|it| {
            let (quality, quality_rank) = audio_quality(&it.title);
            ReplicaMatch { quality: quality.to_string(), quality_rank, item: it }
        })
        .collect();
    out.sort_by(|a, b| b.quality_rank.cmp(&a.quality_rank).then(b.item.seeders.cmp(&a.item.seeders)));
    out.truncate(10);
    out
}

/// Best-effort audio quality label + rank from a release title (higher = better).
fn audio_quality(title: &str) -> (&'static str, i32) {
    let t = title.to_lowercase();
    if t.contains("24bit") || t.contains("24-bit") || t.contains("hi-res") || t.contains("hires") {
        return ("FLAC 24-bit", 110);
    }
    if t.contains("flac") || t.contains("lossless") {
        return ("FLAC", 100);
    }
    if t.contains("alac") || t.contains("aiff") || t.contains(".wav") || t.contains(" wav") {
        return ("Lossless", 95);
    }
    if t.contains("320") {
        return ("MP3 320", 70);
    }
    if t.contains("v0") || t.contains("vbr") {
        return ("MP3 V0", 65);
    }
    if t.contains("256") {
        return ("MP3 256", 55);
    }
    if t.contains("192") {
        return ("MP3 192", 40);
    }
    if t.contains("mp3") || t.contains("aac") || t.contains("m4a") {
        return ("MP3", 30);
    }
    ("Audio", 10)
}

fn first_artist(artists: &str) -> &str {
    artists.split(',').next().map(str::trim).unwrap_or(artists)
}

/// Drop "(feat. …)", "- Remastered", "- Live" etc. so the search matches the base
/// track on release torrents (which rarely carry those qualifiers).
fn clean_track_query(name: &str) -> String {
    let lower = name.to_lowercase();
    let cut = [" (feat", " [feat", " (ft", " (with", " - remaster", " - live", " - acoustic", " - mono"]
        .iter()
        .filter_map(|m| lower.find(m))
        .min();
    match cut {
        Some(i) => name[..i].trim().to_string(),
        None => name.trim().to_string(),
    }
}

fn norm_track_piece(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn track_dedupe_key(t: &Track) -> String {
    if let Some(id) = t.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return format!("id:{}", id.to_ascii_lowercase());
    }
    if let Some(isrc) = t.isrc.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return format!("isrc:{}", isrc.to_ascii_lowercase());
    }
    let title = norm_track_piece(&t.name);
    let artist = norm_track_piece(first_artist(&t.artist));
    format!("meta:{title}:{artist}")
}

fn dedupe_tracks(tracks: Vec<Track>) -> Vec<Track> {
    let mut out = Vec::with_capacity(tracks.len());
    let mut seen = HashSet::new();
    for t in tracks {
        let key = track_dedupe_key(&t);
        if seen.insert(key) {
            out.push(t);
        }
    }
    out
}

fn parse_spotify_id(input: &str, kind: &str) -> Option<String> {
    let s = input.trim();
    let uri_prefix = format!("spotify:{kind}:");
    if let Some(rest) = s.strip_prefix(&uri_prefix) {
        let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        return (!id.is_empty()).then_some(id);
    }
    let path_marker = format!("/{kind}/");
    if let Some(idx) = s.find(&path_marker) {
        let rest = &s[idx + path_marker.len()..];
        let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        return (!id.is_empty()).then_some(id);
    }
    if s.len() >= 16 && s.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Some(s.to_string());
    }
    None
}

pub fn parse_playlist_id(input: &str) -> Option<String> {
    parse_spotify_id(input, "playlist")
}

pub fn parse_album_id(input: &str) -> Option<String> {
    parse_spotify_id(input, "album")
}

pub fn parse_artist_id(input: &str) -> Option<String> {
    parse_spotify_id(input, "artist")
}

/// Fetch a Spotify playlist as portable playlist-manifest tracks. Tries the authed
/// Web API first (covers the user's private/collaborative playlists), then falls back
/// to the public embed scrape (editorial/algorithmic playlists the new API blocks).
/// Returns (playlist_name, tracks).
pub async fn fetch_playlist_for(
    catalog: &Catalog,
    link: &str,
) -> Result<(String, Vec<crate::playlist::PlaylistTrack>), String> {
    let id = parse_playlist_id(link).ok_or_else(|| "That doesn't look like a Spotify playlist link.".to_string())?;
    let client = http()?;
    // Use the user token when logged in (needed for private playlists); otherwise embed.
    let (name, tracks) = match ensure_access(catalog).await {
        Ok(access) => match fetch_playlist(&client, &access, &id).await {
            Ok(v) => v,
            Err(_) => fetch_playlist_embed(&client, &id).await?,
        },
        Err(_) => fetch_playlist_embed(&client, &id).await?,
    };
    let out = dedupe_tracks(tracks)
        .into_iter()
        .map(|t| crate::playlist::PlaylistTrack {
            title: t.name,
            artist: t.artist,
            album: t.album,
            duration_ms: t.duration_ms,
            isrc: t.isrc,
            path: None,
            spotify_url: t.url,
            url: None,
        })
        .collect();
    Ok((name, out))
}

/// Best-effort cover art + display name + track count for any public Spotify
/// playlist/album/artist link, scraped from the embed page (no auth required).
/// Returns (name, cover_url, track_count). Used to enrich import cards.
pub async fn fetch_embed_meta(
    link: &str,
    kind: &str,
) -> Result<(String, Option<String>, Option<u32>), String> {
    let id = parse_spotify_id(link, kind)
        .ok_or_else(|| "Unrecognized Spotify link.".to_string())?;
    let client = http()?;
    let html = client
        .get(format!("https://open.spotify.com/embed/{kind}/{id}"))
        .header("User-Agent", SPOTIFY_EMBED_UA)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    let marker = html
        .find("__NEXT_DATA__")
        .ok_or_else(|| "Couldn't read Spotify embed metadata.".to_string())?;
    let json_start = html[marker..]
        .find('>')
        .map(|i| marker + i + 1)
        .ok_or("Couldn't parse the Spotify embed.")?;
    let json_end = html[json_start..]
        .find("</script>")
        .map(|i| json_start + i)
        .ok_or("Couldn't parse the Spotify embed.")?;
    let data: serde_json::Value = serde_json::from_str(html[json_start..json_end].trim())
        .map_err(|e| format!("Couldn't parse the Spotify embed: {e}"))?;

    let name = find_key(&data, "name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Spotify import".to_string());

    // Prefer the entity-level cover; otherwise fall back to the first track's art.
    let cover = find_key(&data, "coverArt")
        .and_then(|c| c.pointer("/sources/0/url"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let total = find_key(&data, "trackList")
        .and_then(|v| v.as_array())
        .map(|a| a.len() as u32)
        .filter(|n| *n > 0);

    Ok((name, cover, total))
}


// ---- album cover art (legitimate cover-art lookup via Spotify catalog search) ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumQuery {
    pub artist: String,
    pub album: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AlbumArt {
    pub artist: String,
    pub album: String,
    pub art: Option<String>,
}

/// App-level (client-credentials) token — no user login, enough to read public catalog.
async fn app_token(client: &reqwest::Client, id: &str, secret: &str) -> Result<String, String> {
    let resp: TokenResp = client
        .post("https://accounts.spotify.com/api/token")
        .basic_auth(id, Some(secret))
        .form(&[("grant_type", "client_credentials")])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|_| "Spotify auth failed — check your Client ID/Secret in the playlist replicator.".to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(resp.access_token)
}

#[derive(Deserialize)]
struct AlbumSearchResp {
    albums: AlbumItems,
}
#[derive(Deserialize)]
struct AlbumItems {
    #[serde(default)]
    items: Vec<AlbumHit>,
}
#[derive(Deserialize)]
struct AlbumHit {
    #[serde(default)]
    images: Vec<ImageObj>,
}

async fn search_album_art(client: &reqwest::Client, token: &str, artist: &str, album: &str) -> Option<String> {
    let q = format!("album:{} artist:{}", album.trim(), artist.trim());
    let resp: AlbumSearchResp = client
        .get("https://api.spotify.com/v1/search")
        .bearer_auth(token)
        .query(&[("q", q.as_str()), ("type", "album"), ("limit", "1")])
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    resp.albums.items.into_iter().next()?.images.into_iter().next().map(|i| i.url)
}

/// Look up Spotify cover art for a batch of (artist, album) pairs (bounded concurrency).
/// Each result carries its artist+album so the UI can map covers back by key. Uses the
/// stored Client ID/Secret via client-credentials — only reads public album metadata.
pub async fn album_art_batch(catalog: &Catalog, queries: Vec<AlbumQuery>) -> Result<Vec<AlbumArt>, String> {
    let id = setting(catalog, "spotify_client_id").ok_or("Add your Spotify Client ID in the playlist replicator first.")?;
    let secret = setting(catalog, "spotify_client_secret").ok_or("Add your Spotify Client Secret first.")?;
    let client = std::sync::Arc::new(http()?);
    let token = std::sync::Arc::new(app_token(&client, &id, &secret).await?);
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(5));
    let mut set = tokio::task::JoinSet::new();
    for q in queries {
        let client = client.clone();
        let token = token.clone();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            let art = search_album_art(&client, &token, &q.artist, &q.album).await;
            AlbumArt { artist: q.artist, album: q.album, art }
        });
    }
    let mut out = Vec::new();
    while let Some(r) = set.join_next().await {
        if let Ok(a) = r {
            out.push(a);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn spotify_album_art(
    catalog: tauri::State<'_, Catalog>,
    albums: Vec<AlbumQuery>,
) -> Result<Vec<AlbumArt>, String> {
    album_art_batch(&catalog, albums).await
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyArtist {
    pub id: String,
    pub name: String,
    pub image: Option<String>,
    pub url: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyAlbum {
    pub id: String,
    pub name: String,
    pub artist: String,
    pub image: Option<String>,
    pub url: String,
    pub year: Option<i32>,
    pub track_count: i32,
}

#[derive(Deserialize)]
struct SpotifyArtistSearchResp {
    artists: SpotifyArtistItems,
}

#[derive(Deserialize)]
struct SpotifyArtistItems {
    #[serde(default)]
    items: Vec<SpotifyArtistHit>,
}

#[derive(Deserialize)]
struct SpotifyArtistHit {
    id: String,
    name: String,
    #[serde(default)]
    images: Vec<ImageObj>,
    #[serde(default)]
    external_urls: Option<ExtUrls>,
}

#[derive(Deserialize)]
struct SpotifyArtistAlbumsResp {
    #[serde(default)]
    items: Vec<SpotifyAlbumHit>,
    next: Option<String>,
}

#[derive(Deserialize)]
struct SpotifyAlbumHit {
    id: String,
    name: String,
    #[serde(default)]
    images: Vec<ImageObj>,
    #[serde(default)]
    artists: Vec<NameObj>,
    #[serde(default)]
    release_date: String,
    #[serde(default)]
    total_tracks: i32,
    #[serde(default)]
    external_urls: Option<ExtUrls>,
}

async fn spotify_app_access(catalog: &Catalog) -> Result<(reqwest::Client, String), String> {
    let id = setting(catalog, "spotify_client_id").ok_or("Add your Spotify Client ID in Settings first.")?;
    let secret = setting(catalog, "spotify_client_secret").ok_or("Add your Spotify Client Secret in Settings first.")?;
    let client = http()?;
    let token = app_token(&client, &id, &secret).await?;
    Ok((client, token))
}

fn spotify_album_year(release_date: &str) -> Option<i32> {
    release_date.split('-').next()?.parse::<i32>().ok()
}

#[tauri::command]
pub async fn spotify_search_artists(
    catalog: tauri::State<'_, Catalog>,
    query: String,
) -> Result<Vec<SpotifyArtist>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let (client, token) = spotify_app_access(&catalog).await?;
    let resp: SpotifyArtistSearchResp = client
        .get("https://api.spotify.com/v1/search")
        .bearer_auth(&token)
        .query(&[("q", q), ("type", "artist"), ("limit", "8")])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("Spotify artist search failed: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    Ok(resp
        .artists
        .items
        .into_iter()
        .map(|artist| SpotifyArtist {
            url: artist
                .external_urls
                .and_then(|urls| urls.spotify)
                .unwrap_or_else(|| format!("https://open.spotify.com/artist/{}", artist.id)),
            image: artist.images.into_iter().next().map(|image| image.url),
            id: artist.id,
            name: artist.name,
        })
        .collect())
}

#[tauri::command]
pub async fn spotify_artist_albums(
    catalog: tauri::State<'_, Catalog>,
    artist_id: String,
) -> Result<Vec<SpotifyAlbum>, String> {
    let artist_id = artist_id.trim();
    if artist_id.is_empty() {
        return Ok(Vec::new());
    }
    let (client, token) = spotify_app_access(&catalog).await?;
    fetch_all_artist_albums(&client, &token, artist_id).await
}

/// Every album + single an artist released (paginated, deduped by name+year so cross-market and
/// standard/deluxe re-releases don't multiply). Sorted newest-first.
async fn fetch_all_artist_albums(
    client: &reqwest::Client,
    token: &str,
    artist_id: &str,
) -> Result<Vec<SpotifyAlbum>, String> {
    let mut url = format!(
        "https://api.spotify.com/v1/artists/{artist_id}/albums?include_groups=album,single&limit=50"
    );
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    loop {
        let page: SpotifyArtistAlbumsResp = client
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| format!("Spotify album lookup failed: {e}"))?
            .json()
            .await
            .map_err(|e| e.to_string())?;

        for album in page.items {
            let year = spotify_album_year(&album.release_date);
            let dedupe_key = format!(
                "{}:{}",
                album.name.trim().to_lowercase(),
                year.map(|value| value.to_string()).unwrap_or_default()
            );
            if !seen.insert(dedupe_key) {
                continue;
            }
            out.push(SpotifyAlbum {
                url: album
                    .external_urls
                    .and_then(|urls| urls.spotify)
                    .unwrap_or_else(|| format!("https://open.spotify.com/album/{}", album.id)),
                image: album.images.into_iter().next().map(|image| image.url),
                artist: album
                    .artists
                    .first()
                    .map(|artist| artist.name.clone())
                    .unwrap_or_default(),
                year,
                track_count: album.total_tracks,
                id: album.id,
                name: album.name,
            });
        }

        match page.next {
            Some(next) => url = next,
            None => break,
        }
    }

    out.sort_by(|a, b| b.year.cmp(&a.year).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

#[derive(Deserialize)]
struct ArtistObj {
    #[serde(default)]
    name: String,
}

/// Resolve a Spotify ARTIST link to (artist name, full discography) for importing — the whole
/// catalogue, not the ~10 top tracks the public embed exposes. Needs the Spotify API (Client ID /
/// Secret in Settings); callers fall back to the single link when this errors.
pub async fn artist_albums_for_import(
    catalog: &Catalog,
    artist_url: &str,
) -> Result<(String, Vec<SpotifyAlbum>), String> {
    let id = parse_artist_id(artist_url).ok_or("That doesn't look like a Spotify artist link.")?;
    let (client, token) = spotify_app_access(catalog).await?;
    let name = client
        .get(format!("https://api.spotify.com/v1/artists/{id}"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("Spotify artist lookup failed: {e}"))?
        .json::<ArtistObj>()
        .await
        .map(|a| a.name)
        .unwrap_or_default();
    let albums = fetch_all_artist_albums(&client, &token, &id).await?;
    Ok((name, albums))
}


fn setting(catalog: &Catalog, key: &str) -> Option<String> {
    catalog.get_setting(key).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn urlencode(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => o.push(b as char),
            b' ' => o.push_str("%20"),
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}

fn query_param(target: &str, key: &str) -> Option<String> {
    let q = target.split_once('?')?.1;
    let q = q.split_whitespace().next().unwrap_or(q); // drop trailing " HTTP/1.1"
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(percent_decode(v));
            }
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(n) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(n as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}
