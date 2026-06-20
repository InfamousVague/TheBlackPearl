// Persistent cold-start seed for the iPad companion. The Mac's /api/snapshot returns the whole
// index (catalog + library + downloaded) in one shot; we stash it in localStorage so reopening
// the app paints every view instantly from disk, then revalidates against the host's cheap
// version probe and swaps only if something changed. localStorage (not the Tauri settings table
// or a fs plugin) is deliberate: the read is synchronous inside a useState initializer — the
// whole point is a populated first frame. ~5MB WKWebView cap, so we trim the catalog and guard
// writes against quota; library + downloaded (the user's own content) are persisted in full.
import type { CatalogItem } from "./types";
import type { DownloadedItem, LibraryItem } from "../ipc/library";

const KEY = "ghosty.snapshot.v1";
// Hard caps so the persisted blob stays well under the WKWebView ~5 MB localStorage quota AND so
// the in-memory/rendered set never OOMs the iPad's web content process (the cause of the black
// screen on a large library). These are the cold-start SEED only — the live data still refreshes
// in full from the host. The backend /api/snapshot already caps catalog/library to match.
const MAX_CATALOG = 800;
const MAX_LIBRARY = 600;
const MAX_DOWNLOADED = 1000;

export interface PersistedSnapshot {
  version: number;
  catalog: CatalogItem[];
  library: LibraryItem[];
  downloaded: DownloadedItem[];
  savedAt: number;
  /** linkedMac.deviceId the snapshot came from — discarded if the user re-pairs to a different Mac. */
  hostId: string;
}

/** Load the persisted snapshot, or null. Ignores a snapshot saved against a DIFFERENT linked
 *  Mac so re-pairing to another host never paints stale content. */
export function loadSnapshot(hostId: string | null): PersistedSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as PersistedSnapshot;
    if (!s || !Array.isArray(s.catalog) || !Array.isArray(s.downloaded)) return null;
    if (hostId && s.hostId && s.hostId !== hostId) return null;
    return s;
  } catch {
    return null;
  }
}

/** Persist a snapshot. Trims the catalog and swallows quota/private-mode errors — the copy is
 *  only an instant-paint seed; the live data still refreshes from the host regardless. */
export function saveSnapshot(s: PersistedSnapshot): void {
  try {
    const trimmed: PersistedSnapshot = {
      ...s,
      catalog: s.catalog.slice(0, MAX_CATALOG),
      library: s.library.slice(0, MAX_LIBRARY),
      downloaded: s.downloaded.slice(0, MAX_DOWNLOADED),
      savedAt: s.savedAt || Date.now(),
    };
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    /* quota exceeded or storage unavailable — the seed is optional, skip it */
  }
}

export function clearSnapshot(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
