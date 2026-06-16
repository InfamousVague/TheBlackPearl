import { useEffect, useMemo, type MouseEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { PosterGridSkeleton } from "../components/Skeletons";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { removeFromLibrary, trashDownloaded, type DownloadedItem } from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { formatBytes } from "../lib/format";
import { IS_IOS } from "../lib/platform";
import { circlePlay, folderOpen, gamepad2, library, rotateCw, trash2 } from "../lib/icons";
import { hueFromString } from "../lib/catalog";

interface GamesProps {
  onOpenLocal: (item: DownloadedItem) => void;
  posterFor?: (title: string, kind?: string) => string | undefined;
}

function fileExt(name: string): string {
  const ext = name.split(".").pop()?.trim();
  return ext ? ext.toUpperCase() : "GAME";
}

export function Games({ onOpenLocal, posterFor }: GamesProps) {
  const { items: all, refresh } = useDownloaded();
  const ctx = useContextMenu();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loading = all === null;
  const games = useMemo(
    () =>
      (all ?? [])
        .filter((i) => i.mediaType === "game" && i.inLibrary)
        .sort((a, b) => a.title.localeCompare(b.title)),
    [all],
  );

  function fileActions(it: DownloadedItem): MenuAction[] {
    return [
      { label: IS_IOS ? "Open" : "Reveal in Finder", icon: IS_IOS ? circlePlay : folderOpen, onSelect: () => onOpenLocal(it) },
      ...(IS_IOS ? [] : [{ label: "Open", icon: circlePlay, onSelect: () => onOpenLocal(it) }]),
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
          <Icon icon={gamepad2} size="base" /> Games
        </span>
        {games.length > 0 && <span className="cat-sub">{games.length}</span>}
        <div className="cat-controls">
          <Button variant="ghost" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      {loading ? (
        <PosterGridSkeleton />
      ) : games.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <img src="/hero-library.png" alt="" style={{ width: 184, height: "auto", marginBottom: 8 }} />
            <h3>No games in your library yet</h3>
            <p>Game files and ROMs from your downloads are grouped here automatically.</p>
          </div>
        </div>
      ) : (
        <div className="cat-grid">
          {games.map((it) => (
            <GameCard
              key={it.id}
              item={it}
              poster={posterFor?.(it.title, "game")}
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

function GameCard({ item, poster, onClick, onContextMenu }: { item: DownloadedItem; poster?: string; onClick: () => void; onContextMenu?: (e: MouseEvent) => void }) {
  const hue = hueFromString(item.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} onContextMenu={onContextMenu} role="button" tabIndex={0}>
      <div className="poster" style={poster ? undefined : { background: bg }}>
        {poster ? <img className="poster-img" src={poster} alt="" loading="lazy" /> : <span className="poster-glyph"><Icon icon={gamepad2} size="2xl" /></span>}
        <div className="poster-seed"><span className="play-badge"><Icon icon={circlePlay} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={item.title}>{item.title}</div>
        <div className="poster-info"><span>{fileExt(item.fileName)}</span><span className="dot" /><span>{formatBytes(item.sizeBytes)}</span></div>
      </div>
    </div>
  );
}
