//! SQLite-backed catalog: discovered torrents (deduped by infohash) and the
//! configured sources they came from. Mirrors the TS `CatalogItem` / `Source`.

use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::Mutex;

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  url          TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_indexed INTEGER,
  item_count   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  magnet      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  seeders     INTEGER NOT NULL DEFAULT 0,
  leechers    INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'other',
  added_at    INTEGER NOT NULL,
  files       INTEGER,
  poster      TEXT,
  description TEXT,
  year        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_seeders ON items(seeders DESC);
CREATE INDEX IF NOT EXISTS idx_items_added   ON items(added_at DESC);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- AI/artwork enrichment, keyed 1:1 with items.id (infohash). Kept separate so a
-- re-scan never disturbs the raw indexed torrent rows.
CREATE TABLE IF NOT EXISTS meta (
  id          TEXT PRIMARY KEY,
  clean_title TEXT,
  media_type  TEXT,
  imdb_rating REAL,
  rt_rating   INTEGER,
  genre       TEXT,
  quality     TEXT,
  tags        TEXT,            -- JSON array of strings
  organized   INTEGER NOT NULL DEFAULT 0,
  scanned     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER
);
-- Manual poster overrides, keyed by normalized title (so a chosen cover applies to
-- every matching local file / catalog item by name).
CREATE TABLE IF NOT EXISTS poster_overrides (
  title TEXT PRIMARY KEY,
  url   TEXT NOT NULL
);
"#;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub url: String,
    pub enabled: bool,
    pub last_indexed: Option<i64>,
    pub item_count: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub id: String,
    pub title: String,
    pub magnet: String,
    pub size_bytes: i64,
    pub seeders: i64,
    pub leechers: i64,
    pub source: String,
    pub category: String,
    pub added_at: i64,
    pub files: Option<i64>,
    pub poster: Option<String>,
    pub description: Option<String>,
    pub year: Option<i64>,
}

/// AI/artwork enrichment for one item, written by the scan pipeline.
#[derive(Default, Clone)]
pub struct Meta {
    pub clean_title: Option<String>,
    pub media_type: Option<String>,
    pub imdb_rating: Option<f64>,
    pub rt_rating: Option<i64>,
    pub genre: Option<String>,
    pub quality: Option<String>,
    pub tags: Option<String>,
}

/// A catalog item joined with its AI/artwork metadata, for the Library view.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    #[serde(flatten)]
    pub item: CatalogItem,
    pub clean_title: Option<String>,
    pub media_type: Option<String>,
    pub imdb_rating: Option<f64>,
    pub rt_rating: Option<i64>,
    pub genre: Option<String>,
    pub quality: Option<String>,
    pub tags: Option<String>,
}

pub struct Catalog {
    conn: Mutex<Connection>,
}

impl Catalog {
    pub fn open(path: &Path) -> Result<Catalog> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Catalog {
            conn: Mutex::new(conn),
        })
    }

    pub fn list_sources(&self) -> Result<Vec<Source>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, kind, url, enabled, last_indexed, item_count FROM sources ORDER BY name",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Source {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    url: r.get(3)?,
                    enabled: r.get::<_, i64>(4)? != 0,
                    last_indexed: r.get(5)?,
                    item_count: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn add_source(&self, name: &str, kind: &str, url: &str) -> Result<Source> {
        let id = format!("src-{:x}", hash_str(url));
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sources (id, name, kind, url, enabled, item_count)
             VALUES (?1, ?2, ?3, ?4, 1, 0)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind",
            params![id, name, kind, url],
        )?;
        Ok(Source {
            id,
            name: name.to_string(),
            kind: kind.to_string(),
            url: url.to_string(),
            enabled: true,
            last_indexed: None,
            item_count: 0,
        })
    }

    pub fn get_source(&self, id: &str) -> Result<Option<Source>> {
        Ok(self.list_sources()?.into_iter().find(|s| s.id == id))
    }

    pub fn remove_source(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        // also drop items attributed to this source's name
        if let Ok(name) = conn.query_row("SELECT name FROM sources WHERE id=?1", params![id], |r| {
            r.get::<_, String>(0)
        }) {
            conn.execute("DELETE FROM items WHERE source=?1", params![name])?;
        }
        conn.execute("DELETE FROM sources WHERE id=?1", params![id])?;
        Ok(())
    }

    /// Insert/refresh discovered items (keyed by infohash; preserves added_at).
    pub fn upsert_items(&self, items: &[CatalogItem]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for it in items {
            tx.execute(
                "INSERT INTO items
                   (id,title,magnet,size_bytes,seeders,leechers,source,category,added_at,files,poster,description,year)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
                 ON CONFLICT(id) DO UPDATE SET
                   title=excluded.title, magnet=excluded.magnet, size_bytes=excluded.size_bytes,
                   seeders=excluded.seeders, leechers=excluded.leechers, category=excluded.category,
                   files=excluded.files, poster=COALESCE(excluded.poster, items.poster),
                   description=COALESCE(excluded.description, items.description), year=excluded.year",
                params![
                    it.id, it.title, it.magnet, it.size_bytes, it.seeders, it.leechers,
                    it.source, it.category, it.added_at, it.files, it.poster, it.description, it.year
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn set_source_indexed(&self, id: &str, now: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM items WHERE source=(SELECT name FROM sources WHERE id=?1)",
                params![id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        conn.execute(
            "UPDATE sources SET last_indexed=?2, item_count=?3 WHERE id=?1",
            params![id, now, count],
        )?;
        Ok(())
    }

    pub fn list_items(
        &self,
        query: Option<&str>,
        category: Option<&str>,
        sort: &str,
        limit: i64,
    ) -> Result<Vec<CatalogItem>> {
        let order = match sort {
            "recent" => "added_at DESC",
            "size" => "size_bytes DESC",
            "title" => "title COLLATE NOCASE ASC",
            _ => "seeders DESC", // popularity (default)
        };
        let mut sql = String::from(
            "SELECT id,title,magnet,size_bytes,seeders,leechers,source,category,added_at,files,poster,description,year FROM items WHERE 1=1",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(q) = query.filter(|q| !q.is_empty()) {
            sql.push_str(" AND (title LIKE ?1 OR source LIKE ?1)");
            args.push(Box::new(format!("%{q}%")));
        }
        if let Some(c) = category.filter(|c| !c.is_empty() && *c != "all") {
            let p = args.len() + 1;
            sql.push_str(&format!(" AND category = ?{p}"));
            args.push(Box::new(c.to_string()));
        }
        sql.push_str(&format!(" ORDER BY {order} LIMIT {limit}"));

        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let params_ref: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let rows = stmt
            .query_map(params_ref.as_slice(), |r| {
                Ok(CatalogItem {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    magnet: r.get(2)?,
                    size_bytes: r.get(3)?,
                    seeders: r.get(4)?,
                    leechers: r.get(5)?,
                    source: r.get(6)?,
                    category: r.get(7)?,
                    added_at: r.get(8)?,
                    files: r.get(9)?,
                    poster: r.get(10)?,
                    description: r.get(11)?,
                    year: r.get(12)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn count_items(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))?)
    }

    pub fn get_setting(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT value FROM settings WHERE key=?1", params![key], |r| r.get(0))
            .ok()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key,value) VALUES (?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Store a manual poster override for a normalized title.
    pub fn set_poster_override(&self, title: &str, url: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO poster_overrides (title,url) VALUES (?1,?2)
             ON CONFLICT(title) DO UPDATE SET url=excluded.url",
            params![title, url],
        )?;
        // Also stamp any catalog items that share this title so grids reflect it.
        conn.execute("UPDATE items SET poster=?2 WHERE poster IS NULL AND title=?1", params![title, url]).ok();
        Ok(())
    }

    /// All poster overrides as (normalized title, url) pairs.
    pub fn list_poster_overrides(&self) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT title, url FROM poster_overrides")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn clear_items(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("DELETE FROM items", [])?;
        conn.execute("UPDATE sources SET item_count=0", [])?;
        Ok(n)
    }

    /// (id, title) for items lacking a poster — candidates for enrichment.
    pub fn items_needing_poster(&self, limit: i64) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title FROM items WHERE poster IS NULL AND category IN ('video','audio','other') ORDER BY seeders DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Count of items still missing a poster (drives the "N left" progress hint).
    pub fn count_needing_poster(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM items WHERE poster IS NULL AND category IN ('video','audio','other')",
            [],
            |r| r.get(0),
        )?)
    }

    pub fn set_enrichment(
        &self,
        id: &str,
        poster: Option<&str>,
        description: Option<&str>,
        year: Option<i64>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE items SET poster=COALESCE(?2,poster), description=COALESCE(?3,description),
               year=COALESCE(?4,year) WHERE id=?1",
            params![id, poster, description, year],
        )?;
        Ok(())
    }

    // ---- AI / artwork (meta table) ----

    /// (id, title) for items not yet AI-scanned, newest/most-seeded first.
    pub fn items_needing_scan(&self, limit: i64) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT i.id, i.title FROM items i
             LEFT JOIN meta m ON m.id = i.id
             WHERE m.scanned IS NULL OR m.scanned = 0
             ORDER BY i.seeders DESC, i.added_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn count_needing_scan(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM items i LEFT JOIN meta m ON m.id=i.id
             WHERE m.scanned IS NULL OR m.scanned = 0",
            [],
            |r| r.get(0),
        )?)
    }

    /// Upsert AI/artwork metadata for an item and mark it scanned.
    pub fn set_meta(&self, id: &str, m: &Meta, now: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO meta
               (id, clean_title, media_type, imdb_rating, rt_rating, genre, quality, tags, organized, scanned, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,1,?9)
             ON CONFLICT(id) DO UPDATE SET
               clean_title=COALESCE(excluded.clean_title, meta.clean_title),
               media_type =COALESCE(excluded.media_type,  meta.media_type),
               imdb_rating=COALESCE(excluded.imdb_rating, meta.imdb_rating),
               rt_rating  =COALESCE(excluded.rt_rating,   meta.rt_rating),
               genre      =COALESCE(excluded.genre,       meta.genre),
               quality    =COALESCE(excluded.quality,     meta.quality),
               tags       =COALESCE(excluded.tags,        meta.tags),
               organized=1, scanned=1, updated_at=excluded.updated_at",
            params![
                id, m.clean_title, m.media_type, m.imdb_rating, m.rt_rating,
                m.genre, m.quality, m.tags, now
            ],
        )?;
        Ok(())
    }

    /// The cached clean display title for an item, if one has been computed.
    pub fn clean_title_for(&self, id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT clean_title FROM meta WHERE id=?1", params![id], |r| {
            r.get::<_, Option<String>>(0)
        })
        .ok()
        .flatten()
        .filter(|t| !t.trim().is_empty())
    }

    /// The raw (messy) release-name title for an item.
    pub fn raw_title_for(&self, id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT title FROM items WHERE id=?1", params![id], |r| r.get::<_, String>(0)).ok()
    }

    /// Cache a cleaned display title (and optional type/year) for an item WITHOUT marking
    /// it fully scanned — title cleaning is lighter than the full AI scan, so a cleaned
    /// item should not yet surface in the Library.
    pub fn set_clean_title(
        &self,
        id: &str,
        clean_title: &str,
        media_type: Option<&str>,
        year: Option<i64>,
        now: i64,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO meta (id, clean_title, media_type, updated_at)
             VALUES (?1,?2,?3,?4)
             ON CONFLICT(id) DO UPDATE SET
               clean_title=excluded.clean_title,
               media_type =COALESCE(excluded.media_type, meta.media_type),
               updated_at =excluded.updated_at",
            params![id, clean_title, media_type, now],
        )?;
        if let Some(y) = year {
            let _ = conn.execute("UPDATE items SET year=COALESCE(year,?2) WHERE id=?1", params![id, y]);
        }
        Ok(())
    }

    /// Items that have been scanned, joined with their metadata — the Library.
    pub fn list_library(&self, limit: i64) -> Result<Vec<LibraryItem>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT i.id,i.title,i.magnet,i.size_bytes,i.seeders,i.leechers,i.source,i.category,
                    i.added_at,i.files,i.poster,i.description,i.year,
                    m.clean_title,m.media_type,m.imdb_rating,m.rt_rating,m.genre,m.quality,m.tags
             FROM items i JOIN meta m ON m.id = i.id
             WHERE m.scanned = 1
             ORDER BY (i.poster IS NOT NULL) DESC,
                      m.imdb_rating DESC NULLS LAST,
                      i.seeders DESC
             LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(LibraryItem {
                    item: CatalogItem {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        magnet: r.get(2)?,
                        size_bytes: r.get(3)?,
                        seeders: r.get(4)?,
                        leechers: r.get(5)?,
                        source: r.get(6)?,
                        category: r.get(7)?,
                        added_at: r.get(8)?,
                        files: r.get(9)?,
                        poster: r.get(10)?,
                        description: r.get(11)?,
                        year: r.get(12)?,
                    },
                    clean_title: r.get(13)?,
                    media_type: r.get(14)?,
                    imdb_rating: r.get(15)?,
                    rt_rating: r.get(16)?,
                    genre: r.get(17)?,
                    quality: r.get(18)?,
                    tags: r.get(19)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

fn hash_str(s: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}
