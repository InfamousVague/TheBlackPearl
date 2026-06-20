import { useEffect, useRef, useState } from "react";
import { IN_TAURI } from "../ipc/engine";
import { IS_IOS } from "../lib/platform";
import { LoadingScreen } from "./LoadingScreen";

// The small Discord-style pre-launch window. It checks for an update before the main
// window is shown: if one is found it downloads + installs it and relaunches; otherwise
// it reveals the (hidden) main window and closes itself. Renders the shared LoadingScreen
// so boot + updater feel like one screen.

const CHECK_TIMEOUT_MS = 8_000; // a hung manifest must never trap the user on the splash
const STALL_TIMEOUT_MS = 90_000; // no download progress this long → give up and just launch
const MAX_SPLASH_MS = 12_000; // hard ceiling: whatever happens, hand off to the app by then

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

function pct(downloaded: number, total: number): number | null {
  return total > 0 ? downloaded / total : null;
}

export function UpdaterSplash() {
  const [status, setStatus] = useState("Starting…");
  const [progress, setProgress] = useState<number | null>(null);
  const handedOff = useRef(false);

  useEffect(() => {
    let cancelled = false;

    // Reveal the (hidden) main window and close this splash. Idempotent — the main window
    // also reveals itself on its own readiness, so a failure here can't strand the app.
    async function handOff() {
      if (handedOff.current) return;
      handedOff.current = true;
      setStatus("Starting…");
      if (!IN_TAURI) return;
      try {
        const [{ WebviewWindow }, { emit }] = await Promise.all([
          import("@tauri-apps/api/webviewWindow"),
          import("@tauri-apps/api/event"),
        ]);
        await emit("splash://proceed").catch(() => {});
        const main = await WebviewWindow.getByLabel("main");
        await main?.show().catch(() => {});
        await main?.setFocus().catch(() => {});
        const me = await WebviewWindow.getByLabel("splashscreen");
        // Brief beat so the main window paints before we tear the splash down.
        setTimeout(() => { void me?.close().catch(() => {}); }, 400);
      } catch {
        /* main self-reveals as a fallback */
      }
    }

    async function run() {
      // No updater on the web preview or iOS — just hand straight off after a short beat.
      if (!IN_TAURI || IS_IOS) {
        setStatus("Loading…");
        setTimeout(() => void handOff(), 700);
        return;
      }
      // Absolute ceiling: never let a wedged check/download trap launch.
      const ceiling = window.setTimeout(() => void handOff(), MAX_SPLASH_MS);
      try {
        setStatus("Checking for updates…");
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await withTimeout(check(), CHECK_TIMEOUT_MS, "update check");
        if (cancelled) return;

        if (!update) {
          window.clearTimeout(ceiling);
          await handOff();
          return;
        }

        // An update is available — prefetch + install it before the app opens.
        setStatus(`Downloading update ${update.version}…`);
        setProgress(0);
        let downloaded = 0;
        let total = 0;
        let lastTick = Date.now();
        let stalled = false;
        const watchdog = window.setInterval(() => {
          if (!stalled && Date.now() - lastTick > STALL_TIMEOUT_MS) {
            stalled = true;
            window.clearInterval(watchdog);
            window.clearTimeout(ceiling);
            void handOff(); // download wedged → just launch the current version
          }
        }, 5_000);

        await update.downloadAndInstall((ev) => {
          lastTick = Date.now();
          if (stalled) return;
          const e = ev as unknown as { event: string; data?: { contentLength?: number; chunkLength?: number } };
          if (e.event === "Started") {
            total = e.data?.contentLength ?? 0;
            setProgress(pct(0, total));
          } else if (e.event === "Progress") {
            downloaded += e.data?.chunkLength ?? 0;
            setProgress(pct(downloaded, total));
          } else if (e.event === "Finished") {
            setProgress(1);
          }
        });
        window.clearInterval(watchdog);
        if (cancelled || stalled) return;

        // Installed — relaunch into the new version (the macOS-safe path fully exits then
        // re-opens, avoiding Launch Services reopening the pre-swap bundle).
        setStatus("Restarting to finish update…");
        window.clearTimeout(ceiling);
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("relaunch_for_update");
        } catch {
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
        }
      } catch (e) {
        // Network blip / missing manifest / timeout — don't block launch over an update.
        console.warn("[updater-splash] prelaunch check failed:", e);
        window.clearTimeout(ceiling);
        if (!cancelled) await handOff();
      }
    }

    void run();
    return () => { cancelled = true; };
  }, []);

  return <LoadingScreen compact status={status} progress={progress} />;
}
