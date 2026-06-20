import { useEffect, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { PosterRow } from "./PosterRow";
import { AnimeDiscoverRows } from "./AnimeDiscoverRows";
import { IN_TAURI } from "../ipc/engine";
import { checkAvailability, discoverFeed, type DiscoverFeed, type TrendingItem } from "../ipc/discover";
import { hueFromString } from "../lib/catalog";
import type { DiscoverTab } from "../lib/media";
import { book, clapperboard, gamepad2, music as musicIcon, search as searchIcon, star, tv } from "../lib/icons";
import "../views/Anime.css";
import "./DiscoverTrending.css";

const KIND_GLYPH: Record<string, string> = {
  movie: clapperboard, tv: tv, music: musicIcon, book: book, game: gamepad2,
};
const KIND_LABEL: Record<string, string> = {
  movie: "Movie", tv: "Show", music: "Music", book: "Book", game: "Game",
};

// Session cache: switching tabs (or returning to one) shouldn't refetch — these lists barely
// change within a session and the relay/keyless sources are rate-limited. Entries carry a
// timestamp and go stale after TTL so a one-off odd/skewed relay response can't stay pinned
// for the whole session — once stale we keep showing it but refetch fresh data in the
// background.
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { feed: DiscoverFeed; ts: number }>();

/** Albums/books search better with the artist/author appended; titles alone suffice elsewhere. */
function searchQuery(it: TrendingItem): string {
  return (it.kind === "music" || it.kind === "book" || it.kind === "game") && it.subtitle
    ? `${it.title} ${it.subtitle}`
    : it.title;
}

/** External Discover content for one category, pulled from free sources: a hero billboard +
 *  several rows. A click runs a source search (same as the anime rails). Anime delegates. */
export function DiscoverTrending({ category, onSearch }: { category: DiscoverTab; onSearch: (q: string) => void }) {
  if (category === "anime") return <AnimeDiscoverRows onSearch={onSearch} />;
  if (category === "all") return null;
  return <DiscoverFeedView category={category} onSearch={onSearch} />;
}

function DiscoverFeedView({ category, onSearch }: { category: string; onSearch: (q: string) => void }) {
  const [feed, setFeed] = useState<DiscoverFeed | null>(() => cache.get(category)?.feed ?? null);
  // Map of search-query → does any source have a torrent for it. Missing = not yet checked
  // (shown normally); explicit false = grayed out.
  const [avail, setAvail] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!IN_TAURI) return;
    setAvail({});
    const cached = cache.get(category);
    const fresh = cached && Date.now() - cached.ts < CACHE_TTL_MS;
    if (cached) setFeed(cached.feed);
    else setFeed(null);
    // Up-to-date cache hit — nothing to fetch.
    if (fresh) return;
    let alive = true;
    discoverFeed(category)
      .then((f) => {
        cache.set(category, { feed: f, ts: Date.now() });
        if (alive) setFeed(f);
      })
      .catch(() => {
        // Keep any stale-but-usable cached feed on error; only blank when we had nothing.
        if (alive && !cached) setFeed({ hero: null, rows: [] });
      });
    return () => {
      alive = false;
    };
  }, [category]);

  // Probe the user's sources for each item once the feed is in. Batched per row (deduped)
  // so cards gray out progressively; the backend caps concurrency + caches the results.
  useEffect(() => {
    if (!IN_TAURI || !feed) return;
    let alive = true;
    const seen = new Set<string>();
    const fresh = (q: string) => (seen.has(q) ? false : (seen.add(q), true));
    const batches: string[][] = [];
    if (feed.hero) {
      const q = searchQuery(feed.hero);
      if (fresh(q)) batches.push([q]);
    }
    for (const row of feed.rows) {
      const qs = row.items.map(searchQuery).filter(fresh);
      if (qs.length) batches.push(qs);
    }
    for (const qs of batches) {
      checkAvailability(qs)
        .then((bools) => {
          if (!alive) return;
          setAvail((prev) => {
            const next = { ...prev };
            qs.forEach((q, i) => { next[q] = bools[i] ?? true; });
            return next;
          });
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [feed]);

  if (!feed || feed.rows.length === 0) return null;
  return (
    <div className="disc-feed">
      {feed.hero && <DiscoverHero item={feed.hero} available={avail[searchQuery(feed.hero)]} onSearch={onSearch} />}
      {feed.rows.map((row) => (
        <PosterRow key={row.title} title={row.title} count={row.items.length}>
          {row.items.map((it, i) => (
            <TrendingCard key={`${it.title}-${i}`} item={it} available={avail[searchQuery(it)]} onSearch={onSearch} />
          ))}
        </PosterRow>
      ))}
    </div>
  );
}

function DiscoverHero({ item, available, onSearch }: { item: TrendingItem; available?: boolean; onSearch: (q: string) => void }) {
  const hue = hueFromString(item.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 38% 22%), hsl(${(hue + 40) % 360} 46% 12%))`;
  const art = item.backdrop || item.poster;
  const unavailable = available === false;
  const meta = [
    item.year ? String(item.year) : null,
    item.genre,
    KIND_LABEL[item.kind],
  ].filter(Boolean);
  return (
    <div className={`disc-hero${unavailable ? " is-unavailable" : ""}`}>
      <div className="disc-hero-bg" style={art ? { backgroundImage: `url(${art})` } : { background: bg }} aria-hidden />
      <div className="disc-hero-scrim" aria-hidden />
      <div className="disc-hero-inner">
        <div className="disc-hero-art" style={item.poster ? undefined : { background: bg }}>
          {item.poster ? (
            <img src={item.poster} alt="" loading="lazy" />
          ) : (
            <span className="poster-glyph"><Icon icon={KIND_GLYPH[item.kind] ?? searchIcon} size="2xl" /></span>
          )}
        </div>
        <div className="disc-hero-body">
          <span className="disc-hero-kicker">Trending now</span>
          <h2 className="disc-hero-title" title={item.title}>{item.title}</h2>
          <div className="disc-hero-meta">
            {item.rating != null && (
              <span className="disc-hero-rating"><Icon icon={star} size="xs" /> {item.rating.toFixed(1)}</span>
            )}
            {meta.map((m, i) => <span key={i}>{m}</span>)}
            {item.subtitle && <span className="disc-hero-sub">{item.subtitle}</span>}
          </div>
          {item.overview && <p className="disc-hero-overview">{item.overview}</p>}
          <div className="disc-hero-cta">
            <Button variant="primary" shape="pill" icon={searchIcon} onClick={() => onSearch(searchQuery(item))}>
              Find sources
            </Button>
            {unavailable && <span className="disc-hero-na">No torrents found</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function TrendingCard({ item, available, onSearch }: { item: TrendingItem; available?: boolean; onSearch: (q: string) => void }) {
  const hue = hueFromString(item.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  const glyph = KIND_GLYPH[item.kind] ?? searchIcon;
  const info = [item.subtitle, item.genre, item.year ? String(item.year) : null].filter(Boolean).join(" · ");
  const unavailable = available === false;
  return (
    <div
      className={`poster-card${unavailable ? " is-unavailable" : ""}`}
      role="button"
      tabIndex={0}
      title={unavailable ? `${item.title} — no torrents found in your sources` : item.title}
      onClick={() => onSearch(searchQuery(item))}
      onKeyDown={(e) => e.key === "Enter" && onSearch(searchQuery(item))}
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
        <div className="poster-info"><span>{info}</span></div>
      </div>
    </div>
  );
}
