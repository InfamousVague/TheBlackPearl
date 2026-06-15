import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { PosterGridSkeleton } from "../components/Skeletons";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
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
import { spotifyPlaylistPreview, type SpotifyTrack } from "../ipc/spotify";
import { hueFromString } from "../lib/catalog";
import { formatBytes } from "../lib/format";
import { chevronLeft, circleCheck, circlePlay, disc3, download, folderOpen, library, link2, micVocal, music, rotateCw, trash2, triangleAlert } from "../lib/icons";

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
  track: string;
  trackNo: number;
  artworkUrl: string | null;
}

interface AlbumGroup {
  key: string;
  album: string;
  artist: string;
  tracks: ParsedTrack[];
  artworkUrl: string | null;
  addedAt: number;
}

interface ArtistGroup {
  name: string;
  albums: AlbumGroup[];
  trackCount: number;
  artworkUrl: string | null;
  addedAt: number;
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
    track: it.title?.trim() || it.fileName.replace(/\.[^.]+$/, ""),
    trackNo: it.trackNo && it.trackNo > 0 ? it.trackNo : 0,
    artworkUrl: it.artworkUrl?.trim() || null,
  };
}

export function Music({ onPlayLocal, onReplacePoster }: MusicProps) {
  const { items: all, refresh } = useDownloaded();
  const [artistName, setArtistName] = useState<string | null>(null);
  const [albumKey, setAlbumKey] = useState<string | null>(null);
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
  const ctx = useContextMenu();

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
        id: track.id ?? `${idx}-${key}`,
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
        g = { key, album: p.album, artist: p.artist, tracks: [], artworkUrl: p.artworkUrl, addedAt: 0 };
        albumMap.set(key, g);
      }
      if (!g.artworkUrl && p.artworkUrl) g.artworkUrl = p.artworkUrl;
      g.tracks.push(p);
      g.addedAt = Math.max(g.addedAt, it.addedAt);
    }
    const artistMap = new Map<string, ArtistGroup>();
    for (const al of albumMap.values()) {
      al.tracks.sort((a, b) => a.trackNo - b.trackNo || a.track.localeCompare(b.track));
      const ak = al.artist.toLowerCase();
      let ar = artistMap.get(ak);
      if (!ar) {
        ar = { name: al.artist, albums: [], trackCount: 0, artworkUrl: al.artworkUrl, addedAt: 0 };
        artistMap.set(ak, ar);
      }
      if (!ar.artworkUrl && al.artworkUrl) ar.artworkUrl = al.artworkUrl;
      ar.albums.push(al);
      ar.trackCount += al.tracks.length;
      ar.addedAt = Math.max(ar.addedAt, al.addedAt);
    }
    const list = [...artistMap.values()];
    for (const ar of list) ar.albums.sort((a, b) => b.addedAt - a.addedAt);
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [items]);

  const allAlbums = useMemo(() => artists.flatMap((a) => a.albums), [artists]);

  const artist = artistName ? artists.find((a) => a.name.toLowerCase() === artistName.toLowerCase()) ?? null : null;
  const album = albumKey ? allAlbums.find((a) => a.key === albumKey) ?? null : null;

  function trackActions(p: ParsedTrack): MenuAction[] {
    return [
      { label: "Play", icon: circlePlay, onSelect: () => onPlayLocal(p.item) },
      { label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(p.item.id) },
      { label: "Remove from library", icon: library, divider: true, onSelect: () => void removeFromLibrary(p.item.id).then(() => refresh()) },
      { label: "Move to Trash", icon: trash2, danger: true, onSelect: () => void trashDownloaded(p.item.id).then(() => refresh()) },
    ];
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
    if (targetUrl.includes("open.spotify.com/playlist/") || targetUrl.includes("spotify:playlist:")) {
      setPrefetchBusy(true);
      try {
        const preview = await spotifyPlaylistPreview(targetUrl);
        setExpectedTracks(preview.tracks);
        setExpectedPlaylistName(preview.playlist);
      } catch {
        // Prefetch is best-effort; importing still continues.
      } finally {
        setPrefetchBusy(false);
      }
    }
    try {
      await musicSpotiFlacDownload(targetUrl, downloadService, "LOSSLESS");
      setDownloadDone(true);
      setDownloadUrl("");
      await refresh();
    } catch (e) {
      setDownloadError(String(e));
    } finally {
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
        {ctx.menu}
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
            <AlbumCard key={al.key} album={al} onClick={() => setAlbumKey(al.key)} />
          ))}
        </div>
        {ctx.menu}
      </div>
    );
  }

  // ---- artists grid (top level) ----
  return (
    <div className="section-stack media-wide">
      <div className="cat-header">
        <span className="cat-title section-title"><Icon icon={music} size="base" /> Music</span>
        {artists.length > 0 && <span className="cat-sub">{artists.length} artist{artists.length === 1 ? "" : "s"}</span>}
        <div className="cat-controls">
          <Button variant="ghost" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

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
          {(downloadBusy || prefetchBusy || visibleQueue.length > 0) && (
            <div className="field" style={{ borderTop: "1px solid color-mix(in srgb, var(--outline-variant, rgba(255,255,255,0.12)) 100%, transparent)", paddingTop: 12 }}>
              <label className="field-label">Incoming tracks{expectedPlaylistName ? ` • ${expectedPlaylistName}` : ""}</label>
              {prefetchBusy ? (
                <p className="field-hint">Loading playlist tracks...</p>
              ) : visibleQueue.length === 0 ? (
                <p className="field-hint">Preparing tracks...</p>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {visibleQueue.slice(0, 24).map((item) => (
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
          {downloadBusy && downloadProgress.total != null && (
            <p className="field-hint">Imported {downloadProgress.downloaded} of {downloadProgress.total} tracks so far.</p>
          )}
          {!IN_TAURI && <p className="field-hint">SpotiFLAC downloads run in the desktop app.</p>}
          {spotiStatus?.hint && <p className="field-hint">{spotiStatus.hint}</p>}
        </div>
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
      ) : (
        <div className="cat-grid">
          {artists.map((a) => (
            <ArtistCard key={a.name} artist={a} onClick={() => setArtistName(a.name)} />
          ))}
        </div>
      )}
      {ctx.menu}
    </div>
  );
}

function ArtistCard({ artist, onClick }: { artist: ArtistGroup; onClick: () => void }) {
  const hue = hueFromString(artist.name);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} role="button" tabIndex={0}>
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

function AlbumCard({ album, onClick }: { album: AlbumGroup; onClick: () => void }) {
  const hue = hueFromString(album.album);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} role="button" tabIndex={0}>
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
