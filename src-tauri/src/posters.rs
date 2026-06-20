//! Keyless-first cover-art lookup so posters appear without the user adding any
//! API key. IMDb's public suggestion endpoint returns posters for commercial
//! movies and TV; iTunes covers music albums. TMDB/OMDb refine when keys exist,
//! and games can use RomsGames/relay box art.

use anyhow::Result;
use serde::Deserialize;

use crate::{artwork, enrich};

// ---------- IMDb keyless suggestion ----------

#[derive(Deserialize)]
struct ImdbResp {
    #[serde(default)]
    d: Vec<ImdbItem>,
}
#[derive(Deserialize)]
struct ImdbItem {
    #[serde(default)]
    l: String, // title
    q: Option<String>, // "feature" | "TV series" | "TV mini-series" | "short" | "video" | …
    y: Option<i64>,     // year
    i: Option<ImdbImg>,
}
#[derive(Deserialize)]
struct ImdbImg {
    #[serde(rename = "imageUrl")]
    image_url: Option<String>,
}

/// IMDb suggestion lookup → best poster URL for a movie/show. No API key.
pub async fn imdb_poster(
    client: &reqwest::Client,
    title: &str,
    year: Option<i64>,
    want_tv: bool,
) -> Result<Option<String>> {
    let want = normalize(title);
    let Some(first) = want.chars().next() else {
        return Ok(None);
    };
    let url = format!(
        "https://v2.sg.media-imdb.com/suggestion/{first}/{}.json",
        want.replace(' ', "%20")
    );
    let resp: ImdbResp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let mut best: Option<(i32, String)> = None;
    for it in resp.d {
        let Some(img) = it.i.and_then(|x| x.image_url).filter(|u| !u.is_empty()) else {
            continue;
        };
        let q = it.q.unwrap_or_default();
        let is_tv = q.contains("TV");
        // Keep only title-like results (drop video games, people, etc.).
        let titleish = q.contains("feature") || is_tv || q.contains("video") || q.contains("short") || q.contains("documentary");
        if !titleish {
            continue;
        }
        let mut score = title_score(&want, &normalize(&it.l));
        if score == 0 {
            continue;
        }
        if let (Some(a), Some(b)) = (year, it.y) {
            if a == b {
                score += 30;
            } else if (a - b).abs() <= 1 {
                score += 12;
            } else {
                score -= 12;
            }
        }
        if want_tv == is_tv {
            score += 18;
        }
        if best.as_ref().map_or(true, |(b, _)| score > *b) {
            best = Some((score, sized(&img)));
        }
    }
    Ok(best.map(|(_, u)| u))
}

/// IMDb Amazon image URLs accept a size modifier before `.jpg`; request ~500px wide.
fn sized(url: &str) -> String {
    match regex::Regex::new(r"\._V1_.*?\.jpg") {
        Ok(re) => re.replace(url, "._V1_QL75_UX500_.jpg").into_owned(),
        Err(_) => url.to_string(),
    }
}

// ---------- iTunes (music, keyless) ----------

#[derive(Deserialize)]
struct ItunesResp {
    #[serde(default)]
    results: Vec<ItunesItem>,
}
#[derive(Deserialize)]
struct ItunesItem {
    #[serde(rename = "collectionName")]
    collection_name: Option<String>,
    #[serde(rename = "artworkUrl100")]
    artwork: Option<String>,
}

/// iTunes album art for a music title. No API key (iTunes still serves music).
pub async fn itunes_album(client: &reqwest::Client, title: &str) -> Result<Option<String>> {
    let want = normalize(title);
    if want.is_empty() {
        return Ok(None);
    }
    let resp: ItunesResp = client
        .get("https://itunes.apple.com/search")
        .query(&[
            ("term", want.as_str()),
            ("media", "music"),
            ("entity", "album"),
            ("limit", "5"),
            ("country", "US"),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    for it in resp.results {
        if let Some(art) = it.artwork.filter(|a| !a.is_empty()) {
            let name = normalize(&it.collection_name.unwrap_or_default());
            if title_score(&want, &name) > 0 {
                return Ok(Some(art.replace("100x100bb", "600x600bb")));
            }
        }
    }
    Ok(None)
}

fn absolute_game_url(url: &str) -> String {
    if url.starts_with("http://") || url.starts_with("https://") {
        return url.to_string();
    }
    if url.starts_with("//") {
        return format!("https:{url}");
    }
    if url.starts_with('/') {
        return format!("https://www.romsgames.net{url}");
    }
    format!("https://www.romsgames.net/{url}")
}

/// Best-effort game box art from RomsGames search cards (keyless, no API).
async fn romsgames_box_art(client: &reqwest::Client, title: &str) -> Result<Option<String>> {
    let want = normalize(&clean_for_query(title, "game"));
    if want.is_empty() {
        return Ok(None);
    }

    let mut search = reqwest::Url::parse("https://www.romsgames.net/search/")?;
    {
        let mut qp = search.query_pairs_mut();
        qp.append_pair("q", title.trim());
    }
    let body = client
        .get(search)
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0")
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;

    let card_re = regex::Regex::new(
        r#"(?s)<a href="([^"]*?-rom-[^"]+?/?)"[^>]*>.*?<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)""#,
    )?;
    let mut best: Option<(i32, String)> = None;
    for cap in card_re.captures_iter(&body) {
        let href = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let img = cap.get(2).map(|m| m.as_str()).unwrap_or("").trim();
        if img.is_empty() || img.contains("/image/no-cover") {
            continue;
        }
        let alt = normalize(cap.get(3).map(|m| m.as_str()).unwrap_or(""));
        let slug_guess = href
            .trim_matches('/')
            .rsplit('/')
            .next()
            .map(|s| s.replace('-', " "))
            .unwrap_or_default();
        let cand_title = if alt.is_empty() { normalize(&slug_guess) } else { alt };
        let score = title_score(&want, &cand_title);
        if score == 0 {
            continue;
        }
        let art = absolute_game_url(img);
        if best.as_ref().map_or(true, |(b, _)| score > *b) {
            best = Some((score, art));
        }
    }
    Ok(best.map(|(_, u)| u))
}

/// Several poster candidates for a title (IMDb suggestion results + iTunes), for the
/// manual "replace poster" picker. Keyless.
pub async fn candidates(client: &reqwest::Client, title: &str, kind: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let want = normalize(title);

    if kind == "game" {
        if let Ok(Some(u)) = romsgames_box_art(client, title).await {
            out.push(u);
        }
        let relay = relay_poster_url("game", title, year_from_title(title));
        if !out.contains(&relay) {
            out.push(relay);
        }
        out.truncate(18);
        return out;
    }

    let Some(first) = want.chars().next() else {
        return out;
    };

    // IMDb suggestion — every result's image.
    let url = format!("https://v2.sg.media-imdb.com/suggestion/{first}/{}.json", want.replace(' ', "%20"));
    if let Ok(resp) = client.get(&url).header(reqwest::header::USER_AGENT, "Mozilla/5.0").send().await {
        if let Ok(r) = resp.json::<ImdbResp>().await {
            for it in r.d {
                if let Some(img) = it.i.and_then(|x| x.image_url).filter(|u| !u.is_empty()) {
                    let s = sized(&img);
                    if !out.contains(&s) {
                        out.push(s);
                    }
                }
            }
        }
    }

    // iTunes — album / movie art.
    let (media, entity) = match kind {
        "music" => ("music", "album"),
        "show" => ("tvShow", "tvSeason"),
        _ => ("movie", "movie"),
    };
    if let Ok(resp) = client
        .get("https://itunes.apple.com/search")
        .query(&[("term", want.as_str()), ("media", media), ("entity", entity), ("limit", "8"), ("country", "US")])
        .send()
        .await
    {
        if let Ok(r) = resp.json::<ItunesResp>().await {
            for it in r.results {
                if let Some(a) = it.artwork.filter(|x| !x.is_empty()) {
                    let s = a.replace("100x100bb", "600x600bb");
                    if !out.contains(&s) {
                        out.push(s);
                    }
                }
            }
        }
    }

    out.truncate(18);
    out
}

// ---------- waterfall ----------

/// Base URL of GhostWire artwork relay — movie/TV posters + album art,
/// resolved and cached server-side so no client needs an API key. The endpoints
/// return image bytes directly, so a relay URL is usable anywhere a poster URL is
/// (the UI and the local artwork cache fetch it like any other image).
pub const RELAY_BASE: &str = "https://theblackpearl.tv/api";

// ---- Details digest (movie/show) via the relay (read-only, server-cached) ----

#[derive(serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CastMember {
    pub name: String,
    #[serde(default)]
    pub character: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
}

/// Full details the relay assembles for a movie/show — overview, ratings, genres,
/// runtime, cast, poster/backdrop, and a YouTube trailer key. camelCase matches the
/// relay JSON on the way in and the frontend on the way out.
#[derive(serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MovieDigest {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub year: Option<i64>,
    #[serde(default)]
    pub tmdb_id: i64,
    #[serde(default)]
    pub imdb_id: Option<String>,
    #[serde(default)]
    pub overview: Option<String>,
    #[serde(default)]
    pub tagline: Option<String>,
    #[serde(default)]
    pub runtime_minutes: Option<i64>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub rating: Option<f64>,
    #[serde(default)]
    pub imdb_rating: Option<f64>,
    #[serde(default)]
    pub rt_rating: Option<i64>,
    #[serde(default)]
    pub poster: Option<String>,
    #[serde(default)]
    pub backdrop: Option<String>,
    #[serde(default)]
    pub trailer_youtube_key: Option<String>,
    #[serde(default)]
    pub cast: Vec<CastMember>,
    #[serde(default)]
    pub director: Option<String>,
}

fn relay_details_url(kind: &str, title: &str, year: Option<i64>) -> String {
    let typ = match kind {
        "show" | "series" | "tv" => "tv",
        "anime" => "anime",
        _ => "movie",
    };
    let mut url = reqwest::Url::parse(&format!("{RELAY_BASE}/details")).expect("valid relay url");
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("type", typ);
        qp.append_pair("title", title);
        if let Some(y) = year {
            qp.append_pair("year", &y.to_string());
        }
    }
    url.into()
}

/// Fetch a movie/show details digest from the relay (it fetches from TMDB/OMDb +
/// caches server-side, so this is keyless and the relay warms its cache for everyone).
pub async fn fetch_details(
    client: &reqwest::Client,
    title: &str,
    year: Option<i64>,
    kind: &str,
) -> anyhow::Result<MovieDigest> {
    let url = relay_details_url(kind, title, year);
    let digest = client.get(&url).send().await?.error_for_status()?.json::<MovieDigest>().await?;
    Ok(digest)
}

/// Fetch the curated featured carousel (each item a full digest) from the relay.
pub async fn fetch_featured(client: &reqwest::Client) -> anyhow::Result<Vec<MovieDigest>> {
    let url = format!("{RELAY_BASE}/featured");
    let list = client.get(&url).send().await?.error_for_status()?.json::<Vec<MovieDigest>>().await?;
    Ok(list)
}

/// Build the relay poster URL for an item. Deterministic by title/year, so it's a
/// stable value to persist and cache.
fn relay_poster_url(kind: &str, title: &str, year: Option<i64>) -> String {
    let typ = match kind {
        "anime" => "anime",
        "game" => "game",
        "show" => "tv",
        _ => "movie",
    };
    let mut url = reqwest::Url::parse(&format!("{RELAY_BASE}/poster")).expect("valid relay url");
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("type", typ);
        qp.append_pair("title", title);
        if let Some(y) = year {
            qp.append_pair("year", &y.to_string());
        }
    }
    url.into()
}

/// Best poster for an item. By default the relay resolves + caches it server-side
/// (no API key needed); the returned URL is the image itself. When the user
/// supplies their own TMDB/OMDb keys we resolve directly instead — a power-user /
/// self-host / offline path.
pub async fn find_poster(
    client: &reqwest::Client,
    title: &str,
    year: Option<i64>,
    kind: &str,
    tmdb_key: Option<&str>,
    omdb_key: Option<&str>,
) -> Option<String> {
    if kind == "music" {
        return itunes_album(client, title).await.ok().flatten();
    }
    // Games: scrape box art from RomsGames first, then ask the relay's game endpoint.
    if kind == "game" {
        if let Ok(Some(u)) = romsgames_box_art(client, title).await {
            return Some(u);
        }
        return Some(relay_poster_url("game", title, year));
    }
    // Anime resolves best via AniList (through the relay's /poster?type=anime);
    // TMDB/OMDb are weak at anime, so route it to the relay regardless of keys.
    if kind == "anime" {
        return Some(relay_poster_url("anime", title, year));
    }
    // Power users with their own keys resolve directly (no relay dependency).
    if tmdb_key.is_some() || omdb_key.is_some() {
        // IMDb (keyless) first as a cheap try, then the supplied keys.
        if let Ok(Some(u)) = imdb_poster(client, title, year, kind == "show").await {
            return Some(u);
        }
        if let Some(k) = tmdb_key {
            if let Ok(Some(u)) = enrich::tmdb_poster(client, k, title, year, kind).await {
                return Some(u);
            }
        }
        if let Some(k) = omdb_key {
            if let Ok(Some(a)) = artwork::omdb_lookup(client, k, title, year, Some(kind)).await {
                if a.poster_url.is_some() {
                    return a.poster_url;
                }
            }
        }
        return None;
    }
    // Default: keyless via the relay. The endpoint IS the image URL.
    Some(relay_poster_url(kind, title, year))
}

// ---------- helpers ----------

fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if matches!(c, ' ' | '-' | '_' | '.' | ':' | '\'') {
            out.push(' ');
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn title_score(want: &str, got: &str) -> i32 {
    if got == want {
        100
    } else if got.starts_with(want) || want.starts_with(got) {
        60
    } else if got.contains(want) || want.contains(got) {
        30
    } else {
        0
    }
}

/// Kind-aware query cleaner: turns a messy release name into the bare title to
/// look up. For shows it cuts at the SxxExx / season marker (so only the series
/// name remains); for everything it drops quality/source/codec/format noise and
/// the trailing year (the year is passed separately).
pub fn clean_for_query(title: &str, kind: &str) -> String {
    let mut t = title.replace(['.', '_'], " ");

    // Shows: keep just the series name, before the season/episode marker.
    if kind == "show" {
        if let Ok(re) = regex::Regex::new(r"(?i)\bs\d{1,2}(\s?e\d{1,2})?\b|\bseason\s*\d|\b\d{1,2}x\d{2}\b") {
            if let Some(m) = re.find(&t) {
                t.truncate(m.start());
            }
        }
    }

    // Anime: strip a leading [fansub-group] / (group) tag, then cut at the episode
    // marker so just the series / film title remains for the AniList lookup.
    if kind == "anime" {
        if let Ok(re) = regex::Regex::new(r"^\s*[\[(][^\])]*[\])]\s*") {
            let stripped = re.replace(&t, "").into_owned();
            t = stripped;
        }
        if let Ok(re) = regex::Regex::new(r"(?i)\s-\s*\d{1,4}\b|\bs\d{1,2}(\s?e\d{1,2})?\b|\bep(isode)?\s*\d{1,4}\b") {
            if let Some(m) = re.find(&t) {
                if m.start() > 0 {
                    t.truncate(m.start());
                }
            }
        }
    }

    // Cut at the first release-noise marker (quality / source / codec / format /
    // group bracket). Guard pos>0 so a title that *starts* with a marker survives.
    const MARKERS: &[&str] = &[
        "1080p", "2160p", "720p", "480p", "4k", "x264", "x265", "h264", "h265", "hevc",
        "bluray", "blu-ray", "web-dl", "webrip", "web ", "hdtv", "telesync", "hdts",
        "dvdrip", "brrip", "bdrip", "xvid", "divx", " aac", " ac3", "dd5", "ddp5", "dts",
        "flac", " mp3", "320kbps", "repack", "proper", "complete", "vostfr", "multi",
        "[", "(", "10bit", "10-bit", "remux", "imax",
    ];
    let lower = t.to_lowercase();
    let mut cut = t.len();
    for m in MARKERS {
        if let Some(pos) = lower.find(m) {
            if pos > 0 && pos < cut {
                cut = pos;
            }
        }
    }
    t.truncate(cut);

    // Drop the trailing year (passed to the API separately).
    if let Ok(re) = regex::Regex::new(r"\b(19|20)\d{2}\b") {
        if let Some(m) = re.find(&t) {
            t.truncate(m.start());
        }
    }
    t.trim().trim_end_matches([' ', '-', '(', '[', ':']).trim().to_string()
}

/// Fansub-group tags + anime markers that strongly imply an anime release
/// (mirrors the frontend's media.ts detection).
fn is_anime(t: &str) -> bool {
    const GROUPS: &[&str] = &[
        "[subsplease]", "[erai-raws]", "[horriblesubs]", "[judas]", "[ember]", "[asw]",
        "[commie]", "[cyc]", "[nyaa]", "[ohys-raws]", "[golumpa]", "[yameii]", "[cleo]", "[sallysubs]",
    ];
    if GROUPS.iter().any(|g| t.contains(g)) {
        return true;
    }
    ["anime", "fansub", "vostfr", "simuldub", "softsub", "hardsub", "crunchyroll"]
        .iter()
        .any(|m| t.contains(m))
}

fn is_game_title(t: &str) -> bool {
    // Console/platform hints and common ROM/container extensions.
    const HINTS: &[&str] = &[
        "playstation", "nintendo", "xbox", "switch", "gamecube", "dreamcast", "atari",
        "romset", "emulator", "psx", "psp", "ps2", "ps3", "ps4", "ps5", "gba", "nds",
        "3ds", "snes", "n64", ".iso", ".chd", ".cue", ".bin", ".cso", ".nsp", ".xci",
        ".gba", ".nds", ".3ds", ".cia", ".z64", ".n64", " rom ", " roms ",
        // PC repacks + scene groups (game-specific; hyphen-anchored so they don't
        // false-positive on movie titles like "Movie.2020.REPACK").
        "fitgirl", "dodi", "-codex", "-plaza", "-skidrow", "-reloaded", "-razor1911",
        "-empress", "-tenoke", "-flt", "-cpy", "-rune", "-hoodlum", "-prophet", "-goldberg",
    ];
    HINTS.iter().any(|h| t.contains(h))
}

/// Guess the media kind from a release title (anime / game / TV / audio hints).
pub fn guess_kind(title: &str) -> &'static str {
    let t = title.to_lowercase();
    // Anime first — AniList (the relay's anime source) covers both films and series.
    if is_anime(&t) {
        return "anime";
    }
    if is_game_title(&t) {
        return "game";
    }
    let is_tv = regex::Regex::new(r"\bs\d{1,2}\s?e\d{1,2}\b|\bs\d{1,2}\b|\bseason\s*\d|\bcomplete\b|\bepisode")
        .ok()
        .map_or(false, |re| re.is_match(&t));
    if is_tv {
        return "show";
    }
    for hint in [".mp3", ".flac", ".m4a", ".aac", ".ogg", ".wav", " flac", " mp3 ", "discography", "320kbps"] {
        if t.contains(hint) {
            return "music";
        }
    }
    "movie"
}

/// Extract a plausible release year from a title.
pub fn year_from_title(title: &str) -> Option<i64> {
    regex::Regex::new(r"\b(19|20)\d{2}\b")
        .ok()?
        .find(title)
        .and_then(|m| m.as_str().parse::<i64>().ok())
}
