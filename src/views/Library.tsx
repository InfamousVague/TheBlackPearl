import { useEffect, useMemo, type MouseEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { PosterGridSkeleton } from "../components/Skeletons";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { removeFromLibrary, revealPath, trashDownloaded, type DownloadedItem } from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { hueFromString } from "../lib/catalog";
import { formatBytes } from "../lib/format";
import { IS_IOS } from "../lib/platform";
import { book, circlePlay, clapperboard, folderOpen, gamepad2, images, library, music, rotateCw, sparkles, trash2, tv } from "../lib/icons";

interface LibraryProps {
  onPlayLocal: (item: DownloadedItem) => void;
  posterFor?: (title: string) => string | undefined;
  /** Open the "replace poster" picker for a title. */
  onReplacePoster?: (title: string) => void;
  /** Start (or reveal) the background "organize library folder" task. */
  onOrganize: () => void;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAY = 86_400;

/** Bucket an mtime into a "Recently added" section, newest first. */
function bucketOf(addedAt: number, now: number): { order: number; label: string } {
  const age = now - addedAt;
  if (addedAt === 0) return { order: 5, label: "Earlier" };
  if (age < DAY) return { order: 0, label: "Today" };
  if (age < 2 * DAY) return { order: 1, label: "Yesterday" };
  if (age < 7 * DAY) return { order: 2, label: "This week" };
  if (age < 30 * DAY) return { order: 3, label: "This month" };
  if (age < 365 * DAY) return { order: 4, label: "This year" };
  return { order: 5, label: "Earlier" };
}

function glyphFor(t: DownloadedItem["mediaType"]): string {
  return t === "show" ? tv : t === "music" ? music : t === "book" ? book : t === "game" ? gamepad2 : clapperboard;
}

function subOf(it: DownloadedItem): string {
  if (it.mediaType === "show" && it.season != null && it.episode != null) {
    return `S${pad(it.season)}E${pad(it.episode)} · ${formatBytes(it.sizeBytes)}`;
  }
  const label = it.mediaType === "music" ? "Song" : it.mediaType === "show" ? "Episode" : it.mediaType === "book" ? "Book" : it.mediaType === "game" ? "Game" : "Movie";
  return `${label} · ${formatBytes(it.sizeBytes)}`;
}

export function Library({ onPlayLocal, posterFor, onReplacePoster, onOrganize }: LibraryProps) {
  const { items: all, refresh } = useDownloaded();
  const ctx = useContextMenu();

  // Revalidate on mount; the cached list paints instantly so there's no spinner on revisit.
  useEffect(() => { void refresh(); }, [refresh]);
  const loading = all === null;
  const items = useMemo(() => (all ?? []).filter((i) => i.inLibrary), [all]);

  // Everything on disk, newest first, bucketed into "Today / This week / …".
  const groups = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const sorted = [...items].sort((a, b) => b.addedAt - a.addedAt);
    const map = new Map<number, { label: string; items: DownloadedItem[] }>();
    for (const it of sorted) {
      const b = bucketOf(it.addedAt, now);
      let g = map.get(b.order);
      if (!g) {
        g = { label: b.label, items: [] };
        map.set(b.order, g);
      }
      g.items.push(it);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
  }, [items]);

  function fileActions(it: DownloadedItem): MenuAction[] {
    return [
      { label: "Play", icon: circlePlay, onSelect: () => onPlayLocal(it) },
      { label: "Replace poster…", icon: images, onSelect: () => onReplacePoster?.(it.title) },
      { label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(it.id) },
      { label: "Remove from library", icon: library, divider: true, onSelect: () => void removeFromLibrary(it.id).then(() => refresh()) },
      { label: "Move to Trash", icon: trash2, danger: true, onSelect: () => void trashDownloaded(it.id).then(() => refresh()) },
    ];
  }

  return (
    <div className="section-stack media-wide">
      <div className="cat-header">
        <span className="cat-title section-title"><Icon icon={library} size="base" /> Recently added</span>
        {items.length > 0 && <span className="cat-sub">{items.length}</span>}
        <div className="cat-controls">
          {!IS_IOS && <Button variant="secondary" icon={sparkles} onClick={onOrganize}>Organize</Button>}
          <Button variant="ghost" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      {loading ? (
        <PosterGridSkeleton />
      ) : items.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <img src="/hero-library.png" alt="" style={{ width: 184, height: "auto", marginBottom: 8 }} />
            <h3>Nothing downloaded yet</h3>
            <p>Find movies, shows, and music under <b>Discover</b> and download them — your most recent additions show up here.</p>
          </div>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.label} className="lib-group">
            <div className="side-group-label">{g.label} · {g.items.length}</div>
            <div className="cat-grid">
              {g.items.map((it) => (
                <Card
                  key={it.id}
                  item={it}
                  poster={posterFor?.(it.title)}
                  onClick={() => onPlayLocal(it)}
                  onContextMenu={(e) => ctx.open(e, fileActions(it))}
                />
              ))}
            </div>
          </div>
        ))
      )}
      {ctx.menu}
    </div>
  );
}

function Card({ item, poster, onClick, onContextMenu }: { item: DownloadedItem; poster?: string; onClick: () => void; onContextMenu?: (e: MouseEvent) => void }) {
  const glyph = glyphFor(item.mediaType);
  const square = item.mediaType === "music";
  const hue = hueFromString(item.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} onContextMenu={onContextMenu} role="button" tabIndex={0}>
      <div className={`poster${square ? " square" : ""}`} style={poster ? undefined : { background: bg }}>
        {poster ? <img className="poster-img" src={poster} alt="" loading="lazy" /> : <span className="poster-glyph"><Icon icon={glyph} size="2xl" /></span>}
        <div className="poster-seed"><span className="play-badge"><Icon icon={circlePlay} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={item.title}>{item.title}</div>
        <div className="poster-info"><span>{subOf(item)}</span></div>
      </div>
    </div>
  );
}
