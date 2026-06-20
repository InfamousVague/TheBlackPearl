//! Social P2P (P1.2) — the client half of GhostWire's Soulseek-style friend network.
//!
//! The companion coordination server (`https://ghostwire.tv/social` by default) is a pure
//! address-book + signaling relay: it stores identities (Ed25519 public keys ↔ handles), the
//! follow graph, and abuse reports — and routes live presence + friend-to-friend search/browse
//! requests. It NEVER sees content, magnets, or transfers. Everything a friend actually
//! downloads moves peer-to-peer over BitTorrent via the engine. This keeps the "we don't host
//! user content" posture intact.
//!
//! Identity is a local Ed25519 keypair (no passwords). The secret key is persisted 0600 in the
//! app data dir; auth is challenge/response. A persistent WebSocket carries presence and the
//! friend search/browse routing — when a friend searches us we answer ONLY from the items we
//! DELIBERATELY shared with our connections (via [`Engine::seeding_shares`]); plain downloaded
//! torrents that are merely seeding back to the public swarm are never advertised to friends.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::RwLock;
use tokio_tungstenite::tungstenite::Message;

use crate::engine::Engine;

/// Default public endpoint (path-based behind Caddy on the GhostWire VPS).
pub const DEFAULT_BASE_URL: &str = "https://ghostwire.tv/social";

/// One advertised share, mirroring the server's `ShareItem` protocol shape.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShareItem {
    infohash: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size_bytes: Option<u64>,
    /// Music tags so the peer resolves the exact album cover instead of guessing from the name.
    #[serde(skip_serializing_if = "Option::is_none")]
    artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    /// Socket addresses to dial directly so the swarm negotiates without waiting on DHT.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    peers: Vec<String>,
}

/// What we persist between launches so the identity (and last server/handle) survive.
#[derive(Serialize, Deserialize, Default)]
struct StoredIdentity {
    /// base64url(no-pad) of the 32-byte Ed25519 secret key.
    secret_b64: String,
    handle: Option<String>,
    base_url: Option<String>,
}

/// Live, mutable connection state.
#[derive(Default)]
struct Live {
    base_url: Option<String>,
    handle: Option<String>,
    token: Option<String>,
    /// Sender into the active WebSocket writer task (None when disconnected).
    tx: Option<UnboundedSender<String>>,
    connected: bool,
}

struct Inner {
    id_path: PathBuf,
    http: reqwest::Client,
    signing: SigningKey,
    pubkey_b64: String,
    state: RwLock<Live>,
}

/// Tauri-managed handle to the social client. Cheap to clone (just an `Arc`).
#[derive(Clone)]
pub struct Social {
    inner: Arc<Inner>,
}

/// Snapshot returned to the frontend for status / identity queries.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SocialStatus {
    pub pubkey: String,
    pub handle: Option<String>,
    pub base_url: String,
    pub registered: bool,
    pub connected: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FriendPresence {
    pub handle: String,
    pub online: bool,
}

impl Social {
    /// Load (or first-time generate) the identity from `data_dir/social-identity.json`.
    pub fn load(data_dir: &str) -> Self {
        let id_path = PathBuf::from(data_dir).join("social-identity.json");
        let http = reqwest::Client::builder()
            .user_agent("GhostWire-Social/1")
            .build()
            .unwrap_or_default();

        let (signing, stored) = match load_stored(&id_path) {
            Some(stored) => match decode_secret(&stored.secret_b64) {
                Some(signing) => (signing, stored),
                None => fresh_identity(),
            },
            None => fresh_identity(),
        };

        let pubkey_b64 = B64.encode(signing.verifying_key().to_bytes());
        let live = Live {
            base_url: stored.base_url.clone(),
            handle: stored.handle.clone(),
            ..Default::default()
        };

        let inner = Arc::new(Inner {
            id_path,
            http,
            signing,
            pubkey_b64,
            state: RwLock::new(live),
        });

        // Persist immediately if this is a brand-new identity (no file yet).
        if !inner.id_path.exists() {
            let _ = persist(&inner.id_path, &inner.signing, &stored.handle, &stored.base_url);
        }
        Self { inner }
    }

    fn base_url(&self, live: &Live) -> String {
        live.base_url
            .clone()
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
    }

    pub async fn status(&self) -> SocialStatus {
        let live = self.inner.state.read().await;
        SocialStatus {
            pubkey: self.inner.pubkey_b64.clone(),
            handle: live.handle.clone(),
            base_url: self.base_url(&live),
            registered: live.handle.is_some(),
            connected: live.connected,
        }
    }

    /// Register a brand-new handle for this identity, then connect.
    pub async fn register(&self, app: &AppHandle, base_url: &str, handle: &str) -> Result<()> {
        let base = normalize_base(base_url);
        let msg = format!("register:{handle}:{}", self.inner.pubkey_b64);
        let sig = self.sign(msg.as_bytes());
        let body = json!({ "handle": handle, "pubkey": self.inner.pubkey_b64, "sig": sig });
        let resp = self
            .inner
            .http
            .post(format!("{base}/v1/register"))
            .json(&body)
            .send()
            .await
            .context("register request failed")?;
        // A 409 means this key already claimed a handle on the server (e.g. a prior attempt
        // succeeded but the follow-up sign-in failed). That's not an error for us — just fall
        // through and sign in with the existing identity.
        if !resp.status().is_success() && resp.status() != reqwest::StatusCode::CONFLICT {
            return Err(anyhow!(error_text("register", resp).await));
        }
        {
            let mut live = self.inner.state.write().await;
            live.base_url = Some(base.clone());
            live.handle = Some(handle.to_string());
            live.token = None;
        }
        self.persist_identity().await;
        self.login(app, &base).await
    }

    /// Authenticate an existing identity (challenge/response) and open the live socket.
    pub async fn login(&self, app: &AppHandle, base_url: &str) -> Result<()> {
        let base = normalize_base(base_url);
        let token = self.fetch_token(&base).await?;
        {
            let mut live = self.inner.state.write().await;
            live.base_url = Some(base.clone());
            live.token = Some(token);
        }
        self.persist_identity().await;
        self.inner.clone().connect(app.clone()).await
    }

    /// Best-effort reconnect on launch if we already have a handle + server on file.
    pub async fn autostart(&self, app: &AppHandle) {
        let base = {
            let live = self.inner.state.read().await;
            if live.handle.is_none() {
                return;
            }
            self.base_url(&live)
        };
        if let Err(e) = self.login(app, &base).await {
            eprintln!("[social] autostart failed: {e:#}");
        }
    }

    pub async fn disconnect(&self) {
        let mut live = self.inner.state.write().await;
        live.tx = None;
        live.connected = false;
    }

    pub async fn following(&self) -> Result<Vec<FriendPresence>> {
        self.list("following").await
    }
    pub async fn followers(&self) -> Result<Vec<FriendPresence>> {
        self.list("followers").await
    }
    pub async fn friends(&self) -> Result<Vec<FriendPresence>> {
        self.list("friends").await
    }

    pub async fn follow(&self, handle: &str) -> Result<()> {
        self.post_json("/v1/follow", json!({ "handle": handle })).await
    }
    pub async fn unfollow(&self, handle: &str) -> Result<()> {
        self.post_json("/v1/unfollow", json!({ "handle": handle })).await
    }
    pub async fn report(&self, handle: &str, infohash: Option<&str>, reason: &str) -> Result<()> {
        self.post_json(
            "/v1/report",
            json!({ "handle": handle, "infohash": infohash, "reason": reason }),
        )
        .await
    }

    /// Send a search to all online friends. Hits arrive asynchronously as
    /// `social://search-hit` events; returns the request id used to correlate them.
    pub async fn search(&self, query: &str) -> Result<String> {
        let id = rand_id();
        self.ws_send(json!({ "t": "search", "id": id, "query": query }))
            .await?;
        Ok(id)
    }

    /// Browse a single friend's whole share list (arrives as `social://browse-result`).
    pub async fn browse(&self, handle: &str) -> Result<String> {
        let id = rand_id();
        self.ws_send(json!({ "t": "browse", "id": id, "handle": handle }))
            .await?;
        Ok(id)
    }

    // ---- internals ----

    fn sign(&self, msg: &[u8]) -> String {
        B64.encode(self.inner.signing.sign(msg).to_bytes())
    }

    async fn persist_identity(&self) {
        let (handle, base_url) = {
            let live = self.inner.state.read().await;
            (live.handle.clone(), live.base_url.clone())
        };
        let _ = persist(&self.inner.id_path, &self.inner.signing, &handle, &base_url);
    }

    async fn fetch_token(&self, base: &str) -> Result<String> {
        // 1) ask for a challenge nonce.
        let resp = self
            .inner
            .http
            .post(format!("{base}/v1/auth/challenge"))
            .json(&json!({ "pubkey": self.inner.pubkey_b64 }))
            .send()
            .await
            .context("challenge request failed")?;
        if !resp.status().is_success() {
            return Err(anyhow!(error_text("challenge", resp).await));
        }
        let v: Value = resp.json().await.context("bad challenge response")?;
        let nonce = v
            .get("nonce")
            .and_then(|x| x.as_str())
            .ok_or_else(|| anyhow!("challenge missing nonce"))?;
        // 2) Sign the nonce and exchange it for a bearer token. The server verifies the
        // signature over the nonce *string* bytes (the base64url text as UTF-8), so we sign
        // exactly those bytes — NOT the decoded nonce.
        let sig = self.sign(nonce.as_bytes());
        let resp = self
            .inner
            .http
            .post(format!("{base}/v1/auth/verify"))
            .json(&json!({ "pubkey": self.inner.pubkey_b64, "nonce": nonce, "sig": sig }))
            .send()
            .await
            .context("verify request failed")?;
        if !resp.status().is_success() {
            return Err(anyhow!(error_text("verify", resp).await));
        }
        let v: Value = resp.json().await.context("bad verify response")?;
        v.get("token")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("verify missing token"))
    }

    async fn auth_ctx(&self) -> Result<(String, String)> {
        let live = self.inner.state.read().await;
        let base = self.base_url(&live);
        let token = live
            .token
            .clone()
            .ok_or_else(|| anyhow!("not signed in to the social network yet"))?;
        Ok((base, token))
    }

    async fn list(&self, which: &str) -> Result<Vec<FriendPresence>> {
        let (base, token) = self.auth_ctx().await?;
        let resp = self
            .inner
            .http
            .get(format!("{base}/v1/me/{which}"))
            .bearer_auth(token)
            .send()
            .await
            .with_context(|| format!("{which} request failed"))?;
        if !resp.status().is_success() {
            return Err(anyhow!(error_text(which, resp).await));
        }
        // The server wraps the array as `{ "users": [...] }`.
        #[derive(Deserialize)]
        struct UserList {
            #[serde(default)]
            users: Vec<FriendPresence>,
        }
        let parsed: UserList = resp
            .json()
            .await
            .with_context(|| format!("bad {which} response"))?;
        Ok(parsed.users)
    }

    async fn post_json(&self, path: &str, body: Value) -> Result<()> {
        let (base, token) = self.auth_ctx().await?;
        let resp = self
            .inner
            .http
            .post(format!("{base}{path}"))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("{path} request failed"))?;
        if !resp.status().is_success() {
            return Err(anyhow!(error_text(path, resp).await));
        }
        Ok(())
    }

    async fn ws_send(&self, msg: Value) -> Result<()> {
        let live = self.inner.state.read().await;
        let tx = live
            .tx
            .as_ref()
            .ok_or_else(|| anyhow!("not connected to the social network"))?;
        tx.send(msg.to_string())
            .map_err(|_| anyhow!("social connection closed"))
    }
}

impl Inner {
    /// Open the persistent WebSocket and spawn its reader/writer tasks.
    async fn connect(self: Arc<Self>, app: AppHandle) -> Result<()> {
        let (base, token) = {
            let live = self.state.read().await;
            let base = live
                .base_url
                .clone()
                .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
            let token = live
                .token
                .clone()
                .ok_or_else(|| anyhow!("no auth token — sign in first"))?;
            (base, token)
        };
        let ws_url = to_ws_url(&base, &token);
        let (stream, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .context("WebSocket connect failed")?;
        let (mut write, mut read) = stream.split();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        {
            let mut live = self.state.write().await;
            live.tx = Some(tx.clone());
            live.connected = true;
        }

        // Writer: drain outgoing messages (search/browse + our replies) onto the socket.
        tauri::async_runtime::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if write.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            let _ = write.close().await;
        });

        // Reader: surface server events to the UI and answer friend search/browse requests.
        let inner = self.clone();
        let app2 = app.clone();
        let tx2 = tx.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(next) = read.next().await {
                match next {
                    Ok(Message::Text(t)) => handle_incoming(&app2, &tx2, t.as_str()).await,
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            {
                let mut live = inner.state.write().await;
                live.connected = false;
                live.tx = None;
            }
            let _ = app2.emit("social://connected", json!({ "connected": false }));
        });

        let _ = app.emit("social://connected", json!({ "connected": true }));
        Ok(())
    }
}

/// Route one inbound server frame: emit UI events, or answer search/browse from our own seeds.
async fn handle_incoming(app: &AppHandle, tx: &UnboundedSender<String>, text: &str) {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return;
    };
    match v.get("t").and_then(|x| x.as_str()).unwrap_or("") {
        "ready" => {
            let _ = app.emit("social://ready", &v);
        }
        "presence" => {
            let _ = app.emit("social://presence", &v);
        }
        "search-hit" => {
            let _ = app.emit("social://search-hit", &v);
        }
        "search-end" => {
            let _ = app.emit("social://search-end", &v);
        }
        "browse-result" => {
            let _ = app.emit("social://browse-result", &v);
        }
        "follow" => {
            let _ = app.emit("social://follow", &v);
        }
        "unfollow" => {
            let _ = app.emit("social://unfollow", &v);
        }
        "friend" => {
            let _ = app.emit("social://friend", &v);
        }
        "error" => {
            eprintln!("[social] server error: {v}");
            let _ = app.emit("social://error", &v);
        }
        "search-req" => {
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let query = v.get("query").and_then(|x| x.as_str()).unwrap_or("");
            let items = shares_for(app, Some(query)).await;
            let _ = tx.send(json!({ "t": "search-resp", "id": id, "items": items }).to_string());
        }
        "browse-req" => {
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let items = shares_for(app, None).await;
            let _ = tx.send(json!({ "t": "browse-resp", "id": id, "items": items }).to_string());
        }
        _ => {}
    }
}

/// Build the share list answer from the items the user DELIBERATELY shared with their
/// connections (NOT every seeding torrent — downloads seeding back to the public swarm stay
/// private to the swarm and are never exposed to friends).
async fn shares_for(app: &AppHandle, query: Option<&str>) -> Vec<ShareItem> {
    let Some(engine) = app.try_state::<Engine>() else {
        return Vec::new();
    };
    // Correlate each seeding torrent with the rich, already-scanned library item (embedded
    // tags + clean title) keyed by file basename. This reuses the exact metadata the local
    // Downloads view shows, and resolves nested music paths that `share_meta` can't.
    let scanned = crate::cached_downloaded(app);
    let mut by_file: std::collections::HashMap<String, &crate::DownloadedItem> =
        std::collections::HashMap::with_capacity(scanned.len());
    for it in &scanned {
        by_file.entry(it.file_name.clone()).or_insert(it);
    }
    engine
        .seeding_shares(query)
        .await
        .into_iter()
        .map(|s| {
            let hit = by_file.get(s.name.as_str()).copied();
            let artist = s.artist.or_else(|| hit.and_then(|h| h.artist.clone()));
            let album = s.album.or_else(|| hit.and_then(|h| h.album.clone()));
            let title = s
                .track_title
                .or_else(|| hit.map(|h| h.title.clone()));
            ShareItem {
                infohash: s.infohash,
                name: s.name,
                category: s.category,
                media_type: s.media_type,
                size_bytes: s.size_bytes,
                artist,
                album,
                title,
                peers: s.peers,
            }
        })
        .collect()
}

// ---- free helpers ----

fn fresh_identity() -> (SigningKey, StoredIdentity) {
    let signing = SigningKey::generate(&mut rand::rngs::OsRng);
    (signing, StoredIdentity::default())
}

fn decode_secret(secret_b64: &str) -> Option<SigningKey> {
    let bytes = B64.decode(secret_b64).ok()?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    Some(SigningKey::from_bytes(&arr))
}

fn load_stored(path: &PathBuf) -> Option<StoredIdentity> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn persist(
    path: &PathBuf,
    signing: &SigningKey,
    handle: &Option<String>,
    base_url: &Option<String>,
) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    let stored = StoredIdentity {
        secret_b64: B64.encode(signing.to_bytes()),
        handle: handle.clone(),
        base_url: base_url.clone(),
    };
    let data = serde_json::to_vec_pretty(&stored)?;
    std::fs::write(path, &data)?;
    // The secret key is sensitive — lock it down to the owner (best-effort, unix only).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Strip a trailing slash so `{base}/v1/...` never doubles up.
fn normalize_base(base: &str) -> String {
    base.trim().trim_end_matches('/').to_string()
}

/// Derive the WebSocket URL from the REST base (http→ws, https→wss) + the bearer token.
fn to_ws_url(base: &str, token: &str) -> String {
    let scheme = if base.starts_with("https://") {
        base.replacen("https://", "wss://", 1)
    } else if base.starts_with("http://") {
        base.replacen("http://", "ws://", 1)
    } else {
        format!("wss://{base}")
    };
    format!(
        "{}/v1/ws?token={}",
        scheme.trim_end_matches('/'),
        urlencode(token)
    )
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn rand_id() -> String {
    let mut buf = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut buf);
    B64.encode(buf)
}

async fn error_text(label: &str, resp: reqwest::Response) -> String {
    let code = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
        .unwrap_or_else(|| body.chars().take(200).collect());
    if detail.is_empty() {
        format!("{label} failed ({code})")
    } else {
        format!("{label} failed ({code}): {detail}")
    }
}
