import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { PosterGridSkeleton } from "../components/Skeletons";
import { PosterArt, SeriesArt } from "../components/PosterArt";
import { useInfiniteScroll } from "../lib/useInfiniteScroll";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { removeFromLibrary, revealPath, trashDownloaded, type DownloadedItem } from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { useShareControls } from "../ipc/shares";
import { hueFromString } from "../lib/catalog";
import { formatBytes } from "../lib/format";
import { chevronLeft, circlePlay, clapperboard, folderOpen, images, library, rotateCw, trash2, upload } from "../lib/icons";

interface MoviesProps {
  onPlayLocal: (item: DownloadedItem) => void;
  posterFor?: (title: string, kind?: string) => string | undefined;
  onReplacePoster?: (title: string) => void;
  /** Signals when the view is first usable for perf timing. */
  onReady?: (meta?: Record<string, string | number | boolean | null>) => void;
}

export function Movies({ onPlayLocal, posterFor, onReplacePoster, onReady }: MoviesProps) {
  const { items: all, refresh } = useDownloaded();
  const [detail, setDetail] = useState<DownloadedItem | null>(null);
  const ctx = useContextMenu();
  const { shareItem } = useShareControls();

  const loading = all === null;

  const movies = useMemo(
    () => (all ?? []).filter((i) => i.mediaType === "movie" && i.inLibrary).sort((a, b) => a.title.localeCompare(b.title)),
    [all],
  );
  // Render a page at a time + grow on scroll so a big movie library doesn't lock the UI on mount.
  const { visible: visibleMovies, sentinelRef, hasMore } = useInfiniteScroll(movies);

  useEffect(() => {
    if (loading) return;
    onReady?.({
      movies: movies.length,
      rendered: visibleMovies.length,
      detailOpen: !!detail,
    });
  }, [detail, loading, movies.length, onReady, visibleMovies.length]);

  function fileActions(it: DownloadedItem): MenuAction[] {
    return [
      { label: "Play", icon: circlePlay, onSelect: () => onPlayLocal(it) },
      { label: "Replace poster…", icon: images, onSelect: () => onReplacePoster?.(it.title) },
      { label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(it.id) },
      { label: "Share with network", icon: upload, divider: true, onSelect: () => shareItem({ id: it.id, title: it.title, local: true }) },
      { label: "Remove from library", icon: library, divider: true, onSelect: () => void removeFromLibrary(it.id).then(() => refresh()) },
      { label: "Move to Trash", icon: trash2, danger: true, onSelect: () => void trashDownloaded(it.id).then(() => refresh()) },
    ];
  }

  if (detail) {
    const fmt = detail.fileName.split(".").pop()?.toUpperCase();
    return (
      <div className="series media-wide">
        <button className="series-back" onClick={() => setDetail(null)}><Icon icon={chevronLeft} size="sm" /> Movies</button>
        <div className="series-head">
          <div className="series-art"><SeriesArt src={posterFor?.(detail.title, "movie")} glyph={clapperboard} /></div>
          <div className="series-info">
            <h2 className="series-name">{detail.title}</h2>
            <div className="series-meta">{["Movie", fmt, formatBytes(detail.sizeBytes)].filter(Boolean).join(" · ")}</div>
            <div className="form-actions" style={{ marginTop: 16 }}>
              <Button variant="primary" icon={circlePlay} onClick={() => onPlayLocal(detail)}>Play</Button>
              {onReplacePoster && <Button variant="ghost" onClick={() => onReplacePoster(detail.title)}>Replace poster…</Button>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="section-stack media-wide">
      <div className="cat-header">
        <span className="cat-title section-title"><Icon icon={clapperboard} size="base" /> Movies</span>
        {movies.length > 0 && <span className="cat-sub">{movies.length}</span>}
        <div className="cat-controls">
          <Button variant="secondary" shape="pill" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      {loading ? (
        <PosterGridSkeleton />
      ) : movies.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <img src="/hero-movies.png" alt="" style={{ width: 184, height: "auto", marginBottom: 8 }} />
            <h3>No movies in your library yet</h3>
            <p>Find films under <b>Discover</b> and download them — they'll show up here ready to play.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="cat-grid">
            {visibleMovies.map((it) => (
              <Card
                key={it.id}
                item={it}
                poster={posterFor?.(it.title, "movie")}
                onClick={() => setDetail(it)}
                onContextMenu={(e) => ctx.open(e, fileActions(it))}
              />
            ))}
          </div>
          {hasMore && <div ref={sentinelRef} style={{ height: 1 }} aria-hidden />}
        </>
      )}
      {ctx.menu}
    </div>
  );
}

function Card({ item, poster, onClick, onContextMenu }: { item: DownloadedItem; poster?: string; onClick: () => void; onContextMenu?: (e: MouseEvent) => void }) {
  const hue = hueFromString(item.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} onContextMenu={onContextMenu} role="button" tabIndex={0}>
      <div className="poster" style={{ background: bg }}>
        <PosterArt src={poster} glyph={clapperboard} />
        <div className="poster-seed"><span className="play-badge"><Icon icon={circlePlay} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={item.title}>{item.title}</div>
        <div className="poster-info"><span>{formatBytes(item.sizeBytes)}</span></div>
      </div>
    </div>
  );
}
