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

// ---- top-level libraries (Movies / TV Shows / Music) ----

export type MediaSectionId = "movies" | "tvshows" | "music";

// Series/episode markers that distinguish a TV show from a movie.
const TV_RE = /(\bs\d{1,2}\s?e\d{1,2}\b|\bs\d{1,2}\b|\bseason\s*\d|\bcomplete\s+series\b|\bepisodes?\b|\b\d{1,2}x\d{2}\b)/i;

/**
 * Which top-level library an item belongs to. The AI scan's `mediaType` wins when
 * present; otherwise fall back to `mediaKind` + pattern heuristics. Non-AV content
 * (ISOs, installers, archives, books, datasets…) returns "other" and is shown in no
 * section — the app only browses Movies / TV / Music.
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

export type SectionSort = "popularity" | "rating" | "recent" | "title";

export const SECTION_LABEL: Record<MediaSectionId, string> = {
  movies: "Movies",
  tvshows: "TV Shows",
  music: "Music",
};

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
export function isAnime(item: { title: string; genre?: string | null }): boolean {
  const g = (item.genre ?? "").toLowerCase();
  if (g.includes("anime")) return true;
  if (ANIME_GROUP_RE.test(item.title)) return true;
  if (/\banime\b/i.test(item.title)) return true;
  if (g.includes("animation") && ANIME_HINT_RE.test(item.title)) return true;
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
