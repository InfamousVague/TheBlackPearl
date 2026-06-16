import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { PosterGridSkeleton } from "../components/Skeletons";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { removeFromLibrary, revealPath, trashDownloaded, type DownloadedItem } from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { hueFromString } from "../lib/catalog";
import { formatBytes } from "../lib/format";
import { isAnime } from "../lib/media";
import { anime as animeIcon, chevronLeft, circlePlay, folderOpen, images, library, link2, rotateCw, trash2, tv } from "../lib/icons";

interface AnimeProps {
  onPlayLocal: (item: DownloadedItem) => void;
  posterFor?: (title: string) => string | undefined;
  onReplacePoster?: (title: string) => void;
  /** Run a source search (jumps to Discover results) — used by "Find anime". */
  onBrowse: (q: string) => void;
}

export function Anime({ onPlayLocal, posterFor, onReplacePoster, onBrowse }: AnimeProps) {
  const { items: all, refresh } = useDownloaded();
  const [detail, setDetail] = useState<DownloadedItem | null>(null);
  const ctx = useContextMenu();

  useEffect(() => { void refresh(); }, [refresh]);
  const loading = all === null;

  // Anime crosses Movies + TV, so we filter every in-library video by the anime
  // heuristic (genre / fansub tags) rather than a single mediaType.
  const items = useMemo(
    () =>
      (all ?? [])
        .filter((i) => i.inLibrary && (i.mediaType === "movie" || i.mediaType === "show") && isAnime(i))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [all],
  );

  function fileActions(it: DownloadedItem): MenuAction[] {
    return [
      { label: "Play", icon: circlePlay, onSelect: () => onPlayLocal(it) },
      { label: "Replace poster…", icon: images, onSelect: () => onReplacePoster?.(it.title) },
      { label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(it.id) },
      { label: "Remove from library", icon: library, divider: true, onSelect: () => void removeFromLibrary(it.id).then(() => refresh()) },
      { label: "Move to Trash", icon: trash2, danger: true, onSelect: () => void trashDownloaded(it.id).then(() => refresh()) },
    ];
  }

  if (detail) {
    const fmt = detail.fileName.split(".").pop()?.toUpperCase();
    const kind = detail.mediaType === "show" ? "Series" : "Film";
    return (
      <div className="series media-wide">
        <button className="series-back" onClick={() => setDetail(null)}><Icon icon={chevronLeft} size="sm" /> Anime</button>
        <div className="series-head">
          <div className="series-art">{posterFor?.(detail.title) ? <img src={posterFor(detail.title)} alt="" /> : <Icon icon={animeIcon} size="2xl" />}</div>
          <div className="series-info">
            <h2 className="series-name">{detail.title}</h2>
            <div className="series-meta">{["Anime", kind, fmt, formatBytes(detail.sizeBytes)].filter(Boolean).join(" · ")}</div>
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
        <span className="cat-title section-title"><Icon icon={animeIcon} size="base" /> Anime</span>
        {items.length > 0 && <span className="cat-sub">{items.length}</span>}
        <div className="cat-controls">
          <Button variant="secondary" icon={link2} onClick={() => onBrowse("anime")}>Find anime</Button>
          <Button variant="ghost" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      {loading ? (
        <PosterGridSkeleton />
      ) : items.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <span className="empty-glyph"><Icon icon={animeIcon} size="xl" /></span>
            <h3>No anime in your library yet</h3>
            <p>Tap <b>Find anime</b> to search your sources, or grab a series under <b>Discover</b> — anything tagged anime (or from a known fansub group) lands here.</p>
            <div className="form-actions" style={{ marginTop: 14, justifyContent: "center" }}>
              <Button variant="primary" icon={link2} onClick={() => onBrowse("anime")}>Find anime</Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="cat-grid">
          {items.map((it) => (
            <Card
              key={it.id}
              item={it}
              poster={posterFor?.(it.title)}
              onClick={() => setDetail(it)}
              onContextMenu={(e) => ctx.open(e, fileActions(it))}
            />
          ))}
        </div>
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
      <div className="poster" style={poster ? undefined : { background: bg }}>
        {poster ? <img className="poster-img" src={poster} alt="" loading="lazy" /> : <span className="poster-glyph"><Icon icon={item.mediaType === "show" ? tv : animeIcon} size="2xl" /></span>}
        <div className="poster-seed"><span className="play-badge"><Icon icon={circlePlay} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={item.title}>{item.title}</div>
        <div className="poster-info"><span>{item.mediaType === "show" ? "Series" : "Film"} · {formatBytes(item.sizeBytes)}</span></div>
      </div>
    </div>
  );
}
