// IPC for Discover "trending" — free top/trending lists per media category, resolved by the
// Rust backend (Movies/TV via the relay's TMDB; Music/Books/Games via keyless sources).
import { invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./engine";

export interface TrendingItem {
  /** Shown as the title and used (with subtitle, for music/books) as the source-search query. */
  title: string;
  subtitle: string | null;
  poster: string | null;
  year: number | null;
  /** 0–10 where the source exposes a score. */
  rating: number | null;
  /** movie | tv | music | book | game */
  kind: string;
}

/** Trending items for a Discover category ("movies" | "tvshows" | "music" | "books" | "games").
 *  Resolves to [] off-Tauri or on any backend error (the row just stays hidden). */
export function trending(category: string): Promise<TrendingItem[]> {
  if (!IN_TAURI) return Promise.resolve([]);
  return invoke<TrendingItem[]>("trending", { category }).catch(() => []);
}
