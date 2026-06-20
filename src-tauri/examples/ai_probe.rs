//! Probe the local Ollama title parser against the real daemon. Run:
//!   cargo run --example ai_probe
//!   cargo run --example ai_probe -- "Some.Release.2021.1080p.BluRay.x265-GRP"

use ghosty_lib::ai;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()?;

    let status = ai::status(&client).await;
    println!("[ai] available={} model={:?}", status.available, status.model);
    println!("[ai] installed: {:?}", status.models);
    let Some(model) = status.model.clone() else {
        println!("[ai] no model installed — nothing to parse");
        return Ok(());
    };

    let titles: Vec<String> = {
        let extra = std::env::args().nth(1);
        match extra {
            Some(t) => vec![t],
            None => vec![
                "The.Matrix.1999.1080p.BluRay.x265-RARBG".into(),
                "Big Buck Bunny (2008) [1080p] WEBRip".into(),
                "Breaking.Bad.S03E07.720p.HDTV.x264-IMMERSE".into(),
                "Ubuntu 24.04 LTS Desktop amd64 ISO".into(),
                "Backrooms 2026 720p VOSTFR HDTS x264-FS".into(),
            ],
        }
    };

    for raw in &titles {
        match ai::parse_title(&client, &model, raw).await {
            Ok(p) => println!(
                "  {raw}\n    -> title={:?} year={:?} kind={:?} S{:?}E{:?} quality={:?} codec={:?} lang={:?} genres={:?}",
                p.title, p.year, p.kind, p.season, p.episode, p.quality, p.codec, p.language, p.genres
            ),
            Err(e) => println!("  {raw}\n    -> ERROR: {e}"),
        }
    }
    Ok(())
}
