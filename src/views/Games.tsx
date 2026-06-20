import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { PosterGridSkeleton } from "../components/Skeletons";
import { PosterArt } from "../components/PosterArt";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { removeFromLibrary, revealPath, trashDownloaded, type DownloadedItem } from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { useShareControls } from "../ipc/shares";
import { formatBytes } from "../lib/format";
import { IS_IOS } from "../lib/platform";
import { circlePlay, cpu, externalLink, folderOpen, gamepad2, library, rotateCw, trash2, upload } from "../lib/icons";
import { hueFromString } from "../lib/catalog";
import "./Games.css";

interface GamesProps {
  onOpenLocal: (item: DownloadedItem) => void;
  posterFor?: (title: string, kind?: string) => string | undefined;
  /** Signals when the view is first usable for perf timing. */
  onReady?: (meta?: Record<string, string | number | boolean | null>) => void;
}

/** Reputable, actively-maintained emulators grouped by the system they run.
 *  `icon` overrides the auto favicon for sites DuckDuckGo doesn't index. */
const EMULATORS: { name: string; system: string; url: string; icon?: string }[] = [
  { name: "xemu", system: "Xbox", url: "https://xemu.app" },
  { name: "RPCS3", system: "PlayStation 3", url: "https://rpcs3.net" },
  { name: "PCSX2", system: "PlayStation 2", url: "https://pcsx2.net" },
  { name: "DuckStation", system: "PlayStation 1", url: "https://www.duckstation.org" },
  { name: "PPSSPP", system: "PSP", url: "https://www.ppsspp.org" },
  { name: "Dolphin", system: "GameCube / Wii", url: "https://dolphin-emu.org", icon: "https://www.google.com/s2/favicons?sz=64&domain=dolphin-emu.org" },
  { name: "Cemu", system: "Wii U", url: "https://cemu.info" },
  { name: "Astris", system: "Nintendo Switch", url: "https://github.com/V380-Ori/Astris.Binaries" },
  { name: "melonDS", system: "Nintendo DS", url: "https://melonds.kuribo64.net" },
  { name: "mGBA", system: "Game Boy Advance", url: "https://mgba.io" },
  { name: "OpenEmu", system: "Multi-system", url: "https://openemu.org" },
  { name: "RetroArch", system: "Multi-system", url: "https://www.retroarch.com", icon: "https://icons.duckduckgo.com/ip3/www.libretro.com.ico" },
];

function openExternal(url: string) {
  import("@tauri-apps/plugin-opener")
    .then(({ openUrl }) => openUrl(url))
    .catch(() => window.open(url, "_blank", "noopener,noreferrer"));
}

/** A site's favicon (the emulator's logo) at icon size, via DuckDuckGo's keyless icon service. */
function faviconFor(url: string): string {
  try {
    return `https://icons.duckduckgo.com/ip3/${new URL(url).hostname}.ico`;
  } catch {
    return "";
  }
}

/** Emulator logo with a graceful fallback to the gamepad glyph when the favicon can't load. */
function EmuIcon({ url, icon }: { url: string; icon?: string }) {
  const [failed, setFailed] = useState(false);
  const src = icon ?? faviconFor(url);
  if (failed || !src) return <Icon icon={gamepad2} size="sm" />;
  return <img className="emu-item-logo" src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function fileExt(name: string): string {
  const ext = name.split(".").pop()?.trim();
  return ext ? ext.toUpperCase() : "GAME";
}

export function Games({ onOpenLocal, posterFor, onReady }: GamesProps) {
  const { items: all, refresh } = useDownloaded();
  const ctx = useContextMenu();
  const { shareItem } = useShareControls();

  const loading = all === null;
  const games = useMemo(
    () =>
      (all ?? [])
        .filter((i) => i.mediaType === "game" && i.inLibrary)
        .sort((a, b) => a.title.localeCompare(b.title)),
    [all],
  );

  useEffect(() => {
    if (loading) return;
    onReady?.({
      games: games.length,
      empty: games.length === 0,
    });
  }, [games.length, loading, onReady]);

  function fileActions(it: DownloadedItem): MenuAction[] {
    return [
      // A game is an install/repack folder, not a playable stream — reveal it on desktop;
      // iOS has no Finder, so "Open" hands off to the system.
      IS_IOS
        ? { label: "Open", icon: circlePlay, onSelect: () => onOpenLocal(it) }
        : { label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(it.id) },
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
          <Icon icon={gamepad2} size="base" /> Games
        </span>
        {games.length > 0 && <span className="cat-sub">{games.length}</span>}
        <div className="cat-controls">
          <Button variant="secondary" shape="pill" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      <EmulatorsCard />

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
              onClick={() => (IS_IOS ? onOpenLocal(it) : void revealPath(it.id))}
              onContextMenu={(e) => ctx.open(e, fileActions(it))}
            />
          ))}
        </div>
      )}
      {ctx.menu}
    </div>
  );
}

function EmulatorsCard() {
  return (
    <div className="emu-card">
      <div className="emu-head">
        <span className="emu-title"><Icon icon={cpu} size="base" /> Emulators</span>
        <span className="emu-sub">Download an emulator to run games from different systems</span>
      </div>
      <div className="emu-grid">
        {EMULATORS.map((e) => (
          <button key={e.url} className="emu-item" onClick={() => openExternal(e.url)} title={`Download ${e.name} — ${e.system}`}>
            <span className="emu-item-icon"><EmuIcon url={e.url} icon={e.icon} /></span>
            <span className="emu-item-text">
              <span className="emu-item-name">{e.name}</span>
              <span className="emu-item-system">{e.system}</span>
            </span>
            <Icon icon={externalLink} size="sm" className="emu-item-ext" />
          </button>
        ))}
      </div>
    </div>
  );
}

function GameCard({ item, poster, onClick, onContextMenu }: { item: DownloadedItem; poster?: string; onClick: () => void; onContextMenu?: (e: MouseEvent) => void }) {
  const hue = hueFromString(item.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} onContextMenu={onContextMenu} role="button" tabIndex={0}>
      <div className="poster" style={{ background: bg }}>
        <PosterArt src={poster} glyph={gamepad2} />
        <div className="poster-seed"><span className="play-badge"><Icon icon={circlePlay} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={item.title}>{item.title}</div>
        <div className="poster-info"><span>{fileExt(item.fileName)}</span><span className="dot" /><span>{formatBytes(item.sizeBytes)}</span></div>
      </div>
    </div>
  );
}
