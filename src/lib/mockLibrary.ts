import type { DownloadedItem } from "../ipc/library";
import type { DownloadStats } from "./types";

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
// Entirely fictional titles — nothing real/copyrighted shows on the marketing site.
const VIDEOS: VideoSpec[] = [
  { title: "Neon Harbor (2021) 1080p", mediaType: "movie", genre: "Sci-Fi, Thriller", daysAgo: 3, sizeGB: 4.2 },
  { title: "The Last Cartographer (2019) 1080p", mediaType: "movie", genre: "Adventure, Drama", daysAgo: 7, sizeGB: 3.6 },
  { title: "[SubFleet] Lantern Saga - 12 (1080p)", mediaType: "show", genre: "Anime, Adventure", daysAgo: 1, sizeGB: 1.3 },
  { title: "[Erai-fan] Cobalt Hours - 24 [1080p]", mediaType: "show", genre: "Anime, Action", daysAgo: 2, sizeGB: 1.4 },
  { title: "[SubFleet] Tidebound - 08 (1080p)", mediaType: "show", genre: "Anime, Adventure", daysAgo: 3, sizeGB: 1.2 },
  { title: "[Erai-fan] Emberfall - 15 [1080p]", mediaType: "show", genre: "Anime, Fantasy", daysAgo: 4, sizeGB: 1.5 },
  { title: "[SubFleet] Starling Code - 03 (1080p)", mediaType: "show", genre: "Anime, Sci-Fi", daysAgo: 7, sizeGB: 1.1 },
  { title: "Echoes of Andromeda (2023) 2160p", mediaType: "movie", genre: "Sci-Fi", daysAgo: 10, sizeGB: 18.0 },
  { title: "Saltwater Kings (2024) 1080p", mediaType: "movie", genre: "Drama", daysAgo: 5, sizeGB: 9.1 },
  { title: "Pier Seven S01E01 1080p", mediaType: "show", genre: "Drama", daysAgo: 14, sizeGB: 2.1 },
  { title: "Midnight Signal S03E01 1080p", mediaType: "show", genre: "Thriller, Mystery", daysAgo: 6, sizeGB: 1.8 },
  { title: "The Glass Atlas (2020) 1080p", mediaType: "movie", genre: "Fantasy, Adventure", daysAgo: 20, sizeGB: 6.0 },
  { title: "Driftwood (2022) 1080p", mediaType: "movie", genre: "Animation, Family", daysAgo: 16, sizeGB: 3.2 },
  { title: "Frostlight (2018) 1080p", mediaType: "movie", genre: "Drama", daysAgo: 28, sizeGB: 4.5 },
  { title: "The Wren Society S01E04 1080p", mediaType: "show", genre: "Mystery", daysAgo: 9, sizeGB: 1.6 },
  { title: "Due North S02E08 2160p", mediaType: "show", genre: "Adventure", daysAgo: 11, sizeGB: 3.0 },
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
  // A lower-quality duplicate of "Compass Rose" — exercises the Music view's
  // exact-duplicate collapse (the smaller mp3 is hidden, the flac kept).
  out.push({
    id: "mock/music/midnight-cartographers/atlas-of-sleep/1-compass-rose-128.mp3",
    title: "Compass Rose",
    fileName: "01 Compass Rose.mp3",
    kind: "audio",
    mediaType: "music",
    season: null,
    episode: null,
    artist: "Midnight Cartographers",
    album: "Atlas of Sleep",
    genre: "Indie",
    trackNo: 1,
    artworkUrl: null,
    sizeBytes: 6_000_000,
    addedAt: nowSec - 86400,
    url: "",
    inLibrary: true,
  });
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
  // Fictional ebooks so the Books library view has content (author lives in `artist`).
  const BOOKS: { title: string; author: string; genre: string; daysAgo: number; mb: number }[] = [
    { title: "The Lantern Keeper's Almanac", author: "Elara Voss", genre: "Fantasy", daysAgo: 4, mb: 3.1 },
    { title: "Tideglass", author: "Marin Holloway", genre: "Sci-Fi", daysAgo: 8, mb: 2.4 },
    { title: "Saltmarsh Letters", author: "J. P. Wren", genre: "Literary", daysAgo: 13, mb: 1.9 },
    { title: "The Cartographer's Daughter", author: "Nadia Frost", genre: "Historical", daysAgo: 19, mb: 4.2 },
    { title: "Orbital Decay", author: "Sam Okonkwo", genre: "Sci-Fi", daysAgo: 25, mb: 2.8 },
    { title: "Paper Moons", author: "Cora Lin", genre: "Romance", daysAgo: 33, mb: 2.1 },
  ];
  BOOKS.forEach((b) => {
    out.push({
      id: `mock/books/${slug(b.title)}.epub`,
      title: b.title,
      fileName: `${slug(b.title)}.epub`,
      kind: "book",
      mediaType: "book",
      season: null,
      episode: null,
      artist: b.author,
      album: null,
      genre: b.genre,
      trackNo: null,
      artworkUrl: null,
      sizeBytes: Math.round(b.mb * 1024 * 1024),
      addedAt: nowSec - b.daysAgo * day,
      url: "",
      inLibrary: true,
    });
  });
  // Fictional games so the Games library view has content.
  const GAMES: { title: string; genre: string; daysAgo: number; gb: number }[] = [
    { title: "Neon Drifters", genre: "Racing", daysAgo: 2, gb: 6.4 },
    { title: "Hollowmoor", genre: "RPG", daysAgo: 5, gb: 22.0 },
    { title: "Pixel Pioneers", genre: "Strategy", daysAgo: 10, gb: 3.2 },
    { title: "Starbound Salvage", genre: "Adventure", daysAgo: 15, gb: 14.5 },
    { title: "Cinder Keep", genre: "Platformer", daysAgo: 21, gb: 1.8 },
    { title: "Cobalt Circuit", genre: "Puzzle", daysAgo: 29, gb: 0.9 },
  ];
  GAMES.forEach((g) => {
    out.push({
      id: `mock/games/${slug(g.title)}.iso`,
      title: g.title,
      fileName: `${slug(g.title)}.iso`,
      kind: "game",
      mediaType: "game",
      season: null,
      episode: null,
      artist: null,
      album: null,
      genre: g.genre,
      trackNo: null,
      artworkUrl: null,
      sizeBytes: Math.round(g.gb * 1024 * 1024 * 1024),
      addedAt: nowSec - g.daysAgo * day,
      url: "",
      inLibrary: true,
    });
  });
  return out;
})();

// In-progress transfers for the Downloads view in the browser preview (the real list comes from
// the torrent engine). A "ready" item shows streaming before a download finishes; a "seeding"
// item shows give-back. Fictional titles only. Never used in the shipped desktop app.
export const MOCK_DOWNLOADS: DownloadStats[] = [
  { id: "demodl-andromeda", title: "Echoes of Andromeda (2023) 2160p", state: "downloading", progress: 0.42, downSpeed: 8.4 * 1024 * 1024, upSpeed: 320 * 1024, peers: 47 },
  { id: "demodl-neon", title: "Neon Harbor (2021) 1080p", state: "downloading", progress: 0.08, downSpeed: 3.1 * 1024 * 1024, upSpeed: 64 * 1024, peers: 22 },
  { id: "demodl-lantern", title: "[SubFleet] Lantern Saga - 12 (1080p)", state: "ready", progress: 0.71, downSpeed: 5.2 * 1024 * 1024, upSpeed: 210 * 1024, peers: 33 },
  { id: "demodl-saltwater", title: "Saltwater Kings (2024) 1080p", state: "seeding", progress: 1, downSpeed: 0, upSpeed: 540 * 1024, peers: 12 },
];
