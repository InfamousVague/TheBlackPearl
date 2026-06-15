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

/** Add a magnet to the session; resolves to the torrent's infohash id. */
export function addTorrent(magnet: string): Promise<string> {
  return invoke<string>("add_torrent", { magnet });
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

export function listDownloads(): Promise<DownloadStats[]> {
  return invoke<DownloadStats[]>("list_downloads");
}

export function removeTorrent(id: string, deleteFiles = false): Promise<void> {
  return invoke("remove_torrent", { id, deleteFiles }).then(() => undefined);
}

export function pauseDownload(id: string, paused: boolean): Promise<void> {
  return invoke("pause_download", { id, paused }).then(() => undefined);
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
