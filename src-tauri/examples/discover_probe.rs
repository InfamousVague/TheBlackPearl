//! Probe TV discovery against live sources. Run:
//!   cargo run --example discover_probe                 # IMDb chart only (keyless)
//!   cargo run --example discover_probe -- TMDB_KEY     # + TMDB trending

use ghosty_lib::discover;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15")
        .timeout(std::time::Duration::from_secs(20))
        .build()?;

    let tmdb = std::env::args().nth(1);
    let shows = discover::popular_shows(&client, tmdb.as_deref(), None, None).await;
    println!("[discover] {} popular shows", shows.len());
    for s in shows.iter().take(20) {
        println!(
            "  {:<40} {} poster={} sources={:?}",
            s.title.chars().take(40).collect::<String>(),
            s.year.map(|y| y.to_string()).unwrap_or_else(|| "----".into()),
            if s.poster.is_some() { "yes" } else { "no " },
            s.sources,
        );
    }
    Ok(())
}
