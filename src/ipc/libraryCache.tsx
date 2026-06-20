// Shared, stale-while-revalidate cache for the on-disk library (`list_downloaded`).
//
// Every media tab (Library / Movies / TV / Music / Downloads) used to call
// `listDownloaded()` in a fresh `useEffect(..., [])` on mount — so each tab switch
// re-ran the recursive disk scan AND flashed a spinner over a blank screen, even when
// you'd just been there. This provider holds the last scan at the App root: views read
// the cached list synchronously (instant paint, no spinner on revisit) and quietly
// revalidate in the background. A single in-flight promise dedups concurrent refreshes.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { IN_TAURI } from "./engine";
import { listDownloaded, type DownloadedItem } from "./library";
import { getActiveDevice } from "./remote";
import { getSyncApi } from "./syncReport";
import { useLinkedDevice, readLinkedDeviceIdSync } from "../contexts/DeviceContext";
import { useSync } from "../contexts/SyncContext";
import { loadSnapshot } from "../lib/snapshotCache";
import { IS_IOS } from "../lib/platform";
import { MOCK_DOWNLOADED } from "../lib/mockLibrary";
import { recordPerf, startPerfTimer } from "../lib/perf";

interface LibraryCache {
  /** `null` until the first scan resolves; then the cached list. View loading = `items === null`. */
  items: DownloadedItem[] | null;
  /** A scan/mirror is currently in flight (initial load or revalidation). */
  loading: boolean;
  /** Re-scan the library (deduped while one is already in flight). Resolves to the fresh list. */
  refresh: () => Promise<DownloadedItem[]>;
}

const Ctx = createContext<LibraryCache | null>(null);

/** Cheap structural compare so a revalidation that returns identical data doesn't re-render. */
function sameItems(a: DownloadedItem[] | null, b: DownloadedItem[]): boolean {
  if (a === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.inLibrary !== y.inLibrary || x.addedAt !== y.addedAt || x.sizeBytes !== y.sizeBytes) {
      return false;
    }
  }
  return true;
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  // Seed from the persisted companion snapshot so the iPad's Library/Movies/TV/Music tabs paint
  // instantly on cold start. Null on desktop (nothing persisted) → normal first-scan spinner.
  const [items, setItems] = useState<DownloadedItem[] | null>(
    () => loadSnapshot(readLinkedDeviceIdSync())?.downloaded ?? null,
  );
  const [loading, setLoading] = useState(false);
  const inflight = useRef<Promise<DownloadedItem[]> | null>(null);
  const { linkedMac } = useLinkedDevice();
  const { state: sync } = useSync();

  const refreshTagged = useCallback((reason: string) => {
    const done = startPerfTimer("library", "libraryCache.refresh", {
      reason,
      source: IN_TAURI ? "tauri" : "mock",
    });
    if (!IN_TAURI) {
      // Browser preview has no backend library — paint a fixture so the
      // Music/Library views have something to lay out against (dev-only).
      let changed = false;
      setItems((cur) => {
        changed = cur === null;
        return cur ?? MOCK_DOWNLOADED;
      });
      done({ items: MOCK_DOWNLOADED.length, changed });
      return Promise.resolve<DownloadedItem[]>(MOCK_DOWNLOADED);
    }
    // Companion (iPad): downloaded comes from the linked Mac. Before the link is restored there's
    // no host yet — skip rather than hit the empty local backend and clobber the persisted seed.
    // The device-linked effect below re-runs refresh once the host is set.
    if (IS_IOS && !getActiveDevice()) {
      done({ skipped: "no-host" });
      return Promise.resolve<DownloadedItem[]>([]);
    }
    if (inflight.current) {
      recordPerf("library", "libraryCache.refresh.deduped", 0, { reason });
      done({ deduped: true });
      return inflight.current;
    }
    let changed = false;
    let count = 0;
    setLoading(true);
    const sync = getSyncApi();
    sync?.begin("downloaded");
    const p = listDownloaded()
      .then((all) => {
        count = all.length;
        // Keep the old reference when nothing changed so revalidation is render-free.
        setItems((cur) => {
          changed = !sameItems(cur, all);
          return changed ? all : cur;
        });
        sync?.done("downloaded", all.length);
        return all;
      })
      .catch((e) => {
        setItems((cur) => {
          if (cur === null) {
            changed = true;
            return [];
          }
          return cur;
        });
        sync?.fail("downloaded", e);
        return [] as DownloadedItem[];
      })
      .finally(() => {
        done({ items: count, changed });
        inflight.current = null;
        setLoading(false);
      });
    inflight.current = p;
    return p;
  }, []);

  const refresh = useCallback(() => refreshTagged("manual"), [refreshTagged]);

  // Warm the cache once on mount so the first tab opened is already populated.
  useEffect(() => {
    void refreshTagged("mount");
  }, [refreshTagged]);

  // Companion (iPad): the mount scan above can run before the linked Mac is restored from
  // settings — at which point routing was still local and returned an empty list that then
  // got cached. Re-mirror from the host the moment the link comes up (or switches). Skips the
  // first render (deviceId starts null); desktop never links, so this stays a no-op there.
  const deviceId = linkedMac?.deviceId ?? null;
  const seenDevice = useRef(false);
  useEffect(() => {
    if (!seenDevice.current) {
      seenDevice.current = true;
      return;
    }
    void refreshTagged("device-linked");
  }, [deviceId, refreshTagged]);

  // Self-heal the downloaded list when the link to the Mac recovers (offline/connecting → online).
  // The mount/device-linked fetch may have failed while the host was down; re-pull on reconnect so
  // the Library fills in without a manual refresh. Deduped + render-free when nothing changed.
  const prevConn = useRef(sync.connection);
  useEffect(() => {
    const was = prevConn.current;
    prevConn.current = sync.connection;
    if (IS_IOS && was !== "online" && sync.connection === "online") void refreshTagged("reconnect");
  }, [sync.connection, refreshTagged]);

  // Auto-refresh so new content appears without a manual Refresh: when the backend's
  // download-folder watcher fires (a download finished, files were organized/moved) and when the
  // window regains focus. These are RATE-LIMITED: profiling showed the watcher firing ~156 full
  // rescans/min while a torrent wrote chunks — each re-reading audio tags for the whole library
  // (~2.9s) — which was the main source of navigation/refocus lag. Leading+trailing limiter:
  // refresh immediately if it's been a while, else coalesce a burst into one trailing refresh.
  const lastAuto = useRef(0);
  const autoTimer = useRef<number | null>(null);
  const autoRefresh = useCallback(
    (reason: string) => {
      const MIN_GAP_MS = 6000;
      const since = Date.now() - lastAuto.current;
      if (since >= MIN_GAP_MS) {
        lastAuto.current = Date.now();
        void refreshTagged(reason);
      } else if (autoTimer.current == null) {
        autoTimer.current = window.setTimeout(() => {
          autoTimer.current = null;
          lastAuto.current = Date.now();
          void refreshTagged(reason);
        }, MIN_GAP_MS - since);
      }
    },
    [refreshTagged],
  );

  useEffect(() => {
    if (!IN_TAURI) return;
    let un: (() => void) | undefined;
    listen("library://changed", () => autoRefresh("watcher")).then((f) => (un = f));
    const onFocus = () => autoRefresh("focus");
    window.addEventListener("focus", onFocus);
    return () => {
      un?.();
      window.removeEventListener("focus", onFocus);
      if (autoTimer.current != null) window.clearTimeout(autoTimer.current);
    };
  }, [autoRefresh]);

  const value = useMemo(() => ({ items, loading, refresh }), [items, loading, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDownloaded(): LibraryCache {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDownloaded must be used within <LibraryProvider>");
  return c;
}
