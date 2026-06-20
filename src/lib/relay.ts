// Relay-backed cover art for catalog items. The GhostWire artwork relay turns a
// {type,title,year} query into image bytes — TMDB/OMDb for movies + TV, AniList/Jikan/Kitsu
// for anime — caches them server-side, and serves them with immutable cache headers. So a
// plain <img src> is all a client needs: the first view of a title warms the cache for
// everyone, and a clean miss is a 404 the card falls back from. No API key, no IPC.
import type { CatalogItem } from "./types";
import { cleanRelease } from "./catalog";
import { isAnime, parseAnimeEpisode, parseEpisode } from "./media";
import { IN_TAURI } from "../ipc/engine";

const RELAY_POSTER = "https://theblackpearl.tv/api/poster";
const RELAY_BOOK = "https://theblackpearl.tv/api/book";

type RelayKind = "movie" | "tv" | "anime";

/** Book cover from the relay's Open Library endpoint. Ebook names are usually "Title by
 *  Author" — split that so the structured title/author search matches precisely. */
function relayBookUrl(raw: string): string | undefined {
  const clean = raw.replace(/\.(epub|pdf|mobi|azw3?|cbz|cbr|djvu|fb2)$/i, "").trim();
  if (!clean) return undefined;
  const m = clean.match(/^(.*?)\s+by\s+(.+)$/i);
  const title = (m ? m[1] : clean).trim();
  const author = m ? m[2].trim() : "";
  const qs = author
    ? `?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}`
    : `?title=${encodeURIComponent(title)}`;
  return `${RELAY_BOOK}${qs}`;
}

/** Which relay poster kind fits this item, or null when it isn't movie/TV/anime art —
 *  music resolves album art elsewhere; software/books/games/data have no poster to fetch. */
function relayKind(item: CatalogItem): RelayKind | null {
  if (item.category !== "video") return null;
  if (isAnime({ title: item.title })) return "anime";
  // A raw search hit has no mediaType — fall back to the episode pattern in the name.
  return /\bS\d{1,2}\s?E\d{1,3}\b|\bSeason\s+\d|\b\d{1,2}x\d{2}\b/i.test(item.title) ? "tv" : "movie";
}

/**
 * Reduce a raw release/filename to the clean work title the relay can actually match against
 * TMDB/AniList — e.g. "[Anitsu] Kusuriya no Hitorigoto - S01E17 [BD 1080p x265 10bit]" →
 * "Kusuriya no Hitorigoto". A raw filename never matches, which is exactly why so many cards
 * 404 into a broken image. Shared by `relayPosterFor` (catalog cards) and `relayPosterUrl`
 * (library views) so both query the relay with a clean title and by the same TV-Shows grouping.
 */
export function cleanTitleForPoster(rawTitle: string, kind: RelayKind): string | undefined {
  // Strip leading fansub/release [tags] so we search the work, not the group
  // ("[Erai-raws] Re:Zero …" → "Re:Zero …").
  const stripped = rawTitle.replace(/^\s*(?:\[[^\]]*\]\s*)+/, "");
  let cleaned: string;
  if (kind === "anime") {
    // Anime fansub names are "<show> - <abs-episode>"; the trailing episode number breaks the
    // AniList match ("Frieren - 28" 404s, "Frieren" hits), so reduce to the parsed show name.
    // AniList indexes seasons as "2nd Season", not "S2", so drop a trailing abbreviated season.
    const ep = parseAnimeEpisode(rawTitle) ?? parseEpisode(rawTitle);
    cleaned = (ep?.show || cleanRelease(stripped)).replace(/[\s:_-]+S\d{1,2}\s*$/i, "").trim();
  } else {
    cleaned = cleanRelease(stripped);
  }
  return cleaned || undefined;
}

export type { RelayKind };

/**
 * A square cover-art URL for a music share, for direct use as an `<img src>`. When the seeder
 * supplied real tags we query by `artist` (+ the track/album `title`), which the relay's iTunes
 * search resolves far more reliably than a bare filename. Without tags we fall back to the
 * filename: strip the audio extension and any leading track number ("08 - Underwater.m4a" →
 * "Underwater"). A clean miss is a 404 the card falls back from.
 */
export function relayMusicUrl(raw: string, artist?: string | null): string | undefined {
  // Browser preview (no Tauri backend) renders a MOCK library; never let a fake artist/album
  // coincidentally resolve a real copyrighted iTunes cover through the relay — fall back to the
  // gradient placeholder. The shipped desktop app (IN_TAURI) resolves real art as normal.
  if (!IN_TAURI) return undefined;
  const noExt = raw.replace(/\.(mp3|flac|wav|aac|ogg|m4a|opus|alac|wma|aiff?)$/i, "");
  const cleaned = noExt
    .replace(/^\s*\d{1,3}\s*[-._)]\s*/, "") // drop a leading "08 - " / "01. " track number
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = cleaned || raw.trim();
  if (!title) return undefined;
  const art = artist?.trim();
  // Artist + title is the precise query; it disambiguates short titles ("Demons") that a bare
  // filename can't, which is exactly where filename-only guessing was spotty.
  const q = art ? `${art} ${title}` : title;
  const artistParam = art ? `&artist=${encodeURIComponent(art)}` : "";
  return `${RELAY_POSTER}?type=music&title=${encodeURIComponent(q)}${artistParam}`;
}

/**
 * A cover-art URL for a catalog item, for direct use as an `<img src>`. Returns the item's
 * own poster when it already has one, otherwise a relay query (which 404s cleanly when no
 * art exists — the card then shows its gradient). Undefined when the item bears no poster.
 * Pair with `loading="lazy"` so only the cards actually on screen hit the relay.
 */
export function relayPosterFor(item: CatalogItem): string | undefined {
  if (item.poster) return item.poster;
  if (item.category === "books") return relayBookUrl(item.cleanTitle?.trim() || item.title);
  const kind = relayKind(item);
  if (!kind) return undefined;
  const cleaned = item.cleanTitle?.trim() || cleanTitleForPoster(item.title, kind);
  if (!cleaned) return undefined;
  // A year sharpens a movie/TV match; for anime it tends to hurt (season ≠ first air), so skip.
  const ym = kind !== "anime" ? item.title.match(/\b(?:19|20)\d{2}\b/) : null;
  const year = ym ? `&year=${ym[0]}` : "";
  return `${RELAY_POSTER}?type=${kind}&title=${encodeURIComponent(cleaned)}${year}`;
}
