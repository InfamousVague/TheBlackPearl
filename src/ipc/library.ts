// IPC for the catalog + sources (backed by the Rust SQLite store / indexer).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CatalogItem, Category, SortKey, Source, SourceKind } from "../lib/types";
import { IN_TAURI } from "./engine";
import { IS_IOS } from "../lib/platform";
import {
  getActiveDevice,
  remoteListCatalog,
  remoteListDownloaded,
  remoteListLibrary,
  remoteLibraryStreamUrl,
  remoteSearch,
} from "./remote";

/** Companion mode: on iOS while linked to a desktop, reads mirror that desktop over the LAN. */
function companionDevice() {
  return IS_IOS ? getActiveDevice() : null;
}

export function listSources(): Promise<Source[]> {
  return invoke<Source[]>("list_sources");
}

export function addSource(name: string, kind: SourceKind, url: string): Promise<Source> {
  return invoke<Source>("add_source", { name, kind, url });
}

export function removeSource(id: string): Promise<void> {
  return invoke("remove_source", { id }).then(() => undefined);
}

/** Index a source; resolves to the number of items discovered. */
export function refreshSource(id: string): Promise<number> {
  return invoke<number>("refresh_source", { id });
}

/** Per-source diagnostic from the "Test source" button. */
export interface SourceTest {
  /** True if the full pipeline (incl. fallbacks) found at least one torrent. */
  ok: boolean;
  itemCount: number;
  elapsedMs: number;
  /** HTTP status of the configured URL (null if the request never completed). */
  httpStatus: number | null;
  /** Where the configured URL ended up after redirects. */
  finalUrl: string | null;
  bytes: number;
  /** Detected response shape (apibay JSON / HTML / Cloudflare / …). */
  format: string;
  /** A few result titles, as proof the parse worked. */
  sample: string[];
  /** Plain-language next step when something's wrong. */
  hint: string | null;
  /** Top-level pipeline error, if the whole fetch failed. */
  error: string | null;
}

/** Probe a source and return diagnostics (status, format, count, sample, hint). Read-only. */
export function testSource(id: string): Promise<SourceTest> {
  return invoke<SourceTest>("test_source", { id });
}

/** Live-search every linked source for `query`; merged, deduped, seeders-sorted.
 *  Companion mode (iOS + linked desktop): searches the desktop's sources over the LAN. */
export function searchSources(query: string): Promise<CatalogItem[]> {
  const dev = companionDevice();
  if (dev) return remoteSearch<CatalogItem>(dev, query);
  return invoke<CatalogItem[]>("search_sources", { query });
}

/** The indexed catalog (Discover). Companion mode: mirrors the linked desktop's catalog. */
export function listCatalog(
  query?: string,
  category?: Category | "all",
  sort?: SortKey,
): Promise<CatalogItem[]> {
  const dev = companionDevice();
  if (dev) return remoteListCatalog<CatalogItem>(dev, query, category, sort);
  return invoke<CatalogItem[]>("list_catalog", {
    query: query || null,
    category: category && category !== "all" ? category : null,
    sort: sort ?? "popularity",
  });
}

/**
 * Merge built-in seed items with DB items. The richer seed entry wins on
 * infohash collisions (generic scrapes can't read seeders/size), while
 * DB-only discoveries are appended.
 */
export function mergeCatalog(seed: CatalogItem[], db: CatalogItem[]): CatalogItem[] {
  const byId = new Map<string, CatalogItem>();
  for (const it of db) byId.set(it.id, it);
  for (const it of seed) byId.set(it.id, it);
  return [...byId.values()];
}

export interface AppInfo {
  downloadDir: string;
  dataDir: string;
  ffmpegAvailable: boolean;
}

export function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

/** Liveness of The Black Pearl artwork relay (posters/album art). */
export interface RelayStatus {
  url: string;
  reachable: boolean;
  status: number | null;
  latencyMs: number | null;
}

export function relayStatus(): Promise<RelayStatus> {
  return invoke<RelayStatus>("relay_status");
}

export interface CastMember {
  name: string;
  character: string | null;
  profile: string | null;
}

/** A movie/show details digest assembled + cached by the relay (TMDB/OMDb). */
export interface MovieDigest {
  kind: string;
  title: string;
  year: number | null;
  tmdbId: number;
  imdbId: string | null;
  overview: string | null;
  tagline: string | null;
  runtimeMinutes: number | null;
  genres: string[];
  rating: number | null;
  imdbRating: number | null;
  rtRating: number | null;
  poster: string | null;
  backdrop: string | null;
  trailerYoutubeKey: string | null;
  cast: CastMember[];
  director: string | null;
}

/** Fetch a movie/show digest from the relay (keyless; the relay caches it). */
export function movieDigest(kind: string, title: string, year?: number | null): Promise<MovieDigest> {
  return invoke<MovieDigest>("movie_digest", { kind, title, year: year ?? null });
}

/** The curated featured carousel (each a full digest), from the relay. */
export function featured(): Promise<MovieDigest[]> {
  return invoke<MovieDigest[]>("featured");
}

export interface MusicSpotiFlacStatus {
  available: boolean;
  command: string | null;
  outputDir: string;
  hint: string | null;
}

export interface MusicSpotiFlacResult {
  command: string;
  outputDir: string;
  stdout: string;
  stderr: string;
}

export interface MusicSpotiFlacInstallResult {
  command: string;
  resolvedCommand: string | null;
  stdout: string;
  stderr: string;
}

export interface MusicSpotiFlacOutput {
  stream: "stdout" | "stderr" | "meta";
  line: string;
  completedFiles?: number | null;
}

export interface TidalAuthStatus {
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
  hasAccessToken: boolean;
  accessTokenExpiresAt: number | null;
}

export interface TidalAuthResult {
  tokenType: string;
  expiresIn: number;
  accessTokenExpiresAt: number;
  authMode: string;
}

export function musicSpotiFlacStatus(): Promise<MusicSpotiFlacStatus> {
  return invoke<MusicSpotiFlacStatus>("music_spotiflac_status");
}

export function musicSpotiFlacInstall(): Promise<MusicSpotiFlacInstallResult> {
  return invoke<MusicSpotiFlacInstallResult>("music_spotiflac_install");
}

export function musicSpotiFlacDownload(url: string, service: string, quality?: string): Promise<MusicSpotiFlacResult> {
  return invoke<MusicSpotiFlacResult>("music_spotiflac_download", {
    url,
    service,
    quality: quality ?? null,
  });
}

export function onMusicSpotiFlacOutput(cb: (line: MusicSpotiFlacOutput) => void): Promise<() => void> {
  if (!IN_TAURI) return Promise.resolve(() => {});
  return listen<MusicSpotiFlacOutput>("spotiflac://output", (e) => cb(e.payload));
}

export function tidalAuthStatus(): Promise<TidalAuthStatus> {
  return invoke<TidalAuthStatus>("tidal_auth_status");
}

export function tidalSaveCredentials(
  clientId: string,
  clientSecret: string,
  refreshToken?: string | null,
): Promise<TidalAuthStatus> {
  return invoke<TidalAuthStatus>("tidal_save_credentials", {
    clientId,
    clientSecret,
    refreshToken: refreshToken ?? null,
  });
}

export function tidalClearCredentials(): Promise<TidalAuthStatus> {
  return invoke<TidalAuthStatus>("tidal_clear_credentials");
}

export function tidalTestAuth(): Promise<TidalAuthResult> {
  return invoke<TidalAuthResult>("tidal_test_auth");
}

export function tidalAuthorizeLogin(redirectUri?: string | null): Promise<TidalAuthResult> {
  return invoke<TidalAuthResult>("tidal_authorize_login", {
    redirectUri: redirectUri ?? null,
  });
}

export interface VpnStatus {
  active: boolean;
  interface: string;
}

export function vpnStatus(): Promise<VpnStatus> {
  return invoke<VpnStatus>("vpn_status");
}

export function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("get_setting", { key });
}

export function setSetting(key: string, value: string): Promise<void> {
  return invoke("set_setting", { key, value }).then(() => undefined);
}

/** Enrich un-postered items via TMDB (needs a stored key). Resolves to count enriched. */
export function enrichCatalog(): Promise<number> {
  return invoke<number>("enrich_catalog");
}

export function clearCatalog(): Promise<number> {
  return invoke<number>("clear_catalog");
}

// ---- local LLM + artwork library ----

export interface AiStatus {
  available: boolean;
  /** Model the scan will use (best installed match). */
  model: string | null;
  models: string[];
}

export interface ScanResult {
  organized: number;
  posters: number;
  remaining: number;
  aiUsed: boolean;
  model: string | null;
}

/** A catalog item plus AI/artwork metadata (flattened over the wire). */
export interface LibraryItem extends CatalogItem {
  cleanTitle?: string | null;
  mediaType?: string | null;
  imdbRating?: number | null;
  rtRating?: number | null;
  genre?: string | null;
  quality?: string | null;
  /** JSON-encoded string array of classification tags. */
  tags?: string | null;
}

/** Is the local Ollama daemon running, and what models are installed? */
export function aiStatus(): Promise<AiStatus> {
  return invoke<AiStatus>("ai_status");
}

/** Organize + scan up to `limit` un-processed items (posters, ratings, tags). */
export function aiScan(limit?: number): Promise<ScanResult> {
  return invoke<ScanResult>("ai_scan", { limit: limit ?? null });
}

export interface CleanTitlesResult {
  /** [id, cleanTitle] for every requested id that now has a clean title. */
  titles: [string, string][];
  /** Requested ids still missing a clean title — call again to do more. */
  remaining: number;
  aiUsed: boolean;
}

/** LLM-clean (regex fallback) the messy titles of the given catalog ids, cached server-side.
 *  Cache hits are free; up to `limit` uncached titles are cleaned per call. */
export function cleanTitles(ids: string[], limit?: number): Promise<CleanTitlesResult> {
  return invoke<CleanTitlesResult>("clean_titles", { ids, limit: limit ?? null });
}

/** Scanned items joined with their metadata — the Library view.
 *  Companion mode (iOS + linked desktop): mirrors the linked desktop's Library. */
export function listLibrary(): Promise<LibraryItem[]> {
  const dev = companionDevice();
  if (dev) return remoteListLibrary<LibraryItem>(dev);
  return invoke<LibraryItem[]>("list_library");
}

export interface PosterResult {
  found: number;
  scanned: number;
  remaining: number;
  usedKeys: boolean;
}

/** Keyless-first poster fetch (IMDb / iTunes, + TMDB/OMDb if keys). Resolves a summary. */
export function fetchPosters(limit?: number): Promise<PosterResult> {
  return invoke<PosterResult>("fetch_posters", { limit: limit ?? null });
}

// ---- TV series finder (keyless TVMaze metadata) ----

export interface TvShow {
  id: number;
  name: string;
  year: number | null;
  poster: string | null;
  network: string | null;
  genres: string[];
  summary: string | null;
}

export interface TvEpisode {
  season: number;
  number: number;
  name: string;
  airdate: string | null;
}

/** Search the real TV catalog (TVMaze) for shows matching `query`. */
export function tvSearch(query: string): Promise<TvShow[]> {
  return invoke<TvShow[]>("tv_search", { query });
}

/** Every episode of a show, in order, so the finder can lay out seasons/episodes. */
export function tvEpisodes(showId: number): Promise<TvEpisode[]> {
  return invoke<TvEpisode[]>("tv_episodes", { showId });
}

/** TVMaze-backed anime check for downloaded show titles (cached server-side). Returns the
 *  subset of `titles` tagged with the Anime genre — used by the Anime tab to surface shows
 *  the local release-name heuristic can't judge (an organized file has no fansub tag, and a
 *  title like "The Apothecary Diaries" carries no anime marker; the genre is only on TVMaze). */
export function classifyAnime(titles: string[]): Promise<string[]> {
  return invoke<string[]>("classify_anime", { titles });
}

/** A YouTube trailer key for a show (via TMDB; needs a key). Null if none. */
export function tvTrailer(title: string, year?: number | null): Promise<string | null> {
  return invoke<string | null>("tv_trailer", { title, year: year ?? null });
}

// ---- Music discovery (keyless iTunes metadata) ----

export interface MusicArtist {
  id: number;
  name: string;
  genre: string | null;
}

export interface MusicAlbum {
  id: number;
  name: string;
  artist: string;
  year: number | null;
  poster: string | null;
  trackCount: number;
}

export interface MusicTrack {
  id: number;
  name: string;
  number: number;
  disc: number;
  durationMs: number;
}

/** Search the real music catalog (iTunes) for recording artists matching `query`. */
export function musicSearchArtists(query: string): Promise<MusicArtist[]> {
  return invoke<MusicArtist[]>("music_search_artists", { query });
}

/** An artist's albums, newest first, so the finder can lay out the discography. */
export function musicArtistAlbums(artistId: number): Promise<MusicAlbum[]> {
  return invoke<MusicAlbum[]>("music_artist_albums", { artistId });
}

/** Every track on an album, in order, so the finder can list songs to source. */
export function musicAlbumTracks(albumId: number): Promise<MusicTrack[]> {
  return invoke<MusicTrack[]>("music_album_tracks", { albumId });
}

// ---- local Library (content downloaded to disk) ----

export interface DownloadedItem {
  id: string;
  title: string;
  fileName: string;
  kind: "video" | "audio" | "book" | "game";
  mediaType: "movie" | "show" | "music" | "book" | "game";
  season: number | null;
  episode: number | null;
  /** Embedded audio tags (music only) — the Music view groups by these. */
  artist: string | null;
  album: string | null;
  /** Embedded genre tag (music only) — drives the Music genre rows. */
  genre: string | null;
  trackNo: number | null;
  /** Embedded album artwork (music only), served from loopback /art. */
  artworkUrl: string | null;
  sizeBytes: number;
  /** File mtime as epoch seconds — drives the "Recently added" feed. */
  addedAt: number;
  /** Loopback URL the player streams the local file from. */
  url: string;
  /** Curated into the Library? If not, it shows under Downloads as "unsorted". */
  inLibrary: boolean;
}

/** Everything downloaded to disk (movies / shows / music / books / games) with ready-to-play URLs.
 *  Companion mode (iOS + linked desktop): mirrors the linked desktop's on-disk Library.
 *  Item `url`s come back as the desktop's loopback URLs — call `resolveLocalPlayUrl(item)`
 *  at play time to turn them into a token-bearing URL on the desktop. */
export function listDownloaded(): Promise<DownloadedItem[]> {
  const dev = companionDevice();
  if (dev) return remoteListDownloaded<DownloadedItem>(dev);
  return invoke<DownloadedItem[]>("list_downloaded");
}

/** The playback URL for a downloaded item. Locally that's the item's own loopback `url`;
 *  in companion mode it's a fresh token-bearing stream URL on the linked desktop (resolved
 *  by relpath, which is the item's `id`). The iPad buffers only — nothing is stored. */
export async function resolveLocalPlayUrl(item: DownloadedItem): Promise<string> {
  const dev = companionDevice();
  if (dev) return remoteLibraryStreamUrl(dev, item.id);
  return item.url;
}

/** Curate a downloaded item into the Library. */
export function addToLibrary(id: string): Promise<void> {
  return invoke("add_to_library", { id }).then(() => undefined);
}

/** Remove a downloaded item from the Library (the file stays on disk, under Downloads). */
export function removeFromLibrary(id: string): Promise<void> {
  return invoke("remove_from_library", { id }).then(() => undefined);
}

/** Reveal a downloaded file in Finder. */
export function revealPath(id: string): Promise<void> {
  return invoke("reveal_path", { id }).then(() => undefined);
}

/** Move a downloaded file to the Trash (recoverable) and drop it from the Library. */
export function trashDownloaded(id: string): Promise<void> {
  return invoke("trash_downloaded", { id }).then(() => undefined);
}

export interface ClearResult {
  removedActive: number;
  trashed: number;
}

/** Stop all transfers and trash every on-disk file not in the Library (Library is kept). */
export function clearDownloads(): Promise<ClearResult> {
  return invoke<ClearResult>("clear_downloads");
}

// ---- manual-verification browser (Cloudflare / "I'm not a robot") ----

/** Open/refocus an embedded browser at `url` so the user can pass a bot check. */
export function openBrowser(url: string): Promise<string> {
  return invoke<string>("open_browser", { url });
}

/** Scrape magnets from the page currently shown in the verification browser. */
export function importFromBrowser(sourceName: string): Promise<number> {
  return invoke<number>("import_from_browser", { sourceName });
}

/** Download a direct HTTP(S) file into Ghosty's download folder (desktop only flow). */
export function downloadHttpFile(url: string, title?: string): Promise<string> {
  return invoke<string>("download_http_file", { url, title: title ?? null });
}

// ---- export to media libraries (Plex / Apple Music / generic folder) ----

export interface Exportable {
  path: string;
  fileName: string;
  sizeBytes: number;
  kind: "video" | "audio" | "book" | "game";
  mediaType: "movie" | "show" | "music" | "book" | "game";
  title: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  relPath: string;
}

export type ExportTarget = "plex" | "apple_music" | "generic";

export interface ExportResult {
  path: string;
  ok: boolean;
  dest?: string | null;
  converted: boolean;
  message: string;
}

/** Native folder picker (allows creating new folders). Null if cancelled. */
export function pickFolder(): Promise<string | null> {
  return invoke<string | null>("pick_folder");
}

/** Set a new storage folder (optionally moving existing downloads). Resolves to a status. */
export function setStorageDir(path: string, migrate: boolean): Promise<string> {
  return invoke<string>("set_storage_dir", { path, migrate });
}

/** Relaunch the app (so a new storage folder takes effect). */
export function restartApp(): Promise<void> {
  return invoke("restart_app").then(() => undefined);
}

// ---- manual poster overrides (right-click → Replace poster) ----

export interface PosterOverride {
  title: string;
  url: string;
}

/** Candidate poster URLs for a title (keyless IMDb + iTunes). */
export function posterCandidates(title: string, kind?: string): Promise<string[]> {
  return invoke<string[]>("poster_candidates", { title, kind: kind ?? null });
}

/** Set the poster for everything matching `title`; resolves to the stored art URL. */
export function setPoster(title: string, url: string): Promise<string> {
  return invoke<string>("set_poster", { title, url });
}

/** All manual poster overrides (normalized title → url). */
export function listPosterOverrides(): Promise<PosterOverride[]> {
  return invoke<PosterOverride[]>("list_poster_overrides");
}

/** Media files in the download folder, with parsed names + library-path previews. */
export function listExportable(): Promise<Exportable[]> {
  return invoke<Exportable[]>("list_exportable");
}

/** Export the given file paths to a target; resolves to a per-file result list. */
export function exportItems(target: ExportTarget, paths: string[]): Promise<ExportResult[]> {
  return invoke<ExportResult[]>("export_items", { target, paths });
}

export const LIBRARY_AVAILABLE = IN_TAURI;
