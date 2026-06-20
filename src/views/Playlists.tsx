import { useEffect, useMemo, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { IN_TAURI } from "../ipc/engine";
import { usePlayer, type PlayerTrack } from "../ipc/player";
import {
  FORMAT_LABELS,
  createPlaylist,
  deletePlaylist,
  exportPlaylist,
  getPlaylist,
  importPlaylist,
  listPlaylists,
  playlistRemoveTrack,
  renamePlaylist,
  setPlaylistTracks,
  spotifyToPlaylist,
  type Playlist,
  type PlaylistFormat,
} from "../ipc/playlists";
import { hueFromString } from "../lib/catalog";
import { relayMusicUrl } from "../lib/relay";
import { check, chevronLeft, download as downloadIcon, folderDown, folderOutput, listMusic, music, play as playIcon, plus, rotateCw, shuffle, trash2, x } from "../lib/icons";
import "./Playlists.css";

const FORMATS: PlaylistFormat[] = ["m3u8", "m3u", "pls", "xspf"];

function fmtDur(ms: number): string {
  if (!ms || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Human total runtime for a playlist header, e.g. "1 hr 12 min" or "47 min". */
function fmtTotal(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min <= 0) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} hr ${m} min` : `${m} min`;
}

interface PlaylistsProps {
  /** Open this playlist's detail (driven by the Music rail). */
  openId?: string | null;
  onOpenId?: (id: string | null) => void;
  /** Bumped by the parent to force a re-fetch (e.g. after a drag-to-add elsewhere). */
  refreshKey?: number;
  /** Notify the parent (→ rail) that playlists changed. */
  onChanged?: () => void;
  /** Signals when the view is first usable for perf timing. */
  onReady?: (meta?: Record<string, string | number | boolean | null>) => void;
}

export function Playlists({ openId, onOpenId, refreshKey, onChanged, onReady }: PlaylistsProps = {}) {
  const player = usePlayer();
  const [lists, setLists] = useState<Playlist[] | null>(null);
  const [selected, setSelected] = useState<Playlist | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Header tools.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [spotifyLink, setSpotifyLink] = useState("");
  // Detail tools.
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const [format, setFormat] = useState<PlaylistFormat>("m3u8");
  // Drag-to-reorder track indices.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const sortedLists = useMemo(
    () => [...(lists ?? [])].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name)),
    [lists],
  );

  async function refresh() {
    try {
      setLists(await listPlaylists());
    } catch (e) {
      setError(String(e));
      setLists([]);
    }
  }

  useEffect(() => {
    if (IN_TAURI) void refresh();
    else setLists([]);
  }, []);

  async function open(id: string) {
    setError(null);
    setStatus(null);
    onOpenId?.(id);
    try {
      setSelected(await getPlaylist(id));
    } catch (e) {
      setError(String(e));
    }
  }
  function back() {
    setSelected(null);
    setRenaming(false);
    setStatus(null);
    onOpenId?.(null);
  }

  // Open whatever the rail asked for.
  useEffect(() => {
    if (openId && selected?.id !== openId) void open(openId);
    if (!openId && selected) setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  // Re-fetch (list + open detail) when something changed elsewhere (e.g. a drag-to-add).
  useEffect(() => {
    if (!IN_TAURI || refreshKey === undefined) return;
    void refresh();
    if (selected) void open(selected.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    if (!IN_TAURI) {
      onReady?.({ desktopOnly: true, available: false });
      return;
    }
    if (lists === null) return;
    onReady?.({
      playlists: lists.length,
      selected: selected ? selected.id : null,
      tracks: selected?.tracks.length ?? 0,
      busy: !!busy,
    });
  }, [busy, lists, onReady, selected]);

  async function doCreate() {
    const name = newName.trim();
    if (!name) return;
    setBusy("create");
    setError(null);
    try {
      const p = await createPlaylist(name);
      setNewName("");
      setCreating(false);
      await refresh();
      onChanged?.();
      setSelected(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doSpotify() {
    const link = spotifyLink.trim();
    if (!link) return;
    setBusy("spotify");
    setError(null);
    setStatus(null);
    try {
      const p = await spotifyToPlaylist(link);
      setSpotifyLink("");
      await refresh();
      onChanged?.();
      setSelected(p);
      setStatus(`Saved “${p.name}” — ${p.tracks.length} song${p.tracks.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doImport() {
    setError(null);
    setStatus(null);
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const file = await openDialog({
        multiple: false,
        filters: [{ name: "Playlists", extensions: ["m3u8", "m3u", "pls", "xspf"] }],
      });
      if (typeof file !== "string") return;
      setBusy("import");
      const p = await importPlaylist(file);
      await refresh();
      onChanged?.();
      setSelected(p);
      setStatus(`Imported “${p.name}” — ${p.tracks.length} track${p.tracks.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doDelete(p: Playlist) {
    setBusy("delete");
    try {
      await deletePlaylist(p.id);
      setSelected(null);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doRename() {
    if (!selected) return;
    const name = renameVal.trim();
    if (!name) return;
    setBusy("rename");
    try {
      const p = await renamePlaylist(selected.id, name);
      setSelected(p);
      setRenaming(false);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doExport() {
    if (!selected) return;
    setBusy("export");
    setError(null);
    setStatus(null);
    try {
      setStatus(await exportPlaylist(selected.id, format));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function removeTrack(index: number) {
    if (!selected) return;
    try {
      const p = await playlistRemoveTrack(selected.id, index);
      setSelected(p);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(String(e));
    }
  }

  function playablesOf(p: Playlist): { track: PlayerTrack; index: number }[] {
    return p.tracks
      .map((t, index) => ({ t, index }))
      .filter(({ t }) => !!t.url)
      .map(({ t, index }) => ({
        index,
        track: { id: `${p.id}:${index}`, title: t.title, artist: t.artist || undefined, album: t.album || undefined, url: t.url! },
      }));
  }

  function playAll(p: Playlist) {
    const q = playablesOf(p);
    if (q.length) player.play(q.map((x) => x.track), 0);
  }

  function playFrom(p: Playlist, trackIndex: number) {
    const q = playablesOf(p);
    const at = q.findIndex((x) => x.index === trackIndex);
    if (at >= 0) player.play(q.map((x) => x.track), at);
  }

  function playShuffled(p: Playlist) {
    const q = playablesOf(p).map((x) => x.track);
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    if (q.length) player.play(q, 0);
  }

  async function reorder(from: number, to: number) {
    if (!selected || from === to) return;
    const arr = [...selected.tracks];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    setSelected({ ...selected, tracks: arr }); // optimistic
    try {
      const p = await setPlaylistTracks(selected.id, arr);
      setSelected(p);
      onChanged?.();
    } catch (e) {
      setError(String(e));
    }
  }

  if (!IN_TAURI) {
    return (
      <div className="section-stack media-wide">
        <div className="cat-header">
          <span className="cat-title section-title"><Icon icon={listMusic} size="base" /> Playlists</span>
        </div>
        <p className="field-hint">Playlists run in the desktop app.</p>
      </div>
    );
  }

  // ----- detail view -----
  if (selected) {
    const downloaded = selected.tracks.filter((t) => t.url).length;
    const hue = hueFromString(selected.name);
    const grad = `linear-gradient(160deg, hsl(${hue} 46% 32%), hsl(${(hue + 28) % 360} 40% 11%) 78%)`;
    const sourceLabel = selected.source === "spotify" ? "Spotify" : selected.source === "import" ? "Imported" : "Manual";
    const totalMs = selected.tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
    // Playlist tracks carry no embedded art, so derive a cover from the first track via the relay.
    const coverSeed = selected.tracks.find((t) => t.album || t.title);
    const cover = coverSeed ? relayMusicUrl(coverSeed.album || coverSeed.title, coverSeed.artist) : undefined;
    return (
      <div className="section-stack media-wide pl-detail">
        <button className="series-back" onClick={back}>
          <Icon icon={chevronLeft} size="sm" /> Playlists
        </button>

        <header className="pl-hero" style={{ background: grad }}>
          <PlaylistHeroCover cover={cover} hue={hue} />
          <div className="pl-hero-info">
            <span className="pl-hero-kind">Playlist</span>
            {renaming ? (
              <div className="pl-rename-row pl-hero-rename">
                <Input autoFocus value={renameVal} onChange={(e) => setRenameVal(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") void doRename(); if (e.key === "Escape") setRenaming(false); }} />
                <Button size="sm" variant="primary" icon={check} loading={busy === "rename"} onClick={doRename}>Save</Button>
                <Button size="sm" variant="ghost" icon={x} onClick={() => setRenaming(false)}>Cancel</Button>
              </div>
            ) : (
              <h1 className="pl-hero-title" title="Click to rename" onClick={() => { setRenameVal(selected.name); setRenaming(true); }}>{selected.name}</h1>
            )}
            <div className="pl-hero-meta">
              <span>{sourceLabel}</span>
              <span className="dot" />
              <span>{selected.tracks.length} song{selected.tracks.length === 1 ? "" : "s"}</span>
              <span className="dot" />
              <span>{downloaded} downloaded</span>
              {totalMs > 0 && (<><span className="dot" /><span>{fmtTotal(totalMs)}</span></>)}
            </div>
          </div>
        </header>

        <div className="pl-actions">
          <Button variant="primary" shape="pill" size="lg" icon={playIcon} disabled={downloaded === 0} onClick={() => playAll(selected)}>
            Play{downloaded < selected.tracks.length && downloaded > 0 ? ` (${downloaded})` : ""}
          </Button>
          <Button variant="secondary" shape="pill" size="lg" icon={shuffle} disabled={downloaded === 0} onClick={() => playShuffled(selected)}>Shuffle</Button>
          <span className="pl-actions-spacer" />
          <span className="pl-export">
            <select className="pl-format" value={format} onChange={(e) => setFormat(e.currentTarget.value as PlaylistFormat)}>
              {FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}
            </select>
            <Button variant="secondary" icon={folderOutput} loading={busy === "export"} disabled={downloaded === 0} onClick={doExport}>
              Export
            </Button>
          </span>
          <Button variant="ghost" icon={trash2} loading={busy === "delete"} onClick={() => doDelete(selected)}>Delete</Button>
        </div>

        {downloaded === 0 && (
          <p className="field-hint pl-hint">
            None of these songs are downloaded yet — replicate the playlist from the search box, or grab the tracks, then they’ll
            light up here and become exportable.
          </p>
        )}
        {status && <p className="settings-status">{status}</p>}
        {error && <p className="settings-status spotify-error">{error}</p>}

        <div className="pl-tracks">
          {selected.tracks.map((t, i) => (
            <div
              className={`pl-track${t.url ? " has-file" : ""}${dragIndex === i ? " is-dragging" : ""}${overIndex === i && dragIndex !== i ? " is-over" : ""}`}
              key={`${t.title}-${i}`}
              draggable
              onDragStart={(e) => { setDragIndex(i); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { e.preventDefault(); if (dragIndex !== null && overIndex !== i) setOverIndex(i); }}
              onDrop={(e) => { e.preventDefault(); if (dragIndex !== null) void reorder(dragIndex, i); setDragIndex(null); setOverIndex(null); }}
              onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
            >
              <button className="pl-track-idx" disabled={!t.url} onClick={() => playFrom(selected, i)} title={t.url ? "Play" : "Not downloaded"}>
                <span className="pl-num">{i + 1}</span>
                {t.url && <span className="pl-play-glyph"><Icon icon={playIcon} size="xs" /></span>}
              </button>
              <div className="pl-track-meta">
                <div className="pl-track-name" title={t.title}>{t.title}</div>
                <div className="pl-track-artist">{[t.artist, t.album].filter(Boolean).join(" · ")}</div>
              </div>
              <span className="pl-track-dur">{fmtDur(t.durationMs)}</span>
              <button className="pl-track-x" title="Remove from playlist" onClick={() => removeTrack(i)}>
                <Icon icon={x} size="xs" />
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ----- master / list view -----
  return (
    <div className="section-stack media-wide">
      <div className="cat-header">
        <span className="cat-title section-title"><Icon icon={listMusic} size="base" /> Playlists</span>
        {lists && lists.length > 0 && <span className="cat-sub">{lists.length} playlist{lists.length === 1 ? "" : "s"}</span>}
        <div className="cat-controls">
          <Button variant="secondary" shape="pill" icon={rotateCw} onClick={() => void refresh()}>Refresh</Button>
        </div>
      </div>

      <div className="settings-group">
        <div className="search-bar-lg">
          <Input
            iconLeft={music}
            shape="pill"
            size="lg"
            placeholder="Paste a Spotify playlist link to save it as a playlist..."
            value={spotifyLink}
            onChange={(e) => setSpotifyLink(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && doSpotify()}
          />
          <Button variant="primary" shape="pill" size="lg" icon={downloadIcon} loading={busy === "spotify"} disabled={!spotifyLink.trim()} onClick={doSpotify}>
            Save
          </Button>
        </div>

        <div className="form-actions pl-head-actions">
          {creating ? (
            <span className="pl-new-row">
              <Input autoFocus placeholder="Playlist name…" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") void doCreate(); if (e.key === "Escape") setCreating(false); }} />
              <Button size="sm" variant="primary" icon={check} loading={busy === "create"} onClick={doCreate}>Create</Button>
              <Button size="sm" variant="ghost" icon={x} onClick={() => setCreating(false)}>Cancel</Button>
            </span>
          ) : (
            <>
              <Button size="sm" variant="secondary" icon={plus} onClick={() => setCreating(true)}>New</Button>
              <Button size="sm" variant="ghost" icon={folderDown} loading={busy === "import"} onClick={doImport}>Import</Button>
            </>
          )}
        </div>

      {status && <p className="settings-status">{status}</p>}
      {error && <p className="settings-status spotify-error">{error}</p>}
      </div>

      {lists === null ? (
        <div className="spotify-loading"><Spinner size="md" /></div>
      ) : lists.length === 0 ? (
        <div className="pl-empty">
          <Icon icon={listMusic} size="lg" />
          <p>No playlists yet.</p>
          <p className="field-hint">Save from a Spotify link, import M3U/PLS/XSPF, or create a new playlist.</p>
        </div>
      ) : (
        <div className="pl-grid">
          {sortedLists.map((p) => <PlaylistCard key={p.id} playlist={p} onOpen={() => open(p.id)} />)}
        </div>
      )}
    </div>
  );
}

/** Big square hero cover for the detail page: relay art when it resolves, else a tinted
 *  gradient + glyph (mirrors how the now-playing dock degrades). */
function PlaylistHeroCover({ cover, hue }: { cover?: string; hue: number }) {
  const [failed, setFailed] = useState(false);
  const bg = `linear-gradient(150deg, hsl(${hue} 38% 30%), hsl(${(hue + 40) % 360} 44% 14%))`;
  const src = cover && !failed ? cover : undefined;
  return (
    <div className="pl-hero-cover" style={src ? undefined : { background: bg }}>
      {src
        ? <img src={src} alt="" onError={() => setFailed(true)} />
        : <span className="pl-hero-glyph"><Icon icon={listMusic} size="2xl" /></span>}
    </div>
  );
}

function PlaylistCard({ playlist, onOpen }: { playlist: Playlist; onOpen: () => void }) {
  const downloaded = playlist.tracks.filter((t) => t.url).length;
  const hue = hueFromString(playlist.name);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;

  return (
    <button className="poster-card pl-poster-card" onClick={onOpen}>
      <span className="poster square" style={{ background: bg }}>
        <span className="poster-glyph"><Icon icon={listMusic} size="2xl" /></span>
        <span className="poster-seed">
          <span>{downloaded}/{playlist.tracks.length}</span>
          <span className="play-badge"><Icon icon={playIcon} size="base" /></span>
        </span>
      </span>
      <span className="poster-meta">
        <span className="poster-name" title={playlist.name}>{playlist.name}</span>
        <span className="poster-info">
          <span>{playlist.tracks.length} song{playlist.tracks.length === 1 ? "" : "s"}</span>
          <span className="dot" />
          <span>{downloaded} downloaded</span>
        </span>
        <span className="poster-info pl-source-row">
          {playlist.source === "spotify" ? "Spotify" : playlist.source === "import" ? "Imported" : "Manual"}
        </span>
      </span>
    </button>
  );
}
