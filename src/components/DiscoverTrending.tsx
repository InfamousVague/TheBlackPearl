import { useEffect, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { PosterRow } from "./PosterRow";
import { AnimeDiscoverRows } from "./AnimeDiscoverRows";
import { IN_TAURI } from "../ipc/engine";
import { trending, type TrendingItem } from "../ipc/discover";
import { hueFromString } from "../lib/catalog";
import type { DiscoverTab } from "../lib/media";
import { book, clapperboard, gamepad2, music as musicIcon, search as searchIcon, tv } from "../lib/icons";
import "../views/Anime.css";

const ROW_TITLE: Record<string, string> = {
  movies: "Trending movies",
  tvshows: "Trending shows",
  music: "Top albums",
  books: "Trending books",
  games: "Top games",
};

const KIND_GLYPH: Record<string, string> = {
  movie: clapperboard,
  tv: tv,
  music: musicIcon,
  book: book,
  game: gamepad2,
};

// Session cache: switching tabs (or returning to one) shouldn't refetch — these lists barely
// change within a session, and the relay/keyless sources are rate-limited.
const cache = new Map<string, TrendingItem[]>();

/** External "top/trending" rows for one Discover category, pulled from free sources. A click
 *  runs a source search (same as the anime rails). Anime delegates to `AnimeDiscoverRows`. */
export function DiscoverTrending({ category, onSearch }: { category: DiscoverTab; onSearch: (q: string) => void }) {
  if (category === "anime") return <AnimeDiscoverRows onSearch={onSearch} />;
  if (category === "all") return null;
  return <TrendingRow category={category} onSearch={onSearch} />;
}

function TrendingRow({ category, onSearch }: { category: string; onSearch: (q: string) => void }) {
  const [items, setItems] = useState<TrendingItem[] | null>(() => cache.get(category) ?? null);

  useEffect(() => {
    if (!IN_TAURI) return;
    const cached = cache.get(category);
    if (cached) {
      setItems(cached);
      return;
    }
    let alive = true;
    setItems(null);
    trending(category)
      .then((list) => {
        cache.set(category, list);
        if (alive) setItems(list);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [category]);

  if (!items || items.length === 0) return null;
  return (
    <PosterRow title={ROW_TITLE[category] ?? "Trending"} count={items.length}>
      {items.map((it, i) => (
        <TrendingCard key={`${it.title}-${i}`} item={it} onSearch={onSearch} />
      ))}
    </PosterRow>
  );
}

function TrendingCard({ item, onSearch }: { item: TrendingItem; onSearch: (q: string) => void }) {
  const hue = hueFromString(item.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  // Albums/books search better with the artist/author appended; titles alone suffice elsewhere.
  const query =
    (item.kind === "music" || item.kind === "book") && item.subtitle
      ? `${item.title} ${item.subtitle}`
      : item.title;
  const glyph = KIND_GLYPH[item.kind] ?? searchIcon;
  return (
    <div
      className="poster-card"
      role="button"
      tabIndex={0}
      title={item.title}
      onClick={() => onSearch(query)}
      onKeyDown={(e) => e.key === "Enter" && onSearch(query)}
    >
      <div className="poster" style={item.poster ? undefined : { background: bg }}>
        {item.poster ? (
          <img className="poster-img" src={item.poster} alt="" loading="lazy" />
        ) : (
          <span className="poster-glyph"><Icon icon={glyph} size="2xl" /></span>
        )}
        {item.rating != null && <span className="anime-score">★ {item.rating.toFixed(1)}</span>}
        <div className="poster-seed"><span className="play-badge"><Icon icon={searchIcon} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={item.title}>{item.title}</div>
        <div className="poster-info"><span>{[item.subtitle, item.year].filter(Boolean).join(" · ")}</span></div>
      </div>
    </div>
  );
}
