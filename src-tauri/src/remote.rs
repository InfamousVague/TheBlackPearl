//! Primitives for LAN device-linking: stable device identity, HMAC-signed bearer/stream
//! tokens, and the short-lived PIN pairing handshake. The HTTP surface that uses these
//! lives in `engine.rs` (it needs the axum `ServerState`); this module is just the
//! crypto + identity helpers so they're easy to test and reason about in isolation.
//!
//! Security model (home-LAN scope): the Mac (host) binds the server to the LAN. Requests
//! from `127.0.0.1` are trusted (the desktop app itself); LAN requests must carry a valid
//! HMAC token. Initial trust is bootstrapped by a 6-digit PIN the Mac displays and the
//! iPad enters. Tokens are stateless (signed `exp` + HMAC); revoke-all = rotate the secret.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::RwLock;

use crate::catalog::Catalog;

/// Stable per-install identity, persisted in the `settings` table.
#[derive(Clone)]
pub struct DeviceIdentity {
    pub id: String,
    pub name: String,
    /// HMAC key for signing tokens. Rotating this invalidates every issued token.
    pub secret: String,
}

/// Read identity from settings, generating + persisting any missing piece on first run.
pub fn ensure_device_identity(catalog: &Catalog) -> DeviceIdentity {
    let id = catalog.get_setting("device_id").unwrap_or_else(|| {
        let v = random_hex(16);
        let _ = catalog.set_setting("device_id", &v);
        v
    });
    let name = catalog
        .get_setting("device_name")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            let v = host_name();
            let _ = catalog.set_setting("device_name", &v);
            v
        });
    let secret = catalog.get_setting("pairing_secret").unwrap_or_else(|| {
        let v = random_hex(32);
        let _ = catalog.set_setting("pairing_secret", &v);
        v
    });
    DeviceIdentity { id, name, secret }
}

/// A friendly machine name for the host. The Mac is the one that advertises a name; on
/// macOS prefer the user-set "Computer Name" (e.g. "Matt's iMac").
fn host_name() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("scutil")
            .args(["--get", "ComputerName"])
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return s;
                }
            }
        }
    }
    std::env::var("HOSTNAME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "GhostWire".to_string())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `bytes` random bytes, lowercase hex.
pub fn random_hex(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// A 6-digit pairing PIN.
pub fn gen_pin() -> String {
    use rand::Rng;
    format!("{:06}", rand::thread_rng().gen_range(0..1_000_000))
}

/// Best-effort LAN IP of this host (for showing "connect to <ip>:port" on the Mac). Opens a
/// UDP socket toward a public address to learn which local interface routes outward — no
/// packets are actually sent.
pub fn local_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

/// HMAC-SHA256 (RFC 2104) using the `sha2` crate already in the tree — avoids pulling an
/// extra `hmac` dependency.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= block[i];
        opad[i] ^= block[i];
    }
    let inner = {
        let mut h = Sha256::new();
        h.update(ipad);
        h.update(msg);
        h.finalize()
    };
    let mut h = Sha256::new();
    h.update(opad);
    h.update(inner);
    h.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Constant-time-ish string compare (avoids early-exit timing leak on the signature).
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// Mint a stateless token valid for `ttl_secs`. Format: `<exp>.<hmac_hex(secret, exp)>`.
pub fn mint_token(secret: &str, ttl_secs: u64) -> String {
    let exp = now_secs() + ttl_secs;
    let sig = hex(&hmac_sha256(secret.as_bytes(), exp.to_string().as_bytes()));
    format!("{exp}.{sig}")
}

/// Verify a token minted by [`mint_token`]: signature matches and not expired.
pub fn verify_token(secret: &str, token: &str) -> bool {
    let Some((exp_str, sig)) = token.split_once('.') else {
        return false;
    };
    let Ok(exp) = exp_str.parse::<u64>() else {
        return false;
    };
    if exp < now_secs() {
        return false;
    }
    let expected = hex(&hmac_sha256(secret.as_bytes(), exp_str.as_bytes()));
    ct_eq(&expected, sig)
}

/// Token lifetimes.
pub const BEARER_TTL_SECS: u64 = 365 * 24 * 3600; // pairing token: ~1 year
pub const STREAM_TTL_SECS: u64 = 12 * 3600; // playback URL token: 12 hours
pub const PIN_TTL_SECS: u64 = 300; // pairing PIN: 5 minutes

/// A pending PIN pairing offer (set by the host, consumed on first successful pair).
pub struct PendingPair {
    pub pin: String,
    pub expires: u64,
}

/// Shared, mutable pairing slot — written by the `pairing_pin` Tauri command, read by the
/// `/api/pair` HTTP handler. `None` = no pairing currently offered.
pub type Pairing = Arc<RwLock<Option<PendingPair>>>;

pub fn new_pairing() -> Pairing {
    Arc::new(RwLock::new(None))
}

/// Set a fresh PIN offer and return it (for the host UI to display).
pub async fn offer_pin(pairing: &Pairing) -> String {
    let pin = gen_pin();
    *pairing.write().await = Some(PendingPair {
        pin: pin.clone(),
        expires: now_secs() + PIN_TTL_SECS,
    });
    pin
}

/// Check a submitted PIN against the current offer; consume it on success.
pub async fn consume_pin(pairing: &Pairing, submitted: &str) -> bool {
    let mut slot = pairing.write().await;
    match slot.as_ref() {
        Some(p) if p.expires >= now_secs() && ct_eq(&p.pin, submitted) => {
            *slot = None; // one-time use
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_roundtrip() {
        let s = random_hex(32);
        let t = mint_token(&s, 60);
        assert!(verify_token(&s, &t));
        assert!(!verify_token("wrong-secret", &t));
        assert!(!verify_token(&s, "garbage"));
        // expired
        let exp = now_secs() - 10;
        let sig = hex(&hmac_sha256(s.as_bytes(), exp.to_string().as_bytes()));
        assert!(!verify_token(&s, &format!("{exp}.{sig}")));
    }
}
