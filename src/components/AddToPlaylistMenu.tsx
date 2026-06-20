import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { createPlaylist, listPlaylists, playlistAddTracks, type Playlist, type PlaylistTrack } from "../ipc/playlists";
import { check, listMusic, plus } from "../lib/icons";

interface Props {
  x: number;
  y: number;
  /** Songs to add (one for a track, all of them for an album/artist). */
  tracks: PlaylistTrack[];
  onClose: () => void;
  /** Surfaced as a small toast by the parent. */
  onAdded?: (message: string) => void;
}

/**
 * Spotify-style "Add to playlist" flyout: lists existing playlists plus a "New playlist"
 * button (with inline naming). Opened from a music context-menu item, anchored at the
 * click. Adding resolves local files server-side, so the songs become exportable.
 */
export function AddToPlaylistMenu({ x, y, tracks, onClose, onAdded }: Props) {
  const [lists, setLists] = useState<Playlist[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    listPlaylists().then(setLists).catch(() => setLists([]));
  }, []);

  // Dismiss on outside click / Escape — deferred so the opening click doesn't close it.
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const id = window.setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
      window.addEventListener("resize", close);
    }, 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const count = tracks.length === 1 ? "1 song" : `${tracks.length} songs`;

  async function addTo(p: Playlist) {
    setBusy(true);
    try {
      await playlistAddTracks(p.id, tracks);
      onAdded?.(`Added ${count} to “${p.name}”.`);
      onClose();
    } catch {
      setBusy(false);
    }
  }

  async function createAndAdd() {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      const p = await createPlaylist(n, tracks);
      onAdded?.(`Created “${p.name}” with ${count}.`);
      onClose();
    } catch {
      setBusy(false);
    }
  }

  const style: CSSProperties = {
    left: Math.min(x, window.innerWidth - 290),
    top: Math.min(y, window.innerHeight - 380),
  };

  return createPortal(
    <div
      className="ctx-menu atp-menu"
      style={style}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="atp-head">Add to playlist</div>

      {creating ? (
        <div className="atp-new">
          <input
            autoFocus
            className="atp-input"
            placeholder="Playlist name…"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createAndAdd();
              if (e.key === "Escape") { e.stopPropagation(); setCreating(false); }
            }}
          />
          <button className="atp-go" disabled={!name.trim() || busy} onClick={() => void createAndAdd()} aria-label="Create">
            <Icon icon={check} size="sm" />
          </button>
        </div>
      ) : (
        <button className="ctx-item atp-create" onClick={() => setCreating(true)}>
          <Icon icon={plus} size="sm" />
          <span>New playlist</span>
        </button>
      )}

      <div className="atp-sep" />
      <div className="atp-list">
        {lists === null ? (
          <div className="atp-state"><Spinner size="sm" /></div>
        ) : lists.length === 0 ? (
          <div className="atp-state">No playlists yet</div>
        ) : (
          lists.map((p) => (
            <button key={p.id} className="ctx-item atp-item" disabled={busy} onClick={() => void addTo(p)} title={p.name}>
              <Icon icon={listMusic} size="sm" />
              <span className="atp-name">{p.name}</span>
              <span className="atp-count">{p.tracks.length}</span>
            </button>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}
