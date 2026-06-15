//! Source providers: turn a configured source URL into a list of CatalogItems.
//! - "scraper" / "adapter": fetch the page and regex out every magnet: link.
//! - "torznab": query the standardized Torznab/Newznab XML API (rich seeders/size).

use std::collections::HashSet;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::catalog::CatalogItem;

/// The Pirate Bay's canonical JSON API. Its mirror sites (thepiratebay.org/.bond/…) are
/// JavaScript front-ends with no server-rendered listings — they fetch from here — so any
/// TPB mirror URL is made to work by falling back to apibay.
const APIBAY: &str = "https://apibay.org";

/// Does this URL point at a Pirate Bay mirror (so the apibay JSON API is the real source)?
fn is_tpb(url: &str) -> bool {
    let u = url.to_lowercase();
    u.contains("piratebay") || u.contains("apibay") || u.contains("thepiratebay")
}

pub async fn run_source(kind: &str, url: &str, source_name: &str, now_ms: i64) -> Result<Vec<CatalogItem>> {
    match kind {
        "torznab" => torznab(url, source_name, now_ms).await,
        // The Pirate Bay — either architecture (modern apibay JSON, or original-source
        // server-rendered results table).
        "adapter" => adapter_source(url, source_name, now_ms).await,
        // Manual-verification sources (Cloudflare / "I'm not a robot") can't be fetched
        // server-side — they're indexed by importing from the embedded browser instead.
        "webview" => Ok(Vec::new()),
        // Generic: detect apibay JSON / TPB table / loose magnet links in whatever's fetched.
        _ => {
            let body = http_get(url).await?;
            Ok(parse_body(&body, source_name, now_ms))
        }
    }
}

async fn http_get(url: &str) -> Result<String> {
    let client = reqwest::Client::builder()
        .user_agent("BlackPearl/0.1 (+https://github.com/)")
        .timeout(Duration::from_secs(25))
        .build()?;
    let resp = client.get(url).send().await.context("request failed")?;
    anyhow::ensure!(resp.status().is_success(), "HTTP {}", resp.status());
    Ok(resp.text().await?)
}

// ---- source self-test (diagnostics for the "Test source" button) ----

/// Per-source diagnostic: what the source returned and why it did or didn't work.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTest {
    /// True if the full pipeline (incl. fallbacks) found at least one torrent.
    pub ok: bool,
    pub item_count: usize,
    pub elapsed_ms: u64,
    /// HTTP status of the configured URL itself (None if the request never completed).
    pub http_status: Option<u16>,
    /// Where the configured URL ended up after redirects.
    pub final_url: Option<String>,
    pub bytes: usize,
    /// Detected response shape of the configured URL (apibay JSON / HTML / Cloudflare / …).
    pub format: String,
    /// A few result titles, as proof the parse worked.
    pub sample: Vec<String>,
    /// Plain-language next step when something's wrong.
    pub hint: Option<String>,
    /// Top-level pipeline error, if the whole fetch failed.
    pub error: Option<String>,
}

/// Classify a fetched body so the test can explain *why* parsing did/didn't yield results.
fn classify_body(body: &str) -> &'static str {
    if try_apibay(body, "", 0).is_some() {
        return "apibay JSON";
    }
    if body.contains("magnet:?xt=") {
        return "magnet links";
    }
    let head = body.get(..body.len().min(6000)).unwrap_or(body).to_lowercase();
    if head.contains("just a moment") || head.contains("cf-browser-verification") || head.contains("challenge-platform") {
        return "Cloudflare bot check";
    }
    if head.contains("table-list") {
        return "1337x results table";
    }
    if head.contains("detname") || head.contains("/torrent/") {
        return "TPB results table";
    }
    if head.contains("<html") || head.contains("<!doctype") {
        return "HTML page (no listings)";
    }
    if body.trim().is_empty() {
        return "empty response";
    }
    "unrecognized"
}

fn test_hint(url: &str, status: Option<u16>, format: &str, count: usize, error: Option<&str>) -> Option<String> {
    if count > 0 {
        return None;
    }
    if let Some(e) = error {
        let el = e.to_lowercase();
        if el.contains("dns") || el.contains("connect") || el.contains("error sending request") || el.contains("timed out") {
            return Some("Couldn't reach the host — check the URL, your connection, or VPN/DNS.".to_string());
        }
        if el.contains("redirect") || el.contains("302") {
            return Some("The host bounced the request through redirects — the mirror may be parked or blocking.".to_string());
        }
    }
    if format.contains("Cloudflare") {
        return Some("Behind a Cloudflare bot check — it can't be scraped directly. Add it as a 'Verified browser' source and import via the embedded browser, or use a different mirror.".to_string());
    }
    if is_tpb(url) {
        return Some("This Pirate Bay mirror is a JavaScript front-end with no server-side listings; its data comes from apibay.org, which the app now uses automatically. If it still shows 0, apibay.org may be down right now.".to_string());
    }
    if matches!(status, Some(s) if s >= 400) {
        return Some(format!("The host returned HTTP {} — the URL or endpoint may have moved.", status.unwrap_or(0)));
    }
    Some("Reachable, but no magnets were found in the response — the mirror may have changed format or be empty.".to_string())
}

/// Probe a source and report exactly what happened — backs the "Test source" button.
pub async fn test_source(kind: &str, url: &str, source_name: &str, now: i64) -> SourceTest {
    let start = Instant::now();

    // 1) Probe the configured URL directly for HTTP-level diagnostics.
    let ua = if is_1337x(url) {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
    } else {
        "BlackPearl/0.1 (+https://github.com/)"
    };
    let (http_status, final_url, bytes, format) = match reqwest::Client::builder()
        .user_agent(ua)
        .timeout(Duration::from_secs(20))
        .build()
    {
        Ok(client) => match client.get(url).send().await {
            Ok(resp) => {
                let st = resp.status().as_u16();
                let fu = resp.url().to_string();
                let body = resp.text().await.unwrap_or_default();
                (Some(st), Some(fu), body.len(), classify_body(&body).to_string())
            }
            Err(e) => (None, None, 0, format!("request failed: {e}")),
        },
        Err(e) => (None, None, 0, format!("client error: {e}")),
    };

    // 2) Run the real pipeline (with all fallbacks) for the authoritative result.
    let (item_count, sample, error) = match run_source(kind, url, source_name, now).await {
        Ok(items) => (
            items.len(),
            items.iter().take(6).map(|i| i.title.clone()).collect(),
            None,
        ),
        Err(e) => (0, Vec::new(), Some(format!("{e:#}"))),
    };

    let hint = test_hint(url, http_status, &format, item_count, error.as_deref());

    SourceTest {
        ok: item_count > 0,
        item_count,
        elapsed_ms: start.elapsed().as_millis() as u64,
        http_status,
        final_url,
        bytes,
        format,
        sample,
        hint,
        error,
    }
}

// ---- The Pirate Bay adapter (handles both architectures) ----

/// Fetch the URL and let `parse_body` detect the format. For a bare host that returns
/// no results, try the common browse endpoints (modern apibay JSON, then original-source
/// `/top/all` and `/recent`) so just pasting the site root works.
async fn adapter_source(url: &str, source_name: &str, now: i64) -> Result<Vec<CatalogItem>> {
    if is_1337x(url) {
        return x1337_browse(url, source_name, now).await;
    }
    let body = http_get(url).await?;
    let items = parse_body(&body, source_name, now);
    if !items.is_empty() {
        return Ok(items);
    }
    let is_bare = !["q.php", "?", "/search/", "/browse/", "/top/", "/recent", ".json"]
        .iter()
        .any(|m| url.contains(m));
    if is_bare {
        let base = url.trim_end_matches('/');
        for path in ["/q.php?q=top100:all", "/top/all", "/recent"] {
            if let Ok(b) = http_get(&format!("{base}{path}")).await {
                let r = parse_body(&b, source_name, now);
                if !r.is_empty() {
                    return Ok(r);
                }
            }
        }
    }
    // Last resort for TPB mirrors: their data is served by apibay.org, not the mirror itself.
    if is_tpb(url) {
        for endpoint in [
            "/precompiled/data_top100_200.json", // top 100 video
            "/q.php?q=category:200",
        ] {
            if let Ok(b) = http_get(&format!("{APIBAY}{endpoint}")).await {
                let r = parse_body(&b, source_name, now);
                if !r.is_empty() {
                    return Ok(r);
                }
            }
        }
    }
    Ok(items)
}

/// Detect the response format: apibay JSON, server-rendered TPB table, or loose magnets.
/// Public so the browser-import command can run it over webview-rendered HTML.
pub fn parse_body(body: &str, source_name: &str, now: i64) -> Vec<CatalogItem> {
    if let Some(items) = try_apibay(body, source_name, now) {
        return items;
    }
    if body.contains("searchResult") {
        let rows = parse_tpb_html(body, source_name, now);
        if !rows.is_empty() {
            return rows;
        }
    }
    extract_magnets(body, source_name, now)
}

/// Parse a server-rendered Pirate Bay `#searchResult` table into rich items.
/// Each row carries the magnet, a `/browse/<cat>` link, and three right-aligned
/// cells: size, seeders, leechers.
fn parse_tpb_html(body: &str, source_name: &str, now: i64) -> Vec<CatalogItem> {
    let table = body
        .split_once("searchResult")
        .map(|(_, rest)| rest.split_once("</table>").map(|(t, _)| t).unwrap_or(rest))
        .unwrap_or(body);
    let magnet_re = regex::Regex::new(r#"magnet:\?[^\s"'<>\\)]+"#).unwrap();
    let right_re = regex::Regex::new(r#"align="right">\s*([^<]+?)\s*</td>"#).unwrap();
    let cat_re = regex::Regex::new(r#"/browse/(\d+)"#).unwrap();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for row in table.split("<tr") {
        let magnet = match magnet_re.find(row) {
            Some(m) => html_unescape(m.as_str()),
            None => continue,
        };
        let id = match infohash(&magnet) {
            Some(h) => h,
            None => continue,
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let title = magnet_dn(&magnet).unwrap_or_else(|| id.clone());
        let rights: Vec<String> = right_re
            .captures_iter(row)
            .map(|c| c[1].replace("&nbsp;", " ").replace('\u{a0}', " "))
            .collect();
        let size_bytes = rights.first().map(|s| parse_size(s)).unwrap_or(0);
        let seeders = rights.get(1).and_then(|s| s.replace(',', "").trim().parse().ok()).unwrap_or(0);
        let leechers = rights.get(2).and_then(|s| s.replace(',', "").trim().parse().ok()).unwrap_or(0);
        let category = cat_re
            .captures(row)
            .map(|c| apibay_category(&c[1]))
            .unwrap_or_else(|| guess_category(&title));
        let year = guess_year(&title);
        out.push(CatalogItem {
            id,
            category,
            title,
            magnet,
            size_bytes,
            seeders,
            leechers,
            source: source_name.to_string(),
            added_at: now,
            files: None,
            poster: None,
            description: None,
            year,
        });
    }
    out
}

/// "6.07 GiB" → bytes.
fn parse_size(s: &str) -> i64 {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 2 {
        return 0;
    }
    let n: f64 = parts[0].replace(',', "").parse().unwrap_or(0.0);
    let mult = match parts[1].to_ascii_uppercase().as_str() {
        "KIB" | "KB" => 1024.0,
        "MIB" | "MB" => 1024f64.powi(2),
        "GIB" | "GB" => 1024f64.powi(3),
        "TIB" | "TB" => 1024f64.powi(4),
        _ => 1.0,
    };
    (n * mult) as i64
}

/// apibay's `q.php` returns every field as a string ("seeders":"42"), but its precompiled
/// `data_top100_*.json` returns numbers ("seeders":42). Accept either so both endpoints parse.
fn de_str_or_num<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum V {
        S(String),
        I(i64),
        F(f64),
    }
    Ok(match V::deserialize(d)? {
        V::S(s) => s,
        V::I(i) => i.to_string(),
        V::F(f) => (f as i64).to_string(),
    })
}

#[derive(serde::Deserialize)]
struct ApibayItem {
    name: String,
    info_hash: String,
    #[serde(default, deserialize_with = "de_str_or_num")]
    seeders: String,
    #[serde(default, deserialize_with = "de_str_or_num")]
    leechers: String,
    #[serde(default, deserialize_with = "de_str_or_num")]
    size: String,
    #[serde(default, deserialize_with = "de_str_or_num")]
    category: String,
    #[serde(default, deserialize_with = "de_str_or_num")]
    num_files: String,
    #[serde(default, deserialize_with = "de_str_or_num")]
    added: String,
}

/// Parse an apibay JSON array into catalog items. Returns None if the body isn't apibay JSON.
fn try_apibay(body: &str, source_name: &str, now: i64) -> Option<Vec<CatalogItem>> {
    let trimmed = body.trim_start();
    if !trimmed.starts_with('[') {
        return None;
    }
    let rows: Vec<ApibayItem> = serde_json::from_str(trimmed).ok()?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for r in rows {
        let id = r.info_hash.to_ascii_lowercase();
        // skip the "No results returned" sentinel (all-zero infohash) and malformed rows
        if id.len() != 40 || id.bytes().all(|b| b == b'0') {
            continue;
        }
        if !seen.insert(id.clone()) {
            continue;
        }
        let added_at = r.added.parse::<i64>().map(|s| s * 1000).unwrap_or(now);
        let year = guess_year(&r.name);
        out.push(CatalogItem {
            category: apibay_category(&r.category),
            magnet: build_magnet(&id, &r.name),
            id,
            title: r.name,
            size_bytes: r.size.parse().unwrap_or(0),
            seeders: r.seeders.parse().unwrap_or(0),
            leechers: r.leechers.parse().unwrap_or(0),
            source: source_name.to_string(),
            added_at,
            files: r.num_files.parse().ok(),
            poster: None,
            description: None,
            year,
        });
    }
    Some(out)
}

const APIBAY_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://explodie.org:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
];

fn build_magnet(infohash: &str, name: &str) -> String {
    let trackers: String = APIBAY_TRACKERS
        .iter()
        .map(|t| format!("&tr={}", urlencode(t)))
        .collect();
    format!("magnet:?xt=urn:btih:{infohash}&dn={}{trackers}", urlencode(name))
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Map TPB category numbers to Ghosty categories.
fn apibay_category(cat: &str) -> String {
    match cat.parse::<i64>().unwrap_or(0) {
        100..=199 => "audio",
        200..=299 => "video",
        601 | 602 => "books",
        _ => "other",
    }
    .to_string()
}

/// Pull every distinct magnet link out of arbitrary HTML.
fn extract_magnets(html: &str, source_name: &str, now: i64) -> Vec<CatalogItem> {
    let re = regex::Regex::new(r#"magnet:\?[^\s"'<>\\)]+"#).unwrap();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for m in re.find_iter(html) {
        let magnet = html_unescape(m.as_str());
        let id = match infohash(&magnet) {
            Some(h) => h,
            None => continue,
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let title = magnet_dn(&magnet).unwrap_or_else(|| id.clone());
        let year = guess_year(&title);
        out.push(CatalogItem {
            id,
            category: guess_category(&title),
            title,
            magnet,
            size_bytes: 0,
            seeders: 0,
            leechers: 0,
            source: source_name.to_string(),
            added_at: now,
            files: None,
            poster: None,
            description: None,
            year,
        });
    }
    out
}

async fn torznab(url: &str, source_name: &str, now: i64) -> Result<Vec<CatalogItem>> {
    let full = torznab_url(url, None);
    let body = http_get(&full).await?;
    Ok(parse_torznab(&body, source_name, now))
}

/// Build a Torznab request URL, optionally with a search query.
fn torznab_url(url: &str, query: Option<&str>) -> String {
    let mut u = url.to_string();
    if !u.contains("t=") {
        u.push_str(if u.contains('?') { "&t=search" } else { "?t=search" });
    }
    if let Some(q) = query {
        u.push_str(&format!("&q={}", urlencode(q)));
    }
    u
}

fn parse_torznab(body: &str, source_name: &str, now: i64) -> Vec<CatalogItem> {
    let doc = match roxmltree::Document::parse(body) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for item in doc.descendants().filter(|n| n.is_element() && n.tag_name().name() == "item") {
        let title = child_text(&item, "title").unwrap_or_default();
        let magnet = item
            .children()
            .find(|c| c.tag_name().name() == "enclosure")
            .and_then(|e| e.attribute("url").map(String::from))
            .or_else(|| child_text(&item, "link"))
            .filter(|u| u.starts_with("magnet:"));
        let magnet = match magnet {
            Some(m) => m,
            None => continue,
        };
        let id = match infohash(&magnet) {
            Some(h) => h,
            None => continue,
        };
        if !seen.insert(id.clone()) {
            continue;
        }

        let (mut seeders, mut leechers, mut size) = (0i64, 0i64, 0i64);
        for attr in item.children().filter(|c| c.tag_name().name() == "attr") {
            let name = attr.attribute("name").unwrap_or("");
            let val = attr.attribute("value").unwrap_or("");
            match name {
                "seeders" => seeders = val.parse().unwrap_or(0),
                "peers" | "leechers" => leechers = val.parse().unwrap_or(0),
                "size" => size = val.parse().unwrap_or(0),
                _ => {}
            }
        }
        if size == 0 {
            size = child_text(&item, "size").and_then(|s| s.parse().ok()).unwrap_or(0);
        }
        let year = guess_year(&title);
        out.push(CatalogItem {
            id,
            category: guess_category(&title),
            title,
            magnet,
            size_bytes: size,
            seeders,
            leechers,
            source: source_name.to_string(),
            added_at: now,
            files: None,
            poster: None,
            description: None,
            year,
        });
    }
    out
}

// ---- live search across a source ----

/// Query a single source for `query`. Tries the source's search endpoint (apibay
/// `q.php`, original-TPB `/search`, or Torznab), then falls back to fetching the
/// configured URL and filtering by title.
pub async fn search_source(
    kind: &str,
    url: &str,
    query: &str,
    source_name: &str,
    now: i64,
) -> Result<Vec<CatalogItem>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let enc = urlencode(q);

    if kind == "torznab" {
        let full = torznab_url(url, Some(q));
        if let Ok(body) = http_get(&full).await {
            return Ok(parse_torznab(&body, source_name, now));
        }
        return Ok(Vec::new());
    }

    if is_1337x(url) {
        return x1337_search(url, q, source_name, now).await;
    }

    // scraper / adapter: try the Pirate Bay search shapes. ALWAYS try the configured
    // host first — a self-hosted or DNS-proxied mirror (e.g. a legal-torrents fork) serves
    // the modern apibay JSON at its own /q.php, and we must prefer that over the public API.
    let host = base_host(url);
    let mut candidates = vec![
        format!("{host}/q.php?q={enc}"),       // modern apibay JSON (incl. self-hosted forks)
        format!("{host}/search/{enc}/1/99/0"), // original server-rendered
    ];
    // Last resort only: the real public TPB mirrors are JS front-ends with no server-side
    // API, so their data actually comes from apibay.org. Appended (not prepended) so it
    // never shadows the user's own host.
    if is_tpb(url) {
        candidates.push(format!("{APIBAY}/q.php?q={enc}"));
    }
    for c in &candidates {
        if let Ok(body) = http_get(c).await {
            let items = parse_body(&body, source_name, now);
            if !items.is_empty() {
                return Ok(items);
            }
        }
    }

    // Fallback: fetch the configured page and filter by title.
    if let Ok(body) = http_get(url).await {
        let ql = q.to_lowercase();
        let items = parse_body(&body, source_name, now)
            .into_iter()
            .filter(|i| i.title.to_lowercase().contains(&ql))
            .collect();
        return Ok(items);
    }
    Ok(Vec::new())
}

/// `scheme://host` with any path/query stripped.
fn base_host(url: &str) -> String {
    if let Some(i) = url.find("://") {
        let after = &url[i + 3..];
        let end = after.find('/').map(|j| i + 3 + j).unwrap_or(url.len());
        url[..end].to_string()
    } else {
        url.trim_end_matches('/').to_string()
    }
}

fn child_text(node: &roxmltree::Node, name: &str) -> Option<String> {
    node.children()
        .find(|c| c.tag_name().name() == name)
        .and_then(|c| c.text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// ---- shared magnet/title helpers ----

fn infohash(magnet: &str) -> Option<String> {
    let query = magnet.split_once('?')?.1;
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix("xt=urn:btih:"))
        .map(|h| h.to_ascii_lowercase())
        .filter(|h| h.len() == 40 || h.len() == 32)
}

fn magnet_dn(magnet: &str) -> Option<String> {
    let query = magnet.split_once('?')?.1;
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix("dn="))
        .map(percent_decode)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(v) => {
                    out.push(v);
                    i += 3;
                }
                Err(_) => {
                    out.push(bytes[i]);
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&").replace("&#38;", "&").replace("&#x26;", "&")
}

fn guess_category(title: &str) -> String {
    let t = title.to_lowercase();
    let has = |kws: &[&str]| kws.iter().any(|k| t.contains(k));
    if has(&["1080p", "720p", "2160p", "4k", "x264", "x265", "hevc", "bluray", "bdrip", "webrip", "web-dl", "hdtv", ".mkv", ".mp4", ".avi", "movie"]) {
        "video"
    } else if has(&["flac", "mp3", "album", "audiobook", "discography", "ost", ".m4a", "320kbps"]) {
        "audio"
    } else if has(&["epub", "mobi", ".pdf", "ebook", "azw3", "audiobook"]) {
        "books"
    } else if has(&["dataset", "imagenet", ".csv", "corpus", "mnist"]) {
        "data"
    } else {
        "other"
    }
    .to_string()
}

// ---- 1337x adapter ----
// 1337x mirrors serve a server-rendered results table, but magnets live only on
// each torrent's detail page — so this is a two-step scrape (list → detail pages).
// Some "gateway" domains (e.g. 1337x.tw) only link out to the real mirror, so we
// fall back to a known-good host when the configured one yields nothing.

const X1337_FALLBACK: &str = "https://www.1377x.to";

fn is_1337x(url: &str) -> bool {
    let u = url.to_lowercase();
    u.contains("1337x") || u.contains("1377x")
}

/// Candidate origins to scrape: the user's own host first (so a working mirror they
/// pasted is used directly), then the known-good fallback.
fn x1337_origins(url: &str) -> Vec<String> {
    let mut v = Vec::new();
    let origin = base_host(url);
    if origin.starts_with("http") && is_1337x(&origin) {
        v.push(origin);
    }
    if !v.iter().any(|o| o.contains("1377x.to")) {
        v.push(X1337_FALLBACK.to_string());
    }
    v
}

/// Fetch with a browser UA — 1337x serves a stub to unknown clients.
async fn x1337_get(url: &str) -> Result<String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15")
        .timeout(Duration::from_secs(25))
        .build()?;
    let resp = client.get(url).send().await.context("request failed")?;
    anyhow::ensure!(resp.status().is_success(), "HTTP {}", resp.status());
    Ok(resp.text().await?)
}

/// Encode a query for a 1337x search path: spaces → "+", others percent-encoded.
fn x1337_query(q: &str) -> String {
    let mut s = String::new();
    for ch in q.trim().chars() {
        match ch {
            ' ' => s.push('+'),
            c if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') => s.push(c),
            c => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).bytes() {
                    s.push_str(&format!("%{b:02X}"));
                }
            }
        }
    }
    s
}

struct X1337Row {
    path: String,
    title: String,
    seeders: i64,
    leechers: i64,
    size_bytes: i64,
}

/// Parse a 1337x results/listing table into rows (magnets resolved separately).
fn parse_1337x_list(body: &str) -> Vec<X1337Row> {
    let table = body
        .split_once("table-list")
        .map(|(_, rest)| rest.split_once("</table>").map(|(t, _)| t).unwrap_or(rest))
        .unwrap_or(body);
    let name_re = regex::Regex::new(r#"href="(/torrent/\d+/[^"]+/)"[^>]*>([^<]+)</a>"#).unwrap();
    let seed_re = regex::Regex::new(r#"coll-2 seeds[^>]*>\s*([\d,]+)"#).unwrap();
    let leech_re = regex::Regex::new(r#"coll-3 leeches[^>]*>\s*([\d,]+)"#).unwrap();
    let size_re = regex::Regex::new(r#"coll-\d+ size[^>]*>\s*([\d.,]+\s*[KMGT]i?B)"#).unwrap();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for row in table.split("<tr>") {
        let Some(c) = name_re.captures(row) else {
            continue;
        };
        let path = c[1].to_string();
        if !seen.insert(path.clone()) {
            continue;
        }
        let title = html_unescape(c[2].trim());
        let seeders = seed_re
            .captures(row)
            .and_then(|m| m[1].replace(',', "").parse().ok())
            .unwrap_or(0);
        let leechers = leech_re
            .captures(row)
            .and_then(|m| m[1].replace(',', "").parse().ok())
            .unwrap_or(0);
        let size_bytes = size_re.captures(row).map(|m| parse_size(m[1].trim())).unwrap_or(0);
        out.push(X1337Row { path, title, seeders, leechers, size_bytes });
    }
    out
}

async fn x1337_search(url: &str, query: &str, source_name: &str, now: i64) -> Result<Vec<CatalogItem>> {
    let enc = x1337_query(query);
    for origin in x1337_origins(url) {
        let list_url = format!("{origin}/sort-search/{enc}/seeders/desc/1/");
        if let Ok(body) = x1337_get(&list_url).await {
            let rows = parse_1337x_list(&body);
            if !rows.is_empty() {
                return x1337_resolve(&origin, rows, source_name, now).await;
            }
        }
    }
    Ok(Vec::new())
}

/// Browse/refresh: 1337x has no magnets without a query, so pull its trending/top list.
async fn x1337_browse(url: &str, source_name: &str, now: i64) -> Result<Vec<CatalogItem>> {
    for origin in x1337_origins(url) {
        for path in ["/trending/", "/top-100"] {
            if let Ok(body) = x1337_get(&format!("{origin}{path}")).await {
                let rows = parse_1337x_list(&body);
                if !rows.is_empty() {
                    return x1337_resolve(&origin, rows, source_name, now).await;
                }
            }
        }
    }
    Ok(Vec::new())
}

/// Fetch each row's detail page (capped concurrency) and pull out its magnet.
async fn x1337_resolve(
    origin: &str,
    rows: Vec<X1337Row>,
    source_name: &str,
    now: i64,
) -> Result<Vec<CatalogItem>> {
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(6));
    let mut set = tokio::task::JoinSet::new();
    for row in rows.into_iter().take(30) {
        let origin = origin.to_string();
        let source = source_name.to_string();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok()?;
            let body = x1337_get(&format!("{origin}{}", row.path)).await.ok()?;
            let magnet_re = regex::Regex::new(r#"magnet:\?[^\s"'<>]+"#).ok()?;
            let magnet = html_unescape(magnet_re.find(&body)?.as_str().trim());
            let id = infohash(&magnet)?;
            Some(CatalogItem {
                id,
                category: guess_category(&row.title),
                size_bytes: row.size_bytes,
                seeders: row.seeders,
                leechers: row.leechers,
                year: guess_year(&row.title),
                source,
                added_at: now,
                files: None,
                poster: None,
                description: None,
                magnet,
                title: row.title,
            })
        });
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    while let Some(res) = set.join_next().await {
        if let Ok(Some(item)) = res {
            if seen.insert(item.id.clone()) {
                out.push(item);
            }
        }
    }
    out.sort_by(|a, b| b.seeders.cmp(&a.seeders));
    Ok(out)
}

fn guess_year(title: &str) -> Option<i64> {
    let re = regex::Regex::new(r"(19|20)\d{2}").ok()?;
    re.find(title)?.as_str().parse().ok()
}
