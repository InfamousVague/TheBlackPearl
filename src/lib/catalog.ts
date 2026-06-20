import type { Category, CatalogItem, SortKey, SortOption, Source } from "./types";

export const SORT_OPTIONS: SortOption[] = [
  { key: "popularity", label: "Popularity" },
  { key: "recent", label: "Recently added" },
  { key: "size", label: "Size" },
  { key: "title", label: "Title" },
];

export const CATEGORY_LABEL: Record<Category, string> = {
  video: "Video",
  audio: "Audio",
  software: "Software",
  books: "Books",
  data: "Datasets",
  other: "Other",
};

/**
 * Best-effort guess (from the title) of whether a torrent plays natively in the
 * webview (MP4/WebM) or will need on-the-fly conversion (MKV/x265/AVI/…). Only the
 * title is known before downloading, so this is heuristic.
 */
export function streamFormat(title: string): "native" | "convert" {
  const t = title.toLowerCase();
  if (/\bmp4\b|\.mp4|\bwebm\b|\.webm|\bm4v\b/.test(t)) return "native";
  return "convert";
}

export type Quality = "4K" | "1080p" | "720p" | "SD";
export const QUALITIES: Quality[] = ["4K", "1080p", "720p", "SD"];

/** Resolution class parsed from a release title — powers the Discover quality filter. */
export function qualityOf(title: string): Quality | null {
  const t = title.toLowerCase();
  if (/\b(?:2160p|4k|uhd)\b/.test(t)) return "4K";
  if (/\b1080p\b/.test(t)) return "1080p";
  if (/\b720p\b/.test(t)) return "720p";
  if (/\b(?:480p|360p|sd|dvdrip|dvdscr|xvid)\b/.test(t)) return "SD";
  return null;
}

/**
 * Instant, offline title clean — a JS mirror of the Rust `enrich::clean_title`. Strips
 * dots/underscores and cuts at the first quality/year marker so a messy release name reads
 * as a human title right away, before the sharper LLM-cleaned version arrives.
 */
export function cleanRelease(raw: string): string {
  if (!raw) return raw;
  // Drop a trailing file extension ("Big Buck Bunny.mkv" → "Big Buck Bunny"). Seeded-share
  // titles are raw file basenames, so without this the relay poster lookup queries "… mkv"
  // and misses — the cause of blank thumbnails on the Seeding/Downloads cards.
  const noExt = raw.replace(
    /\.(mkv|mp4|m4v|avi|mov|webm|wmv|flv|mpg|mpeg|ts|m2ts|iso|zip|rar|7z|tar|gz|epub|pdf|mobi|azw3?|cbz|cbr|mp3|flac|m4a|aac|ogg|opus|wav|exe|dmg|pkg|apk)$/i,
    "",
  );
  let t = noExt.replace(/[._]/g, " ");
  const lower = t.toLowerCase();
  let cut = t.length;
  for (const m of [
    "(", "[", "1080p", "720p", "2160p", "480p", "4k", "x264", "x265", "h264", "h265",
    "hevc", "bluray", "blu-ray", "web-dl", "webrip", "web dl", "hdtv", "dvdrip", "brrip", "bdrip", "xvid",
  ]) {
    const i = lower.indexOf(m);
    if (i > 0) cut = Math.min(cut, i);
  }
  const ym = t.match(/\b(?:19|20)\d{2}\b/);
  if (ym && ym.index !== undefined && ym.index > 0) cut = Math.min(cut, ym.index);
  const se = t.match(/\bS\d{1,2}\s?E\d{1,3}\b/i) ?? t.match(/\bSeason\s+\d+/i);
  if (se && se.index !== undefined && se.index > 0) cut = Math.min(cut, se.index);
  t = t.slice(0, cut).replace(/[\s\-–_]+$/, "").trim();
  return t || raw.trim();
}

/** A captured episode number that's actually a year or a video resolution, not an episode. */
function notAnEpisode(n: number): boolean {
  return (n >= 1900 && n <= 2099) || n === 2160 || n === 1080 || n === 720 || n === 480 || n === 360 || n === 240;
}

/**
 * Pull season/episode out of a raw release name. Handles S01E02, 1x02, "Season 1 Episode 2",
 * anime forms with an explicit season ("S2 - 23", batch "S2 (01-10)"), and — crucially for
 * single-cour anime — a bare dash-delimited episode with no season at all ("Title - 28").
 * `episodeEnd` is set for batch ranges. Returns all-null for non-episodic titles (movies,
 * music). Used to keep the episode visible after the clean title has stripped it.
 */
export function parseSeasonEpisode(
  raw: string,
): { season: number | null; episode: number | null; episodeEnd: number | null } {
  const none = { season: null, episode: null, episodeEnd: null };
  if (!raw) return none;
  // Drop a leading [fansub-group] tag so its contents can't be mistaken for an episode.
  const t = raw.replace(/^\[[^\]]*\]\s*/, "").replace(/[._]/g, " ");

  // 1) S01E02 / S1 E2, optionally a range (S01E02-E05).
  let m = t.match(/\bS(\d{1,2})\s?E(\d{1,3})(?:\s?[-–]\s?E?(\d{1,3}))?\b/i);
  if (m) return { season: +m[1], episode: +m[2], episodeEnd: m[3] ? +m[3] : null };
  // 2) 1x02
  m = t.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (m) return { season: +m[1], episode: +m[2], episodeEnd: null };
  // 3) Season 1 Episode 2
  m = t.match(/\bseason\s+(\d{1,2})\b.*?\bepisode\s+(\d{1,3})\b/i);
  if (m) return { season: +m[1], episode: +m[2], episodeEnd: null };
  // 4) anime with an explicit season: "S2 - 23", or a batch "S2 (01-10)".
  m = t.match(/\bS(\d{1,2})\s*[-–(]\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/i);
  if (m) return { season: +m[1], episode: +m[2], episodeEnd: m[3] ? +m[3] : null };
  // 5) single-cour anime, no season marker: "Title - 28", "Title (01-12)" (batch). Must be
  //    dash- or paren-delimited; reject numbers that are really a year or a resolution.
  m = t.match(/(?:\s[-–]\s*|\()(\d{1,4})(?:v\d+)?(?:\s*[-–]\s*(\d{1,4}))?\s*(?:[)\]([]|$|\s)/);
  if (m) {
    const ep = +m[1];
    const end = m[2] ? +m[2] : null;
    if (!notAnEpisode(ep) && (end == null || !notAnEpisode(end))) {
      return { season: null, episode: ep, episodeEnd: end };
    }
  }
  // 6) season-only packs.
  m = t.match(/\bseason\s+(\d{1,2})\b/i);
  if (m) return { season: +m[1], episode: null, episodeEnd: null };
  m = t.match(/\bS(\d{1,2})\b(?![\dEe])/i);
  if (m) return { season: +m[1], episode: null, episodeEnd: null };
  return none;
}

/**
 * Compact episode label from a raw title: "S5 · E14", a batch "S2 · E01–10", a bare
 * "E28" (anime single cour with no season), or "Season 5" for a season pack. "" when not
 * episodic. Episode numbers are zero-padded to two digits (anime convention).
 */
export function seasonEpisodeLabel(raw: string): string {
  const { season, episode, episodeEnd } = parseSeasonEpisode(raw);
  const pad = (n: number) => String(n).padStart(2, "0");
  const ep =
    episode == null
      ? ""
      : episodeEnd != null && episodeEnd !== episode
        ? `E${pad(episode)}–${pad(episodeEnd)}`
        : `E${pad(episode)}`;
  if (season == null) return ep; // bare episode — show just the episode
  if (!ep) return `Season ${season}`;
  return `S${season} · ${ep}`;
}

/** Stable hue derived from a string, used for placeholder poster gradients. */
export function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function sortCatalog(items: CatalogItem[], key: SortKey): CatalogItem[] {
  const sorted = [...items];
  switch (key) {
    case "popularity":
      return sorted.sort((a, b) => b.seeders - a.seeders);
    case "recent":
      return sorted.sort((a, b) => b.addedAt - a.addedAt);
    case "size":
      return sorted.sort((a, b) => b.sizeBytes - a.sizeBytes);
    case "title":
      return sorted.sort((a, b) => a.title.localeCompare(b.title));
  }
}

/** Sort library items in place by best available rating (IMDb, then RT), desc. */
export function sortByRating<T extends { imdbRating?: number | null; rtRating?: number | null; seeders: number }>(
  items: T[],
): T[] {
  const score = (x: T) =>
    x.imdbRating != null ? x.imdbRating : x.rtRating != null ? x.rtRating / 10 : -1;
  return items.sort((a, b) => {
    const d = score(b) - score(a);
    return d !== 0 ? d : b.seeders - a.seeders;
  });
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY = 86_400_000;
// A fixed "now" so the mock timeline reads consistently regardless of when it renders.
const T0 = 1_749_900_000_000; // ~mid June 2026

function magnet(hash: string, name: string): string {
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`;
}

// Tracker set for the real, well-seeded public-domain test torrents below.
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://explodie.org:6969/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
];
function realMagnet(hash: string, name: string, webseed?: string): string {
  const tr = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  const ws = webseed ? `&ws=${encodeURIComponent(webseed)}` : "";
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${tr}${ws}`;
}
const BLENDER_WS = "https://webtorrent.io/torrents/";

// --- Seed catalog: legal / public-domain / open content only ---
// (Mirrors the default legal sources: Internet Archive, Academic Torrents, Linux trackers.)
export const MOCK_CATALOG: CatalogItem[] = [
  {
    id: "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c",
    title: "Big Buck Bunny (2008)",
    magnet: realMagnet("dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c", "Big Buck Bunny", BLENDER_WS),
    sizeBytes: 1.1 * GB, seeders: 3940, leechers: 88, source: "archive.org",
    category: "video", addedAt: T0 - 1 * DAY, files: 3, year: 2008,
    description: "Blender Foundation open movie. Public domain.",
  },
  {
    id: "08ada5a7a6183aae1e09d831df6748d566095a10",
    title: "Sintel (2010) — 1080p",
    magnet: realMagnet("08ada5a7a6183aae1e09d831df6748d566095a10", "Sintel", BLENDER_WS),
    sizeBytes: 1.9 * GB, seeders: 2715, leechers: 64, source: "archive.org",
    category: "video", addedAt: T0 - 9 * DAY, files: 2, year: 2010,
    description: "Durian open movie project, Blender Foundation. CC-BY.",
  },
  {
    id: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8091011121314",
    title: "NASA Apollo 11 — Restored Mission Footage",
    magnet: magnet("e5f6a7b8c9d0e1f2a3b4c5d6e7f8091011121314", "apollo-11-restored"),
    sizeBytes: 12.4 * GB, seeders: 1880, leechers: 240, source: "archive.org",
    category: "video", addedAt: T0 - 4 * DAY, files: 17, year: 1969,
    description: "Public-domain footage courtesy of NASA.",
  },
  {
    id: "f6a7b8c9d0e1f2a3b4c5d6e7f809101112131415",
    title: "ImageNet Object Localization (sample)",
    magnet: magnet("f6a7b8c9d0e1f2a3b4c5d6e7f809101112131415", "imagenet-sample"),
    sizeBytes: 42 * GB, seeders: 612, leechers: 95, source: "academictorrents.com",
    category: "data", addedAt: T0 - 14 * DAY, files: 1431, year: 2012,
    description: "Research dataset distributed via Academic Torrents.",
  },
  {
    id: "07b8c9d0e1f2a3b4c5d6e7f80910111213141516",
    title: "LibriVox — Pride and Prejudice (audiobook)",
    magnet: magnet("07b8c9d0e1f2a3b4c5d6e7f80910111213141516", "librivox-pride-prejudice"),
    sizeBytes: 612 * MB, seeders: 894, leechers: 12, source: "archive.org",
    category: "audio", addedAt: T0 - 20 * DAY, files: 61, year: 1813,
    description: "Public-domain recording from LibriVox volunteers.",
  },
  {
    id: "209c8226b299b308beaf2b9cd3fb49212dbd13ec",
    title: "Tears of Steel (2012)",
    magnet: realMagnet("209c8226b299b308beaf2b9cd3fb49212dbd13ec", "Tears of Steel", BLENDER_WS),
    sizeBytes: 2.3 * GB, seeders: 1320, leechers: 51, source: "archive.org",
    category: "video", addedAt: T0 - 3 * DAY, files: 2, year: 2012,
    description: "Mango open movie project, Blender Foundation. CC-BY.",
  },
  {
    id: "3ae1f2a3b4c5d6e7f80910111213141516171819",
    title: "MIT 6.006 Introduction to Algorithms — Lectures",
    magnet: magnet("3ae1f2a3b4c5d6e7f80910111213141516171819", "mit-6006-lectures"),
    sizeBytes: 8.7 * GB, seeders: 740, leechers: 33, source: "academictorrents.com",
    category: "video", addedAt: T0 - 11 * DAY, files: 24, year: 2011,
    description: "MIT OpenCourseWare lecture recordings. CC-BY-NC-SA.",
  },
];

export const MOCK_SOURCES: Source[] = [
  { id: "src-ia", name: "archive.org", kind: "scraper", url: "https://archive.org/search?query=mediatype:movies", enabled: true, lastIndexed: T0 - 3600_000, itemCount: 5 },
  { id: "src-at", name: "academictorrents.com", kind: "adapter", url: "https://academictorrents.com/browse.php", enabled: true, lastIndexed: T0 - 7200_000, itemCount: 2 },
  { id: "src-lt", name: "linuxtracker.org", kind: "torznab", url: "https://linuxtracker.org/api/torznab", enabled: true, lastIndexed: T0 - 1800_000, itemCount: 3 },
];
