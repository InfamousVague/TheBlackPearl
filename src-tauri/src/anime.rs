//! Anime discovery from free, keyless public APIs (both confirmed reachable
//! server-side):
//!   - AniList GraphQL (graphql.anilist.co) — TRENDING_DESC, rich metadata.
//!   - Jikan (api.jikan.moe, the unofficial MyAnimeList API) — top-by-popularity
//!     and the current season.
//! Returns three browseable rails (Trending / Most popular / This season). No key,
//! no login — the user can spot a title and hit "Find sources" to grab it.

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnimeItem {
    /// Romaji / native title — the better match for source searches (fansubs use it).
    pub title: String,
    pub title_english: Option<String>,
    pub year: Option<i64>,
    pub poster: Option<String>,
    pub synopsis: Option<String>,
    /// 0–10 score (AniList's 0–100 average is rescaled).
    pub score: Option<f64>,
    pub genres: Vec<String>,
    pub episodes: Option<i64>,
    /// TV / Movie / OVA / ONA / Special.
    pub format: Option<String>,
    pub status: Option<String>,
    pub trailer_youtube: Option<String>,
    pub mal_id: Option<i64>,
    pub anilist_id: Option<i64>,
    /// Which provider(s) surfaced this title.
    pub sources: Vec<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnimeDiscovery {
    pub trending: Vec<AnimeItem>,
    pub top: Vec<AnimeItem>,
    pub seasonal: Vec<AnimeItem>,
}

/// Fetch all three rails concurrently; any provider that errors just yields an empty
/// rail, so the page degrades gracefully rather than failing whole.
pub async fn popular_anime(client: &reqwest::Client) -> AnimeDiscovery {
    let (trending, top, seasonal) = tokio::join!(
        anilist_trending(client),
        jikan_top(client),
        jikan_season_now(client),
    );
    AnimeDiscovery {
        trending: trending.unwrap_or_default(),
        top: top.unwrap_or_default(),
        seasonal: seasonal.unwrap_or_default(),
    }
}

/// Strip HTML tags + collapse whitespace (AniList descriptions are HTML).
fn strip_html(s: &str) -> String {
    let no_tags = regex::Regex::new(r"<[^>]+>").unwrap().replace_all(s, " ");
    let decoded = no_tags
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ============================ AniList (trending) ============================

#[derive(Deserialize)]
struct AniResp {
    data: Option<AniData>,
}
#[derive(Deserialize)]
struct AniData {
    #[serde(rename = "Page")]
    page: Option<AniPage>,
}
#[derive(Deserialize)]
struct AniPage {
    #[serde(default)]
    media: Vec<AniMedia>,
}
#[derive(Deserialize)]
struct AniMedia {
    id: Option<i64>,
    #[serde(rename = "idMal")]
    id_mal: Option<i64>,
    title: Option<AniTitle>,
    #[serde(rename = "averageScore")]
    average_score: Option<i64>,
    #[serde(rename = "seasonYear")]
    season_year: Option<i64>,
    episodes: Option<i64>,
    format: Option<String>,
    status: Option<String>,
    #[serde(default)]
    genres: Vec<String>,
    #[serde(rename = "coverImage")]
    cover_image: Option<AniCover>,
    description: Option<String>,
    trailer: Option<AniTrailer>,
}
#[derive(Deserialize)]
struct AniTitle {
    romaji: Option<String>,
    english: Option<String>,
}
#[derive(Deserialize)]
struct AniCover {
    large: Option<String>,
}
#[derive(Deserialize)]
struct AniTrailer {
    id: Option<String>,
    site: Option<String>,
}

async fn anilist_trending(client: &reqwest::Client) -> Result<Vec<AnimeItem>> {
    let query = r#"query($n:Int){Page(perPage:$n){media(type:ANIME,sort:TRENDING_DESC,isAdult:false){id idMal title{romaji english} averageScore seasonYear episodes format status genres coverImage{large} description(asHtml:false) trailer{id site}}}}"#;
    let body = serde_json::json!({ "query": query, "variables": { "n": 24 } });
    let resp: AniResp = client
        .post("https://graphql.anilist.co")
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let media = resp.data.and_then(|d| d.page).map(|p| p.media).unwrap_or_default();
    Ok(media.into_iter().filter_map(ani_map).collect())
}

/// Map one AniList media node → an `AnimeItem` (shared by trending + search).
fn ani_map(m: AniMedia) -> Option<AnimeItem> {
    let t = m.title.unwrap_or(AniTitle { romaji: None, english: None });
    let title = t.romaji.clone().or_else(|| t.english.clone())?;
    if title.is_empty() {
        return None;
    }
    Some(AnimeItem {
        title,
        title_english: t.english.filter(|e| !e.is_empty()),
        year: m.season_year,
        poster: m.cover_image.and_then(|c| c.large).filter(|p| !p.is_empty()),
        synopsis: m.description.as_deref().map(strip_html).filter(|s| !s.is_empty()),
        score: m.average_score.map(|s| (s as f64) / 10.0).filter(|s| *s > 0.0),
        genres: m.genres,
        episodes: m.episodes,
        format: m.format,
        status: m.status,
        trailer_youtube: m.trailer.and_then(|tr| {
            if tr.site.as_deref() == Some("youtube") { tr.id } else { None }
        }),
        mal_id: m.id_mal,
        anilist_id: m.id,
        sources: vec!["AniList".to_string()],
    })
}

// ============================ anime detail (by title) ============================

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnimeEpisode {
    pub number: i64,
    pub title: Option<String>,
    pub airdate: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnimeDetail {
    /// All the discovery metadata (synopsis, genres, episode count, poster, …).
    #[serde(flatten)]
    pub info: AnimeItem,
    /// Per-episode titles/airdates where the provider exposes them (best-effort).
    pub episode_list: Vec<AnimeEpisode>,
}

#[derive(Deserialize)]
struct AniOneResp {
    data: Option<AniOneData>,
}
#[derive(Deserialize)]
struct AniOneData {
    #[serde(rename = "Media")]
    media: Option<AniMedia>,
}

/// Find the single best-matching anime for `title` on AniList.
async fn anilist_search(client: &reqwest::Client, title: &str) -> Result<Option<AnimeItem>> {
    let query = r#"query($q:String){Media(search:$q,type:ANIME,sort:SEARCH_MATCH){id idMal title{romaji english} averageScore seasonYear episodes format status genres coverImage{large} description(asHtml:false) trailer{id site}}}"#;
    let body = serde_json::json!({ "query": query, "variables": { "q": title } });
    let resp: AniOneResp = client
        .post("https://graphql.anilist.co")
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp.data.and_then(|d| d.media).and_then(ani_map))
}

/// Fallback: best-matching anime for `title` on MyAnimeList (Jikan).
async fn jikan_search(client: &reqwest::Client, title: &str) -> Result<Option<AnimeItem>> {
    let resp: JikanList = client
        .get("https://api.jikan.moe/v4/anime")
        .query(&[("q", title), ("limit", "1"), ("sfw", "true")])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp.data.into_iter().next().and_then(jikan_map))
}

#[derive(Deserialize)]
struct JikanEpisodesResp {
    #[serde(default)]
    data: Vec<JikanEp>,
}
#[derive(Deserialize)]
struct JikanEp {
    mal_id: Option<i64>,
    title: Option<String>,
    aired: Option<String>,
}

/// Episode titles for a MAL id (first page — up to ~100; enough for current-season
/// and most series, with longer runs falling back to bare numbers on the client).
async fn jikan_episodes(client: &reqwest::Client, mal_id: i64) -> Result<Vec<AnimeEpisode>> {
    let resp: JikanEpisodesResp = client
        .get(format!("https://api.jikan.moe/v4/anime/{mal_id}/episodes"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp
        .data
        .into_iter()
        .enumerate()
        .map(|(i, e)| AnimeEpisode {
            number: e.mal_id.unwrap_or((i as i64) + 1),
            title: e.title.filter(|t| !t.is_empty()),
            airdate: e.aired.and_then(|a| a.get(0..10).map(str::to_string)),
        })
        .collect())
}

/// Look up one anime by title (AniList → Jikan fallback) + its episode list. Powers
/// the below-player anime panel (synopsis, up-next, remaining episodes).
pub async fn anime_detail(client: &reqwest::Client, title: &str) -> Option<AnimeDetail> {
    let info = match anilist_search(client, title).await {
        Ok(Some(it)) => it,
        _ => jikan_search(client, title).await.ok().flatten()?,
    };
    let mut episode_list = Vec::new();
    if let Some(mal) = info.mal_id {
        if let Ok(eps) = jikan_episodes(client, mal).await {
            episode_list = eps;
        }
    }
    Some(AnimeDetail { info, episode_list })
}

// ============================ Jikan (MyAnimeList) ============================

#[derive(Deserialize)]
struct JikanList {
    #[serde(default)]
    data: Vec<JikanAnime>,
}
#[derive(Deserialize)]
struct JikanAnime {
    mal_id: Option<i64>,
    title: Option<String>,
    title_english: Option<String>,
    images: Option<JikanImages>,
    synopsis: Option<String>,
    score: Option<f64>,
    year: Option<i64>,
    episodes: Option<i64>,
    #[serde(rename = "type")]
    kind: Option<String>,
    status: Option<String>,
    members: Option<i64>,
    #[serde(default)]
    genres: Vec<JikanNamed>,
    trailer: Option<JikanTrailer>,
    aired: Option<JikanAired>,
}
#[derive(Deserialize)]
struct JikanImages {
    jpg: Option<JikanImg>,
}
#[derive(Deserialize)]
struct JikanImg {
    large_image_url: Option<String>,
    image_url: Option<String>,
}
#[derive(Deserialize)]
struct JikanNamed {
    name: String,
}
#[derive(Deserialize)]
struct JikanTrailer {
    youtube_id: Option<String>,
}
#[derive(Deserialize)]
struct JikanAired {
    from: Option<String>,
}

fn jikan_map(a: JikanAnime) -> Option<AnimeItem> {
    let title = a.title.filter(|t| !t.is_empty())?;
    let year = a
        .year
        .or_else(|| a.aired.as_ref().and_then(|d| d.from.as_deref()).and_then(|f| f.get(0..4)).and_then(|y| y.parse().ok()));
    let poster = a.images.and_then(|i| i.jpg).and_then(|j| j.large_image_url.or(j.image_url)).filter(|p| !p.is_empty());
    Some(AnimeItem {
        title,
        title_english: a.title_english.filter(|e| !e.is_empty()),
        year,
        poster,
        synopsis: a.synopsis.filter(|s| !s.is_empty()),
        score: a.score.filter(|s| *s > 0.0),
        genres: a.genres.into_iter().map(|g| g.name).collect(),
        episodes: a.episodes,
        format: a.kind,
        status: a.status,
        trailer_youtube: a.trailer.and_then(|t| t.youtube_id).filter(|y| !y.is_empty()),
        mal_id: a.mal_id,
        anilist_id: None,
        sources: vec!["MyAnimeList".to_string()],
    })
}

async fn jikan_top(client: &reqwest::Client) -> Result<Vec<AnimeItem>> {
    let resp: JikanList = client
        .get("https://api.jikan.moe/v4/top/anime?filter=bypopularity&limit=24&sfw=true")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp.data.into_iter().filter_map(jikan_map).collect())
}

async fn jikan_season_now(client: &reqwest::Client) -> Result<Vec<AnimeItem>> {
    let resp: JikanList = client
        .get("https://api.jikan.moe/v4/seasons/now?sfw=true&limit=24")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    // The seasonal endpoint isn't popularity-sorted, so order by MAL members.
    let mut items: Vec<(i64, AnimeItem)> = resp
        .data
        .into_iter()
        .map(|a| (a.members.unwrap_or(0), a))
        .filter_map(|(m, a)| jikan_map(a).map(|it| (m, it)))
        .collect();
    items.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(items.into_iter().map(|(_, it)| it).take(20).collect())
}
