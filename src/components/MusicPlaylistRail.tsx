import { useCallback, useEffect, useState, type DragEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import {
  createPlaylist,
  deletePlaylist,
  findLiked,
  getDragTracks,
  listPlaylists,
  playlistAddTracks,
  renamePlaylist,
  LIKED_PLAYLIST_NAME,
  type Playlist,
} from "../ipc/playlists";
import { useContextMenu, type MenuAction } from "./ContextMenu";
import { check, heart, listMusic, plus, tag, trash2, x as xIcon } from "../lib/icons";
import { relayMusicUrl } from "../lib/relay";
import "./MusicPlaylistRail.css";

interface Props {
  /** Currently-open playlist id (highlighted). */
  activeId?: string | null;
  /** Open a playlist's detail. */
  onOpen: (id: string) => void;
  /** Bumped by the parent to force a re-fetch (e.g. after a track was added elsewhere). */
  refreshKey?: number;
  onToast?: (message: string) => void;
  /** Render inside the shell Sidebar (no extra outer card chrome). */
  embedded?: boolean;
}

/** Spotify-style "Your Library" rail: every playlist (Liked Songs pinned), a New-playlist
 *  button, and each row is a drop target — drag a song/album/artist onto it to add. */
export function MusicPlaylistRail({ activeId, onOpen, refreshKey, onToast, embedded = false }: Props) {
  const [lists, setLists] = useState<Playlist[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [dropId, setDropId] = useState<string | null>(null); // "new" | playlist id being hovered
  const ctx = useContextMenu();

  const refresh = useCallback(() => {
    listPlaylists().then(setLists).catch(() => setLists([]));
  }, []);
  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  const liked = findLiked(lists);
  const others = lists.filter((p) => p.name !== LIKED_PLAYLIST_NAME);

  async function doCreate(): Promise<void> {
    const n = name.trim();
    if (!n) return;
    const p = await createPlaylist(n).catch(() => null);
    setName("");
    setCreating(false);
    refresh();
    if (p) onOpen(p.id);
  }

  async function dropOn(id: string, e: DragEvent): Promise<void> {
    e.preventDefault();
    setDropId(null);
    const tracks = getDragTracks(e.dataTransfer);
    if (!tracks || tracks.length === 0) return;
    const list = lists.find((p) => p.id === id);
    const updated = await playlistAddTracks(id, tracks).catch(() => null);
    if (updated) {
      refresh();
      onToast?.(`Added ${tracks.length === 1 ? "1 song" : `${tracks.length} songs`} to “${list?.name ?? "playlist"}”.`);
    }
  }

  async function renameFromMenu(p: Playlist): Promise<void> {
    if (p.name === LIKED_PLAYLIST_NAME) return;
    const next = window.prompt("Rename playlist", p.name);
    const name = (next ?? "").trim();
    if (!name || name === p.name) return;
    const updated = await renamePlaylist(p.id, name).catch(() => null);
    if (!updated) return;
    onToast?.(`Renamed playlist to "${updated.name}".`);
    if (activeId === p.id) onOpen(p.id);
    refresh();
  }

  async function deleteFromMenu(p: Playlist): Promise<void> {
    if (p.name === LIKED_PLAYLIST_NAME) return;
    if (!window.confirm(`Delete playlist "${p.name}"?`)) return;
    const ok = await deletePlaylist(p.id).then(() => true).catch(() => false);
    if (!ok) return;
    const remaining = lists.filter((x) => x.id !== p.id);
    setLists(remaining);
    onToast?.(`Deleted "${p.name}".`);
    if (activeId === p.id) {
      const fallback = findLiked(remaining) ?? remaining[0];
      if (fallback) onOpen(fallback.id);
    }
    refresh();
  }

  function playlistActions(p: Playlist): MenuAction[] {
    const actions: MenuAction[] = [
      { label: "Open", icon: listMusic, onSelect: () => onOpen(p.id) },
    ];
    if (p.name !== LIKED_PLAYLIST_NAME) {
      actions.push({ label: "Rename…", icon: tag, onSelect: () => void renameFromMenu(p) });
      actions.push({ label: "Delete", icon: trash2, divider: true, danger: true, onSelect: () => void deleteFromMenu(p) });
    }
    return actions;
  }

  async function dropNew(e: DragEvent): Promise<void> {
    e.preventDefault();
    setDropId(null);
    const tracks = getDragTracks(e.dataTransfer);
    if (!tracks || tracks.length === 0) return;
    const base = tracks[0]?.album || tracks[0]?.artist || "New Playlist";
    const p = await createPlaylist(base, tracks).catch(() => null);
    if (p) {
      refresh();
      onToast?.(`Created “${p.name}” with ${tracks.length === 1 ? "1 song" : `${tracks.length} songs`}.`);
      onOpen(p.id);
    }
  }

  const allow = (id: string) => (e: DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-ghosty-tracks")) {
      e.preventDefault();
      setDropId(id);
    }
  };

  function row(p: Playlist, isLiked: boolean) {
    return (
      <button
        key={p.id}
        className={`mpr-row${activeId === p.id ? " active" : ""}${dropId === p.id ? " dropping" : ""}`}
        onClick={() => onOpen(p.id)}
        onContextMenu={(e) => ctx.open(e, playlistActions(p))}
        onDragOver={allow(p.id)}
        onDragLeave={() => setDropId((d) => (d === p.id ? null : d))}
        onDrop={(e) => void dropOn(p.id, e)}
        title={p.name}
      >
        <PlaylistCover p={p} isLiked={isLiked} />
        <span className="mpr-meta">
          <span className="mpr-name">{p.name}</span>
          <span className="mpr-sub">{p.tracks.length} song{p.tracks.length === 1 ? "" : "s"}</span>
        </span>
      </button>
    );
  }

  return (
    <div className={`mpr${embedded ? " mpr-inline" : ""}`}>
      <div className="mpr-head">
        <span className="mpr-title"><Icon icon={listMusic} size="sm" /> Your Library</span>
        {!creating && (
          <button className="mpr-new-btn" title="New playlist" aria-label="New playlist" onClick={() => setCreating(true)}>
            <Icon icon={plus} size="sm" />
          </button>
        )}
      </div>

      {creating && (
        <div className="mpr-new-row">
          <input
            autoFocus
            className="mpr-input"
            placeholder="Playlist name…"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doCreate(); if (e.key === "Escape") setCreating(false); }}
          />
          <button className="mpr-go" disabled={!name.trim()} onClick={() => void doCreate()} aria-label="Create"><Icon icon={check} size="sm" /></button>
          <button className="mpr-cancel" onClick={() => setCreating(false)} aria-label="Cancel"><Icon icon={xIcon} size="sm" /></button>
        </div>
      )}

      <div className="mpr-list">
        {liked && row(liked, true)}
        {others.map((p) => row(p, false))}
        {/* Drop here to create a new playlist from the dragged songs. */}
        <div
          className={`mpr-dropnew${dropId === "new" ? " dropping" : ""}`}
          onDragOver={allow("new")}
          onDragLeave={() => setDropId((d) => (d === "new" ? null : d))}
          onDrop={(e) => void dropNew(e)}
        >
          <Icon icon={plus} size="sm" /> Drop to make a playlist
        </div>
      </div>
      {ctx.menu}
    </div>
  );
}

/** Playlist cover: real album art (via the artwork relay, keyed off the first track),
 *  falling back to the list/heart glyph when there's no match or the relay 404s. */
function PlaylistCover({ p, isLiked }: { p: Playlist; isLiked: boolean }) {
  const [failed, setFailed] = useState(false);
  const seed = isLiked ? undefined : p.tracks.find((t) => t.title || t.album || t.artist);
  const cover = seed ? relayMusicUrl(seed.album || seed.title, seed.artist) : undefined;
  if (cover && !failed) {
    return (
      <span className="mpr-cover">
        <img src={cover} alt="" loading="lazy" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span className={`mpr-cover${isLiked ? " liked" : ""}`}>
      <Icon icon={isLiked ? heart : listMusic} size="sm" />
    </span>
  );
}
