import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PlayerProvider } from "./ipc/player";
import { DeviceProvider } from "./contexts/DeviceContext";
import { SyncProvider } from "./contexts/SyncContext";
import { LoadingScreen } from "./components/LoadingScreen";
import { UpdaterSplash } from "./components/UpdaterSplash";
import { VisualizerWindow } from "./components/VisualizerWindow";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyPlatformClasses, IS_TOUCH } from "./lib/platform";
import { IN_TAURI } from "./ipc/engine";
import { installLongPressContextMenu } from "./lib/longpress";

// A rejected promise with no .catch (a failed IPC call, a dropped fetch) otherwise vanishes
// silently; log it so failures are at least diagnosable instead of invisible.
window.addEventListener("unhandledrejection", (e) => {
  console.error("GhostWire unhandled rejection:", e.reason);
});
import { recordPerf, startPerfTimer } from "./lib/perf";

// Base UI design system: base reset + token variables, then the primitives we use.
import "@mattmattmattmatt/base/site/styles/base.css";
import "@mattmattmattmatt/base/primitives/icon/icon.css";
import "@mattmattmattmatt/base/primitives/button/button.css";
import "@mattmattmattmatt/base/primitives/input/input.css";
import "@mattmattmattmatt/base/primitives/card/card.css";
import "@mattmattmattmatt/base/primitives/chip/chip.css";
import "@mattmattmattmatt/base/primitives/spinner/spinner.css";
import "@mattmattmattmatt/base/primitives/skeleton/skeleton.css";
import "@mattmattmattmatt/base/primitives/circular-progress/circular-progress.css";
import "@mattmattmattmatt/base/primitives/dialog/dialog.css";
import "@mattmattmattmatt/base/primitives/segmented-control/segmented-control.css";
import "@mattmattmattmatt/base/primitives/select/select.css";
import "@mattmattmattmatt/base/primitives/toggle/toggle.css";
// GhostWire app styling (loaded last so it can layer on top of Base).
import "./styles/app.css";
import "./styles/app-background.css";

// GhostWire is a dark-only app.
document.documentElement.setAttribute("data-theme", "dark");
// Tag iOS / touch so the shell can drop desktop chrome and adapt for iPad.
applyPlatformClasses();
// Touch devices have no right-click: bridge long-press → context menu (+ haptic).
if (IS_TOUCH) installLongPressContextMenu();

// The pre-launch updater window is transparent (rounded corners) — clear the page background so
// only the rounded loading panel paints and the corners show through the window.
if (window.location.hash.startsWith("#/updater")) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}

// macOS suspends the WKWebView's rendering when the window is occluded (tab away → it goes black);
// on refocus it can stay black until the next natural paint. Nudge a recomposite on the NATIVE
// window-focus event (reliable in WKWebView where JS `window.focus` often doesn't fire) by flipping
// body opacity for one frame — visually imperceptible (0.999 ≈ 1) but forces WebKit to repaint.
void import("@tauri-apps/api/event")
  .then(({ listen }) => {
    void listen("tauri://blur", () => recordPerf("ui", "window.blur.native", 0, {}));
    void listen("tauri://focus", () => {
      // Profiling signal: native focus + how blocked the main thread is on resume (window.focus
      // JS events don't fire reliably in WKWebView, so capture it here instead).
      recordPerf("ui", "window.focus.native", 0, {});
      const t0 = performance.now();
      requestAnimationFrame(() => recordPerf("ui", "resume.firstFrame", performance.now() - t0, {}));
      const t1 = performance.now();
      window.setTimeout(() => recordPerf("ui", "resume.taskDelay", performance.now() - t1, {}), 0);
      // The repaint nudge (see above).
      requestAnimationFrame(() => {
        document.body.style.opacity = "0.999";
        requestAnimationFrame(() => {
          document.body.style.opacity = "";
        });
      });
    });
  })
  .catch(() => {
    // Not in Tauri (browser preview) — nothing to repaint.
  });

// Minimum time the boot loading screen stays up so it never flashes, and a hard ceiling
// after which it fades regardless (a slow first view must not pin the loader forever).
const LOADER_MIN_MS = 700;
const LOADER_MAX_MS = 6_000;

/**
 * Boot flow: mount the app immediately so its data loading overlaps with the loading screen,
 * which owns the window until the app's first paint settles, then fades out. On desktop the
 * main window starts hidden and is revealed by the pre-launch updater window (or self-reveals
 * here as a fallback) so a failed splash can never strand the app off-screen.
 */
function Boot() {
  const [splashDone, setSplashDone] = useState(false);
  const [fading, setFading] = useState(false);
  const splashWaitTimer = useRef(startPerfTimer("startup", "boot.splash_wait"));
  const splashMarkedRef = useRef(false);

  useEffect(() => {
    recordPerf("startup", "boot.mount", 0, {});
    recordPerf("startup", "boot.app_preload_start", 0, {});
  }, []);

  // Reveal this (possibly hidden) main window: promptly when the updater window hands off,
  // and unconditionally after a short fallback so a missing/failed splash can't hide the app.
  useEffect(() => {
    if (!IN_TAURI) return;
    let revealed = false;
    let unlisten: (() => void) | undefined;
    const reveal = async () => {
      if (revealed) return;
      revealed = true;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();
        await w.show().catch(() => {});
        await w.setFocus().catch(() => {});
      } catch { /* not Tauri */ }
    };
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("splash://proceed", () => void reveal()).then((un) => { unlisten = un; }),
    ).catch(() => {});
    const fallback = window.setTimeout(() => void reveal(), 8_000);
    return () => { window.clearTimeout(fallback); unlisten?.(); };
  }, []);

  // Dismiss the loading screen once the app has had a paint or two (min display to avoid a
  // flash, max ceiling so a heavy first view can't pin it). App code can also dispatch a
  // `ghostwire:app-ready` window event to dismiss it precisely the moment data is usable.
  useEffect(() => {
    const finish = () => {
      if (splashMarkedRef.current) return;
      splashMarkedRef.current = true;
      splashWaitTimer.current({ showApp: true, preloaded: true });
      setFading(true);
      window.setTimeout(() => setSplashDone(true), 450); // let the fade finish, then unmount
    };
    const min = window.setTimeout(finish, LOADER_MIN_MS);
    const max = window.setTimeout(finish, LOADER_MAX_MS);
    const onReady = () => finish();
    window.addEventListener("ghostwire:app-ready", onReady);
    return () => {
      window.clearTimeout(min);
      window.clearTimeout(max);
      window.removeEventListener("ghostwire:app-ready", onReady);
    };
  }, []);

  useEffect(() => {
    if (!splashDone) return;
    recordPerf("startup", "boot.app_visible", 0, {});
  }, [splashDone]);

  return (
    <>
      <DeviceProvider>
        <SyncProvider>
          <PlayerProvider>
            <App />
          </PlayerProvider>
        </SyncProvider>
      </DeviceProvider>
      {!splashDone && <LoadingScreen status="Loading…" fading={fading} />}
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {window.location.hash.startsWith("#/updater") ? (
        <UpdaterSplash />
      ) : window.location.hash.startsWith("#/visualizer") ? (
        <VisualizerWindow />
      ) : (
        <Boot />
      )}
    </ErrorBoundary>
  </React.StrictMode>,
);
