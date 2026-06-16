import type { DownloadedItem } from "../ipc/library";

// Preview-only fixture. The real library comes from the Rust backend
// (`list_downloaded`); outside Tauri that returns nothing, so the browser
// preview would render every library view empty. This gives the Music / Library
// previews realistic content (artists, albums, genres) to lay out against. It is
// NEVER used in the shipped desktop app — `useDownloaded` only falls back to it
// when `!IN_TAURI`.
interface AlbumSpec {
  artist: string;
  album: string;
  genre: string;
  daysAgo: number;
  tracks: string[];
}

const ALBUMS: AlbumSpec[] = [
  { artist: "Midnight Cartographers", album: "Atlas of Sleep", genre: "Indie", daysAgo: 1, tracks: ["Compass Rose", "Slow Tide", "Paper Lanterns", "Northbound", "Harbor Lights", "Atlas of Sleep"] },
  { artist: "Solar Fields", album: "Movements", genre: "Electronic", daysAgo: 2, tracks: ["Ascent", "Drift", "Aurora", "Parallel", "Movements"] },
  { artist: "River Tides", album: "Lagoon", genre: "Funk", daysAgo: 4, tracks: ["Shoreline", "Undertow", "Lagoon", "Saltwater", "Currents", "Low Tide"] },
  { artist: "Wildwood Choir", album: "Birdsong", genre: "Folk", daysAgo: 6, tracks: ["Morning Lark", "Cedar & Pine", "Birdsong", "Hollow Oak", "Wren"] },
  { artist: "Astral Brass", album: "Supernova Hymns", genre: "Jazz", daysAgo: 9, tracks: ["First Light", "Nebula Walk", "Supernova Hymn", "Brass Comet", "Event Horizon"] },
  { artist: "Glasshouse", album: "Migration Patterns", genre: "Electronic", daysAgo: 12, tracks: ["Departure", "Flyway", "Migration", "Thermals", "Return"] },
  { artist: "Dawnwave", album: "Horizon", genre: "Ambient", daysAgo: 18, tracks: ["Pale Blue", "Horizon", "Stillwater", "Daybreak"] },
  { artist: "Midnight Cartographers", album: "Northern Lines", genre: "Indie", daysAgo: 24, tracks: ["Meridian", "Frostlight", "Northern Lines", "Cold Stars", "Glacier"] },
  { artist: "River Tides", album: "Brass & Tide", genre: "Funk", daysAgo: 31, tracks: ["Groove No. 4", "Brass & Tide", "Sunday Drive", "Pocket"] },
  { artist: "The Velvet Hours", album: "After Midnight", genre: "Jazz", daysAgo: 40, tracks: ["Last Call", "After Midnight", "Smoke Rings", "Blue Note", "Closing Time"] },
];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Mock video items (movies + shows, some anime) so Movies / TV / Anime previews
// — and the Discover anime row — have content to render.
interface VideoSpec {
  title: string;
  mediaType: "movie" | "show";
  genre: string;
  daysAgo: number;
  sizeGB: number;
}
const VIDEOS: VideoSpec[] = [
  { title: "Spirited Away (2001) 1080p", mediaType: "movie", genre: "Anime, Fantasy", daysAgo: 3, sizeGB: 4.2 },
  { title: "Your Name (2016) 1080p", mediaType: "movie", genre: "Anime, Romance", daysAgo: 7, sizeGB: 3.6 },
  { title: "[SubsPlease] Frieren - 12 (1080p)", mediaType: "show", genre: "Anime, Adventure", daysAgo: 1, sizeGB: 1.3 },
  { title: "[Erai-raws] Jujutsu Kaisen - 24 [1080p]", mediaType: "show", genre: "Anime, Action", daysAgo: 2, sizeGB: 1.4 },
  { title: "Blade Runner 2049 (2017) 2160p", mediaType: "movie", genre: "Sci-Fi, Drama", daysAgo: 10, sizeGB: 18.0 },
  { title: "Dune Part Two (2024) 1080p", mediaType: "movie", genre: "Sci-Fi, Adventure", daysAgo: 5, sizeGB: 9.1 },
  { title: "Breaking Bad S01E01 1080p", mediaType: "show", genre: "Crime, Drama", daysAgo: 14, sizeGB: 2.1 },
  { title: "The Bear S03E01 1080p", mediaType: "show", genre: "Comedy, Drama", daysAgo: 6, sizeGB: 1.8 },
];

export const MOCK_DOWNLOADED: DownloadedItem[] = (() => {
  const nowSec = Math.floor(Date.now() / 1000);
  const day = 86400;
  const out: DownloadedItem[] = [];
  for (const a of ALBUMS) {
    a.tracks.forEach((title, i) => {
      const id = `mock/music/${slug(a.artist)}/${slug(a.album)}/${i + 1}-${slug(title)}.flac`;
      out.push({
        id,
        title,
        fileName: `${String(i + 1).padStart(2, "0")} ${title}.flac`,
        kind: "audio",
        mediaType: "music",
        season: null,
        episode: null,
        artist: a.artist,
        album: a.album,
        genre: a.genre,
        trackNo: i + 1,
        artworkUrl: null,
        sizeBytes: 28_000_000 + i * 1_400_000,
        addedAt: nowSec - a.daysAgo * day - i * 60,
        url: "",
        inLibrary: true,
      });
    });
  }
  VIDEOS.forEach((v) => {
    out.push({
      id: `mock/video/${slug(v.title)}.mkv`,
      title: v.title,
      fileName: `${slug(v.title)}.mkv`,
      kind: "video",
      mediaType: v.mediaType,
      season: v.mediaType === "show" ? 1 : null,
      episode: null,
      artist: null,
      album: null,
      genre: v.genre,
      trackNo: null,
      artworkUrl: null,
      sizeBytes: Math.round(v.sizeGB * 1024 * 1024 * 1024),
      addedAt: nowSec - v.daysAgo * day,
      url: "",
      inLibrary: true,
    });
  });
  return out;
})();
