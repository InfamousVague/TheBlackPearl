// Coarse media classification, mirrored on the Rust side (engine.rs `media_kind`).
// Decides how an item plays: a video opens the video player, music opens the
// audio player, and everything else (software, disk images, books, archives…)
// is download-only and must never be sent to the encoder.
import type { Category } from "./types";

export type MediaKind = "video" | "audio" | "other";

const VIDEO_EXT = new Set([
  "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg",
  "m2ts", "mts", "ts", "ogv", "3gp", "vob", "divx", "rmvb", "asf",
]);
const AUDIO_EXT = new Set([
  "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "wma", "alac",
  "aiff", "aif", "ape", "mka",
]);
// Explicitly non-media — forces "other" even if the indexer mis-categorized it.
const OTHER_EXT = new Set([
  "iso", "img", "dmg", "exe", "msi", "pkg", "deb", "rpm", "apk", "app", "bin",
  "zip", "rar", "7z", "tar", "gz", "epub", "pdf", "mobi", "azw3", "cbz", "cbr",
  "nsp", "xci", "rom", "wad",
]);

/**
 * Best-effort media class from a release title + the indexer's category. A real
 * file extension in the title wins (it's the strongest signal); otherwise the
 * category decides, defaulting to video for unknown catalog content.
 */
export function mediaKind(title: string, category?: Category): MediaKind {
  const tokens = title.toLowerCase().match(/\.([a-z0-9]{2,4})(?=[^a-z0-9]|$)/g);
  if (tokens) {
    // Scan from the end — the real extension is the last dotted token.
    for (let i = tokens.length - 1; i >= 0; i--) {
      const ext = tokens[i].slice(1);
      if (VIDEO_EXT.has(ext)) return "video";
      if (AUDIO_EXT.has(ext)) return "audio";
      if (OTHER_EXT.has(ext)) return "other";
    }
  }
  switch (category) {
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "software":
    case "books":
    case "data":
    case "other":
      return "other";
    default:
      return "video";
  }
}

// ---- top-level libraries (Movies / TV Shows / Music / Books / Games) ----

export type MediaSectionId = "movies" | "tvshows" | "music" | "books" | "games";

// Series/episode markers that distinguish a TV show from a movie.
const TV_RE = /(\bs\d{1,2}\s?e\d{1,2}\b|\bs\d{1,2}\b|\bseason\s*\d|\bcomplete\s+series\b|\bepisodes?\b|\b\d{1,2}x\d{2}\b)/i;
const GAME_EXT = new Set([
  "nsp", "xci", "3ds", "cia", "nds", "gba", "gbc", "gb", "nes", "sfc", "smc",
  "n64", "z64", "vpk", "wad", "xex", "cso", "pbp", "rom", "iso",
]);
const GAME_HINT_RE = /\b(repack|fitgirl|dodi|steamrip|gog|nintendo|switch|xbox|playstation|ps[345]|romset)\b/i;

function isGameRelease(title: string): boolean {
  const t = title.toLowerCase();
  const tokens = t.match(/\.([a-z0-9]{2,4})(?=[^a-z0-9]|$)/g);
  if (tokens) {
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (GAME_EXT.has(tokens[i].slice(1))) return true;
    }
  }
  return GAME_HINT_RE.test(t);
}

/**
 * Which top-level library an item belongs to. The AI scan's `mediaType` wins when
 * present; otherwise fall back to `mediaKind` + pattern heuristics. Non-AV content
 * (ISOs, installers, archives, datasets…) returns "other" and is shown in no
 * section.
 */
export function sectionOf(item: {
  title: string;
  category?: Category;
  mediaType?: string | null;
}): MediaSectionId | "other" {
  const mt = item.mediaType?.toLowerCase();
  if (mt === "movie") return "movies";
  if (mt === "show" || mt === "series" || mt === "tv") return "tvshows";
  if (mt === "music") return "music";
  if (mt === "game" || mt === "games") return "games";
  if (mt === "book" || mt === "ebook") return "books";
  if (item.category === "books") return "books";
  if ((item.category === "software" || item.category === "data" || item.category === "other") && isGameRelease(item.title)) {
    return "games";
  }
  const kind = mediaKind(item.title, item.category);
  if (kind === "audio") return "music";
  if (kind === "video") return TV_RE.test(item.title) ? "tvshows" : "movies";
  return "other";
}

export interface ParsedEpisode {
  /** Best-effort show name to look up (TVMaze), release noise stripped. */
  show: string;
  season: number;
  episode: number;
}

/** Tidy a captured show name for a metadata lookup — undo dotted releases, drop a
 *  parenthesised year and trailing separators, but keep bare years so titles like
 *  "1923" survive. */
function cleanShowName(s: string): string {
  return s
    .replace(/[._]+/g, " ")
    .replace(/\(\s*\d{4}\s*\)/g, " ")
    .replace(/[\-–—:|]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull `{ show, season, episode }` out of a messy release title, or null if it isn't
 * an episode. Handles `S01E02` / `S1 E2`, `1x02`, and `Season 1 … Episode 2`. The
 * show name is everything before the marker (release tags trail the marker, not it).
 */
export function parseEpisode(title: string): ParsedEpisode | null {
  const t = title.replace(/[._]+/g, " ");
  let m = t.match(/^(.*?)\bs(\d{1,2})\s*[\s.\-_]?e(\d{1,3})\b/i);
  if (m) return { show: cleanShowName(m[1]), season: +m[2], episode: +m[3] };
  m = t.match(/^(.*?)\b(\d{1,2})x(\d{2,3})\b/i);
  if (m) return { show: cleanShowName(m[1]), season: +m[2], episode: +m[3] };
  m = t.match(/^(.*?)\bseason\s*(\d{1,2})\b.*?\bepisode\s*(\d{1,3})\b/i);
  if (m) return { show: cleanShowName(m[1]), season: +m[2], episode: +m[3] };
  return null;
}

export interface ParsedAnimeEpisode {
  show: string;
  /** Absolute episode number (anime numbers continuously, not per-season). */
  episode: number;
}

/**
 * Pull `{ show, episode }` from an anime release title, which numbers episodes
 * absolutely rather than with S/E — e.g. `[SubsPlease] Sousou no Frieren - 28 (1080p)`,
 * `Title Episode 28`, `Title #28`. Returns null if no episode number is found.
 */
export function parseAnimeEpisode(title: string): ParsedAnimeEpisode | null {
  // Drop leading release-group tags ("[SubsPlease] …") and a file extension.
  let t = title.replace(/[._]+/g, " ").replace(/^\s*(?:\[[^\]]*\]\s*)+/g, "");
  t = t.replace(/\.(mkv|mp4|avi|webm|m4v)$/i, "").trim();
  const ok = (show: string, ep: number): ParsedAnimeEpisode | null =>
    // Reject 4-digit "episodes" that are obviously a year.
    ep >= 1 && !(ep >= 1900 && ep <= 2100) ? { show: cleanShowName(show), episode: ep } : null;

  // "Title - 28", "Title - 28v2", "Title – 28 (1080p)" — the dominant fansub pattern.
  let m = t.match(/^(.*?)\s[-–—]\s(\d{1,4})(?:v\d+)?(?=\s|\(|\[|$)/);
  if (m) return ok(m[1], +m[2]);
  // "Title Episode 28" / "Title Ep 28" / "Title #28".
  m = t.match(/^(.*?)\b(?:episode|ep)\.?\s*(\d{1,4})\b/i);
  if (m) return ok(m[1], +m[2]);
  m = t.match(/^(.*?)#(\d{1,4})\b/);
  if (m) return ok(m[1], +m[2]);
  // Last resort: a bare trailing number before quality/format tags ("Title 28 [1080p]").
  m = t.match(/^(.*?)\s(\d{1,4})(?=\s*[([]|$)/);
  if (m) return ok(m[1], +m[2]);
  return null;
}

export type SectionSort = "popularity" | "rating" | "recent" | "title";

export const SECTION_LABEL: Record<MediaSectionId, string> = {
  movies: "Movies",
  tvshows: "TV Shows",
  music: "Music",
  books: "Books",
  games: "Games",
};

/** The Discover category switcher. "anime" is a cross-cutting filter (not a section); the
 *  rest map to `MediaSectionId`. Order + labels are what the toggle renders. */
export type DiscoverTab = "all" | MediaSectionId | "anime";
export const DISCOVER_TABS: { id: DiscoverTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "tvshows", label: "Shows" },
  { id: "anime", label: "Anime" },
  { id: "movies", label: "Movies" },
  { id: "music", label: "Music" },
  { id: "books", label: "Books" },
  { id: "games", label: "Games" },
];

// ---- Anime (cross-cutting: spans Movies + TV, so it's a filter, not a section) ----

// Common fansub / release-group tags that all but guarantee an anime release.
const ANIME_GROUP_RE = /\[(?:subsplease|erai-raws|horriblesubs|judas|ember|asw|commie|cyc|nyaa|anime\s?time|ohys-raws|golumpa|yameii|cleo|sallysubs)\]/i;
// Anime-specific release markers (NOT generic "raw"/"dub" which over-match).
const ANIME_HINT_RE = /\b(?:anime|fansub|vostfr|simuldub|softsub|hardsub|crunchyroll)\b/i;

/**
 * Best-effort "is this anime?" for an item. Anime overlaps Movies + TV (an anime
 * film is still a movie), so this is a cross-cutting predicate the Anime section
 * and the Discover anime row filter on — not a `MediaSectionId`. Signals, in order:
 * an explicit `anime` genre, a known fansub group tag, or `animation` + an
 * anime-specific release marker.
 */
/** Normalize a title for fuzzy matching: lowercase, drop "the", strip punctuation. */
function normAnime(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bthe\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Downloaded video carries no anime metadata (genres are TMDB-style like "Animation",
// which also covers Western cartoons; and the AI genre isn't joined to on-disk items). So
// for titles without a fansub tag we match against well-known anime (English + romaji).
// This is a heuristic safety net — the robust fix is an AniList/Jikan classifier at scan time.
const KNOWN_ANIME = [
  "apothecary diaries", "tongari boushi", "witch hat atelier", "frieren", "spy x family",
  "jujutsu kaisen", "demon slayer", "kimetsu no yaiba", "chainsaw man", "dandadan",
  "attack on titan", "shingeki no kyojin", "one piece", "naruto", "bleach", "dragon ball",
  "my hero academia", "boku no hero", "death note", "fullmetal alchemist", "hunter x hunter",
  "one punch man", "mob psycho", "vinland saga", "oshi no ko", "blue lock", "solo leveling",
  "mushoku tensei", "re zero", "konosuba", "overlord", "reincarnated as a slime", "tensura",
  "bocchi", "cyberpunk edgerunners", "cowboy bebop", "evangelion", "sword art online",
  "tokyo ghoul", "fairy tail", "black clover", "dr stone", "fire force", "haikyu",
  "kaguya sama", "horimiya", "komi can", "made in abyss", "steins gate", "jojo",
  "spy classroom", "dungeon meshi", "delicious in dungeon", "kaiju no 8", "wind breaker",
].map(normAnime);

export function isAnime(item: { title: string; genre?: string | null }): boolean {
  const g = (item.genre ?? "").toLowerCase();
  if (g.includes("anime")) return true;
  if (ANIME_GROUP_RE.test(item.title)) return true;
  if (/\banime\b/i.test(item.title)) return true;
  if (g.includes("animation") && ANIME_HINT_RE.test(item.title)) return true;
  const n = normAnime(item.title);
  if (n && KNOWN_ANIME.some((k) => n.includes(k))) return true;
  return false;
}

/** Genre chips for the Anime browse hub — each runs a live source search. */
export const ANIME_GENRES = [
  "Anime", "Shonen", "Shojo", "Isekai", "Slice of Life", "Mecha",
  "Romance", "Action", "Fantasy", "Seinen", "Sports", "Movie",
];

/** Distinct genres present across items (from the AI `genre` field), sorted, capped. */
export function genresOf(items: { genre?: string | null }[]): string[] {
  const set = new Set<string>();
  for (const it of items) {
    if (!it.genre) continue;
    for (const g of it.genre.split(/[,/]/).map((s) => s.trim()).filter(Boolean)) set.add(g);
  }
  return [...set].sort((a, b) => a.localeCompare(b)).slice(0, 24);
}
