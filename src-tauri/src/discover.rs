//! TV-show discovery + AI season compilation.
//! - `popular_shows`: merge popular/trending TV from TMDB, Trakt and IMDb's chart
//!   (whichever are available), dedupe, enrich posters + IMDb/RT ratings.
//! - `compile_seasons`: for a chosen show, resolve the real season list from TMDB
//!   (ground truth), search every linked source, then bucket the magnets by season
//!   so each season is one click to stream — the "AI agent" the user asked for.

use std::collections::HashMap;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::catalog::{Catalog, CatalogItem};
use crate::{artwork, indexer, posters};

// ============================ popular shows ============================

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Show {
    pub title: String,
    pub year: Option<i64>,
    pub poster: Option<String>,
    pub overview: Option<String>,
    pub imdb_rating: Option<f64>,
    pub rt_rating: Option<i64>,
    pub tmdb_id: Option<i64>,
    /// Which providers surfaced this show (for transparency).
    pub sources: Vec<String>,
}

fn norm(t: &str) -> String {
    t.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Gather popular TV from every available source, merge by title, enrich top hits.
pub async fn popular_shows(
    client: &reqwest::Client,
    tmdb_key: Option<&str>,
    trakt_key: Option<&str>,
    omdb_key: Option<&str>,
) -> Vec<Show> {
    let mut merged: Vec<Show> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    let mut add = |shows: Vec<Show>| {
        for s in shows {
            let key = norm(&s.title);
            if key.is_empty() {
                continue;
            }
            if let Some(&i) = index.get(&key) {
                let e: &mut Show = &mut merged[i];
                for src in s.sources {
                    if !e.sources.contains(&src) {
                        e.sources.push(src);
                    }
                }
                e.poster = e.poster.take().or(s.poster);
                e.overview = e.overview.take().or(s.overview);
                e.year = e.year.or(s.year);
                e.tmdb_id = e.tmdb_id.or(s.tmdb_id);
            } else {
                index.insert(key, merged.len());
                merged.push(s);
            }
        }
    };

    if let Some(k) = tmdb_key {
        if let Ok(v) = tmdb_trending(client, k).await {
            add(v);
        }
    }
    if let Some(k) = trakt_key {
        if let Ok(v) = trakt_trending(client, k).await {
            add(v);
        }
    }
    // NOTE: IMDb blocks server-side requests (same anti-bot as Cloudflare sites),
    // so we can't scrape its chart here — IMDb instead contributes per-show *ratings*
    // via OMDb in the enrichment pass below.

    // Rank: shows surfaced by more providers first, then keep source order.
    merged.sort_by(|a, b| b.sources.len().cmp(&a.sources.len()));
    merged.truncate(40);

    // Enrich the top of the list with posters (if missing) + IMDb/RT ratings.
    for s in merged.iter_mut().take(30) {
        if s.poster.is_none() {
            s.poster = posters::find_poster(client, &s.title, s.year, "show", tmdb_key, omdb_key).await;
        }
        if let Some(ok) = omdb_key {
            if s.imdb_rating.is_none() {
                if let Ok(Some(a)) = artwork::omdb_lookup(client, ok, &s.title, s.year, Some("show")).await {
                    s.imdb_rating = a.imdb_rating;
                    s.rt_rating = a.rt_rating;
                    if s.overview.is_none() {
                        s.overview = a.plot;
                    }
                    s.year = s.year.or(a.year);
                }
            }
        }
    }
    merged
}

#[derive(Deserialize)]
struct TmdbTrending {
    #[serde(default)]
    results: Vec<TmdbShow>,
}
#[derive(Deserialize)]
struct TmdbShow {
    id: i64,
    #[serde(default)]
    name: String,
    poster_path: Option<String>,
    overview: Option<String>,
    first_air_date: Option<String>,
    vote_average: Option<f64>,
}

async fn tmdb_trending(client: &reqwest::Client, key: &str) -> Result<Vec<Show>> {
    let resp: TmdbTrending = client
        .get("https://api.themoviedb.org/3/trending/tv/week")
        .query(&[("api_key", key)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp
        .results
        .into_iter()
        .filter(|s| !s.name.is_empty())
        .map(|s| Show {
            year: s.first_air_date.as_deref().and_then(|d| d.get(0..4)).and_then(|y| y.parse().ok()),
            poster: s.poster_path.filter(|p| !p.is_empty()).map(|p| format!("https://image.tmdb.org/t/p/w500{p}")),
            overview: s.overview.filter(|o| !o.is_empty()),
            imdb_rating: s.vote_average.filter(|v| *v > 0.0),
            tmdb_id: Some(s.id),
            title: s.name,
            rt_rating: None,
            sources: vec!["TMDB".to_string()],
        })
        .collect())
}

#[derive(Deserialize)]
struct TraktTrending {
    show: TraktShow,
}
#[derive(Deserialize)]
struct TraktShow {
    title: String,
    year: Option<i64>,
    ids: TraktIds,
}
#[derive(Deserialize)]
struct TraktIds {
    tmdb: Option<i64>,
}

async fn trakt_trending(client: &reqwest::Client, key: &str) -> Result<Vec<Show>> {
    let rows: Vec<TraktTrending> = client
        .get("https://api.trakt.tv/shows/trending")
        .query(&[("limit", "30")])
        .header("trakt-api-version", "2")
        .header("trakt-api-key", key)
        .header("Content-Type", "application/json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| Show {
            title: r.show.title,
            year: r.show.year,
            tmdb_id: r.show.ids.tmdb,
            sources: vec!["Trakt".to_string()],
            ..Default::default()
        })
        .collect())
}

// ============================ season compilation ============================

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeasonPack {
    pub season: i64,
    pub label: String,
    /// Real episode count from TMDB, when known (ground truth for the UI).
    pub episode_count: Option<i64>,
    /// Best (most-seeded) season-pack magnet for this season, if found.
    pub best: Option<CatalogItem>,
    /// Other candidates (packs + individual episodes), seeders-sorted.
    pub alternatives: Vec<CatalogItem>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Compilation {
    pub show: String,
    pub year: Option<i64>,
    pub total_seasons: Option<i64>,
    pub seasons: Vec<SeasonPack>,
    /// Complete-series / multi-season packs.
    pub complete: Vec<CatalogItem>,
    /// True when source results were classified against a real TMDB season list.
    pub grounded: bool,
}

struct SeasonHit {
    season: Option<i64>,
    is_complete: bool,
    is_episode: bool,
}

/// Detect which season a release title refers to (and whether it's a full pack,
/// a complete-series pack, or a single episode).
fn detect_season(title: &str) -> SeasonHit {
    let t = title.to_lowercase();
    let complete = regex::Regex::new(r"complete|all\s+seasons|s0?1\s*-\s*s?\d|seasons?\s*1\s*-\s*\d").unwrap();
    let is_complete = complete.is_match(&t);
    // SxxEyy or NxNN → single episode
    let ep = regex::Regex::new(r"(?i)\bs(\d{1,2})\s*e(\d{1,3})\b|\b(\d{1,2})x(\d{2})\b").unwrap();
    if let Some(c) = ep.captures(&t) {
        let s = c.get(1).or(c.get(3)).and_then(|m| m.as_str().parse().ok());
        return SeasonHit { season: s, is_complete, is_episode: true };
    }
    // "S03" / "season 3" → season pack
    let se = regex::Regex::new(r"(?i)\bs(\d{1,2})\b|\bseason\s*(\d{1,2})\b").unwrap();
    if let Some(c) = se.captures(&t) {
        let s = c.get(1).or(c.get(2)).and_then(|m| m.as_str().parse().ok());
        return SeasonHit { season: s, is_complete, is_episode: false };
    }
    SeasonHit { season: None, is_complete, is_episode: false }
}

#[derive(Deserialize)]
struct TmdbSearchTv {
    #[serde(default)]
    results: Vec<TmdbTvHit>,
}
#[derive(Deserialize)]
struct TmdbTvHit {
    id: i64,
}
#[derive(Deserialize)]
struct TmdbTvDetail {
    number_of_seasons: Option<i64>,
    #[serde(default)]
    seasons: Vec<TmdbSeason>,
}
#[derive(Deserialize)]
struct TmdbSeason {
    season_number: i64,
    episode_count: Option<i64>,
}

/// Ground-truth season list for a show via TMDB: (total_seasons, [(season, episodes)]).
async fn tmdb_seasons(
    client: &reqwest::Client,
    key: &str,
    title: &str,
    year: Option<i64>,
) -> Option<(i64, Vec<(i64, Option<i64>)>)> {
    let mut q: Vec<(&str, String)> = vec![("api_key", key.to_string()), ("query", title.to_string())];
    if let Some(y) = year {
        q.push(("first_air_date_year", y.to_string()));
    }
    let search: TmdbSearchTv = client
        .get("https://api.themoviedb.org/3/search/tv")
        .query(&q)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let hit = search.results.into_iter().next()?;
    let detail: TmdbTvDetail = client
        .get(format!("https://api.themoviedb.org/3/tv/{}", hit.id))
        .query(&[("api_key", key)])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let total = detail.number_of_seasons.unwrap_or(0);
    let seasons = detail
        .seasons
        .into_iter()
        .filter(|s| s.season_number >= 1) // skip "Specials" (season 0)
        .map(|s| (s.season_number, s.episode_count))
        .collect();
    Some((total, seasons))
}

/// Search every enabled source for a show and bucket the magnets by season.
/// TMDB (if keyed) provides the authoritative season list to label/validate against.
pub async fn compile_seasons(
    catalog: &Catalog,
    client: &reqwest::Client,
    tmdb_key: Option<&str>,
    title: &str,
    year: Option<i64>,
    now: i64,
) -> Result<Compilation> {
    let sources: Vec<_> = catalog.list_sources()?.into_iter().filter(|s| s.enabled).collect();

    // Broad searches that surface packs + episodes across architectures.
    let queries = [
        format!("{title} complete"),
        format!("{title} season"),
        title.to_string(),
    ];
    let mut seen = std::collections::HashSet::new();
    let mut all: Vec<CatalogItem> = Vec::new();
    for q in &queries {
        for s in &sources {
            if let Ok(items) = indexer::search_source(&s.kind, &s.url, q, &s.name, now).await {
                for it in items {
                    if seen.insert(it.id.clone()) {
                        all.push(it);
                    }
                }
            }
        }
    }
    let _ = catalog.upsert_items(&all);

    // Keep only results that plausibly belong to this show (title prefix match).
    let want = norm(title);
    all.retain(|it| {
        let n = norm(&it.title);
        !want.is_empty() && (n.starts_with(&want) || n.contains(&want))
    });

    // Ground truth seasons from TMDB.
    let grounded;
    let mut total_seasons = None;
    let mut ep_counts: HashMap<i64, Option<i64>> = HashMap::new();
    if let Some(k) = tmdb_key {
        if let Some((total, seasons)) = tmdb_seasons(client, k, title, year).await {
            grounded = true;
            total_seasons = Some(total);
            for (s, e) in seasons {
                ep_counts.insert(s, e);
            }
        } else {
            grounded = false;
        }
    } else {
        grounded = false;
    }

    // Bucket by season.
    let mut by_season: HashMap<i64, Vec<CatalogItem>> = HashMap::new();
    let mut complete: Vec<CatalogItem> = Vec::new();
    for it in all {
        let hit = detect_season(&it.title);
        if hit.is_complete && hit.season.is_none() {
            complete.push(it);
            continue;
        }
        match hit.season {
            Some(s) => by_season.entry(s).or_default().push(it),
            None => {
                if hit.is_complete {
                    complete.push(it);
                }
            }
        }
    }
    complete.sort_by(|a, b| b.seeders.cmp(&a.seeders));

    // Assemble seasons: prefer TMDB's real list, else whatever seasons we found.
    let mut season_nums: Vec<i64> = if let Some(t) = total_seasons.filter(|t| *t > 0) {
        (1..=t).collect()
    } else {
        let mut k: Vec<i64> = by_season.keys().copied().collect();
        k.sort();
        k
    };
    season_nums.dedup();

    let seasons = season_nums
        .into_iter()
        .map(|s| {
            let mut cands = by_season.remove(&s).unwrap_or_default();
            cands.sort_by(|a, b| b.seeders.cmp(&a.seeders));
            // The best is the most-seeded full-season pack (not a single episode).
            let best_idx = cands.iter().position(|c| !detect_season(&c.title).is_episode);
            let best = best_idx.map(|i| cands.remove(i)).or_else(|| {
                if cands.is_empty() {
                    None
                } else {
                    Some(cands.remove(0))
                }
            });
            SeasonPack {
                label: format!("Season {s}"),
                episode_count: ep_counts.get(&s).copied().flatten(),
                best,
                alternatives: cands.into_iter().take(12).collect(),
                season: s,
            }
        })
        .collect();

    Ok(Compilation {
        show: title.to_string(),
        year,
        total_seasons,
        seasons,
        complete: complete.into_iter().take(8).collect(),
        grounded,
    })
}
