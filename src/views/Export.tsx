import { useEffect, useMemo, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Card } from "@mattmattmattmatt/base/primitives/card/Card";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { Checkbox } from "@mattmattmattmatt/base/primitives/checkbox/Checkbox";
import { SegmentedControl } from "@mattmattmattmatt/base/primitives/segmented-control/SegmentedControl";
import { IN_TAURI } from "../ipc/engine";
import {
  exportItems,
  getSetting,
  listExportable,
  pickFolder,
  setSetting,
  type Exportable,
  type ExportResult,
  type ExportTarget,
} from "../ipc/library";
import { formatBytes } from "../lib/format";
import {
  book,
  circleCheck,
  clapperboard,
  folder,
  folderOutput,
  gamepad2,
  hardDriveUpload,
  music,
  rotateCw,
  server,
  triangleAlert,
  tv,
} from "../lib/icons";

const TARGETS = [
  { value: "plex", label: "Plex" },
  { value: "apple_music", label: "Apple Music" },
  { value: "generic", label: "Folder" },
];
const TARGET_LABEL: Record<ExportTarget, string> = {
  plex: "Plex",
  apple_music: "Apple Music",
  generic: "folder",
};
const TYPE_ICON: Record<string, string> = { movie: clapperboard, show: tv, music, book, game: gamepad2 };

export function Export() {
  const [items, setItems] = useState<Exportable[]>([]);
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState<ExportTarget>("plex");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, ExportResult>>({});
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const [plexDir, setPlexDir] = useState("");
  const [plexUrl, setPlexUrl] = useState("");
  const [plexToken, setPlexToken] = useState("");
  const [genericDir, setGenericDir] = useState("");

  useEffect(() => {
    if (!IN_TAURI) return;
    reload();
    getSetting("plex_dir").then((v) => setPlexDir(v ?? "")).catch(() => {});
    getSetting("plex_url").then((v) => setPlexUrl(v ?? "")).catch(() => {});
    getSetting("plex_token").then((v) => setPlexToken(v ?? "")).catch(() => {});
    getSetting("generic_dir").then((v) => setGenericDir(v ?? "")).catch(() => {});
  }, []);

  function reload() {
    if (!IN_TAURI) return;
    setLoading(true);
    listExportable().then(setItems).catch(() => {}).finally(() => setLoading(false));
  }

  // Apple Music accepts audio only.
  const visible = useMemo(
    () => (target === "apple_music" ? items.filter((i) => i.kind === "audio") : items),
    [items, target],
  );

  function save(key: string, val: string) {
    if (IN_TAURI) setSetting(key, val).catch(() => {});
  }
  async function choose(key: string, setter: (s: string) => void) {
    const p = await pickFolder();
    if (p) {
      setter(p);
      save(key, p);
    }
  }
  function field(key: string, val: string, setter: (s: string) => void) {
    setter(val);
    save(key, val);
  }

  function toggle(path: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }
  const allSelected = visible.length > 0 && selected.size >= visible.length;
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visible.map((i) => i.path)));
  }

  async function doExport() {
    const paths = visible.filter((i) => selected.has(i.path)).map((i) => i.path);
    if (!paths.length) return;
    setExporting(true);
    setStatus(null);
    try {
      const res = await exportItems(target, paths);
      const map: Record<string, ExportResult> = {};
      let ok = 0;
      let fail = 0;
      let note = "";
      for (const r of res) {
        if (r.path === "Plex server") {
          note = r.message;
          continue;
        }
        map[r.path] = r;
        if (r.ok) ok++;
        else fail++;
      }
      setResults((prev) => ({ ...prev, ...map }));
      setStatus(`Exported ${ok} item${ok === 1 ? "" : "s"}${fail ? `, ${fail} failed` : ""}.${note ? ` ${note}` : ""}`);
    } catch (e) {
      setStatus(String(e));
    } finally {
      setExporting(false);
    }
  }

  const targetReady = target === "plex" ? !!plexDir.trim() : target === "generic" ? !!genericDir.trim() : true;
  const selCount = visible.filter((i) => selected.has(i.path)).length;

  return (
    <div className="section-stack export-page">
      <div className="cat-header" style={{ marginBottom: 4 }}>
        <span className="cat-title">Export</span>
        <span className="cat-sub">Send your downloads to Plex, Apple Music, or a media folder</span>
        <div className="cat-controls">
          <Button variant="ghost" iconOnly icon={rotateCw} loading={loading} aria-label="Rescan downloads" onClick={reload} />
        </div>
      </div>

      <SegmentedControl options={TARGETS} value={target} onChange={(v) => setTarget(v as ExportTarget)} />

      {/* per-target configuration */}
      <Card variant="outlined" padding="lg">
        {target === "plex" && (
          <div className="settings-group">
            <h4 className="settings-h"><Icon icon={server} size="sm" /> Plex library</h4>
            <div className="field">
              <label className="field-label">Library folder</label>
              <div className="path-row">
                <Input placeholder="/Volumes/Media/Plex" value={plexDir} onChange={(e) => field("plex_dir", e.currentTarget.value, setPlexDir)} />
                <Button variant="secondary" icon={folder} onClick={() => choose("plex_dir", setPlexDir)} disabled={!IN_TAURI}>Choose…</Button>
              </div>
              <p className="field-hint">Files are organized into <code>Movies/</code>, <code>TV Shows/</code> and <code>Music/</code> here.</p>
            </div>
            <div className="field">
              <label className="field-label">Server URL — optional, for auto-scan</label>
              <Input placeholder="http://127.0.0.1:32400" value={plexUrl} onChange={(e) => field("plex_url", e.currentTarget.value, setPlexUrl)} />
            </div>
            <div className="field">
              <label className="field-label">Plex token — optional</label>
              <Input type="password" placeholder="X-Plex-Token" value={plexToken} onChange={(e) => field("plex_token", e.currentTarget.value, setPlexToken)} />
              <p className="field-hint">With a URL + token, Plex rescans automatically after each export.</p>
            </div>
          </div>
        )}
        {target === "generic" && (
          <div className="settings-group">
            <h4 className="settings-h"><Icon icon={folderOutput} size="sm" /> Export folder</h4>
            <div className="field">
              <div className="path-row">
                <Input placeholder="/Volumes/Media or any folder" value={genericDir} onChange={(e) => field("generic_dir", e.currentTarget.value, setGenericDir)} />
                <Button variant="secondary" icon={folder} onClick={() => choose("generic_dir", setGenericDir)} disabled={!IN_TAURI}>Choose…</Button>
              </div>
              <p className="field-hint">Organized as <code>Movies/Name (Year)/…</code>, <code>TV Shows/Show/Season 01/…</code>, <code>Music/…</code> — ready for Jellyfin, Emby, Infuse, or Plex.</p>
            </div>
          </div>
        )}
        {target === "apple_music" && (
          <div className="settings-group">
            <h4 className="settings-h"><Icon icon={music} size="sm" /> Apple Music</h4>
            <p className="field-hint">
              Audio is added straight to the Music app. FLAC, OGG and other non-Apple formats are converted to ALAC (lossless) automatically.
              macOS will ask for permission to control Music the first time — allow it under System Settings ▸ Privacy &amp; Security ▸ Automation.
            </p>
          </div>
        )}
      </Card>

      {/* exportable items */}
      <div className="export-toolbar">
        <Checkbox label={`Select all (${visible.length})`} checked={allSelected} onChange={toggleAll} />
        <div className="cat-controls">
          {selCount > 0 && <span className="cat-sub">{selCount} selected</span>}
          <Button
            variant="primary"
            icon={hardDriveUpload}
            loading={exporting}
            disabled={!IN_TAURI || selCount === 0 || !targetReady}
            onClick={doExport}
          >
            Export to {TARGET_LABEL[target]}
          </Button>
        </div>
      </div>
      {!targetReady && selCount > 0 && (
        <p className="field-hint">Set the {target === "plex" ? "Plex library folder" : "export folder"} above first.</p>
      )}
      {status && <p className="settings-status">{status}</p>}

      {loading ? (
        <div className="empty"><div className="empty-inner"><Spinner size="lg" /><p>Scanning your downloads…</p></div></div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <span className="empty-glyph"><Icon icon={folderOutput} size="xl" /></span>
            <h3>Nothing to export yet</h3>
            <p>{target === "apple_music" ? "No audio files in your downloads." : "Download some media first — it'll show up here, ready to export."}</p>
          </div>
        </div>
      ) : (
        <Card variant="outlined" padding="none">
          {visible.map((it) => {
            const r = results[it.path];
            return (
              <div className={`export-row${selected.has(it.path) ? " sel" : ""}`} key={it.path}>
                <Checkbox checked={selected.has(it.path)} onChange={() => toggle(it.path)} aria-label={`Select ${it.title}`} />
                <span className="export-type"><Icon icon={TYPE_ICON[it.mediaType] ?? clapperboard} size="sm" /></span>
                <div className="export-main">
                  <div className="export-title" title={it.fileName}>
                    {it.title}
                    {it.year ? ` (${it.year})` : ""}
                    {it.season != null ? ` · S${String(it.season).padStart(2, "0")}${it.episode != null ? `E${String(it.episode).padStart(2, "0")}` : ""}` : ""}
                  </div>
                  <div className="export-sub" title={it.relPath}>{it.relPath}</div>
                </div>
                <span className="export-size">{formatBytes(it.sizeBytes)}</span>
                {r && (
                  <span className={`export-result ${r.ok ? "ok" : "err"}`} title={r.message}>
                    <Icon icon={r.ok ? circleCheck : triangleAlert} size="sm" />
                    {r.ok ? (r.converted ? "Converted" : "Done") : "Failed"}
                  </span>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {!IN_TAURI && <p className="field-hint">Exporting runs in the desktop app.</p>}
    </div>
  );
}
