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
import { MOCK_DOWNLOADED } from "../lib/mockLibrary";

interface LibraryCache {
  /** `null` until the first scan resolves; then the cached list. View loading = `items === null`. */
  items: DownloadedItem[] | null;
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
  const [items, setItems] = useState<DownloadedItem[] | null>(null);
  const inflight = useRef<Promise<DownloadedItem[]> | null>(null);

  const refresh = useCallback(() => {
    if (!IN_TAURI) {
      // Browser preview has no backend library — paint a fixture so the
      // Music/Library views have something to lay out against (dev-only).
      setItems((cur) => cur ?? MOCK_DOWNLOADED);
      return Promise.resolve<DownloadedItem[]>(MOCK_DOWNLOADED);
    }
    if (inflight.current) return inflight.current;
    const p = listDownloaded()
      .then((all) => {
        // Keep the old reference when nothing changed so revalidation is render-free.
        setItems((cur) => (sameItems(cur, all) ? cur : all));
        return all;
      })
      .catch(() => {
        setItems((cur) => cur ?? []);
        return [] as DownloadedItem[];
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = p;
    return p;
  }, []);

  // Warm the cache once on mount so the first tab opened is already populated.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-refresh so new content appears without a manual Refresh: when the backend's
  // download-folder watcher fires (a download finished, files were organized/moved, etc.)
  // and whenever the window regains focus. The refresh is deduped + render-free when
  // nothing actually changed, so these are cheap.
  useEffect(() => {
    if (!IN_TAURI) return;
    let un: (() => void) | undefined;
    listen("library://changed", () => void refresh()).then((f) => (un = f));
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      un?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const value = useMemo(() => ({ items, refresh }), [items, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDownloaded(): LibraryCache {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDownloaded must be used within <LibraryProvider>");
  return c;
}
