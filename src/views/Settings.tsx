import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Card } from "@mattmattmattmatt/base/primitives/card/Card";
import { LinkDeviceCard } from "../components/LinkDeviceCard";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Toggle } from "@mattmattmattmatt/base/primitives/toggle/Toggle";
import { IN_TAURI } from "../ipc/engine";
import { PerformancePanel } from "../components/PerformancePanel";
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
import { circleCheck, cpu, download, film, folderDown, folderOpen, globe, hardDrive, info as infoIcon, rotateCw, server, slidersVertical, sparkles, triangleAlert } from "../lib/icons";
import { AppearanceSettings } from "./AppearanceSettings";
import { IS_IOS } from "../lib/platform";
import type { SettingsTab } from "../lib/settingsTabs";
import "./Settings.css";

type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error";

interface SettingsProps {
  onCatalogChanged: () => void;
  tab: SettingsTab;
  onRunPerfPass1: () => Promise<string>;
  onRunPerfPass2: () => Promise<string>;
  onRunPerfPass3: () => Promise<string>;
  onRunPerfPass4: () => Promise<string>;
  onRunPerfPass5: () => Promise<string>;
}

/** The active category (`tab`) is owned by App and surfaced in the shell Sidebar card, so
 *  this view just renders the matching pane. */
export function Settings({ onCatalogChanged, tab, onRunPerfPass1, onRunPerfPass2, onRunPerfPass3, onRunPerfPass4, onRunPerfPass5 }: SettingsProps) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tmdbKey, setTmdbKey] = useState("");
  const [omdbKey, setOmdbKey] = useState("");
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [autoCleanup, setAutoCleanup] = useState(true);
  // Player ambient glow (light bleed behind the video).
  const [ambient, setAmbient] = useState(true);
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
  const [preferP2P, setPreferP2P] = useState(false);
  const [seedUpdates, setSeedUpdates] = useState(false);
  const [seedMsg, setSeedMsg] = useState("");
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
    getSetting("auto_cleanup").then((v) => setAutoCleanup(v === "true")).catch(() => {});
    getSetting("player_ambient").then((v) => setAmbient(v !== "false")).catch(() => {});
    getSetting("prefer_p2p").then((v) => setPreferP2P(v === "true")).catch(() => {});
    getSetting("seed_updates")
      .then((v) => {
        const on = v === "true";
        setSeedUpdates(on);
        // Re-register the seed in this session (the swarm torrent itself persists in the engine).
        if (on) import("@tauri-apps/api/core").then(({ invoke }) => invoke<string>("start_app_seed").then((ver) => setSeedMsg(ver)).catch(() => {}));
      })
      .catch(() => {});
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
    // P2P opt-in: pull the signed bundle over BitTorrent (verified against the same key) instead of
    // HTTP. On any failure (no peers / no magnet / verify error) fall through to the HTTP path below.
    if (preferP2P) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const installed = await invoke<boolean>("p2p_update");
        if (installed) {
          setUpPhase("ready");
          return;
        }
      } catch (e) {
        console.warn("[updater] P2P update failed, falling back to HTTP:", e);
      }
    }
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

  async function toggleAmbient(on: boolean) {
    setAmbient(on);
    try {
      await setSetting("player_ambient", on ? "true" : "false");
    } catch {
      /* ignore */
    }
  }

  async function togglePreferP2P(on: boolean) {
    setPreferP2P(on);
    try {
      await setSetting("prefer_p2p", on ? "true" : "false");
    } catch {
      /* ignore */
    }
  }

  async function toggleSeedUpdates(on: boolean) {
    setSeedUpdates(on);
    setSeedMsg(on ? "Starting…" : "");
    try {
      await setSetting("seed_updates", on ? "true" : "false");
      const { invoke } = await import("@tauri-apps/api/core");
      if (on) {
        const ver = await invoke<string>("start_app_seed");
        setSeedMsg(ver ? `Seeding GhostWire ${ver}` : "Seeding the latest build");
      } else {
        await invoke("stop_app_seed");
      }
    } catch (e) {
      setSeedMsg(`Couldn't start seeding: ${String(e)}`);
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

      <div className="settings-pane">

      {tab === "appearance" && (
      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h"><Icon icon={slidersVertical} size="sm" /> Accent &amp; theme</h4>
          <AppearanceSettings />
        </div>
      </Card>
      )}

      {tab === "general" && (
      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h"><Icon icon={infoIcon} size="sm" /> About &amp; updates</h4>
          <div className="settings-row">
            <span className="settings-label">Version</span>
            <span className="settings-val">{version ? `GhostWire ${version}` : "—"}</span>
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
                {(upPhase === "idle" || upPhase === "checking" || upPhase === "current" || upPhase === "error") && (
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
              <Toggle
                className="settings-toggle"
                style={{ marginTop: 10 }}
                label="Download updates over BitTorrent"
                checked={preferP2P}
                disabled={!IN_TAURI}
                onChange={(e: ChangeEvent<HTMLInputElement>) => void togglePreferP2P(e.currentTarget.checked)}
              />
              <p className="field-hint">
                Pull GhostWire updates peer-to-peer from the swarm instead of the server. The download is
                verified against the same signature before installing, and it falls back to a normal HTTPS
                download automatically. Like any torrent, this exposes your IP to peers.
              </p>
              <Toggle
                className="settings-toggle"
                style={{ marginTop: 12 }}
                label="Help distribute GhostWire (seed the app)"
                checked={seedUpdates}
                disabled={!IN_TAURI}
                onChange={(e: ChangeEvent<HTMLInputElement>) => void toggleSeedUpdates(e.currentTarget.checked)}
              />
              <p className="field-hint">
                Share the latest GhostWire build with other users over BitTorrent (downloaded once, then
                seeded). It appears in your Downloads “seeding” list. Uses upload bandwidth and exposes your
                IP to peers, like any torrent.
                {seedMsg && <><br /><span style={{ color: "var(--gg-accent)" }}>{seedMsg}</span></>}
              </p>
            </>
          )}
        </div>
      </Card>

      )}

      {tab === "storage" && (
      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">Storage</h4>
          <div className="settings-row">
            <span className="settings-label"><Icon icon={folderDown} size="sm" /> Save folder</span>
            <code className="mono-path">{info?.downloadDir ?? "—"}</code>
          </div>
          <p className="field-hint">Downloads save here. You can move this to another drive and optionally migrate existing files.</p>
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
              <Toggle
                className="settings-toggle"
                label="Move existing downloads into the new folder"
                checked={migrate}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setMigrate(e.currentTarget.checked)}
              />
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

      )}

      {tab === "media" && (<>
      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h"><Icon icon={sparkles} size="sm" /> Automatic cleanup</h4>
          <Toggle
            className="settings-toggle"
            label="Organize & enrich new downloads automatically"
            checked={autoCleanup}
            disabled={!IN_TAURI}
            onChange={(e: ChangeEvent<HTMLInputElement>) => void toggleAutoCleanup(e.currentTarget.checked)}
          />
          <p className="field-hint">
            Off by default — organize and clean your library manually from the Automation page. When enabled, finished
            downloads are auto-organized into clean library folders and enriched with posters, ratings, and cleaner titles.
            Leave this off if you download large/active torrents: moving files mid-transfer can interrupt a download.
          </p>
        </div>
      </Card>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">Playback</h4>
          <Toggle
            className="settings-toggle"
            label="Ambient glow"
            checked={ambient}
            onChange={(e: ChangeEvent<HTMLInputElement>) => void toggleAmbient(e.currentTarget.checked)}
          />
          <p className="field-hint">
            Adds a soft color glow behind the player while you watch.
          </p>
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
            The local model cleans messy release names into proper titles and tags so matching works better.
            Run scans from the Library tab.
          </p>
        </div>
      </Card>

      </>)}

      {tab === "artwork" && (
      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">Posters, ratings &amp; music APIs</h4>
          <p className="field-hint">
            Optional API keys: OMDb adds IMDb/Rotten Tomatoes + posters, and TMDB is poster fallback.
            Without keys, posters and album art use the relay below.
          </p>
          <div className="field">
            <label className="field-label">OMDb API key — IMDb + Rotten Tomatoes</label>
            <Input
              type="password"
              placeholder="OMDb API key"
              value={omdbKey}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setOmdbKey(e.currentTarget.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">TMDB API key — poster fallback</label>
            <Input
              type="password"
              placeholder="TMDB API key"
              value={tmdbKey}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTmdbKey(e.currentTarget.value)}
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

      )}

      {tab === "network" && (<>
      <Card variant="outlined" padding="lg">
        <LinkDeviceCard />
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
            <code className="mono-path">{relay?.url ?? "https://theblackpearl.tv/api"}</code> — keyless poster and album-art relay.
            If it&apos;s unavailable, your OMDb/TMDB keys are used.
          </p>
          <div className="form-actions settings-actions">
            <Button variant="secondary" icon={rotateCw} loading={relayChecking} disabled={!IN_TAURI} onClick={checkRelay}>Recheck</Button>
          </div>
        </div>
      </Card>

      </>)}

      {tab === "performance" && (
      <Card variant="outlined" padding="lg">
        <PerformancePanel
          onRunPass1={onRunPerfPass1}
          onRunPass2={onRunPerfPass2}
          onRunPass3={onRunPerfPass3}
          onRunPass4={onRunPerfPass4}
          onRunPass5={onRunPerfPass5}
        />
      </Card>

      )}

      {tab === "advanced" && (
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

      )}

      {status && <p className="settings-status">{status}</p>}
      {!IN_TAURI && <p className="field-hint">Settings actions run in the desktop app.</p>}
        </div>
    </div>
  );
}
