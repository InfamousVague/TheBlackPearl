// IPC for Spotify playlist replication (backed by src-tauri/src/spotify.rs).
import { invoke } from "@tauri-apps/api/core";
import type { CatalogItem } from "../lib/types";

export interface SpotifyStatus {
  connected: boolean;
  hasCredentials: boolean;
  /** Redirect URI to register in the Spotify app dashboard. */
  redirectUri: string;
}

export interface SpotifyTrack {
  name: string;
  artist: string;
  album: string;
  albumArt: string | null;
  durationMs: number;
  isrc: string | null;
  /** Spotify track id + open.spotify.com link (to play it in Spotify). */
  id: string | null;
  url: string | null;
  /** 30s preview clip when available. */
  previewUrl: string | null;
}

/** A source match for a track, with parsed audio quality. */
export interface ReplicaMatch extends CatalogItem {
  quality: string;
  qualityRank: number;
}

export interface ReplicaTrack {
  track: SpotifyTrack;
  matches: ReplicaMatch[];
}

export interface ReplicaResult {
  playlist: string;
  total: number;
  tracks: ReplicaTrack[];
}

export interface SpotifyPlaylistPreviewResult {
  playlist: string;
  total: number;
  tracks: SpotifyTrack[];
}

export function spotifyStatus(): Promise<SpotifyStatus> {
  return invoke<SpotifyStatus>("spotify_status");
}

/** Open the Spotify login window + loopback OAuth; resolves once tokens are stored. */
export function spotifyLogin(): Promise<void> {
  return invoke("spotify_login").then(() => undefined);
}

export function spotifyLogout(): Promise<void> {
  return invoke("spotify_logout").then(() => undefined);
}

/** Fetch a playlist's tracks and match each against the linked sources. */
export function spotifyReplicate(playlistUrl: string): Promise<ReplicaResult> {
  return invoke<ReplicaResult>("spotify_replicate", { playlistUrl });
}

/** Fetch Spotify playlist tracks only (no source matching), for import previews. */
export function spotifyPlaylistPreview(playlistUrl: string): Promise<SpotifyPlaylistPreviewResult> {
  return invoke<SpotifyPlaylistPreviewResult>("spotify_playlist_preview", { playlistUrl });
}

export interface AlbumArt {
  artist: string;
  album: string;
  art: string | null;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  image: string | null;
  url: string;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  artist: string;
  image: string | null;
  url: string;
  year: number | null;
  trackCount: number;
}

/** Look up Spotify cover art for a batch of (artist, album) pairs — covers only. */
export function spotifyAlbumArt(albums: { artist: string; album: string }[]): Promise<AlbumArt[]> {
  return invoke<AlbumArt[]>("spotify_album_art", { albums });
}

/** Search Spotify's public artist catalog using the stored app credentials. */
export function spotifySearchArtists(query: string): Promise<SpotifyArtist[]> {
  return invoke<SpotifyArtist[]>("spotify_search_artists", { query });
}

/** Load an artist's Spotify albums for one-click complete-album downloads. */
export function spotifyArtistAlbums(artistId: string): Promise<SpotifyAlbum[]> {
  return invoke<SpotifyAlbum[]>("spotify_artist_albums", { artistId });
}
