// Typed bridge to the Rust torrent engine (librqbit), landing in M1.
// The command names/payloads here are the contract the Rust side implements;
// they intentionally mirror the DownloadStats domain type.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DownloadStats, MediaInfo } from "../lib/types";

/** True only inside the Tauri webview — false in the plain browser preview. */
export const IN_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Event channel the Rust engine pushes a full snapshot of active downloads on (~1/s). */
export const DOWNLOADS_EVENT = "ghosty://downloads";

/** Add a magnet to the session; resolves to the torrent's infohash id. `queue=true` enqueues
 *  it as a download (one-at-a-time, starts when a slot frees); the default streams it now.
 *  `peers` are seeder socket addresses (`ip:port`) carried by a friend's share so the swarm
 *  dials them directly instead of waiting on DHT discovery. */
export function addTorrent(magnet: string, queue = false, peers?: string[]): Promise<string> {
  return invoke<string>("add_torrent", { magnet, queue, peers });
}

/** PIN + this Mac's LAN address to display so another device (iPad) can link to it. */
export interface PairingInfo {
  pin: string;
  address: string;
}
export function pairingPin(): Promise<PairingInfo> {
  return invoke<PairingInfo>("pairing_pin");
}

/** Local HTTP URL (range-capable) the <video> streams from. fileIdx omitted = largest media file. */
export function getStreamUrl(id: string, fileIdx?: number): Promise<string> {
  return invoke<string>("stream_url", { id, fileIdx: fileIdx ?? null });
}

export function torrentStats(id: string): Promise<DownloadStats> {
  return invoke<DownloadStats>("torrent_stats", { id });
}

/** Format/codec + peer/tracker health for the active stream (for the debug panel). */
export function mediaInfo(id: string): Promise<MediaInfo> {
  return invoke<MediaInfo>("media_info", { id });
}

/** A subtitle track for a local video — sidecar file or embedded stream, served as WebVTT. */
export interface SubTrack {
  label: string;
  lang: string;
  url: string;
}

/** Subtitle tracks for a local video by its relative path under the download folder. */
export function listSubtitles(rel: string): Promise<SubTrack[]> {
  return invoke<SubTrack[]>("list_subtitles", { rel });
}

/** Fetch a subtitle (free, keyless, via OpenSubtitles) for a video that has none; saves it
 *  next to the file and resolves to the refreshed track list. */
export function fetchSubtitles(
  rel: string,
  title: string,
  season?: number | null,
  episode?: number | null,
  lang?: string,
): Promise<SubTrack[]> {
  return invoke<SubTrack[]>("fetch_subtitles", {
    rel,
    title,
    season: season ?? null,
    episode: episode ?? null,
    lang: lang ?? null,
  });
}

export function listDownloads(): Promise<DownloadStats[]> {
  return invoke<DownloadStats[]>("list_downloads");
}

export function removeTorrent(id: string, deleteFiles = false): Promise<void> {
  return invoke("remove_torrent", { id, deleteFiles }).then(() => undefined);
}

/** Result of creating a torrent from local files. Everything stays on the user's machine —
 *  the torrent is just a fingerprint and the user's own client is the seed. */
export interface CreatedTorrent {
  infohash: string;
  magnet: string;
  name: string;
  sizeBytes: number;
  fileCount: number;
  /** Path the `.torrent` was written to, if a save path was given. */
  torrentPath: string | null;
  /** True if the engine started seeding the source files. */
  seeding: boolean;
}

/** Create a `.torrent` from a local file/folder and (by default) start seeding it locally.
 *  Nothing is uploaded to any GhostWire server — the user shares the returned magnet /
 *  `.torrent` file wherever they choose. */
export function createTorrent(
  sourcePath: string,
  opts?: { savePath?: string; trackers?: string[]; startSeeding?: boolean },
): Promise<CreatedTorrent> {
  return invoke<CreatedTorrent>("create_torrent", {
    sourcePath,
    savePath: opts?.savePath ?? null,
    trackers: opts?.trackers ?? null,
    startSeeding: opts?.startSeeding ?? true,
  });
}

/** Re-seed a previously created `.torrent` file by pointing it at the content directory.
 *  Resolves to the torrent's infohash id. */
export function seedTorrent(torrentPath: string, contentDir: string): Promise<string> {
  return invoke<string>("seed_torrent", { torrentPath, contentDir });
}

/** Share an item already downloaded to the library: creates a fresh torrent from its file/folder
 *  on disk and starts seeding it so friends can find it. `id` is the item's path relative to the
 *  download dir (i.e. `DownloadedItem.id`). Nothing is uploaded to any GhostWire server. */
export function shareLibraryItem(id: string): Promise<CreatedTorrent> {
  return invoke<CreatedTorrent>("share_library_item", { id });
}

export function pauseDownload(id: string, paused: boolean): Promise<void> {
  return invoke("pause_download", { id, paused }).then(() => undefined);
}

/** Current queue concurrency cap (how many downloads may transfer at once). */
export function getDownloadConcurrency(): Promise<number> {
  return invoke<number>("get_download_concurrency");
}

/** Set queue concurrency cap (clamped server-side to a safe range). */
export function setDownloadConcurrency(value: number): Promise<number> {
  return invoke<number>("set_download_concurrency", { value });
}

/** Reveal the download's folder in the OS file manager. */
export function revealDownload(id: string): Promise<void> {
  return invoke("reveal_download", { id }).then(() => undefined);
}

/** Subscribe to the engine's periodic download snapshots. No-op outside Tauri. */
export async function onDownloads(
  cb: (snapshot: DownloadStats[]) => void,
): Promise<UnlistenFn> {
  if (!IN_TAURI) return () => {};
  return listen<DownloadStats[]>(DOWNLOADS_EVENT, (e) => cb(e.payload));
}
