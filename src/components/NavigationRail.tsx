import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { useDownloaded } from "../ipc/libraryCache";
import {
  library, search, tv, clapperboard, music, anime,
  book, gamepad2, folderDown, settings2, users, plus,
} from "../lib/icons";

// Tabs whose content comes from the on-disk library scan — hovering one warms the
// shared cache so the click lands on already-loaded data.
const LIBRARY_TABS = new Set<NavId>(["library", "movies", "tvshows", "anime", "music", "books", "games", "downloads"]);

// Top-level navigation ids. The first group are content sections shown in the rail's
// top cluster; the second are management destinations in the bottom cluster.
// ("playlists" lives inside the Music tab now, not the rail.)
export type NavId =
  | "library" | "discover" | "tvshows" | "anime" | "movies" | "music" | "books" | "games"
  | "playlists" | "social" | "downloads" | "export" | "automation" | "sources" | "settings";

interface RailEntry {
  id: NavId;
  label: string;
  icon: string;
  count?: number;
}

interface NavigationRailProps {
  active: NavId;
  onNavigate: (id: NavId) => void;
  downloadCount?: number;
  /** Accepted for compatibility; Sources now lives under Settings, so the rail shows no badge. */
  sourceCount?: number;
  /** Opens the "create a torrent to share with your network" flow. */
  onCreateShare?: () => void;
  /** True while the share-creation modal is open, so the "+" reads as active only then. */
  createActive?: boolean;
}

export function NavigationRail({ active, onNavigate, downloadCount, onCreateShare, createActive }: NavigationRailProps) {
  const { refresh } = useDownloaded();
  const railRef = useRef<HTMLElement>(null);
  const [chipY, setChipY] = useState<number | null>(null);
  const [animated, setAnimated] = useState(false);
  const prefetch = (id: NavId) => {
    if (LIBRARY_TABS.has(id)) void refresh();
  };

  // Slide the active "chip" to whichever rail item is current. Measured from the DOM so
  // it works across the top + bottom clusters and re-aligns on resize.
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const measure = () => {
      const activeEl = rail.querySelector<HTMLElement>(".nav-rail__item--active");
      if (!activeEl) { setChipY(null); return; }
      const r = activeEl.getBoundingClientRect();
      setChipY(r.top - rail.getBoundingClientRect().top - rail.clientTop);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(rail);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [active]);

  // Enable the slide transition only after the first placement so the chip doesn't
  // animate in from the top of the rail on mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const top: RailEntry[] = [
    { id: "library", label: "Library", icon: library },
    { id: "discover", label: "Discover", icon: search },
    { id: "music", label: "Music", icon: music },
    { id: "tvshows", label: "TV Shows", icon: tv },
    { id: "anime", label: "Anime", icon: anime },
    { id: "movies", label: "Movies", icon: clapperboard },
    { id: "books", label: "Books", icon: book },
    { id: "games", label: "Games", icon: gamepad2 },
  ];
  const bottom: RailEntry[] = [
    { id: "social", label: "Friends", icon: users },
    { id: "downloads", label: "Downloads", icon: folderDown, count: downloadCount },
    // Sources, AI cleanup (Automate) and Export now live as sub-pages under Settings,
    // so the rail just carries Downloads + Settings here.
    { id: "settings", label: "Settings", icon: settings2 },
  ];

  return (
    <nav className="nav-rail" aria-label="Primary navigation" ref={railRef}>
      <span
        className={`nav-rail__chip${chipY != null ? " is-visible" : ""}${animated ? " is-animated" : ""}`}
        aria-hidden="true"
        style={chipY != null ? { transform: `translate(-50%, ${chipY}px)` } : undefined}
      />
      <div className="nav-rail__top">
        {top.map((e) => (
          <RailItem key={e.id} entry={e} active={active === e.id} onClick={() => onNavigate(e.id)} onHover={() => prefetch(e.id)} />
        ))}
      </div>
      <div className="nav-rail__bottom">
        {onCreateShare && (
          <button
            className={`nav-rail__item nav-rail__create${createActive ? " nav-rail__create--active" : ""}`}
            title="Share with your network"
            aria-label="Create a torrent to share with your network"
            aria-pressed={!!createActive}
            onClick={onCreateShare}
          >
            <Icon icon={plus} size="xl" color="currentColor" />
          </button>
        )}
        {bottom.map((e) => (
          <RailItem key={e.id} entry={e} active={active === e.id} onClick={() => onNavigate(e.id)} onHover={() => prefetch(e.id)} />
        ))}
      </div>
    </nav>
  );
}

function RailItem({ entry, active, onClick, onHover }: { entry: RailEntry; active: boolean; onClick: () => void; onHover?: () => void }) {
  return (
    <button
      className={`nav-rail__item${active ? " nav-rail__item--active" : ""}`}
      title={entry.label}
      aria-label={entry.label}
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={onHover}
      onFocus={onHover}
    >
      <Icon icon={entry.icon} size="xl" color="currentColor" />
      {entry.count ? <span className="nav-rail__badge">{entry.count > 99 ? "99+" : entry.count}</span> : null}
    </button>
  );
}
