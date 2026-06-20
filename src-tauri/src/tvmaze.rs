//! Keyless TV metadata via TVMaze — the authoritative season/episode catalog the
//! series finder browses. No API key. The user then searches their torrent sources
//! for the episodes/seasons that actually exist.

use anyhow::Result;
use serde::{Deserialize, Serialize};

// ---- raw TVMaze shapes ----

#[derive(Deserialize)]
struct SearchHit {
    show: ShowRaw,
}
#[derive(Deserialize)]
struct ShowRaw {
    id: i64,
    name: String,
    premiered: Option<String>,
    image: Option<Image>,
    summary: Option<String>,
    network: Option<Network>,
    #[serde(rename = "webChannel")]
    web_channel: Option<Network>,
    #[serde(default)]
    genres: Vec<String>,
}
#[derive(Deserialize)]
struct Image {
    medium: Option<String>,
    original: Option<String>,
}
#[derive(Deserialize)]
struct Network {
    name: Option<String>,
}
#[derive(Deserialize)]
struct EpisodeRaw {
    season: i64,
    number: Option<i64>,
    name: Option<String>,
    airdate: Option<String>,
}

// ---- wire types (camelCase to TS) ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TvShow {
    pub id: i64,
    pub name: String,
    pub year: Option<i64>,
    pub poster: Option<String>,
    pub network: Option<String>,
    pub genres: Vec<String>,
    pub summary: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TvEpisode {
    pub season: i64,
    pub number: i64,
    pub name: String,
    pub airdate: Option<String>,
}

fn strip_html(s: &str) -> String {
    let no_tags = regex::Regex::new(r"<[^>]*>")
        .map(|re| re.replace_all(s, "").into_owned())
        .unwrap_or_else(|_| s.to_string());
    no_tags.replace("&amp;", "&").replace("&#39;", "'").trim().to_string()
}

/// Search TVMaze for shows matching `query`. Keyless.
pub async fn search_shows(client: &reqwest::Client, query: &str) -> Result<Vec<TvShow>> {
    let hits: Vec<SearchHit> = client
        .get("https://api.tvmaze.com/search/shows")
        .query(&[("q", query)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(hits
        .into_iter()
        .map(|h| {
            let s = h.show;
            TvShow {
                id: s.id,
                name: s.name,
                year: s.premiered.as_deref().and_then(|d| d.get(0..4)).and_then(|y| y.parse().ok()),
                poster: s.image.and_then(|i| i.original.or(i.medium)),
                network: s.network.or(s.web_channel).and_then(|n| n.name),
                genres: s.genres,
                summary: s.summary.as_deref().map(strip_html).filter(|x| !x.is_empty()),
            }
        })
        .collect())
}

/// Every episode of a show, in order. Keyless.
pub async fn episodes(client: &reqwest::Client, show_id: i64) -> Result<Vec<TvEpisode>> {
    let raw: Vec<EpisodeRaw> = client
        .get(format!("https://api.tvmaze.com/shows/{show_id}/episodes"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(raw
        .into_iter()
        .filter_map(|e| {
            e.number.map(|n| TvEpisode {
                season: e.season,
                number: n,
                name: e.name.unwrap_or_default(),
                airdate: e.airdate.filter(|d| !d.is_empty()),
            })
        })
        .collect())
}
