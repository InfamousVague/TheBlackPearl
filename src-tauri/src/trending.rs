//! Discover "trending" — free, keyless top/trending lists per media category, plus the
//! relay-backed Movies/TV (TMDB). Every fetcher degrades to an EMPTY Vec on any error, so a
//! flaky or rate-limited upstream just yields a blank row (same tolerance as
//! `anime::popular_anime`). Parsing is split into pure `parse_*` fns so it's unit-testable
//! without the network.

use serde::{Deserialize, Serialize};

/// A discover-row item. `title` is both what's shown and what a click searches the user's
/// sources for; `subtitle` is the secondary line (artist / author / studio).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrendingItem {
    pub title: String,
    pub subtitle: Option<String>,
    pub poster: Option<String>,
    pub year: Option<i64>,
    /// 0–10 where the source exposes a score; otherwise None.
    pub rating: Option<f64>,
    /// movie | tv | music | book | game
    pub kind: String,
}

const APPLE_ALBUMS: &str =
    "https://rss.marketingtools.apple.com/api/v2/us/music/most-played/25/albums.json";
const OPENLIB_TRENDING: &str = "https://openlibrary.org/trending/daily.json?limit=30";
const STEAMSPY_TOP: &str = "https://steamspy.com/api.php?request=top100in2weeks";

/// Trending items for a Discover category. `relay_base` is `posters::RELAY_BASE`.
pub async fn fetch(client: &reqwest::Client, relay_base: &str, category: &str) -> Vec<TrendingItem> {
    match category {
        "movies" => relay(client, relay_base, "movie").await,
        "tvshows" => relay(client, relay_base, "tv").await,
        "music" => match get_text(client, APPLE_ALBUMS).await {
            Some(t) => parse_apple(&t),
            None => Vec::new(),
        },
        "books" => match get_text(client, OPENLIB_TRENDING).await {
            Some(t) => parse_openlibrary(&t),
            None => Vec::new(),
        },
        "games" => match get_text(client, STEAMSPY_TOP).await {
            Some(t) => parse_steamspy(&t),
            None => Vec::new(),
        },
        _ => Vec::new(),
    }
}

async fn get_text(client: &reqwest::Client, url: &str) -> Option<String> {
    let resp = client.get(url).send().await.ok()?;
    resp.error_for_status().ok()?.text().await.ok()
}

// ---- Movies / TV: the user's bp-relay (TMDB trending, cached) ----

async fn relay(client: &reqwest::Client, relay_base: &str, ty: &str) -> Vec<TrendingItem> {
    let url = format!("{relay_base}/trending?type={ty}");
    match get_text(client, &url).await {
        Some(t) => parse_relay(&t, if ty == "tv" { "tv" } else { "movie" }),
        None => Vec::new(),
    }
}

/// The relay returns the same digest shape as `/featured`; we only need a few fields.
#[derive(Deserialize, Default)]
struct RelayDigest {
    #[serde(default)]
    title: String,
    #[serde(default)]
    year: Option<i64>,
    #[serde(default)]
    poster: Option<String>,
    #[serde(default)]
    rating: Option<f64>,
}

fn parse_relay(body: &str, kind: &str) -> Vec<TrendingItem> {
    let list: Vec<RelayDigest> = serde_json::from_str(body).unwrap_or_default();
    list.into_iter()
        .filter(|d| !d.title.trim().is_empty())
        .map(|d| TrendingItem {
            title: d.title,
            subtitle: None,
            poster: d.poster,
            year: d.year,
            rating: d.rating,
            kind: kind.to_string(),
        })
        .collect()
}

// ---- Music: Apple Music RSS most-played albums (keyless) ----

#[derive(Deserialize)]
struct AppleFeed {
    feed: AppleFeedInner,
}
#[derive(Deserialize)]
struct AppleFeedInner {
    #[serde(default)]
    results: Vec<AppleResult>,
}
#[derive(Deserialize)]
struct AppleResult {
    #[serde(default)]
    name: String,
    #[serde(default, rename = "artistName")]
    artist_name: String,
    #[serde(default, rename = "artworkUrl100")]
    artwork_url100: String,
    #[serde(default, rename = "releaseDate")]
    release_date: String,
}

fn parse_apple(body: &str) -> Vec<TrendingItem> {
    let feed: AppleFeed = match serde_json::from_str(body) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    feed.feed
        .results
        .into_iter()
        .filter(|r| !r.name.trim().is_empty())
        .map(|r| TrendingItem {
            title: r.name,
            subtitle: (!r.artist_name.trim().is_empty()).then(|| r.artist_name.clone()),
            // The 100px thumb URL upsizes by swapping the size token.
            poster: (!r.artwork_url100.is_empty())
                .then(|| r.artwork_url100.replace("100x100bb", "400x400bb")),
            year: r.release_date.get(0..4).and_then(|y| y.parse().ok()),
            rating: None,
            kind: "music".to_string(),
        })
        .collect()
}

// ---- Books: Open Library trending (keyless) ----

#[derive(Deserialize)]
struct OlTrending {
    #[serde(default)]
    works: Vec<OlWork>,
}
#[derive(Deserialize)]
struct OlWork {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    author_name: Option<Vec<String>>,
    #[serde(default)]
    first_publish_year: Option<i64>,
    #[serde(default)]
    cover_i: Option<i64>,
}

fn parse_openlibrary(body: &str) -> Vec<TrendingItem> {
    let data: OlTrending = match serde_json::from_str(body) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    data.works
        .into_iter()
        .filter_map(|w| {
            let title = w.title.filter(|t| !t.trim().is_empty())?;
            Some(TrendingItem {
                title,
                subtitle: w.author_name.and_then(|a| a.into_iter().next()),
                poster: w.cover_i.map(|id| format!("https://covers.openlibrary.org/b/id/{id}-L.jpg")),
                year: w.first_publish_year,
                rating: None,
                kind: "book".to_string(),
            })
        })
        .collect()
}

// ---- Games: SteamSpy top-100-in-2-weeks (keyless) ----

#[derive(Deserialize)]
struct SteamGame {
    appid: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    developer: Option<String>,
    #[serde(default)]
    positive: i64,
    #[serde(default)]
    negative: i64,
    #[serde(default)]
    ccu: i64,
}

fn parse_steamspy(body: &str) -> Vec<TrendingItem> {
    // SteamSpy returns an object keyed by appid; serde_json doesn't preserve key order, so we
    // re-rank by concurrent users (ccu) — a solid "trending right now" proxy.
    let map: std::collections::HashMap<String, SteamGame> = match serde_json::from_str(body) {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    let mut games: Vec<SteamGame> = map.into_values().filter(|g| !g.name.trim().is_empty()).collect();
    games.sort_by(|a, b| b.ccu.cmp(&a.ccu));
    games
        .into_iter()
        .take(30)
        .map(|g| TrendingItem {
            title: g.name,
            subtitle: g.developer.filter(|d| !d.trim().is_empty()),
            poster: Some(format!(
                "https://cdn.cloudflare.steamstatic.com/steam/apps/{}/header.jpg",
                g.appid
            )),
            year: None,
            rating: steam_rating(g.positive, g.negative),
            kind: "game".to_string(),
        })
        .collect()
}

fn steam_rating(positive: i64, negative: i64) -> Option<f64> {
    let total = positive + negative;
    if total <= 0 {
        None
    } else {
        Some((positive as f64 / total as f64) * 10.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_rss_parses() {
        let body = r#"{"feed":{"title":"Top Albums","results":[
            {"name":"GUTS","artistName":"Olivia Rodrigo","artworkUrl100":"https://x/100x100bb.jpg","releaseDate":"2023-09-08"},
            {"name":"","artistName":"Nobody","artworkUrl100":"","releaseDate":""}
        ]}}"#;
        let items = parse_apple(body);
        assert_eq!(items.len(), 1, "blank-name entries are dropped");
        let it = &items[0];
        assert_eq!(it.title, "GUTS");
        assert_eq!(it.subtitle.as_deref(), Some("Olivia Rodrigo"));
        assert_eq!(it.poster.as_deref(), Some("https://x/400x400bb.jpg"), "art upsized");
        assert_eq!(it.year, Some(2023));
        assert_eq!(it.kind, "music");
    }

    #[test]
    fn openlibrary_parses() {
        let body = r#"{"works":[
            {"title":"Atomic Habits","author_name":["James Clear"],"first_publish_year":2016,"cover_i":12539702},
            {"author_name":["Ghost"]}
        ]}"#;
        let items = parse_openlibrary(body);
        assert_eq!(items.len(), 1, "untitled works are dropped");
        let it = &items[0];
        assert_eq!(it.title, "Atomic Habits");
        assert_eq!(it.subtitle.as_deref(), Some("James Clear"));
        assert_eq!(it.poster.as_deref(), Some("https://covers.openlibrary.org/b/id/12539702-L.jpg"));
        assert_eq!(it.year, Some(2016));
        assert_eq!(it.kind, "book");
    }

    #[test]
    fn steamspy_parses_and_ranks_by_ccu() {
        let body = r#"{
            "730":{"appid":730,"name":"Counter-Strike 2","developer":"Valve","positive":90,"negative":10,"ccu":500},
            "570":{"appid":570,"name":"Dota 2","developer":"Valve","positive":50,"negative":50,"ccu":900},
            "1":{"appid":1,"name":"","ccu":9999}
        }"#;
        let items = parse_steamspy(body);
        assert_eq!(items.len(), 2, "nameless app dropped");
        assert_eq!(items[0].title, "Dota 2", "ranked by ccu desc");
        assert_eq!(items[1].title, "Counter-Strike 2");
        assert_eq!(items[0].poster.as_deref(), Some("https://cdn.cloudflare.steamstatic.com/steam/apps/570/header.jpg"));
        assert_eq!(items[1].rating, Some(9.0), "90/100 → 9.0");
        assert_eq!(items[0].kind, "game");
    }

    #[test]
    fn relay_digest_parses() {
        let body = r#"[{"title":"Dune: Part Two","year":2024,"poster":"https://img/p.jpg","rating":8.2,"kind":"movie","extra":"ignored"},
                       {"title":"  "}]"#;
        let items = parse_relay(body, "movie");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Dune: Part Two");
        assert_eq!(items[0].rating, Some(8.2));
        assert_eq!(items[0].kind, "movie");
    }

    #[test]
    fn bad_json_degrades_to_empty() {
        assert!(parse_apple("not json").is_empty());
        assert!(parse_openlibrary("<html>").is_empty());
        assert!(parse_steamspy("").is_empty());
        assert!(parse_relay("null", "tv").is_empty());
    }
}
