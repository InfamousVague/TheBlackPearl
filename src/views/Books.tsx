import { useEffect, useMemo, type MouseEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { PosterGridSkeleton } from "../components/Skeletons";
import { PosterArt } from "../components/PosterArt";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { removeFromLibrary, revealPath, trashDownloaded, type DownloadedItem } from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { useShareControls } from "../ipc/shares";
import { IS_IOS } from "../lib/platform";
import { formatBytes } from "../lib/format";
import { book, circlePlay, folderOpen, library, rotateCw, trash2, upload } from "../lib/icons";
import { hueFromString } from "../lib/catalog";

interface BooksProps {
  onOpenLocal: (item: DownloadedItem) => void;
  posterFor?: (title: string, kind?: string) => string | undefined;
  /** Signals when the view is first usable for perf timing. */
  onReady?: (meta?: Record<string, string | number | boolean | null>) => void;
}

function fileExt(name: string): string {
  const ext = name.split(".").pop()?.trim();
  return ext ? ext.toUpperCase() : "BOOK";
}

export function Books({ onOpenLocal, posterFor, onReady }: BooksProps) {
  const { items: all, refresh } = useDownloaded();
  const ctx = useContextMenu();
  const { shareItem } = useShareControls();

  const loading = all === null;
  const books = useMemo(
    () =>
      (all ?? [])
        .filter((i) => i.mediaType === "book" && i.inLibrary)
        .sort((a, b) => a.title.localeCompare(b.title)),
    [all],
  );

  useEffect(() => {
    if (loading) return;
    onReady?.({
      books: books.length,
      empty: books.length === 0,
    });
  }, [books.length, loading, onReady]);

  function fileActions(it: DownloadedItem): MenuAction[] {
    return [
      { label: "Open", icon: circlePlay, onSelect: () => onOpenLocal(it) },
      ...(IS_IOS ? [] : [{ label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(it.id) }]),
      { label: "Share with network", icon: upload, divider: true, onSelect: () => shareItem({ id: it.id, title: it.title, local: true }) },
      {
        label: "Remove from library",
        icon: library,
        divider: true,
        onSelect: () => void removeFromLibrary(it.id).then(() => refresh()),
      },
      {
        label: "Move to Trash",
        icon: trash2,
        danger: true,
        onSelect: () => void trashDownloaded(it.id).then(() => refresh()),
      },
    ];
  }

  return (
    <div className="section-stack media-wide">
      <div className="cat-header">
        <span className="cat-title section-title">
          <Icon icon={book} size="base" /> Books
        </span>
        {books.length > 0 && <span className="cat-sub">{books.length}</span>}
        <div className="cat-controls">
          <Button variant="secondary" shape="pill" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      {loading ? (
        <PosterGridSkeleton />
      ) : books.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <img src="/hero-library.png" alt="" style={{ width: 184, height: "auto", marginBottom: 8 }} />
            <h3>No books in your library yet</h3>
            <p>Download EPUB, PDF, and other ebook files from Discover and they will appear here.</p>
          </div>
        </div>
      ) : (
        <div className="cat-grid">
          {books.map((it) => (
            <BookCard
              key={it.id}
              item={it}
              poster={posterFor?.(it.title, "book")}
              onClick={() => onOpenLocal(it)}
              onContextMenu={(e) => ctx.open(e, fileActions(it))}
            />
          ))}
        </div>
      )}
      {ctx.menu}
    </div>
  );
}

function BookCard({ item, poster, onClick, onContextMenu }: { item: DownloadedItem; poster?: string; onClick: () => void; onContextMenu?: (e: MouseEvent) => void }) {
  const hue = hueFromString(item.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} onContextMenu={onContextMenu} role="button" tabIndex={0}>
      <div className="poster" style={{ background: bg }}>
        <PosterArt src={poster} glyph={book} />
        <div className="poster-seed"><span className="play-badge"><Icon icon={circlePlay} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={item.title}>{item.title}</div>
        <div className="poster-info"><span>{fileExt(item.fileName)}</span><span className="dot" /><span>{formatBytes(item.sizeBytes)}</span></div>
      </div>
    </div>
  );
}
