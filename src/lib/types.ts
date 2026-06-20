// Core domain model for GhostWire. These types are shared between the React UI
// and (eventually) the typed Tauri IPC layer, so the Rust side should mirror them.

export type SourceKind = "scraper" | "adapter" | "torznab" | "webview";

export interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  /** Base URL or endpoint that magnets are discovered from. */
  url: string;
  enabled: boolean;
  /** Epoch ms of the last successful index, if ever. */
  lastIndexed?: number;
  /** Number of catalog items currently attributed to this source. */
  itemCount: number;
}

export type Category = "video" | "audio" | "software" | "books" | "data" | "other";

export interface CatalogItem {
  /** Infohash — the natural primary key, used to dedupe across sources. */
  id: string;
  title: string;
  magnet: string;
  sizeBytes: number;
  seeders: number;
  leechers: number;
  /** Display name of the originating source. */
  source: string;
  category: Category;
  /** Epoch ms this item was first indexed. */
  addedAt: number;
  files?: number;
  // --- optional enrichment (M4) ---
  poster?: string;
  description?: string;
  year?: number;
  /** LLM/regex-cleaned display title (overlaid client-side); falls back to `title`. */
  cleanTitle?: string | null;
}

export type SortKey = "popularity" | "recent" | "size" | "title";

export interface SortOption {
  key: SortKey;
  label: string;
}

/** Live state of an active stream/download (populated by the Rust engine in M1). */
export type DownloadState = "queued" | "connecting" | "downloading" | "ready" | "seeding" | "paused" | "error";

export interface FileEntry {
  index: number;
  name: string;
  size: number;
}

/** Rich per-torrent diagnostics for the player's "what's streaming" panel. */
export interface MediaInfo {
  state: string;
  peers: number;
  hasMeta: boolean;
  progress: number;
  totalBytes: number;
  ageSecs: number;
  trackers: number;
  webseed: boolean;
  fileName: string | null;
  fileExt: string | null;
  fileSize: number;
  /** Selected file's path relative to the download folder — drives streaming subtitles. */
  relPath: string | null;
  files: FileEntry[];
  mediaKind: string | null; // "video" | "audio" | "other"
  endpoint: string | null; // "direct" | "transcode" | "download"
  endpointReason: string | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  transcodeError: string | null;
  detail: string;
}

export interface DownloadStats {
  id: string; // infohash
  title: string;
  state: DownloadState;
  /** 0–1 overall progress. */
  progress: number;
  /** Bytes/sec. */
  downSpeed: number;
  upSpeed: number;
  peers: number;
  /** Local URL the <video> element streams from, once playable. */
  streamUrl?: string;
  /** True only for content you deliberately shared with your connections (a local seed from
   *  "Share with network" / "Create torrent"). False for downloaded torrents that are merely
   *  seeding back to the public swarm — lets the UI separate the two. */
  shared?: boolean;
}
