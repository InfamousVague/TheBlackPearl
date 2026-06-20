//! Probe the real indexer against a URL. Run:
//!   cargo run --example scrape_probe -- "https://webtorrent.io/free-torrents" scraper

use ghosty_lib::indexer::run_source;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "https://webtorrent.io/free-torrents".to_string());
    let kind = std::env::args().nth(2).unwrap_or_else(|| "scraper".to_string());

    println!("[scrape] {kind} <- {url}");
    let items = run_source(&kind, &url, "probe", 0).await?;
    println!("[scrape] found {} items", items.len());
    for it in items.iter().take(20) {
        let short = &it.id[..8.min(it.id.len())];
        println!(
            "  [{short}] {:<45} cat={:<8} seeders={} size={}",
            truncate(&it.title, 45),
            it.category,
            it.seeders,
            it.size_bytes
        );
    }
    Ok(())
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n - 1).collect::<String>())
    }
}
