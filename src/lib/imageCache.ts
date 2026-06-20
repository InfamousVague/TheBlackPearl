import { IN_TAURI } from "../ipc/engine";

// The engine's loopback image cache (engine.rs STREAM_PORT = 3030, route /img).
const LOOPBACK = "http://127.0.0.1:3030/img";
// Must mirror `is_cacheable_image_host` in engine.rs — the hosts the cache will fetch from.
const CACHEABLE = /^https:\/\/(theblackpearl\.tv|covers\.openlibrary\.org|image\.tmdb\.org|[a-z0-9-]+\.mzstatic\.com)\//i;

/**
 * Rewrite a remote artwork URL to the local on-disk image cache so repeat browses + relaunches
 * serve from disk instead of re-hitting the relay. Returns undefined when caching doesn't apply
 * (browser preview with no loopback server, local `/art` or data URLs, or an un-allowed host) —
 * the caller then loads the original URL directly. Pair with a fall-back-to-origin on error, since
 * the loopback server isn't up for the first moment after launch.
 */
export function cachedImageUrl(url?: string): string | undefined {
  if (!url || !IN_TAURI) return undefined;
  if (!CACHEABLE.test(url)) return undefined;
  return `${LOOPBACK}?u=${encodeURIComponent(url)}`;
}
