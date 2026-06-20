import { useEffect, useRef, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Toggle } from "@mattmattmattmatt/base/primitives/toggle/Toggle";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import {
  listDevices,
  onDeviceSyncProgress,
  syncMusicToDevice,
  type DeviceSyncResult,
  type DeviceSyncStep,
  type SyncDevice,
} from "../ipc/devices";
import { getSetting, setSetting } from "../ipc/library";
import { formatBytes } from "../lib/format";
import { arrowDownUp, circleCheck, hardDrive, rotateCw, triangleAlert } from "../lib/icons";

const FOLDER_SETTING = "device_sync_folder";
const DEFAULT_FOLDER = "Music";

interface DeviceSyncCardProps {
  /** Number of music tracks in the Library (what a full sync would copy). */
  trackCount: number;
}

interface ActiveSync {
  mount: string;
  step: DeviceSyncStep | null;
}

/** Detect connected MP3 players / SD cards and keep a folder on them in sync with the
 *  Library's music. Copies only new/changed tracks; optional mirror prunes removed ones. */
export function DeviceSyncCard({ trackCount }: DeviceSyncCardProps) {
  const [devices, setDevices] = useState<SyncDevice[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [folder, setFolder] = useState(DEFAULT_FOLDER);
  const [mirror, setMirror] = useState(false);
  const [active, setActive] = useState<ActiveSync | null>(null);
  const [result, setResult] = useState<{ mount: string; res: DeviceSyncResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const folderRef = useRef(DEFAULT_FOLDER);
  const activeRef = useRef(false);
  const scanningRef = useRef(false);

  // The folder name is needed by both the poll and the rescan; keep a ref so the interval
  // closure always reads the latest value without re-subscribing.
  folderRef.current = folder;
  activeRef.current = active !== null;

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

  // Load the saved folder name, then do a first scan. Poll every 4s so plugging a device
  // in (or pulling one out) shows up without a manual rescan — paused while a sync runs.
  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = (await getSetting(FOLDER_SETTING).catch(() => null))?.trim();
      if (alive && saved) {
        setFolder(saved);
        folderRef.current = saved;
      }
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

  // Live per-file progress for the running sync.
  useEffect(() => {
    let un: (() => void) | undefined;
    onDeviceSyncProgress((step) => {
      setActive((cur) => (cur ? { ...cur, step } : cur));
    }).then((fn) => {
      un = fn;
    });
    return () => un?.();
  }, []);

  function onFolderChange(value: string) {
    setFolder(value);
    folderRef.current = value;
    void setSetting(FOLDER_SETTING, value.trim() || DEFAULT_FOLDER).catch(() => {});
  }

  async function sync(device: SyncDevice) {
    setError(null);
    setResult(null);
    setActive({ mount: device.mountPath, step: null });
    try {
      const res = await syncMusicToDevice(device.mountPath, folder, mirror);
      setResult({ mount: device.mountPath, res });
    } catch (e) {
      setError(String(e));
    } finally {
      setActive(null);
      void rescan(); // refresh the "N tracks synced" counts
    }
  }

  return (
    <div className="settings-group device-sync">
      <div className="device-sync-head">
        <span className="field-label">
          <Icon icon={hardDrive} size="sm" /> Sync to a device
        </span>
        <Button variant="ghost" size="sm" icon={rotateCw} loading={scanning} onClick={() => void rescan()}>
          Rescan
        </Button>
      </div>
      <p className="field-hint">
        Copy your {trackCount} library track{trackCount === 1 ? "" : "s"} onto a connected MP3 player or SD card,
        organized into <code>{folder.trim() || DEFAULT_FOLDER}/Artist/Album</code>. Re-syncing only copies what&apos;s new.
      </p>

      <div className="device-sync-controls">
        <label className="field-hint device-sync-folder">
          Folder
          <Input
            value={folder}
            placeholder={DEFAULT_FOLDER}
            onChange={(e) => onFolderChange(e.currentTarget.value)}
            disabled={active !== null}
          />
        </label>
        <Toggle
          className="device-sync-mirror"
          title="Also delete tracks on the device that are no longer in your Library"
          label="Mirror (remove extras)"
          checked={mirror}
          onChange={(e) => setMirror(e.currentTarget.checked)}
          disabled={active !== null}
        />
      </div>
      {mirror && (
        <p className="field-hint device-sync-warn">
          <Icon icon={triangleAlert} size="sm" /> Mirror deletes audio in <code>{folder.trim() || DEFAULT_FOLDER}/</code> on the device that isn&apos;t in your Library. Other files are left alone.
        </p>
      )}

      {devices === null ? (
        <p className="field-hint">Looking for connected devices…</p>
      ) : devices.length === 0 ? (
        <p className="field-hint">No removable devices found. Plug in an MP3 player or SD card, then Rescan.</p>
      ) : (
        <div className="device-list">
          {devices.map((d) => {
            const used = d.totalBytes > 0 ? Math.min(100, Math.max(0, ((d.totalBytes - d.freeBytes) / d.totalBytes) * 100)) : 0;
            const isActive = active?.mount === d.mountPath;
            const done = result?.mount === d.mountPath ? result.res : null;
            return (
              <div key={d.mountPath} className="device-row">
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
                  {isActive && (
                    <div className="device-progress" aria-live="polite">
                      <div className={`music-import-progress-track${active?.step ? "" : " is-indeterminate"}`}>
                        <div
                          className="music-import-progress-fill"
                          style={active?.step && active.step.total > 0 ? { width: `${Math.round((active.step.done / active.step.total) * 100)}%` } : undefined}
                        />
                      </div>
                      <span className="field-hint">
                        {active?.step
                          ? `${active.step.action === "deleted" ? "Removing" : "Copying"} ${active.step.done} of ${active.step.total}…`
                          : "Starting…"}
                      </span>
                    </div>
                  )}
                  {done && !isActive && (
                    <p className="field-hint device-done">
                      <Icon icon={circleCheck} size="sm" /> {summarize(done)}
                    </p>
                  )}
                </div>
                <Button
                  variant="primary"
                  shape="pill"
                  icon={arrowDownUp}
                  loading={isActive}
                  disabled={trackCount === 0 || active !== null}
                  onClick={() => void sync(d)}
                >
                  {isActive ? "Syncing…" : "Sync"}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {error && <p className="field-hint device-sync-warn">{error}</p>}
    </div>
  );
}

function summarize(r: DeviceSyncResult): string {
  const parts: string[] = [];
  parts.push(`${r.copied} copied`);
  if (r.skipped) parts.push(`${r.skipped} already there`);
  if (r.deleted) parts.push(`${r.deleted} removed`);
  if (r.errors) parts.push(`${r.errors} failed`);
  return `${parts.join(" · ")}.`;
}
