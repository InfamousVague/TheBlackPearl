import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import { SegmentedControl } from "@mattmattmattmatt/base/primitives/segmented-control/SegmentedControl";
import { PosterRow } from "../components/PosterRow";
import { PosterArt } from "../components/PosterArt";
import { relayMusicUrl } from "../lib/relay";
import { PosterGridSkeleton } from "../components/Skeletons";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { AddToPlaylistMenu } from "../components/AddToPlaylistMenu";
import { IN_TAURI } from "../ipc/engine";
import { useCurrentTrack } from "../ipc/player";
import {
  musicSpotiFlacInstall,
  musicSpotiFlacDownload,
  onMusicSpotiFlacOutput,
  musicSpotiFlacStatus,
  removeFromLibrary,
  revealPath,
  trashDownloaded,
  isMusicImportLink,
  type DownloadedItem,
  type MusicSpotiFlacInstallResult,
  type MusicSpotiFlacOutput,
  type MusicSpotiFlacStatus,
} from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { useShareControls } from "../ipc/shares";
import { findLiked, listPlaylists, setDragTracks, spotifyToPlaylist, toggleLiked, trackKey, type PlaylistTrack } from "../ipc/playlists";
import { spotifyAlbumPreview, spotifyArtistTopTracksPreview, spotifyPlaylistPreview, type SpotifyTrack } from "../ipc/spotify";
import { hueFromString } from "../lib/catalog";
import { formatBytes } from "../lib/format";
import { arrowDownUp, chevronLeft, circlePlay, disc3, download, folderOpen, heart, history, images, library, link2, listMusic, micVocal, music, rotateCw, search, shuffle, sparkles, trash2, triangleAlert, upload } from "../lib/icons";
import { useInfiniteScroll } from "../lib/useInfiniteScroll";
import { IS_IOS } from "../lib/platform";
import { recordPerf, startPerfTimer, withPerfSync } from "../lib/perf";
import "./Music.css";

interface PlayAudioCollectionOptions {
  startId?: string;
  shuffle?: boolean;
}

interface MusicProps {
  /** Play a local audio file (single track). */
  onPlayLocal: (item: DownloadedItem) => void;
  /** Play a full audio collection as a queue (global player). */
  onPlayAudioCollection?: (items: DownloadedItem[], opts?: PlayAudioCollectionOptions) => void | Promise<void>;
  /** Open the "replace poster" picker for an artist/album title. */
  onReplacePoster?: (title: string) => void;
  /** Notify the shell (→ playlists rail) that playlists changed. */
  onPlaylistsChanged?: () => void;
  /** Browse = local library UI, import = downloader/import queue UI. */
  mode?: "browse" | "import";
  /** Paste a music link into the browse search bar to enqueue a background import. */
  onImportLink?: (url: string) => void;
  /** Signals when the view is first usable for perf timing. */
  onReady?: (meta?: Record<string, string | number | boolean | null>) => void;
}

interface ParsedTrack {
  item: DownloadedItem;
  artist: string;
  album: string;
  genre: string | null;
  track: string;
  trackNo: number;
  artworkUrl: string | null;
}

interface AlbumGroup {
  key: string;
  album: string;
  artist: string;
  genre: string | null;
  tracks: ParsedTrack[];
  artworkUrl: string | null;
  addedAt: number;
}

interface ArtistGroup {
  name: string;
  genre: string | null;
  albums: AlbumGroup[];
  trackCount: number;
  artworkUrl: string | null;
  addedAt: number;
}

interface GenreGroup {
  name: string;
  albums: AlbumGroup[];
  artistCount: number;
  trackCount: number;
  addedAt: number;
}

/** Most-common non-empty genre among a set of tracks/albums. */
function majorityGenre(genres: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const g of genres) {
    if (!g) continue;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [g, n] of counts) if (n > bestN) {
    best = g;
    bestN = n;
  }
  return best;
}

interface SpotiFlacProgress {
  downloaded: number;
  total: number | null;
}

interface ImportQueueItem {
  id: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  imported: boolean;
}

const CONCURRENCY_CHOICES = [1, 2, 3, 4, 5, 6, 8] as const;

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 2;
  return Math.min(8, Math.max(1, Math.trunc(value)));
}

function parseSpotiFlacProgress(log: string[], busy: boolean, failed: boolean): SpotiFlacProgress {
  let total: number | null = null;
  let downloaded = 0;
  let current = 0;
  const successLines = new Set<string>();

  for (const raw of log) {
    const line = raw.replace(/^\[err\]\s*/, "");
    const byIndex =
      line.match(/\btrack\s+(\d+)\s*(?:\/|of)\s*(\d+)\b/i) ??
      line.match(/\b(?:song|item)\s+(\d+)\s*(?:\/|of)\s*(\d+)\b/i) ??
      line.match(/\[(\d+)\s*\/\s*(\d+)\]/);
    if (byIndex) {
      const idx = parseInt(byIndex[1], 10);
      const count = parseInt(byIndex[2], 10);
      if (Number.isFinite(idx) && Number.isFinite(count) && count > 0) {
        current = Math.max(current, idx);
        total = Math.max(total ?? 0, count);
        if (/(downloaded|completed|finished|saved|success)/i.test(line)) {
          downloaded = Math.max(downloaded, idx);
        } else {
          downloaded = Math.max(downloaded, Math.max(0, idx - 1));
        }
      }
    }

    const totalOnly =
      line.match(/\bfound\s+(\d+)\s+track\(s\)\b/i) ??
      line.match(/\b(\d+)\s+tracks?\b/i) ??
      line.match(/\b(\d+)\s+track\(s\)\b/i);
    if (totalOnly && /(album|playlist|queue|found|processing|queued|analy)/i.test(line)) {
      const count = parseInt(totalOnly[1], 10);
      if (Number.isFinite(count) && count > 0) total = Math.max(total ?? 0, count);
    }

    if (/(downloaded|completed|finished|saved successfully)/i.test(line)) {
      successLines.add(line);
    }
  }

  downloaded = Math.max(downloaded, successLines.size);
  if (total != null) {
    if (!busy && !failed) downloaded = Math.max(downloaded, total);
    downloaded = Math.min(downloaded, total);
  }
  return { downloaded, total };
}

function spotifyClientTokenUnauthorized(detail: string): boolean {
  const d = detail.toLowerCase();
  if (d.includes("clienttoken.spotify.com") && d.includes("401")) return true;
  if (d.includes("spotify rejected spotiflac's client-token request")) return true;
  return d.includes("client-token request") && d.includes("401");
}

function youtubeSearchForTrack(title: string, artist: string): string {
  const q = [title.trim(), artist.trim()].filter(Boolean).join(" ");
  return `https://music.youtube.com/search?q=${encodeURIComponent(q)}`;
}

function normalizeSpotifyField(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function spotifyTrackKey(track: SpotifyTrack): string {
  const id = track.id?.trim().toLowerCase();
  if (id) return `id:${id}`;
  const isrc = track.isrc?.trim().toLowerCase();
  if (isrc) return `isrc:${isrc}`;
  const title = normalizeSpotifyField(track.name || "");
  const artist = normalizeSpotifyField(track.artist || "");
  return `meta:${title}::${artist}`;
}

function dedupeSpotifyTracks(tracks: SpotifyTrack[]): SpotifyTrack[] {
  const out: SpotifyTrack[] = [];
  const seen = new Set<string>();
  for (const track of tracks) {
    const key = spotifyTrackKey(track);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

function normalizedTrackName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isSpotifyCollectionLink(url: string, kind: "playlist" | "album" | "artist"): boolean {
  return url.includes(`open.spotify.com/${kind}/`) || url.includes(`spotify:${kind}:`);
}

/**
 * Build UI track data directly from backend metadata.
 * The backend already prefers embedded file tags (SpotiFLAC-enriched) and
 * falls back to scanner-derived values when tags are missing.
 */
function parseMusic(it: DownloadedItem): ParsedTrack {
  return {
    item: it,
    artist: it.artist?.trim() || "Unknown Artist",
    album: it.album?.trim() || "Singles",
    genre: it.genre?.trim() || null,
    track: it.title?.trim() || it.fileName.replace(/\.[^.]+$/, ""),
    trackNo: it.trackNo && it.trackNo > 0 ? it.trackNo : 0,
    artworkUrl: it.artworkUrl?.trim() || null,
  };
}

interface PreparedTrack {
  parsed: ParsedTrack;
  artistKey: string;
  albumKey: string;
  trackKey: string;
}

interface PreparedMusicData {
  artists: ArtistGroup[];
  allAlbums: AlbumGroup[];
  artistByKey: Map<string, ArtistGroup>;
  albumByKey: Map<string, AlbumGroup>;
}

interface LocalTrackHit {
  albumKey: string;
  track: ParsedTrack;
}

const EMPTY_PREPARED: PreparedMusicData = {
  artists: [],
  allAlbums: [],
  artistByKey: new Map(),
  albumByKey: new Map(),
};

const MAX_LOCAL_TRACK_HITS = 120;
const MAX_LOCAL_ARTIST_HITS = 240;
const MAX_LOCAL_ALBUM_HITS = 320;
const RECENT_TRACKS_KEY = "ghosty.music.recentTracks";
const RECENT_TRACKS_MAX = 80;
const IMPORT_QUEUE_INITIAL = 18;
const IMPORT_QUEUE_CHUNK = 24;
const CASCADE_STEP_MS = 75;

type BrowseSort = "smart" | "recent" | "az";
const BROWSE_SORTS: { value: BrowseSort; label: string }[] = [
  { value: "smart", label: "Smart" },
  { value: "recent", label: "Recent" },
  { value: "az", label: "A-Z" },
];

function loadRecentTrackIds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_TRACKS_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is string => typeof id === "string").slice(0, RECENT_TRACKS_MAX);
  } catch {
    return [];
  }
}

function saveRecentTrackIds(ids: string[]) {
  try {
    localStorage.setItem(RECENT_TRACKS_KEY, JSON.stringify(ids.slice(0, RECENT_TRACKS_MAX)));
  } catch {
    // best effort
  }
}

function prepareMusicData(items: DownloadedItem[]): PreparedMusicData {
  const doneParse = startPerfTimer("music", "music.prepare.parse", { tracks: items.length });
  const prepared: PreparedTrack[] = items.map((item) => {
    const parsed = parseMusic(item);
    const artistKey = normalizedTrackName(parsed.artist);
    const albumKey = normalizedTrackName(parsed.album);
    return {
      parsed,
      artistKey,
      albumKey,
      trackKey: `${parsed.trackNo}::${normalizedTrackName(parsed.track)}`,
    };
  });
  doneParse({ prepared: prepared.length });

  const doneAlbums = startPerfTimer("music", "music.prepare.group_albums", { prepared: prepared.length });
  const albumMap = new Map<string, AlbumGroup>();
  const albumTrackIndex = new Map<string, Map<string, number>>();
  for (const p of prepared) {
    const key = `${p.artistKey}|${p.albumKey}`;
    let g = albumMap.get(key);
    if (!g) {
      g = {
        key,
        album: p.parsed.album,
        artist: p.parsed.artist,
        genre: null,
        tracks: [],
        artworkUrl: p.parsed.artworkUrl,
        addedAt: 0,
      };
      albumMap.set(key, g);
      albumTrackIndex.set(key, new Map());
    }
    if (!g.artworkUrl && p.parsed.artworkUrl) g.artworkUrl = p.parsed.artworkUrl;

    const idxMap = albumTrackIndex.get(key)!;
    const dup = idxMap.get(p.trackKey);
    if (dup != null) {
      if (p.parsed.item.sizeBytes > g.tracks[dup].item.sizeBytes) g.tracks[dup] = p.parsed;
    } else {
      idxMap.set(p.trackKey, g.tracks.length);
      g.tracks.push(p.parsed);
    }
    g.addedAt = Math.max(g.addedAt, p.parsed.item.addedAt);
  }
  doneAlbums({ albums: albumMap.size });

  const doneArtists = startPerfTimer("music", "music.prepare.group_artists", { albums: albumMap.size });
  const artistMap = new Map<string, ArtistGroup>();
  for (const al of albumMap.values()) {
    al.tracks.sort((a, b) => a.trackNo - b.trackNo || a.track.localeCompare(b.track));
    al.genre = majorityGenre(al.tracks.map((t) => t.genre));
    const ak = normalizedTrackName(al.artist);
    let ar = artistMap.get(ak);
    if (!ar) {
      ar = { name: al.artist, genre: null, albums: [], trackCount: 0, artworkUrl: al.artworkUrl, addedAt: 0 };
      artistMap.set(ak, ar);
    }
    if (!ar.artworkUrl && al.artworkUrl) ar.artworkUrl = al.artworkUrl;
    ar.albums.push(al);
    ar.trackCount += al.tracks.length;
    ar.addedAt = Math.max(ar.addedAt, al.addedAt);
  }
  doneArtists({ artists: artistMap.size });

  const doneSort = startPerfTimer("music", "music.prepare.sort", { artists: artistMap.size });
  const artists = [...artistMap.values()];
  for (const ar of artists) {
    ar.albums.sort((a, b) => b.addedAt - a.addedAt);
    ar.genre = majorityGenre(ar.albums.map((a) => a.genre));
  }
  artists.sort((a, b) => a.name.localeCompare(b.name));
  doneSort({ artists: artists.length });

  const doneIndex = startPerfTimer("music", "music.prepare.index_maps", { artists: artists.length });
  const allAlbums = artists.flatMap((a) => a.albums);
  const artistByKey = new Map<string, ArtistGroup>();
  const albumByKey = new Map<string, AlbumGroup>();
  for (const ar of artists) {
    artistByKey.set(normalizedTrackName(ar.name), ar);
  }
  for (const al of allAlbums) {
    albumByKey.set(al.key, al);
  }
  doneIndex({ albums: allAlbums.length });

  return { artists, allAlbums, artistByKey, albumByKey };
}

export function Music({ onPlayLocal, onPlayAudioCollection, onReplacePoster, onPlaylistsChanged, mode = "browse", onImportLink, onReady }: MusicProps) {
  const currentTrack = useCurrentTrack();
  const { items: all, refresh } = useDownloaded();
  const [artistName, setArtistName] = useState<string | null>(null);
  const [albumKey, setAlbumKey] = useState<string | null>(null);
  const [genreName, setGenreName] = useState<string | null>(null);
  const [localQuery, setLocalQuery] = useState("");
  const [browseSort, setBrowseSort] = useState<BrowseSort>("smart");
  const [recentTrackIds, setRecentTrackIds] = useState<string[]>(loadRecentTrackIds);
  const [spotiStatus, setSpotiStatus] = useState<MusicSpotiFlacStatus | null>(null);
  const [downloadUrl, setDownloadUrl] = useState("");
  const downloadService = "youtube";
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadLog, setDownloadLog] = useState<string[]>([]);
  const [downloadDone, setDownloadDone] = useState(false);
  const [downloadCompletedFiles, setDownloadCompletedFiles] = useState<number | null>(null);
  const [downloadSessionBaseIds, setDownloadSessionBaseIds] = useState<string[] | null>(null);
  const [expectedTracks, setExpectedTracks] = useState<SpotifyTrack[] | null>(null);
  const [expectedPlaylistName, setExpectedPlaylistName] = useState<string | null>(null);
  const [prefetchBusy, setPrefetchBusy] = useState(false);
  const [downloadConcurrency, setDownloadConcurrency] = useState(2);
  const [activeDownloads, setActiveDownloads] = useState(0);
  // Authoritative count of tracks the import queue has actually finished downloading. Unlike
  // the log-parse / library-diff heuristics (which jitter as the rolling log window evicts
  // lines and the library cache revalidates), this only ever increments — one per completed
  // track — so the playlist progress can't cycle 1→2→1→2.
  const [queueCompleted, setQueueCompleted] = useState(0);
  // Highest "downloaded" value shown this import session; clamps the display so noisy sources
  // can never make the count regress mid-import.
  const downloadFloorRef = useRef(0);
  const downloadConcurrencyRef = useRef(2);
  const queuePumpRef = useRef<(() => void) | null>(null);
  const ctx = useContextMenu();
  const { shareItem } = useShareControls();
  const mountStartMsRef = useRef(typeof performance !== "undefined" ? performance.now() : Date.now());
  const mountCommitLoggedRef = useRef(false);
  const dataReadyLoggedRef = useRef(false);

  // "Add to playlist" flyout — opened from a context-menu item, anchored at the right-click.
  // The menu's onSelect carries no event, so we capture the last right-click position here.
  const menuPos = useRef({ x: 0, y: 0 });
  const [addToPl, setAddToPl] = useState<{ x: number; y: number; tracks: PlaylistTrack[] } | null>(null);
  const [atpMsg, setAtpMsg] = useState<string | null>(null);
  useEffect(() => {
    const onCtx = (e: globalThis.MouseEvent) => { menuPos.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener("contextmenu", onCtx, true);
    return () => window.removeEventListener("contextmenu", onCtx, true);
  }, []);
  useEffect(() => {
    if (!atpMsg) return;
    const id = window.setTimeout(() => setAtpMsg(null), 2600);
    return () => window.clearTimeout(id);
  }, [atpMsg]);

  /** Map music tracks → playlist tracks (the backend resolves the local file by title). */
  const toPlTracks = (items: ParsedTrack[]): PlaylistTrack[] =>
    items.map((p) => ({
      title: p.track || p.item.title,
      artist: p.artist || "",
      album: p.album || "",
      durationMs: 0,
    }));
  const openAddToPlaylist = (tracks: PlaylistTrack[]) =>
    setAddToPl({ x: menuPos.current.x, y: menuPos.current.y, tracks });

  // ---- Liked Songs (one-click heart) + drag-to-add ----
  const [likedKeys, setLikedKeys] = useState<Set<string>>(new Set());
  const reloadLiked = useCallback(() => {
    if (!IN_TAURI) return;
    listPlaylists()
      .then((all) => setLikedKeys(new Set((findLiked(all)?.tracks ?? []).map(trackKey))))
      .catch(() => {});
  }, []);
  useEffect(() => { reloadLiked(); }, [reloadLiked]);
  const trackIsLiked = (p: ParsedTrack) => likedKeys.has(trackKey({ title: p.track || p.item.title, artist: p.artist }));
  async function toggleLikeTrack(p: ParsedTrack) {
    const next = await toggleLiked(toPlTracks([p])[0]).catch(() => null);
    if (next === null) return;
    reloadLiked();
    onPlaylistsChanged?.();
  }
  /** Make a card/row draggable with its tracks as the DnD payload. */
  const dragProps = (tracks: PlaylistTrack[]) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => setDragTracks(e.dataTransfer, tracks),
  });

  // ---- multi-select (⌘/⌃/⇧-click rows) → make a playlist from the selection ----
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const clearSel = () => setSel(new Set());
  useEffect(() => { setSel(new Set()); }, [albumKey, artistName, genreName]);

  const playTrackCollection = useCallback(
    async (tracks: ParsedTrack[], opts?: PlayAudioCollectionOptions) => {
      if (tracks.length === 0) return;
      if (onPlayAudioCollection) {
        await Promise.resolve(onPlayAudioCollection(tracks.map((t) => t.item), opts));
        return;
      }
      if (opts?.startId) {
        const start = tracks.find((t) => t.item.id === opts.startId);
        if (start) {
          onPlayLocal(start.item);
          return;
        }
      }
      onPlayLocal(tracks[0].item);
    },
    [onPlayAudioCollection, onPlayLocal],
  );

  // Rendered alongside the context menu in every view branch (both portal to <body>).
  const playlistOverlay = (
    <>
      {addToPl && (
        <AddToPlaylistMenu
          x={addToPl.x}
          y={addToPl.y}
          tracks={addToPl.tracks}
          onClose={() => setAddToPl(null)}
          onAdded={(m) => { setAtpMsg(m); onPlaylistsChanged?.(); }}
        />
      )}
      {atpMsg && <div className="atp-toast" role="status">{atpMsg}</div>}
    </>
  );

  useEffect(() => {
    downloadConcurrencyRef.current = downloadConcurrency;
    queuePumpRef.current?.();
  }, [downloadConcurrency]);

  // Shared cache provider already revalidates on mount and file-change events.
  useEffect(() => {
    if (!IN_TAURI) return;
    musicSpotiFlacStatus().then(setSpotiStatus).catch(() => {});
  }, []);
  useEffect(() => {
    if (!IN_TAURI) return;
    const p = onMusicSpotiFlacOutput((evt: MusicSpotiFlacOutput) => {
      if (typeof evt.completedFiles === "number") {
        setDownloadCompletedFiles((cur) => Math.max(cur ?? 0, evt.completedFiles ?? 0));
      }
      if (!evt.line.trim()) return;
      const prefix = evt.stream === "stderr" ? "[err] " : evt.stream === "meta" ? "" : "";
      setDownloadLog((cur) => {
        const next = [...cur, `${prefix}${evt.line}`];
        return next.length > 240 ? next.slice(next.length - 240) : next;
      });
    });
    return () => {
      void p.then((unlisten) => unlisten());
    };
  }, []);
  const loading = all === null;
  const items = useMemo(() => (all ?? []).filter((i) => i.mediaType === "music" && i.inLibrary), [all]);
  const parsedProgress = useMemo(
    () => parseSpotiFlacProgress(downloadLog, downloadBusy, Boolean(downloadError)),
    [downloadLog, downloadBusy, downloadError],
  );

  const importedSinceStart = useMemo(() => {
    if (!downloadSessionBaseIds) return [] as DownloadedItem[];
    const baseline = new Set(downloadSessionBaseIds);
    return items.filter((i) => !baseline.has(i.id));
  }, [downloadSessionBaseIds, items]);

  const expectedTotal = expectedTracks?.length ?? null;
  const importedTrackCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of importedSinceStart) {
      const p = parseMusic(it);
      const key = `${p.track.toLowerCase()}::${p.artist.toLowerCase()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [importedSinceStart]);

  const importQueue = useMemo(() => {
    if (!expectedTracks || expectedTracks.length === 0) return [] as ImportQueueItem[];
    const remaining = new Map(importedTrackCounts);
    return expectedTracks.map((track, idx) => {
      const key = `${track.name.trim().toLowerCase()}::${(track.artist || "").trim().toLowerCase()}`;
      const matched = remaining.get(key) ?? 0;
      const imported = matched > 0;
      if (imported) remaining.set(key, matched - 1);
      return {
        id: `${track.id ?? "track"}-${idx}`,
        title: track.name || "Unknown Track",
        artist: track.artist || "Unknown Artist",
        album: track.album || "",
        artworkUrl: track.albumArt,
        imported,
      };
    });
  }, [expectedTracks, importedTrackCounts]);

  const importedCount = useMemo(() => {
    if (importQueue.length > 0) return importQueue.filter((item) => item.imported).length;
    return importedSinceStart.length;
  }, [importQueue, importedSinceStart]);

  const downloadProgress = useMemo(
    () => {
      const raw = Math.max(
        downloadCompletedFiles ?? 0,
        importedCount,
        parsedProgress.downloaded,
        queueCompleted,
      );
      // Monotonic clamp: never let the displayed count drop below what we've already shown
      // this session (prevents the 1→2→1 flicker from the noisy log/library sources).
      const downloaded = Math.max(raw, downloadFloorRef.current);
      downloadFloorRef.current = downloaded;
      return {
        downloaded,
        total: expectedTotal ?? parsedProgress.total,
      };
    },
    [downloadCompletedFiles, importedCount, expectedTotal, parsedProgress, queueCompleted],
  );

  const downloadRemaining = useMemo(() => {
    if (downloadProgress.total == null) return null;
    return Math.max(0, downloadProgress.total - downloadProgress.downloaded);
  }, [downloadProgress.downloaded, downloadProgress.total]);

  const downloadPercent = useMemo(() => {
    if (downloadProgress.total == null || downloadProgress.total <= 0) return null;
    const pct = Math.round((downloadProgress.downloaded / downloadProgress.total) * 100);
    return Math.max(0, Math.min(100, pct));
  }, [downloadProgress.downloaded, downloadProgress.total]);

  const baselineIdSet = useMemo(() => new Set(downloadSessionBaseIds ?? []), [downloadSessionBaseIds]);

  const downloadingPreviews = useMemo(() => {
    if (!downloadBusy || !downloadSessionBaseIds) return [] as ParsedTrack[];
    return items
      .filter((i) => !baselineIdSet.has(i.id))
      .sort((a, b) => b.addedAt - a.addedAt)
      .map(parseMusic)
      .slice(0, 8);
  }, [downloadBusy, downloadSessionBaseIds, baselineIdSet, items]);

  const visibleQueue = useMemo(() => {
    if (importQueue.length > 0) return importQueue;
    return downloadingPreviews.map((p) => ({
      id: p.item.id,
      title: p.track,
      artist: p.artist,
      album: p.album,
      artworkUrl: p.artworkUrl,
      imported: true,
    })) as ImportQueueItem[];
  }, [importQueue, downloadingPreviews]);
  const [queueVisibleCount, setQueueVisibleCount] = useState(IMPORT_QUEUE_INITIAL);

  useEffect(() => {
    if (!(downloadBusy || prefetchBusy)) {
      setQueueVisibleCount(IMPORT_QUEUE_INITIAL);
      return;
    }
    const total = visibleQueue.length;
    if (total <= IMPORT_QUEUE_INITIAL) {
      setQueueVisibleCount(total);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    setQueueVisibleCount((cur) => Math.min(total, Math.max(cur, IMPORT_QUEUE_INITIAL)));
    const pump = () => {
      if (cancelled) return;
      setQueueVisibleCount((cur) => {
        const next = Math.min(total, cur + IMPORT_QUEUE_CHUNK);
        if (next < total && !cancelled) {
          timer = window.setTimeout(pump, CASCADE_STEP_MS);
        }
        return next;
      });
    };
    timer = window.setTimeout(pump, CASCADE_STEP_MS);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [downloadBusy, prefetchBusy, visibleQueue.length]);

  const visibleQueueSlice = useMemo(
    () => visibleQueue.slice(0, queueVisibleCount),
    [queueVisibleCount, visibleQueue],
  );

  const prepared = useMemo(
    () => {
      if (mode !== "browse") return EMPTY_PREPARED;
      return withPerfSync("music", "music.prepare_data", () => prepareMusicData(items), {
        tracks: items.length,
      });
    },
    [items, mode],
  );
  const artists = prepared.artists;
  const allAlbums = prepared.allAlbums;
  const allTracks = useMemo(() => allAlbums.flatMap((al) => al.tracks), [allAlbums]);
  const trackById = useMemo(() => {
    const map = new Map<string, ParsedTrack>();
    for (const t of allTracks) map.set(t.item.id, t);
    return map;
  }, [allTracks]);
  const likedTracks = useMemo(() => {
    const seen = new Set<string>();
    const out: ParsedTrack[] = [];
    for (const t of allTracks) {
      if (!trackIsLiked(t) || seen.has(t.item.id)) continue;
      seen.add(t.item.id);
      out.push(t);
    }
    return out;
  }, [allTracks, likedKeys]);
  const recentTracks = useMemo(() => {
    const out: ParsedTrack[] = [];
    for (const id of recentTrackIds) {
      const t = trackById.get(id);
      if (t) out.push(t);
    }
    return out;
  }, [recentTrackIds, trackById]);
  const currentTrackId = currentTrack?.id ?? null;
  useEffect(() => {
    if (!currentTrackId || !trackById.has(currentTrackId)) return;
    setRecentTrackIds((cur) => {
      const next = [currentTrackId, ...cur.filter((id) => id !== currentTrackId)].slice(0, RECENT_TRACKS_MAX);
      saveRecentTrackIds(next);
      return next;
    });
  }, [currentTrackId, trackById]);

  const normalizedLocalQuery = useMemo(() => normalizedTrackName(localQuery), [localQuery]);
  const hasLocalQuery = mode === "browse" && normalizedLocalQuery.length > 0;

  // ---- iTunes-style browse derivations ----
  const recentAlbums = useMemo(
    () => [...allAlbums].sort((a, b) => b.addedAt - a.addedAt).slice(0, 18),
    [allAlbums],
  );
  const artistsBrowse = useMemo(() => {
    const list = [...artists];
    if (browseSort === "recent") {
      return list.sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name));
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [artists, browseSort]);
  const albumsBrowse = useMemo(() => {
    const list = [...allAlbums];
    if (browseSort === "recent") {
      return list.sort((a, b) => b.addedAt - a.addedAt || a.album.localeCompare(b.album));
    }
    return list.sort((a, b) => a.album.localeCompare(b.album));
  }, [allAlbums, browseSort]);
  // The featured billboard: the most complete recent album reads best.
  const featured = useMemo(
    () => [...allAlbums].sort((a, b) => b.tracks.length - a.tracks.length || b.addedAt - a.addedAt)[0] ?? null,
    [allAlbums],
  );
  const genres = useMemo(() => {
    const m = new Map<string, GenreGroup & { artists: Set<string> }>();
    for (const al of allAlbums) {
      const name = al.genre || "Other";
      const lk = name.toLowerCase();
      let g = m.get(lk);
      if (!g) {
        g = { name, albums: [], artistCount: 0, trackCount: 0, addedAt: 0, artists: new Set() };
        m.set(lk, g);
      }
      g.albums.push(al);
      g.artists.add(al.artist.toLowerCase());
      g.trackCount += al.tracks.length;
      g.addedAt = Math.max(g.addedAt, al.addedAt);
    }
    return [...m.values()]
      .map((g) => ({ name: g.name, albums: g.albums, artistCount: g.artists.size, trackCount: g.trackCount, addedAt: g.addedAt }))
      .sort((a, b) => b.albums.length - a.albums.length || a.name.localeCompare(b.name));
  }, [allAlbums]);
  const browseSections = useMemo(
    () => [
      { key: "smart", enabled: likedTracks.length > 0 || recentTracks.length > 0 },
      { key: "recent", enabled: recentAlbums.length > 0 },
      { key: "artists", enabled: artistsBrowse.length > 0 },
      { key: "albums", enabled: albumsBrowse.length > 0 },
      { key: "genres", enabled: genres.length > 0 },
    ].filter((s) => s.enabled),
    [albumsBrowse.length, artistsBrowse.length, genres.length, likedTracks.length, recentAlbums.length, recentTracks.length],
  );
  const [browseVisibleSections, setBrowseVisibleSections] = useState(0);

  useEffect(() => {
    if (mode !== "browse" || loading || hasLocalQuery || artists.length === 0) {
      setBrowseVisibleSections(0);
      return;
    }
    const total = browseSections.length;
    if (total === 0) {
      setBrowseVisibleSections(0);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    setBrowseVisibleSections(1);
    const pump = () => {
      if (cancelled) return;
      setBrowseVisibleSections((cur) => {
        const next = Math.min(total, cur + 1);
        if (next < total && !cancelled) {
          timer = window.setTimeout(pump, CASCADE_STEP_MS);
        }
        return next;
      });
    };
    timer = window.setTimeout(pump, CASCADE_STEP_MS);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [artists.length, browseSections.length, hasLocalQuery, loading, mode]);

  const visibleBrowseSections = useMemo(
    () => new Set(browseSections.slice(0, browseVisibleSections).map((s) => s.key)),
    [browseSections, browseVisibleSections],
  );

  const localArtistResults = useMemo(() => {
    if (!hasLocalQuery) return [] as ArtistGroup[];
    return artists
      .filter((a) => normalizedTrackName(a.name).includes(normalizedLocalQuery))
      .slice(0, MAX_LOCAL_ARTIST_HITS);
  }, [artists, hasLocalQuery, normalizedLocalQuery]);

  const localAlbumResults = useMemo(() => {
    if (!hasLocalQuery) return [] as AlbumGroup[];
    return allAlbums
      .filter((al) => {
        const albumName = normalizedTrackName(al.album);
        const artistName = normalizedTrackName(al.artist);
        return albumName.includes(normalizedLocalQuery) || artistName.includes(normalizedLocalQuery);
      })
      .slice(0, MAX_LOCAL_ALBUM_HITS);
  }, [allAlbums, hasLocalQuery, normalizedLocalQuery]);

  const localTrackResults = useMemo(() => {
    if (!hasLocalQuery) {
      return { hits: [] as LocalTrackHit[], total: 0 };
    }
    const hits: LocalTrackHit[] = [];
    let total = 0;
    for (const al of allAlbums) {
      const albumHit = normalizedTrackName(al.album).includes(normalizedLocalQuery);
      const artistHit = normalizedTrackName(al.artist).includes(normalizedLocalQuery);
      for (const t of al.tracks) {
        const trackHit = normalizedTrackName(t.track).includes(normalizedLocalQuery);
        if (!(albumHit || artistHit || trackHit)) continue;
        total += 1;
        if (hits.length < MAX_LOCAL_TRACK_HITS) {
          hits.push({ albumKey: al.key, track: t });
        }
      }
    }
    return { hits, total };
  }, [allAlbums, hasLocalQuery, normalizedLocalQuery]);
  const {
    visible: visibleLocalTrackHits,
    sentinelRef: localTrackSentinelRef,
    hasMore: localTrackHasMore,
  } = useInfiniteScroll(localTrackResults.hits, 36);

  const artist = mode === "browse" && artistName ? prepared.artistByKey.get(normalizedTrackName(artistName)) ?? null : null;
  const album = mode === "browse" && albumKey ? prepared.albumByKey.get(albumKey) ?? null : null;
  const selectedGenre = mode === "browse" && genreName ? genres.find((g) => g.name.toLowerCase() === genreName.toLowerCase()) ?? null : null;
  const musicScreen = mode === "import" ? "import" : album ? "album" : artist ? "artist" : selectedGenre ? "genre" : hasLocalQuery ? "search" : "home";

  // Artists that have an album in the selected genre. Memoized + set-based: the old inline
  // `artists.filter(a => genre.albums.some(...))` was O(artists × albums) and recomputed on every
  // render while a genre was open (each download tick, hover, etc.).
  const genreArtists = useMemo(() => {
    if (!selectedGenre) return [] as typeof artists;
    const inGenre = new Set(selectedGenre.albums.map((al) => al.artist.toLowerCase()));
    return artists.filter((a) => inGenre.has(a.name.toLowerCase()));
  }, [selectedGenre, artists]);

  useEffect(() => {
    if (mountCommitLoggedRef.current) return;
    mountCommitLoggedRef.current = true;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    recordPerf("music", "music.mount.commit", Math.max(0, now - mountStartMsRef.current), {
      mode,
      tracks: items.length,
    });
  }, [items.length, mode]);

  useEffect(() => {
    if (dataReadyLoggedRef.current || all === null) return;
    dataReadyLoggedRef.current = true;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    recordPerf("music", "music.mount.data_ready", Math.max(0, now - mountStartMsRef.current), {
      mode,
      tracks: all.length,
    });
  }, [all, mode]);

  useEffect(() => {
    recordPerf("music", "music.view.snapshot", 0, {
      tracks: items.length,
      artists: artists.length,
      albums: allAlbums.length,
      screen: musicScreen,
      hasLocalQuery,
      mode,
    });
  }, [allAlbums.length, artists.length, hasLocalQuery, items.length, mode, musicScreen]);

  useEffect(() => {
    if (mode === "browse" && all === null) return;
    // Defer by one tick so App's view-enter marker is always armed before we emit ready.
    const id = window.setTimeout(() => {
      onReady?.({
        mode,
        screen: musicScreen,
        tracks: items.length,
        artists: artists.length,
        albums: allAlbums.length,
        hasLocalQuery,
        localTrackHits: hasLocalQuery ? localTrackResults.total : 0,
        loading: all === null,
      });
    }, 0);
    return () => window.clearTimeout(id);
  }, [all, allAlbums.length, artists.length, hasLocalQuery, items.length, localTrackResults.total, mode, musicScreen, onReady]);

  function trackActions(p: ParsedTrack): MenuAction[] {
    return [
      { label: "Play", icon: circlePlay, onSelect: () => onPlayLocal(p.item) },
      { label: "Add to playlist…", icon: listMusic, onSelect: () => openAddToPlaylist(toPlTracks([p])) },
      { label: "Share with network", icon: upload, divider: true, onSelect: () => shareItem({ id: p.item.id, title: p.track || p.item.title, local: true }) },
      { label: "Reveal in Finder", icon: folderOpen, divider: true, onSelect: () => void revealPath(p.item.id) },
      { label: "Remove from library", icon: library, divider: true, onSelect: () => void removeFromLibrary(p.item.id).then(() => refresh()) },
      { label: "Move to Trash", icon: trash2, danger: true, onSelect: () => void trashDownloaded(p.item.id).then(() => refresh()) },
    ];
  }

  // Manage a whole album (all its tracks) from a right-click on its cover.
  function albumActions(al: AlbumGroup): MenuAction[] {
    const ids = al.tracks.map((t) => t.item.id);
    const actions: MenuAction[] = [
      { label: "Play album", icon: circlePlay, onSelect: () => { void playTrackCollection(al.tracks); } },
      { label: "Shuffle album", icon: shuffle, onSelect: () => { void playTrackCollection(al.tracks, { shuffle: true }); } },
      { label: "Add album to playlist…", icon: listMusic, onSelect: () => openAddToPlaylist(toPlTracks(al.tracks)) },
      { label: "Share album with network", icon: upload, divider: true, onSelect: () => al.tracks.forEach((t) => shareItem({ id: t.item.id, title: t.track || t.item.title, local: true })) },
      { label: "Reveal in Finder", icon: folderOpen, divider: true, onSelect: () => void revealPath(ids[0]) },
    ];
    if (onReplacePoster) actions.push({ label: "Replace cover…", icon: images, onSelect: () => onReplacePoster(al.album) });
    actions.push(
      { label: "Remove album from library", icon: library, divider: true, onSelect: () => void Promise.all(ids.map((id) => removeFromLibrary(id))).then(() => refresh()) },
      { label: "Move album to Trash", icon: trash2, danger: true, onSelect: () => void Promise.all(ids.map((id) => trashDownloaded(id))).then(() => refresh()) },
    );
    return actions;
  }

  // Manage a whole artist (every track across their albums) from a right-click on the bubble.
  function artistActions(ar: ArtistGroup): MenuAction[] {
    const tracks = ar.albums.flatMap((al) => al.tracks);
    const ids = tracks.map((t) => t.item.id);
    const actions: MenuAction[] = [
      { label: "Play", icon: circlePlay, onSelect: () => { void playTrackCollection(tracks); } },
      { label: "Shuffle", icon: shuffle, onSelect: () => { void playTrackCollection(tracks, { shuffle: true }); } },
      { label: "Add to playlist…", icon: listMusic, onSelect: () => openAddToPlaylist(toPlTracks(tracks)) },
      { label: "Share with network", icon: upload, divider: true, onSelect: () => tracks.forEach((t) => shareItem({ id: t.item.id, title: t.track || t.item.title, local: true })) },
      { label: "Reveal in Finder", icon: folderOpen, divider: true, onSelect: () => void revealPath(ids[0]) },
    ];
    if (onReplacePoster) actions.push({ label: "Replace image…", icon: images, onSelect: () => onReplacePoster(ar.name) });
    actions.push(
      { label: `Remove artist from library`, icon: library, divider: true, onSelect: () => void Promise.all(ids.map((id) => removeFromLibrary(id))).then(() => refresh()) },
      { label: "Move artist to Trash", icon: trash2, danger: true, onSelect: () => void Promise.all(ids.map((id) => trashDownloaded(id))).then(() => refresh()) },
    );
    return actions;
  }

  function onDownloadConcurrencyChange(value: number) {
    const next = clampConcurrency(value);
    downloadConcurrencyRef.current = next;
    setDownloadConcurrency(next);
  }

  async function runQueuedSpotifyTracks(tracks: SpotifyTrack[]) {
    const uniqueTracks = dedupeSpotifyTracks(tracks);
    const skippedDuplicates = Math.max(0, tracks.length - uniqueTracks.length);
    const entries = uniqueTracks
      .map((track, idx) => ({
        id: track.id ?? String(idx),
        title: track.name || `Track ${idx + 1}`,
        artist: track.artist || "",
        url: track.url?.trim() ?? "",
        fallbackUrl: youtubeSearchForTrack(track.name || `Track ${idx + 1}`, track.artist || ""),
      }))
      .filter((entry) => entry.url.length > 0 || entry.fallbackUrl.length > 0);

    if (entries.length === 0) {
      throw new Error("No usable track links were available for this import.");
    }

    const requestedConcurrency = clampConcurrency(downloadConcurrencyRef.current);
    downloadConcurrencyRef.current = requestedConcurrency;

    const failures: string[] = [];
    let next = 0;
    let active = 0;
    let spotifyTrackUrlsBlocked = false;
    let spotifyFallbackAnnounced = false;

    setDownloadLog((cur) => {
      const nextLog = [
        ...cur,
        `Starting import queue: ${entries.length} unique tracks, up to ${requestedConcurrency} concurrent downloads.${skippedDuplicates > 0 ? ` (${skippedDuplicates} duplicates skipped.)` : ""}`,
      ];
      return nextLog.length > 240 ? nextLog.slice(nextLog.length - 240) : nextLog;
    });
    setActiveDownloads(0);

    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        setActiveDownloads(0);
        queuePumpRef.current = null;
        resolve();
      };

      const pump = () => {
        if (finished) return;
        const limit = requestedConcurrency;
        while (active < limit && next < entries.length) {
          const entry = entries[next++];
          active += 1;
          setActiveDownloads(active);
          void (async () => {
            let failed = false;
            try {
              const attemptedSpotifyUrl = !spotifyTrackUrlsBlocked && entry.url.length > 0;
              const primaryUrl = attemptedSpotifyUrl ? entry.url : entry.fallbackUrl;
              await musicSpotiFlacDownload(primaryUrl, downloadService, "LOSSLESS");
            } catch (err) {
              const detail = String(err);
              const spotifyBlocked = spotifyClientTokenUnauthorized(detail);
              if (spotifyBlocked) {
                spotifyTrackUrlsBlocked = true;
                if (!spotifyFallbackAnnounced) {
                  spotifyFallbackAnnounced = true;
                  setDownloadLog((cur) => {
                    const nextLog = [
                      ...cur,
                      "Spotify client-token requests are being rejected (401). Falling back to YouTube Music search links for this import.",
                    ];
                    return nextLog.length > 240 ? nextLog.slice(nextLog.length - 240) : nextLog;
                  });
                }
              }

              const canRetryWithYoutube = entry.fallbackUrl.length > 0 && entry.url.length > 0 && (spotifyBlocked || spotifyTrackUrlsBlocked);
              if (canRetryWithYoutube) {
                try {
                  await musicSpotiFlacDownload(entry.fallbackUrl, downloadService, "LOSSLESS");
                } catch (fallbackErr) {
                  failed = true;
                  const failureText = `${entry.title}: ${String(fallbackErr)}`;
                  failures.push(failureText);
                  setDownloadLog((cur) => {
                    const nextLog = [...cur, `Track failed: ${failureText}`];
                    return nextLog.length > 240 ? nextLog.slice(nextLog.length - 240) : nextLog;
                  });
                }
              } else {
                failed = true;
                const failureText = `${entry.title}: ${detail}`;
                failures.push(failureText);
                setDownloadLog((cur) => {
                  const nextLog = [...cur, `Track failed: ${failureText}`];
                  return nextLog.length > 240 ? nextLog.slice(nextLog.length - 240) : nextLog;
                });
              }
            } finally {
              active -= 1;
              setActiveDownloads(active);
              if (!failed) {
                // One more track finished downloading — advance the authoritative counter.
                setQueueCompleted((n) => n + 1);
              }
              void refresh();
              if (next >= entries.length && active === 0) {
                finish();
                return;
              }
              pump();
            }
          })();
        }
        if (next >= entries.length && active === 0) {
          finish();
        }
      };

      queuePumpRef.current = pump;
      pump();
    });

    if (failures.length > 0) {
      const failed = failures.length;
      const ok = entries.length - failed;
      const sample = failures.slice(0, 3).map((line) => `- ${line}`).join("\n");
      throw new Error(`Imported ${ok} of ${entries.length} tracks. ${failed} failed.${sample ? `\n${sample}` : ""}`);
    }
  }

  async function runSpotiFlac(urlOverride?: string) {
    const override = typeof urlOverride === "string" ? urlOverride : null;
    const targetUrl = (override ?? downloadUrl).trim();
    if (!IN_TAURI || downloadBusy || !targetUrl) return;
    const baselineIds = items.map((i) => i.id);
    setDownloadBusy(true);
    setDownloadDone(false);
    setDownloadError(null);
    setDownloadMessage(null);
    setDownloadLog([]);
    setDownloadCompletedFiles(null);
    setQueueCompleted(0);
    downloadFloorRef.current = 0;
    setDownloadSessionBaseIds(baselineIds);
    setExpectedTracks(null);
    setExpectedPlaylistName(null);
    setActiveDownloads(0);
    let prefetchedTracks: SpotifyTrack[] | null = null;
    let canRunConcurrentQueue = false;
    let playlistSaveTask: Promise<void> | null = null;
    let playlistSavedName: string | null = null;
    let playlistSavedCount: number | null = null;
    let playlistSaveError: string | null = null;
    const isPlaylistImport = isSpotifyCollectionLink(targetUrl, "playlist");
    const isAlbumImport = isSpotifyCollectionLink(targetUrl, "album");
    const isArtistImport = isSpotifyCollectionLink(targetUrl, "artist");
    if (isPlaylistImport) {
      playlistSaveTask = spotifyToPlaylist(targetUrl)
        .then((playlist) => {
          playlistSavedName = playlist.name;
          playlistSavedCount = playlist.tracks.length;
        })
        .catch((err) => {
          playlistSaveError = String(err);
        });
      setPrefetchBusy(true);
      try {
        const preview = await spotifyPlaylistPreview(targetUrl);
        const uniqueTracks = dedupeSpotifyTracks(preview.tracks);
        setExpectedTracks(uniqueTracks);
        setExpectedPlaylistName(preview.playlist);
        prefetchedTracks = uniqueTracks;
        canRunConcurrentQueue = uniqueTracks.length > 0;
      } catch {
        // Prefetch is best-effort; importing still continues.
      } finally {
        setPrefetchBusy(false);
      }
    } else if (isAlbumImport || isArtistImport) {
      setPrefetchBusy(true);
      try {
        const preview = isAlbumImport
          ? await spotifyAlbumPreview(targetUrl)
          : await spotifyArtistTopTracksPreview(targetUrl);
        const uniqueTracks = dedupeSpotifyTracks(preview.tracks);
        setExpectedTracks(uniqueTracks);
        setExpectedPlaylistName(preview.playlist);
        prefetchedTracks = uniqueTracks;
        canRunConcurrentQueue = uniqueTracks.length > 0;
      } catch {
        // Prefetch is best-effort; importing still continues.
      } finally {
        setPrefetchBusy(false);
      }
    }
    try {
      if (canRunConcurrentQueue && prefetchedTracks) {
        await runQueuedSpotifyTracks(prefetchedTracks);
      } else {
        setActiveDownloads(1);
        await musicSpotiFlacDownload(targetUrl, downloadService, "LOSSLESS");
      }
      if (playlistSaveTask) {
        await playlistSaveTask;
        if (playlistSavedName && typeof playlistSavedCount === "number") {
          setDownloadMessage(`Saved playlist \"${playlistSavedName}\" with ${playlistSavedCount} track${playlistSavedCount === 1 ? "" : "s"}.`);
        } else if (playlistSaveError) {
          setDownloadMessage("Import finished, but saving a playlist manifest failed.");
        }
      }
      setDownloadDone(true);
      setDownloadUrl("");
      await refresh();
    } catch (e) {
      setDownloadError(String(e));
    } finally {
      queuePumpRef.current = null;
      setActiveDownloads(0);
      setDownloadBusy(false);
    }
  }

  async function installSpotiFlac() {
    if (!IN_TAURI || installBusy) return;
    setInstallBusy(true);
    setDownloadError(null);
    setDownloadMessage(null);
    try {
      const res: MusicSpotiFlacInstallResult = await musicSpotiFlacInstall();
      const status = await musicSpotiFlacStatus();
      setSpotiStatus(status);
      setDownloadMessage(
        res.resolvedCommand
          ? `Installed. Using ${res.resolvedCommand}. ${res.stderr || res.stdout || ""}`.trim()
          : (res.stderr || res.stdout || "Installation finished.").trim(),
      );
    } catch (e) {
      setDownloadError(String(e));
    } finally {
      setInstallBusy(false);
    }
  }

  function findMoreAlbumsForArtist(artistQuery: string) {
    setArtistName(null);
    setAlbumKey(null);
    setDownloadUrl(`https://music.youtube.com/search?q=${encodeURIComponent(artistQuery)}`);
  }

  function findMoreSongsForAlbum(artistQuery: string) {
    setArtistName(null);
    setAlbumKey(null);
    setDownloadUrl(`https://music.youtube.com/search?q=${encodeURIComponent(artistQuery)}`);
  }

  if (mode === "import") {
    return (
      <div className="section-stack media-wide music-import-shell">
        <div className="cat-header">
          <span className="cat-title section-title music-import-title"><Icon icon={download} size="base" /> Import Music</span>
          <span className="cat-sub">Queue tracks, albums, playlists, and artists.</span>
          <div className="cat-controls">
            <Button variant="ghost" icon={rotateCw} onClick={refresh}>Refresh library cache</Button>
          </div>
        </div>

        {!IS_IOS ? (
          <div>
            <div className="settings-group">
              <div className="search-bar-lg">
                <Input
                  iconLeft={link2}
                  placeholder="Paste a song, album, playlist, or artist link..."
                  shape="pill"
                  size="lg"
                  value={downloadUrl}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setDownloadUrl(e.currentTarget.value)}
                  onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && void runSpotiFlac()}
                  onClear={() => setDownloadUrl("")}
                />
                <Button
                  variant="primary"
                  shape="pill"
                  size="lg"
                  icon={download}
                  loading={downloadBusy}
                  disabled={!IN_TAURI || !spotiStatus?.available || !downloadUrl.trim()}
                  onClick={runSpotiFlac}
                >
                  {downloadBusy ? "Importing..." : "Import"}
                </Button>
              </div>
              <div className="form-actions">
                <label className="field-hint" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  Concurrent downloads
                  <select
                    value={downloadConcurrency}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => onDownloadConcurrencyChange(parseInt(e.currentTarget.value, 10))}
                    style={{
                      minWidth: 74,
                      borderRadius: 8,
                      border: "1px solid color-mix(in srgb, var(--outline-variant, rgba(255,255,255,0.12)) 100%, transparent)",
                      background: "var(--surface-1, rgba(255,255,255,0.04))",
                      color: "var(--text, #fff)",
                      padding: "6px 8px",
                    }}
                  >
                    {CONCURRENCY_CHOICES.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                  {downloadBusy && <span className="music-concurrency-active">{activeDownloads} active</span>}
                </label>
                {!spotiStatus?.available && (
                  <Button
                    variant="secondary"
                    icon={download}
                    loading={installBusy}
                    disabled={!IN_TAURI}
                    onClick={installSpotiFlac}
                  >
                    Install CLI
                  </Button>
                )}
              </div>
              {!spotiStatus?.available && (
                <p className="field-hint" style={{ color: "var(--gg-danger, #d85b5b)" }}>
                  <Icon icon={triangleAlert} size="sm" /> SpotiFLAC is not installed.
                </p>
              )}
              {(downloadBusy || prefetchBusy) && (
                <div className="field" style={{ borderTop: "1px solid color-mix(in srgb, var(--outline-variant, rgba(255,255,255,0.12)) 100%, transparent)", paddingTop: 12 }}>
                  <label className="field-label">Incoming tracks{expectedPlaylistName ? ` • ${expectedPlaylistName}` : ""}</label>
                  {prefetchBusy ? (
                    <p className="field-hint">Loading playlist tracks...</p>
                  ) : visibleQueue.length === 0 ? (
                    <p className="field-hint">Preparing tracks...</p>
                  ) : (
                    <div style={{ maxHeight: 360, overflowY: "auto", paddingRight: 6 }}>
                      <div style={{ display: "grid", gap: 10 }}>
                        {visibleQueueSlice.map((item) => (
                          <div
                            key={item.id}
                            style={{
                              display: "grid",
                              gap: 12,
                              gridTemplateColumns: "52px minmax(0, 1fr) auto",
                              alignItems: "center",
                              padding: 10,
                              borderRadius: 12,
                              border: "1px solid color-mix(in srgb, var(--outline-variant, rgba(255,255,255,0.12)) 100%, transparent)",
                              background: "color-mix(in srgb, var(--surface-1, rgba(255,255,255,0.04)) 100%, transparent)",
                            }}
                          >
                            <div
                              style={{
                                width: 52,
                                height: 52,
                                borderRadius: 10,
                                overflow: "hidden",
                                display: "grid",
                                placeItems: "center",
                                background: `linear-gradient(150deg, hsl(${hueFromString(`${item.artist} ${item.album}`)} 32% 24%), hsl(${(hueFromString(`${item.artist} ${item.album}`) + 40) % 360} 42% 13%))`,
                              }}
                            >
                              {item.artworkUrl ? <img src={item.artworkUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Icon icon={disc3} size="base" />}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.title}>{item.title}</div>
                              <div className="field-hint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${item.artist} · ${item.album}`}>
                                {[item.artist, item.album].filter(Boolean).join(" · ")}
                              </div>
                            </div>
                            <div style={{ justifySelf: "end", color: item.imported ? "var(--gg-success, #2f8f4e)" : "var(--gg-text-dim)" }}>
                              {item.imported ? "Added" : "Queued"}
                            </div>
                          </div>
                        ))}
                      </div>
                      {visibleQueue.length > visibleQueueSlice.length && (
                        <p className="field-hint" style={{ marginTop: 10 }}>
                          Rendering {visibleQueueSlice.length} of {visibleQueue.length} tracks. More items are loading…
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
              {(prefetchBusy || downloadBusy) && (
                <div className="music-import-progress" aria-live="polite">
                  <div className="music-import-progress-head">
                    <span className="field-label">Import progress</span>
                    <span className="field-hint">
                      {downloadProgress.total != null
                        ? `${downloadProgress.downloaded} of ${downloadProgress.total} imported${downloadRemaining != null ? ` • ${downloadRemaining} left` : ""}`
                        : prefetchBusy
                          ? "Loading playlist tracks..."
                          : "Waiting for first completed track..."}
                    </span>
                  </div>
                  <div
                    className={`music-import-progress-track${downloadPercent == null ? " is-indeterminate" : ""}`}
                    role={downloadPercent == null ? "status" : "progressbar"}
                    aria-label="Music import progress"
                    aria-valuemin={downloadPercent == null ? undefined : 0}
                    aria-valuemax={downloadPercent == null ? undefined : 100}
                    aria-valuenow={downloadPercent == null ? undefined : downloadPercent}
                  >
                    <div
                      className="music-import-progress-fill"
                      style={downloadPercent == null ? undefined : { width: `${downloadPercent}%` }}
                    />
                  </div>
                  {downloadBusy && (
                    <p className="field-hint">
                      {downloadProgress.total != null
                        ? `Imported ${downloadProgress.downloaded} of ${downloadProgress.total} tracks.`
                        : "Import in progress..."}
                      {` Active: ${activeDownloads} / ${downloadConcurrency}.`}
                    </p>
                  )}
                </div>
              )}
              {downloadError && <p className="field-hint" style={{ color: "var(--gg-danger, #d85b5b)" }}>{downloadError}</p>}
              {!downloadError && downloadMessage && <p className="settings-status">{downloadMessage}</p>}
              {!downloadBusy && !downloadError && downloadDone && downloadProgress.total != null && (
                <p className="field-hint" style={{ color: "var(--gg-success, #2f8f4e)" }}>
                  Finished importing {downloadProgress.total} track{downloadProgress.total === 1 ? "" : "s"}.
                </p>
              )}
              {!IN_TAURI && <p className="field-hint">SpotiFLAC downloads run in the desktop app.</p>}
              {spotiStatus?.hint && <p className="field-hint">{spotiStatus.hint}</p>}
            </div>
          </div>
        ) : (
          <div className="settings-group">
            <p className="field-hint">
              <Icon icon={download} size="sm" /> Find music in <b>Discover</b>, then add it here. iPad supports MP3/AAC/ALAC/WAV; FLAC won&apos;t play.
            </p>
          </div>
        )}
        {ctx.menu}{playlistOverlay}
      </div>
    );
  }

  // ---- album detail (track list) ----
  if (album) {
    return (
      <div className="section-stack media-wide">
        <button className="series-back" onClick={() => setAlbumKey(null)}><Icon icon={chevronLeft} size="sm" /> {album.artist}</button>
        <div className="cat-header">
          <span className="cat-title section-title"><Icon icon={disc3} size="base" /> {album.album}</span>
          <span className="cat-sub">{album.artist}</span>
          <div className="cat-controls">
            <Button
              variant="secondary"
              icon={link2}
              disabled={!IN_TAURI || downloadBusy}
              onClick={() => findMoreSongsForAlbum(album.artist)}
            >
              Find more songs
            </Button>
          </div>
        </div>
        <div className="series-head">
          <div className="series-art series-art-sq">
            {album.artworkUrl ? <img src={album.artworkUrl} alt="" /> : <Icon icon={disc3} size="2xl" />}
          </div>
          <div className="series-info">
            <h2 className="series-name">{album.album}</h2>
            <div className="series-meta">{[album.artist, `${album.tracks.length} track${album.tracks.length === 1 ? "" : "s"}`].join(" · ")}</div>
            <div className="form-actions" style={{ marginTop: 16 }}>
              <Button variant="primary" icon={circlePlay} onClick={() => onPlayLocal(album.tracks[0].item)}>Play</Button>
              {onReplacePoster && <Button variant="ghost" onClick={() => onReplacePoster(album.album)}>Replace cover…</Button>}
            </div>
          </div>
        </div>
        {sel.size > 0 && (
          <div className="track-selbar">
            <span className="track-selbar-count">{sel.size} selected</span>
            <Button
              size="sm"
              variant="primary"
              icon={listMusic}
              onClick={(e: MouseEvent<HTMLElement>) => {
                menuPos.current = { x: e.clientX, y: e.clientY };
                openAddToPlaylist(toPlTracks(album.tracks.filter((p) => sel.has(p.item.id))));
              }}
            >
              Add to playlist…
            </Button>
            <button className="search-sec-action" onClick={clearSel}>Clear</button>
          </div>
        )}
        <div className="track-list">
          {album.tracks.map((p) => (
            <div
              key={p.item.id}
              className={`track-row${sel.has(p.item.id) ? " selected" : ""}`}
              {...dragProps(toPlTracks(sel.has(p.item.id) ? album.tracks.filter((t) => sel.has(t.item.id)) : [p]))}
              onContextMenu={(e) => ctx.open(e, trackActions(p))}
              onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) { e.preventDefault(); toggleSel(p.item.id); } }}
              onDoubleClick={() => onPlayLocal(p.item)}
            >
              <span className="track-no">{p.trackNo || "—"}</span>
              <span className="track-name" title={p.track}>{p.track}</span>
              <button
                className={`track-like${trackIsLiked(p) ? " liked" : ""}`}
                title={trackIsLiked(p) ? "Remove from Liked Songs" : "Add to Liked Songs"}
                aria-label="Like"
                onClick={() => void toggleLikeTrack(p)}
              >
                <Icon icon={heart} size="sm" />
              </button>
              <span className="track-size">{formatBytes(p.item.sizeBytes)}</span>
              <button className="track-play" title="Play" onClick={() => onPlayLocal(p.item)}><Icon icon={circlePlay} size="sm" /></button>
            </div>
          ))}
        </div>
        {ctx.menu}{playlistOverlay}
      </div>
    );
  }

  // ---- artist detail (albums grid) ----
  if (artist) {
    return (
      <div className="section-stack media-wide">
        <button className="series-back" onClick={() => setArtistName(null)}><Icon icon={chevronLeft} size="sm" /> All artists</button>
        <div className="cat-header">
          <span className="cat-title section-title"><Icon icon={micVocal} size="base" /> {artist.name}</span>
          <span className="cat-sub">{artist.albums.length} album{artist.albums.length === 1 ? "" : "s"}</span>
          <div className="cat-controls">
            <Button
              variant="secondary"
              icon={link2}
              disabled={!IN_TAURI || downloadBusy}
              onClick={() => findMoreAlbumsForArtist(artist.name)}
            >
              Find more albums
            </Button>
          </div>
        </div>
        <div className="cat-grid">
          {artist.albums.map((al) => (
            <AlbumCard key={al.key} album={al} onClick={() => setAlbumKey(al.key)} onContextMenu={(e) => ctx.open(e, albumActions(al))} dnd={dragProps(toPlTracks(al.tracks))} />
          ))}
        </div>
        {ctx.menu}{playlistOverlay}
      </div>
    );
  }

  // ---- genre detail (artists + albums in a genre) ----
  if (selectedGenre) {
    const genreAlbums = [...selectedGenre.albums].sort((a, b) => b.addedAt - a.addedAt);
    return (
      <div className="section-stack media-wide">
        <button className="series-back" onClick={() => setGenreName(null)}><Icon icon={chevronLeft} size="sm" /> All music</button>
        <div className="cat-header">
          <span className="cat-title section-title"><Icon icon={sparkles} size="base" /> {selectedGenre.name}</span>
          <span className="cat-sub">
            {selectedGenre.albums.length} album{selectedGenre.albums.length === 1 ? "" : "s"} · {selectedGenre.artistCount} artist{selectedGenre.artistCount === 1 ? "" : "s"}
          </span>
        </div>
        {genreArtists.length > 0 && (
          <PosterRow
            title="Artists"
            count={genreArtists.length}
            items={genreArtists}
            renderItem={(a) => (
              <ArtistCard
                key={a.name}
                artist={a}
                onClick={() => {
                  setGenreName(null);
                  setArtistName(a.name);
                }}
                onContextMenu={(e) => ctx.open(e, artistActions(a))}
                dnd={dragProps(toPlTracks(a.albums.flatMap((al) => al.tracks)))}
              />
            )}
          />
        )}
        <h2 className="prow-title music-grid-title"><Icon icon={disc3} size="sm" /> Albums</h2>
        <div className="cat-grid">
          {genreAlbums.map((al) => (
            <AlbumCard key={al.key} album={al} onClick={() => setAlbumKey(al.key)} onContextMenu={(e) => ctx.open(e, albumActions(al))} dnd={dragProps(toPlTracks(al.tracks))} />
          ))}
        </div>
        {ctx.menu}{playlistOverlay}
      </div>
    );
  }

  // ---- browse home (iTunes-style: featured + rows + genres) ----
  return (
    <div className="section-stack media-wide">
      <div className="cat-header">
        <span className="cat-title section-title"><Icon icon={music} size="base" /> Music</span>
        {artists.length > 0 && <span className="cat-sub">{artists.length} artist{artists.length === 1 ? "" : "s"}</span>}
        <div className="cat-controls">
          {!hasLocalQuery && artists.length > 0 && (
            <label className="music-sort" title="Sort artists and albums">
              <Icon icon={arrowDownUp} size="xs" />
              <SegmentedControl options={BROWSE_SORTS} value={browseSort} onChange={(v) => setBrowseSort(v as BrowseSort)} />
            </label>
          )}
          <Button variant="secondary" shape="pill" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      <div className="settings-group music-local-search">
        <div className="search-bar-lg">
          <Input
            iconLeft={search}
            placeholder="Search local music, or paste a Spotify link to import…"
            shape="pill"
            size="lg"
            value={localQuery}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setLocalQuery(e.currentTarget.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key !== "Enter") return;
              const v = localQuery.trim();
              if (onImportLink && isMusicImportLink(v)) {
                e.preventDefault();
                onImportLink(v);
                setLocalQuery("");
              }
            }}
            onClear={() => setLocalQuery("")}
          />
        </div>
        <p className="field-hint">
          {hasLocalQuery
            ? `Showing local matches for “${localQuery.trim()}”.`
            : "Filter local tracks, or paste a Spotify playlist/album/artist link and press Enter to import."}
        </p>
      </div>

      {loading ? (
        <PosterGridSkeleton square />
      ) : artists.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <span className="empty-glyph"><Icon icon={music} size="xl" /></span>
            <h3>No music in your library yet</h3>
            <p>Find albums under <b>Discover</b> and download them — they&apos;ll show up here grouped by artist using embedded metadata from your files.</p>
          </div>
        </div>
      ) : hasLocalQuery ? (
        <div className="music-search-results">
          <section className="prow">
            <div className="prow-head">
              <h2 className="prow-title">Tracks<span className="prow-count">{localTrackResults.total}</span></h2>
            </div>
            {localTrackResults.total === 0 ? (
              <p className="field-hint music-search-empty">No local tracks matched your query.</p>
            ) : (
              <>
                <div className="track-list">
                  {visibleLocalTrackHits.map((hit) => {
                    const p = hit.track;
                    return (
                      <div
                        key={`${p.item.id}-${hit.albumKey}`}
                        className="track-row"
                        onContextMenu={(e) => ctx.open(e, trackActions(p))}
                        onClick={() => setAlbumKey(hit.albumKey)}
                        onDoubleClick={() => onPlayLocal(p.item)}
                      >
                        <span className="track-no">{p.trackNo || "—"}</span>
                        <span className="track-name" title={`${p.track} · ${p.artist}`}>{`${p.track} · ${p.artist}`}</span>
                        <button
                          className={`track-like${trackIsLiked(p) ? " liked" : ""}`}
                          title={trackIsLiked(p) ? "Remove from Liked Songs" : "Add to Liked Songs"}
                          aria-label="Like"
                          onClick={(e: MouseEvent<HTMLButtonElement>) => {
                            e.stopPropagation();
                            void toggleLikeTrack(p);
                          }}
                        >
                          <Icon icon={heart} size="sm" />
                        </button>
                        <span className="track-size">{formatBytes(p.item.sizeBytes)}</span>
                        <button
                          className="track-play"
                          title="Play"
                          onClick={(e: MouseEvent<HTMLButtonElement>) => {
                            e.stopPropagation();
                            onPlayLocal(p.item);
                          }}
                        >
                          <Icon icon={circlePlay} size="sm" />
                        </button>
                      </div>
                    );
                  })}
                </div>
                {localTrackHasMore && <div ref={localTrackSentinelRef} style={{ height: 1 }} aria-hidden />}
                {localTrackHasMore && (
                  <p className="field-hint music-search-truncated">
                    Rendering {visibleLocalTrackHits.length} of {localTrackResults.hits.length} loaded matches. Keep scrolling to load more.
                  </p>
                )}
                {!localTrackHasMore && localTrackResults.total > localTrackResults.hits.length && (
                  <p className="field-hint music-search-truncated">
                    Showing the first {localTrackResults.hits.length} track matches. Narrow the query for exact results.
                  </p>
                )}
              </>
            )}
          </section>

          {localArtistResults.length > 0 && (
            <PosterRow
              title="Artists"
              count={localArtistResults.length}
              items={localArtistResults}
              renderItem={(a) => (
                <ArtistCard
                  key={a.name}
                  artist={a}
                  onClick={() => setArtistName(a.name)}
                  onContextMenu={(e) => ctx.open(e, artistActions(a))}
                  dnd={dragProps(toPlTracks(a.albums.flatMap((al) => al.tracks)))}
                />
              )}
            />
          )}

          {localAlbumResults.length > 0 && (
            <PosterRow
              title="Albums"
              count={localAlbumResults.length}
              items={localAlbumResults}
              renderItem={(al) => (
                <AlbumCard
                  key={al.key}
                  album={al}
                  onClick={() => setAlbumKey(al.key)}
                  onContextMenu={(e) => ctx.open(e, albumActions(al))}
                  dnd={dragProps(toPlTracks(al.tracks))}
                />
              )}
            />
          )}
        </div>
      ) : (
        <div className="music-browse">
          {featured && (
            <MusicHero
              album={featured}
              onPlay={() => onPlayLocal(featured.tracks[0].item)}
              onArtist={() => setArtistName(featured.artist)}
            />
          )}
          {visibleBrowseSections.has("smart") && (likedTracks.length > 0 || recentTracks.length > 0) && (
            <section className="prow">
              <div className="prow-head">
                <h2 className="prow-title">Made for you</h2>
              </div>
              <div className="music-smart-row">
                {likedTracks.length > 0 && (
                  <button
                    className="music-smart-card is-liked"
                    onClick={() => void playTrackCollection(likedTracks, { shuffle: true })}
                  >
                    <span className="music-smart-glyph"><Icon icon={heart} size="xl" /></span>
                    <span className="music-smart-text">
                      <span className="music-smart-title">Liked Songs</span>
                      <span className="music-smart-sub">{likedTracks.length} song{likedTracks.length === 1 ? "" : "s"} · Shuffle</span>
                    </span>
                    <span className="music-smart-play"><Icon icon={shuffle} size="sm" /></span>
                  </button>
                )}
                {recentTracks.length > 0 && (
                  <button
                    className="music-smart-card is-recent"
                    onClick={() => void playTrackCollection(recentTracks)}
                  >
                    <span className="music-smart-glyph"><Icon icon={history} size="xl" /></span>
                    <span className="music-smart-text">
                      <span className="music-smart-title">Recently Played</span>
                      <span className="music-smart-sub">{recentTracks.length} song{recentTracks.length === 1 ? "" : "s"}</span>
                    </span>
                    <span className="music-smart-play"><Icon icon={circlePlay} size="sm" /></span>
                  </button>
                )}
              </div>
            </section>
          )}
          {visibleBrowseSections.has("recent") && recentAlbums.length > 0 && (
            <PosterRow
              title="Recently Added"
              count={recentAlbums.length}
              items={recentAlbums}
              renderItem={(al) => (
                <AlbumCard
                  key={al.key}
                  album={al}
                  onClick={() => setAlbumKey(al.key)}
                  onContextMenu={(e) => ctx.open(e, albumActions(al))}
                  dnd={dragProps(toPlTracks(al.tracks))}
                />
              )}
            />
          )}
          {visibleBrowseSections.has("artists") && artistsBrowse.length > 0 && (
            <PosterRow
              title="Artists"
              count={artistsBrowse.length}
              items={artistsBrowse}
              renderItem={(a) => (
                <ArtistCard
                  key={a.name}
                  artist={a}
                  onClick={() => setArtistName(a.name)}
                  onContextMenu={(e) => ctx.open(e, artistActions(a))}
                  dnd={dragProps(toPlTracks(a.albums.flatMap((al) => al.tracks)))}
                />
              )}
            />
          )}
          {visibleBrowseSections.has("albums") && albumsBrowse.length > 0 && (
            <PosterRow
              title="Albums"
              count={albumsBrowse.length}
              items={albumsBrowse}
              renderItem={(al) => (
                <AlbumCard
                  key={al.key}
                  album={al}
                  onClick={() => setAlbumKey(al.key)}
                  onContextMenu={(e) => ctx.open(e, albumActions(al))}
                  dnd={dragProps(toPlTracks(al.tracks))}
                />
              )}
            />
          )}
          {visibleBrowseSections.has("genres") && genres.length > 0 && (
            <section className="prow">
              <div className="prow-head">
                <h2 className="prow-title">Genres<span className="prow-count">{genres.length}</span></h2>
              </div>
              <div className="genre-tiles">
                {genres.map((g) => (
                  <GenreTile key={g.name} genre={g} onClick={() => setGenreName(g.name)} />
                ))}
              </div>
            </section>
          )}
          {browseVisibleSections < browseSections.length && (
            <p className="field-hint" style={{ marginTop: 4 }}>Loading more music sections…</p>
          )}
        </div>
      )}
      {ctx.menu}{playlistOverlay}
    </div>
  );
}

function MusicHero({ album, onPlay, onArtist }: { album: AlbumGroup; onPlay: () => void; onArtist: () => void }) {
  const hue = hueFromString(album.album);
  const bg = `linear-gradient(150deg, hsl(${hue} 34% 26%), hsl(${(hue + 40) % 360} 44% 14%))`;
  return (
    <div className="music-hero">
      <div className="music-hero-wash" style={{ background: bg }} aria-hidden />
      {album.artworkUrl && <div className="music-hero-bg" style={{ backgroundImage: `url(${album.artworkUrl})` }} aria-hidden />}
      <div className="music-hero-scrim" aria-hidden />
      <div className="music-hero-inner">
        <div className="music-hero-art" style={{ background: bg }}>
          {album.artworkUrl ? <img src={album.artworkUrl} alt="" /> : <Icon icon={disc3} size="2xl" />}
        </div>
        <div className="music-hero-body">
          <span className="hero-kicker">Featured Album</span>
          <h1 className="music-hero-title" title={album.album}>{album.album}</h1>
          <button className="music-hero-artist" onClick={onArtist}><Icon icon={micVocal} size="xs" /> {album.artist}</button>
          <div className="music-hero-meta">
            {album.genre && <Chip size="sm" variant="filled">{album.genre}</Chip>}
            <span className="music-hero-tracks"><Icon icon={music} size="xs" /> {album.tracks.length} track{album.tracks.length === 1 ? "" : "s"}</span>
          </div>
          <div className="form-actions" style={{ marginTop: 16 }}>
            <Button variant="primary" icon={circlePlay} onClick={onPlay}>Play</Button>
            <Button variant="ghost" onClick={onArtist}>View artist</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GenreTile({ genre, onClick }: { genre: GenreGroup; onClick: () => void }) {
  const hue = hueFromString(genre.name);
  const bg = `linear-gradient(135deg, hsl(${hue} 52% 34%), hsl(${(hue + 55) % 360} 58% 20%))`;
  return (
    <button className="genre-tile" style={{ background: bg }} onClick={onClick}>
      <span className="genre-tile-name">{genre.name}</span>
      <span className="genre-tile-count">{genre.albums.length} album{genre.albums.length === 1 ? "" : "s"} · {genre.artistCount} artist{genre.artistCount === 1 ? "" : "s"}</span>
      <span className="genre-tile-glyph" aria-hidden><Icon icon={disc3} size="xl" /></span>
    </button>
  );
}

type DnD = { draggable: boolean; onDragStart: (e: DragEvent) => void };

function ArtistCard({ artist, onClick, onContextMenu, dnd }: { artist: ArtistGroup; onClick: () => void; onContextMenu?: (e: MouseEvent) => void; dnd?: DnD }) {
  const hue = hueFromString(artist.name);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} onContextMenu={onContextMenu} role="button" tabIndex={0} {...dnd}>
      <div className="poster square round" style={{ background: bg }}>
        {artist.artworkUrl ? (
          <img className="poster-img" src={artist.artworkUrl} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="poster-glyph"><Icon icon={micVocal} size="2xl" /></span>
        )}
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={artist.name}>{artist.name}</div>
        <div className="poster-info"><span>{artist.albums.length} album{artist.albums.length === 1 ? "" : "s"} · {artist.trackCount} track{artist.trackCount === 1 ? "" : "s"}</span></div>
      </div>
    </div>
  );
}

function AlbumCard({ album, onClick, onContextMenu, dnd }: { album: AlbumGroup; onClick: () => void; onContextMenu?: (e: MouseEvent) => void; dnd?: DnD }) {
  const hue = hueFromString(album.album);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} onContextMenu={onContextMenu} role="button" tabIndex={0} {...dnd}>
      <div className="poster square" style={{ background: bg }}>
        <PosterArt src={album.artworkUrl || relayMusicUrl(album.album, album.artist)} glyph={disc3} />
        <div className="poster-seed"><span className="play-badge"><Icon icon={circlePlay} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={album.album}>{album.album}</div>
        <div className="poster-info"><span>{album.tracks.length} track{album.tracks.length === 1 ? "" : "s"}</span></div>
      </div>
    </div>
  );
}
