//! Opt-in peer-to-peer (BitTorrent) self-update.
//!
//! The update bundle is pulled over BitTorrent via the app's own torrent engine instead of HTTP,
//! then **verified against the exact same minisign signature the HTTP updater uses** before it's
//! handed to Tauri's platform installer. A torrent swarm is untrusted, so the signature — never the
//! transport — is what makes a peer-delivered binary safe to run; tampered bytes fail verification
//! and are never installed.
//!
//! Any failure here (no magnet in the manifest, no peers, download/verify error) returns an `Err`
//! so the caller transparently falls back to the normal HTTP updater. With the opt-in setting off,
//! this path is never taken and update behaviour is byte-for-byte the HTTP path.

use anyhow::{anyhow, Context, Result};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

/// Verify `data` against the announced minisign `signature` using `pub_key`. Mirrors
/// `tauri-plugin-updater`'s own `verify_signature` (same `minisign-verify` crate + base64 framing)
/// so a torrent-delivered bundle is gated identically to an HTTP one.
fn verify_signature(data: &[u8], signature: &str, pub_key: &str) -> Result<()> {
    use base64::Engine as _;
    let unb64 = |s: &str| -> Result<String> {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(s)
            .context("base64 decode")?;
        String::from_utf8(raw).context("utf8")
    };
    let public_key = minisign_verify::PublicKey::decode(&unb64(pub_key)?)
        .map_err(|e| anyhow!("decode pubkey: {e}"))?;
    let sig = minisign_verify::Signature::decode(&unb64(signature)?)
        .map_err(|e| anyhow!("decode signature: {e}"))?;
    public_key
        .verify(data, &sig, true)
        .map_err(|e| anyhow!("signature verification failed: {e}"))?;
    Ok(())
}

/// The minisign pubkey the HTTP updater is configured with (tauri.conf.json
/// `plugins.updater.pubkey`). Read from the embedded app config so it can never drift.
fn updater_pubkey(app: &tauri::AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")?
        .get("pubkey")?
        .as_str()
        .map(|s| s.to_string())
}

/// Pull this platform's update magnet out of the manifest JSON the updater already fetched.
/// `raw_json` may be either the matched per-platform object (`{signature,url,magnet}`) or the full
/// manifest (`{platforms:{<target>:{…}}}`), so try both shapes.
fn magnet_from_manifest(raw: &serde_json::Value, target: &str) -> Option<String> {
    if let Some(m) = raw.get("magnet").and_then(|v| v.as_str()) {
        return Some(m.to_string());
    }
    raw.get("platforms")?
        .get(target)?
        .get("magnet")?
        .as_str()
        .map(|s| s.to_string())
}

/// Attempt a P2P self-update.
/// - `Ok(true)`  → an update was downloaded, **verified**, and installed; the caller should relaunch.
/// - `Ok(false)` → already up to date.
/// - `Err(_)`    → fall back to the HTTP updater.
pub async fn try_p2p_update(app: tauri::AppHandle) -> Result<bool> {
    // Use the real (HTTPS) manifest to learn whether an update exists + its signature/magnet.
    let updater = app.updater().context("build updater")?;
    let Some(update) = updater.check().await.context("check for update")? else {
        return Ok(false);
    };

    let magnet = magnet_from_manifest(&update.raw_json, &update.target)
        .ok_or_else(|| anyhow!("no torrent magnet in manifest for {}", update.target))?;
    let pubkey = updater_pubkey(&app).ok_or_else(|| anyhow!("updater pubkey missing from config"))?;

    // Pull the bundle over BitTorrent into a temp dir, out of the Downloads queue.
    let tmp = std::env::temp_dir().join(format!("ghostwire-ota-{}", update.version));
    let engine = crate::engine_state(&app).map_err(|e| anyhow!(e))?;
    let bundle = engine
        .download_to_path(&magnet, &tmp)
        .await
        .context("download update over BitTorrent")?;
    let bytes = std::fs::read(&bundle).with_context(|| format!("read {bundle:?}"))?;

    // SECURITY GATE: the swarm is untrusted — only install bytes that match the signed release.
    verify_signature(&bytes, &update.signature, &pubkey)
        .context("verify P2P-downloaded update")?;

    // Hand the verified bytes to Tauri's platform installer (same code path the HTTP updater uses).
    update.install(&bytes).context("install update")?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(true)
}

// ---------------------------------------------------------------------------
// Opt-in seeding: help distribute the latest GhostWire build to other users.
// ---------------------------------------------------------------------------

/// Infohash of the app-update bundle currently being seeded (so we can stop it on opt-out).
fn ota_seed_slot() -> &'static Mutex<Option<String>> {
    static S: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// The Tauri updater platform key for this build (matches `latest.json` `platforms` keys).
fn current_target() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))] { return "darwin-aarch64"; }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))] { return "darwin-x86_64"; }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))] { return "windows-x86_64"; }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))] { return "windows-aarch64"; }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))] { return "linux-x86_64"; }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))] { return "linux-aarch64"; }
    #[allow(unreachable_code)] { "unknown" }
}

fn updater_endpoint(app: &tauri::AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")?
        .get("endpoints")?
        .as_array()?
        .first()?
        .as_str()
        .map(|s| s.to_string())
}

/// Fetch `latest.json` directly (no version gate) and read the magnet for THIS platform — so we can
/// seed the latest build even when we're already on it (where the updater's `check()` returns None).
async fn latest_magnet(app: &tauri::AppHandle) -> Result<(String, String)> {
    let url = updater_endpoint(app).ok_or_else(|| anyhow!("no updater endpoint configured"))?;
    let body = reqwest::get(&url)
        .await
        .context("fetch manifest")?
        .error_for_status()
        .context("manifest status")?
        .text()
        .await
        .context("read manifest")?;
    let v: serde_json::Value = serde_json::from_str(&body).context("parse manifest")?;
    let version = v.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let target = current_target();
    let magnet = v
        .get("platforms")
        .and_then(|p| p.get(target))
        .and_then(|t| t.get("magnet"))
        .and_then(|m| m.as_str())
        .ok_or_else(|| anyhow!("no torrent magnet for {target} in manifest"))?
        .to_string();
    Ok((version, magnet))
}

/// Start seeding the latest GhostWire build (opt-in). Downloads the bundle once into `<data>/updates/`
/// and keeps it seeding. Returns the version being seeded. Idempotent.
pub async fn start_seeding_app(app: tauri::AppHandle) -> Result<String> {
    let (version, magnet) = latest_magnet(&app).await?;
    let data_dir = app
        .try_state::<crate::AppInfo>()
        .map(|i| i.data_dir.clone())
        .ok_or_else(|| anyhow!("app not ready"))?;
    let dir = std::path::PathBuf::from(data_dir).join("updates");
    let engine = crate::engine_state(&app).map_err(|e| anyhow!(e))?;
    let infohash = engine.seed_from_magnet(&magnet, &dir).await.context("seed app bundle")?;
    *ota_seed_slot().lock().unwrap_or_else(|p| p.into_inner()) = Some(infohash);
    Ok(version)
}

/// Stop seeding the app bundle (opt-out). Keeps the downloaded files.
pub async fn stop_seeding_app(app: tauri::AppHandle) -> Result<()> {
    let infohash = ota_seed_slot().lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(id) = infohash {
        if let Ok(engine) = crate::engine_state(&app) {
            engine.stop_seeding(&id).await.ok();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::verify_signature;

    /// The minisign pubkey the app ships with (tauri.conf.json `plugins.updater.pubkey`).
    fn config_pubkey() -> Option<String> {
        let conf = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json")).ok()?;
        let v: serde_json::Value = serde_json::from_str(&conf).ok()?;
        v.get("plugins")?.get("updater")?.get("pubkey")?.as_str().map(|s| s.to_string())
    }

    /// Exercises the real security gate against a locally-built signed bundle when one exists
    /// (skips cleanly otherwise, e.g. in CI): a genuine bundle verifies, a single flipped byte fails.
    #[test]
    fn verifies_real_bundle_and_rejects_tampering() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/target/release/bundle/macos");
        let bundle_path = format!("{dir}/GhostWire.app.tar.gz");
        let sig_path = format!("{bundle_path}.sig");
        let (Ok(bytes), Ok(sig_file), Some(pubkey)) = (
            std::fs::read(&bundle_path),
            std::fs::read_to_string(&sig_path),
            config_pubkey(),
        ) else {
            eprintln!("skipping: no locally-built signed bundle at {bundle_path}");
            return;
        };
        // The `.sig` file is itself base64 (the minisign signature text), and latest.json carries
        // that content verbatim — so use it as-is, exactly as the updater receives it.
        let signature = sig_file.trim().to_string();

        // A genuine bundle must verify.
        verify_signature(&bytes, &signature, &pubkey).expect("real signed bundle should verify");

        // Flipping a single byte (a tampered peer payload) must be rejected.
        let mut tampered = bytes.clone();
        tampered[bytes.len() / 2] ^= 0xFF;
        assert!(
            verify_signature(&tampered, &signature, &pubkey).is_err(),
            "tampered bundle must fail signature verification"
        );
    }
}
