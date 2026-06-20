// HTTP client for a linked Mac host's LAN control API (`/api/*`, served by src-tauri's
// engine.rs). Plain fetch — these are cross-device calls, not Tauri invokes. The iPad
// stores a {baseUrl, token} after PIN pairing and authenticates every call with the bearer.

import type { CatalogItem } from "../lib/types";
import type { DownloadedItem, LibraryItem } from "./library";

export interface LinkedDevice {
  /** e.g. "http://192.168.1.50:3030" */
  baseUrl: string;
  /** long-lived bearer token from /api/pair */
  token: string;
  name: string;
  deviceId: string;
}

/** Accept "192.168.1.50", "192.168.1.50:3030", or a full URL → normalized base URL. */
function normalizeBase(address: string): string {
  let a = address.trim();
  if (!/^https?:\/\//i.test(a)) a = `http://${a}`;
  a = a.replace(/\/+$/, "");
  // default the engine port if the user gave only a host
  if (!/:\d+$/.test(a.replace(/^https?:\/\//i, ""))) a = `${a}:3030`;
  return a;
}

/** Exchange a PIN for a bearer token. Throws on a bad/expired PIN or unreachable host. */
export async function pairWithMac(address: string, pin: string): Promise<LinkedDevice> {
  const baseUrl = normalizeBase(address);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: pin.trim() }),
    });
  } catch {
    throw new Error(`Couldn't reach ${baseUrl} — same WiFi, and the Mac app open?`);
  }
  if (!res.ok) {
    throw new Error(res.status === 401 ? "Wrong or expired PIN" : `Pairing failed (${res.status})`);
  }
  const d = (await res.json()) as { token: string; name: string; device_id: string };
  return { baseUrl, token: d.token, name: d.name, deviceId: d.device_id };
}

function authed(dev: LinkedDevice, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${dev.baseUrl}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${dev.token}`, "Content-Type": "application/json" },
  });
}

/** Liveness/auth check — true if the link still works. */
export async function remotePing(dev: LinkedDevice): Promise<boolean> {
  try {
    return (await authed(dev, "/api/device_info")).ok;
  } catch {
    return false;
  }
}

/** Start a download on the Mac; returns its infohash id. */
export async function remoteAddTorrent(dev: LinkedDevice, magnet: string): Promise<string> {
  const r = await authed(dev, "/api/add_torrent", { method: "POST", body: JSON.stringify({ magnet }) });
  if (!r.ok) throw new Error(`Remote download failed (${r.status})`);
  return ((await r.json()) as { id: string }).id;
}

/** The Mac's current downloads (same shape as the local DownloadStats snapshot). */
export async function remoteListDownloads(dev: LinkedDevice): Promise<unknown[]> {
  const r = await authed(dev, "/api/list_downloads");
  if (!r.ok) throw new Error(`Remote list failed (${r.status})`);
  return r.json();
}

/** A fully-qualified, token-bearing stream URL on the Mac (handles transcode via the Mac's ffmpeg). */
export async function remoteStreamUrl(dev: LinkedDevice, id: string, file?: number): Promise<string> {
  const q = new URLSearchParams({ id });
  if (file != null) q.set("file", String(file));
  const r = await authed(dev, `/api/stream_url?${q.toString()}`);
  if (!r.ok) throw new Error(`Remote stream failed (${r.status})`);
  const { url } = (await r.json()) as { url: string };
  return `${dev.baseUrl}${url}`; // server returns a relative path carrying ?tk
}

// ===================== Companion mode (iPad fully mirrors the linked Mac) =====================
// These read the Mac's own data — its on-disk Library, curated Library, indexed catalog
// (Discover) and live source search — so the iPad shows EXACTLY what the Mac shows. The iPad
// streams/plays from the Mac and never downloads or stores anything itself.

async function authedJson<T>(dev: LinkedDevice, path: string): Promise<T> {
  const r = await authed(dev, path);
  if (!r.ok) throw new Error(`Remote request failed (${r.status})`);
  return r.json() as Promise<T>;
}

const LOOPBACK = "http://127.0.0.1:3030";
/** Mirrored items carry the Mac's OWN loopback poster/artwork URLs (`http://127.0.0.1:3030/art/…`),
 *  which are unreachable from the iPad. Rewrite that host to the linked Mac's address so the
 *  cached posters load (the `/art/` route is open on the LAN). https/relay URLs pass through. */
function mirrorArtwork<T>(dev: LinkedDevice, items: T[]): T[] {
  const fix = (u: unknown) =>
    typeof u === "string" && u.startsWith(LOOPBACK) ? dev.baseUrl + u.slice(LOOPBACK.length) : u;
  for (const it of items as Array<Record<string, unknown>>) {
    if (it && typeof it === "object") {
      if (typeof it.poster === "string") it.poster = fix(it.poster);
      if (typeof it.artworkUrl === "string") it.artworkUrl = fix(it.artworkUrl);
    }
  }
  return items;
}

/** The Mac's on-disk Library scan (movies / shows / music), shaped like `listDownloaded()`. */
export async function remoteListDownloaded<T = unknown>(dev: LinkedDevice): Promise<T[]> {
  return mirrorArtwork(dev, await authedJson<T[]>(dev, "/api/list_downloaded"));
}

/** The Mac's curated Library (scanned + enriched), shaped like `listLibrary()`. */
export async function remoteListLibrary<T = unknown>(dev: LinkedDevice): Promise<T[]> {
  return mirrorArtwork(dev, await authedJson<T[]>(dev, "/api/list_library"));
}

/** The Mac's indexed catalog (Discover), shaped like `listCatalog()`. */
export async function remoteListCatalog<T = unknown>(
  dev: LinkedDevice,
  query?: string,
  category?: string,
  sort?: string,
): Promise<T[]> {
  const q = new URLSearchParams();
  if (query) q.set("query", query);
  if (category && category !== "all") q.set("category", category);
  if (sort) q.set("sort", sort);
  const qs = q.toString();
  return mirrorArtwork(dev, await authedJson<T[]>(dev, `/api/list_catalog${qs ? `?${qs}` : ""}`));
}

/** A live source search on the Mac (its sources), shaped like `searchSources()`. */
export async function remoteSearch<T = unknown>(dev: LinkedDevice, query: string): Promise<T[]> {
  return mirrorArtwork(dev, await authedJson<T[]>(dev, `/api/search?q=${encodeURIComponent(query)}`));
}

/** A fully-qualified, token-bearing playback URL for a FINISHED Library file on the Mac,
 *  by its path relative to the Mac's download root (the `id`/relpath of a downloaded item). */
export async function remoteLibraryStreamUrl(dev: LinkedDevice, relpath: string): Promise<string> {
  const { url } = await authedJson<{ url: string }>(
    dev,
    `/api/library_stream_url?relpath=${encodeURIComponent(relpath)}`,
  );
  return `${dev.baseUrl}${url}`; // server returns a relative path carrying ?tk
}

/** The whole companion index in one round-trip — catalog (Discover) + curated library +
 *  on-disk downloaded — so the iPad hydrates every view from a single request and can persist
 *  it for an instant cold-start paint. Posters are rewritten to the Mac's LAN address. */
export interface Snapshot {
  version: number;
  catalogCount: number;
  libraryCount: number;
  downloadedCount: number;
  catalog: CatalogItem[];
  library: LibraryItem[];
  downloaded: DownloadedItem[];
}
export async function remoteSnapshot(dev: LinkedDevice): Promise<Snapshot> {
  const s = await authedJson<Snapshot>(dev, "/api/snapshot");
  return {
    ...s,
    catalog: mirrorArtwork(dev, s.catalog),
    library: mirrorArtwork(dev, s.library),
    downloaded: mirrorArtwork(dev, s.downloaded),
  };
}

/** Cheap "did anything change?" probe — compare `version` to a persisted copy before pulling
 *  the (potentially multi-MB) full snapshot. */
export async function remoteSnapshotVersion(
  dev: LinkedDevice,
): Promise<{ version: number; catalogCount: number }> {
  return authedJson(dev, "/api/snapshot_version");
}

// ---- module-level active-device holder ----
// The ipc/* functions are plain async fns (no React context). `DeviceContext` pushes the
// current linked device here so they can route to the Mac in companion mode.

let activeDevice: LinkedDevice | null = null;

/** Set (or clear) the currently-linked device. Called by `DeviceContext` when it changes. */
export function setActiveDevice(dev: LinkedDevice | null): void {
  activeDevice = dev;
}

/** The currently-linked device, or null. Used by ipc read-wrappers to decide on companion routing. */
export function getActiveDevice(): LinkedDevice | null {
  return activeDevice;
}
