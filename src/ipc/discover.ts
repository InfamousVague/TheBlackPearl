// IPC for the Discover feeds — free top/trending lists per media category, resolved by the
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
  /** Plot/overview (movies & TV) — shown in the hero. */
  overview: string | null;
  /** A primary genre, where available. */
  genre: string | null;
  /** Wide backdrop (movies & TV) for the hero background. */
  backdrop: string | null;
}

export interface DiscoverRow {
  title: string;
  items: TrendingItem[];
}

export interface DiscoverFeed {
  /** The billboard pick (top item with the richest art/overview). */
  hero: TrendingItem | null;
  rows: DiscoverRow[];
}

const EMPTY: DiscoverFeed = { hero: null, rows: [] };

/** The whole Discover feed for a category ("movies" | "tvshows" | "music" | "books" | "games").
 *  Resolves to an empty feed off-Tauri or on any backend error (the section stays hidden). */
export function discoverFeed(category: string): Promise<DiscoverFeed> {
  if (!IN_TAURI) return Promise.resolve(EMPTY);
  return invoke<DiscoverFeed>("discover_feed", { category }).catch(() => EMPTY);
}

/** For each query, whether the user's sources actually have a torrent for it (relevance-
 *  filtered, cached + concurrency-capped in the backend). Aligned to `queries`; unknown/
 *  error → true (don't gray on uncertainty). Off-Tauri everything is "available". */
export function checkAvailability(queries: string[]): Promise<boolean[]> {
  if (!IN_TAURI || queries.length === 0) return Promise.resolve(queries.map(() => true));
  return invoke<boolean[]>("check_availability", { queries }).catch(() => queries.map(() => true));
}
