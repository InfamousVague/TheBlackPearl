// IPC for the GhostWire social network (P1.2) — a Soulseek-style friend layer.
//
// The coordination server is a pure address-book + signaling relay: identities (Ed25519
// pubkey ↔ handle), the follow graph, and live presence + friend-to-friend search/browse
// routing. It never sees content or magnets — every transfer still happens peer-to-peer
// over BitTorrent once you grab a returned infohash. Auth is keyless (the Rust backend
// holds the Ed25519 key); these wrappers just drive the backend commands and events.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { IN_TAURI } from "./engine";

/** Default public endpoint (path-based behind Caddy on the GhostWire VPS). */
export const DEFAULT_SOCIAL_URL = "https://ghostwire.tv/social";

export interface SocialStatus {
  /** This install's Ed25519 public key (base64url) — stable identity. */
  pubkey: string;
  /** The claimed handle, or null until registered. */
  handle: string | null;
  /** Coordination server base URL in use. */
  baseUrl: string;
  /** Has this identity claimed a handle? */
  registered: boolean;
  /** Live WebSocket currently connected? */
  connected: boolean;
}

export interface FriendPresence {
  handle: string;
  online: boolean;
}

/** One shared item a friend is seeding (the only thing the server ever relays). */
export interface ShareItem {
  infohash: string;
  name: string;
  category?: string | null;
  /** Finer media type — "movie" / "show" / "music" / "book" / "game" — when known. */
  mediaType?: string | null;
  sizeBytes?: number | null;
  /** Music tags read from the seeder's file, so we resolve the exact album cover. */
  artist?: string | null;
  album?: string | null;
  title?: string | null;
  /** Seeder socket addresses (`ip:port`) to dial directly so the transfer actually starts. */
  peers?: string[] | null;
}

export interface SearchHit {
  /** Correlates with the id returned by `socialSearch`. */
  id: string;
  /** Friend handle the hits came from. */
  from: string;
  items: ShareItem[];
}

export interface BrowseResult {
  id: string;
  handle: string;
  items: ShareItem[];
}

export interface ReadyEvent {
  handle: string;
  friends: FriendPresence[];
}

export interface PresenceEvent {
  handle: string;
  online: boolean;
}

const unsupported = (): Promise<never> =>
  Promise.reject(new Error("Social networking is only available in the desktop app."));

/** Current identity + connection status (safe to call any time). */
export function socialStatus(): Promise<SocialStatus> {
  if (!IN_TAURI) return unsupported();
  return invoke<SocialStatus>("social_status");
}

/** Claim a brand-new handle for this identity, then connect. */
export function socialRegister(handle: string, baseUrl?: string): Promise<SocialStatus> {
  if (!IN_TAURI) return unsupported();
  return invoke<SocialStatus>("social_register", { handle, baseUrl: baseUrl ?? null });
}

/** Sign in an existing identity (challenge/response) and open the live socket. */
export function socialLogin(baseUrl?: string): Promise<SocialStatus> {
  if (!IN_TAURI) return unsupported();
  return invoke<SocialStatus>("social_login", { baseUrl: baseUrl ?? null });
}

export function socialDisconnect(): Promise<void> {
  if (!IN_TAURI) return Promise.resolve();
  return invoke("social_disconnect").then(() => undefined);
}

/** Mutual follows (your "friends"), with live presence. */
export function socialFriends(): Promise<FriendPresence[]> {
  if (!IN_TAURI) return Promise.resolve([]);
  return invoke<FriendPresence[]>("social_friends");
}

/** Accounts you follow. */
export function socialFollowing(): Promise<FriendPresence[]> {
  if (!IN_TAURI) return Promise.resolve([]);
  return invoke<FriendPresence[]>("social_following");
}

/** Accounts that follow you. */
export function socialFollowers(): Promise<FriendPresence[]> {
  if (!IN_TAURI) return Promise.resolve([]);
  return invoke<FriendPresence[]>("social_followers");
}

export function socialFollow(handle: string): Promise<void> {
  if (!IN_TAURI) return unsupported();
  return invoke("social_follow", { handle }).then(() => undefined);
}

export function socialUnfollow(handle: string): Promise<void> {
  if (!IN_TAURI) return unsupported();
  return invoke("social_unfollow", { handle }).then(() => undefined);
}

export function socialReport(handle: string, reason: string, infohash?: string): Promise<void> {
  if (!IN_TAURI) return unsupported();
  return invoke("social_report", { handle, reason, infohash: infohash ?? null }).then(() => undefined);
}

/** Fan out a search to all online friends; hits arrive via `onSearchHit`. Returns a
 *  request id you can use to discard stale hits when issuing a new search. */
export function socialSearch(query: string): Promise<string> {
  if (!IN_TAURI) return unsupported();
  return invoke<string>("social_search", { query });
}

/** Request a single friend's entire share list; results arrive via `onBrowseResult`. */
export function socialBrowse(handle: string): Promise<string> {
  if (!IN_TAURI) return unsupported();
  return invoke<string>("social_browse", { handle });
}

// ---- live events ----

export function onSocialReady(cb: (e: ReadyEvent) => void): Promise<UnlistenFn> {
  return listen<ReadyEvent>("social://ready", (e) => cb(e.payload));
}

export function onSocialPresence(cb: (e: PresenceEvent) => void): Promise<UnlistenFn> {
  return listen<PresenceEvent>("social://presence", (e) => cb(e.payload));
}

export function onSocialConnected(cb: (connected: boolean) => void): Promise<UnlistenFn> {
  return listen<{ connected: boolean }>("social://connected", (e) => cb(e.payload.connected));
}

export function onSearchHit(cb: (e: SearchHit) => void): Promise<UnlistenFn> {
  return listen<SearchHit>("social://search-hit", (e) => cb(e.payload));
}

export function onSearchEnd(cb: (id: string) => void): Promise<UnlistenFn> {
  return listen<{ id: string }>("social://search-end", (e) => cb(e.payload.id));
}

export function onBrowseResult(cb: (e: BrowseResult) => void): Promise<UnlistenFn> {
  return listen<BrowseResult>("social://browse-result", (e) => cb(e.payload));
}

/** Someone started following you (prompt to follow back). */
export interface FollowEvent {
  handle: string;
  online: boolean;
}

export function onSocialFollow(cb: (e: FollowEvent) => void): Promise<UnlistenFn> {
  return listen<FollowEvent>("social://follow", (e) => cb(e.payload));
}

export function onSocialUnfollow(cb: (handle: string) => void): Promise<UnlistenFn> {
  return listen<{ handle: string }>("social://unfollow", (e) => cb(e.payload.handle));
}

export function onSocialFriend(cb: (e: FollowEvent) => void): Promise<UnlistenFn> {
  return listen<FollowEvent>("social://friend", (e) => cb(e.payload));
}

/** Build a magnet from a friend's share so the engine can fetch it peer-to-peer. */
export function shareMagnet(item: ShareItem): string {
  const name = encodeURIComponent(item.name);
  return `magnet:?xt=urn:btih:${item.infohash}&dn=${name}`;
}
