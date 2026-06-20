import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { IN_TAURI } from "../ipc/engine";
import { IS_IOS } from "../lib/platform";
import { download, rotateCw, x } from "../lib/icons";
import "./UpdateBanner.css";

// Auto-update notifier. Mirrors Libre's mechanism: dynamically import the
// updater plugin (so the web/preview build never loads it), check on mount +
// hourly, then drive download → install → relaunch from a small floating card.
// `IN_TAURI` keeps this inert in the browser preview (no __TAURI_INTERNALS__).
const RECHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly steady-state; 0 disables polling
// After a FAILED check, retry on a fast backoff instead of waiting the full hour — a
// transient startup network blip shouldn't delay an update for an hour.
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000]; // 30s → 2m → 5m, then 5m
const FIRST_CHECK_DELAY_MS = 3_000; // let app startup / network settle before the first check
const CHECK_TIMEOUT_MS = 30_000; // a hung endpoint must not block the check loop
const STALL_TIMEOUT_MS = 90_000; // no download progress this long → surface a retry
const DISMISSED_KEY = "bp:update-dismissed-version";

/** Reject if `p` doesn't settle within `ms` — keeps a hung network call from wedging us. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

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
    // OTA self-update (Tauri updater) is impossible on iOS — never import the
    // plugin or poll there. Desktop keeps the full check + polling.
    if (!IN_TAURI || IS_IOS) return;
    let cancelled = false;
    let timer: number | undefined;
    let checking = false; // guard against an interval firing over an in-flight check
    let failures = 0; // drives the fast retry backoff after a failed check

    const schedule = (ms: number) => {
      if (cancelled || ms <= 0) return; // ms<=0 (e.g. RECHECK disabled) → stop polling
      timer = window.setTimeout(() => void runCheck(), ms);
    };

    async function runCheck() {
      if (cancelled || checking) return;
      checking = true;
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await withTimeout(check(), CHECK_TIMEOUT_MS, "update check");
        if (cancelled) return;
        failures = 0; // success → back to the slow steady-state cadence
        if (!update) {
          updateRef.current = null;
        } else {
          updateRef.current = update as never;
          // Stay quiet for a version the user already dismissed; a newer version
          // (version mismatch) re-surfaces the banner. Never interrupt an install.
          if (dismissedFor.current !== update.version) {
            setState((s) =>
              s.kind === "downloading" || s.kind === "ready"
                ? s
                : { kind: "available", version: update.version, notes: update.body ?? "" },
            );
          }
        }
        schedule(RECHECK_INTERVAL_MS);
      } catch (e) {
        // Network blip / missing manifest / timeout — retry soon on a backoff.
        console.warn("[updater] check failed:", e);
        if (!cancelled) {
          const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)];
          failures += 1;
          schedule(delay);
        }
      } finally {
        checking = false;
      }
    }

    timer = window.setTimeout(() => void runCheck(), FIRST_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const onDownload = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    const version = update.version;
    let downloaded = 0;
    let total = 0;
    let lastTick = Date.now();
    let stalled = false;
    setState({ kind: "downloading", version, downloaded: 0, total: 0 });

    // Watchdog: a download that makes no progress for STALL_TIMEOUT_MS would otherwise
    // leave the banner stuck on "downloading" forever (its dismiss button is hidden), so
    // flip to a retryable error instead.
    const watchdog = window.setInterval(() => {
      if (!stalled && Date.now() - lastTick > STALL_TIMEOUT_MS) {
        stalled = true;
        window.clearInterval(watchdog);
        setState({ kind: "error", message: "Download stalled — check your connection and retry." });
      }
    }, 5_000);

    try {
      await update.downloadAndInstall((ev) => {
        lastTick = Date.now();
        if (stalled) return; // already gave up; ignore late events
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
      window.clearInterval(watchdog);
      if (!stalled) setState({ kind: "ready", version });
    } catch (e) {
      window.clearInterval(watchdog);
      if (!stalled) {
        console.error("[updater] download failed:", e);
        setState({ kind: "error", message: String(e) });
      }
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

  if (IS_IOS || !IN_TAURI || state.kind === "idle") return null;

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
            <div className="bp-update-sub">A new version of GhostWire is ready to install.</div>
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
