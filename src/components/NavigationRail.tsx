import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { useDownloaded } from "../ipc/libraryCache";
import { IS_IOS } from "../lib/platform";
import {
  library, compass, tv, clapperboard, music, anime,
  folderDown, folderOutput, rss, settings2, sparkles,
} from "../lib/icons";

// Tabs whose content comes from the on-disk library scan — hovering one warms the
// shared cache so the click lands on already-loaded data.
const LIBRARY_TABS = new Set<NavId>(["library", "movies", "tvshows", "anime", "music", "downloads"]);

// Top-level navigation ids. The first group are content sections shown in the rail's
// top cluster; the second are management destinations in the bottom cluster.
export type NavId =
  | "library" | "discover" | "tvshows" | "anime" | "movies" | "music"
  | "downloads" | "export" | "automation" | "sources" | "settings";

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
  sourceCount?: number;
}

export function NavigationRail({ active, onNavigate, downloadCount, sourceCount }: NavigationRailProps) {
  const { refresh } = useDownloaded();
  const prefetch = (id: NavId) => {
    if (LIBRARY_TABS.has(id)) void refresh();
  };
  const top: RailEntry[] = [
    { id: "library", label: "Library", icon: library },
    { id: "discover", label: "Discover", icon: compass },
    { id: "tvshows", label: "TV Shows", icon: tv },
    { id: "anime", label: "Anime", icon: anime },
    { id: "movies", label: "Movies", icon: clapperboard },
    { id: "music", label: "Music", icon: music },
  ];
  const bottom: RailEntry[] = [
    { id: "downloads", label: "Downloads", icon: folderDown, count: downloadCount },
    // Export (ffmpeg) and Automate (AI convert/tag/organize) are desktop-only;
    // hide them on iOS while keeping all entries on desktop (IS_IOS === false).
    ...(IS_IOS ? [] : [
      { id: "export", label: "Export", icon: folderOutput },
      { id: "automation", label: "Automate", icon: sparkles },
    ] as RailEntry[]),
    { id: "sources", label: "Sources", icon: rss, count: sourceCount },
    { id: "settings", label: "Settings", icon: settings2 },
  ];

  return (
    <nav className="nav-rail" aria-label="Primary navigation">
      <div className="nav-rail__top">
        {top.map((e) => (
          <RailItem key={e.id} entry={e} active={active === e.id} onClick={() => onNavigate(e.id)} onHover={() => prefetch(e.id)} />
        ))}
      </div>
      <div className="nav-rail__bottom">
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
