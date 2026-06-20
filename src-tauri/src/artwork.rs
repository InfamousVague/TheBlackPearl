//! Poster + ratings lookup with on-disk caching for a local artwork library.
//! OMDb returns IMDb and Rotten Tomatoes scores plus a poster in one call;
//! TMDB is a poster-only fallback (handled by the `enrich` module).

use std::path::Path;

use anyhow::Result;
use serde::Deserialize;

pub struct Artwork {
    pub poster_url: Option<String>,
    pub imdb_rating: Option<f64>,
    pub rt_rating: Option<i64>,
    pub genre: Option<String>,
    pub plot: Option<String>,
    pub year: Option<i64>,
}

#[derive(Deserialize)]
struct OmdbResp {
    #[serde(rename = "Response")]
    response: String,
    #[serde(rename = "Year")]
    year: Option<String>,
    #[serde(rename = "Poster")]
    poster: Option<String>,
    #[serde(rename = "imdbRating")]
    imdb_rating: Option<String>,
    #[serde(rename = "Genre")]
    genre: Option<String>,
    #[serde(rename = "Plot")]
    plot: Option<String>,
    #[serde(rename = "Ratings", default)]
    ratings: Vec<OmdbRating>,
}

#[derive(Deserialize)]
struct OmdbRating {
    #[serde(rename = "Source")]
    source: String,
    #[serde(rename = "Value")]
    value: String,
}

fn clean(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty() && v != "N/A")
}

/// Look up a title on OMDb. `kind` maps to OMDb's `type` (movie/series) when known.
pub async fn omdb_lookup(
    client: &reqwest::Client,
    key: &str,
    title: &str,
    year: Option<i64>,
    kind: Option<&str>,
) -> Result<Option<Artwork>> {
    let title = title.trim();
    if title.is_empty() {
        return Ok(None);
    }
    let mut q: Vec<(&str, String)> = vec![
        ("apikey", key.to_string()),
        ("t", title.to_string()),
        ("plot", "short".to_string()),
    ];
    if let Some(y) = year {
        q.push(("y", y.to_string()));
    }
    match kind {
        Some("movie") => q.push(("type", "movie".to_string())),
        Some("show") => q.push(("type", "series".to_string())),
        _ => {}
    }
    let resp: OmdbResp = client
        .get("https://www.omdbapi.com/")
        .query(&q)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if resp.response != "True" {
        return Ok(None);
    }
    let rt_rating = resp
        .ratings
        .iter()
        .find(|r| r.source == "Rotten Tomatoes")
        .and_then(|r| r.value.trim_end_matches('%').parse::<i64>().ok());
    let imdb_rating = clean(resp.imdb_rating).and_then(|v| v.parse::<f64>().ok());
    let year = clean(resp.year)
        .as_deref()
        .and_then(|y| y.get(0..4))
        .and_then(|y| y.parse::<i64>().ok());
    Ok(Some(Artwork {
        poster_url: clean(resp.poster),
        imdb_rating,
        rt_rating,
        genre: clean(resp.genre),
        plot: clean(resp.plot),
        year,
    }))
}

/// Download a remote poster into the local artwork cache (`dir/<id>`), so the
/// library renders from disk and survives the source going away. Returns true
/// on a successful, non-trivial write.
pub async fn cache_image(client: &reqwest::Client, url: &str, dir: &Path, id: &str) -> Result<bool> {
    let bytes = client
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    if bytes.len() < 512 {
        return Ok(false); // placeholder / 1px error image
    }
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(id), &bytes)?;
    Ok(true)
}
