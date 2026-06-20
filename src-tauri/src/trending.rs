//! Discover feeds — free, keyless top/trending lists per media category, plus the
//! relay-backed Movies/TV (TMDB). Each category returns a `DiscoverFeed { hero, rows }`:
//! several labelled rows (e.g. Trending / Popular / Top rated) and a hero pick for the
//! billboard. Every fetcher degrades to an EMPTY list on any error (same tolerance as
//! `anime::popular_anime`); parsing is split into pure `parse_*` fns so it's unit-testable
//! without the network.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// A discover item. `title` is what's shown and what a click searches the user's sources for;
/// `subtitle` is the secondary line (artist / author / studio). The richer fields drive the
/// hero billboard.
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
    /// Plot/overview, where available (movies & TV) — shown in the hero.
    pub overview: Option<String>,
    /// A primary genre, where available.
    pub genre: Option<String>,
    /// Wide backdrop image (movies & TV) for the hero background.
    pub backdrop: Option<String>,
}

/// One labelled rail of items.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverRow {
    pub title: String,
    pub items: Vec<TrendingItem>,
}

/// A category's whole Discover page: a hero pick + several rows.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverFeed {
    pub hero: Option<TrendingItem>,
    pub rows: Vec<DiscoverRow>,
}

const APPLE_ALBUMS: &str =
    "https://rss.marketingtools.apple.com/api/v2/us/music/most-played/30/albums.json";
const APPLE_SONGS: &str =
    "https://rss.marketingtools.apple.com/api/v2/us/music/most-played/30/songs.json";
const ROMSGAMES_BASE: &str = "https://www.romsgames.net";
const IA_GAME_FILTER: &str = "mediatype:software AND (subject:(game OR games OR rom OR arcade OR emulator) OR collection:(consolelivingroom OR softwarelibrary OR softwarelibrary_console OR psxgames))";

/// The whole Discover feed for a category. `relay_base` is `posters::RELAY_BASE`.
pub async fn feed(client: &reqwest::Client, relay_base: &str, category: &str) -> DiscoverFeed {
    let raw_rows: Vec<DiscoverRow> = match category {
        "movies" => relay_rows(client, relay_base, "movie").await,
        "tvshows" => relay_rows(client, relay_base, "tv").await,
        "music" => music_rows(client).await,
        "books" => books_rows(client).await,
        "games" => games_rows(client).await,
        _ => Vec::new(),
    };
    let rows: Vec<DiscoverRow> = raw_rows.into_iter().filter(|r| !r.items.is_empty()).collect();
    let hero = pick_hero(&rows);
    DiscoverFeed { hero, rows }
}

/// Hero pick: prefer an item with a backdrop + overview (a rich billboard), else any with a
/// poster, else the very first item.
fn pick_hero(rows: &[DiscoverRow]) -> Option<TrendingItem> {
    let all = || rows.iter().flat_map(|r| r.items.iter());
    all()
        .find(|i| i.backdrop.is_some() && i.overview.is_some())
        .or_else(|| all().find(|i| i.poster.is_some()))
        .or_else(|| all().next())
        .cloned()
}

async fn get_text(client: &reqwest::Client, url: &str) -> Option<String> {
    let resp = client.get(url).send().await.ok()?;
    resp.error_for_status().ok()?.text().await.ok()
}

// ---- Movies / TV: the user's bp-relay (TMDB trending/popular/top_rated, cached) ----

async fn relay_rows(client: &reqwest::Client, relay_base: &str, kind: &str) -> Vec<DiscoverRow> {
    let (trending, popular, top) = tokio::join!(
        relay(client, relay_base, kind, "trending"),
        relay(client, relay_base, kind, "popular"),
        relay(client, relay_base, kind, "top_rated"),
    );
    vec![
        DiscoverRow { title: "Trending this week".into(), items: trending },
        DiscoverRow { title: "Popular".into(), items: popular },
        DiscoverRow { title: "Top rated".into(), items: top },
    ]
}

async fn relay(client: &reqwest::Client, relay_base: &str, kind: &str, feed: &str) -> Vec<TrendingItem> {
    let url = format!("{relay_base}/trending?type={kind}&feed={feed}");
    match get_text(client, &url).await {
        Some(t) => parse_relay(&t, kind),
        None => Vec::new(),
    }
}

/// The relay returns the same digest shape as `/featured`; we take a few fields.
#[derive(Deserialize, Default)]
struct RelayDigest {
    #[serde(default)]
    title: String,
    #[serde(default)]
    year: Option<i64>,
    #[serde(default)]
    poster: Option<String>,
    #[serde(default)]
    backdrop: Option<String>,
    #[serde(default)]
    overview: Option<String>,
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
            overview: d.overview,
            genre: None,
            backdrop: d.backdrop,
        })
        .collect()
}

// ---- Music: Apple Music RSS most-played albums + songs (keyless) ----

async fn music_rows(client: &reqwest::Client) -> Vec<DiscoverRow> {
    let (albums, songs) = tokio::join!(apple(client, APPLE_ALBUMS), apple(client, APPLE_SONGS));
    vec![
        DiscoverRow { title: "Top albums".into(), items: albums },
        DiscoverRow { title: "Top songs".into(), items: songs },
    ]
}

async fn apple(client: &reqwest::Client, url: &str) -> Vec<TrendingItem> {
    match get_text(client, url).await {
        Some(t) => parse_apple(&t),
        None => Vec::new(),
    }
}

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
    #[serde(default)]
    genres: Vec<AppleGenre>,
}
#[derive(Deserialize)]
struct AppleGenre {
    #[serde(default)]
    name: String,
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
        .map(|r| {
            // Apple tags everything with the generic "Music" genre too — prefer the specific one.
            let genre = r
                .genres
                .iter()
                .map(|g| g.name.trim())
                .find(|n| !n.is_empty() && *n != "Music")
                .or_else(|| r.genres.iter().map(|g| g.name.trim()).find(|n| !n.is_empty()))
                .map(|s| s.to_string());
            TrendingItem {
                title: r.name,
                subtitle: (!r.artist_name.trim().is_empty()).then(|| r.artist_name.clone()),
                poster: (!r.artwork_url100.is_empty())
                    .then(|| r.artwork_url100.replace("100x100bb", "600x600bb")),
                year: r.release_date.get(0..4).and_then(|y| y.parse().ok()),
                rating: None,
                kind: "music".to_string(),
                overview: None,
                genre,
                backdrop: None,
            }
        })
        .collect()
}

// ---- Books: Open Library trending (keyless), three time windows ----

async fn books_rows(client: &reqwest::Client) -> Vec<DiscoverRow> {
    let (daily, weekly, monthly) = tokio::join!(
        openlibrary(client, "daily"),
        openlibrary(client, "weekly"),
        openlibrary(client, "monthly"),
    );
    vec![
        DiscoverRow { title: "Trending today".into(), items: daily },
        DiscoverRow { title: "Trending this week".into(), items: weekly },
        DiscoverRow { title: "Trending this month".into(), items: monthly },
    ]
}

async fn openlibrary(client: &reqwest::Client, window: &str) -> Vec<TrendingItem> {
    let url = format!("https://openlibrary.org/trending/{window}.json?limit=30");
    match get_text(client, &url).await {
        Some(t) => parse_openlibrary(&t),
        None => Vec::new(),
    }
}

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
                overview: None,
                genre: None,
                backdrop: None,
            })
        })
        .collect()
}

// ---- Games: ROM websites (keyless): Internet Archive + RomsGames ----

async fn games_rows(client: &reqwest::Client) -> Vec<DiscoverRow> {
    let (archive, playstation, gba) = tokio::join!(
        internet_archive_roms(client),
        romsgames_platform(client, "playstation"),
        romsgames_platform(client, "gameboy-advance"),
    );
    let mut rows = vec![
        DiscoverRow { title: "Internet Archive ROMs".into(), items: archive },
        DiscoverRow { title: "RomsGames · PlayStation".into(), items: playstation },
        DiscoverRow { title: "RomsGames · Game Boy Advance".into(), items: gba },
    ];

    if rows.iter().all(|r| r.items.is_empty()) {
        rows.push(DiscoverRow {
            title: "ROM search ideas".into(),
            items: rom_search_ideas(),
        });
    }
    rows
}

fn rom_search_ideas() -> Vec<TrendingItem> {
    [
        "Pokemon",
        "Legend of Zelda",
        "Super Mario",
        "Final Fantasy",
        "Metroid",
        "Castlevania",
        "Crash Bandicoot",
        "Nintendo DS ROM",
        "Game Boy Advance ROM",
        "PlayStation ROM",
        "SNES ROM",
        "N64 ROM",
    ]
    .into_iter()
    .map(|title| TrendingItem {
        title: title.to_string(),
        subtitle: Some("ROM query".to_string()),
        poster: None,
        year: None,
        rating: None,
        kind: "game".to_string(),
        overview: None,
        genre: Some("ROM".to_string()),
        backdrop: None,
    })
    .collect()
}

fn value_first_string(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { None } else { Some(t.to_string()) }
        }
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Array(a) => a.iter().find_map(value_first_string),
        _ => None,
    }
}

fn parse_year(v: Option<&serde_json::Value>) -> Option<i64> {
    let raw = v.and_then(value_first_string)?;
    let re = regex::Regex::new(r"(19|20)\d{2}").ok()?;
    re.find(&raw)?.as_str().parse().ok()
}

fn parse_internet_archive_roms(body: &str) -> Vec<TrendingItem> {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(docs) = val
        .get("response")
        .and_then(|r| r.get("docs"))
        .and_then(|d| d.as_array())
    else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for doc in docs {
        let Some(identifier) = doc.get("identifier").and_then(value_first_string) else {
            continue;
        };
        if !seen.insert(identifier.to_lowercase()) {
            continue;
        }
        let title = doc
            .get("title")
            .and_then(value_first_string)
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| identifier.clone());

        out.push(TrendingItem {
            title,
            subtitle: Some("Internet Archive".to_string()),
            poster: Some(format!("https://archive.org/services/img/{identifier}")),
            year: parse_year(doc.get("year")),
            rating: None,
            kind: "game".to_string(),
            overview: None,
            genre: Some("ROM".to_string()),
            backdrop: Some(format!("https://archive.org/services/img/{identifier}")),
        });
    }
    out.into_iter().take(30).collect()
}

async fn internet_archive_roms(client: &reqwest::Client) -> Vec<TrendingItem> {
    let mut url = match reqwest::Url::parse("https://archive.org/advancedsearch.php") {
        Ok(u) => u,
        Err(_) => return Vec::new(),
    };
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("q", IA_GAME_FILTER);
        qp.append_pair("fl[]", "identifier");
        qp.append_pair("fl[]", "title");
        qp.append_pair("fl[]", "year");
        qp.append_pair("rows", "60");
        qp.append_pair("page", "1");
        qp.append_pair("output", "json");
        qp.append_pair("sort[]", "downloads desc");
    }
    match get_text(client, url.as_str()).await {
        Some(t) => parse_internet_archive_roms(&t),
        None => Vec::new(),
    }
}

fn absolute_romsgames_url(url: &str) -> String {
    if url.starts_with("http://") || url.starts_with("https://") {
        return url.to_string();
    }
    if url.starts_with("//") {
        return format!("https:{url}");
    }
    if url.starts_with('/') {
        return format!("{ROMSGAMES_BASE}{url}");
    }
    format!("{ROMSGAMES_BASE}/{}", url.trim_start_matches('/'))
}

fn parse_romsgames_cards(body: &str) -> Vec<TrendingItem> {
    let card_re = match regex::Regex::new(
        r#"(?s)<a href="([^"]*?-rom-[^"]+?/?)"[^>]*>.*?<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>.*?<div[^>]*>\s*([^<]+?)\s*</div>"#,
    ) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for cap in card_re.captures_iter(body) {
        let href = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        if href.is_empty() {
            continue;
        }
        let key = href.trim_matches('/').to_lowercase();
        if key.is_empty() || !seen.insert(key) {
            continue;
        }

        let alt = cap.get(3).map(|m| m.as_str().trim()).unwrap_or("");
        let card_title = cap.get(4).map(|m| m.as_str().trim()).unwrap_or("");
        let title = if card_title.is_empty() { alt } else { card_title };
        if title.is_empty() {
            continue;
        }

        let poster = cap
            .get(2)
            .map(|m| absolute_romsgames_url(m.as_str()))
            .filter(|u| !u.is_empty() && !u.contains("/image/no-cover"));

        out.push(TrendingItem {
            title: title.to_string(),
            subtitle: Some("RomsGames".to_string()),
            poster: poster.clone(),
            year: None,
            rating: None,
            kind: "game".to_string(),
            overview: None,
            genre: Some("ROM".to_string()),
            backdrop: poster,
        });
    }
    out
}

async fn romsgames_platform(client: &reqwest::Client, slug: &str) -> Vec<TrendingItem> {
    let endpoint = format!("{ROMSGAMES_BASE}/roms/{slug}/");
    match get_text(client, &endpoint).await {
        Some(t) => parse_romsgames_cards(&t).into_iter().take(24).collect(),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_rss_parses_with_genre() {
        let body = r#"{"feed":{"results":[
            {"name":"GUTS","artistName":"Olivia Rodrigo","artworkUrl100":"https://x/100x100bb.jpg","releaseDate":"2023-09-08","genres":[{"name":"Pop"},{"name":"Music"}]},
            {"name":"","artistName":"Nobody","artworkUrl100":"","releaseDate":""}
        ]}}"#;
        let items = parse_apple(body);
        assert_eq!(items.len(), 1, "blank-name entries are dropped");
        let it = &items[0];
        assert_eq!(it.title, "GUTS");
        assert_eq!(it.subtitle.as_deref(), Some("Olivia Rodrigo"));
        assert_eq!(it.poster.as_deref(), Some("https://x/600x600bb.jpg"), "art upsized");
        assert_eq!(it.year, Some(2023));
        assert_eq!(it.genre.as_deref(), Some("Pop"), "specific genre preferred over generic 'Music'");
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
    fn internet_archive_roms_parse() {
        let body = r#"{
            "response": {
                "docs": [
                    {"identifier": "psx_crash_bandicoot", "title": "Crash Bandicoot (PSX)", "year": "1996"},
                    {"identifier": "nds_mario_kart", "title": "Mario Kart DS", "year": 2005}
                ]
            }
        }"#;
        let items = parse_internet_archive_roms(body);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Crash Bandicoot (PSX)");
        assert_eq!(items[0].subtitle.as_deref(), Some("Internet Archive"));
        assert_eq!(items[0].genre.as_deref(), Some("ROM"));
        assert_eq!(items[0].year, Some(1996));
        assert_eq!(items[1].year, Some(2005));
    }

    #[test]
    fn romsgames_cards_parse() {
        let body = r#"
<div class="grid gap-6">
    <a href="/playstation-rom-crash-bandicoot-1/" class="relative p-2">
        <img src="https://cache.downloadroms.io/static/abc/image.jpeg" alt="Crash Bandicoot">
        <div>Crash Bandicoot</div>
    </a>
</div>
"#;
        let items = parse_romsgames_cards(body);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Crash Bandicoot");
        assert_eq!(items[0].subtitle.as_deref(), Some("RomsGames"));
        assert_eq!(items[0].kind, "game");
        assert_eq!(items[0].genre.as_deref(), Some("ROM"));
    }

    #[test]
    fn relay_digest_parses_with_overview_and_backdrop() {
        let body = r#"[{"title":"Dune: Part Two","year":2024,"poster":"https://img/p.jpg","backdrop":"https://img/b.jpg","overview":"Paul unites with the Fremen.","rating":8.2,"kind":"movie","extra":"ignored"},
                       {"title":"  "}]"#;
        let items = parse_relay(body, "movie");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Dune: Part Two");
        assert_eq!(items[0].overview.as_deref(), Some("Paul unites with the Fremen."));
        assert_eq!(items[0].backdrop.as_deref(), Some("https://img/b.jpg"));
        assert_eq!(items[0].rating, Some(8.2));
        assert_eq!(items[0].kind, "movie");
    }

    #[test]
    fn hero_prefers_backdrop_plus_overview() {
        let plain = TrendingItem {
            title: "Plain".into(), subtitle: None, poster: Some("p".into()), year: None,
            rating: None, kind: "movie".into(), overview: None, genre: None, backdrop: None,
        };
        let rich = TrendingItem {
            title: "Rich".into(), subtitle: None, poster: Some("p".into()), year: None,
            rating: None, kind: "movie".into(), overview: Some("o".into()), genre: None, backdrop: Some("b".into()),
        };
        let rows = vec![
            DiscoverRow { title: "A".into(), items: vec![plain.clone()] },
            DiscoverRow { title: "B".into(), items: vec![rich.clone()] },
        ];
        assert_eq!(pick_hero(&rows).unwrap().title, "Rich");
    }

    #[test]
    fn bad_json_degrades_to_empty() {
        assert!(parse_apple("not json").is_empty());
        assert!(parse_openlibrary("<html>").is_empty());
        assert!(parse_internet_archive_roms("").is_empty());
        assert!(parse_romsgames_cards("").is_empty());
        assert!(parse_relay("null", "tv").is_empty());
    }
}
