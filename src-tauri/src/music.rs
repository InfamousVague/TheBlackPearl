//! Keyless music discovery via the iTunes Search API — artists → albums → tracks.
//! No API key (same source `posters.rs` already uses for album art). The user browses
//! an artist's real discography, then searches their torrent sources for the albums and
//! songs that actually exist. Mirrors `tvmaze.rs` for the TV-show finder.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// ---- raw iTunes shapes (only the fields we use; unknown fields are ignored) ----

#[derive(Deserialize)]
struct ArtistRaw {
    // Optional so one malformed row can't fail the whole array's deserialization.
    #[serde(rename = "artistId")]
    artist_id: Option<i64>,
    #[serde(rename = "artistName")]
    artist_name: Option<String>,
    #[serde(rename = "primaryGenreName")]
    primary_genre: Option<String>,
}

#[derive(Deserialize)]
struct AlbumRaw {
    // The artist-lookup response leads with the artist record (wrapperType "artist") and
    // then lists every release (wrapperType "collection"); every field is optional so the
    // leading artist row deserializes harmlessly and is filtered out below.
    #[serde(rename = "wrapperType")]
    wrapper_type: Option<String>,
    #[serde(rename = "collectionId")]
    collection_id: Option<i64>,
    #[serde(rename = "collectionName")]
    collection_name: Option<String>,
    #[serde(rename = "artistName")]
    artist_name: Option<String>,
    #[serde(rename = "artworkUrl100")]
    artwork: Option<String>,
    #[serde(rename = "releaseDate")]
    release_date: Option<String>,
    #[serde(rename = "trackCount")]
    track_count: Option<i64>,
}

#[derive(Deserialize)]
struct TrackRaw {
    // Likewise leads with the collection record, then one row per track ("track").
    #[serde(rename = "wrapperType")]
    wrapper_type: Option<String>,
    #[serde(rename = "trackId")]
    track_id: Option<i64>,
    #[serde(rename = "trackName")]
    track_name: Option<String>,
    #[serde(rename = "trackNumber")]
    track_number: Option<i64>,
    #[serde(rename = "discNumber")]
    disc_number: Option<i64>,
    #[serde(rename = "trackTimeMillis")]
    track_time: Option<i64>,
}

#[derive(Deserialize)]
struct SearchResp {
    results: Vec<ArtistRaw>,
}
#[derive(Deserialize)]
struct LookupResp<T> {
    results: Vec<T>,
}

// ---- wire types (camelCase to TS) ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: i64,
    pub name: String,
    pub genre: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: i64,
    pub name: String,
    pub artist: String,
    pub year: Option<i64>,
    pub poster: Option<String>,
    pub track_count: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub name: String,
    pub number: i64,
    pub disc: i64,
    pub duration_ms: i64,
}

fn hi_res(art: &str) -> String {
    // iTunes returns 100x100 thumbnails; this token swap fetches a sharp cover.
    art.replace("100x100bb", "600x600bb")
}

/// Search iTunes for recording artists matching `query`. Keyless.
pub async fn search_artists(client: &reqwest::Client, query: &str) -> Result<Vec<Artist>> {
    let resp: SearchResp = client
        .get("https://itunes.apple.com/search")
        .query(&[
            ("term", query),
            ("entity", "musicArtist"),
            ("limit", "24"),
            ("country", "US"),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp
        .results
        .into_iter()
        .filter_map(|a| {
            Some(Artist {
                id: a.artist_id?,
                name: a.artist_name.filter(|n| !n.is_empty())?,
                genre: a.primary_genre.filter(|g| !g.is_empty()),
            })
        })
        .collect())
}

/// An artist's albums, newest first, de-duplicated across deluxe/remastered editions.
pub async fn artist_albums(client: &reqwest::Client, artist_id: i64) -> Result<Vec<Album>> {
    let id = artist_id.to_string();
    let resp: LookupResp<AlbumRaw> = client
        .get("https://itunes.apple.com/lookup")
        .query(&[
            ("id", id.as_str()),
            ("entity", "album"),
            ("limit", "120"),
            ("country", "US"),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let mut seen: HashSet<String> = HashSet::new();
    let mut albums: Vec<Album> = resp
        .results
        .into_iter()
        .filter(|r| r.wrapper_type.as_deref() == Some("collection"))
        .filter_map(|r| {
            let id = r.collection_id?;
            let name = r.collection_name?;
            // Collapse "(Deluxe)", "(Remastered)", "(Explicit)" variants to one entry.
            let key = dedup_key(&name);
            if !seen.insert(key) {
                return None;
            }
            Some(Album {
                id,
                name,
                artist: r.artist_name.unwrap_or_default(),
                year: r
                    .release_date
                    .as_deref()
                    .and_then(|d| d.get(0..4))
                    .and_then(|y| y.parse().ok()),
                poster: r.artwork.filter(|a| !a.is_empty()).map(|a| hi_res(&a)),
                track_count: r.track_count.unwrap_or(0),
            })
        })
        .collect();
    albums.sort_by(|a, b| b.year.cmp(&a.year));
    Ok(albums)
}

/// Every track on an album, in order. Keyless.
pub async fn album_tracks(client: &reqwest::Client, album_id: i64) -> Result<Vec<Track>> {
    let id = album_id.to_string();
    let resp: LookupResp<TrackRaw> = client
        .get("https://itunes.apple.com/lookup")
        .query(&[("id", id.as_str()), ("entity", "song"), ("country", "US")])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let mut tracks: Vec<Track> = resp
        .results
        .into_iter()
        .filter(|r| r.wrapper_type.as_deref() == Some("track"))
        .filter_map(|r| {
            Some(Track {
                id: r.track_id?,
                name: r.track_name?,
                number: r.track_number.unwrap_or(0),
                disc: r.disc_number.unwrap_or(1),
                duration_ms: r.track_time.unwrap_or(0),
            })
        })
        .collect();
    tracks.sort_by(|a, b| (a.disc, a.number).cmp(&(b.disc, b.number)));
    Ok(tracks)
}

/// Normalized album name for de-duplication: lowercase, parentheticals stripped.
fn dedup_key(name: &str) -> String {
    let no_paren = regex::Regex::new(r"\s*[\(\[][^\)\]]*[\)\]]")
        .map(|re| re.replace_all(name, "").into_owned())
        .unwrap_or_else(|_| name.to_string());
    no_paren.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}
