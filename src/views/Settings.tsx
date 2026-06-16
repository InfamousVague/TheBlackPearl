import { useEffect, useState } from "react";
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
  restartApp,
  setSetting,
  setStorageDir,
  tidalAuthStatus,
  tidalAuthorizeLogin,
  tidalClearCredentials,
  tidalSaveCredentials,
  tidalTestAuth,
  type AiStatus,
  type AppInfo,
  type TidalAuthStatus,
} from "../ipc/library";
import { cpu, film, folderDown, folderOpen, hardDrive, rotateCw, sparkles } from "../lib/icons";
import { IS_IOS } from "../lib/platform";

export function Settings({ onCatalogChanged }: { onCatalogChanged: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tmdbKey, setTmdbKey] = useState("");
  const [omdbKey, setOmdbKey] = useState("");
  const [tidalApiUrl, setTidalApiUrl] = useState("");
  const [tidalClientId, setTidalClientId] = useState("");
  const [tidalClientSecret, setTidalClientSecret] = useState("");
  const [tidalRefreshToken, setTidalRefreshToken] = useState("");
  const [tidalRedirectUri, setTidalRedirectUri] = useState("");
  const [tidalAuth, setTidalAuth] = useState<TidalAuthStatus | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [autoCleanup, setAutoCleanup] = useState(true);
  // Storage-folder change flow.
  const [chosenDir, setChosenDir] = useState<string | null>(null);
  const [migrate, setMigrate] = useState(true);
  const [needsRestart, setNeedsRestart] = useState(false);

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

  useEffect(() => {
    if (!IN_TAURI) return;
    appInfo().then(setInfo).catch(() => {});
    getSetting("tmdb_key").then((k) => setTmdbKey(k ?? "")).catch(() => {});
    getSetting("omdb_key").then((k) => setOmdbKey(k ?? "")).catch(() => {});
    getSetting("spotiflac_tidal_api").then((k) => setTidalApiUrl(k ?? "")).catch(() => {});
    getSetting("tidal_oauth_redirect_uri")
      .then((k) => setTidalRedirectUri(k ?? "http://127.0.0.1:46171/tidal/callback"))
      .catch(() => {});
    getSetting("auto_cleanup").then((v) => setAutoCleanup(v !== "false")).catch(() => {});
    tidalAuthStatus().then(setTidalAuth).catch(() => {});
    aiStatus().then(setAi).catch(() => {});
  }, []);

  async function saveTidalAppCreds() {
    if (!IN_TAURI) return;
    setBusy("tidal-save");
    setStatus("");
    try {
      const next = await tidalSaveCredentials(tidalClientId, tidalClientSecret, tidalRefreshToken.trim() || null);
      setTidalAuth(next);
      setTidalClientId("");
      setTidalClientSecret("");
      setTidalRefreshToken("");
      setStatus(
        next.hasRefreshToken
          ? "TIDAL credentials and account refresh token saved to Keychain."
          : "TIDAL app credentials saved to Keychain.",
      );
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function testTidalCreds() {
    if (!IN_TAURI) return;
    setBusy("tidal-test");
    setStatus("");
    try {
      const res = await tidalTestAuth();
      const next = await tidalAuthStatus();
      setTidalAuth(next);
      setStatus(
        `TIDAL auth OK (${res.authMode.replace(/_/g, " ")}). ${res.tokenType} token valid for ${Math.max(1, Math.round(res.expiresIn / 60))} min.`,
      );
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function authorizeTidalLogin() {
    if (!IN_TAURI) return;
    setBusy("tidal-authorize");
    setStatus("");
    try {
      if (tidalClientId.trim() && tidalClientSecret.trim()) {
        await tidalSaveCredentials(tidalClientId, tidalClientSecret, null);
        setTidalClientId("");
        setTidalClientSecret("");
      }
      const redirect = tidalRedirectUri.trim() || "http://127.0.0.1:46171/tidal/callback";
      await setSetting("tidal_oauth_redirect_uri", redirect);
      const res = await tidalAuthorizeLogin(redirect);
      const next = await tidalAuthStatus();
      setTidalAuth(next);
      setTidalRefreshToken("");
      setStatus(
        `TIDAL login complete (${res.authMode.replace(/_/g, " ")}). Refresh token saved to Keychain and ${res.tokenType} token valid for ${Math.max(1, Math.round(res.expiresIn / 60))} min.`,
      );
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function clearTidalCreds() {
    if (!IN_TAURI) return;
    setBusy("tidal-clear");
    setStatus("");
    try {
      const next = await tidalClearCredentials();
      setTidalAuth(next);
      setTidalClientId("");
      setTidalClientSecret("");
      setTidalRefreshToken("");
      setStatus("TIDAL app credentials cleared.");
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(null);
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
      await setSetting("spotiflac_tidal_api", tidalApiUrl.trim());
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

  return (
    <div className="section-stack">
      <div className="cat-header" style={{ marginBottom: 4 }}>
        <span className="cat-title">Settings</span>
      </div>

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
            When a download finishes it's tidied into your Organized library (clean Plex-style
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
            poster fallback. TIDAL downloads in the Music tab default to SpotiFLAC's community
            mirror pool (no account required). Set a Tidal API URL only if you run your own
            hifi-api instance.
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
          <div className="field">
            <label className="field-label">Tidal API URL — optional self-hosted override</label>
            <Input
              placeholder="https://your-hifi-api.example.com"
              value={tidalApiUrl}
              onChange={(e) => setTidalApiUrl(e.currentTarget.value)}
            />
            <p className="field-hint">
              Passed to SpotiFLAC as <b>--tidal-api</b>. Leave blank to use SpotiFLAC's built-in
              public mirror pool.
            </p>
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

      {!IS_IOS && (
      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">TIDAL app auth</h4>
          <p className="field-hint">
            Store your TIDAL developer app credentials securely in macOS Keychain and optionally add an account refresh token for playback-grade auth.
            This is optional advanced setup and is not required for the default SpotiFLAC community mirror mode.
          </p>
          <p className="field-hint">
            If TIDAL login shows error 1002 or permission errors, skip OAuth and use default community mirrors, or set a custom self-hosted hifi-api URL above.
          </p>
          <div className="field">
            <label className="field-label">Client ID</label>
            <Input
              placeholder={tidalAuth?.hasClientId ? "Saved in Keychain" : "TIDAL Client ID"}
              value={tidalClientId}
              onChange={(e) => setTidalClientId(e.currentTarget.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">Client Secret</label>
            <Input
              type="password"
              placeholder={tidalAuth?.hasClientSecret ? "Saved in Keychain" : "TIDAL Client Secret"}
              value={tidalClientSecret}
              onChange={(e) => setTidalClientSecret(e.currentTarget.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">Refresh token (account token)</label>
            <Input
              type="password"
              placeholder={tidalAuth?.hasRefreshToken ? "Saved in Keychain" : "Paste a TIDAL OAuth refresh token"}
              value={tidalRefreshToken}
              onChange={(e) => setTidalRefreshToken(e.currentTarget.value)}
            />
            <p className="field-hint">When present, Ghosty uses refresh-token auth for TIDAL playback lookups instead of app-only client credentials.</p>
          </div>
          <div className="field">
            <label className="field-label">OAuth redirect URI</label>
            <Input
              placeholder="http://127.0.0.1:46171/tidal/callback"
              value={tidalRedirectUri}
              onChange={(e) => setTidalRedirectUri(e.currentTarget.value)}
            />
            <p className="field-hint">
              Must exactly match your TIDAL app redirect URI. Ghosty listens on this localhost URL to capture the login code and save your refresh token.
            </p>
          </div>
          <div className="settings-row">
            <span className="settings-label">Stored credentials</span>
            <span className="settings-val">
              {tidalAuth == null
                ? "—"
                : tidalAuth.hasClientId && tidalAuth.hasClientSecret
                  ? "Client ID + Secret saved"
                  : "Not configured"}
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Stored refresh token</span>
            <span className="settings-val">{tidalAuth?.hasRefreshToken ? "Present" : "None"}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Cached access token</span>
            <span className="settings-val">
              {tidalAuth?.hasAccessToken && tidalAuth.accessTokenExpiresAt
                ? `Present until ${new Date(tidalAuth.accessTokenExpiresAt * 1000).toLocaleString()}`
                : "None"}
            </span>
          </div>
          <p className="field-hint">
            A saved manual Tidal API URL still wins. Clear that override to return to SpotiFLAC's default public mirror pool.
          </p>
          <div className="form-actions settings-actions">
            <Button
              variant="primary"
              loading={busy === "tidal-save"}
              disabled={
                !IN_TAURI
                || !(
                  (tidalClientId.trim().length > 0 && tidalClientSecret.trim().length > 0)
                  || (Boolean(tidalAuth?.hasClientId && tidalAuth?.hasClientSecret) && tidalRefreshToken.trim().length > 0)
                )
              }
              onClick={saveTidalAppCreds}
            >
              Save TIDAL creds
            </Button>
            <Button
              variant="secondary"
              loading={busy === "tidal-authorize"}
              disabled={
                !IN_TAURI
                || !(
                  Boolean(tidalAuth?.hasClientId && tidalAuth?.hasClientSecret)
                  || (tidalClientId.trim().length > 0 && tidalClientSecret.trim().length > 0)
                )
              }
              onClick={authorizeTidalLogin}
            >
              Get refresh token
            </Button>
            <Button
              variant="secondary"
              loading={busy === "tidal-test"}
              disabled={!IN_TAURI || !(tidalAuth?.hasClientId && tidalAuth?.hasClientSecret)}
              onClick={testTidalCreds}
            >
              Test auth
            </Button>
            <Button
              variant="ghost"
              loading={busy === "tidal-clear"}
              disabled={!IN_TAURI || !(tidalAuth?.hasClientId || tidalAuth?.hasClientSecret || tidalAuth?.hasAccessToken)}
              onClick={clearTidalCreds}
            >
              Clear
            </Button>
          </div>
        </div>
      </Card>
      )}

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
