import { useEffect, useRef, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Card } from "@mattmattmattmatt/base/primitives/card/Card";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { IN_TAURI } from "../ipc/engine";
import {
  aiStatus,
  appInfo,
  clearCatalog,
  getSetting,
  pickFolder,
  relayStatus,
  restartApp,
  setSetting,
  setStorageDir,
  type AiStatus,
  type AppInfo,
  type RelayStatus,
} from "../ipc/library";
import { circleCheck, cpu, download, film, folderDown, folderOpen, globe, hardDrive, info, rotateCw, server, sparkles, triangleAlert } from "../lib/icons";
import { IS_IOS } from "../lib/platform";

type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error";

export function Settings({ onCatalogChanged }: { onCatalogChanged: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tmdbKey, setTmdbKey] = useState("");
  const [omdbKey, setOmdbKey] = useState("");
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [autoCleanup, setAutoCleanup] = useState(true);
  // Storage-folder change flow.
  const [chosenDir, setChosenDir] = useState<string | null>(null);
  const [migrate, setMigrate] = useState(true);
  const [needsRestart, setNeedsRestart] = useState(false);
  // Artwork relay liveness.
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [relayChecking, setRelayChecking] = useState(false);
  // Version + updater.
  const [version, setVersion] = useState("");
  const [upPhase, setUpPhase] = useState<UpdatePhase>("idle");
  const [upMsg, setUpMsg] = useState("");
  const [upPct, setUpPct] = useState(0);
  const updateRef = useRef<{ version: string; downloadAndInstall: (cb: (e: ProgressEvent) => void) => Promise<void> } | null>(null);

  async function chooseFolder() {
    const dir = await pickFolder().catch(() => null);
    if (dir) setChosenDir(dir);
  }
  async function applyFolder() {
    if (!chosenDir) return;
    setBusy("storage");
    setStatus("");
    try {
      const msg = await setStorageDir(chosenDir, migrate);
      setStatus(msg);
      setNeedsRestart(true);
      setChosenDir(null);
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function checkRelay() {
    if (!IN_TAURI) return;
    setRelayChecking(true);
    try {
      setRelay(await relayStatus());
    } catch {
      setRelay(null);
    } finally {
      setRelayChecking(false);
    }
  }

  useEffect(() => {
    if (!IN_TAURI) return;
    appInfo().then(setInfo).catch(() => {});
    getSetting("tmdb_key").then((k) => setTmdbKey(k ?? "")).catch(() => {});
    getSetting("omdb_key").then((k) => setOmdbKey(k ?? "")).catch(() => {});
    getSetting("auto_cleanup").then((v) => setAutoCleanup(v !== "false")).catch(() => {});
    aiStatus().then(setAi).catch(() => {});
    void checkRelay();
    import("@tauri-apps/api/app").then(({ getVersion }) => getVersion().then(setVersion)).catch(() => {});
  }, []);

  async function checkUpdates() {
    if (!IN_TAURI || IS_IOS) return;
    setUpPhase("checking");
    setUpMsg("");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        setUpPhase("current");
        return;
      }
      updateRef.current = update as never;
      setUpMsg(update.version);
      setUpPhase("available");
    } catch (e) {
      setUpPhase("error");
      setUpMsg(String(e));
    }
  }

  async function installUpdate() {
    const update = updateRef.current;
    if (!update) return;
    setUpPhase("downloading");
    setUpPct(0);
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((ev) => {
        const e = ev as unknown as { event: string; data?: { contentLength?: number; chunkLength?: number } };
        if (e.event === "Started") total = e.data?.contentLength ?? 0;
        else if (e.event === "Progress") {
          done += e.data?.chunkLength ?? 0;
          if (total > 0) setUpPct(Math.min(100, (done / total) * 100));
        }
      });
      setUpPhase("ready");
    } catch (e) {
      setUpPhase("error");
      setUpMsg(String(e));
    }
  }

  async function restartForUpdate() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("relaunch_for_update");
    } catch {
      try {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch {
        /* ignore */
      }
    }
  }

  async function toggleAutoCleanup(on: boolean) {
    setAutoCleanup(on);
    try {
      await setSetting("auto_cleanup", on ? "true" : "false");
    } catch {
      /* ignore */
    }
  }

  async function saveKeys() {
    if (!IN_TAURI) return;
    setBusy("save");
    try {
      await setSetting("tmdb_key", tmdbKey.trim());
      await setSetting("omdb_key", omdbKey.trim());
      setStatus("Settings saved. Run an AI scan from the Library to match posters and ratings.");
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(null);
    }
  }
  async function doClear() {
    setBusy("clear");
    setStatus("");
    try {
      const n = await clearCatalog();
      setStatus(`Cleared ${n} indexed item${n === 1 ? "" : "s"}.`);
      onCatalogChanged();
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(null);
    }
  }

  const relayColor = relay === null ? undefined : relay.reachable ? "var(--gg-success, #2f8f4e)" : "var(--gg-danger, #d85b5b)";

  return (
    <div className="section-stack">
      <div className="cat-header" style={{ marginBottom: 4 }}>
        <span className="cat-title">Settings</span>
      </div>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h"><Icon icon={info} size="sm" /> About &amp; updates</h4>
          <div className="settings-row">
            <span className="settings-label">Version</span>
            <span className="settings-val">{version ? `The Black Pearl ${version}` : "—"}</span>
          </div>
          {IS_IOS ? (
            <p className="field-hint">Updates are delivered through the App Store on iOS.</p>
          ) : (
            <>
              {upPhase === "available" && <p className="field-hint" style={{ color: "var(--gg-accent)" }}>Update available — v{upMsg}</p>}
              {upPhase === "current" && <p className="field-hint" style={{ color: "var(--gg-success, #2f8f4e)" }}>You&apos;re on the latest version.</p>}
              {upPhase === "downloading" && (
                <div style={{ height: 5, borderRadius: 3, background: "var(--gg-surface-2)", overflow: "hidden", margin: "8px 0 4px" }}>
                  <span style={{ display: "block", height: "100%", width: `${upPct || 5}%`, background: "var(--gg-accent)", borderRadius: 3, transition: "width 180ms ease" }} />
                </div>
              )}
              {upPhase === "ready" && <p className="field-hint" style={{ color: "var(--gg-success, #2f8f4e)" }}>Update installed — restart to apply.</p>}
              {upPhase === "error" && <p className="field-hint" style={{ color: "var(--gg-danger, #d85b5b)" }}>{upMsg}</p>}
              <div className="form-actions settings-actions">
                {(upPhase === "idle" || upPhase === "current" || upPhase === "error") && (
                  <Button variant="secondary" icon={rotateCw} loading={upPhase === "checking"} disabled={!IN_TAURI} onClick={checkUpdates}>Check for updates</Button>
                )}
                {upPhase === "available" && (
                  <Button variant="primary" icon={download} onClick={installUpdate}>Install v{upMsg}</Button>
                )}
                {upPhase === "downloading" && (
                  <Button variant="primary" loading disabled>Downloading…</Button>
                )}
                {upPhase === "ready" && (
                  <Button variant="primary" icon={rotateCw} onClick={restartForUpdate}>Restart now</Button>
                )}
              </div>
            </>
          )}
        </div>
      </Card>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">Storage</h4>
          <div className="settings-row">
            <span className="settings-label"><Icon icon={folderDown} size="sm" /> Save folder</span>
            <code className="mono-path">{info?.downloadDir ?? "—"}</code>
          </div>
          <p className="field-hint">Where downloads are saved. Move it to an external drive and (optionally) bring your existing files along.</p>
          <div className="form-actions settings-actions">
            {!IS_IOS && (
              <Button variant="secondary" icon={folderOpen} disabled={!IN_TAURI} onClick={chooseFolder}>Change folder…</Button>
            )}
            {needsRestart && (
              <Button variant="primary" icon={rotateCw} onClick={() => void restartApp()}>Restart now</Button>
            )}
          </div>
          {chosenDir && (
            <div className="storage-confirm">
              <div className="settings-row">
                <span className="settings-label">New folder</span>
                <code className="mono-path">{chosenDir}</code>
              </div>
              <label className="settings-check">
                <input type="checkbox" checked={migrate} onChange={(e) => setMigrate(e.currentTarget.checked)} />
                Move existing downloads into the new folder
              </label>
              <div className="form-actions">
                <Button variant="ghost" onClick={() => setChosenDir(null)}>Cancel</Button>
                <Button variant="primary" loading={busy === "storage"} onClick={applyFolder}>Apply</Button>
              </div>
            </div>
          )}
          <div className="settings-row">
            <span className="settings-label"><Icon icon={hardDrive} size="sm" /> App data</span>
            <code className="mono-path">{info?.dataDir ?? "—"}</code>
          </div>
        </div>
      </Card>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h"><Icon icon={sparkles} size="sm" /> Automatic cleanup</h4>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={autoCleanup}
              disabled={!IN_TAURI}
              onChange={(e) => void toggleAutoCleanup(e.currentTarget.checked)}
            />
            Organize &amp; enrich new downloads automatically
          </label>
          <p className="field-hint">
            When a download finishes it&apos;s tidied into your Organized library (clean Plex-style
            folders, one per show or film) and enriched with posters, ratings and clean titles —
            no clicking required. Runs in the background; progress shows in the top bar.
          </p>
        </div>
      </Card>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">Playback</h4>
          <div className="settings-row">
            <span className="settings-label"><Icon icon={film} size="sm" /> Format support</span>
            <span className="settings-val">
              {info?.ffmpegAvailable
                ? "FFmpeg detected — MKV, HEVC, AC-3, XviD and more are transcoded on the fly"
                : "Install FFmpeg (brew install ffmpeg) to play MKV and other non-MP4 formats"}
            </span>
          </div>
        </div>
      </Card>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">Local AI</h4>
          <div className="settings-row">
            <span className="settings-label"><Icon icon={cpu} size="sm" /> Ollama</span>
            <span className="settings-val">
              {ai === null
                ? "—"
                : ai.available
                  ? `Connected — scans will use ${ai.model ?? "the installed model"}${
                      ai.models.length > 1 ? ` (${ai.models.length} models installed)` : ""
                    }`
                  : "Not running. Install Ollama and pull a model (e.g. `ollama pull qwen2.5:7b`) to organize titles. Posters still work without it."}
            </span>
          </div>
          <p className="field-hint">
            The local model parses messy release names into clean titles, types and tags — then
            posters and ratings are matched. Run scans from the Library tab.
          </p>
        </div>
      </Card>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">Posters, ratings &amp; music APIs</h4>
          <p className="field-hint">
            Optional API keys. OMDb adds IMDb and Rotten Tomatoes scores plus posters; TMDB is a
            poster fallback. Without keys, posters &amp; album art resolve through the keyless
            artwork relay (below).
          </p>
          <div className="field">
            <label className="field-label">OMDb API key — IMDb + Rotten Tomatoes</label>
            <Input
              type="password"
              placeholder="OMDb API key"
              value={omdbKey}
              onChange={(e) => setOmdbKey(e.currentTarget.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">TMDB API key — poster fallback</label>
            <Input
              type="password"
              placeholder="TMDB API key"
              value={tmdbKey}
              onChange={(e) => setTmdbKey(e.currentTarget.value)}
            />
          </div>
          <div className="form-actions settings-actions">
            <Button
              variant="primary"
              loading={busy === "save"}
              disabled={!IN_TAURI}
              onClick={saveKeys}
            >
              Save keys
            </Button>
          </div>
        </div>
      </Card>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h"><Icon icon={server} size="sm" /> Connection</h4>
          <div className="settings-row">
            <span className="settings-label"><Icon icon={globe} size="sm" /> Artwork relay</span>
            <span className="settings-val" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: relayColor }}>
              {relay === null ? (
                relayChecking ? "Checking…" : "—"
              ) : relay.reachable ? (
                <><Icon icon={circleCheck} size="sm" /> Connected{relay.latencyMs != null ? ` · ${relay.latencyMs} ms` : ""}</>
              ) : (
                <><Icon icon={triangleAlert} size="sm" /> Unreachable</>
              )}
            </span>
          </div>
          <p className="field-hint">
            <code className="mono-path">{relay?.url ?? "https://theblackpearl.tv/api"}</code> — the keyless poster &amp;
            album-art relay. If it&apos;s down, artwork still resolves through your own OMDb/TMDB keys.
          </p>
          <div className="form-actions settings-actions">
            <Button variant="secondary" icon={rotateCw} loading={relayChecking} disabled={!IN_TAURI} onClick={checkRelay}>Recheck</Button>
          </div>
        </div>
      </Card>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">Catalog</h4>
          <p className="field-hint">Remove all indexed items (configured sources are kept).</p>
          <div className="form-actions settings-actions">
            <Button
              variant="secondary"
              intent="error"
              appearance="subtle"
              loading={busy === "clear"}
              disabled={!IN_TAURI}
              onClick={doClear}
            >
              Clear indexed catalog
            </Button>
          </div>
        </div>
      </Card>

      {status && <p className="settings-status">{status}</p>}
      {!IN_TAURI && <p className="field-hint">Settings actions run in the desktop app.</p>}
    </div>
  );
}
