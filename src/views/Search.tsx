import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { SegmentedControl } from "@mattmattmattmatt/base/primitives/segmented-control/SegmentedControl";
import { PosterCard } from "../components/PosterCard";
import { PosterGridSkeleton } from "../components/Skeletons";
import { useInfiniteScroll } from "../lib/useInfiniteScroll";
import { PosterRow } from "../components/PosterRow";
import { FeaturedCarousel } from "../components/FeaturedCarousel";
import { AnimeDiscoverRows } from "../components/AnimeDiscoverRows";
import { DiscoverTrending } from "../components/DiscoverTrending";
import { useDownloaded } from "../ipc/libraryCache";
import type { CatalogItem, Category, SortKey } from "../lib/types";
import { isMusicImportLink, type LibraryItem, type MovieDigest } from "../ipc/library";
import { isAnime, sectionOf, ANIME_GENRES, DISCOVER_TABS, type DiscoverTab, type MediaSectionId } from "../lib/media";
import { CATEGORY_LABEL, cleanRelease, qualityOf, QUALITIES, sortCatalog, streamFormat, type Quality } from "../lib/catalog";
import { anime as animeIcon, clapperboard, gamepad2, history, link2, music, plus, search as searchIcon, trendingUp, tv } from "../lib/icons";

interface SearchProps {
  query: string;
  results: CatalogItem[];
  loading: boolean;
  error: string | null;
  recents: string[];
  popular: string[];
  /** Browsable catalog grouped by media type — powers the billboard + carousels. */
  sections: Record<MediaSectionId, LibraryItem[]>;
  /** Curated featured digests from the relay (carousel). Falls back to the local pool. */
  featured: MovieDigest[];
  onSearch: (q: string) => void;
  onAddMagnet: (m: string) => void;
  onClearRecents: () => void;
  onPlay: (item: CatalogItem) => void;
  /** Queue an item for download without streaming. */
  onQueue: (item: CatalogItem, forceDuplicate?: boolean) => void;
  /** Paste a Spotify playlist link to jump straight into Replicate. */
  onSpotify?: (url: string) => void;
  /** Signals when the view is first usable for perf timing. */
  onReady?: (meta?: Record<string, string | number | boolean | null>) => void;
}

const MAGNET_RE = /^magnet:\?xt=urn:btih:/i;
const CATEGORY_ORDER: Category[] = ["video", "audio", "data", "books", "other"];
const SORTS: { key: SortKey; label: string }[] = [
  { key: "popularity", label: "Popularity" },
  { key: "size", label: "Size" },
  { key: "recent", label: "Recent" },
];
type FormatFilter = "all" | "native" | "convert";

// Genre chips for the Discover home — each runs a live source search for that genre.
const MOVIE_GENRES = [
  "Action", "Comedy", "Drama", "Horror", "Sci-Fi", "Thriller",
  "Romance", "Animation", "Documentary", "Crime", "Fantasy", "Western",
];
const TV_GENRES = [
  "Drama", "Comedy", "Crime", "Sci-Fi", "Reality", "Documentary",
  "Animation", "Fantasy", "Mystery", "Anime",
];

// Per-tab genre chip section shown on a specific Discover category (not on "All").
const TAB_GENRES: Partial<Record<DiscoverTab, { glyph: string; label: string; genres: string[] }>> = {
  movies: { glyph: clapperboard, label: "Movies by genre", genres: MOVIE_GENRES },
  tvshows: { glyph: tv, label: "TV by genre", genres: TV_GENRES },
  anime: { glyph: animeIcon, label: "Anime by genre", genres: ANIME_GENRES },
  games: {
    glyph: gamepad2,
    label: "ROM platforms",
    genres: [
      "SNES ROM",
      "GBA ROM",
      "NDS ROM",
      "N64 ROM",
      "PS1 ROM",
      "PS2 ISO",
      "PSP ISO",
      "Genesis ROM",
      "Arcade ROM",
    ],
  },
};

function normDownloadedTitle(raw: string): string {
  return cleanRelease(raw)
    .replace(/\.(mkv|mp4|webm|avi|mov|m4v|mp3|flac|m4a|aac|ogg|opus|wav|wma|alac|aiff|aif|epub|pdf|mobi|azw3?|fb2|djvu|cbz|cbr|nsp|xci|iso|rom)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function Search({
  query,
  results,
  loading,
  error,
  recents,
  popular,
  sections,
  featured,
  onSearch,
  onAddMagnet,
  onClearRecents,
  onPlay,
  onQueue,
  onSpotify,
  onReady,
}: SearchProps) {
  const { items: downloaded } = useDownloaded();
  const [value, setValue] = useState(query);
  const [tab, setTab] = useState<DiscoverTab>("all");
  const [sort, setSort] = useState<SortKey>("popularity");
  const [category, setCategory] = useState<Category | "all">("all");
  const [format, setFormat] = useState<FormatFilter>("all");
  const [quality, setQuality] = useState<Quality | "all">("all");
  const [wellSeeded, setWellSeeded] = useState(false);
  const [source, setSource] = useState<string | "all">("all");

  useEffect(() => setValue(query), [query]);

  const trimmed = value.trim();
  const isMagnet = MAGNET_RE.test(trimmed);
  const isSpotify = isMusicImportLink(trimmed);
  function submit() {
    const v = value.trim();
    if (isMusicImportLink(v)) onSpotify?.(v);
    else if (MAGNET_RE.test(v)) onAddMagnet(v);
    else if (v) onSearch(v);
  }

  const actionLabel = isSpotify ? "Import" : isMagnet ? "Stream" : "Search";
  const actionIcon = isSpotify ? music : isMagnet ? plus : searchIcon;

  const present = useMemo(() => {
    const set = new Set(results.map((r) => r.category));
    return CATEGORY_ORDER.filter((c) => set.has(c));
  }, [results]);

  // Which quality classes actually appear in the results — only show those chips.
  const presentQualities = useMemo(() => {
    const set = new Set(results.map((r) => qualityOf(r.title)).filter(Boolean) as Quality[]);
    return QUALITIES.filter((q) => set.has(q));
  }, [results]);

  // The sources represented in the current results — drives the "by source" filter (shown
  // only when more than one source contributed hits).
  const presentSources = useMemo(() => {
    const set = new Set(results.map((r) => r.source).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [results]);

  const downloadedTitles = useMemo(() => {
    const keys = new Set<string>();
    for (const it of downloaded ?? []) {
      const byTitle = normDownloadedTitle(it.title);
      if (byTitle) keys.add(byTitle);
      const byFile = normDownloadedTitle(it.fileName);
      if (byFile) keys.add(byFile);
    }
    return keys;
  }, [downloaded]);

  const alreadyDownloaded = useCallback(
    (item: CatalogItem) => {
      const key = normDownloadedTitle(item.cleanTitle?.trim() || item.title);
      return !!key && downloadedTitles.has(key);
    },
    [downloadedTitles],
  );

  const visible = useMemo(() => {
    let list = results;
    // The Discover category toggle filters by media section (anime is cross-cutting).
    if (tab === "anime") list = list.filter((r) => isAnime(r));
    else if (tab !== "all") list = list.filter((r) => sectionOf(r) === tab);
    if (category !== "all") list = list.filter((r) => r.category === category);
    if (format !== "all") list = list.filter((r) => streamFormat(r.title) === format);
    if (quality !== "all") list = list.filter((r) => qualityOf(r.title) === quality);
    if (wellSeeded) list = list.filter((r) => r.seeders >= 10);
    // Guard on presentSources so a stale source pick (after a new search) is ignored rather
    // than zeroing out the results.
    if (source !== "all" && presentSources.includes(source)) list = list.filter((r) => r.source === source);
    return sortCatalog(list, sort);
  }, [results, tab, category, format, quality, wellSeeded, source, presentSources, sort]);

  // Page the results grid on scroll so a big result set doesn't lock the UI mounting every card.
  const { visible: visiblePage, sentinelRef, hasMore } = useInfiniteScroll(visible);

  // ---- Discover billboard + carousels (the idle home) ----
  const pool = useMemo(
    () => [...sections.movies, ...sections.tvshows, ...sections.music],
    [sections],
  );
  // Featured carousel: the relay's curated digests, else the top of the local pool
  // mapped into the same digest shape (poster as backdrop; no trailer without the relay).
  const featuredSlides = useMemo<MovieDigest[]>(() => {
    if (featured.length > 0) return featured.slice(0, 6);
    return [...pool]
      .sort((a, b) => b.seeders - a.seeders)
      .slice(0, 5)
      .map((it) => ({
        kind: "movie",
        title: it.cleanTitle || cleanRelease(it.title.replace(/^\[[^\]]*\]\s*/, "")),
        year: it.year ?? null,
        tmdbId: 0,
        imdbId: null,
        overview: it.description ?? null,
        tagline: null,
        runtimeMinutes: null,
        genres: it.genre ? [it.genre] : [],
        rating: null,
        imdbRating: it.imdbRating ?? null,
        rtRating: it.rtRating ?? null,
        poster: it.poster ?? null,
        backdrop: it.poster ?? null,
        trailerYoutubeKey: null,
        cast: [],
        director: null,
      }));
  }, [featured, pool]);
  const trending = useMemo(() => [...pool].sort((a, b) => b.seeders - a.seeders).slice(0, 24), [pool]);
  const animeItems = useMemo(
    () => [...sections.movies, ...sections.tvshows].filter((it) => isAnime(it)).sort((a, b) => b.seeders - a.seeders).slice(0, 24),
    [sections],
  );
  // The current tab's local-library row (shown alongside its external trending row).
  const tabSection: MediaSectionId | null = tab === "all" || tab === "anime" ? null : tab;
  const localItems = tab === "anime" ? animeItems : tabSection ? sections[tabSection] : [];
  const tabGenres = tab !== "all" ? TAB_GENRES[tab] : undefined;

  const idle = !query && !loading && !error;
  const showControls = !idle && !loading && !error && results.length > 0;

  useEffect(() => {
    if (loading) return;
    onReady?.({
      tab,
      idle,
      hasQuery: query.trim().length > 0,
      hasError: !!error,
      results: results.length,
      visible: visible.length,
    });
  }, [error, idle, loading, onReady, query, results.length, tab, visible.length]);

  return (
    <div className="search-page">
      <div className="search-hero">
        <div className="search-bar-lg">
          <Input
            iconLeft={isMagnet || isSpotify ? link2 : searchIcon}
            placeholder="Search sources, or paste a magnet or Spotify playlist link…"
            shape="pill"
            size="lg"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            onClear={() => { setValue(""); onSearch(""); }}
          />
          <Button variant="primary" shape="pill" size="lg" icon={actionIcon} onClick={submit}>
            {actionLabel}
          </Button>
        </div>
      </div>

      <SegmentedControl
        className="discover-tabs"
        options={DISCOVER_TABS.map((t) => ({ value: t.id, label: t.label }))}
        value={tab}
        onChange={(v) => setTab(v as DiscoverTab)}
      />

      {idle ? (
        <div className="home">
          {tab === "all" ? (
          <>
          {featuredSlides.length > 0 && (
            <FeaturedCarousel items={featuredSlides} onFind={onSearch} />
          )}

          {featuredSlides.length === 0 &&
            trending.length === 0 &&
            sections.movies.length === 0 &&
            sections.tvshows.length === 0 &&
            sections.music.length === 0 && (
              <div style={{ textAlign: "center", padding: "24px 0 4px" }}>
                <img src="/hero-discover.png" alt="" style={{ width: "min(560px, 78%)", height: "auto" }} />
                <h2 style={{ margin: "6px 0 4px", fontSize: "var(--text-xl-size)", fontWeight: 700, letterSpacing: "-0.01em" }}>
                  Welcome aboard
                </h2>
                <p style={{ color: "var(--gg-text-dim)" }}>
                  Search above, or add sources under <b>Sources</b> to start filling your library.
                </p>
              </div>
            )}

          {trending.length > 0 && (
            <PosterRow title="Trending now">
              {trending.map((it) => (
                <PosterCard
                  key={it.id}
                  item={it}
                  square={it.category === "audio"}
                  onPlay={() => onPlay(it)}
                  onQueue={(forceDuplicate) => onQueue(it, forceDuplicate)}
                  alreadyDownloaded={alreadyDownloaded(it)}
                />
              ))}
            </PosterRow>
          )}
          {sections.movies.length > 0 && (
            <PosterRow title="Movies" count={sections.movies.length}>
              {sections.movies.slice(0, 24).map((it) => (
                <PosterCard
                  key={it.id}
                  item={it}
                  onPlay={() => onPlay(it)}
                  onQueue={(forceDuplicate) => onQueue(it, forceDuplicate)}
                  alreadyDownloaded={alreadyDownloaded(it)}
                />
              ))}
            </PosterRow>
          )}
          {sections.tvshows.length > 0 && (
            <PosterRow title="TV Shows" count={sections.tvshows.length}>
              {sections.tvshows.slice(0, 24).map((it) => (
                <PosterCard
                  key={it.id}
                  item={it}
                  onPlay={() => onPlay(it)}
                  onQueue={(forceDuplicate) => onQueue(it, forceDuplicate)}
                  alreadyDownloaded={alreadyDownloaded(it)}
                />
              ))}
            </PosterRow>
          )}
          {animeItems.length > 0 && (
            <PosterRow title="Anime" count={animeItems.length}>
              {animeItems.map((it) => (
                <PosterCard
                  key={it.id}
                  item={it}
                  onPlay={() => onPlay(it)}
                  onQueue={(forceDuplicate) => onQueue(it, forceDuplicate)}
                  alreadyDownloaded={alreadyDownloaded(it)}
                />
              ))}
            </PosterRow>
          )}
          {/* Popular/trending/seasonal anime from AniList + MyAnimeList → run a search. */}
          <AnimeDiscoverRows onSearch={onSearch} />
          {sections.music.length > 0 && (
            <PosterRow title="Music" count={sections.music.length}>
              {sections.music.slice(0, 24).map((it) => (
                <PosterCard
                  key={it.id}
                  item={it}
                  square
                  onPlay={() => onPlay(it)}
                  onQueue={(forceDuplicate) => onQueue(it, forceDuplicate)}
                  alreadyDownloaded={alreadyDownloaded(it)}
                />
              ))}
            </PosterRow>
          )}

          <div className="home-chips">
            {recents.length > 0 && (
              <section className="search-sec">
                <div className="search-sec-head">
                  <span className="search-sec-title"><Icon icon={history} size="sm" /> Recent searches</span>
                  <button className="search-sec-action" onClick={onClearRecents}>Clear</button>
                </div>
                <div className="chip-row">
                  {recents.map((r) => (
                    <button key={r} className="search-chip" onClick={() => onSearch(r)}>{r}</button>
                  ))}
                </div>
              </section>
            )}
            <section className="search-sec">
              <div className="search-sec-head">
                <span className="search-sec-title"><Icon icon={clapperboard} size="sm" /> Movies by genre</span>
              </div>
              <div className="chip-row">
                {MOVIE_GENRES.map((g) => (
                  <button key={g} className="search-chip" onClick={() => onSearch(g)}>{g}</button>
                ))}
              </div>
            </section>
            <section className="search-sec">
              <div className="search-sec-head">
                <span className="search-sec-title"><Icon icon={tv} size="sm" /> TV by genre</span>
              </div>
              <div className="chip-row">
                {TV_GENRES.map((g) => (
                  <button key={g} className="search-chip" onClick={() => onSearch(g)}>{g}</button>
                ))}
              </div>
            </section>
            <section className="search-sec">
              <div className="search-sec-head">
                <span className="search-sec-title"><Icon icon={animeIcon} size="sm" /> Anime by genre</span>
              </div>
              <div className="chip-row">
                {ANIME_GENRES.map((g) => (
                  <button key={g} className="search-chip" onClick={() => onSearch(g === "Anime" ? "anime" : `anime ${g}`)}>{g}</button>
                ))}
              </div>
            </section>
            <section className="search-sec">
              <div className="search-sec-head">
                <span className="search-sec-title"><Icon icon={trendingUp} size="sm" /> Popular</span>
              </div>
              <div className="chip-row">
                {popular.map((p) => (
                  <button key={p} className="search-chip" onClick={() => onSearch(p)}>{p}</button>
                ))}
              </div>
            </section>
          </div>
          </>
          ) : (
            <>
              <DiscoverTrending category={tab} onSearch={onSearch} />
              {localItems.length > 0 && (
                <PosterRow title="In your library" count={localItems.length}>
                  {localItems.slice(0, 24).map((it) => (
                    <PosterCard
                      key={it.id}
                      item={it}
                      square={tab === "music"}
                      onPlay={() => onPlay(it)}
                      onQueue={(forceDuplicate) => onQueue(it, forceDuplicate)}
                      alreadyDownloaded={alreadyDownloaded(it)}
                    />
                  ))}
                </PosterRow>
              )}
              {tabGenres && (
                <div className="home-chips">
                  <section className="search-sec">
                    <div className="search-sec-head">
                      <span className="search-sec-title"><Icon icon={tabGenres.glyph} size="sm" /> {tabGenres.label}</span>
                    </div>
                    <div className="chip-row">
                      {tabGenres.genres.map((g) => (
                        <button key={g} className="search-chip" onClick={() => onSearch(tab === "anime" ? (g === "Anime" ? "anime" : `anime ${g}`) : g)}>{g}</button>
                      ))}
                    </div>
                  </section>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="cat-header">
            <span className="cat-title">Results</span>
            {query && !loading && (
              <span className="cat-sub">“{query}” · {visible.length}/{results.length}</span>
            )}
            {showControls && (
              <div className="cat-controls">
                <SegmentedControl
                  options={SORTS.map((o) => ({ value: o.key, label: o.label }))}
                  value={sort}
                  onChange={(v) => setSort(v as SortKey)}
                />
              </div>
            )}
          </div>

          {showControls && (
            <div className="cat-filters">
              <SegmentedControl
                options={[{ value: "all", label: "All" }, ...present.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))]}
                value={category}
                onChange={(v) => setCategory(v as Category | "all")}
              />
              <SegmentedControl
                options={[
                  { value: "all", label: "Any format" },
                  { value: "native", label: "Plays natively" },
                  { value: "convert", label: "Needs convert" },
                ]}
                value={format}
                onChange={(v) => setFormat(v as FormatFilter)}
              />
              {presentQualities.length > 0 && (
                <SegmentedControl
                  options={[{ value: "all", label: "Any quality" }, ...presentQualities.map((q) => ({ value: q, label: q }))]}
                  value={quality}
                  onChange={(v) => setQuality(v as Quality | "all")}
                />
              )}
              <SegmentedControl
                options={[
                  { value: "any", label: "All seeders" },
                  { value: "well", label: "Well-seeded" },
                ]}
                value={wellSeeded ? "well" : "any"}
                onChange={(v) => setWellSeeded(v === "well")}
              />
              {presentSources.length > 1 && (
                <SegmentedControl
                  options={[{ value: "all", label: "All sources" }, ...presentSources.map((s) => ({ value: s, label: s }))]}
                  value={source}
                  onChange={(v) => setSource(v)}
                />
              )}
            </div>
          )}

          {loading ? (
            <PosterGridSkeleton count={12} />
          ) : error ? (
            <div className="empty">
              <div className="empty-inner">
                <h3>Search failed</h3>
                <p>{error}</p>
              </div>
            </div>
          ) : results.length === 0 ? (
            <div className="empty">
              <div className="empty-inner">
                <img src="/hero-ship.png" alt="" style={{ width: 200, height: "auto", marginBottom: 8 }} />
                <h3>No results</h3>
                <p>Nothing matched “{query}” across your linked sources.</p>
              </div>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty">
              <div className="empty-inner">
                <h3>No matches</h3>
                {tab !== "all" ? (
                  <>
                    <p>
                      No <b>{DISCOVER_TABS.find((t) => t.id === tab)?.label}</b> results for “{query}” — the category
                      filter is hiding {results.length} other result{results.length === 1 ? "" : "s"}.
                    </p>
                    <Button variant="secondary" shape="pill" onClick={() => setTab("all")}>Show all results</Button>
                  </>
                ) : (
                  <p>No results match these filters — try “Any format” or a different category.</p>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="cat-grid">
                {visiblePage.map((it) => (
                  <PosterCard
                    key={it.id}
                    item={it}
                    square={it.category === "audio"}
                    onPlay={() => onPlay(it)}
                    onQueue={(forceDuplicate) => onQueue(it, forceDuplicate)}
                    alreadyDownloaded={alreadyDownloaded(it)}
                  />
                ))}
              </div>
              {hasMore && <div ref={sentinelRef} style={{ height: 1 }} aria-hidden />}
            </>
          )}
        </>
      )}
    </div>
  );
}
