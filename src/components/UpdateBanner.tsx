import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { IN_TAURI } from "../ipc/engine";
import { download, rotateCw, x } from "../lib/icons";
import "./UpdateBanner.css";

// Auto-update notifier. Mirrors Libre's mechanism: dynamically import the
// updater plugin (so the web/preview build never loads it), check on mount +
// hourly, then drive download → install → relaunch from a small floating card.
// `IN_TAURI` keeps this inert in the browser preview (no __TAURI_INTERNALS__).
const RECHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly; 0 disables polling
const DISMISSED_KEY = "bp:update-dismissed-version";

type State =
  | { kind: "idle" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; version: string; downloaded: number; total: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

export function UpdateBanner() {
  const [state, setState] = useState<State>({ kind: "idle" });
  // The Update object returned by check() — reused by downloadAndInstall().
  const updateRef = useRef<{ version: string; body?: string; downloadAndInstall: (cb: (e: ProgressEvent) => void) => Promise<void> } | null>(null);
  const dismissedFor = useRef<string | null>(
    typeof localStorage !== "undefined" ? localStorage.getItem(DISMISSED_KEY) : null,
  );

  useEffect(() => {
    if (!IN_TAURI) return;
    let cancelled = false;
    const runCheck = async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (cancelled) return;
        if (!update) {
          updateRef.current = null;
          return;
        }
        updateRef.current = update as never;
        // Stay quiet for a version the user already dismissed; a newer
        // version (version mismatch) re-surfaces the banner.
        if (dismissedFor.current === update.version) return;
        setState((s) =>
          s.kind === "downloading" || s.kind === "ready"
            ? s // never interrupt an in-flight install
            : { kind: "available", version: update.version, notes: update.body ?? "" },
        );
      } catch (e) {
        // Network blip / missing manifest — swallow, retry next interval.
        console.warn("[updater] check failed:", e);
      }
    };
    void runCheck();
    if (RECHECK_INTERVAL_MS > 0) {
      const id = window.setInterval(runCheck, RECHECK_INTERVAL_MS);
      return () => {
        cancelled = true;
        window.clearInterval(id);
      };
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const onDownload = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    const version = update.version;
    let downloaded = 0;
    let total = 0;
    setState({ kind: "downloading", version, downloaded: 0, total: 0 });
    try {
      await update.downloadAndInstall((ev) => {
        const e = ev as unknown as { event: string; data?: { contentLength?: number; chunkLength?: number } };
        if (e.event === "Started") {
          total = e.data?.contentLength ?? 0;
          setState({ kind: "downloading", version, downloaded: 0, total });
        } else if (e.event === "Progress") {
          downloaded += e.data?.chunkLength ?? 0;
          setState({ kind: "downloading", version, downloaded, total });
        } else if (e.event === "Finished") {
          setState({ kind: "downloading", version, downloaded: total, total });
        }
      });
      setState({ kind: "ready", version });
    } catch (e) {
      console.error("[updater] download failed:", e);
      setState({ kind: "error", message: String(e) });
    }
  }, []);

  const onRestart = useCallback(async () => {
    // Prefer the Rust command: on macOS the plugin's plain relaunch() re-execs
    // before the dying process releases the freshly swapped bundle, so Launch
    // Services can reopen the OLD version. The command fully exits + a detached
    // helper reopens once we're gone. Fall back to plugin-process otherwise.
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("relaunch_for_update");
    } catch {
      try {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch (e) {
        console.error("[updater] relaunch failed:", e);
      }
    }
  }, []);

  const onDismiss = useCallback(() => {
    const v =
      state.kind === "available" || state.kind === "downloading" || state.kind === "ready"
        ? state.version
        : null;
    if (v && typeof localStorage !== "undefined") {
      localStorage.setItem(DISMISSED_KEY, v);
      dismissedFor.current = v;
    }
    setState({ kind: "idle" });
  }, [state]);

  if (!IN_TAURI || state.kind === "idle") return null;

  const pct =
    state.kind === "downloading" && state.total > 0
      ? Math.min(100, (state.downloaded / state.total) * 100)
      : null;

  return (
    <div className={`bp-update bp-update--${state.kind}`} role="status" aria-live="polite">
      <div className="bp-update-icon">
        <Icon icon={state.kind === "ready" ? rotateCw : download} size="sm" />
      </div>
      <div className="bp-update-body">
        {state.kind === "available" && (
          <>
            <div className="bp-update-title">Update available — v{state.version}</div>
            <div className="bp-update-sub">A new version of The Black Pearl is ready to install.</div>
          </>
        )}
        {state.kind === "downloading" && (
          <>
            <div className="bp-update-title">Downloading v{state.version}…</div>
            <div className="bp-update-progress">
              <span style={{ width: pct != null ? `${pct}%` : "8%" }} />
            </div>
            <div className="bp-update-sub">
              {state.total > 0 ? `${formatBytes(state.downloaded)} / ${formatBytes(state.total)}` : "Starting…"}
            </div>
          </>
        )}
        {state.kind === "ready" && (
          <>
            <div className="bp-update-title">Update installed</div>
            <div className="bp-update-sub">Restart to finish updating to v{state.version}.</div>
          </>
        )}
        {state.kind === "error" && (
          <>
            <div className="bp-update-title">Update failed</div>
            <div className="bp-update-sub">{state.message}</div>
          </>
        )}
      </div>
      <div className="bp-update-actions">
        {state.kind === "available" && (
          <button className="bp-update-btn primary" onClick={onDownload}>
            Install
          </button>
        )}
        {state.kind === "ready" && (
          <button className="bp-update-btn primary" onClick={onRestart} autoFocus>
            Restart
          </button>
        )}
        {state.kind === "error" && (
          <button className="bp-update-btn" onClick={onDownload}>
            Retry
          </button>
        )}
        {state.kind !== "downloading" && (
          <button className="bp-update-x" onClick={onDismiss} aria-label="Dismiss">
            <Icon icon={x} size="sm" />
          </button>
        )}
      </div>
    </div>
  );
}
