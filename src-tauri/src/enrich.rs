//! Optional metadata enrichment via TMDB (posters, overviews, year).
//! Inert unless the user stores a TMDB API key in settings.

use anyhow::Result;
use serde::Deserialize;

#[derive(Deserialize)]
struct SearchResp {
    results: Vec<Movie>,
}

#[derive(Deserialize)]
struct Movie {
    poster_path: Option<String>,
    overview: Option<String>,
    release_date: Option<String>,
}

pub struct Enriched {
    pub poster: Option<String>,
    pub description: Option<String>,
    pub year: Option<i64>,
}

pub async fn enrich_title(client: &reqwest::Client, key: &str, title: &str) -> Result<Option<Enriched>> {
    let query = clean_title(title);
    if query.is_empty() {
        return Ok(None);
    }
    let resp: SearchResp = client
        .get("https://api.themoviedb.org/3/search/movie")
        .query(&[("api_key", key), ("query", &query)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let Some(m) = resp.results.into_iter().next() else {
        return Ok(None);
    };
    let poster = m
        .poster_path
        .filter(|p| !p.is_empty())
        .map(|p| format!("https://image.tmdb.org/t/p/w500{p}"));
    let year = m
        .release_date
        .as_deref()
        .and_then(|d| d.get(0..4))
        .and_then(|y| y.parse::<i64>().ok());
    let description = m.overview.filter(|s| !s.is_empty());
    Ok(Some(Enriched {
        poster,
        description,
        year,
    }))
}

/// Year-filtered TMDB poster for a movie or show. Keyed. Uses the /tv endpoint
/// for shows and the matching year param so the right title wins.
pub async fn tmdb_poster(
    client: &reqwest::Client,
    key: &str,
    title: &str,
    year: Option<i64>,
    kind: &str,
) -> Result<Option<String>> {
    let query = clean_title(title);
    if query.is_empty() {
        return Ok(None);
    }
    let endpoint = if kind == "show" { "tv" } else { "movie" };
    let mut q: Vec<(&str, String)> = vec![("api_key", key.to_string()), ("query", query)];
    if let Some(y) = year {
        q.push((if kind == "show" { "first_air_date_year" } else { "year" }, y.to_string()));
    }
    let resp: SearchResp = client
        .get(format!("https://api.themoviedb.org/3/search/{endpoint}"))
        .query(&q)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp.results.into_iter().find_map(|m| {
        m.poster_path
            .filter(|p| !p.is_empty())
            .map(|p| format!("https://image.tmdb.org/t/p/w500{p}"))
    }))
}

/// Strip release group / quality / year noise so the title matches TMDB.
pub fn clean_title(title: &str) -> String {
    let mut t = title.replace(['.', '_'], " ");
    // cut at the first year or quality marker
    for marker in ["(", "1080p", "720p", "2160p", "4k", "x264", "x265", "bluray", "web", "hdtv"] {
        if let Some(pos) = t.to_lowercase().find(marker) {
            t.truncate(pos);
        }
    }
    // also cut at a 4-digit year
    if let Some(caps) = regex::Regex::new(r"\b(19|20)\d{2}\b").ok().and_then(|re| re.find(&t).map(|m| m.start())) {
        t.truncate(caps);
    }
    t.trim().trim_end_matches('-').trim().to_string()
}
