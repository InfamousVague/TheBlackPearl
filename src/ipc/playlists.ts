// IPC for playlist manifests (saved as JSON on disk by the Rust `playlist` module)
// plus export/import to the common player formats and Spotify-link capture.
import { invoke } from "@tauri-apps/api/core";

export interface PlaylistTrack {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  isrc?: string | null;
  /** Absolute local file path, once the song is downloaded + matched. */
  path?: string | null;
  spotifyUrl?: string | null;
  /** Loopback stream URL the player can play (present only when downloaded). */
  url?: string | null;
}

export interface Playlist {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  /** "spotify" | "manual" | "import" */
  source: string;
  tracks: PlaylistTrack[];
}

/** Rockbox uses M3U8; the rest are for other players / portability. */
export type PlaylistFormat = "m3u8" | "m3u" | "pls" | "xspf";

export const FORMAT_LABELS: Record<PlaylistFormat, string> = {
  m3u8: "M3U8 (Rockbox)",
  m3u: "M3U",
  pls: "PLS",
  xspf: "XSPF",
};

export function listPlaylists(): Promise<Playlist[]> {
  return invoke<Playlist[]>("list_playlists");
}

export function getPlaylist(id: string): Promise<Playlist> {
  return invoke<Playlist>("get_playlist", { id });
}

export function createPlaylist(name: string, tracks?: PlaylistTrack[]): Promise<Playlist> {
  return invoke<Playlist>("create_playlist", { name, tracks: tracks ?? null });
}

export function deletePlaylist(id: string): Promise<void> {
  return invoke("delete_playlist", { id }).then(() => undefined);
}

export function renamePlaylist(id: string, name: string): Promise<Playlist> {
  return invoke<Playlist>("rename_playlist", { id, name });
}

export function playlistAddTracks(id: string, tracks: PlaylistTrack[]): Promise<Playlist> {
  return invoke<Playlist>("playlist_add_tracks", { id, tracks });
}

export function playlistRemoveTrack(id: string, index: number): Promise<Playlist> {
  return invoke<Playlist>("playlist_remove_track", { id, index });
}

/** Replace the whole track list (drag-to-reorder / bulk edit). */
export function setPlaylistTracks(id: string, tracks: PlaylistTrack[]): Promise<Playlist> {
  return invoke<Playlist>("set_playlist_tracks", { id, tracks });
}

/** Export to a player format; returns a human summary. `dir` defaults to Music/Playlists. */
export function exportPlaylist(id: string, format: PlaylistFormat, dir?: string | null): Promise<string> {
  return invoke<string>("export_playlist", { id, format, dir: dir ?? null });
}

export function importPlaylist(filePath: string): Promise<Playlist> {
  return invoke<Playlist>("import_playlist", { filePath });
}

/** Link a Spotify playlist → save a real manifest of its songs. */
export function spotifyToPlaylist(link: string): Promise<Playlist> {
  return invoke<Playlist>("spotify_to_playlist", { link });
}

// ---- Liked Songs (an auto-managed playlist, Spotify-style) ----

export const LIKED_PLAYLIST_NAME = "Liked Songs";

/** Stable identity for a track within a playlist (title + artist, normalized). */
export function trackKey(t: { title: string; artist?: string | null }): string {
  return `${(t.title || "").toLowerCase().trim()}::${(t.artist || "").toLowerCase().trim()}`;
}

/** Whether `list` already contains a track matching `track`. */
export function playlistHasTrack(list: Playlist, track: { title: string; artist?: string | null }): boolean {
  const k = trackKey(track);
  return list.tracks.some((t) => trackKey(t) === k);
}

/** The "Liked Songs" playlist if it exists (matched by its well-known name). */
export function findLiked(all: Playlist[]): Playlist | undefined {
  return all.find((p) => p.name === LIKED_PLAYLIST_NAME);
}

/** Find or create the "Liked Songs" playlist. */
export async function ensureLiked(): Promise<Playlist> {
  const liked = findLiked(await listPlaylists());
  return liked ?? createPlaylist(LIKED_PLAYLIST_NAME);
}

/** Add/remove a track from Liked Songs; resolves to the new liked state. */
export async function toggleLiked(track: PlaylistTrack): Promise<boolean> {
  const liked = await ensureLiked();
  const k = trackKey(track);
  const idx = liked.tracks.findIndex((t) => trackKey(t) === k);
  if (idx >= 0) {
    await playlistRemoveTrack(liked.id, idx);
    return false;
  }
  await playlistAddTracks(liked.id, [track]);
  return true;
}

// ---- drag-and-drop payload (drag tracks/albums onto a playlist) ----

export const TRACKS_MIME = "application/x-ghosty-tracks";

export function setDragTracks(dt: DataTransfer | null, tracks: PlaylistTrack[]): void {
  if (!dt) return;
  dt.setData(TRACKS_MIME, JSON.stringify(tracks));
  dt.setData("text/plain", tracks.map((t) => t.title).join(", "));
  dt.effectAllowed = "copy";
}

export function getDragTracks(dt: DataTransfer | null): PlaylistTrack[] | null {
  const raw = dt?.getData(TRACKS_MIME);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as PlaylistTrack[]) : null;
  } catch {
    return null;
  }
}
