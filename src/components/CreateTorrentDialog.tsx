import { useState } from "react";
import { Dialog } from "@mattmattmattmatt/base/primitives/dialog/Dialog";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { createTorrent, type CreatedTorrent } from "../ipc/engine";
import { IN_TAURI } from "../ipc/engine";
import { formatBytes } from "../lib/format";
import {
  folder, file, hardDriveUpload, copy, check, circleCheck, shieldCheck, globe, magnet, x,
} from "../lib/icons";
import "./CreateTorrentDialog.css";

/**
 * Create a `.torrent` from local files and seed it from this machine. Everything stays
 * local — the torrent is just a fingerprint and this client is the seed; nothing is
 * uploaded to any GhostWire server. The user shares the magnet / `.torrent` wherever they
 * choose (their own site, a tracker, a chat) — GhostWire never hosts or lists it.
 */
export function CreateTorrentDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [sourceIsDir, setSourceIsDir] = useState(false);
  const [trackers, setTrackers] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedTorrent | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setSourcePath(null);
    setSourceIsDir(false);
    setTrackers("");
    setBusy(false);
    setError(null);
    setResult(null);
    setCopied(false);
  }

  function close() {
    reset();
    onClose();
  }

  const sourceLabel = sourcePath ? sourcePath.split("/").pop() || sourcePath : null;

  async function pick(directory: boolean) {
    if (!IN_TAURI) return;
    setError(null);
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const picked = await openDialog({
        title: directory ? "Choose a folder to share" : "Choose a file to share",
        multiple: false,
        directory,
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (path) {
        setSourcePath(path);
        setSourceIsDir(directory);
        setResult(null);
      }
    } catch (e) {
      setError(`${e}`);
    }
  }

  async function create() {
    if (!sourcePath || !IN_TAURI) return;
    setBusy(true);
    setError(null);
    try {
      // Ask where to save the .torrent so the user can share the file too (optional).
      const { save } = await import("@tauri-apps/plugin-dialog");
      const base = (sourcePath.split("/").pop() || "shared").replace(/\.[^.]+$/, "");
      const savePath = await save({
        title: "Save .torrent file",
        defaultPath: `${base}.torrent`,
        filters: [{ name: "Torrent", extensions: ["torrent"] }],
      });
      const trackerList = trackers
        .split(/\r?\n/)
        .map((t) => t.trim())
        .filter(Boolean);
      const res = await createTorrent(sourcePath, {
        savePath: savePath ?? undefined,
        trackers: trackerList,
        startSeeding: true,
      });
      setResult(res);
    } catch (e) {
      setError(`${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function copyMagnet() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.magnet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  return (
    <Dialog open={open} onClose={close} title="Create &amp; share a torrent" className="crt-dialog">
      <div className="crt">
        {!result ? (
          <>
            <div className="crt-note">
              <span className="crt-note-ic"><Icon icon={shieldCheck} size="sm" /></span>
              <span>
                This stays on your machine — the torrent is just a fingerprint of your files and
                your computer becomes the seed. Nothing is uploaded to GhostWire; share the magnet
                or <code>.torrent</code> wherever you like.
              </span>
            </div>

            {sourcePath ? (
              <div className="crt-source">
                <span className="crt-source-ic"><Icon icon={sourceIsDir ? folder : file} size="base" /></span>
                <div className="crt-source-meta">
                  <div className="crt-source-name" title={sourcePath}>{sourceLabel}</div>
                  <div className="crt-source-sub">{sourceIsDir ? "Folder" : "File"} · ready to seed</div>
                </div>
                <button type="button" className="crt-source-clear" title="Choose something else" aria-label="Clear selection" onClick={() => { setSourcePath(null); setSourceIsDir(false); }}>
                  <Icon icon={x} size="sm" />
                </button>
              </div>
            ) : (
              <div className="crt-pickers">
                <button type="button" className="crt-pick" onClick={() => pick(true)} disabled={busy}>
                  <span className="crt-pick-ic"><Icon icon={folder} size="base" /></span>
                  <span className="crt-pick-label">Choose folder</span>
                  <span className="crt-pick-sub">Share a whole folder</span>
                </button>
                <button type="button" className="crt-pick" onClick={() => pick(false)} disabled={busy}>
                  <span className="crt-pick-ic"><Icon icon={file} size="base" /></span>
                  <span className="crt-pick-label">Choose file</span>
                  <span className="crt-pick-sub">Share a single file</span>
                </button>
              </div>
            )}

            <label className="crt-field">
              <span className="crt-label"><Icon icon={globe} size="xs" /> Trackers <span className="crt-label-opt">Optional</span></span>
              <textarea
                className="crt-textarea"
                value={trackers}
                onChange={(e) => setTrackers(e.target.value)}
                placeholder={"udp://tracker.opentrackr.org:1337/announce\nudp://open.demonii.com:1337/announce"}
                rows={3}
                spellCheck={false}
              />
              <span className="crt-hint">One per line. Leave empty to share trackerless — peers find each other over the DHT.</span>
            </label>

            {error && <p className="crt-error">{error}</p>}

            <div className="crt-actions">
              <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
              <Button variant="primary" icon={hardDriveUpload} onClick={create} disabled={!sourcePath || busy} loading={busy}>
                Create &amp; seed
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="crt-success">
              <span className="crt-success-ic"><Icon icon={circleCheck} size="base" /></span>
              <span>
                <strong>{result.name}</strong> — {formatBytes(result.sizeBytes)} ·{" "}
                {result.fileCount} file{result.fileCount === 1 ? "" : "s"}
                {result.seeding ? " · seeding now" : ""}
              </span>
            </div>

            <label className="crt-field">
              <span className="crt-label"><Icon icon={magnet} size="xs" /> Magnet link</span>
              <textarea
                className="crt-textarea"
                readOnly
                value={result.magnet}
                rows={3}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>

            {result.torrentPath && (
              <p className="crt-hint" title={result.torrentPath}>
                Saved <code>.torrent</code> to <strong>{result.torrentPath.split("/").pop()}</strong>
              </p>
            )}

            <div className="crt-actions crt-actions--split">
              <Button variant="secondary" icon={copied ? check : copy} onClick={copyMagnet}>
                {copied ? "Copied" : "Copy magnet"}
              </Button>
              <Button variant="primary" onClick={close}>Done</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
