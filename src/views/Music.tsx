import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import { PosterRow } from "../components/PosterRow";
import { PosterGridSkeleton } from "../components/Skeletons";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { AddToPlaylistMenu } from "../components/AddToPlaylistMenu";
import { IN_TAURI } from "../ipc/engine";
import {
  musicSpotiFlacInstall,
  musicSpotiFlacDownload,
  onMusicSpotiFlacOutput,
  musicSpotiFlacStatus,
  removeFromLibrary,
  revealPath,
  trashDownloaded,
  type DownloadedItem,
  type MusicSpotiFlacInstallResult,
  type MusicSpotiFlacOutput,
  type MusicSpotiFlacStatus,
} from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { spotifyToPlaylist, type PlaylistTrack } from "../ipc/playlists";
import { spotifyPlaylistPreview, type SpotifyTrack } from "../ipc/spotify";
import { hueFromString } from "../lib/catalog";
import { formatBytes } from "../lib/format";
import { chevronLeft, circlePlay, disc3, download, folderOpen, images, library, link2, listMusic, micVocal, music, rotateCw, sparkles, trash2, triangleAlert } from "../lib/icons";
import { IS_IOS } from "../lib/platform";
import "./Music.css";

interface MusicProps {
  /** Play a local audio file (single track). */
  onPlayLocal: (item: DownloadedItem) => void;
  /** Open the "replace poster" picker for an artist/album title. */
  onReplacePoster?: (title: string) => void;
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
  return d.includes("clienttoken.spotify.com") && d.includes("401");
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

export function Music({ onPlayLocal, onReplacePoster }: MusicProps) {
  const { items: all, refresh } = useDownloaded();
  const [artistName, setArtistName] = useState<string | null>(null);
  const [albumKey, setAlbumKey] = useState<string | null>(null);
  const [genreName, setGenreName] = useState<string | null>(null);
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
  const downloadConcurrencyRef = useRef(2);
  const queuePumpRef = useRef<(() => void) | null>(null);
  const ctx = useContextMenu();

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

  // Rendered alongside the context menu in every view branch (both portal to <body>).
  const playlistOverlay = (
    <>
      {addToPl && (
        <AddToPlaylistMenu
          x={addToPl.x}
          y={addToPl.y}
          tracks={addToPl.tracks}
          onClose={() => setAddToPl(null)}
          onAdded={(m) => setAtpMsg(m)}
        />
      )}
      {atpMsg && <div className="atp-toast" role="status">{atpMsg}</div>}
    </>
  );

  useEffect(() => {
    downloadConcurrencyRef.current = downloadConcurrency;
    queuePumpRef.current?.();
  }, [downloadConcurrency]);

  // Revalidate on mount; the cached list paints instantly so there's no spinner on revisit.
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!IN_TAURI) return;
    musicSpotiFlacStatus().then(setSpotiStatus).catch(() => {});
  }, []);
  useEffect(() => {
    if (!IN_TAURI) return;
    const p = onMusicSpotiFlacOutput((evt: MusicSpotiFlacOutput) => {
      if (typeof evt.completedFiles === "number") {
        setDownloadCompletedFiles((cur) => Math.max(cur ?? 0, evt.completedFiles ?? 0));
        void refresh();
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
    () => ({
      downloaded: Math.max(downloadCompletedFiles ?? 0, importedCount, parsedProgress.downloaded),
      total: expectedTotal ?? parsedProgress.total,
    }),
    [downloadCompletedFiles, importedCount, expectedTotal, parsedProgress],
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

  // Build the Artist → Album → Track tree from the flat file list.
  const artists = useMemo(() => {
    const albumMap = new Map<string, AlbumGroup>();
    for (const it of items) {
      const p = parseMusic(it);
      const key = `${p.artist.toLowerCase()}|${p.album.toLowerCase()}`;
      let g = albumMap.get(key);
      if (!g) {
        g = { key, album: p.album, artist: p.artist, genre: null, tracks: [], artworkUrl: p.artworkUrl, addedAt: 0 };
        albumMap.set(key, g);
      }
      if (!g.artworkUrl && p.artworkUrl) g.artworkUrl = p.artworkUrl;
      // Collapse duplicate copies of the same track within an album (keep the largest
      // file). This hides dupes from the view; the Automate "Dedupe library" task
      // removes the actual files. Keyed by track no. + normalized title.
      const tkey = `${p.trackNo}::${p.track.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
      const dup = g.tracks.findIndex(
        (t) => `${t.trackNo}::${t.track.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}` === tkey,
      );
      if (dup >= 0) {
        if (p.item.sizeBytes > g.tracks[dup].item.sizeBytes) g.tracks[dup] = p;
      } else {
        g.tracks.push(p);
      }
      g.addedAt = Math.max(g.addedAt, it.addedAt);
    }
    const artistMap = new Map<string, ArtistGroup>();
    for (const al of albumMap.values()) {
      al.tracks.sort((a, b) => a.trackNo - b.trackNo || a.track.localeCompare(b.track));
      al.genre = majorityGenre(al.tracks.map((t) => t.genre));
      const ak = al.artist.toLowerCase();
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
    const list = [...artistMap.values()];
    for (const ar of list) {
      ar.albums.sort((a, b) => b.addedAt - a.addedAt);
      ar.genre = majorityGenre(ar.albums.map((a) => a.genre));
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [items]);

  const allAlbums = useMemo(() => artists.flatMap((a) => a.albums), [artists]);

  // ---- iTunes-style browse derivations ----
  const recentAlbums = useMemo(
    () => [...allAlbums].sort((a, b) => b.addedAt - a.addedAt).slice(0, 18),
    [allAlbums],
  );
  const albumsByName = useMemo(
    () => [...allAlbums].sort((a, b) => a.album.localeCompare(b.album)),
    [allAlbums],
  );
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

  const artist = artistName ? artists.find((a) => a.name.toLowerCase() === artistName.toLowerCase()) ?? null : null;
  const album = albumKey ? allAlbums.find((a) => a.key === albumKey) ?? null : null;
  const selectedGenre = genreName ? genres.find((g) => g.name.toLowerCase() === genreName.toLowerCase()) ?? null : null;

  function trackActions(p: ParsedTrack): MenuAction[] {
    return [
      { label: "Play", icon: circlePlay, onSelect: () => onPlayLocal(p.item) },
      { label: "Add to playlist…", icon: listMusic, onSelect: () => openAddToPlaylist(toPlTracks([p])) },
      { label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(p.item.id) },
      { label: "Remove from library", icon: library, divider: true, onSelect: () => void removeFromLibrary(p.item.id).then(() => refresh()) },
      { label: "Move to Trash", icon: trash2, danger: true, onSelect: () => void trashDownloaded(p.item.id).then(() => refresh()) },
    ];
  }

  // Manage a whole album (all its tracks) from a right-click on its cover.
  function albumActions(al: AlbumGroup): MenuAction[] {
    const ids = al.tracks.map((t) => t.item.id);
    const actions: MenuAction[] = [
      { label: "Play album", icon: circlePlay, onSelect: () => onPlayLocal(al.tracks[0].item) },
      { label: "Add album to playlist…", icon: listMusic, onSelect: () => openAddToPlaylist(toPlTracks(al.tracks)) },
      { label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(ids[0]) },
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
      { label: "Play", icon: circlePlay, onSelect: () => onPlayLocal(tracks[0].item) },
      { label: "Add to playlist…", icon: listMusic, onSelect: () => openAddToPlaylist(toPlTracks(tracks)) },
      { label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(ids[0]) },
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
      throw new Error("No usable track links were available for this playlist.");
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
        `Starting playlist queue: ${entries.length} unique tracks, up to ${requestedConcurrency} concurrent downloads.${skippedDuplicates > 0 ? ` (${skippedDuplicates} duplicates skipped.)` : ""}`,
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
              const primaryUrl = spotifyTrackUrlsBlocked || !entry.url ? entry.fallbackUrl : entry.url;
              await musicSpotiFlacDownload(primaryUrl, downloadService, "LOSSLESS");
            } catch (err) {
              const detail = String(err);
              const canRetryWithYoutube = entry.fallbackUrl.length > 0 && !spotifyTrackUrlsBlocked && entry.url.length > 0;
              if (canRetryWithYoutube && spotifyClientTokenUnauthorized(detail)) {
                spotifyTrackUrlsBlocked = true;
                if (!spotifyFallbackAnnounced) {
                  spotifyFallbackAnnounced = true;
                  setDownloadLog((cur) => {
                    const nextLog = [
                      ...cur,
                      "Spotify client-token requests are being rejected (401). Falling back to YouTube Music search links for this playlist.",
                    ];
                    return nextLog.length > 240 ? nextLog.slice(nextLog.length - 240) : nextLog;
                  });
                }
                try {
                  await musicSpotiFlacDownload(entry.fallbackUrl, downloadService, "LOSSLESS");
                } catch (fallbackErr) {
                  failed = true;
                  failures.push(`${entry.title}: ${String(fallbackErr)}`);
                }
              } else {
                failed = true;
                failures.push(`${entry.title}: ${detail}`);
              }
            } finally {
              active -= 1;
              setActiveDownloads(active);
              if (failed) {
                // no-op; keep branch explicit for readability next to failure counting
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
      throw new Error(`Imported ${ok} of ${entries.length} tracks. ${failed} failed.`);
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
    if (targetUrl.includes("open.spotify.com/playlist/") || targetUrl.includes("spotify:playlist:")) {
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
        <div className="track-list">
          {album.tracks.map((p) => (
            <div key={p.item.id} className="track-row" onContextMenu={(e) => ctx.open(e, trackActions(p))} onDoubleClick={() => onPlayLocal(p.item)}>
              <span className="track-no">{p.trackNo || "—"}</span>
              <span className="track-name" title={p.track}>{p.track}</span>
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
            <AlbumCard key={al.key} album={al} onClick={() => setAlbumKey(al.key)} onContextMenu={(e) => ctx.open(e, albumActions(al))} />
          ))}
        </div>
        {ctx.menu}{playlistOverlay}
      </div>
    );
  }

  // ---- genre detail (artists + albums in a genre) ----
  if (selectedGenre) {
    const genreArtists = artists.filter((a) =>
      selectedGenre.albums.some((al) => al.artist.toLowerCase() === a.name.toLowerCase()),
    );
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
          <PosterRow title="Artists" count={genreArtists.length}>
            {genreArtists.map((a) => (
              <ArtistCard key={a.name} artist={a} onClick={() => { setGenreName(null); setArtistName(a.name); }} onContextMenu={(e) => ctx.open(e, artistActions(a))} />
            ))}
          </PosterRow>
        )}
        <h2 className="prow-title music-grid-title"><Icon icon={disc3} size="sm" /> Albums</h2>
        <div className="cat-grid">
          {genreAlbums.map((al) => (
            <AlbumCard key={al.key} album={al} onClick={() => setAlbumKey(al.key)} onContextMenu={(e) => ctx.open(e, albumActions(al))} />
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
          <Button variant="ghost" icon={rotateCw} onClick={refresh}>Refresh</Button>
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
              onKeyDown={(e) => e.key === "Enter" && void runSpotiFlac()}
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
                onChange={(e) => onDownloadConcurrencyChange(parseInt(e.currentTarget.value, 10))}
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
                    {visibleQueue.map((item) => (
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
                    ? `Imported ${downloadProgress.downloaded} of ${downloadProgress.total} tracks so far.`
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
            <Icon icon={download} size="sm" /> Find and download music under <b>Discover</b> — search an album or artist and add it. (Lossless FLAC won&apos;t play on iPad; MP3, AAC, ALAC and WAV do.)
          </p>
        </div>
      )}

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
      ) : (
        <div className="music-browse">
          {featured && (
            <MusicHero
              album={featured}
              onPlay={() => onPlayLocal(featured.tracks[0].item)}
              onArtist={() => setArtistName(featured.artist)}
            />
          )}
          {recentAlbums.length > 0 && (
            <PosterRow title="Recently Added" count={recentAlbums.length}>
              {recentAlbums.map((al) => (
                <AlbumCard key={al.key} album={al} onClick={() => setAlbumKey(al.key)} onContextMenu={(e) => ctx.open(e, albumActions(al))} />
              ))}
            </PosterRow>
          )}
          {artists.length > 0 && (
            <PosterRow title="Artists" count={artists.length}>
              {artists.map((a) => (
                <ArtistCard key={a.name} artist={a} onClick={() => setArtistName(a.name)} onContextMenu={(e) => ctx.open(e, artistActions(a))} />
              ))}
            </PosterRow>
          )}
          {albumsByName.length > 0 && (
            <PosterRow title="Albums" count={albumsByName.length}>
              {albumsByName.map((al) => (
                <AlbumCard key={al.key} album={al} onClick={() => setAlbumKey(al.key)} onContextMenu={(e) => ctx.open(e, albumActions(al))} />
              ))}
            </PosterRow>
          )}
          {genres.length > 0 && (
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

function ArtistCard({ artist, onClick, onContextMenu }: { artist: ArtistGroup; onClick: () => void; onContextMenu?: (e: MouseEvent) => void }) {
  const hue = hueFromString(artist.name);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} onContextMenu={onContextMenu} role="button" tabIndex={0}>
      <div className="poster square round" style={{ background: bg }}>
        {artist.artworkUrl ? (
          <img className="poster-img" src={artist.artworkUrl} alt="" />
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

function AlbumCard({ album, onClick, onContextMenu }: { album: AlbumGroup; onClick: () => void; onContextMenu?: (e: MouseEvent) => void }) {
  const hue = hueFromString(album.album);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} onContextMenu={onContextMenu} role="button" tabIndex={0}>
      <div className="poster square" style={{ background: bg }}>
        {album.artworkUrl ? (
          <img className="poster-img" src={album.artworkUrl} alt="" />
        ) : (
          <span className="poster-glyph"><Icon icon={disc3} size="2xl" /></span>
        )}
        <div className="poster-seed"><span className="play-badge"><Icon icon={circlePlay} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={album.album}>{album.album}</div>
        <div className="poster-info"><span>{album.tracks.length} track{album.tracks.length === 1 ? "" : "s"}</span></div>
      </div>
    </div>
  );
}
