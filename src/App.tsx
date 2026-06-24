import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SegmentedControl } from "@mattmattmattmatt/base/primitives/segmented-control/SegmentedControl";
import { Sidebar } from "./components/Sidebar";
import { NavigationRail, type NavId } from "./components/NavigationRail";
import { TopBar } from "./components/TopBar";
import HalftoneCanvas from "./components/HalftoneCanvas";
import { Library } from "./views/Library";
import { Sources } from "./views/Sources";
import { Downloads } from "./views/Downloads";
import { Player, type PlayerItem } from "./views/Player";
import { Settings } from "./views/Settings";
import { Search } from "./views/Search";
import { TvShows } from "./views/TvShows";
import { Music } from "./views/Music";
import { Movies } from "./views/Movies";
import { Books } from "./views/Books";
import { Games } from "./views/Games";
import { Anime } from "./views/Anime";
import { Digest } from "./views/Digest";
import { LibraryProvider } from "./ipc/libraryCache";
import { ReplacePoster } from "./components/ReplacePoster";
import { Export } from "./views/Export";
import { Automation } from "./views/Automation";
import { Playlists } from "./views/Playlists";
import { Sync } from "./views/Sync";
import { Social } from "./views/Social";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { NowPlayingHero } from "./components/NowPlayingHero";
import { VideoTabs, type VideoTab } from "./components/VideoTabs";
import { YouTubeVideos } from "./views/YouTubeVideos";
import { UpdateBanner } from "./components/UpdateBanner";
import { DvdScreensaver, useIdle } from "./components/DvdScreensaver";
import { SyncStatusCard } from "./components/SyncStatusCard";
import { VpnKillSwitch } from "./components/VpnKillSwitch";
import { CreateTorrentDialog } from "./components/CreateTorrentDialog";
import { type Command } from "./components/CommandPalette";
import { CommandPaletteHost } from "./components/CommandPaletteHost";
import { ExtensionProvider } from "./ext/host";
import { ExtensionView, ExtSearchBridge, ExtMusicImporterBridge, ExtViewIdsBridge } from "./ext/slots";
import type { ExtMusicImporter } from "./ext/sdk";
import { ExtensionsBrowse } from "./ext/ExtensionsManager";
import { WatchLater } from "./views/WatchLater";
import { SETTINGS_TABS } from "./lib/settingsTabs";
import {
  library as iconLibrary, search as iconSearch, music as iconMusic, tv as iconTv, anime as iconAnime,
  clapperboard as iconMovies, book as iconBook, gamepad2 as iconGames, users as iconUsers,
  folderDown as iconDownloads, settings2 as iconSettings, rotateCw as iconRefresh, layers as iconOrganize,
  plus as iconShare, folderOpen as iconFolder, pause as iconPause, play as iconPlay,
  panelLeftClose as iconSidebar, history as iconHistory, magnet as iconMagnet, link2 as iconLink,
  clock as iconClock,
} from "./lib/icons";
import { ContextMenuProvider } from "./components/ContextMenu";
import { SharesProvider, type ShareControls, type MyShare } from "./ipc/shares";
import { shareMagnet, type ShareItem } from "./ipc/social";
import { usePlayer, type PlayerTrack } from "./ipc/player";
import { useVisualizerWindow } from "./ipc/visualizer";
import { OrganizePanel, type OrganizePhase } from "./components/OrganizePanel";
import { organizeRun, onOrganizeProgress, type OrganizeResult, type OrganizeStep } from "./ipc/organize";
import { MOCK_CATALOG, MOCK_SOURCES } from "./lib/catalog";
import { isAnime, mediaKind, parseEpisode, sectionOf, genresOf, type MediaKind, type MediaSectionId, type SectionSort } from "./lib/media";
import { cleanTitleForPoster } from "./lib/relay";
import { getPerfEvents, isPerfEnabled, recordPerf, startPerfTimer, withPerfAsync, type PerfMeta } from "./lib/perf";
import type { SettingsTab } from "./lib/settingsTabs";
import type { CatalogItem, DownloadStats, MediaInfo, Source, SourceKind } from "./lib/types";
import { MOCK_DOWNLOADS } from "./lib/mockLibrary";
import {
  IN_TAURI,
  addTorrent,
  getDownloadConcurrency,
  getStreamUrl,
  mediaInfo,
  onDownloads,
  pauseDownload,
  removeTorrent,
  revealDownload,
  setDownloadConcurrency,
  shareLibraryItem,
} from "./ipc/engine";
import { remoteAddTorrent, remoteListDownloads, remoteStreamUrl, remoteSnapshot, remoteSnapshotVersion, getActiveDevice } from "./ipc/remote";
import { useLinkedDevice, readLinkedDeviceIdSync } from "./contexts/DeviceContext";
import { useSync } from "./contexts/SyncContext";
import { loadSnapshot, saveSnapshot } from "./lib/snapshotCache";
import { getSyncApi } from "./ipc/syncReport";
import { IS_IOS, IS_MAC } from "./lib/platform";
import {
  addSource,
  aiScan,
  aiStatus,
  cleanTitles,
  exportSources,
  importSources,
  fetchPosters,
  getSetting,
  importFromBrowser,
  downloadHttpFile,
  perfBackendScanBench,
  listCatalog,
  listDownloaded,
  listLibrary,
  listPosterOverrides,
  listSources,
  mergeCatalog,
  openBrowser,
  revealPath,
  networkPauseAll,
  networkResumeAll,
  refreshSource,
  removeSource,
  resolveLocalPlayUrl,
  searchSources,
  featured as fetchFeatured,
  onVpnDropped,
  listMusicImports,
  removeMusicImport,
  retryMusicImport,
  cancelMusicImport,
  onMusicImports,
  type DownloadedItem,
  type LibraryItem,
  type MovieDigest,
  type VpnStatus,
  type MusicImportJob,
} from "./ipc/library";

// `string & {}` keeps autocomplete for the known views while letting extensions add their own view ids.
type AppView = NavId | "player" | (string & {});
type MusicTab = "browse" | "playlists" | "sync";
type PlayAudioCollectionOptions = { startId?: string; shuffle?: boolean };

const RECENTS_KEY = "ghosty.recents";
const MAGNET_RE = /^magnet:\?xt=urn:btih:/i;
const HTTP_URL_RE = /^https?:\/\//i;
// Preset launch points + trending terms shown on the Discover home.
const POPULAR = [
  "1080p", "4K", "Documentary", "Sci-Fi", "Soundtrack",
  "FLAC", "Blender", "Public Domain", "Anime", "Concert",
];

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await nextFrame();
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
// The rail ids that map to a browsable content section.
const MEDIA_SECTIONS: MediaSectionId[] = ["movies", "tvshows", "music", "books", "games"];
// The three views unified under the rail's single "Videos" entry (segmented toggle in-view).
const VIDEO_SECTIONS: VideoTab[] = ["tvshows", "movies", "anime", "youtube"];
const isVideoView = (v: string): v is VideoTab => (VIDEO_SECTIONS as string[]).includes(v);

function readyKeyForView(view: AppView, musicTab: MusicTab): string | null {
  if (
    view === "player" ||
    view === "settings" ||
    view === "sources" ||
    view === "export" ||
    view === "automation" ||
    view === "playlists" ||
    view === "youtube"
  ) {
    return null;
  }
  if (view === "music") return `music:${musicTab}`;
  return view;
}

function fmtPerfMs(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "n/a";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
}

function loadRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveRecents(r: string[]) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(r));
  } catch {
    /* ignore quota / private-mode failures */
  }
}

// Persisted cache of LLM-summarized titles keyed by item id. The backend already caches
// these in SQLite (so the LLM never re-runs), but the frontend map was in-memory only —
// so every session/re-search flashed the raw release name and round-tripped to rebuild it.
// Mirroring the map to localStorage makes already-summarized titles render instantly.
const CLEAN_TITLES_KEY = "ghosty.cleanTitles";
const CLEAN_TITLES_MAX = 4000; // cap so the cache can't grow unbounded

function loadCleanTitles(): Map<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(CLEAN_TITLES_KEY) || "[]");
    if (Array.isArray(v)) {
      return new Map(
        v.filter(
          (e): e is [string, string] =>
            Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string",
        ),
      );
    }
  } catch {
    /* ignore corrupt cache */
  }
  return new Map();
}

function saveCleanTitles(map: Map<string, string>) {
  try {
    // Map preserves insertion order, so slicing the tail keeps the most-recently-cleaned.
    const entries = [...map];
    const trimmed = entries.length > CLEAN_TITLES_MAX ? entries.slice(-CLEAN_TITLES_MAX) : entries;
    localStorage.setItem(CLEAN_TITLES_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore quota / private-mode failures */
  }
}

function isTorrentMagnet(link: string): boolean {
  return MAGNET_RE.test(link.trim());
}

function isHttpUrl(link: string): boolean {
  return HTTP_URL_RE.test(link.trim());
}

/** An http(s) `.torrent` file (e.g. archive.org's per-item torrent) — the engine fetches it
 *  and downloads its contents, so it must NOT be treated as a direct HTTP file download. */
function isTorrentFileUrl(link: string): boolean {
  const path = link.trim().split(/[?#]/)[0].toLowerCase();
  return isHttpUrl(link) && path.endsWith(".torrent");
}

/** A link the torrent engine handles directly: a magnet or an http(s) `.torrent` URL. */
function isTorrentLink(link: string): boolean {
  return isTorrentMagnet(link) || isTorrentFileUrl(link);
}

// Browser-preview-only sample (no Rust engine). Replaced by real librqbit streams in Tauri.
const SAMPLE_VIDEO =
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/**
 * The engine pushes a snapshot ~1×/sec. When nothing is actively transferring or
 * seeding, successive snapshots are identical — but a fresh array reference would still
 * re-render the whole tree every second. Bail to the previous array when nothing that
 * matters changed, so an idle app isn't constantly re-rendering during navigation.
 *
 * Compared by id (order-independent): the backend builds the snapshot from a HashMap, so
 * two ticks can list the same downloads in a different order. Treating a pure reorder as a
 * change forced a needless re-render every second and made cards flash/reshuffle.
 */
function sameDownloads(a: DownloadStats[], b: DownloadStats[]): boolean {
  if (a.length !== b.length) return false;
  const prev = new Map(a.map((x) => [x.id, x]));
  for (const y of b) {
    const x = prev.get(y.id);
    if (
      !x ||
      x.state !== y.state ||
      x.progress !== y.progress ||
      x.downSpeed !== y.downSpeed ||
      x.upSpeed !== y.upSpeed ||
      x.peers !== y.peers
    ) {
      return false;
    }
  }
  return true;
}

function mockStats(id: string, title: string): DownloadStats {
  return {
    id, title, state: "downloading", progress: 0.18,
    downSpeed: 2.6 * 1024 * 1024, upSpeed: 180 * 1024, peers: 34, streamUrl: SAMPLE_VIDEO,
  };
}

// Keyless relay poster by title (+ kind). It's plain https, so it loads anywhere — no
// local /art cache or LAN image fetch — which is why it's the reliable fallback on the
// iPad companion, where downloaded titles often aren't in the catalog/library lookup.
const POSTER_RELAY = "https://theblackpearl.tv/api/poster";
const BOOK_RELAY = "https://theblackpearl.tv/api/book";
/** Book covers come from the relay's Open Library endpoint. Ebook filenames are typically
 *  "Title by Author", so split that out — Open Library's structured title/author search is
 *  far more accurate than a free-text query (which tends to match cover-less box sets). */
function relayBookUrl(title: string): string | undefined {
  const clean = title.trim();
  if (!clean) return undefined;
  const m = clean.match(/^(.*?)\s+by\s+(.+)$/i);
  const t = (m ? m[1] : clean).trim();
  const author = m ? m[2].trim() : "";
  const qs = author
    ? `?title=${encodeURIComponent(t)}&author=${encodeURIComponent(author)}`
    : `?title=${encodeURIComponent(t)}`;
  return `${BOOK_RELAY}${qs}`;
}
function relayPosterUrl(title: string, kind?: string): string | undefined {
  // Browser preview renders a MOCK library; never let a fictional title coincidentally resolve
  // a real copyrighted poster through the relay. Library cards fall back to their gradient.
  // (Discover keeps real public-domain art — it uses relayPosterFor, not this.)
  if (!IN_TAURI) return undefined;
  const clean = title.trim();
  if (!clean) return undefined;
  const t = (kind ?? "").toLowerCase();
  if (t === "music") return undefined; // album art is resolved separately (iTunes/embedded)
  if (t === "book") return relayBookUrl(clean);
  if (t === "game") return `${POSTER_RELAY}?type=game&title=${encodeURIComponent(clean)}`;
  // movie / tv / anime. Auto-detect anime from the title when the caller didn't say (the TV
  // Shows view passes "show" for everything, including anime), then reduce the raw release name
  // to a clean work title — a raw filename like "[Anitsu] Kusuriya no Hitorigoto - S01E17 [BD
  // 1080p x265]" never matches TMDB/AniList, which is the root cause of the broken-poster grid.
  const type: "anime" | "tv" | "movie" =
    t === "anime" || isAnime({ title: clean })
      ? "anime"
      : t === "show" || t === "tv" || t === "series"
        ? "tv"
        : "movie";
  const cleaned = cleanTitleForPoster(clean, type) ?? clean;
  return `${POSTER_RELAY}?type=${type}&title=${encodeURIComponent(cleaned)}`;
}

export default function App() {
  const [view, setView] = useState<AppView>("discover");
  const [prevView, setPrevView] = useState<NavId>("discover");
  // --- Browser-style back/forward history over the main view ---
  const [navHist, setNavHist] = useState<{ stack: AppView[]; index: number }>(() => ({ stack: ["discover"], index: 0 }));
  const navHistRef = useRef(navHist);
  navHistRef.current = navHist;
  // True while we are restoring a historical view via the arrows — so the view-watcher below moves
  // the pointer instead of branching a new trail (and truncating the forward stack).
  const navSuppressRef = useRef(false);
  useEffect(() => {
    if (navSuppressRef.current) { navSuppressRef.current = false; return; }
    setNavHist((n) => {
      if (n.stack[n.index] === view) return n; // not a real change (initial mount / re-render)
      const arr = [...n.stack.slice(0, n.index + 1), view].slice(-50); // drop forward trail, cap depth
      return { stack: arr, index: arr.length - 1 };
    });
  }, [view]);
  const goBack = useCallback(() => {
    const n = navHistRef.current;
    if (n.index <= 0) return;
    navSuppressRef.current = true;
    const index = n.index - 1;
    setNavHist({ ...n, index });
    setView(n.stack[index]);
  }, []);
  const goForward = useCallback(() => {
    const n = navHistRef.current;
    if (n.index >= n.stack.length - 1) return;
    navSuppressRef.current = true;
    const index = n.index + 1;
    setNavHist({ ...n, index });
    setView(n.stack[index]);
  }, []);
  // Which video sub-tab the rail's "Videos" entry returns to (sticks to the last one opened).
  const [lastVideoView, setLastVideoView] = useState<VideoTab>("tvshows");
  const player = usePlayer();
  // After a few idle minutes (no input), drift a colour-cycling DVD-style element around the screen.
  // With a track loaded it bounces a live "now playing" card (art + visualizer + title/artist);
  // otherwise the plain GhostWire logo. Suppressed only while watching a video (view === "player").
  const idle = useIdle(3 * 60 * 1000, !IS_IOS && view !== "player");
  const { openWindow: openVisualizerWindow } = useVisualizerWindow(player);
  const { linkedMac } = useLinkedDevice();
  const { state: sync } = useSync();
  // Companion mode: on iOS, the app is a pure mirror of a linked desktop — it shows the
  // desktop's downloads and streams them, but never downloads or stores anything locally.
  const companionMode = IS_IOS && !!linkedMac;
  const [remoteDownloads, setRemoteDownloads] = useState<DownloadStats[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CatalogItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Set by <ExtSearchBridge> (inside ExtensionProvider) — runs extension-contributed search sources.
  const extSearchRef = useRef<((q: string, now: number) => Promise<CatalogItem[]>) | null>(null);
  // Set by <ExtMusicImporterBridge> — the active music-link importer (SpotiFLAC), or null when its
  // extension is disabled (which turns music importing off across the app).
  const extMusicImporterRef = useRef<ExtMusicImporter | null>(null);
  // Set by <ExtViewIdsBridge> — ids of extension-contributed views (and which of them supply their
  // own contextual sidebar). The app's sidebar is hidden only for full-canvas ext views (no sidebar).
  const [extViews, setExtViews] = useState<{ ids: string[]; sidebars: string[] }>({ ids: [], sidebars: [] });
  const [recents, setRecents] = useState<string[]>(loadRecents);
  // Featured carousel (from the relay) + the movie/show details digest shown on click.
  const [featuredItems, setFeaturedItems] = useState<MovieDigest[]>(() => {
    // Paint the last-seen featured carousel instantly (SWR), then revalidate from the relay —
    // so the billboard isn't blank for the 1–2s of a cold relay round-trip on launch.
    try {
      const c = JSON.parse(localStorage.getItem("ghosty.featured") || "[]");
      return Array.isArray(c) ? (c as MovieDigest[]) : [];
    } catch {
      return [];
    }
  });
  const [digestItem, setDigestItem] = useState<CatalogItem | null>(null);

  // Persistent music-import queue (Spotify/music links → background downloads, shown
  // as cards on the Downloads page). The backend owns the queue + resume; we mirror it.
  const [musicImports, setMusicImports] = useState<MusicImportJob[]>([]);
  async function importMusicLink(url: string) {
    const importer = extMusicImporterRef.current;
    if (!importer) {
      setMusicToast("Enable the SpotiFLAC extension to import music links.");
      return;
    }
    try {
      await importer.enqueue(url);
      // Stay on the current view — the toast + the Downloads rail badge are the
      // feedback; don't yank the user over to Downloads.
      setMusicToast("Added to downloads — importing in the background.");
    } catch (e) {
      setMusicToast(e instanceof Error ? e.message : String(e));
    }
  }

  // VPN kill-switch: set when a VPN that was active during this session switches off. The
  // backend has already halted all traffic by the time this fires; the modal blocks the UI
  // until the user resumes or quits. Never set on a VPN-less launch.
  const [vpnDropped, setVpnDropped] = useState<VpnStatus | null>(null);

  // Organize-library task — lifted to App so it runs in the background (non-blocking)
  // and is monitorable from the top-bar chip + a closeable right-hand panel.
  const [orgOpen, setOrgOpen] = useState(false);
  const [orgPhase, setOrgPhase] = useState<OrganizePhase>("idle");
  const [orgProgress, setOrgProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [orgSteps, setOrgSteps] = useState<OrganizeStep[]>([]);
  const [orgResult, setOrgResult] = useState<OrganizeResult | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const orgRunningRef = useRef(false);

  // Incremental organize: one streaming call that moves each download into the separate
  // Organized/ library file by file. Finished files survive a crash/stop, so re-running
  // just resumes. The panel + top-bar chip track the live per-file progress. `silent`
  // (used by the auto-cleanup) runs it in the background without popping the panel open.
  async function startOrganize(opts?: { silent?: boolean }) {
    if (orgRunningRef.current) {
      if (!opts?.silent) setOrgOpen(true); // already in flight — just reveal the panel
      return;
    }
    orgRunningRef.current = true;
    if (!opts?.silent) setOrgOpen(true);
    setOrgPhase("organizing");
    setOrgProgress({ done: 0, total: 0 });
    setOrgSteps([]);
    setOrgResult(null);
    setOrgError(null);
    try {
      // The auto-cleanup pass (silent) leaves music alone — SpotiFLAC already nests it
      // by Artist/Album. A manual Organize still includes music.
      const r = await organizeRun(!opts?.silent);
      setOrgResult(r);
      setOrgPhase("done");
      refreshLibrary();
    } catch (e) {
      setOrgError(String(e));
      setOrgPhase("error");
    } finally {
      orgRunningRef.current = false;
    }
  }

  useEffect(() => {
    if (!IN_TAURI) return;
    let un: (() => void) | undefined;
    onOrganizeProgress((s) => {
      setOrgProgress({ done: s.done, total: s.total });
      setOrgSteps((prev) => [...prev, s].slice(-300)); // cap the live list
    }).then((f) => (un = f));
    return () => un?.();
  }, []);

  // Load the relay's curated featured carousel once (best-effort; Discover falls back
  // to the local pool when the relay has none).
  useEffect(() => {
    if (!IN_TAURI) return;
    fetchFeatured()
      .then((f) => {
        setFeaturedItems(f);
        try { localStorage.setItem("ghosty.featured", JSON.stringify(f)); } catch { /* quota */ }
      })
      .catch(() => {});
  }, []);

  // --- shell chrome (Libre-style nav rail + collapsible contextual sidebar) ---
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Hover-peek of the collapsed sidebar (flyout from the topbar toggle, Claude-style).
  const [sidebarFlyoutOpen, setSidebarFlyoutOpen] = useState(false);
  const flyoutTimer = useRef<number | undefined>(undefined);
  const openSidebarFlyout = () => { window.clearTimeout(flyoutTimer.current); setSidebarFlyoutOpen(true); };
  const closeSidebarFlyoutSoon = () => {
    window.clearTimeout(flyoutTimer.current);
    flyoutTimer.current = window.setTimeout(() => setSidebarFlyoutOpen(false), 160);
  };
  const closeSidebarFlyout = () => { window.clearTimeout(flyoutTimer.current); setSidebarFlyoutOpen(false); };
  const [secSort, setSecSort] = useState<SectionSort>("popularity");
  const [secGenre, setSecGenre] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  // The extension selected in the Extensions page master list (null → first installed).
  // Sub-tab within the Music section (browse, import, playlists, and optional sync).
  const [musicTab, setMusicTab] = useState<"browse" | "playlists" | "sync">("browse");
  // Playlist opened from the rail / detail, + a counter bumped to re-fetch playlists after edits.
  const [openPlaylistId, setOpenPlaylistId] = useState<string | null>(null);
  const [playlistRefresh, setPlaylistRefresh] = useState(0);
  const [musicToast, setMusicToast] = useState<string | null>(null);
  const navTimerRef = useRef<ReturnType<typeof startPerfTimer> | null>(null);
  const appMountMsRef = useRef(typeof performance !== "undefined" ? performance.now() : Date.now());
  const firstUsableLoggedRef = useRef(false);
  const readyRunRef = useRef(0);
  const activeViewReadyRef = useRef<{
    key: string;
    run: number;
    done: (meta?: PerfMeta) => number;
    startedAt: number;
  } | null>(null);

  const markViewReady = useCallback((expectedKey: string, meta?: PerfMeta) => {
    const active = activeViewReadyRef.current;
    if (!active || active.key !== expectedKey) return;
    const elapsed = active.done({
      view: expectedKey,
      run: active.run,
      ready: true,
      ...meta,
    });
    recordPerf("render", "view.ready", elapsed, {
      view: expectedKey,
      run: active.run,
      ...meta,
    });
    activeViewReadyRef.current = null;

    if (!firstUsableLoggedRef.current) {
      firstUsableLoggedRef.current = true;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      recordPerf("startup", "startup.first_usable", Math.max(0, now - appMountMsRef.current), {
        view: expectedKey,
        run: active.run,
      });
    }
  }, []);

  const markDiscoverReady = useCallback((meta?: PerfMeta) => markViewReady("discover", meta), [markViewReady]);
  const markLibraryReady = useCallback((meta?: PerfMeta) => markViewReady("library", meta), [markViewReady]);
  const markMoviesReady = useCallback((meta?: PerfMeta) => markViewReady("movies", meta), [markViewReady]);
  const markTvShowsReady = useCallback((meta?: PerfMeta) => markViewReady("tvshows", meta), [markViewReady]);
  const markMusicBrowseReady = useCallback((meta?: PerfMeta) => markViewReady("music:browse", meta), [markViewReady]);
  const markMusicPlaylistsReady = useCallback((meta?: PerfMeta) => markViewReady("music:playlists", meta), [markViewReady]);
  const markMusicSyncReady = useCallback((meta?: PerfMeta) => markViewReady("music:sync", meta), [markViewReady]);
  const markBooksReady = useCallback((meta?: PerfMeta) => markViewReady("books", meta), [markViewReady]);
  const markGamesReady = useCallback((meta?: PerfMeta) => markViewReady("games", meta), [markViewReady]);
  const markAnimeReady = useCallback((meta?: PerfMeta) => markViewReady("anime", meta), [markViewReady]);
  const markDownloadsReady = useCallback((meta?: PerfMeta) => markViewReady("downloads", meta), [markViewReady]);
  const markSocialReady = useCallback((meta?: PerfMeta) => markViewReady("social", meta), [markViewReady]);

  useLayoutEffect(() => {
    const prev = activeViewReadyRef.current;
    if (prev) {
      prev.done({
        view: prev.key,
        run: prev.run,
        ready: false,
        cancelled: true,
        reason: "view_changed",
      });
      activeViewReadyRef.current = null;
    }
    const key = readyKeyForView(view, musicTab);
    if (!key || !isPerfEnabled()) return;
    readyRunRef.current += 1;
    const run = readyRunRef.current;
    const done = startPerfTimer("render", "view.first_ready", {
      view: key,
      run,
      navView: view,
      musicTab,
    });
    activeViewReadyRef.current = { key, run, done, startedAt: Date.now() };
    recordPerf("render", "view.enter", 0, {
      view: key,
      run,
      navView: view,
      musicTab,
    });
  }, [musicTab, view]);

  useEffect(
    () => () => {
      const active = activeViewReadyRef.current;
      if (!active) return;
      active.done({
        view: active.key,
        run: active.run,
        ready: false,
        cancelled: true,
        reason: "app_unmount",
      });
      activeViewReadyRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!musicToast) return;
    const id = window.setTimeout(() => setMusicToast(null), 2600);
    return () => window.clearTimeout(id);
  }, [musicToast]);

  function pushRecent(q: string) {
    setRecents((cur) => {
      const next = [q, ...cur.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
      saveRecents(next);
      return next;
    });
  }
  function clearRecents() {
    setRecents([]);
    saveRecents([]);
  }

  // Catalog = built-in seed merged with whatever the indexer has discovered (DB).
  // Seed Discover from the persisted companion snapshot so a cold start on the iPad paints
  // instantly instead of waiting on the network. Empty on desktop (nothing persisted there).
  const [dbItems, setDbItems] = useState<CatalogItem[]>(() => loadSnapshot(readLinkedDeviceIdSync())?.catalog ?? []);
  const catalog = useMemo(() => mergeCatalog(MOCK_CATALOG, dbItems), [dbItems]);

  const [sources, setSources] = useState<Source[]>(MOCK_SOURCES);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);
  const [downloadConcurrency, setDownloadConcurrencyState] = useState(1);

  const [downloads, setDownloads] = useState<DownloadStats[]>(() => (IN_TAURI ? [] : MOCK_DOWNLOADS));
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareToast, setShareToast] = useState<string | null>(null);

  // Items deliberately shared with your connections (drives the "Shared" badge on cards + the
  // social "My shares" list) plus the share/stop/copy actions exposed to context menus.
  // Mirrors exactly what friends can browse — NOT downloads merely seeding back to the swarm.
  const shareControls = useMemo<ShareControls>(() => {
    const shared = new Set<string>();
    const myShares: MyShare[] = [];
    for (const d of downloads) {
      if (d.id.startsWith("local:")) continue;
      // Only items DELIBERATELY shared with your connections (a local seed created via
      // "Share with network" / "Create torrent") count here — not every finished download
      // that's merely seeding back to the public swarm. The "Shared" badge and "My shares"
      // both mean "people you're connected with can find this", so swarm seeds are excluded.
      if (d.shared) {
        shared.add(d.id.toLowerCase());
        myShares.push({ id: d.id, title: d.title });
      }
    }
    return {
      shared,
      myShares,
      shareItem: (item) => {
        if (!IN_TAURI) {
          setShareToast("Sharing is available in the desktop app.");
          return;
        }
        const magnet = item.magnet?.trim();
        const run = magnet && MAGNET_RE.test(magnet) ? addTorrent(magnet) : shareLibraryItem(item.id);
        setShareToast(`Sharing “${item.title}” with your network…`);
        Promise.resolve(run)
          .then(() => setShareToast(`Now sharing “${item.title}”.`))
          .catch((e) => setShareToast(`Couldn't share: ${String(e)}`));
      },
      stopSharing: (id) => {
        if (IN_TAURI) removeTorrent(id).catch(() => {});
        setShareToast("Stopped sharing.");
      },
      copyMagnet: (item) => {
        const magnet = item.magnet?.trim();
        if (!magnet) {
          setShareToast("No magnet link for this item.");
          return;
        }
        navigator.clipboard
          .writeText(magnet)
          .then(() => setShareToast("Magnet link copied."))
          .catch(() => setShareToast("Couldn't copy the magnet link."));
      },
    };
  }, [downloads]);

  // Auto-dismiss the global share toast.
  useEffect(() => {
    if (!shareToast) return;
    const id = window.setTimeout(() => setShareToast(null), 2800);
    return () => window.clearTimeout(id);
  }, [shareToast]);

  // --- Auto-cleanup: organize + enrich downloads as they finish (OPT-IN; OFF by default) ---
  // Off by default because organizing moves/renames files out of Downloads/, and a torrent that
  // briefly reports ~99.9% can still be writing/verifying — moving its files then corrupts the
  // transfer. So cleaning is MANUAL unless the user explicitly enables it in Settings.
  const dlProgressRef = useRef<Map<string, number>>(new Map());
  const cleanupTimerRef = useRef<number | null>(null);

  async function runAutoCleanup() {
    if (orgRunningRef.current) {
      scheduleCleanup(); // organize already running — retry once it's free
      return;
    }
    const setting = await getSetting("auto_cleanup").catch(() => null);
    if (setting !== "true") return; // OFF unless explicitly opted in — cleaning is manual by default
    await startOrganize({ silent: true }); // tidy new files into Organized/ (chip shows progress)
    try {
      await aiScan(60); // enrich: clean titles, posters, ratings, index
    } catch {
      /* enrich is best-effort */
    }
    refreshLibrary();
    refreshCatalog();
  }

  function scheduleCleanup() {
    if (cleanupTimerRef.current) window.clearTimeout(cleanupTimerRef.current);
    // Debounce so a burst of completions triggers a single cleanup once things settle.
    cleanupTimerRef.current = window.setTimeout(() => void runAutoCleanup(), 8000);
  }

  // Trigger only on an in-progress → complete transition observed this session, so the
  // pre-existing backlog at launch isn't auto-organized (those are never seen mid-download).
  useEffect(() => {
    if (!IN_TAURI) return;
    let justFinished = false;
    for (const d of downloads) {
      if (d.id.startsWith("local:")) continue;
      const prev = dlProgressRef.current.get(d.id);
      if (prev !== undefined && prev < 0.999 && d.progress >= 0.999) justFinished = true;
      dlProgressRef.current.set(d.id, d.progress);
    }
    if (justFinished) scheduleCleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloads]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [streamItems, setStreamItems] = useState<Record<string, PlayerItem>>({});
  const [media, setMedia] = useState<MediaInfo | null>(null);
  // Streaming a search result is an ephemeral *preview* — its id sits here until
  // either it's explicitly downloaded (removed from the set) or the player closes
  // (torn down, files and all, so previews never pile up in Downloads).
  const previews = useRef<Set<string>>(new Set());
  const watching = useRef<string | null>(null);

  // --- AI library ---
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>(() => loadSnapshot(readLinkedDeviceIdSync())?.library ?? []);

  function refreshLibrary() {
    if (!IN_TAURI) return;
    void withPerfAsync("library", "list_library.refresh", () => listLibrary())
      .then((lib) => startTransition(() => setLibraryItems(lib)))
      .catch(() => {});
  }

  // Companion (iPad): pull the whole index from the linked Mac in ONE round-trip and persist it
  // for instant cold starts. A cheap version probe first skips the (multi-MB) transfer when the
  // painted copy is already current. On failure we keep whatever is painted rather than blanking.
  const pullSnapshot = useCallback(async () => {
    const dev = getActiveDevice();
    if (!IN_TAURI || !dev) return;
    const sync = getSyncApi();
    try {
      const persisted = loadSnapshot(dev.deviceId);
      const v = await remoteSnapshotVersion(dev);
      if (persisted && v.version === persisted.version) return; // nothing changed — keep the painted copy
    } catch {
      return; // host unreachable — the connection ping reflects it; keep the painted cache
    }
    sync?.begin("catalog");
    sync?.begin("library");
    try {
      const snap = await remoteSnapshot(dev);
      startTransition(() => {
        setDbItems(snap.catalog);
        setLibraryItems(snap.library);
      });
      sync?.done("catalog", snap.catalog.length);
      sync?.done("library", snap.library.length);
      // Defer the (multi-MB) JSON.stringify + localStorage write well off the render-critical
      // path so it can't stack on top of the big re-render this pull just triggered and spike
      // the iPad's web view (the persist is only a cold-start seed, never urgent).
      const seed = {
        version: snap.version,
        catalog: snap.catalog,
        library: snap.library,
        downloaded: snap.downloaded,
        savedAt: Date.now(),
        hostId: dev.deviceId,
      };
      setTimeout(() => saveSnapshot(seed), 1500);
    } catch (e) {
      sync?.fail("catalog", e);
      sync?.fail("library", e);
    }
  }, []);

  // Pull when the link comes up (or switches). Skips the first render (deviceId starts null);
  // desktop never links so this stays a no-op there.
  const companionHostId = companionMode ? linkedMac?.deviceId ?? null : null;
  const seenHost = useRef(false);
  useEffect(() => {
    if (!seenHost.current) {
      seenHost.current = true;
      return;
    }
    if (companionHostId) void pullSnapshot();
  }, [companionHostId, pullSnapshot]);

  // Self-heal: when the link to the Mac comes back (offline/connecting → online) — e.g. the host
  // finished a rebuild, woke from sleep, or rejoined WiFi — re-pull the index so content that
  // failed to load while it was down fills in on its own, no manual Sync-now needed. Cheap: the
  // pull is version-gated. (Desktop never pings → connection stays "connecting", so this no-ops.)
  const prevConn = useRef(sync.connection);
  useEffect(() => {
    const was = prevConn.current;
    prevConn.current = sync.connection;
    if (companionMode && was !== "online" && sync.connection === "online") void pullSnapshot();
  }, [sync.connection, companionMode, pullSnapshot]);

  // Real-time poster art: keyless-first (IMDb/iTunes) so covers appear without any
  // API key. Drains the missing-poster queue in batches, refreshing the grid after
  // each, and re-entrancy is guarded so search + load can both trigger it safely.
  const posterBusy = useRef(false);
  async function autoPosters() {
    if (!IN_TAURI || posterBusy.current) return;
    posterBusy.current = true;
    let anyFound = false;
    try {
      for (let batch = 0; batch < 12; batch++) {
        const r = await fetchPosters(60);
        if (r.found > 0) anyFound = true;
        if (r.remaining <= 0 || r.found === 0) break;
      }
      // Repaint ONCE after the loop, not after every batch — re-fetching the full
      // catalog+library each batch caused the grid to re-render up to a dozen times while
      // the user was browsing. Cards show their relay cover meanwhile, so nothing is blank.
      if (anyFound) {
        const [items, lib] = await Promise.all([listCatalog(), listLibrary()]);
        startTransition(() => {
          setDbItems(items);
          setLibraryItems(lib);
        });
      }
    } catch {
      /* best-effort; ignore */
    } finally {
      posterBusy.current = false;
    }
  }

  // --- LLM title cleaning: messy release names → clean display titles, cached server-side
  // and overlaid by id wherever items render. Progressive + bounded so search stays snappy.
  const [cleanTitleMap, setCleanTitleMap] = useState<Map<string, string>>(loadCleanTitles);
  // Same Map object as the initial state so already-cached ids are skipped from the first render.
  const cleanTitleRef = useRef<Map<string, string>>(cleanTitleMap);
  const cleanPending = useRef<Set<string>>(new Set());
  const cleanBusy = useRef(false);

  function requestCleanTitles(ids: string[]) {
    if (!IN_TAURI) return;
    let added = false;
    for (const id of ids) {
      if (id && !cleanTitleRef.current.has(id) && !cleanPending.current.has(id)) {
        cleanPending.current.add(id);
        added = true;
      }
    }
    if (added) void drainCleanTitles();
  }

  async function drainCleanTitles() {
    if (cleanBusy.current) return;
    cleanBusy.current = true;
    try {
      while (cleanPending.current.size > 0) {
        const batch = [...cleanPending.current].slice(0, 40);
        const before = cleanTitleRef.current.size;
        const r = await cleanTitles(batch, 10);
        for (const [id, ct] of r.titles) {
          cleanTitleRef.current.set(id, ct);
          cleanPending.current.delete(id);
        }
        if (cleanTitleRef.current.size > before) {
          setCleanTitleMap(new Map(cleanTitleRef.current));
          saveCleanTitles(cleanTitleRef.current); // persist so re-search/restart renders instantly
        }
        // No progress (e.g. an id is no longer in the catalog) — drop the batch so we don't spin.
        if (cleanTitleRef.current.size === before) for (const id of batch) cleanPending.current.delete(id);
      }
    } catch {
      /* best-effort; ignore */
    } finally {
      cleanBusy.current = false;
    }
  }

  // Clean search-result titles (the messy case) as soon as results arrive…
  useEffect(() => {
    requestCleanTitles(searchResults.map((it) => it.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchResults]);

  // …and on the Discover home, clean the top of the catalog (what the carousels show).
  useEffect(() => {
    if (searchQuery) return; // the search effect covers active searches
    requestCleanTitles(dbItems.slice(0, 48).map((it) => it.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbItems, searchQuery]);

  // Posters live on the persisted catalog/library rows (the auto-fetcher writes
  // them there); fresh search hits arrive without one, so this map lets us overlay
  // the cached cover onto any item by id wherever it's displayed.
  const posterById = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of dbItems) if (it.poster) m.set(it.id, it.poster);
    for (const li of libraryItems) if (li.poster) m.set(li.id, li.poster);
    return m;
  }, [dbItems, libraryItems]);

  // Search hits enriched with the cached cover (and library meta) for display in
  // the Discover home — without this, freshly-searched items render no poster.
  const searchView = useMemo(
    () =>
      searchResults.map((it) => ({
        ...it,
        poster: it.poster ?? posterById.get(it.id),
        cleanTitle: cleanTitleMap.get(it.id) ?? it.cleanTitle,
      })),
    [searchResults, posterById, cleanTitleMap],
  );

  // Normalized title -> cached poster, so locally-downloaded files (which have no
  // infohash) can borrow a cover by loose title match for the Library grid.
  // Manual poster overrides (right-click → Replace poster), keyed by normalized title.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [replaceTitle, setReplaceTitle] = useState<string | null>(null);
  function refreshOverrides() {
    if (!IN_TAURI) return;
    void withPerfAsync("library", "list_poster_overrides", () => listPosterOverrides())
      .then((o) => setOverrides(Object.fromEntries(o.map((x) => [x.title, x.url]))))
      .catch(() => {});
  }

  const posterByTitle = useMemo(() => {
    const m = new Map<string, string>();
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    for (const it of dbItems) if (it.poster) m.set(norm(it.title), it.poster);
    for (const li of libraryItems) if (li.poster) m.set(norm(li.cleanTitle || li.title), li.poster);
    for (const [k, url] of Object.entries(overrides)) m.set(k, url); // overrides win
    return m;
  }, [dbItems, libraryItems, overrides]);
  function posterForTitle(title: string, kind?: string): string | undefined {
    const k = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!k) return undefined;
    const exact = posterByTitle.get(k);
    if (exact) return exact;
    for (const [key, url] of posterByTitle) if (key.startsWith(k) || k.startsWith(key)) return url;
    // Reliable https fallback: resolve from the keyless relay by title (+ kind). Works
    // anywhere — no local /art cache or LAN image load needed (key for the iPad companion,
    // where downloaded titles often aren't in the catalog/library lookup at all).
    return relayPosterUrl(title, kind);
  }

  // Overlay AI metadata (mediaType / ratings / poster) from the scanned library onto
  // the browse pool (catalog + current search hits), then group into typed libraries.
  const sections = useMemo(() => {
    const metaById = new Map(libraryItems.map((li) => [li.id, li] as const));
    const byId = new Map<string, CatalogItem>();
    for (const it of catalog) byId.set(it.id, it);
    for (const it of searchResults) {
      const existing = byId.get(it.id);
      byId.set(it.id, { ...it, poster: it.poster ?? existing?.poster });
    }
    const groups: Record<MediaSectionId, LibraryItem[]> = {
      movies: [], tvshows: [], music: [], books: [], games: [],
    };
    for (const it of byId.values()) {
      const m = metaById.get(it.id);
      const enriched: LibraryItem = m
        ? {
            ...it,
            cleanTitle: cleanTitleMap.get(it.id) ?? m.cleanTitle,
            mediaType: m.mediaType,
            imdbRating: m.imdbRating,
            rtRating: m.rtRating,
            genre: m.genre,
            quality: m.quality,
            tags: m.tags,
            poster: it.poster ?? posterById.get(it.id) ?? m.poster,
          }
        : ({ ...it, poster: it.poster ?? posterById.get(it.id), cleanTitle: cleanTitleMap.get(it.id) } as LibraryItem);
      const s = sectionOf(enriched);
      if (s !== "other") groups[s].push(enriched);
    }
    return groups;
  }, [catalog, searchResults, libraryItems, posterById, cleanTitleMap]);

  // Section search: query every source but stay in the section (results are filtered
  // to the section's media type by the grouping above — that's the "bias toward type").
  // Poll rich media/diagnostic info for whatever's open in the player.
  useEffect(() => {
    if (view !== "player" || !activeId || !IN_TAURI) {
      setMedia(null);
      return;
    }
    let alive = true;
    const tick = () => mediaInfo(activeId).then((m) => alive && setMedia(m)).catch(() => {});
    tick();
    const h = window.setInterval(tick, 1500);
    return () => {
      alive = false;
      window.clearInterval(h);
    };
  }, [view, activeId]);

  // When a preview is no longer the thing being watched (player closed, or you
  // switched to another item), tear it down — engine + partial files — so things
  // you only previewed don't accumulate in Downloads.
  useEffect(() => {
    const now = view === "player" ? activeId : null;
    const prev = watching.current;
    if (prev && prev !== now && previews.current.has(prev)) {
      previews.current.delete(prev);
      setDownloads((d) => d.filter((x) => x.id !== prev));
      if (IN_TAURI) removeTorrent(prev, true).catch(() => {});
    }
    watching.current = now;
  }, [view, activeId]);

  // Load real sources/catalog + subscribe to live download snapshots (Tauri only).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    // The engine snapshot only knows about live torrents; preserve synthetic
    // "local:" entries (Library playback of already-downloaded files) so the
    // player's streamUrl/state survive the ~1Hz refresh.
    onDownloads((snap) => {
      setDownloads((prev) => {
        const ids = new Set(snap.map((s) => s.id));
        const locals = prev.filter((d) => d.id.startsWith("local:") && !ids.has(d.id));
        const next = [...snap, ...locals];
        // Idle ticks are identical — keep the old reference so React skips the re-render.
        return sameDownloads(prev, next) ? prev : next;
      });
    }).then((fn) => (unlisten = fn));
    if (IN_TAURI) {
      const done = startPerfTimer("startup", "app.bootstrap");
      const tasks: Promise<unknown>[] = [];
      tasks.push(
        withPerfAsync("startup", "bootstrap.list_sources", () => listSources())
          .then(setSources)
          .catch(() => {}),
      );
      // On iOS the catalog + library come from the linked Mac's snapshot (persisted seed +
      // the version-gated pull below), NOT a local list — running them here would route to the
      // empty local backend before the link restores and clobber the seeded content.
      if (!IS_IOS) {
        tasks.push(
          withPerfAsync("startup", "bootstrap.list_catalog", () => listCatalog())
            .then((items) => {
          // A large catalog classifies into typed sections + mounts the grids on this state
          // change — a synchronous render that, with thousands of items, blocks the main thread
          // (the black-screen-on-launch). startTransition lets React render it at low priority so
          // the shell stays interactive and paints first, then the content fills in.
              startTransition(() => setDbItems(items));
              if (items.some((it) => !it.poster)) autoPosters();
            })
            .catch(() => {}),
        );
        tasks.push(
          withPerfAsync("startup", "bootstrap.list_library", () => listLibrary())
            .then((lib) => startTransition(() => setLibraryItems(lib)))
            .catch(() => {}),
        );
      }
      tasks.push(withPerfAsync("startup", "bootstrap.ai_status", () => aiStatus()).catch(() => {}));
      refreshOverrides();
      void Promise.allSettled(tasks).then(() => {
        done({ tasks: tasks.length });
        // Dismiss the loading splash the moment real data is usable rather than on a blind timer,
        // so the first frame the user sees is populated (or, on iOS, the seeded/snapshot content).
        window.dispatchEvent(new Event("ghostwire:app-ready"));
      });
    } else {
      window.dispatchEvent(new Event("ghostwire:app-ready"));
    }
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // VPN kill-switch listener: the backend monitors the VPN and, on an active→inactive
  // transition while the app is open, halts traffic and emits `vpn://dropped`. Show the modal.
  useEffect(() => {
    if (!IN_TAURI) return;
    let unlisten: (() => void) | undefined;
    onVpnDropped((status) => setVpnDropped(status)).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  // Mirror the backend music-import queue: hydrate once, then live-update on every change.
  useEffect(() => {
    if (!IN_TAURI) return;
    let unlisten: (() => void) | undefined;
    listMusicImports().then(setMusicImports).catch(() => {});
    onMusicImports(setMusicImports).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!IN_TAURI) return;
    getDownloadConcurrency()
      .then((n) => setDownloadConcurrencyState(Math.max(1, Math.min(6, n || 1))))
      .catch(() => {});
  }, []);

  // --- streaming ---
  function openPlayer(id: string) {
    player.pause(); // don't let background music play under a video
    setActiveId(id);
    setPrevView((v) => (view === "player" ? v : (view as NavId)));
    setView("player");
  }

  /** On iOS the app is a pure companion — it never downloads or stores locally. A download
   *  always goes to the linked desktop; with nothing linked there's nowhere to send it.
   *  On desktop, always local. */
  function chooseDownloadTarget(_title: string): Promise<"mac" | "local" | null> {
    if (IS_IOS) return Promise.resolve(linkedMac ? "mac" : null);
    return Promise.resolve("local");
  }

  /** Open + stream a download that lives on the linked desktop (companion mode). */
  async function openRemoteDownload(id: string) {
    if (!linkedMac) return;
    const d = remoteDownloads.find((x) => x.id === id);
    const title = d?.title ?? "Streaming";
    setStreamItems((s) => ({ ...s, [id]: { title, source: linkedMac.name, kind: "video" } }));
    openPlayer(id);
    try {
      const url = await remoteStreamUrl(linkedMac, id);
      setStreamItems((s) => ({ ...s, [id]: { ...(s[id] ?? { title }), url } }));
    } catch (e) {
      console.error("remote stream failed", e);
    }
  }

  // Mirror the linked desktop's active downloads (companion mode), polling ~2s.
  useEffect(() => {
    if (!companionMode || !linkedMac) {
      setRemoteDownloads([]);
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const list = (await remoteListDownloads(linkedMac)) as DownloadStats[];
        if (alive) setRemoteDownloads(list);
      } catch {
        /* desktop unreachable — keep the last list */
      }
    };
    void poll();
    const t = window.setInterval(poll, 2000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [companionMode, linkedMac]);

  async function startStream(item: CatalogItem) {
    const kind = mediaKind(item.title, item.category);
    // Software, disk images, books, archives… are files, not media — download
    // them, never open the player or the encoder.
    if (kind === "other") {
      void startFileDownload(item);
      return;
    }
    // Movies & shows open a details digest (trailer + IMDb + cast) first, instead of
    // downloading/streaming immediately. Music & uncategorized video stream directly.
    const section = sectionOf(item);
    if (section === "movies" || section === "tvshows") {
      setDigestItem(item);
      return;
    }
    void streamNow(item, kind);
  }

  // The actual stream path (preview mark → player → engine). Called directly for
  // music and from the digest's Stream button for movies/shows.
  async function streamNow(item: CatalogItem, kind: MediaKind) {
    // Streaming = ephemeral preview unless the user later downloads it explicitly.
    previews.current.add(item.id);
    setStreamItems((s) => ({
      ...s,
      [item.id]: { title: item.title, sizeBytes: item.sizeBytes, source: item.source, kind: kind === "audio" ? "audio" : "video", poster: item.poster },
    }));
    openPlayer(item.id);
    if (!IN_TAURI) {
      setDownloads((d) => upsert(d, mockStats(item.id, item.title)));
      return;
    }
    const target = await chooseDownloadTarget(item.title);
    if (target === null) return; // cancelled
    try {
      if (target === "mac" && linkedMac) {
        // Add + transcode on the Mac, stream the result back (plays any codec).
        await remoteAddTorrent(linkedMac, item.magnet);
        const url = await remoteStreamUrl(linkedMac, item.id);
        setDownloads((d) => upsert(d, { ...baseStats(item.id, item.title), streamUrl: url }));
      } else {
        await addTorrent(item.magnet);
        const url = await getStreamUrl(item.id);
        setDownloads((d) => upsert(d, { ...baseStats(item.id, item.title), streamUrl: url }));
      }
    } catch (e) {
      console.error("startStream failed", e);
    }
  }

  /** Non-media item: queue the download and show it in Downloads — no player, no ffmpeg. */
  async function startFileDownload(item: CatalogItem, forceDuplicate = false) {
    const link = item.magnet.trim();
    if (!isTorrentLink(link) && isHttpUrl(link)) {
      if (!IN_TAURI) {
        setSearchError("Direct HTTP downloads are available only in the desktop app.");
      } else if (!IS_IOS) {
        try {
          await downloadHttpFile(link, item.title, forceDuplicate);
          refreshLibrary();
          return;
        } catch (e) {
          const msg = String(e).toLowerCase();
          if (msg.includes("already downloaded")) {
            setSearchError("already downloaded, download again");
          } else {
            setSearchError(`Direct download failed: ${String(e)}`);
          }
        }
      } else {
        setSearchError("Direct HTTP downloads are not supported on iOS companion mode.");
      }
      return;
    }

    previews.current.delete(item.id); // an explicit download is kept, not a preview
    // Stay on the current view — the transfer surfaces in the Downloads rail
    // badge (and Downloads / Library); don't navigate away on enqueue.
    if (!IN_TAURI) {
      setDownloads((d) => upsert(d, mockStats(item.id, item.title)));
      return;
    }
    const target = await chooseDownloadTarget(item.title);
    if (target === null) return;
    setDownloads((d) => upsert(d, baseStats(item.id, item.title)));
    try {
      if (target === "mac" && linkedMac) await remoteAddTorrent(linkedMac, item.magnet);
      else await addTorrent(item.magnet, true); // explicit download → into the one-at-a-time queue
    } catch (e) {
      console.error("download failed", e);
    }
  }

  /** Queue a torrent for download WITHOUT opening the player — used by the series
   *  finder's "Add to library" so grabbing a season pack never streams episode 1.
   *  Stays on the current view; the download surfaces in Downloads (and the Library
   *  once it finishes). */
  async function downloadToLibrary(item: CatalogItem, forceDuplicate = false) {
    const link = item.magnet.trim();
    if (!isTorrentLink(link) && isHttpUrl(link)) {
      if (!IN_TAURI) {
        setSearchError("Direct HTTP downloads are available only in the desktop app.");
      } else if (!IS_IOS) {
        try {
          await downloadHttpFile(link, item.title, forceDuplicate);
          refreshLibrary();
          return;
        } catch (e) {
          const msg = String(e).toLowerCase();
          if (msg.includes("already downloaded")) {
            setSearchError("already downloaded, download again");
          } else {
            setSearchError(`Direct download failed: ${String(e)}`);
          }
        }
      } else {
        setSearchError("Direct HTTP downloads are not supported on iOS companion mode.");
      }
      return;
    }

    previews.current.delete(item.id); // explicit download — keep it
    if (!IN_TAURI) {
      setDownloads((d) => upsert(d, mockStats(item.id, item.title)));
      return;
    }
    const target = await chooseDownloadTarget(item.title);
    if (target === null) return;
    setDownloads((d) => upsert(d, baseStats(item.id, item.title)));
    try {
      if (target === "mac" && linkedMac) await remoteAddTorrent(linkedMac, item.magnet);
      else await addTorrent(item.magnet, true); // explicit download → into the one-at-a-time queue
    } catch (e) {
      console.error("download failed", e);
    }
  }

  /** Pull a friend's share (browse/search "Get") into the one-at-a-time download queue —
   *  a real download, not a stream preview. Stays on the current view; the transfer surfaces
   *  in the Downloads rail badge (and Downloads / Library once it finishes). `addMagnet` (the
   *  paste-a-link path) only adds an ephemeral stream PREVIEW and opens the player, which
   *  surfaces nothing for a folder or non-media share — hence "Get did nothing". */
  async function grabShare(item: ShareItem) {
    const magnet = shareMagnet(item);
    if (!IN_TAURI) {
      setDownloads((d) => upsert(d, mockStats(item.infohash, item.name)));
      return;
    }
    const target = await chooseDownloadTarget(item.name);
    if (target === null) return; // cancelled
    setDownloads((d) => upsert(d, baseStats(item.infohash, item.name)));
    try {
      if (target === "mac" && linkedMac) await remoteAddTorrent(linkedMac, magnet);
      else await addTorrent(magnet, true, item.peers ?? undefined); // explicit download → one-at-a-time queue, dial the seeder directly
    } catch (e) {
      console.error("grab share failed", e);
    }
  }

  /** Play a file already downloaded to disk (Library) — streamed from the loopback /file route.
   *  In companion mode (iPad linked to a desktop) the URL resolves to a token-bearing stream on
   *  the desktop instead, so playback comes off the desktop and the iPad only buffers. */
  async function playLocal(item: DownloadedItem) {
    // Audio plays in the global player (persistent now-playing bar + visualizer),
    // not the full-screen video player. Build a library-wide queue so next/prev work.
    if (item.kind === "audio") {
      void playAudio(item);
      return;
    }
    const url = await resolveLocalPlayUrl(item).catch(() => item.url);
    if (item.kind === "book" || item.mediaType === "book") {
      if (IN_TAURI && !IS_IOS) {
        try {
          await openBrowser(url);
          return;
        } catch {
          /* fall through to a normal browser open */
        }
      }
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    if (item.kind === "game" || item.mediaType === "game") {
      if (IN_TAURI && !IS_IOS) {
        await revealPath(item.id).catch(() => {});
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    const id = `local:${item.id}`;
    setStreamItems((s) => ({
      ...s,
      [id]: {
        title: item.title,
        kind: "video",
        poster: posterForTitle(item.title),
        url,
        relpath: item.id,
        // Carry the parsed episode context so the below-player show panel works for local
        // files (whose clean title no longer contains S/E like a release name does).
        show: item.title,
        season: item.season,
        episode: item.episode,
        isAnime: isAnime({ title: item.title, genre: item.genre }),
      },
    }));
    setDownloads((d) =>
      upsert(d, { id, title: item.title, state: "ready", progress: 1, downSpeed: 0, upSpeed: 0, peers: 0, streamUrl: url }),
    );
    openPlayer(id);
  }

  /** Play a local audio file through the global player, queueing the whole music library.
   *  In companion mode each track's URL resolves to a token-bearing stream on the linked
   *  desktop (resolved by relpath), so the iPad buffers audio off the desktop. */
  async function playAudioCollection(items: DownloadedItem[], opts?: PlayAudioCollectionOptions) {
    const unique = new Map<string, DownloadedItem>();
    for (const it of items) {
      if (!unique.has(it.id)) unique.set(it.id, it);
    }
    const list = [...unique.values()];
    if (list.length === 0) return;

    const toTrack = async (it: DownloadedItem): Promise<PlayerTrack> => ({
      id: it.id,
      title: it.title,
      artist: it.artist ?? undefined,
      album: it.album ?? undefined,
      url: await resolveLocalPlayUrl(it).catch(() => it.url),
      // Embedded album art (served from loopback /art) first, then any matched poster.
      art: it.artworkUrl ?? posterForTitle(it.title) ?? undefined,
    });

    const queue = await Promise.all(list.map(toTrack));
    if (opts?.shuffle) {
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }
    }
    const startId = opts?.startId;
    const idx = startId ? Math.max(0, queue.findIndex((t) => t.id === startId)) : 0;
    player.play(queue, idx);
  }

  async function playAudio(item: DownloadedItem) {
    if (!IN_TAURI) {
      await playAudioCollection([item], { startId: item.id });
      return;
    }
    try {
      const all = await listDownloaded();
      const music = all.filter((i) => i.mediaType === "music").sort((a, b) => a.id.localeCompare(b.id));
      const list = music.length ? music : [item];
      await playAudioCollection(list, { startId: item.id });
    } catch {
      await playAudioCollection([item], { startId: item.id });
    }
  }

  /** From the in-player episode browser: play a specific episode of a show. Prefers an
   *  already-downloaded copy (instant), otherwise finds the best source and streams it. */
  async function playEpisode(show: string, season: number, episode: number): Promise<boolean> {
    if (!IN_TAURI) return false;
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const w = norm(show);
    try {
      const have = await listDownloaded();
      // Exact normalized show-name match: list_downloaded titles are already the clean
      // parsed show name, so equality avoids cross-show collisions ("Lost" vs
      // "Lost in Space" both have an S01E03). A miss just falls back to a source search.
      const local = have.find(
        (d) =>
          d.mediaType === "show" &&
          d.season === season &&
          d.episode === episode &&
          norm(d.title) === w,
      );
      if (local) {
        await playLocal(local);
        return true;
      }
    } catch {
      /* fall through to a source search */
    }
    try {
      const hits = await searchSources(`${show} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`);
      // Only stream a result that actually parses to THIS show + THIS episode. The old code
      // fell back to hits[0] (or any title containing "SxxExx"), which could be an entirely
      // different show — clicking an episode would jump to the wrong series. Better to find
      // nothing (the row says "No source") than to play the wrong show.
      const wantTokens = norm(show).split(" ").filter((t) => t.length >= 2 && !/^\d{4}$/.test(t));
      const showMatches = (parsedShow: string): boolean => {
        const ct = norm(parsedShow).split(" ").filter((t) => t.length >= 2 && !/^\d{4}$/.test(t));
        // Every significant word of the requested show must be present, and the candidate may
        // carry at most one extra word (a studio/region prefix like "Marvel's"/"US") — this
        // keeps "Lost" from matching "Lost in Space".
        return (
          wantTokens.length > 0 &&
          wantTokens.every((tok) => ct.includes(tok)) &&
          ct.filter((tok) => !wantTokens.includes(tok)).length <= 1
        );
      };
      const pick = hits.find((h) => {
        const p = parseEpisode(h.title);
        return p != null && p.season === season && p.episode === episode && showMatches(p.show);
      });
      if (pick) {
        // Stream the episode straight into the (already-open) player — NOT startStream,
        // which would pop the show's details digest and yank the user out of playback.
        void streamNow(pick, "video");
        return true;
      }
    } catch (e) {
      console.error("playEpisode failed", e);
    }
    return false;
  }

  /** Play an anime episode by absolute number — local copy first, else a source search. */
  async function playAnimeEpisode(title: string, episode: number): Promise<boolean> {
    if (!IN_TAURI) return false;
    const w = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const firstWord = w.split(" ")[0] ?? "";
    try {
      const have = await listDownloaded();
      const local = have.find(
        (d) =>
          d.kind === "video" &&
          d.episode === episode &&
          isAnime({ title: d.title, genre: d.genre }) &&
          d.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().includes(firstWord),
      );
      if (local) {
        await playLocal(local);
        return true;
      }
    } catch {
      /* fall through to a source search */
    }
    try {
      const epNum = String(episode);
      const hits = await searchSources(`${title} ${epNum.padStart(2, "0")}`);
      // Require the file to be THIS anime (a strong majority of the title's words appear)
      // AND carry the absolute episode number as its own token (strip resolutions first so
      // "1080p" can't masquerade as the episode). Never fall back to hits[0] — that's how a
      // click would jump to an unrelated series.
      const re = new RegExp(`(^|[^0-9])0*${epNum}([^0-9]|$)`);
      const wantTokens = w.split(" ").filter((t) => t.length >= 2 && !/^\d{4}$/.test(t));
      const isThisAnime = (t: string): boolean => {
        if (wantTokens.length === 0) return false;
        const ct = t.toLowerCase();
        const present = wantTokens.filter((tok) => ct.includes(tok)).length;
        return present / wantTokens.length >= 0.6;
      };
      const pick = hits.find((h) => isThisAnime(h.title) && re.test(h.title.replace(/\b\d{3,4}p\b/gi, " ")));
      if (pick) {
        // Stream straight into the open player instead of routing through startStream
        // (which would surface the details digest and interrupt playback).
        void streamNow(pick, "video");
        return true;
      }
    } catch (e) {
      console.error("playAnimeEpisode failed", e);
    }
    return false;
  }

  async function addMagnet(magnet: string) {
    if (!IN_TAURI) {
      const id = `paste-${magnet.slice(20, 32)}`;
      setStreamItems((s) => ({ ...s, [id]: { title: "Pasted magnet", source: "magnet link" } }));
      setDownloads((d) => upsert(d, mockStats(id, "Pasted magnet")));
      openPlayer(id);
      return;
    }
    const target = await chooseDownloadTarget("Pasted magnet");
    if (target === null) return;
    try {
      if (target === "mac" && linkedMac) {
        const id = await remoteAddTorrent(linkedMac, magnet);
        setStreamItems((s) => ({ ...s, [id]: { title: "Pasted magnet", source: "magnet link" } }));
        openPlayer(id);
        const url = await remoteStreamUrl(linkedMac, id);
        setDownloads((d) => upsert(d, { ...baseStats(id, "Pasted magnet"), streamUrl: url }));
      } else {
        const id = await addTorrent(magnet);
        setStreamItems((s) => ({ ...s, [id]: { title: "Pasted magnet", source: "magnet link" } }));
        openPlayer(id);
        const url = await getStreamUrl(id);
        setDownloads((d) => upsert(d, { ...baseStats(id, "Pasted magnet"), streamUrl: url }));
      }
    } catch (e) {
      console.error("addMagnet failed", e);
    }
  }

  function removeDownload(id: string) {
    setDownloads((d) => d.filter((x) => x.id !== id));
    if (IN_TAURI) removeTorrent(id).catch(() => {});
    if (activeId === id) setView("downloads");
  }

  // --- live search across every linked source (Discover home) ---
  async function handleSearch(q: string) {
    const query = q.trim();
    setPrevView((v) => (view === "player" || view === "discover" ? v : (view as NavId)));
    setSearchQuery(query);
    setView("discover");
    if (!query) {
      setSearchResults([]);
      return;
    }
    pushRecent(query);
    if (!IN_TAURI) {
      const ql = query.toLowerCase();
      setSearchResults(catalog.filter((i) => i.title.toLowerCase().includes(ql)));
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const items = await withPerfAsync("navigation", "search.global", () => searchSources(query), {
        queryLength: query.length,
      });
      // Merge in any extension-contributed search sources (Prowlarr/Jackett etc.). Native results
      // win on infohash collision (mergeCatalog: first arg overrides). Failures are swallowed inside
      // the bridge so a flaky extension source can't fail the whole search.
      let merged = items;
      if (extSearchRef.current) {
        const extItems = await extSearchRef.current(query, Date.now()).catch(() => [] as CatalogItem[]);
        if (extItems.length) merged = mergeCatalog(items, extItems);
      }
      setSearchResults(merged);
      setDbItems((d) => mergeCatalog(d, merged));
      autoPosters();
    } catch (e) {
      setSearchError(String(e));
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  function handlePause(id: string, paused: boolean) {
    if (IN_TAURI) pauseDownload(id, paused).catch(() => {});
  }

  async function handleSetDownloadConcurrency(value: number) {
    const clamped = Math.max(1, Math.min(6, value));
    setDownloadConcurrencyState(clamped);
    if (!IN_TAURI) return;
    try {
      const saved = await setDownloadConcurrency(clamped);
      setDownloadConcurrencyState(Math.max(1, Math.min(6, saved || clamped)));
    } catch {
      // keep optimistic value; snapshot will naturally reflect engine behavior
    }
  }

  function handleReveal(id: string) {
    if (IN_TAURI) revealDownload(id).catch(() => {});
  }

  function refreshCatalog() {
    if (IN_TAURI) listCatalog().then((items) => startTransition(() => setDbItems(items))).catch(() => {});
  }

  // --- sources ---
  async function handleAddSource(name: string, kind: SourceKind, url: string) {
    if (!IN_TAURI) {
      setSources((s) => [...s, { id: `local-${url}`, name, kind, url, enabled: true, itemCount: 0 }]);
      return;
    }
    try {
      await addSource(name, kind, url);
      setSources(await listSources());
    } catch (e) {
      console.error("addSource failed", e);
    }
  }

  async function handleRemoveSource(id: string) {
    if (!IN_TAURI) {
      setSources((s) => s.filter((x) => x.id !== id));
      return;
    }
    try {
      await removeSource(id);
      const [srcs, items] = await Promise.all([listSources(), listCatalog()]);
      setSources(srcs);
      setDbItems(items);
    } catch (e) {
      console.error("removeSource failed", e);
    }
  }

  function handleOpenBrowser(url: string) {
    if (!IN_TAURI) return;
    setRefreshStatus("Opening browser — solve any verification, browse to the magnets, then click Import.");
    openBrowser(url).catch((e) => setRefreshStatus(`Couldn't open browser: ${e}`));
  }

  async function handleImportFromBrowser(name: string) {
    if (!IN_TAURI) return;
    setRefreshStatus(null);
    try {
      const n = await importFromBrowser(name);
      const [srcs, items] = await Promise.all([listSources(), listCatalog()]);
      setSources(srcs);
      setDbItems(items);
      setRefreshStatus(
        n > 0
          ? `Imported ${n} magnet${n === 1 ? "" : "s"} from the page.`
          : "No magnets found on that page — open a results or detail page that contains magnet links, then Import again.",
      );
    } catch (e) {
      setRefreshStatus(`Import failed: ${e}`);
    }
  }

  async function handleExportSources() {
    if (!IN_TAURI) return;
    setRefreshStatus(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        title: "Export sources",
        defaultPath: "ghostwire-sources.json",
        filters: [{ name: "GhostWire sources", extensions: ["json"] }],
      });
      if (!path) return;
      const n = await exportSources(path);
      setRefreshStatus(`Exported ${n} source${n === 1 ? "" : "s"} — share this file to let others import them.`);
    } catch (e) {
      setRefreshStatus(`Export failed: ${e}`);
    }
  }

  async function handleImportSources() {
    if (!IN_TAURI) return;
    setRefreshStatus(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        title: "Import sources",
        multiple: false,
        directory: false,
        filters: [{ name: "GhostWire sources", extensions: ["json"] }],
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      const res = await importSources(path);
      setSources(await listSources());
      const parts = [`Added ${res.added} source${res.added === 1 ? "" : "s"}`];
      if (res.skipped > 0) parts.push(`${res.skipped} skipped (already present or invalid)`);
      setRefreshStatus(`${parts.join(" · ")}.`);
    } catch (e) {
      setRefreshStatus(`Import failed: ${e}`);
    }
  }


  async function handleRefresh(id: string) {
    if (!IN_TAURI) return;
    setRefreshingId(id);
    setRefreshStatus(null);
    try {
      const n = await refreshSource(id);
      const [srcs, items] = await Promise.all([listSources(), listCatalog()]);
      setSources(srcs);
      setDbItems(items);
      setRefreshStatus(`Indexed ${n} item${n === 1 ? "" : "s"}.`);
    } catch (e) {
      setRefreshStatus(`Refresh failed: ${e}`);
    } finally {
      setRefreshingId((cur) => (cur === id ? null : cur));
    }
  }

  const activeStats = downloads.find((d) => d.id === activeId);
  const activeItem = activeId ? streamItems[activeId] : undefined;
  // Which rail item is highlighted (player overlays its originating section).
  const activeNav: AppView = view === "player" ? prevView : view;
  // The shell's contextual sidebar is hidden for sections that drive their own in-view
  // navigation (Library/Playlists/Social) or have no use for the genre filters (Downloads —
  // it lists transfers/on-disk files, which the sidebar's section filters don't apply to).
  // Music uses the same sidebar shell as the other sections (with its playlist rail embedded).
  // Sections that drive their own in-view navigation never show the contextual sidebar,
  // regardless of the collapse toggle.
  const sidebarAutoHidden =
    activeNav === "library" ||
    activeNav === "playlists" ||
    activeNav === "downloads" ||
    activeNav === "extensions" ||
    activeNav === "watch-later" ||
    activeNav === "social" ||
    activeNav === "youtube" ||
    (extViews.ids.includes(activeNav) && !extViews.sidebars.includes(activeNav));
  const hideSidebar = sidebarCollapsed || sidebarAutoHidden;
  // The flyout peek is only meaningful when the user explicitly collapsed a sidebar that
  // would otherwise have content.
  const sidebarFlyoutAvailable = sidebarCollapsed && !sidebarAutoHidden;
  // The content section to render (null while the player is open or on a non-section view).
  const activeSection = (MEDIA_SECTIONS as string[]).includes(view) ? (view as MediaSectionId) : null;
  // The section whose filters the sidebar shows (sticks to the origin section in the player).
  const navSection = (MEDIA_SECTIONS as string[]).includes(activeNav) ? (activeNav as MediaSectionId) : null;
  const animeSidebarGenres = useMemo(() => {
    const animePool = [...sections.tvshows, ...sections.movies].filter((it) =>
      isAnime({ title: it.cleanTitle ?? it.title, genre: it.genre }),
    );
    return genresOf(animePool);
  }, [sections]);
  const sectionGenres = navSection
    ? genresOf(sections[navSection])
    : activeNav === "anime"
      ? animeSidebarGenres
      : [];
  useEffect(() => {
    if (!navTimerRef.current) return;
    const done = navTimerRef.current;
    navTimerRef.current = null;
    void waitFrames(2).then(() => done({ committedView: view }));
  }, [view]);

  function navigate(id: string) {
    // The rail's single "Videos" entry resolves to whichever sub-tab was last open.
    if (id === "videos") id = lastVideoView;
    if (isVideoView(id)) setLastVideoView(id);
    setSecGenre(null); // reset the section filter when switching sections
    navTimerRef.current = startPerfTimer("navigation", "view.navigate", {
      to: id,
      from: view,
    });
    // Mounting a content-heavy view (Music/Library with hundreds of cards) is a synchronous
    // render that can block the main thread. As a transition it yields, so the tab switch is
    // instant and the grid streams in instead of freezing the UI.
    startTransition(() => setView(id));
  }

  async function runPerfPass1Navigation(): Promise<string> {
    const sequence: NavId[] = ["discover", "library", "music", "movies", "tvshows", "downloads", "settings", "discover"];
    const fromView = view;
    const restoreTo: AppView = fromView === "player" ? prevView : fromView;
    const done = startPerfTimer("stress", "pass1.navigation", {
      steps: sequence.length,
      from: fromView,
    });
    for (const step of sequence) {
      startTransition(() => setView(step));
      await waitFrames(2);
    }
    startTransition(() => setView(restoreTo));
    await waitFrames(2);
    const elapsed = done({ restoredTo: restoreTo });
    recordPerf("stress", "pass1.navigation.avgStep", elapsed / (sequence.length + 1), {
      steps: sequence.length + 1,
    });
    return `Pass 1 complete: ${sequence.length} view hops in ${elapsed.toFixed(1)}ms.`;
  }

  async function runPerfPass2LibraryRefresh(): Promise<string> {
    if (!IN_TAURI) return "Pass 2 is desktop-only (requires local library scans).";
    const iterations = 6;
    let itemCount = 0;
    const done = startPerfTimer("stress", "pass2.library_refresh", { iterations });
    for (let i = 0; i < iterations; i++) {
      const items = await withPerfAsync("stress", "pass2.list_downloaded", () => listDownloaded(), {
        iteration: i + 1,
      });
      itemCount = items.length;
      await waitFrames(1);
    }
    const elapsed = done({ itemCount });
    return `Pass 2 complete: ${iterations} list_downloaded calls in ${elapsed.toFixed(1)}ms (items=${itemCount}).`;
  }

  async function runPerfPass3BackendScan(): Promise<string> {
    if (!IN_TAURI) return "Pass 3 is desktop-only (requires Rust scan benchmark).";
    const iterations = 4;
    const result = await withPerfAsync("backend", "pass3.scan_bench", () => perfBackendScanBench(iterations), {
      iterations,
    });
    recordPerf("backend", "pass3.scan_bench.avg", result.avgMs, {
      iterations: result.iterations,
      maxMs: result.maxMs,
      itemCount: result.itemCount,
    });
    return `Pass 3 complete: avg ${result.avgMs.toFixed(1)}ms (min ${result.minMs.toFixed(1)}ms / max ${result.maxMs.toFixed(1)}ms) over ${result.iterations} scans.`;
  }

  async function runPerfPass4MusicLoad(): Promise<string> {
    if (!isPerfEnabled()) return "Pass 4 requires performance tracing enabled.";
    const fromView = view;
    const restoreTo: AppView = fromView === "player" ? prevView : fromView;
    const startedAt = Date.now();
    const done = startPerfTimer("stress", "pass4.music_load_profile", {
      from: fromView,
      restoreTo,
    });

    startTransition(() => {
      setView("discover");
      setMusicTab("browse");
    });
    await waitFrames(2);

    startTransition(() => {
      setView("music");
      setMusicTab("browse");
    });

    let snapshotFound = false;
    for (let i = 0; i < 240; i++) {
      const found = getPerfEvents().some(
        (e) => e.scope === "music" && e.name === "music.view.snapshot" && e.at >= startedAt,
      );
      if (found) {
        snapshotFound = true;
        break;
      }
      await waitFrames(1);
    }

    const elapsed = done({ snapshotFound });
    const recent = getPerfEvents().filter((e) => e.at >= startedAt);
    const latest = (name: string) => recent.find((e) => e.scope === "music" && e.name === name);
    const prep = latest("music.prepare_data")?.durationMs;
    const parse = latest("music.prepare.parse")?.durationMs;
    const groupAlbums = latest("music.prepare.group_albums")?.durationMs;
    const groupArtists = latest("music.prepare.group_artists")?.durationMs;
    const sort = latest("music.prepare.sort")?.durationMs;
    const index = latest("music.prepare.index_maps")?.durationMs;
    const mountCommit = latest("music.mount.commit")?.durationMs;
    const dataReady = latest("music.mount.data_ready")?.durationMs;

    recordPerf("stress", "pass4.music_load.breakdown", elapsed, {
      prepareMs: prep ?? null,
      parseMs: parse ?? null,
      groupAlbumsMs: groupAlbums ?? null,
      groupArtistsMs: groupArtists ?? null,
      sortMs: sort ?? null,
      indexMs: index ?? null,
      mountCommitMs: mountCommit ?? null,
      dataReadyMs: dataReady ?? null,
      snapshotFound,
    });

    startTransition(() => setView(restoreTo));
    await waitFrames(2);

    const fmt = (v?: number) => (typeof v === "number" ? `${v.toFixed(1)}ms` : "n/a");
    return `Pass 4 complete: music load ${elapsed.toFixed(1)}ms · prepare ${fmt(prep)} (parse ${fmt(parse)}, albums ${fmt(groupAlbums)}, artists ${fmt(groupArtists)}, sort ${fmt(sort)}, index ${fmt(index)}) · mount ${fmt(mountCommit)} · data-ready ${fmt(dataReady)}.`;
  }

  async function runPerfPass5HeavyViews(): Promise<string> {
    if (!isPerfEnabled()) return "Pass 5 requires performance tracing enabled.";
    const fromView = view;
    const fromMusicTab = musicTab;
    const restoreTo: AppView = fromView === "player" ? prevView : fromView;
    const steps: Array<{ key: string; view: AppView; musicTab?: MusicTab }> = [
      { key: "discover", view: "discover" },
      { key: "library", view: "library" },
      { key: "movies", view: "movies" },
      { key: "tvshows", view: "tvshows" },
      { key: "music:browse", view: "music", musicTab: "browse" },
      { key: "music:playlists", view: "music", musicTab: "playlists" },
      ...(!IS_IOS && IN_TAURI ? [{ key: "music:sync", view: "music" as AppView, musicTab: "sync" as MusicTab }] : []),
      { key: "books", view: "books" },
      { key: "games", view: "games" },
      { key: "anime", view: "anime" },
      { key: "downloads", view: "downloads" },
    ];

    const done = startPerfTimer("stress", "pass5.heavy_views", {
      steps: steps.length,
      from: fromView,
      restoreTo,
    });
    const results: Array<{ key: string; ms: number; readyFound: boolean }> = [];

    const waitForReady = async (key: string, afterAt: number, timeoutMs = 12000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        const ev = getPerfEvents().find(
          (e) => e.scope === "render" && e.name === "view.ready" && e.at >= afterAt && e.meta.view === key,
        );
        if (ev) return ev;
        await waitMs(16);
      }
      return null;
    };

    for (const step of steps) {
      const stepTimer = startPerfTimer("stress", "pass5.heavy_step", {
        view: step.key,
      });
      const startedAt = Date.now();
      startTransition(() => {
        setView(step.view);
        if (step.view === "music") setMusicTab(step.musicTab ?? "browse");
      });
      const readyEvent = await waitForReady(step.key, startedAt);
      const waitedMs = readyEvent ? Math.max(0, readyEvent.at - startedAt) : null;
      const totalMs = stepTimer({
        view: step.key,
        readyFound: !!readyEvent,
        readyMs: readyEvent?.durationMs ?? null,
        waitedMs,
      });
      const ms = typeof waitedMs === "number" ? waitedMs : totalMs;
      results.push({ key: step.key, ms, readyFound: !!readyEvent });
    }

    startTransition(() => {
      setView(restoreTo);
      setMusicTab(fromMusicTab);
    });
    await waitFrames(2);

    const totalMs = done({
      steps: steps.length,
      avgMs: results.length ? results.reduce((sum, r) => sum + r.ms, 0) / results.length : 0,
      readyFound: results.filter((r) => r.readyFound).length,
    });

    const avgMs = results.length ? results.reduce((sum, r) => sum + r.ms, 0) / results.length : 0;
    const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 4);
    const startupEvents = getPerfEvents();
    const splashWait = startupEvents.find((e) => e.scope === "startup" && e.name === "boot.splash_wait")?.durationMs;
    const bootstrap = startupEvents.find((e) => e.scope === "startup" && e.name === "app.bootstrap")?.durationMs;
    const firstUsable = startupEvents.find((e) => e.scope === "startup" && e.name === "startup.first_usable")?.durationMs;

    const slowSummary = slowest.map((s) => `${s.key} ${fmtPerfMs(s.ms)}`).join(" · ");
    return `Pass 5 complete: ${steps.length} heavy views in ${fmtPerfMs(totalMs)} (avg ${fmtPerfMs(avgMs)}). Slowest: ${slowSummary || "n/a"}. Startup: splash ${fmtPerfMs(splashWait)}, bootstrap ${fmtPerfMs(bootstrap)}, first-usable ${fmtPerfMs(firstUsable)}.`;
  }

  // ---- ⌘K command palette: every navigation + the common global actions, fuzzy-searchable.
  // Rebuilt each render so each command's closure sees live state (e.g. companionMode). Cheap:
  // the palette only filters this ~30-item list, and only while it's open.
  const desktop = IN_TAURI && !IS_IOS;
  const goTo: Command[] = [
    { id: "go-library", group: "Go to", label: "Library", icon: iconLibrary, keywords: "home all", run: () => navigate("library") },
    { id: "go-discover", group: "Go to", label: "Discover", icon: iconSearch, keywords: "search browse find", run: () => navigate("discover") },
    { id: "go-music", group: "Go to", label: "Music", icon: iconMusic, keywords: "songs albums artists", run: () => navigate("music") },
    { id: "go-tvshows", group: "Go to", label: "TV Shows", icon: iconTv, keywords: "series episodes", run: () => navigate("tvshows") },
    { id: "go-anime", group: "Go to", label: "Anime", icon: iconAnime, run: () => navigate("anime") },
    { id: "go-movies", group: "Go to", label: "Movies", icon: iconMovies, keywords: "films", run: () => navigate("movies") },
    { id: "go-books", group: "Go to", label: "Books", icon: iconBook, keywords: "ebooks reading", run: () => navigate("books") },
    { id: "go-games", group: "Go to", label: "Games", icon: iconGames, run: () => navigate("games") },
    { id: "go-social", group: "Go to", label: "Friends", icon: iconUsers, keywords: "social shares", run: () => navigate("social") },
    { id: "go-watch-later", group: "Go to", label: "Watch Later", icon: iconClock, keywords: "queue saved later watchlist", run: () => navigate("watch-later") },
    { id: "go-downloads", group: "Go to", label: "Downloads", icon: iconDownloads, keywords: "transfers queue", run: () => navigate("downloads") },
    { id: "go-settings", group: "Go to", label: "Settings", icon: iconSettings, keywords: "preferences options", run: () => navigate("settings") },
  ];
  const settingsCmds: Command[] = SETTINGS_TABS
    .filter((t) => desktop || !("desktopOnly" in t && t.desktopOnly))
    .map((t) => ({
      id: `set-${t.id}`,
      group: "Settings",
      label: `Settings: ${t.label}`,
      icon: t.icon,
      keywords: "preferences",
      run: () => { setSettingsTab(t.id); navigate("settings"); },
    }));
  const actionCmds: Command[] = [
    { id: "act-refresh", group: "Actions", label: "Refresh library", icon: iconRefresh, keywords: "reload rescan", run: () => refreshLibrary() },
    { id: "act-sidebar", group: "Actions", label: "Toggle sidebar", icon: iconSidebar, keywords: "hide show collapse panel", run: () => setSidebarCollapsed((v) => !v) },
    { id: "act-clear-recents", group: "Actions", label: "Clear recent searches", icon: iconHistory, keywords: "history", run: () => clearRecents() },
    ...(desktop ? [
      { id: "act-organize", group: "Actions", label: "Organize library", icon: iconOrganize, keywords: "sort tidy folders clean", run: () => { void startOrganize(); } },
      { id: "act-share", group: "Actions", label: "Create a torrent to share", icon: iconShare, keywords: "seed upload file", run: () => setShareDialogOpen(true) },
      { id: "act-reveal-music", group: "Actions", label: "Open music folder", icon: iconFolder, keywords: "finder reveal files", run: () => { void revealPath("Music"); } },
      { id: "act-pause-all", group: "Actions", label: "Pause all transfers", icon: iconPause, keywords: "stop downloads", run: () => { void networkPauseAll(); } },
      { id: "act-resume-all", group: "Actions", label: "Resume all transfers", icon: iconPlay, keywords: "continue downloads", run: () => { void networkResumeAll(); } },
    ] as Command[] : []),
  ];
  const paletteCommands: Command[] = [...goTo, ...settingsCmds, ...actionCmds];
  const buildPaletteDynamic = (q: string): { top?: Command[]; bottom?: Command[] } => {
    if (!q) return {};
    if (MAGNET_RE.test(q)) {
      return { top: [{ id: "dyn-magnet", group: "Use", label: "Add magnet link", hint: "Download", icon: iconMagnet, run: () => { void addMagnet(q); } }] };
    }
    const short = q.length > 40 ? `${q.slice(0, 40)}…` : q;
    const top: Command[] = [];
    if (HTTP_URL_RE.test(q) && /spotify\.com/i.test(q)) {
      top.push({ id: "dyn-import", group: "Use", label: `Import “${short}”`, hint: "Music", icon: iconLink, run: () => { void importMusicLink(q); } });
    }
    const bottom: Command[] = [
      { id: "dyn-search", group: "Use", label: `Search for “${short}”`, hint: "Discover", icon: iconSearch, run: () => { void handleSearch(q); } },
    ];
    return { top, bottom };
  };

  // Shared once so the docked sidebar and the hover-peek flyout render identical content.
  const sidebarProps = {
    section: activeNav as NavId,
    genres: sectionGenres,
    sort: secSort,
    onSort: setSecSort,
    genre: secGenre,
    onGenre: setSecGenre,
    recents,
    popular: POPULAR,
    onPick: handleSearch,
    onClearRecents: clearRecents,
    settingsTab,
    onSettingsTab: setSettingsTab,
    musicPlaylistActiveId: musicTab === "playlists" ? openPlaylistId : null,
    onOpenMusicPlaylist: (id: string) => { setOpenPlaylistId(id); setMusicTab("playlists"); },
    musicPlaylistRefreshKey: playlistRefresh,
    onMusicPlaylistToast: setMusicToast,
  };

  return (
    <>
      <LibraryProvider>
      <SharesProvider value={shareControls}>
      <ContextMenuProvider>
      <ExtensionProvider onNavigate={navigate} onAddMagnet={addMagnet} onToast={(m) => setShareToast(m)} onSearch={handleSearch}>
      <ExtSearchBridge onReady={(fn) => { extSearchRef.current = fn; }} />
      <ExtMusicImporterBridge onChange={(imp) => { extMusicImporterRef.current = imp; }} />
      <ExtViewIdsBridge onChange={setExtViews} />
      <div className="app">
      {/* Corner halftone — dots drawn on a <canvas> (size-graded from the corner outward),
          which renders the large→small falloff reliably across engines (WKWebView flattened
          the old multi-layer CSS-mask version to uniform dots). */}
      <HalftoneCanvas className="app-halftone" maxR={3} minR={0.26} spacing={16} />
      {idle && <DvdScreensaver />}
      <TopBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => { setSidebarCollapsed((v) => !v); closeSidebarFlyout(); }}
        onToggleHoverEnter={sidebarFlyoutAvailable ? openSidebarFlyout : undefined}
        onToggleHoverLeave={sidebarFlyoutAvailable ? closeSidebarFlyoutSoon : undefined}
        organize={orgPhase === "idle" ? null : { phase: orgPhase, done: orgProgress.done, total: orgProgress.total, moved: orgResult?.moved ?? 0, changes: orgProgress.total }}
        onOrganizeClick={() => setOrgOpen((v) => !v)}
        onBack={goBack}
        onForward={goForward}
        canGoBack={navHist.index > 0}
        canGoForward={navHist.index < navHist.stack.length - 1}
      />
      {/* Hover-peek: while collapsed, hovering the topbar toggle floats the sidebar in a flyout. */}
      {sidebarFlyoutAvailable && sidebarFlyoutOpen && (
        <div
          className="sidebar-flyout"
          onMouseEnter={openSidebarFlyout}
          onMouseLeave={closeSidebarFlyoutSoon}
        >
          <Sidebar collapsed={false} {...sidebarProps} />
        </div>
      )}
      <div className={`app-body${hideSidebar ? " sidebar-collapsed" : ""}`}>
        <NavigationRail
          active={isVideoView(activeNav) ? "videos" : activeNav}
          onNavigate={navigate}
          downloadCount={downloads.filter((d) => d.progress < 0.999 && !d.id.startsWith("local:")).length}
          sourceCount={sources.length}
          onCreateShare={IN_TAURI && !IS_IOS ? () => setShareDialogOpen(true) : undefined}
          createActive={shareDialogOpen}
        />
        <Sidebar collapsed={hideSidebar} {...sidebarProps} />
        <main className="main">
          <div className="content">
            {view === "library" && <Library onPlayLocal={playLocal} posterFor={posterForTitle} onReady={markLibraryReady} />}
            {view === "social" && (
              <Social
                onGrab={(it) => { void grabShare(it); }}
                onReady={markSocialReady}
                myShares={shareControls.myShares}
                onStopSharing={shareControls.stopSharing}
                onShareFile={IN_TAURI && !IS_IOS ? () => setShareDialogOpen(true) : undefined}
              />
            )}
            {view === "discover" && (
              <Search
                query={searchQuery}
                results={searchView}
                loading={searching}
                error={searchError}
                recents={recents}
                popular={POPULAR}
                sections={sections}
                featured={featuredItems}
                onSearch={handleSearch}
                onAddMagnet={addMagnet}
                onClearRecents={clearRecents}
                onPlay={startStream}
                onQueue={downloadToLibrary}
                onSpotify={importMusicLink}
                onReady={markDiscoverReady}
              />
            )}
            {isVideoView(view) && (
              <div className="videos-tabbar">
                <VideoTabs value={view} onChange={(v) => navigate(v)} />
              </div>
            )}
            {activeSection === "tvshows" ? (
              <TvShows onPlayLocal={playLocal} onPlay={startStream} onAddToLibrary={downloadToLibrary} posterFor={posterForTitle} onReplacePoster={setReplaceTitle} onReady={markTvShowsReady} />
            ) : activeSection === "music" ? (
              <>
                {player.current && <NowPlayingHero onPopOut={IN_TAURI && !IS_IOS ? openVisualizerWindow : undefined} />}
                <SegmentedControl
                  className="music-tabbar"
                  options={[
                    { value: "browse", label: "Browse" },
                    { value: "playlists", label: "Playlists" },
                    ...(!IS_IOS && IN_TAURI ? [{ value: "sync", label: "Sync" }] : []),
                  ]}
                  value={musicTab}
                  onChange={(v) => setMusicTab(v as MusicTab)}
                />
                {musicTab === "playlists" ? (
                  <Playlists openId={openPlaylistId} onOpenId={setOpenPlaylistId} refreshKey={playlistRefresh} onChanged={() => setPlaylistRefresh((n) => n + 1)} onReady={markMusicPlaylistsReady} />
                ) : musicTab === "sync" && !IS_IOS && IN_TAURI ? (
                  <Sync onReady={markMusicSyncReady} />
                ) : (
                  <Music mode="browse" onPlayLocal={playLocal} onPlayAudioCollection={playAudioCollection} onReplacePoster={setReplaceTitle} onPlaylistsChanged={() => setPlaylistRefresh((n) => n + 1)} onImportLink={importMusicLink} onReady={markMusicBrowseReady} />
                )}
              </>
            ) : activeSection === "movies" ? (
              <Movies onPlayLocal={playLocal} posterFor={posterForTitle} onReplacePoster={setReplaceTitle} onReady={markMoviesReady} />
            ) : activeSection === "books" ? (
              <Books onOpenLocal={playLocal} posterFor={posterForTitle} onReady={markBooksReady} />
            ) : activeSection === "games" ? (
              <Games onOpenLocal={playLocal} posterFor={posterForTitle} onReady={markGamesReady} />
            ) : null}
            {view === "anime" && (
              <Anime
                onPlayLocal={playLocal}
                posterFor={posterForTitle}
                onReplacePoster={setReplaceTitle}
                onBrowse={handleSearch}
                sort={secSort}
                genre={secGenre}
                onReady={markAnimeReady}
              />
            )}
            {view === "youtube" && (
              <YouTubeVideos onPlayLocal={playLocal} onSummon={() => navigate("seance")} />
            )}
            {view === "settings" && settingsTab === "sources" && (
              <Sources
                sources={sources}
                refreshingId={refreshingId}
                status={refreshStatus}
                onAdd={handleAddSource}
                onRemove={handleRemoveSource}
                onRefresh={handleRefresh}
                onOpenBrowser={handleOpenBrowser}
                onImport={handleImportFromBrowser}
                onExportFile={handleExportSources}
                onImportFile={handleImportSources}
              />
            )}
            {view === "downloads" && (
              <Downloads
                downloads={companionMode ? remoteDownloads : downloads.filter((d) => !d.id.startsWith("local:"))}
                onOpen={companionMode ? openRemoteDownload : openPlayer}
                onRemove={removeDownload}
                onPause={handlePause}
                onReveal={handleReveal}
                onPlayLocal={playLocal}
                posterFor={posterForTitle}
                onReplacePoster={setReplaceTitle}
                onCleared={() => { refreshLibrary(); }}
                downloadConcurrency={downloadConcurrency}
                onChangeDownloadConcurrency={handleSetDownloadConcurrency}
                musicImports={musicImports}
                onRemoveImport={(id) => { removeMusicImport(id).then(listMusicImports).then(setMusicImports).catch(() => {}); }}
                onRetryImport={(id) => { retryMusicImport(id).catch(() => {}); }}
                onCancelImport={(id) => { cancelMusicImport(id).then(listMusicImports).then(setMusicImports).catch(() => {}); }}
                onRevealMusicFolder={() => { revealPath("Music").catch(() => {}); }}
                onReady={markDownloadsReady}
              />
            )}
            {view === "settings" && settingsTab === "export" && <Export />}
            {view === "settings" && settingsTab === "ai" && (
              <Automation
                onOrganize={startOrganize}
                onChanged={() => {
                  refreshLibrary();
                  refreshCatalog();
                }}
              />
            )}
            {view === "settings" && settingsTab !== "sources" && settingsTab !== "export" && settingsTab !== "ai" && (
              <Settings
                onCatalogChanged={refreshCatalog}
                tab={settingsTab}
                onRunPerfPass1={runPerfPass1Navigation}
                onRunPerfPass2={runPerfPass2LibraryRefresh}
                onRunPerfPass3={runPerfPass3BackendScan}
                onRunPerfPass4={runPerfPass4MusicLoad}
                onRunPerfPass5={runPerfPass5HeavyViews}
              />
            )}
            {view === "player" && activeItem && (
              <Player
                item={activeItem}
                id={activeId ?? ""}
                streamUrl={activeItem.url ?? activeStats?.streamUrl}
                stats={activeStats}
                info={media}
                onBack={() => setView(prevView)}
                onPlayEpisode={playEpisode}
                onPlayAnimeEpisode={playAnimeEpisode}
              />
            )}
            {view === "extensions" && <ExtensionsBrowse />}
            {view === "watch-later" && <WatchLater onAddMagnet={addMagnet} onNavigate={navigate} />}
            {/* Extension-contributed views render here when their id is the active view. */}
            <ExtensionView id={view} />
            <OrganizePanel
              open={orgOpen}
              phase={orgPhase}
              progress={orgProgress}
              steps={orgSteps}
              result={orgResult}
              error={orgError}
              onClose={() => setOrgOpen(false)}
            />
            <ReplacePoster
              title={replaceTitle}
              onClose={() => setReplaceTitle(null)}
              onDone={() => {
                refreshOverrides();
                refreshCatalog();
              }}
            />
            {/* App-level import toast — rendered globally so the "importing in the background"
                confirmation shows from Discover and ⌘K too, not only the Music tab. */}
            {musicToast && <div className="atp-toast" role="status">{musicToast}</div>}
          </div>
          {digestItem && (
            <div className="digest-overlay">
              <Digest
                item={digestItem}
                onBack={() => setDigestItem(null)}
                onStream={() => {
                  if (!digestItem) return;
                  const it = digestItem;
                  setDigestItem(null);
                  void streamNow(it, mediaKind(it.title, it.category));
                }}
                onDownload={() => {
                  if (!digestItem) return;
                  const it = digestItem;
                  setDigestItem(null);
                  void downloadToLibrary(it);
                }}
              />
            </div>
          )}
        </main>
      </div>
      {!(activeSection === "music" && player.current) && <NowPlayingBar />}
    </div>
      <UpdateBanner />
      {companionMode && linkedMac && (
        <SyncStatusCard device={linkedMac} downloads={remoteDownloads} onSyncNow={pullSnapshot} />
      )}
      {vpnDropped && (
        <VpnKillSwitch
          vpnInterface={vpnDropped.interface}
          onResume={() => setVpnDropped(null)}
        />
      )}
      <CreateTorrentDialog open={shareDialogOpen} onClose={() => setShareDialogOpen(false)} />
      <CommandPaletteHost commands={paletteCommands} baseDynamic={buildPaletteDynamic} onPlayLocal={playLocal} isMac={IS_MAC} />
      {shareToast && <div className="share-toast" role="status">{shareToast}</div>}
      </ExtensionProvider>
      </ContextMenuProvider>
      </SharesProvider>
      </LibraryProvider>
    </>
  );
}

function upsert(list: DownloadStats[], next: DownloadStats): DownloadStats[] {
  const i = list.findIndex((x) => x.id === next.id);
  if (i === -1) return [next, ...list];
  const copy = [...list];
  copy[i] = { ...copy[i], ...next };
  return copy;
}

function baseStats(id: string, title: string): DownloadStats {
  return { id, title, state: "connecting", progress: 0, downSpeed: 0, upSpeed: 0, peers: 0 };
}
