import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import type { NavId } from "./NavigationRail";
import { MusicPlaylistRail } from "./MusicPlaylistRail";
import { type MediaSectionId, type SectionSort } from "../lib/media";
import { SETTINGS_TABS, type SettingsTab } from "../lib/settingsTabs";
import { IS_IOS } from "../lib/platform";
import { arrowDownUp, history, tag, trendingUp } from "../lib/icons";

// NavId is a superset of the content sections; this narrows it.
const MEDIA: NavId[] = ["movies", "tvshows", "music", "books", "games"];
function isMedia(s: NavId): s is MediaSectionId {
  return (MEDIA as string[]).includes(s);
}

const MEDIA_SORTS: { key: SectionSort; label: string }[] = [
  { key: "popularity", label: "Popular" },
  { key: "rating", label: "Top rated" },
  { key: "recent", label: "Recently added" },
  { key: "title", label: "A–Z" },
];

interface SidebarProps {
  collapsed: boolean;
  section: NavId;
  // content-section filters
  genres: string[];
  sort: SectionSort;
  onSort: (s: SectionSort) => void;
  genre: string | null;
  onGenre: (g: string | null) => void;
  // discover
  recents: string[];
  popular: string[];
  onPick: (q: string) => void;
  onClearRecents: () => void;
  // settings sub-nav
  settingsTab: SettingsTab;
  onSettingsTab: (t: SettingsTab) => void;
  // music playlists rail (rendered inside the shell sidebar)
  musicPlaylistActiveId?: string | null;
  onOpenMusicPlaylist?: (id: string) => void;
  musicPlaylistRefreshKey?: number;
  onMusicPlaylistToast?: (message: string) => void;
}

export function Sidebar(props: SidebarProps) {
  const { collapsed, section } = props;
  return (
    <aside className={`sidebar${collapsed ? " is-collapsed" : ""}`}>
      <div className="sidebar-inner">
        {section === "discover" ? (
          <DiscoverFilters {...props} />
        ) : section === "music" ? (
          <MusicSidebar {...props} />
        ) : section === "anime" ? (
          <SectionFilters {...props} />
        ) : isMedia(section) ? (
          <SectionFilters {...props} />
        ) : section === "settings" ? (
          <SettingsNav {...props} />
        ) : (
          <ManageInfo section={section} />
        )}
      </div>
    </aside>
  );
}

function MusicSidebar({ musicPlaylistActiveId, onOpenMusicPlaylist, musicPlaylistRefreshKey, onMusicPlaylistToast }: SidebarProps) {
  return (
    <MusicPlaylistRail
      embedded
      activeId={musicPlaylistActiveId}
      onOpen={onOpenMusicPlaylist ?? (() => {})}
      refreshKey={musicPlaylistRefreshKey}
      onToast={onMusicPlaylistToast}
    />
  );
}

function SettingsNav({ settingsTab, onSettingsTab }: SidebarProps) {
  // AI cleanup + Export are desktop-only (Ollama / ffmpeg); hide them on iOS.
  const tabs = SETTINGS_TABS.filter((t) => !(IS_IOS && "desktopOnly" in t && t.desktopOnly));
  return (
    <>
      <div className="side-group">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`side-item${settingsTab === t.id ? " active" : ""}`}
            onClick={() => onSettingsTab(t.id)}
          >
            <Icon icon={t.icon} size="sm" /> {t.label}
          </button>
        ))}
      </div>
    </>
  );
}

function SectionFilters({
  genres, sort, onSort, genre, onGenre,
}: SidebarProps) {
  const sorts = MEDIA_SORTS;
  return (
    <>
      <div className="side-group">
        <div className="side-group-label"><Icon icon={arrowDownUp} size="xs" /> Sort</div>
        {sorts.map((o) => (
          <button
            key={o.key}
            className={`side-item${sort === o.key ? " active" : ""}`}
            onClick={() => onSort(o.key)}
          >
            {o.label}
          </button>
        ))}
      </div>

      {genres.length > 0 && (
        <div className="side-group">
          <div className="side-group-label"><Icon icon={tag} size="xs" /> Genre</div>
          <div className="chip-row side-chips">
            <button className={`side-chip${genre === null ? " active" : ""}`} onClick={() => onGenre(null)}>All</button>
            {genres.map((g) => (
              <button key={g} className={`side-chip${genre === g ? " active" : ""}`} onClick={() => onGenre(g)}>{g}</button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function DiscoverFilters({ recents, popular, onPick, onClearRecents }: SidebarProps) {
  return (
    <>
      {recents.length > 0 && (
        <div className="side-group">
          <div className="side-group-label">
            <Icon icon={history} size="xs" /> Recent
            <button className="side-clear" onClick={onClearRecents}>Clear</button>
          </div>
          <div className="chip-row side-chips">
            {recents.map((r) => (
              <button key={r} className="side-chip" onClick={() => onPick(r)}>{r}</button>
            ))}
          </div>
        </div>
      )}
      <div className="side-group">
        <div className="side-group-label"><Icon icon={trendingUp} size="xs" /> Popular</div>
        <div className="chip-row side-chips">
          {popular.map((p) => (
            <button key={p} className="side-chip" onClick={() => onPick(p)}>{p}</button>
          ))}
        </div>
      </div>
    </>
  );
}

const MANAGE_COPY: Record<string, { title: string; hint: string }> = {
  library: { title: "Library", hint: "Everything you've downloaded, on disk — open it anytime, grouped by movies, shows, music, books, and games." },
  downloads: { title: "Downloads", hint: "Active transfers and finished files. Click a download to open or reveal it." },
  export: { title: "Export", hint: "Copy finished media into your Plex / Apple Music library or a folder, named correctly." },
  sources: { title: "Sources", hint: "The sites magnets are indexed from. Add, refresh, or verify them on the right." },
  settings: { title: "Settings", hint: "API keys, local-AI status, storage location and app info." },
};

function ManageInfo({ section }: { section: NavId }) {
  const c = MANAGE_COPY[section] ?? { title: "", hint: "" };
  return (
    <>
      <p className="side-hint">{c.hint}</p>
    </>
  );
}
