//! Validate the Spotify embed-scrape fallback against live pages. Mirrors the
//! exact extraction logic in spotify.rs. Run:
//!   cargo run --example spotify_embed_probe -- 37i9dQZF1DXcBWIGoYBM5M 6UlPSckAdkoRLMxYkQRFPU

fn find_key<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    match v {
        serde_json::Value::Object(m) => {
            if let Some(f) = m.get(key) {
                return Some(f);
            }
            m.values().find_map(|vv| find_key(vv, key))
        }
        serde_json::Value::Array(a) => a.iter().find_map(|vv| find_key(vv, key)),
        _ => None,
    }
}

async fn probe(client: &reqwest::Client, id: &str) -> Result<(String, usize, Vec<String>), String> {
    let html = client
        .get(format!("https://open.spotify.com/embed/playlist/{id}"))
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15")
        .send().await.map_err(|e| e.to_string())?
        .text().await.map_err(|e| e.to_string())?;
    let marker = html.find("__NEXT_DATA__").ok_or("not public (no __NEXT_DATA__)")?;
    let js = html[marker..].find('>').map(|i| marker + i + 1).ok_or("parse error")?;
    let je = html[js..].find("</script>").map(|i| js + i).ok_or("parse error")?;
    let data: serde_json::Value = serde_json::from_str(html[js..je].trim()).map_err(|e| e.to_string())?;
    let list = find_key(&data, "trackList").and_then(|v| v.as_array()).ok_or("not public (no trackList)")?;
    let name = find_key(&data, "name").and_then(|v| v.as_str()).unwrap_or("Playlist").to_string();
    let sample: Vec<String> = list.iter().take(3)
        .map(|t| format!("{} — {}", t.get("title").and_then(|v| v.as_str()).unwrap_or("?"), t.get("subtitle").and_then(|v| v.as_str()).unwrap_or("?")))
        .collect();
    Ok((name, list.len(), sample))
}

#[tokio::main]
async fn main() {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build().unwrap();
    let ids: Vec<String> = std::env::args().skip(1).collect();
    let ids = if ids.is_empty() { vec!["37i9dQZF1DXcBWIGoYBM5M".to_string()] } else { ids };
    for id in ids {
        match probe(&client, &id).await {
            Ok((name, n, sample)) => {
                println!("[{id}] OK  name={name:?}  tracks={n}");
                for s in sample { println!("    {s}"); }
            }
            Err(e) => println!("[{id}] graceful error: {e}"),
        }
    }
}
