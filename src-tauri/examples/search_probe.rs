//! Probe the live per-source search. Run:
//!   cargo run --example search_probe -- "https://thepiratebay.bond" "scooby doo" adapter

use ghosty_lib::indexer::search_source;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = std::env::args().nth(1).unwrap_or_else(|| "https://thepiratebay.bond".into());
    let query = std::env::args().nth(2).unwrap_or_else(|| "scooby doo".into());
    let kind = std::env::args().nth(3).unwrap_or_else(|| "adapter".into());

    println!("[search] kind={kind} url={url} query={query:?}");
    let items = search_source(&kind, &url, &query, "probe", 0).await?;
    println!("[search] {} results", items.len());
    for it in items.iter().take(12) {
        let t: String = it.title.chars().take(50).collect();
        println!("  {t:<50} seeders={} size={} cat={}", it.seeders, it.size_bytes, it.category);
    }
    Ok(())
}
