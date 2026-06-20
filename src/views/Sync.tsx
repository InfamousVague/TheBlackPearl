import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Toggle } from "@mattmattmattmatt/base/primitives/toggle/Toggle";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { SegmentedControl } from "@mattmattmattmatt/base/primitives/segmented-control/SegmentedControl";
import {
  listDevices,
  onDeviceSyncProgress,
  syncMusicToDevice,
  type DeviceSyncResult,
  type DeviceSyncStep,
  type PlaylistMode,
  type SyncDevice,
} from "../ipc/devices";
import { getSetting, setSetting } from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { formatBytes } from "../lib/format";
import { arrowDownUp, check, circleAlert, circleCheck, hardDrive, listMusic, rotateCw, trash2, triangleAlert } from "../lib/icons";
import "./Sync.css";

const FOLDER_SETTING = "device_sync_folder";
const PLAYLISTS_SETTING = "device_sync_playlists";
const PLAYLIST_MODE_SETTING = "device_playlist_mode";
const DEFAULT_FOLDER = "Music";
/** Most-recent rows kept in the live feed (running tallies stay exact regardless). */
const FEED_CAP = 80;

type Action = DeviceSyncStep["action"];

interface SyncProps {
  /** Signals when the view is first usable for perf timing. */
  onReady?: (meta?: Record<string, string | number | boolean | null>) => void;
}

interface FeedRow {
  /** Monotonic key so React keeps rows stable as new ones prepend. */
  seq: number;
  file: string;
  action: Action;
  message: string | null;
}

interface Tally {
  copied: number;
  skipped: number;
  deleted: number;
  error: number;
  playlist: number;
}

const ZERO_TALLY: Tally = { copied: 0, skipped: 0, deleted: 0, error: 0, playlist: 0 };

const ACTION_META: Record<Action, { icon: string; label: string; cls: string }> = {
  copying: { icon: arrowDownUp, label: "Copying", cls: "copying" },
  copied: { icon: circleCheck, label: "Copied", cls: "copied" },
  skipped: { icon: check, label: "Already there", cls: "skipped" },
  deleted: { icon: trash2, label: "Removed", cls: "deleted" },
  error: { icon: circleAlert, label: "Failed", cls: "error" },
  playlist: { icon: listMusic, label: "Playlist", cls: "copied" },
};

/** Turn an `Artist/Album/NN - Title.ext` rel path into a friendly title + subtitle. */
function prettyTrack(rel: string): { title: string; sub: string } {
  const parts = rel.split("/");
  const file = parts[parts.length - 1] ?? rel;
  const title = file.replace(/\.[^.]+$/, "").replace(/^\s*\d+\s*[-.]\s*/, "").trim() || file;
  const artist = parts.length >= 2 ? parts[0] : "";
  const album = parts.length >= 3 ? parts[1] : "";
  const sub = [artist, album].filter(Boolean).join(" · ");
  return { title, sub };
}

/** A whole page (under Music ▸ Sync) for copying the Library's music onto a connected MP3
 *  player or SD card, with a live per-song feed of what's being transferred right now. */
export function Sync({ onReady }: SyncProps) {
  const { items: all } = useDownloaded();
  const trackCount = useMemo(
    () => (all ?? []).filter((i) => i.mediaType === "music" && i.inLibrary).length,
    [all],
  );

  const [devices, setDevices] = useState<SyncDevice[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [folder, setFolder] = useState(DEFAULT_FOLDER);
  const [mirror, setMirror] = useState(false);
  const [syncPlaylists, setSyncPlaylists] = useState(true);
  const [playlistMode, setPlaylistMode] = useState<PlaylistMode>("m3u8");
  const [error, setError] = useState<string | null>(null);

  // Live-sync state (one device at a time; the buttons are disabled while a sync runs).
  const [syncingMount, setSyncingMount] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [phase, setPhase] = useState<"copy" | "mirror" | "playlists" | null>(null);
  const [bar, setBar] = useState<{ done: number; total: number } | null>(null);
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [tally, setTally] = useState<Tally>(ZERO_TALLY);
  const [result, setResult] = useState<{ mount: string; res: DeviceSyncResult } | null>(null);

  const folderRef = useRef(DEFAULT_FOLDER);
  const activeRef = useRef(false);
  const scanningRef = useRef(false);
  const seqRef = useRef(0);
  const phaseRef = useRef<string | null>(null);

  folderRef.current = folder;
  activeRef.current = syncingMount !== null;

  async function rescan() {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);
    try {
      setDevices(await listDevices(folderRef.current));
    } catch (e) {
      setError(String(e));
    } finally {
      scanningRef.current = false;
      setScanning(false);
    }
  }

  // Load the saved folder name, then scan. Poll every 15s (only when visible + idle) so
  // plugging a device in or pulling one out shows up without a manual rescan.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [savedFolder, savedPl, savedMode] = await Promise.all([
        getSetting(FOLDER_SETTING).catch(() => null),
        getSetting(PLAYLISTS_SETTING).catch(() => null),
        getSetting(PLAYLIST_MODE_SETTING).catch(() => null),
      ]);
      if (!alive) return;
      const folderVal = savedFolder?.trim();
      if (folderVal) {
        setFolder(folderVal);
        folderRef.current = folderVal;
      }
      if (savedPl === "0" || savedPl === "1") setSyncPlaylists(savedPl === "1");
      if (savedMode === "folders" || savedMode === "m3u8") setPlaylistMode(savedMode);
      await rescan();
    })();
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && !activeRef.current && !scanningRef.current) {
        void rescan();
      }
    }, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single live subscription; functional updates keep it free of stale closures. Ignored
  // unless a sync is in flight (activeRef), so stray events never mutate idle state. The
  // `cancelled` guard unsubscribes even if listen() resolves AFTER cleanup — otherwise the
  // StrictMode mount/cleanup/remount cycle (and unmount-before-resolve) would leak a native
  // listener and double every feed row + tally.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    onDeviceSyncProgress((step) => {
      if (!activeRef.current) return;
      // Each phase (copy → mirror → playlists) has its own denominator, so on a phase change
      // blank the bar (it shows indeterminate) rather than snapping it backward from ~100%.
      if (step.phase !== phaseRef.current) {
        phaseRef.current = step.phase;
        setPhase(step.phase);
        setBar(null);
      } else {
        setBar({ done: step.done, total: step.total });
      }
      if (step.action === "copying") {
        setCurrent(step.file);
        return;
      }
      // Capture the narrowed action in a const so it stays typed (without "copying") inside
      // the setState closures below — TS widens property narrowing across function boundaries.
      const action = step.action;
      setCurrent((cur) => (cur === step.file ? null : cur));
      setTally((t) => ({ ...t, [action]: t[action] + 1 }));
      setFeed((f) => {
        const row: FeedRow = { seq: ++seqRef.current, file: step.file, action, message: step.message };
        return [row, ...f].slice(0, FEED_CAP);
      });
    }).then((fn) => {
      if (cancelled) fn();
      else un = fn;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  function onFolderChange(value: string) {
    setFolder(value);
    folderRef.current = value;
    void setSetting(FOLDER_SETTING, value.trim() || DEFAULT_FOLDER).catch(() => {});
  }

  function onPlaylistsChange(on: boolean) {
    setSyncPlaylists(on);
    void setSetting(PLAYLISTS_SETTING, on ? "1" : "0").catch(() => {});
  }

  function onPlaylistModeChange(mode: PlaylistMode) {
    setPlaylistMode(mode);
    void setSetting(PLAYLIST_MODE_SETTING, mode).catch(() => {});
  }

  async function sync(device: SyncDevice) {
    setError(null);
    setResult(null);
    setFeed([]);
    setTally(ZERO_TALLY);
    setCurrent(null);
    setBar(null);
    setPhase(null);
    phaseRef.current = null;
    setSyncingMount(device.mountPath);
    try {
      const res = await syncMusicToDevice(device.mountPath, folder, mirror, syncPlaylists, playlistMode);
      setResult({ mount: device.mountPath, res });
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncingMount(null);
      setCurrent(null);
      void rescan(); // refresh the "N synced" counts
    }
  }

  const cleanFolder = folder.trim() || DEFAULT_FOLDER;
  const percent = bar && bar.total > 0 ? Math.min(100, Math.round((bar.done / bar.total) * 100)) : null;
  const currentPretty = current ? prettyTrack(current) : null;

  // Signal ready on FIRST paint — the view shows its "Looking for devices…" state immediately
  // while listDevices() (a recursive count_audio disk walk) runs in the background. Gating ready
  // on `devices` made navigating to Music's Sync tab block for ~8s on a large library.
  const readyFired = useRef(false);
  useEffect(() => {
    if (readyFired.current) return;
    readyFired.current = true;
    onReady?.({
      devices: devices?.length ?? 0,
      syncing: syncingMount !== null,
      trackCount,
    });
  }, [onReady, devices, syncingMount, trackCount]);

  return (
    <div className="section-stack media-wide sync-page">
      <div className="cat-header">
        <span className="cat-title section-title"><Icon icon={hardDrive} size="base" /> Sync</span>
        <span className="cat-sub">Library tracks: {trackCount}</span>
        <div className="cat-controls">
          <Button variant="ghost" icon={rotateCw} loading={scanning} onClick={() => void rescan()}>Rescan</Button>
        </div>
      </div>

      <div className="settings-group">
        <p className="field-hint">
          Copy library music to a connected MP3 player or SD card in <code>{cleanFolder}/Artist/Album</code>.
          Re-sync only copies new tracks.
        </p>

        <div className="sync-controls">
          <label className="field-hint sync-folder">
            Folder
            <Input
              value={folder}
              placeholder={DEFAULT_FOLDER}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onFolderChange(e.currentTarget.value)}
              disabled={syncingMount !== null}
            />
          </label>
          <Toggle
            className="sync-mirror"
            title="Also delete tracks on the device that are no longer in your Library"
            label="Mirror (remove extras)"
            checked={mirror}
            onChange={(e) => setMirror(e.currentTarget.checked)}
            disabled={syncingMount !== null}
          />
        </div>
        {mirror && (
          <p className="field-hint sync-warn">
            <Icon icon={triangleAlert} size="sm" /> Mirror deletes audio in <code>{cleanFolder}/</code> that isn&apos;t in your Library. Other files are unchanged.
          </p>
        )}

        <div className="sync-controls">
          <Toggle
            className="sync-mirror"
            title="Also write your playlists into a Playlists/ folder at the device root"
            label="Create playlists"
            checked={syncPlaylists}
            onChange={(e) => onPlaylistsChange(e.currentTarget.checked)}
            disabled={syncingMount !== null}
          />
          {syncPlaylists && (
            <SegmentedControl
              className="sync-mode"
              options={[
                { value: "m3u8", label: ".m3u8 files", disabled: syncingMount !== null },
                { value: "folders", label: "Folders", disabled: syncingMount !== null },
              ]}
              value={playlistMode}
              onChange={(v) => onPlaylistModeChange(v as PlaylistMode)}
            />
          )}
        </div>
        {syncPlaylists && (
          <p className="field-hint">
            <Icon icon={listMusic} size="sm" />{" "}
            {playlistMode === "m3u8" ? (
              <>Writes <code>Playlists/&lt;name&gt;.m3u8</code> at the device root with relative paths to <code>{cleanFolder}/</code> — <b>no audio duplicated</b>.</>
            ) : (
              <>Creates a folder per playlist in <code>Playlists/</code> and <b>copies</b> tracks in order. This <b>duplicates</b> those tracks on the card.</>
            )}
          </p>
        )}
      </div>

      {devices === null ? (
        <p className="field-hint">Looking for connected devices…</p>
      ) : devices.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <span className="empty-glyph"><Icon icon={hardDrive} size="xl" /></span>
            <h3>No devices connected</h3>
            <p>Plug in an MP3 player or SD card, then <b>Rescan</b>. It&apos;ll show up here with a Sync button.</p>
          </div>
        </div>
      ) : (
        <div className="device-list">
          {devices.map((d) => {
            const used = d.totalBytes > 0 ? Math.min(100, Math.max(0, ((d.totalBytes - d.freeBytes) / d.totalBytes) * 100)) : 0;
            const isActive = syncingMount === d.mountPath;
            const done = result?.mount === d.mountPath && !isActive ? result.res : null;
            return (
              <div key={d.mountPath} className={`device-row${isActive ? " is-active" : ""}`}>
                <span className="device-icon"><Icon icon={hardDrive} size="base" /></span>
                <div className="device-main">
                  <div className="device-name">
                    {d.name}
                    {d.fileSystem && <Chip size="sm" variant="outlined">{d.fileSystem}</Chip>}
                    {d.hasSyncFolder && <span className="device-synced">{d.syncedTracks} synced</span>}
                  </div>
                  <div className="device-cap">
                    <div className="device-cap-bar"><div className="device-cap-fill" style={{ width: `${used}%` }} /></div>
                    <span className="device-cap-text">{formatBytes(d.freeBytes)} free of {formatBytes(d.totalBytes)}</span>
                  </div>
                  {done && (
                    <p className={`field-hint ${done.errors > 0 ? "sync-warn" : "device-done"}`}>
                      <Icon icon={done.errors > 0 ? triangleAlert : circleCheck} size="sm" /> {summarize(done)}
                    </p>
                  )}
                </div>
                <Button
                  variant="primary"
                  shape="pill"
                  icon={arrowDownUp}
                  loading={isActive}
                  disabled={trackCount === 0 || syncingMount !== null}
                  onClick={() => void sync(d)}
                >
                  {isActive ? "Syncing…" : d.hasSyncFolder ? "Re-sync" : "Sync"}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {error && <p className="field-hint sync-warn">{error}</p>}

      {syncingMount && (
        <div className="sync-live">
          {/* Only this concise line is announced; the bar, now-playing block and the
              high-churn feed below are aria-hidden so a screen reader isn't flooded. */}
          <div className="sync-live-head" role="status" aria-live="polite">
            <span className="field-label">
              {phase === "mirror" ? "Removing extras" : phase === "playlists" ? "Writing playlists" : "Syncing"}
              {percent != null && <span className="sync-live-pct"> · {percent}%</span>}
            </span>
            <span className="field-hint">
              {bar ? `${bar.done} of ${bar.total}` : "Starting…"}
            </span>
          </div>

          <div className={`sync-bar${percent == null ? " is-indeterminate" : ""}`} aria-hidden="true">
            <div className="sync-bar-fill" style={percent == null ? undefined : { width: `${percent}%` }} />
          </div>

          {(phase === null || phase === "copy") && (
            <div className="sync-now" aria-hidden="true">
              <span className="sync-now-disc"><Spinner size="sm" /></span>
              {currentPretty ? (
                <div className="sync-now-body">
                  <div className="sync-now-title" title={currentPretty.title}>{currentPretty.title}</div>
                  {currentPretty.sub && <div className="sync-now-sub" title={currentPretty.sub}>{currentPretty.sub}</div>}
                </div>
              ) : (
                <div className="sync-now-body"><div className="sync-now-title">Preparing…</div></div>
              )}
            </div>
          )}

          <SyncTallies tally={tally} />

          {feed.length > 0 && (
            <ul className="sync-feed" aria-hidden="true">
              {feed.map((row) => {
                const meta = ACTION_META[row.action];
                const pretty = prettyTrack(row.file);
                const actionText = row.message ? `${meta.label} · ${row.message}` : meta.label;
                return (
                  <li key={row.seq} className={`sync-feed-row ${meta.cls}`}>
                    <span className="sync-feed-icon"><Icon icon={meta.icon} size="sm" /></span>
                    <span className="sync-feed-name" title={row.file}>
                      {pretty.title}
                      {pretty.sub && <span className="sync-feed-sub"> — {pretty.sub}</span>}
                    </span>
                    <span className="sync-feed-action" title={actionText}>{actionText}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SyncTallies({ tally }: { tally: Tally }) {
  const chips: { key: string; label: string; n: number; icon: string; cls: string }[] = [
    { key: "copied", label: "copied", n: tally.copied, icon: circleCheck, cls: "copied" },
    { key: "skipped", label: "already there", n: tally.skipped, icon: check, cls: "skipped" },
    { key: "deleted", label: "removed", n: tally.deleted, icon: trash2, cls: "deleted" },
    { key: "playlist", label: tally.playlist === 1 ? "playlist" : "playlists", n: tally.playlist, icon: listMusic, cls: "copied" },
    { key: "error", label: "failed", n: tally.error, icon: circleAlert, cls: "error" },
  ].filter((c) => c.n > 0);
  if (chips.length === 0) return null;
  return (
    <div className="sync-tallies">
      {chips.map((c) => (
        <span key={c.key} className={`sync-tally ${c.cls}`}>
          <Icon icon={c.icon} size="sm" /> {c.n} {c.label}
        </span>
      ))}
    </div>
  );
}

function summarize(r: DeviceSyncResult): string {
  const parts: string[] = [`${r.copied} copied`];
  if (r.skipped) parts.push(`${r.skipped} already there`);
  if (r.deleted) parts.push(`${r.deleted} removed`);
  if (r.playlistsWritten) parts.push(`${r.playlistsWritten} playlist${r.playlistsWritten === 1 ? "" : "s"}`);
  if (r.errors) parts.push(`${r.errors} failed`);
  return `${parts.join(" · ")}.`;
}
