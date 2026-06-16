import { useEffect, useMemo, useRef, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { NavigationRail, type NavId } from "./components/NavigationRail";
import { TopBar } from "./components/TopBar";
import { Sources } from "./views/Sources";
import { Downloads } from "./views/Downloads";
import { Player, type PlayerItem } from "./views/Player";
import { Settings } from "./views/Settings";
import { Search } from "./views/Search";
import { TvShows } from "./views/TvShows";
import { Music } from "./views/Music";
import { Movies } from "./views/Movies";
import { Anime } from "./views/Anime";
import { Library } from "./views/Library";
import { LibraryProvider } from "./ipc/libraryCache";
import { ReplacePoster } from "./components/ReplacePoster";
import { Export } from "./views/Export";
import { Automation } from "./views/Automation";
import { SpotifyReplicate } from "./components/SpotifyReplicate";
import { NowPlayingBar } from "./components/NowPlayingBar";
import { UpdateBanner } from "./components/UpdateBanner";
import { usePlayer, type PlayerTrack } from "./ipc/player";
import { OrganizePanel, type OrganizePhase } from "./components/OrganizePanel";
import { organizeRun, onOrganizeProgress, type OrganizeResult, type OrganizeStep } from "./ipc/organize";
import { MOCK_CATALOG, MOCK_SOURCES } from "./lib/catalog";
import { mediaKind, sectionOf, genresOf, type MediaSectionId, type SectionSort } from "./lib/media";
import type { CatalogItem, DownloadStats, MediaInfo, Source, SourceKind } from "./lib/types";
import { IN_TAURI, addTorrent, getStreamUrl, mediaInfo, onDownloads, pauseDownload, removeTorrent, revealDownload } from "./ipc/engine";
import {
  addSource,
  aiScan,
  aiStatus,
  cleanTitles,
  fetchPosters,
  getSetting,
  importFromBrowser,
  listCatalog,
  listDownloaded,
  listLibrary,
  listPosterOverrides,
  listSources,
  mergeCatalog,
  openBrowser,
  refreshSource,
  removeSource,
  searchSources,
  type AiStatus,
  type DownloadedItem,
  type LibraryItem,
} from "./ipc/library";

type AppView = NavId | "player";

const RECENTS_KEY = "ghosty.recents";
// Preset launch points + trending terms shown on the Discover home.
const POPULAR = [
  "1080p", "4K", "Documentary", "Sci-Fi", "Soundtrack",
  "FLAC", "Blender", "Public Domain", "Anime", "Concert",
];
// The rail ids that map to a browsable content section.
const MEDIA_SECTIONS: MediaSectionId[] = ["movies", "tvshows", "music"];

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

// Browser-preview-only sample (no Rust engine). Replaced by real librqbit streams in Tauri.
const SAMPLE_VIDEO =
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/**
 * The engine pushes a snapshot ~1×/sec. When nothing is actively transferring or
 * seeding, successive snapshots are identical — but a fresh array reference would still
 * re-render the whole tree every second. Bail to the previous array when nothing that
 * matters changed, so an idle app isn't constantly re-rendering during navigation.
 */
function sameDownloads(a: DownloadStats[], b: DownloadStats[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
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

export default function App() {
  const [view, setView] = useState<AppView>("discover");
  const [prevView, setPrevView] = useState<NavId>("discover");
  const player = usePlayer();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CatalogItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>(loadRecents);

  // Spotify playlist replicator — lifted to App so it opens from the Music tab AND
  // from a Spotify link pasted into the main search.
  const [spotifyOpen, setSpotifyOpen] = useState(false);
  const [spotifyInitial, setSpotifyInitial] = useState("");
  function openReplicate(url?: string) {
    setSpotifyInitial(url ?? "");
    setSpotifyOpen(true);
  }

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
      const r = await organizeRun();
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

  // --- shell chrome (Libre-style nav rail + collapsible contextual sidebar) ---
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [secSort, setSecSort] = useState<SectionSort>("popularity");
  const [secGenre, setSecGenre] = useState<string | null>(null);

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
  const [dbItems, setDbItems] = useState<CatalogItem[]>([]);
  const catalog = useMemo(() => mergeCatalog(MOCK_CATALOG, dbItems), [dbItems]);

  const [sources, setSources] = useState<Source[]>(MOCK_SOURCES);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);

  const [downloads, setDownloads] = useState<DownloadStats[]>([]);

  // --- Auto-cleanup: organize + enrich downloads as they finish (enabled by default) ---
  const dlProgressRef = useRef<Map<string, number>>(new Map());
  const cleanupTimerRef = useRef<number | null>(null);

  async function runAutoCleanup() {
    if (orgRunningRef.current) {
      scheduleCleanup(); // organize already running — retry once it's free
      return;
    }
    const setting = await getSetting("auto_cleanup").catch(() => null);
    if (setting === "false") return; // enabled by default when unset
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
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [aiInfo, setAiInfo] = useState<AiStatus | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<string | null>(null);

  function refreshLibrary() {
    if (IN_TAURI) listLibrary().then(setLibraryItems).catch(() => {});
  }

  // Real-time poster art: keyless-first (IMDb/iTunes) so covers appear without any
  // API key. Drains the missing-poster queue in batches, refreshing the grid after
  // each, and re-entrancy is guarded so search + load can both trigger it safely.
  const posterBusy = useRef(false);
  async function autoPosters() {
    if (!IN_TAURI || posterBusy.current) return;
    posterBusy.current = true;
    try {
      for (let batch = 0; batch < 12; batch++) {
        const r = await fetchPosters(60);
        if (r.found > 0) {
          const [items, lib] = await Promise.all([listCatalog(), listLibrary()]);
          setDbItems(items);
          setLibraryItems(lib);
        }
        if (r.remaining <= 0 || r.found === 0) break;
      }
    } catch {
      /* best-effort; ignore */
    } finally {
      posterBusy.current = false;
    }
  }

  // --- LLM title cleaning: messy release names → clean display titles, cached server-side
  // and overlaid by id wherever items render. Progressive + bounded so search stays snappy.
  const [cleanTitleMap, setCleanTitleMap] = useState<Map<string, string>>(new Map());
  const cleanTitleRef = useRef<Map<string, string>>(new Map());
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
        if (cleanTitleRef.current.size > before) setCleanTitleMap(new Map(cleanTitleRef.current));
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

  async function handleScan() {
    if (!IN_TAURI || scanning) return;
    setScanning(true);
    setScanStatus("Organizing your catalog with the local model…");
    try {
      const r = await aiScan(40);
      const via = r.aiUsed ? r.model ?? "AI" : "basic cleanup";
      setScanStatus(
        `Scanned ${r.organized} item${r.organized === 1 ? "" : "s"} via ${via} · ` +
          `${r.posters} poster${r.posters === 1 ? "" : "s"} matched` +
          (r.remaining > 0 ? ` · ${r.remaining} left` : "."),
      );
      refreshLibrary();
      refreshCatalog();
    } catch (e) {
      setScanStatus(String(e));
    } finally {
      setScanning(false);
    }
  }

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
    listPosterOverrides()
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
  function posterForTitle(title: string): string | undefined {
    const k = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!k) return undefined;
    const exact = posterByTitle.get(k);
    if (exact) return exact;
    for (const [key, url] of posterByTitle) if (key.startsWith(k) || k.startsWith(key)) return url;
    return undefined;
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
      movies: [], tvshows: [], music: [],
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
  async function searchInSection(q: string) {
    const query = q.trim();
    setSearchQuery(query);
    if (!query) {
      setSearchResults([]);
      return;
    }
    if (!IN_TAURI) {
      const ql = query.toLowerCase();
      setSearchResults(catalog.filter((i) => i.title.toLowerCase().includes(ql)));
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const items = await searchSources(query);
      setSearchResults(items);
      setDbItems((d) => mergeCatalog(d, items));
      autoPosters();
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setSearching(false);
    }
  }

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
      listSources().then(setSources).catch(() => {});
      listCatalog().then((items) => {
        setDbItems(items);
        if (items.some((it) => !it.poster)) autoPosters();
      }).catch(() => {});
      listLibrary().then(setLibraryItems).catch(() => {});
      aiStatus().then(setAiInfo).catch(() => {});
      refreshOverrides();
    }
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- streaming ---
  function openPlayer(id: string) {
    player.pause(); // don't let background music play under a video
    setActiveId(id);
    setPrevView((v) => (view === "player" ? v : (view as NavId)));
    setView("player");
  }

  async function startStream(item: CatalogItem) {
    const kind = mediaKind(item.title, item.category);
    // Software, disk images, books, archives… are files, not media — download
    // them, never open the player or the encoder.
    if (kind === "other") {
      startFileDownload(item);
      return;
    }
    // Streaming = ephemeral preview unless the user later downloads it explicitly.
    previews.current.add(item.id);
    setStreamItems((s) => ({
      ...s,
      [item.id]: { title: item.title, sizeBytes: item.sizeBytes, source: item.source, kind, poster: item.poster },
    }));
    openPlayer(item.id);
    if (!IN_TAURI) {
      setDownloads((d) => upsert(d, mockStats(item.id, item.title)));
      return;
    }
    try {
      await addTorrent(item.magnet);
      const url = await getStreamUrl(item.id);
      setDownloads((d) => upsert(d, { ...baseStats(item.id, item.title), streamUrl: url }));
    } catch (e) {
      console.error("startStream failed", e);
    }
  }

  /** Non-media item: queue the download and show it in Downloads — no player, no ffmpeg. */
  function startFileDownload(item: CatalogItem) {
    previews.current.delete(item.id); // an explicit download is kept, not a preview
    setDownloads((d) => upsert(d, IN_TAURI ? baseStats(item.id, item.title) : mockStats(item.id, item.title)));
    setView("downloads");
    if (IN_TAURI) addTorrent(item.magnet).catch((e) => console.error("download failed", e));
  }

  /** Queue a torrent for download WITHOUT opening the player — used by the series
   *  finder's "Add to library" so grabbing a season pack never streams episode 1.
   *  Stays on the current view; the download surfaces in Downloads (and the Library
   *  once it finishes). */
  function downloadToLibrary(item: CatalogItem) {
    previews.current.delete(item.id); // explicit download — keep it
    setDownloads((d) => upsert(d, IN_TAURI ? baseStats(item.id, item.title) : mockStats(item.id, item.title)));
    if (IN_TAURI) addTorrent(item.magnet).catch((e) => console.error("download failed", e));
  }

  /** Play a file already downloaded to disk (Library) — streamed from the loopback /file route. */
  function playLocal(item: DownloadedItem) {
    // Audio plays in the global player (persistent now-playing bar + visualizer),
    // not the full-screen video player. Build a library-wide queue so next/prev work.
    if (item.kind === "audio") {
      void playAudio(item);
      return;
    }
    const id = `local:${item.id}`;
    setStreamItems((s) => ({
      ...s,
      [id]: { title: item.title, kind: item.kind, poster: posterForTitle(item.title), url: item.url, relpath: item.id },
    }));
    setDownloads((d) =>
      upsert(d, { id, title: item.title, state: "ready", progress: 1, downSpeed: 0, upSpeed: 0, peers: 0, streamUrl: item.url }),
    );
    openPlayer(id);
  }

  /** Play a local audio file through the global player, queueing the whole music library. */
  async function playAudio(item: DownloadedItem) {
    const toTrack = (it: DownloadedItem): PlayerTrack => ({
      id: it.id,
      title: it.title,
      url: it.url,
      art: posterForTitle(it.title),
    });
    if (!IN_TAURI) {
      player.play([toTrack(item)], 0);
      return;
    }
    try {
      const all = await listDownloaded();
      const music = all.filter((i) => i.mediaType === "music").sort((a, b) => a.id.localeCompare(b.id));
      const queue = (music.length ? music : [item]).map(toTrack);
      const idx = Math.max(0, queue.findIndex((t) => t.id === item.id));
      player.play(queue, idx);
    } catch {
      player.play([toTrack(item)], 0);
    }
  }

  /** From the in-player episode browser: play a specific episode of a show. Prefers an
   *  already-downloaded copy (instant), otherwise finds the best source and streams it. */
  async function playEpisode(show: string, season: number, episode: number): Promise<boolean> {
    if (!IN_TAURI) return false;
    const w = show.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
          d.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === w,
      );
      if (local) {
        playLocal(local);
        return true;
      }
    } catch {
      /* fall through to a source search */
    }
    try {
      const se = `s${String(season).padStart(2, "0")}e${String(episode).padStart(2, "0")}`;
      const hits = await searchSources(`${show} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`);
      // Prefer a single-episode file (title contains SxxExx, separators ignored) over a
      // season pack — so playing one episode never streams episode 1 of a whole pack.
      const single = hits.find((h) => h.title.toLowerCase().replace(/[^a-z0-9]/g, "").includes(se));
      const pick = single ?? hits[0];
      if (pick) {
        void startStream(pick);
        return true;
      }
    } catch (e) {
      console.error("playEpisode failed", e);
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
    try {
      const id = await addTorrent(magnet);
      setStreamItems((s) => ({ ...s, [id]: { title: "Pasted magnet", source: "magnet link" } }));
      openPlayer(id);
      const url = await getStreamUrl(id);
      setDownloads((d) => upsert(d, { ...baseStats(id, "Pasted magnet"), streamUrl: url }));
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
      const items = await searchSources(query);
      setSearchResults(items);
      setDbItems((d) => mergeCatalog(d, items));
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

  function handleReveal(id: string) {
    if (IN_TAURI) revealDownload(id).catch(() => {});
  }

  function refreshCatalog() {
    if (IN_TAURI) listCatalog().then(setDbItems).catch(() => {});
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
  const activeNav: NavId = view === "player" ? prevView : (view as NavId);
  // The content section to render (null while the player is open or on a non-section view).
  const activeSection = (MEDIA_SECTIONS as string[]).includes(view) ? (view as MediaSectionId) : null;
  // The section whose filters the sidebar shows (sticks to the origin section in the player).
  const navSection = (MEDIA_SECTIONS as string[]).includes(activeNav) ? (activeNav as MediaSectionId) : null;
  const sectionGenres = navSection ? genresOf(sections[navSection]) : [];
  const sectionItems = useMemo(() => {
    if (!activeSection) return [];
    const all = sections[activeSection];
    if (!secGenre) return all;
    return all.filter((it) =>
      (it.genre ?? "").split(/[,/]/).map((s) => s.trim()).some((g) => g === secGenre),
    );
  }, [activeSection, sections, secGenre]);

  function navigate(id: NavId) {
    setSecGenre(null); // reset the section filter when switching sections
    setView(id);
  }

  return (
    <>
      <LibraryProvider>
      <div className="app">
      <TopBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        organize={orgPhase === "idle" ? null : { phase: orgPhase, done: orgProgress.done, total: orgProgress.total, moved: orgResult?.moved ?? 0, changes: orgProgress.total }}
        onOrganizeClick={() => setOrgOpen((v) => !v)}
      />
      <div className={`app-body${sidebarCollapsed || activeNav === "library" || activeNav === "anime" ? " sidebar-collapsed" : ""}`}>
        <NavigationRail
          active={activeNav}
          onNavigate={navigate}
          downloadCount={downloads.filter((d) => d.progress < 0.999 && !d.id.startsWith("local:")).length}
          sourceCount={sources.length}
        />
        <Sidebar
          collapsed={sidebarCollapsed || activeNav === "library" || activeNav === "anime"}
          section={activeNav}
          genres={sectionGenres}
          sort={secSort}
          onSort={setSecSort}
          genre={secGenre}
          onGenre={setSecGenre}
          recents={recents}
          popular={POPULAR}
          onPick={handleSearch}
          onClearRecents={clearRecents}
        />
        <main className="main">
          <div className="content">
            {view === "library" && <Library onPlayLocal={playLocal} posterFor={posterForTitle} onReplacePoster={setReplaceTitle} onOrganize={startOrganize} />}
            {view === "discover" && (
              <Search
                query={searchQuery}
                results={searchView}
                loading={searching}
                error={searchError}
                recents={recents}
                popular={POPULAR}
                sections={sections}
                onSearch={handleSearch}
                onAddMagnet={addMagnet}
                onClearRecents={clearRecents}
                onPlay={startStream}
                onQueue={downloadToLibrary}
                onSpotify={openReplicate}
              />
            )}
            {activeSection === "tvshows" ? (
              <TvShows onPlayLocal={playLocal} onPlay={startStream} onAddToLibrary={downloadToLibrary} posterFor={posterForTitle} onReplacePoster={setReplaceTitle} />
            ) : activeSection === "music" ? (
              <Music onPlayLocal={playLocal} onReplacePoster={setReplaceTitle} />
            ) : activeSection === "movies" ? (
              <Movies onPlayLocal={playLocal} posterFor={posterForTitle} onReplacePoster={setReplaceTitle} />
            ) : null}
            {view === "anime" && (
              <Anime onPlayLocal={playLocal} posterFor={posterForTitle} onReplacePoster={setReplaceTitle} onBrowse={handleSearch} />
            )}
            {view === "sources" && (
              <Sources
                sources={sources}
                refreshingId={refreshingId}
                status={refreshStatus}
                onAdd={handleAddSource}
                onRemove={handleRemoveSource}
                onRefresh={handleRefresh}
                onOpenBrowser={handleOpenBrowser}
                onImport={handleImportFromBrowser}
              />
            )}
            {view === "downloads" && (
              <Downloads
                downloads={downloads.filter((d) => !d.id.startsWith("local:"))}
                onOpen={openPlayer}
                onRemove={removeDownload}
                onPause={handlePause}
                onReveal={handleReveal}
                onPlayLocal={playLocal}
                posterFor={posterForTitle}
                onReplacePoster={setReplaceTitle}
                onCleared={() => { refreshLibrary(); }}
              />
            )}
            {view === "export" && <Export />}
            {view === "automation" && (
              <Automation
                onOrganize={startOrganize}
                onChanged={() => {
                  refreshLibrary();
                  refreshCatalog();
                }}
              />
            )}
            {view === "settings" && <Settings onCatalogChanged={refreshCatalog} />}
            {view === "player" && activeItem && (
              <Player
                item={activeItem}
                streamUrl={activeItem.url ?? activeStats?.streamUrl}
                stats={activeStats}
                info={media}
                onBack={() => setView(prevView)}
                onPlayEpisode={playEpisode}
              />
            )}
            <SpotifyReplicate
              open={spotifyOpen}
              initialPlaylist={spotifyInitial}
              onClose={() => setSpotifyOpen(false)}
              onPlay={startStream}
              onDownload={downloadToLibrary}
            />
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
          </div>
        </main>
      </div>
    </div>
      <NowPlayingBar />
      <UpdateBanner />
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
