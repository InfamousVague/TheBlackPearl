//! Probe the keyless poster scraper against real IMDb/iTunes with messy release
//! names. Run: cargo run --example poster_probe

use ghosty_lib::posters;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()?;

    let titles = [
        "Project Hail Mary (2026) [1080p] [WEBRip] [5.1]",
        "Rick and Morty S09E03 Rick Fu Hustle 1080p AMZN WEB-DL DDP5",
        "Spider-Noir.S01.Complete.1080p.WEBRip.10Bit.DDP5.1.x265-NeoN",
        "Mortal Kombat II (2026) [REPACK] [1080p] [WEBRip] [x265]",
        "Obsession.2026.1080p.TELESYNC.x264-UNiON",
        "The.Matrix.1999.1080p.BluRay.x265-RARBG",
        "Daft Punk - Discovery FLAC",
    ];

    for raw in titles {
        let year = posters::year_from_title(raw);
        let kind = posters::guess_kind(raw);
        let clean = posters::clean_for_query(raw, kind);
        let poster = posters::find_poster(&client, &clean, year, kind, None, None).await;
        println!(
            "{raw}\n   clean={clean:?} year={year:?} kind={kind} ->\n   {}\n",
            poster.unwrap_or_else(|| "NO POSTER".into())
        );
    }
    Ok(())
}
