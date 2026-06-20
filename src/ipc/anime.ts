// IPC for anime discovery — popular/trending/seasonal anime from free keyless
// public APIs (AniList + MyAnimeList via Jikan), resolved by the Rust `anime` module.
import { invoke } from "@tauri-apps/api/core";

export interface AnimeItem {
  /** Romaji / native title — used for source searches. */
  title: string;
  titleEnglish?: string | null;
  year?: number | null;
  poster?: string | null;
  synopsis?: string | null;
  /** 0–10. */
  score?: number | null;
  genres: string[];
  episodes?: number | null;
  format?: string | null;
  status?: string | null;
  trailerYoutube?: string | null;
  malId?: number | null;
  anilistId?: number | null;
  sources: string[];
}

export interface AnimeDiscovery {
  trending: AnimeItem[];
  top: AnimeItem[];
  seasonal: AnimeItem[];
}

export function popularAnime(): Promise<AnimeDiscovery> {
  return invoke<AnimeDiscovery>("popular_anime");
}

export interface AnimeEpisode {
  number: number;
  title?: string | null;
  airdate?: string | null;
}

/** One anime's full metadata + episode list (for the below-player panel). */
export interface AnimeDetail extends AnimeItem {
  episodeList: AnimeEpisode[];
}

/** Look up a single anime by title (synopsis, genres, episodes). Null if no match. */
export function animeDetail(title: string): Promise<AnimeDetail | null> {
  return invoke<AnimeDetail | null>("anime_detail", { title });
}
